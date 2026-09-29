import { z } from 'zod';

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === '' ? undefined : value));

const probability = z.coerce.number().min(0).max(1);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Honor X-Forwarded-* (ngrok / load balancer) so rate limiting sees real client IPs.
  TRUST_PROXY: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),

  // Public hostname Twilio reaches this server on (no scheme), e.g. "ivr.example.com".
  // Not needed when NGROK_ENABLED=true: the tunnel's hostname is used instead.
  PUBLIC_HOST: optionalString.pipe(
    z.string().regex(/^[^/\s]+$/, 'PUBLIC_HOST must be a bare hostname without scheme or path').optional(),
  ),

  // Built-in ngrok tunnel: started with the server, closed on shutdown.
  NGROK_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  NGROK_AUTHTOKEN: optionalString,
  // Reserved/static ngrok domain. Without it ngrok assigns a URL per start.
  NGROK_DOMAIN: optionalString.pipe(z.string().regex(/^[^/\s]+$/).optional()),
  // After the tunnel is up, point the TwiML App (and phone number, if given) at it.
  TWILIO_SYNC_WEBHOOKS: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  TWILIO_PHONE_NUMBER_SID: optionalString.pipe(z.string().regex(/^PN[0-9a-fA-F]{32}$/).optional()),

  TYPESAFE_API_KEY: z.string().trim().min(1, 'TYPESAFE_API_KEY is required'),
  TYPESAFE_API_URL: z.string().url().default('https://api.typesafe.ai/v1/systemone'),
  JEV_MODEL: z.string().trim().min(1).default('jev-latest'),
  JEV_TIMEOUT_MS: z.coerce.number().int().positive().default(1500),
  JEV_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(1),

  OPENAI_API_KEY: z.string().trim().min(1, 'OPENAI_API_KEY is required'),
  OPENAI_MODEL: z.string().trim().min(1).default('gpt-4o-mini'),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  FAQ_MAX_CHARS: z.coerce.number().int().min(20).max(400).default(100),
  // Right after triage, add an LLM remark about the trouble (check to do now / first aid / reassurance).
  TRIAGE_ADVICE: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  ADVICE_MAX_CHARS: z.coerce.number().int().min(20).max(200).default(60),

  TWILIO_ACCOUNT_SID: z.string().trim().regex(/^AC[0-9a-fA-F]{32}$/, 'TWILIO_ACCOUNT_SID must look like ACxxxxxxxx…'),
  // When set, X-Twilio-Signature is verified on /twiml* and the WebSocket upgrade.
  TWILIO_AUTH_TOKEN: optionalString,
  // E.164 number to <Dial> on human handoff. Without it the call ends after the handoff message.
  HANDOFF_PHONE_NUMBER: optionalString.pipe(z.string().regex(/^\+[1-9]\d{6,14}$/).optional()),
  // Caller ID for the handoff <Dial>. Required for browser calls, whose From ("client:…") is not a phone number.
  HANDOFF_CALLER_ID: optionalString.pipe(z.string().regex(/^\+[1-9]\d{6,14}$/).optional()),

  // Browser phone (/phone). Enabled only when all three are set.
  TWILIO_API_KEY_SID: optionalString.pipe(z.string().regex(/^SK[0-9a-fA-F]{32}$/).optional()),
  TWILIO_API_KEY_SECRET: optionalString,
  // TwiML App whose Voice URL points at https://<PUBLIC_HOST>/twiml
  TWILIO_TWIML_APP_SID: optionalString.pipe(z.string().regex(/^AP[0-9a-fA-F]{32}$/).optional()),
  // Shared passcode required to get a browser-phone token. Mandatory in production.
  BROWSER_PHONE_PASSCODE: optionalString.pipe(z.string().min(8).optional()),
  BROWSER_PHONE_TOKEN_TTL_SEC: z.coerce.number().int().min(60).max(86_400).default(3600),
  BROWSER_PHONE_TOKEN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  CONFIDENCE_THRESHOLD: probability.default(0.65),
  REQUIRES_HUMAN_THRESHOLD: probability.default(0.7),
  // Minimum Noul for "the caller's utterance answers the slot we asked for".
  SLOT_THRESHOLD: probability.default(0.6),
  // Minimum Noul for "this is an emergency" (water won't stop, flooding, gas smell).
  EMERGENCY_THRESHOLD: probability.default(0.7),
  MAX_CLARIFY_FAILURES: z.coerce.number().int().min(1).max(5).default(2),
  // While an FAQ answer is being generated, caller utterances shorter than this
  // (backchannels such as 「はい」) do not cancel it.
  FAQ_BARGE_IN_MIN_CHARS: z.coerce.number().int().min(0).default(8),

  TTS_LANGUAGE: z.string().trim().min(2).default('ja-JP'),
  TTS_PROVIDER: optionalString,
  TTS_VOICE: optionalString,
  TRANSCRIPTION_PROVIDER: optionalString,
  SPEECH_MODEL: optionalString,

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
});

/** Validated environment. PUBLIC_HOST may still be unknown until the ngrok tunnel is up. */
export type BaseEnv = Readonly<z.infer<typeof envSchema>>;
/** Environment once the public hostname is known; what the server is built from. */
export type Env = BaseEnv & { readonly PUBLIC_HOST: string };

export function withPublicHost(env: BaseEnv, publicHost: string): Env {
  return Object.freeze({ ...env, PUBLIC_HOST: publicHost });
}

export interface BrowserPhoneConfig {
  readonly accountSid: string;
  readonly apiKeySid: string;
  readonly apiKeySecret: string;
  readonly twimlAppSid: string;
  readonly passcode?: string;
  readonly tokenTtlSec: number;
  readonly tokenRateLimitMax: number;
}

const BROWSER_PHONE_KEYS = ['TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'TWILIO_TWIML_APP_SID'] as const;

/** Undefined when the browser phone is not configured (feature off). */
export function browserPhoneConfig(env: Env): BrowserPhoneConfig | undefined {
  const { TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_TWIML_APP_SID } = env;
  if (!TWILIO_API_KEY_SID || !TWILIO_API_KEY_SECRET || !TWILIO_TWIML_APP_SID) return undefined;
  return {
    accountSid: env.TWILIO_ACCOUNT_SID,
    apiKeySid: TWILIO_API_KEY_SID,
    apiKeySecret: TWILIO_API_KEY_SECRET,
    twimlAppSid: TWILIO_TWIML_APP_SID,
    passcode: env.BROWSER_PHONE_PASSCODE,
    tokenTtlSec: env.BROWSER_PHONE_TOKEN_TTL_SEC,
    tokenRateLimitMax: env.BROWSER_PHONE_TOKEN_RATE_LIMIT_MAX,
  };
}

function crossFieldIssues(env: z.infer<typeof envSchema>): readonly string[] {
  const set = BROWSER_PHONE_KEYS.filter((key) => env[key] !== undefined);
  const partial =
    set.length > 0 && set.length < BROWSER_PHONE_KEYS.length
      ? [`  - browser phone: set all of ${BROWSER_PHONE_KEYS.join(', ')} or none`]
      : [];
  const openInProduction =
    env.NODE_ENV === 'production' && set.length === BROWSER_PHONE_KEYS.length && !env.BROWSER_PHONE_PASSCODE
      ? ['  - BROWSER_PHONE_PASSCODE: required in production when the browser phone is enabled']
      : [];
  const ngrok = env.NGROK_ENABLED
    ? env.NGROK_AUTHTOKEN
      ? []
      : ['  - NGROK_AUTHTOKEN: required when NGROK_ENABLED=true']
    : env.PUBLIC_HOST
      ? []
      : ['  - PUBLIC_HOST: required unless NGROK_ENABLED=true (e.g. ivr.example.com)'];
  return [...partial, ...openInProduction, ...ngrok];
}

export function loadBaseEnv(source: NodeJS.ProcessEnv = process.env): BaseEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  const issues = crossFieldIssues(parsed.data);
  if (issues.length > 0) {
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  return Object.freeze(parsed.data);
}

/** For deployments with a fixed hostname (and tests): fails if PUBLIC_HOST is not set. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const env = loadBaseEnv(source);
  if (!env.PUBLIC_HOST) {
    throw new Error('Invalid environment configuration:\n  - PUBLIC_HOST: required');
  }
  return withPublicHost(env, env.PUBLIC_HOST);
}
