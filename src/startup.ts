import { withPublicHost, type BaseEnv, type Env } from './config/env.js';
import { startTunnel, type ForwardFn, type Tunnel } from './services/tunnelService.js';
import {
  syncVoiceWebhooks,
  twilioCredentials,
  webhookTargets,
  type WebhookSyncResult,
} from './services/twilioWebhookService.js';
import type { Dispatcher } from 'undici';

export interface StartupLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface PublicEndpoint {
  readonly env: Env;
  /** Present only when this process owns an ngrok tunnel. */
  readonly tunnel?: Tunnel;
}

/** Decides the public hostname: a fresh ngrok tunnel when enabled, otherwise PUBLIC_HOST. */
export async function resolvePublicEndpoint(base: BaseEnv, forward?: ForwardFn): Promise<PublicEndpoint> {
  if (base.NGROK_ENABLED && base.NGROK_AUTHTOKEN) {
    const tunnel = await startTunnel(
      { port: base.PORT, authtoken: base.NGROK_AUTHTOKEN, domain: base.NGROK_DOMAIN },
      forward,
    );
    return { env: withPublicHost(base, tunnel.host), tunnel };
  }
  if (!base.PUBLIC_HOST) throw new Error('PUBLIC_HOST is required unless NGROK_ENABLED=true');
  return { env: withPublicHost(base, base.PUBLIC_HOST) };
}

/**
 * Points Twilio at the tunnel URL that was just assigned. A failure here is loud
 * but not fatal: the server is still reachable once the URL is set by hand.
 */
export async function syncTwilioWebhooks(
  env: Env,
  log: StartupLogger,
  dispatcher?: Dispatcher,
): Promise<readonly WebhookSyncResult[]> {
  const voiceUrl = `https://${env.PUBLIC_HOST}/twiml`;
  if (!env.NGROK_ENABLED || !env.TWILIO_SYNC_WEBHOOKS) return [];

  const targets = webhookTargets(env);
  const credentials = twilioCredentials(env);
  if (targets.length === 0 || !credentials) {
    log.warn(
      { voiceUrl },
      'Twilio webhook sync skipped: set TWILIO_TWIML_APP_SID and/or TWILIO_PHONE_NUMBER_SID, plus an API key or TWILIO_AUTH_TOKEN. Set the voice URL by hand.',
    );
    return [];
  }

  const results = await syncVoiceWebhooks(credentials, targets, voiceUrl, dispatcher);
  for (const result of results) {
    const fields = { kind: result.target.kind, sid: result.target.sid, voiceUrl };
    if (result.ok) log.info(fields, 'Twilio voice webhook updated');
    else log.error({ ...fields, err: result.error }, 'Twilio voice webhook update FAILED; set the voice URL by hand');
  }
  return results;
}
