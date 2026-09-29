import dotenv from 'dotenv';
import { browserPhoneConfig, loadBaseEnv } from './config/env.js';
import { buildServer } from './server.js';
import { createJevService } from './services/jevService.js';
import { createOpenAiService } from './services/openAiService.js';
import { resolvePublicEndpoint, syncTwilioWebhooks } from './startup.js';

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

async function main(): Promise<void> {
  dotenv.config({ quiet: true });
  // With NGROK_ENABLED the tunnel comes up first: its hostname is baked into the TwiML we serve.
  const { env, tunnel } = await resolvePublicEndpoint(loadBaseEnv());

  try {
    const app = await buildServer(env, ({ log }) => ({
      jev: createJevService(
        {
          apiKey: env.TYPESAFE_API_KEY,
          apiUrl: env.TYPESAFE_API_URL,
          model: env.JEV_MODEL,
          timeoutMs: env.JEV_TIMEOUT_MS,
          maxRetries: env.JEV_MAX_RETRIES,
        },
        log,
      ),
      openAi: createOpenAiService(
        {
          apiKey: env.OPENAI_API_KEY,
          model: env.OPENAI_MODEL,
          timeoutMs: env.OPENAI_TIMEOUT_MS,
          maxChars: env.FAQ_MAX_CHARS,
          adviceMaxChars: env.ADVICE_MAX_CHARS,
        },
        log,
      ),
    }));

    // onClose runs once the HTTP server has stopped, so the tunnel outlives in-flight requests.
    app.addHook('onClose', async () => {
      await tunnel?.close();
      if (tunnel) app.log.info({ url: tunnel.url }, 'ngrok tunnel closed');
    });

    for (const signal of SHUTDOWN_SIGNALS) {
      process.once(signal, () => {
        app.log.info({ signal }, 'shutting down');
        app.close().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      });
    }

    await app.listen({ host: env.HOST, port: env.PORT });
    if (tunnel) app.log.info({ url: tunnel.url }, 'ngrok tunnel open');
    await syncTwilioWebhooks(env, app.log);

    app.log.info(
      {
        twiml: `https://${env.PUBLIC_HOST}/twiml`,
        aiCall: browserPhoneConfig(env) ? `https://${env.PUBLIC_HOST}/phone` : undefined,
      },
      'ready',
    );
  } catch (error) {
    await tunnel?.close().catch(() => undefined);
    throw error;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
