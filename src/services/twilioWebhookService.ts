import { request, type Dispatcher } from 'undici';
import type { BaseEnv } from '../config/env.js';

const TWILIO_API = 'https://api.twilio.com/2010-04-01';
const TIMEOUT_MS = 10_000;

export interface TwilioCredentials {
  readonly accountSid: string;
  /** API key SID or Account SID. */
  readonly username: string;
  /** API key secret or Auth Token. */
  readonly password: string;
}

export interface WebhookTarget {
  readonly kind: 'TwiML App' | 'phone number';
  readonly sid: string;
}

export interface WebhookSyncResult {
  readonly target: WebhookTarget;
  readonly ok: boolean;
  readonly error?: string;
}

/** Prefers the API key (least privilege); falls back to Account SID + Auth Token. */
export function twilioCredentials(env: BaseEnv): TwilioCredentials | undefined {
  if (env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET) {
    return { accountSid: env.TWILIO_ACCOUNT_SID, username: env.TWILIO_API_KEY_SID, password: env.TWILIO_API_KEY_SECRET };
  }
  if (env.TWILIO_AUTH_TOKEN) {
    return { accountSid: env.TWILIO_ACCOUNT_SID, username: env.TWILIO_ACCOUNT_SID, password: env.TWILIO_AUTH_TOKEN };
  }
  return undefined;
}

export function webhookTargets(env: BaseEnv): readonly WebhookTarget[] {
  return [
    ...(env.TWILIO_TWIML_APP_SID ? [{ kind: 'TwiML App' as const, sid: env.TWILIO_TWIML_APP_SID }] : []),
    ...(env.TWILIO_PHONE_NUMBER_SID ? [{ kind: 'phone number' as const, sid: env.TWILIO_PHONE_NUMBER_SID }] : []),
  ];
}

function resourceUrl(accountSid: string, target: WebhookTarget): string {
  const resource = target.kind === 'TwiML App' ? 'Applications' : 'IncomingPhoneNumbers';
  return `${TWILIO_API}/Accounts/${accountSid}/${resource}/${target.sid}.json`;
}

async function updateVoiceUrl(
  credentials: TwilioCredentials,
  target: WebhookTarget,
  voiceUrl: string,
  dispatcher?: Dispatcher,
): Promise<WebhookSyncResult> {
  try {
    const basic = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
    const response = await request(resourceUrl(credentials.accountSid, target), {
      method: 'POST',
      dispatcher,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ VoiceUrl: voiceUrl, VoiceMethod: 'POST' }).toString(),
    });
    const text = await response.body.text();
    if (response.statusCode >= 200 && response.statusCode < 300) return { target, ok: true };
    return { target, ok: false, error: `Twilio responded ${response.statusCode}: ${text.slice(0, 200)}` };
  } catch (error) {
    return { target, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Points each target's voice webhook at `voiceUrl`. Never rejects; failures are reported per target. */
export async function syncVoiceWebhooks(
  credentials: TwilioCredentials,
  targets: readonly WebhookTarget[],
  voiceUrl: string,
  dispatcher?: Dispatcher,
): Promise<readonly WebhookSyncResult[]> {
  return Promise.all(targets.map((target) => updateVoiceUrl(credentials, target, voiceUrl, dispatcher)));
}
