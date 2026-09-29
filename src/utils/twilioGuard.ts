import type { FastifyReply, FastifyRequest } from 'fastify';
import { isValidTwilioSignature } from './twilioSignature.js';

export interface TwilioGuardConfig {
  readonly authToken?: string;
  readonly publicHost: string;
  readonly scheme: 'https' | 'wss';
}

function formParams(body: unknown): Record<string, string> {
  if (typeof body !== 'object' || body === null) return {};
  return Object.fromEntries(
    Object.entries(body).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/** preHandler/preValidation hook rejecting requests not signed by Twilio. No-op without an auth token. */
export function createTwilioGuard(config: TwilioGuardConfig) {
  return async function twilioGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { authToken } = config;
    if (!authToken) return;

    const header = request.headers['x-twilio-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    const url = `${config.scheme}://${config.publicHost}${request.url}`;
    if (isValidTwilioSignature(authToken, signature, url, formParams(request.body))) return;

    request.log.warn({ url: request.url }, 'rejected request with invalid Twilio signature');
    await reply.code(403).send({ success: false, error: 'Invalid Twilio signature' });
  };
}
