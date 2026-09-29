import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadBaseEnv, withPublicHost } from '../src/config/env.js';
import { startTunnel, type ForwardFn } from '../src/services/tunnelService.js';
import { twilioCredentials, webhookTargets } from '../src/services/twilioWebhookService.js';
import { resolvePublicEndpoint, syncTwilioWebhooks } from '../src/startup.js';
import { BASE_ENV, silentLogger } from './helpers.js';

const { PUBLIC_HOST: _unused, ...NO_HOST_ENV } = BASE_ENV;
const NGROK_ENV = { ...NO_HOST_ENV, NGROK_ENABLED: 'true', NGROK_AUTHTOKEN: 'ngrok-token' };
const APP_SID = `AP${'b'.repeat(32)}`;
const PN_SID = `PN${'c'.repeat(32)}`;
const API_KEY = { TWILIO_API_KEY_SID: `SK${'a'.repeat(32)}`, TWILIO_API_KEY_SECRET: 'api-secret' };
const ACCOUNT = BASE_ENV.TWILIO_ACCOUNT_SID;

function fakeForward(url: string | null = 'https://abcd-12.ngrok-free.app') {
  const close = vi.fn().mockResolvedValue(undefined);
  const forward = vi.fn<ForwardFn>().mockResolvedValue({ url: () => url, close });
  return { forward, close };
}

describe('ngrok env', () => {
  it('needs PUBLIC_HOST when ngrok is off, and an authtoken when it is on', () => {
    expect(() => loadBaseEnv(NO_HOST_ENV)).toThrowError(/PUBLIC_HOST: required unless NGROK_ENABLED/);
    expect(() => loadBaseEnv({ ...NO_HOST_ENV, NGROK_ENABLED: 'true' })).toThrowError(/NGROK_AUTHTOKEN/);
    expect(loadBaseEnv(NGROK_ENV).PUBLIC_HOST).toBeUndefined();
  });
});

describe('startTunnel', () => {
  it('forwards the local port and exposes the public host', async () => {
    const { forward, close } = fakeForward();
    const tunnel = await startTunnel({ port: 3000, authtoken: 't', domain: 'my.ngrok.app' }, forward);

    expect(forward).toHaveBeenCalledWith({ addr: 3000, authtoken: 't', domain: 'my.ngrok.app' });
    expect(tunnel).toMatchObject({ url: 'https://abcd-12.ngrok-free.app', host: 'abcd-12.ngrok-free.app' });
    await tunnel.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('explains authentication failures', async () => {
    const forward = vi.fn<ForwardFn>().mockRejectedValue(new Error('ERR_NGROK_105'));
    await expect(startTunnel({ port: 3000, authtoken: 'bad' }, forward)).rejects.toThrow(
      /Could not start the ngrok tunnel.*ERR_NGROK_105/,
    );
  });

  it('closes the listener if no URL was assigned', async () => {
    const { forward, close } = fakeForward(null);
    await expect(startTunnel({ port: 3000, authtoken: 't' }, forward)).rejects.toThrow(/did not report/);
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('resolvePublicEndpoint', () => {
  it('uses the tunnel hostname as PUBLIC_HOST when ngrok is enabled', async () => {
    const { forward } = fakeForward();
    const { env, tunnel } = await resolvePublicEndpoint(loadBaseEnv({ ...NGROK_ENV, PORT: '4100' }), forward);
    expect(env.PUBLIC_HOST).toBe('abcd-12.ngrok-free.app');
    expect(tunnel?.url).toBe('https://abcd-12.ngrok-free.app');
    expect(forward.mock.calls[0]?.[0].addr).toBe(4100);
  });

  it('uses PUBLIC_HOST and starts nothing when ngrok is disabled', async () => {
    const { forward } = fakeForward();
    const { env, tunnel } = await resolvePublicEndpoint(loadBaseEnv(BASE_ENV), forward);
    expect(env.PUBLIC_HOST).toBe('ivr.example.com');
    expect(tunnel).toBeUndefined();
    expect(forward).not.toHaveBeenCalled();
  });
});

describe('twilio webhook sync', () => {
  let agent: MockAgent;
  const env = (extra: Record<string, string>) =>
    withPublicHost(loadBaseEnv({ ...NGROK_ENV, ...extra }), 'abcd-12.ngrok-free.app');

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
  });

  afterEach(async () => {
    await agent.close();
  });

  it('points the TwiML App and the phone number at the tunnel, authenticating with the API key', async () => {
    const seen: { path: string; body: string; auth: string }[] = [];
    const record = (request: { path: string; body?: unknown; headers?: unknown }) => {
      seen.push({
        path: request.path,
        body: String(request.body),
        auth: (request.headers as Record<string, string>).authorization ?? '',
      });
      return { sid: 'ok' };
    };
    const pool = agent.get('https://api.twilio.com');
    pool.intercept({ path: `/2010-04-01/Accounts/${ACCOUNT}/Applications/${APP_SID}.json`, method: 'POST' }).reply(200, record);
    pool
      .intercept({ path: `/2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers/${PN_SID}.json`, method: 'POST' })
      .reply(200, record);
    const log = silentLogger();

    const results = await syncTwilioWebhooks(
      env({ ...API_KEY, TWILIO_TWIML_APP_SID: APP_SID, TWILIO_PHONE_NUMBER_SID: PN_SID }),
      log,
      agent,
    );

    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(new URLSearchParams(call.body).get('VoiceUrl')).toBe('https://abcd-12.ngrok-free.app/twiml');
      expect(new URLSearchParams(call.body).get('VoiceMethod')).toBe('POST');
      expect(call.auth).toBe(`Basic ${Buffer.from(`${API_KEY.TWILIO_API_KEY_SID}:api-secret`).toString('base64')}`);
    }
    expect(log.info).toHaveBeenCalledTimes(2);
  });

  it('reports a Twilio error without throwing', async () => {
    agent
      .get('https://api.twilio.com')
      .intercept({ path: `/2010-04-01/Accounts/${ACCOUNT}/Applications/${APP_SID}.json`, method: 'POST' })
      .reply(401, { message: 'Authenticate' });
    const log = silentLogger();

    const results = await syncTwilioWebhooks(env({ TWILIO_AUTH_TOKEN: 'token', ...API_KEY, TWILIO_TWIML_APP_SID: APP_SID }), log, agent);

    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]?.error).toContain('401');
    expect(log.error).toHaveBeenCalledOnce();
  });

  it('reports a network failure without throwing', async () => {
    const results = await syncTwilioWebhooks(env({ ...API_KEY, TWILIO_TWIML_APP_SID: APP_SID }), silentLogger(), agent);
    expect(results[0]?.ok).toBe(false);
  });

  it('falls back to Account SID + Auth Token credentials', () => {
    expect(twilioCredentials(loadBaseEnv({ ...BASE_ENV, TWILIO_AUTH_TOKEN: 'token' }))).toEqual({
      accountSid: ACCOUNT,
      username: ACCOUNT,
      password: 'token',
    });
    expect(twilioCredentials(loadBaseEnv(BASE_ENV))).toBeUndefined();
    expect(webhookTargets(loadBaseEnv(BASE_ENV))).toEqual([]);
  });

  it('warns and skips when there is nothing to update or no credentials', async () => {
    const log = silentLogger();
    expect(await syncTwilioWebhooks(env({}), log, agent)).toEqual([]);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('does nothing when ngrok is off or sync is disabled', async () => {
    const log = silentLogger();
    const fixedHost = withPublicHost(loadBaseEnv({ ...BASE_ENV, ...API_KEY, TWILIO_TWIML_APP_SID: APP_SID }), 'ivr.example.com');
    expect(await syncTwilioWebhooks(fixedHost, log, agent)).toEqual([]);
    expect(await syncTwilioWebhooks(env({ ...API_KEY, TWILIO_TWIML_APP_SID: APP_SID, TWILIO_SYNC_WEBHOOKS: 'false' }), log, agent)).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
