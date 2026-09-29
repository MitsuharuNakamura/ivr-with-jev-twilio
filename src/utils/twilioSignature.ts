import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Twilio request signature: Base64(HMAC-SHA1(authToken, url + sorted(key + value)…)).
 * https://www.twilio.com/docs/usage/security#validating-requests
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Readonly<Record<string, string>> = {},
): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => `${acc}${key}${params[key] ?? ''}`, url);
  return createHmac('sha1', authToken).update(payload, 'utf8').digest('base64');
}

export function isValidTwilioSignature(
  authToken: string,
  signature: string | undefined,
  url: string,
  params: Readonly<Record<string, string>> = {},
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(computeTwilioSignature(authToken, url, params));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
