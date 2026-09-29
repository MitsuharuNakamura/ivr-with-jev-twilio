import { createHmac, randomUUID } from 'node:crypto';

export interface VoiceTokenParams {
  readonly accountSid: string;
  readonly apiKeySid: string;
  readonly apiKeySecret: string;
  readonly twimlAppSid: string;
  readonly identity: string;
  readonly ttlSec: number;
  readonly now?: Date;
}

const base64url = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * Twilio Access Token (JWT, HS256) with an outgoing-only Voice grant.
 * https://www.twilio.com/docs/iam/access-tokens
 */
export function createVoiceAccessToken(params: VoiceTokenParams): string {
  const issuedAt = Math.floor((params.now ?? new Date()).getTime() / 1000);
  const header = { typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' };
  const payload = {
    jti: `${params.apiKeySid}-${randomUUID()}`,
    iss: params.apiKeySid,
    sub: params.accountSid,
    iat: issuedAt,
    exp: issuedAt + params.ttlSec,
    grants: {
      identity: params.identity,
      voice: { outgoing: { application_sid: params.twimlAppSid } },
    },
  };
  const signingInput = `${base64url(header)}.${base64url(payload)}`;
  const signature = createHmac('sha256', params.apiKeySecret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}
