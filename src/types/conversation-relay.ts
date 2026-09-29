import { z } from 'zod';

/**
 * Twilio ConversationRelay WebSocket protocol.
 * https://www.twilio.com/docs/voice/conversationrelay/websocket-messages
 */

// ---------- Twilio -> server ----------

const setupMessageSchema = z.looseObject({
  type: z.literal('setup'),
  sessionId: z.string(),
  callSid: z.string(),
  accountSid: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  direction: z.string().optional(),
  customParameters: z.record(z.string(), z.string()).optional(),
});

const promptMessageSchema = z.looseObject({
  type: z.literal('prompt'),
  voicePrompt: z.string(),
  lang: z.string().optional(),
  // false while the transcript is still partial; absent/true on a completed utterance.
  last: z.boolean().optional(),
});

const dtmfMessageSchema = z.looseObject({
  type: z.literal('dtmf'),
  digit: z.string(),
});

const interruptMessageSchema = z.looseObject({
  type: z.literal('interrupt'),
  utteranceUntilInterrupt: z.string().optional(),
  durationUntilInterruptMs: z.coerce.number().optional(),
});

const errorMessageSchema = z.looseObject({
  type: z.literal('error'),
  description: z.string().optional(),
});

export const inboundMessageSchema = z.discriminatedUnion('type', [
  setupMessageSchema,
  promptMessageSchema,
  dtmfMessageSchema,
  interruptMessageSchema,
  errorMessageSchema,
]);

export type SetupMessage = z.infer<typeof setupMessageSchema>;
export type PromptMessage = z.infer<typeof promptMessageSchema>;
export type DtmfMessage = z.infer<typeof dtmfMessageSchema>;
export type InterruptMessage = z.infer<typeof interruptMessageSchema>;
export type RelayErrorMessage = z.infer<typeof errorMessageSchema>;
export type InboundMessage = z.infer<typeof inboundMessageSchema>;

// ---------- server -> Twilio ----------

/** Text for Twilio to synthesize. `last: true` marks the end of the utterance. */
export interface TextMessage {
  readonly type: 'text';
  readonly token: string;
  readonly last: boolean;
  readonly lang?: string;
  readonly interruptible?: boolean;
  readonly preemptible?: boolean;
}

/** Ends the ConversationRelay session; `handoffData` is posted to the <Connect action> URL. */
export interface EndMessage {
  readonly type: 'end';
  readonly handoffData?: string;
}

export type OutboundMessage = TextMessage | EndMessage;

// ---------- handoff payload (server -> /twiml/handoff via Twilio) ----------

export const handoffDataSchema = z.object({
  reason: z.enum(['REQUESTED', 'REQUIRES_HUMAN', 'CLARIFY_FAILURES', 'DTMF', 'SYSTEM_ERROR', 'COMPLETED']),
  message: z.string().max(300),
  sessionId: z.string().optional(),
});

export type HandoffData = z.infer<typeof handoffDataSchema>;
export type HandoffReason = HandoffData['reason'];
