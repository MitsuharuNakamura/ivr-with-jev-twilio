import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { browserPhoneConfig, type Env } from './config/env.js';
import { createRelayHandler } from './handlers/relayHandler.js';
import { registerBrowserPhoneRoutes } from './routes/browserPhone.js';
import { registerTwimlRoutes, RELAY_PATH } from './routes/twiml.js';
import { createCallEventBus } from './services/callEvents.js';
import type { JevService } from './services/jevService.js';
import type { OpenAiService } from './services/openAiService.js';
import { createTwilioGuard } from './utils/twilioGuard.js';

const MAX_WS_PAYLOAD_BYTES = 64 * 1024;

export interface ServerDeps {
  readonly jev: JevService;
  readonly openAi: OpenAiService;
}

export type ServiceFactory = (app: FastifyInstance) => ServerDeps;

export async function buildServer(env: Env, createServices: ServiceFactory): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.LOG_LEVEL === 'silent' ? false : { level: env.LOG_LEVEL },
    trustProxy: env.TRUST_PROXY,
  });
  const { jev, openAi } = createServices(app);

  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    // `ip` can be absent when the peer has already disconnected; never let that 500.
    keyGenerator: (request) => request.ip ?? 'unknown',
  });
  await app.register(formbody);
  await app.register(websocket, { options: { maxPayload: MAX_WS_PAYLOAD_BYTES } });

  app.get('/health', async () => ({ success: true, data: { status: 'ok' } }));
  await registerTwimlRoutes(app, env);

  const events = createCallEventBus();
  const browserPhone = browserPhoneConfig(env);
  if (browserPhone) {
    await registerBrowserPhoneRoutes(app, browserPhone, events);
    app.log.info({ url: `https://${env.PUBLIC_HOST}/phone` }, 'browser phone enabled');
  }

  const handleRelaySession = createRelayHandler({
    jev,
    openAi,
    language: env.TTS_LANGUAGE,
    faqBargeInMinChars: env.FAQ_BARGE_IN_MIN_CHARS,
    events,
    policy: {
      confidenceThreshold: env.CONFIDENCE_THRESHOLD,
      requiresHumanThreshold: env.REQUIRES_HUMAN_THRESHOLD,
      maxClarifyFailures: env.MAX_CLARIFY_FAILURES,
      slotThreshold: env.SLOT_THRESHOLD,
      emergencyThreshold: env.EMERGENCY_THRESHOLD,
      triageAdvice: env.TRIAGE_ADVICE,
    },
  });

  const relayGuard = createTwilioGuard({
    authToken: env.TWILIO_AUTH_TOKEN,
    publicHost: env.PUBLIC_HOST,
    scheme: 'wss',
  });

  app.get(RELAY_PATH, { websocket: true, preValidation: relayGuard }, (socket, request) => {
    handleRelaySession(socket, request.log);
  });

  app.addHook('onClose', async () => {
    await jev.close();
  });

  return app;
}
