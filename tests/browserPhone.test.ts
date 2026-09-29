import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserPhoneConfig, loadEnv } from '../src/config/env.js';
import { buildServer } from '../src/server.js';
import { createVoiceAccessToken } from '../src/utils/twilioAccessToken.js';
import { BASE_ENV, judgment, testEnv, triage } from './helpers.js';

const PHONE_ENV = {
  TWILIO_API_KEY_SID: `SK${'a'.repeat(32)}`,
  TWILIO_API_KEY_SECRET: 'api-key-secret',
  TWILIO_TWIML_APP_SID: `AP${'b'.repeat(32)}`,
};

const services = () => ({
  jev: { classify: vi.fn().mockResolvedValue(judgment({ triage: triage('KITCHEN', 'LEAK') })), close: vi.fn().mockResolvedValue(undefined) },
  openAi: { answerFaq: vi.fn(), adviseOnTrouble: vi.fn() },
});

function decode(token: string) {
  const [header = '', payload = '', signature = ''] = token.split('.');
  const parse = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, any>;
  return { header: parse(header), payload: parse(payload), signature, signingInput: `${header}.${payload}` };
}

describe('createVoiceAccessToken', () => {
  it('builds a correctly signed outgoing-only voice token', () => {
    const token = createVoiceAccessToken({
      accountSid: BASE_ENV.TWILIO_ACCOUNT_SID,
      apiKeySid: PHONE_ENV.TWILIO_API_KEY_SID,
      apiKeySecret: PHONE_ENV.TWILIO_API_KEY_SECRET,
      twimlAppSid: PHONE_ENV.TWILIO_TWIML_APP_SID,
      identity: 'browser-test',
      ttlSec: 600,
      now: new Date('2026-01-01T00:00:00Z'),
    });
    const { header, payload, signature, signingInput } = decode(token);

    expect(header).toEqual({ typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' });
    expect(payload).toMatchObject({
      iss: PHONE_ENV.TWILIO_API_KEY_SID,
      sub: BASE_ENV.TWILIO_ACCOUNT_SID,
      iat: 1767225600,
      exp: 1767226200,
      grants: {
        identity: 'browser-test',
        voice: { outgoing: { application_sid: PHONE_ENV.TWILIO_TWIML_APP_SID } },
      },
    });
    expect(payload.grants.voice.incoming).toBeUndefined();
    expect(payload.jti.startsWith(`${PHONE_ENV.TWILIO_API_KEY_SID}-`)).toBe(true);
    expect(signature).toBe(
      createHmac('sha256', PHONE_ENV.TWILIO_API_KEY_SECRET).update(signingInput).digest('base64url'),
    );
  });
});

describe('browser phone env', () => {
  it('is off unless fully configured', () => {
    expect(browserPhoneConfig(testEnv())).toBeUndefined();
    expect(browserPhoneConfig(testEnv(PHONE_ENV))).toMatchObject({ twimlAppSid: PHONE_ENV.TWILIO_TWIML_APP_SID });
  });

  it('rejects partial configuration', () => {
    expect(() => testEnv({ TWILIO_API_KEY_SID: PHONE_ENV.TWILIO_API_KEY_SID })).toThrowError(/set all of/);
  });

  it('requires a passcode in production', () => {
    expect(() => loadEnv({ ...BASE_ENV, ...PHONE_ENV, NODE_ENV: 'production' })).toThrowError(/BROWSER_PHONE_PASSCODE/);
    expect(() =>
      loadEnv({ ...BASE_ENV, ...PHONE_ENV, NODE_ENV: 'production', BROWSER_PHONE_PASSCODE: 'long-enough-pass' }),
    ).not.toThrow();
  });
});

describe('browser phone routes', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('are not registered when the feature is off', async () => {
    app = await buildServer(testEnv(), services);
    expect((await app.inject({ method: 'GET', url: '/phone' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/phone/token' })).statusCode).toBe(404);
  });

  it('serves the page with a CSP and the Voice SDK bundle', async () => {
    app = await buildServer(testEnv(PHONE_ENV), services);
    const page = await app.inject({ method: 'GET', url: '/phone' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain("default-src 'self'");
    expect(page.body).toContain('/phone/sdk.js');

    const sdk = await app.inject({ method: 'GET', url: '/phone/sdk.js' });
    expect(sdk.statusCode).toBe(200);
    expect(sdk.headers['content-type']).toContain('javascript');
    expect(sdk.body).toContain('Twilio');
  });

  it('issues a token with a fresh identity when no passcode is configured', async () => {
    app = await buildServer(testEnv(PHONE_ENV), services);
    expect((await app.inject({ method: 'GET', url: '/phone/config' })).json().data).toEqual({ passcodeRequired: false });

    const first = (await app.inject({ method: 'POST', url: '/phone/token' })).json();
    const second = (await app.inject({ method: 'POST', url: '/phone/token' })).json();
    expect(first.success).toBe(true);
    expect(first.data.identity).toMatch(/^browser-[0-9a-f]{12}$/);
    expect(first.data.identity).not.toBe(second.data.identity);
    expect(decode(first.data.token).payload.grants.identity).toBe(first.data.identity);
  });

  it('enforces the passcode', async () => {
    app = await buildServer(testEnv({ ...PHONE_ENV, BROWSER_PHONE_PASSCODE: 'correct-horse' }), services);
    expect((await app.inject({ method: 'GET', url: '/phone/config' })).json().data).toEqual({ passcodeRequired: true });

    const token = (passcode?: string) =>
      app!.inject({ method: 'POST', url: '/phone/token', headers: passcode ? { 'x-phone-passcode': passcode } : {} });
    expect((await token()).statusCode).toBe(401);
    expect((await token('wrong-horse!!')).statusCode).toBe(401);
    expect((await token('nope')).json()).toMatchObject({ success: false });
    expect((await token('correct-horse')).statusCode).toBe(200);
  });

  it('rate-limits token issuance more tightly than the rest of the API', async () => {
    app = await buildServer(testEnv({ ...PHONE_ENV, BROWSER_PHONE_TOKEN_RATE_LIMIT_MAX: '2' }), services);
    const codes = [];
    for (let i = 0; i < 3; i += 1) codes.push((await app.inject({ method: 'POST', url: '/phone/token' })).statusCode);
    expect(codes).toEqual([200, 200, 429]);
  });

  it('forwards the page identity into the ConversationRelay <Parameter>, and ignores malformed ones', async () => {
    app = await buildServer(testEnv(PHONE_ENV), services);
    const post = (identity: string) =>
      app!.inject({
        method: 'POST',
        url: '/twiml',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ CallSid: 'CA1', From: 'client:x', identity }).toString(),
      });

    const good = await post('browser-0123456789ab');
    expect(good.body).toContain('<Parameter name="identity" value="browser-0123456789ab" />');
    expect(good.body).toContain('</ConversationRelay>');

    const bad = await post('<script>alert(1)</script>');
    expect(bad.statusCode).toBe(200);
    expect(bad.body).not.toContain('Parameter');
    expect(bad.body).toContain('<ConversationRelay ');
  });

  it('streams call events for an identity over SSE', async () => {
    app = await buildServer(testEnv(PHONE_ENV), services);
    await app.ready();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const identity = 'browser-0123456789ab';

    const response = await fetch(`${address}/phone/events?identity=${identity}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const read = async () => decoder.decode((await reader.read()).value);
    expect(await read()).toContain(': connected');

    // The bus is internal to the server; drive it through a relay session carrying the identity.
    const ws = await app.injectWS('/relay');
    ws.send(JSON.stringify({ type: 'setup', sessionId: 'VX1', callSid: 'CA1', customParameters: { identity } }));
    ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'キッチンの水漏れです', last: true }));
    let chunk = '';
    while (!chunk.includes('"type":"agent"')) chunk += await read();
    expect(chunk).toContain('"type":"caller"');
    expect(chunk).toContain('"source":"template"');

    await reader.cancel();
    ws.terminate();
  });

  it('rejects SSE subscriptions without a well-formed identity', async () => {
    app = await buildServer(testEnv(PHONE_ENV), services);
    expect((await app.inject({ method: 'GET', url: '/phone/events' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/phone/events?identity=nope' })).statusCode).toBe(400);
  });

  it('adds the configured caller ID to the handoff <Dial> (browser From is "client:…")', async () => {
    app = await buildServer(
      testEnv({ HANDOFF_PHONE_NUMBER: '+81312345678', HANDOFF_CALLER_ID: '+815012345678' }),
      services,
    );
    const response = await app.inject({
      method: 'POST',
      url: '/twiml/handoff',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        From: 'client:browser-abc',
        HandoffData: JSON.stringify({ reason: 'DTMF', message: 'おつなぎします' }),
      }).toString(),
    });
    expect(response.body).toContain('<Dial callerId="+815012345678">+81312345678</Dial>');
  });
});
