import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { BrowserPhoneConfig } from '../config/env.js';
import type { CallEventBus } from '../services/callEvents.js';
import { IDENTITY_PATTERN } from './twiml.js';
import { z } from 'zod';
import { createVoiceAccessToken } from '../utils/twilioAccessToken.js';

// Resolved from the project root so the same paths work from src/ (tsx) and dist/ (node).
const PAGE_URL = new URL('../../public/phone.html', import.meta.url);
const SDK_URL = new URL('../../node_modules/@twilio/voice-sdk/dist/twilio.min.js', import.meta.url);

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // Voice SDK signaling (WebSocket) and insights endpoints.
  "connect-src 'self' https://*.twilio.com wss://*.twilio.com",
  'media-src * blob:',
  "frame-ancestors 'none'",
].join('; ');

function passcodeMatches(expected: string, received: unknown): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Browser softphone. The page places a call through a TwiML App whose Voice URL
 * is /twiml, so browser calls run through exactly the same relay logic as PSTN calls.
 */
const SSE_KEEPALIVE_MS = 15_000;
const eventsQuerySchema = z.object({ identity: z.string().regex(IDENTITY_PATTERN) });

export async function registerBrowserPhoneRoutes(
  app: FastifyInstance,
  config: BrowserPhoneConfig,
  events: CallEventBus,
): Promise<void> {
  const [page, sdk] = await Promise.all([readFile(PAGE_URL, 'utf8'), readFile(SDK_URL)]);

  app.get('/phone', async (_request, reply) =>
    reply
      .header('content-security-policy', PAGE_CSP)
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(page),
  );

  app.get('/phone/sdk.js', async (_request, reply) =>
    reply.header('cache-control', 'public, max-age=86400').type('text/javascript; charset=utf-8').send(sdk),
  );

  app.get('/phone/config', async () => ({ success: true, data: { passcodeRequired: config.passcode !== undefined } }));

  /** Server-Sent Events: what happened on each turn of this identity's call (for the page's timeline). */
  app.get('/phone/events', async (request, reply) => {
    const query = eventsQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ success: false, error: 'identity is required' });

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    const unsubscribe = events.subscribe(query.data.identity, (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), SSE_KEEPALIVE_MS);
    request.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
    return reply;
  });

  app.post(
    '/phone/token',
    { config: { rateLimit: { max: config.tokenRateLimitMax } } },
    async (request, reply) => {
      if (config.passcode && !passcodeMatches(config.passcode, request.headers['x-phone-passcode'])) {
        request.log.warn({ ip: request.ip }, 'browser phone token refused: bad passcode');
        return reply.code(401).send({ success: false, error: 'パスコードが正しくありません' });
      }
      const identity = `browser-${randomBytes(6).toString('hex')}`;
      const token = createVoiceAccessToken({
        accountSid: config.accountSid,
        apiKeySid: config.apiKeySid,
        apiKeySecret: config.apiKeySecret,
        twimlAppSid: config.twimlAppSid,
        identity,
        ttlSec: config.tokenTtlSec,
      });
      request.log.info({ identity }, 'issued browser phone token');
      return reply
        .header('cache-control', 'no-store')
        .send({ success: true, data: { token, identity, ttlSec: config.tokenTtlSec } });
    },
  );
}
