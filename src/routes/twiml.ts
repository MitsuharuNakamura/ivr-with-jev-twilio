import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import { MESSAGES } from '../config/messages.js';
import { handoffDataSchema, type HandoffData } from '../types/conversation-relay.js';
import { createTwilioGuard } from '../utils/twilioGuard.js';

export const RELAY_PATH = '/relay';
const TWIML_PATH = '/twiml';
const HANDOFF_PATH = '/twiml/handoff';

const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
}

function attributes(attrs: Readonly<Record<string, string | undefined>>): string {
  return Object.entries(attrs)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `${name}="${escapeXml(value)}"`)
    .join(' ');
}

/** Browser phone identity; forwarded to the relay so the page can follow its own call. */
export const IDENTITY_PATTERN = /^browser-[0-9a-f]{12}$/;

const connectParamsSchema = z.looseObject({ identity: z.string().regex(IDENTITY_PATTERN).optional() });

export function buildConnectTwiml(env: Env, options: { identity?: string } = {}): string {
  const relayAttrs = attributes({
    url: `wss://${env.PUBLIC_HOST}${RELAY_PATH}`,
    welcomeGreeting: MESSAGES.welcome,
    language: env.TTS_LANGUAGE,
    ttsProvider: env.TTS_PROVIDER,
    voice: env.TTS_VOICE,
    transcriptionProvider: env.TRANSCRIPTION_PROVIDER,
    speechModel: env.SPEECH_MODEL,
    interruptible: 'any',
    dtmfDetection: 'true',
  });
  const connectAttrs = attributes({ action: `https://${env.PUBLIC_HOST}${HANDOFF_PATH}`, method: 'POST' });
  const relay = options.identity
    ? [
        `    <ConversationRelay ${relayAttrs}>`,
        `      <Parameter ${attributes({ name: 'identity', value: options.identity })} />`,
        '    </ConversationRelay>',
      ]
    : [`    <ConversationRelay ${relayAttrs} />`];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Connect ${connectAttrs}>`,
    ...relay,
    '  </Connect>',
    '</Response>',
  ].join('\n');
}

export function buildHandoffTwiml(env: Env, handoff: HandoffData | undefined): string {
  const sayAttrs = attributes({ language: env.TTS_LANGUAGE });
  const say = (text: string) => `  <Say ${sayAttrs}>${escapeXml(text)}</Say>`;
  // Browser calls arrive with From="client:…", which is not a valid caller ID for a PSTN <Dial>.
  const dialAttrs = attributes({ callerId: env.HANDOFF_CALLER_ID });
  const dial = (number: string) => `  <Dial${dialAttrs && ` ${dialAttrs}`}>${escapeXml(number)}</Dial>`;
  const body =
    handoff === undefined
      ? ['  <Hangup />']
      : handoff.reason === 'COMPLETED'
        ? [say(handoff.message), '  <Hangup />']
        : env.HANDOFF_PHONE_NUMBER
        ? [say(handoff.message), dial(env.HANDOFF_PHONE_NUMBER)]
        : [say(MESSAGES.handoffUnavailable), '  <Hangup />'];
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<Response>', ...body, '</Response>'].join('\n');
}

const connectActionSchema = z.looseObject({
  SessionStatus: z.string().optional(),
  HandoffData: z.string().max(2000).optional(),
});

/**
 * Twilio posts here when the relay session ends. Normal hang-ups carry no
 * HandoffData; a failed session (e.g. our WebSocket died) is escalated to a human.
 */
function resolveHandoff(body: unknown): HandoffData | undefined {
  const parsed = connectActionSchema.safeParse(body ?? {});
  if (!parsed.success) return undefined;

  if (parsed.data.HandoffData) {
    try {
      const data = handoffDataSchema.safeParse(JSON.parse(parsed.data.HandoffData));
      if (data.success) return data.data;
    } catch {
      // Malformed payload: fall through and treat as a failed session.
    }
    return { reason: 'SYSTEM_ERROR', message: MESSAGES.handoff };
  }
  return parsed.data.SessionStatus === 'failed'
    ? { reason: 'SYSTEM_ERROR', message: `${MESSAGES.systemError}${MESSAGES.handoff}` }
    : undefined;
}

function sendXml(reply: FastifyReply, xml: string): FastifyReply {
  return reply.type('text/xml; charset=utf-8').send(xml);
}

export async function registerTwimlRoutes(app: FastifyInstance, env: Env): Promise<void> {
  const guard = createTwilioGuard({
    authToken: env.TWILIO_AUTH_TOKEN,
    publicHost: env.PUBLIC_HOST,
    scheme: 'https',
  });

  app.route({
    method: ['GET', 'POST'],
    url: TWIML_PATH,
    preHandler: guard,
    handler: async (request, reply) => {
      // device.connect({ params: { identity } }) on the page arrives here as a form field.
      const params = connectParamsSchema.safeParse(request.body ?? request.query ?? {});
      return sendXml(reply, buildConnectTwiml(env, { identity: params.success ? params.data.identity : undefined }));
    },
  });

  app.post(HANDOFF_PATH, { preHandler: guard }, async (request, reply) => {
    const handoff = resolveHandoff(request.body);
    if (handoff) request.log.info({ reason: handoff.reason }, 'serving handoff TwiML');
    return sendXml(reply, buildHandoffTwiml(env, handoff));
  });
}
