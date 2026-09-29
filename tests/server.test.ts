import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { acknowledgeTriage, MESSAGES } from '../src/config/messages.js';
import { buildServer } from '../src/server.js';
import { computeTwilioSignature, isValidTwilioSignature } from '../src/utils/twilioSignature.js';
import { BASE_ENV, judgment, testEnv, triage } from './helpers.js';

const AUTH_TOKEN = 'test-auth-token';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

function services() {
  return {
    jev: { classify: vi.fn().mockResolvedValue(judgment({ triage: triage('KITCHEN', 'LEAK') })), close: vi.fn().mockResolvedValue(undefined) },
    openAi: { answerFaq: vi.fn(), adviseOnTrouble: vi.fn() },
  };
}

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = testEnv();
    expect(env).toMatchObject({
      PORT: 3000,
      JEV_MODEL: 'jev-latest',
      OPENAI_MODEL: 'gpt-4o-mini',
      CONFIDENCE_THRESHOLD: 0.65,
      MAX_CLARIFY_FAILURES: 2,
      FAQ_MAX_CHARS: 100,
      TRIAGE_ADVICE: true,
      ADVICE_MAX_CHARS: 60,
    });
    expect(env.TWILIO_AUTH_TOKEN).toBeUndefined();
  });

  it('reports every missing or malformed variable in one error', () => {
    expect(() => loadEnv({ PUBLIC_HOST: 'https://has-scheme.example.com/' })).toThrowError(
      /PUBLIC_HOST[\s\S]*TYPESAFE_API_KEY[\s\S]*OPENAI_API_KEY[\s\S]*TWILIO_ACCOUNT_SID/,
    );
  });

  it('rejects out-of-range thresholds and non-E.164 handoff numbers', () => {
    expect(() => loadEnv({ ...BASE_ENV, CONFIDENCE_THRESHOLD: '1.5' })).toThrowError(/CONFIDENCE_THRESHOLD/);
    expect(() => loadEnv({ ...BASE_ENV, HANDOFF_PHONE_NUMBER: '03-1234-5678' })).toThrowError(/HANDOFF_PHONE_NUMBER/);
  });
});

describe('twilio signature', () => {
  it('matches the reference example from the Twilio docs', () => {
    const signature = computeTwilioSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', {
      CallSid: 'CA1234567890ABCDE',
      Caller: '+12349013030',
      Digits: '1234',
      From: '+12349013030',
      To: '+18005551212',
    });
    expect(signature).toBe('0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  });

  it('rejects missing and tampered signatures', () => {
    const good = computeTwilioSignature(AUTH_TOKEN, 'https://a.example/twiml');
    expect(isValidTwilioSignature(AUTH_TOKEN, good, 'https://a.example/twiml')).toBe(true);
    expect(isValidTwilioSignature(AUTH_TOKEN, undefined, 'https://a.example/twiml')).toBe(false);
    expect(isValidTwilioSignature(AUTH_TOKEN, good, 'https://a.example/other')).toBe(false);
    expect(isValidTwilioSignature(AUTH_TOKEN, 'short', 'https://a.example/twiml')).toBe(false);
  });
});

describe('HTTP routes', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('GET /health', async () => {
    app = await buildServer(testEnv(), services);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.json()).toEqual({ success: true, data: { status: 'ok' } });
  });

  it('POST /twiml connects the call to the relay WebSocket', async () => {
    app = await buildServer(testEnv({ TTS_PROVIDER: 'Google', TTS_VOICE: 'ja-JP-Chirp3-HD-Aoede' }), services);
    const response = await app.inject({ method: 'POST', url: '/twiml', headers: FORM, payload: 'CallSid=CA1' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/xml');
    expect(response.body).toContain('<Connect action="https://ivr.example.com/twiml/handoff" method="POST">');
    expect(response.body).toContain('url="wss://ivr.example.com/relay"');
    expect(response.body).toContain(`welcomeGreeting="${MESSAGES.welcome}"`);
    expect(response.body).toContain('language="ja-JP"');
    expect(response.body).toContain('ttsProvider="Google" voice="ja-JP-Chirp3-HD-Aoede"');
    expect(response.body).not.toContain('transcriptionProvider');
  });

  it('handoff dials the operator after speaking the handoff message', async () => {
    app = await buildServer(testEnv({ HANDOFF_PHONE_NUMBER: '+81312345678' }), services);
    const handoffData = JSON.stringify({ reason: 'REQUESTED', message: 'おつなぎ <します> & お待ちください' });
    const response = await app.inject({
      method: 'POST',
      url: '/twiml/handoff',
      headers: FORM,
      payload: new URLSearchParams({ SessionStatus: 'ended', HandoffData: handoffData }).toString(),
    });

    expect(response.body).toContain('<Say language="ja-JP">おつなぎ &lt;します&gt; &amp; お待ちください</Say>');
    expect(response.body).toContain('<Dial>+81312345678</Dial>');
  });

  it('handoff without a configured number apologizes and hangs up', async () => {
    app = await buildServer(testEnv(), services);
    const response = await app.inject({
      method: 'POST',
      url: '/twiml/handoff',
      headers: FORM,
      payload: new URLSearchParams({ HandoffData: JSON.stringify({ reason: 'DTMF', message: 'x' }) }).toString(),
    });
    expect(response.body).toContain(MESSAGES.handoffUnavailable);
    expect(response.body).toContain('<Hangup />');
  });

  it('a normal session end just hangs up; a failed or malformed one escalates', async () => {
    app = await buildServer(testEnv({ HANDOFF_PHONE_NUMBER: '+81312345678' }), services);
    const post = (params: Record<string, string>) =>
      app!.inject({
        method: 'POST',
        url: '/twiml/handoff',
        headers: FORM,
        payload: new URLSearchParams(params).toString(),
      });

    expect((await post({ SessionStatus: 'ended' })).body).not.toContain('<Dial>');
    expect((await post({ SessionStatus: 'failed' })).body).toContain('<Dial>');
    expect((await post({ HandoffData: '{not json' })).body).toContain('<Dial>');
    expect((await post({ HandoffData: '{"reason":"NOPE"}' })).body).toContain('<Dial>');
  });

  it('enforces X-Twilio-Signature when an auth token is configured', async () => {
    app = await buildServer(testEnv({ TWILIO_AUTH_TOKEN: AUTH_TOKEN }), services);
    const params = { CallSid: 'CA1', From: '+81300000000' };
    const payload = new URLSearchParams(params).toString();

    const unsigned = await app.inject({ method: 'POST', url: '/twiml', headers: FORM, payload });
    expect(unsigned.statusCode).toBe(403);

    const signature = computeTwilioSignature(AUTH_TOKEN, 'https://ivr.example.com/twiml', params);
    const signed = await app.inject({
      method: 'POST',
      url: '/twiml',
      headers: { ...FORM, 'x-twilio-signature': signature },
      payload,
    });
    expect(signed.statusCode).toBe(200);
  });
});

describe('WebSocket /relay', () => {
  it('runs a full turn over a real socket', async () => {
    const deps = services();
    const app = await buildServer(testEnv({ TRIAGE_ADVICE: 'false' }), () => deps);
    await app.ready();
    try {
      const ws = await app.injectWS('/relay');
      const reply = new Promise<string>((resolve) => ws.once('message', (data) => resolve(String(data))));
      ws.send(JSON.stringify({ type: 'setup', sessionId: 'VX1', callSid: 'CA1' }));
      ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'キッチンの水漏れです', last: true }));

      expect(JSON.parse(await reply)).toEqual({
        type: 'text',
        token: `${acknowledgeTriage({ equipment: 'KITCHEN', symptom: 'LEAK' })}${MESSAGES.askDatetime}`,
        last: true,
        lang: 'ja-JP',
      });
      ws.terminate();
    } finally {
      await app.close();
    }
    expect(deps.jev.close).toHaveBeenCalledOnce();
  });

  it('refuses unsigned upgrades when an auth token is configured', async () => {
    const app = await buildServer(testEnv({ TWILIO_AUTH_TOKEN: AUTH_TOKEN }), services);
    await app.ready();
    try {
      await expect(app.injectWS('/relay')).rejects.toThrow();
      const signature = computeTwilioSignature(AUTH_TOKEN, 'wss://ivr.example.com/relay');
      const ws = await app.injectWS('/relay', { headers: { 'x-twilio-signature': signature } });
      ws.terminate();
    } finally {
      await app.close();
    }
  });
});
