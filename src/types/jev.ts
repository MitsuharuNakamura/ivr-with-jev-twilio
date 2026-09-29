import { z } from 'zod';
import { EQUIPMENT, SYMPTOM, type Equipment, type Symptom } from '../config/serviceCatalog.js';

/**
 * TypeSafe AI System One (Jev) evaluation API.
 * POST https://api.typesafe.ai/v1/systemone — https://docs.typesafe.ai/api
 */

export const INTENTS = ['TROUBLE', 'STATUS_CHECK', 'KNOWLEDGE_FAQ', 'HUMAN_HANDOFF', 'CLOSING', 'UNKNOWN'] as const;
export type Intent = (typeof INTENTS)[number];

/** What the agent just asked for; decides which slot judgment rides along with the intent questions. */
export const EXPECTATIONS = ['triage', 'detail', 'datetime', 'name', 'address', 'identifier', 'confirmation'] as const;
export type Expectation = (typeof EXPECTATIONS)[number];

export const CONFIRMATIONS = ['YES', 'NO', 'NEITHER'] as const;
export type Confirmation = (typeof CONFIRMATIONS)[number];

type Rubric = string | Readonly<Record<string, unknown>> | readonly unknown[];

export interface ChoiceQuestion {
  readonly type: 'choice';
  readonly instructions: Rubric;
  readonly criteria: Readonly<Record<string, Rubric | null>>;
}

export interface NoulQuestion {
  readonly type: 'noul';
  readonly instructions: Rubric;
  readonly criteria?: { readonly true?: Rubric; readonly false?: Rubric };
}

export type JevQuestion = ChoiceQuestion | NoulQuestion;

export interface JevRequest {
  readonly model: string;
  readonly state: string | Readonly<Record<string, unknown>> | readonly unknown[];
  readonly questions: Readonly<Record<string, JevQuestion>>;
}

const unitInterval = z.number().min(0).max(1);

const choiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: unitInterval,
});

const noulAnswerSchema = z.object({
  type: z.literal('noul'),
  noul: unitInterval,
});

/** Response shape: three questions every turn, plus whichever extras were asked. */
export const ivrJevResponseSchema = z.object({
  model: z.string(),
  answers: z.object({
    intent: choiceAnswerSchema.extend({ choice: z.enum(INTENTS) }),
    is_confident: noulAnswerSchema,
    requires_human: noulAnswerSchema,
    // Present only when the matching question was asked for this turn.
    provides_datetime: noulAnswerSchema.optional(),
    provides_name: noulAnswerSchema.optional(),
    provides_address: noulAnswerSchema.optional(),
    answers_question: noulAnswerSchema.optional(),
    provides_identifier: noulAnswerSchema.optional(),
    // Present only while the trouble is still being triaged.
    equipment: choiceAnswerSchema.extend({ choice: z.enum(EQUIPMENT) }).optional(),
    symptom: choiceAnswerSchema.extend({ choice: z.enum(SYMPTOM) }).optional(),
    is_emergency: noulAnswerSchema.optional(),
    confirmation: choiceAnswerSchema.extend({ choice: z.enum(CONFIRMATIONS) }).optional(),
  }),
  usage: z
    .object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() })
    .optional(),
});

export type IvrJevResponse = z.infer<typeof ivrJevResponseSchema>;

/** Normalized judgment consumed by the state machine. */
export interface JevJudgment {
  readonly intent: Intent;
  /** Concentration of the intent Choice distribution (0–1), reported by Jev. */
  readonly intentConfidence: number;
  /** Noul: probability that the caller's request is clear enough to act on. */
  readonly isConfident: number;
  /** Noul: probability that a human operator is needed. */
  readonly requiresHuman: number;
  /** Noul per slot: probability the utterance supplies it. Undefined when not asked this turn. */
  readonly provides: {
    readonly datetime?: number;
    readonly name?: number;
    readonly address?: number;
    readonly identifier?: number;
    /** The utterance responds to the situation question the agent just asked. */
    readonly detail?: number;
  };
  readonly confirmation?: { readonly choice: Confirmation; readonly confidence: number };
  /** Present only when triage questions were asked this turn. */
  readonly triage?: {
    readonly equipment: { readonly choice: Equipment; readonly confidence: number };
    readonly symptom: { readonly choice: Symptom; readonly confidence: number };
    readonly emergency: number;
  };
  readonly latencyMs: number;
  /** True when Jev could not be reached and this is a safe fallback judgment. */
  readonly degraded: boolean;
}
