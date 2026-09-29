import { setTimeout as sleep } from 'node:timers/promises';
import { Agent, request, type Dispatcher } from 'undici';
import { EQUIPMENT_CRITERIA, SYMPTOM_CRITERIA } from '../config/serviceCatalog.js';
import type { ConversationTurn } from './stateMachine.js';
import {
  ivrJevResponseSchema,
  type Expectation,
  type JevJudgment,
  type JevQuestion,
  type JevRequest,
} from '../types/jev.js';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const RETRY_BACKOFF_MS = 80;

export interface JevServiceConfig {
  readonly apiKey: string;
  readonly apiUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

export interface JevLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface ClassifyInput {
  readonly utterance: string;
  readonly history: readonly ConversationTurn[];
  /** The slot the agent just asked for, if any. `triage` asks equipment / symptom / emergency instead. */
  readonly expecting?: Expectation;
}

export interface JevService {
  /** Never rejects: on failure returns a degraded UNKNOWN judgment so the call keeps flowing. */
  classify(input: ClassifyInput): Promise<JevJudgment>;
  close(): Promise<void>;
}

class JevHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Jev API responded ${status}: ${body.slice(0, 200)}`);
  }
}

/** All three judgments are independent, so they go out in one request and run in parallel. */
export const IVR_QUESTIONS: Readonly<Record<'intent' | 'is_confident' | 'requires_human', JevQuestion>> = {
  intent: {
    type: 'choice',
    instructions:
      'This is a Japanese phone call to a plumbing / water-equipment repair company. What does the caller want in `latest_caller_utterance`? Use `recent_turns` only to resolve references.',
    criteria: {
      TROUBLE:
        'Reports a problem with water equipment or asks for a repair, replacement, installation or cleaning visit. Includes answering the agent\'s question about where / what the problem is. 例:「キッチンの蛇口から水漏れしてる」「トイレが詰まった」「お湯が出ない」「ウォシュレットを付けたい」',
      STATUS_CHECK: 'Asks about a visit that was already booked: whether it is registered, when the technician comes. 例:「受付できてますか」「何時に来てもらえるんでしたっけ」',
      KNOWLEDGE_FAQ:
        'A question to be answered with information: how to deal with the problem right now, where the shut-off valve is, prices, what the work involves, service area, opening hours, payment. 例:「止水栓はどこ」「いくらかかる」「何時までやってる」',
      HUMAN_HANDOFF: 'Explicitly asks to talk to a person, operator or staff member. 例:「オペレーターにつないで」「人と話したい」',
      CLOSING: 'The caller has nothing more to ask, declines further help, or says goodbye. 例:「大丈夫です」「特にないです」「以上です」「失礼します」',
      UNKNOWN: 'None of the above, unintelligible, off-topic, silence/noise transcription, or too fragmentary to tell.',
    },
  },
  // Worded about the *kind* of request on purpose: asking whether the system can "act on it"
  // made Jev score clear but detail-free requests (「予約をお願いしたいんですけど」) around 0.2.
  is_confident: {
    type: 'noul',
    instructions:
      'Can you tell what kind of help the caller is asking for in `latest_caller_utterance`? Missing details such as dates, names or numbers do not matter; only whether the type of request is understandable.',
    criteria: {
      true: 'The kind of request is understandable, even if details are missing or the phrasing is casual, indirect or trails off politely.',
      false: 'Only fillers, fragments, noise, or words from which the kind of request cannot be determined.',
    },
  },
  requires_human: {
    type: 'noul',
    instructions:
      'Does `latest_caller_utterance` need a human operator rather than the automated repair intake? Urgent water trouble by itself does not: the automated intake handles leaks and floods with immediate advice and a same-day visit.',
    criteria: {
      true: 'The caller demands a person, is angry at the company, makes a complaint about previous work, raises a legal, billing-dispute or otherwise sensitive matter, or asks for something unrelated to water-equipment repair.',
      false: 'A repair request or question the automated intake can handle, including urgent ones such as water that will not stop or a flooded floor.',
    },
  },
};

/**
 * One extra judgment per turn, chosen by what the agent last asked. It rides in the same
 * request as the intent questions, so answering a slot costs no additional round trip.
 */
export const SLOT_QUESTIONS: Readonly<Record<Exclude<Expectation, 'triage'>, readonly [string, JevQuestion]>> = {
  datetime: [
    'provides_datetime',
    {
      type: 'noul',
      instructions: 'Does `latest_caller_utterance` state a day and/or a time the caller wants (for a reservation)?',
      criteria: {
        true: 'Mentions a date, weekday, relative day or clock time. 例:「明日の3時」「来週の金曜日」「15日の夕方」',
        false: 'No day or time is mentioned.',
      },
    },
  ],
  name: [
    'provides_name',
    {
      type: 'noul',
      instructions: 'The agent asked for the caller\'s name. Does `latest_caller_utterance` give a person\'s name?',
      criteria: {
        true: 'States a family name and/or given name, with or without polite endings. 例:「中村です」「田中太郎と申します」',
        false: 'No personal name is given; a question, a refusal, filler, or something unrelated.',
      },
    },
  ],
  detail: [
    'answers_question',
    {
      type: 'noul',
      instructions:
        'The agent asked a question about the trouble (the last agent turn in `recent_turns`). Does `latest_caller_utterance` respond to it?',
      criteria: {
        true: 'Answers the question, describes the situation, or says they do not know / are not sure. 例:「全然出ないです」「根元からポタポタ」「エラーは出てません」「わかりません」',
        false: 'A different request, a question of their own, filler, or unintelligible.',
      },
    },
  ],
  address: [
    'provides_address',
    {
      type: 'noul',
      instructions: 'The agent asked for the address to visit. Does `latest_caller_utterance` give a street address or enough of one (city, town, block, building)?',
      criteria: {
        true: 'States a place to visit: prefecture/city/ward, town name, block numbers, building or apartment. 例:「世田谷区桜丘1丁目2の3」「中野のサンハイツ203」',
        false: 'No address is given; a question, a refusal, filler, or something unrelated.',
      },
    },
  ],
  identifier: [
    'provides_identifier',
    {
      type: 'noul',
      instructions: 'The agent asked for a reservation number or phone number. Does `latest_caller_utterance` give one?',
      criteria: { true: 'Contains a sequence of digits meant as a reservation or phone number.', false: 'No number is given.' },
    },
  ],
  confirmation: [
    'confirmation',
    {
      type: 'choice',
      instructions: 'The agent asked the caller to confirm the details it read back. How does `latest_caller_utterance` respond?',
      criteria: {
        YES: 'Agrees or confirms. 例:「はい」「お願いします」「大丈夫です」「合ってます」',
        NO: 'Rejects, corrects, or says it is wrong. 例:「いいえ」「違います」「時間が違う」',
        NEITHER: 'Neither confirms nor rejects: a different question, a new request, or unclear.',
      },
    },
  ],
};

/** Asked together while the trouble is not yet pinned down; the business line is derived in code. */
export const TRIAGE_QUESTIONS: Readonly<Record<'equipment' | 'symptom' | 'is_emergency', JevQuestion>> = {
  equipment: {
    type: 'choice',
    instructions: 'Which piece of water equipment or location is `latest_caller_utterance` about? Use `recent_turns` if the caller is answering the agent\'s question.',
    criteria: EQUIPMENT_CRITERIA,
  },
  symptom: {
    type: 'choice',
    instructions: 'What is wrong with it, or what work does the caller want, according to `latest_caller_utterance` (and `recent_turns` if answering the agent)?',
    criteria: SYMPTOM_CRITERIA,
  },
  is_emergency: {
    type: 'noul',
    instructions: 'Does `latest_caller_utterance` describe an emergency that needs action right now?',
    criteria: {
      true: 'Water will not stop or is spraying out, water is spreading over the floor or into the flat below, or the caller smells gas. 例:「水が止まらない」「床が水浸し」「ガス臭い」',
      false: 'A drip, a slow drain, a broken unit, a replacement wish, or a question: unpleasant but not spreading damage right now.',
    },
  },
};

function extraQuestions(expecting: Expectation | undefined): Readonly<Record<string, JevQuestion>> {
  if (expecting === 'triage') return TRIAGE_QUESTIONS;
  // With nothing pending, 「キッチンの水漏れなんですけど」 should still be triaged in this turn.
  if (expecting === undefined) return { ...TRIAGE_QUESTIONS, provides_datetime: SLOT_QUESTIONS.datetime[1] };
  const [slotId, slotQuestion] = SLOT_QUESTIONS[expecting];
  return { [slotId]: slotQuestion };
}

function buildRequest(model: string, input: ClassifyInput): JevRequest {
  return {
    model,
    state: {
      latest_caller_utterance: input.utterance,
      recent_turns: input.history.map((turn) => ({ speaker: turn.role, text: turn.text })),
    },
    questions: { ...IVR_QUESTIONS, ...extraQuestions(input.expecting) },
  };
}

function degradedJudgment(latencyMs: number): JevJudgment {
  return { intent: 'UNKNOWN', intentConfidence: 0, isConfident: 0, requiresHuman: 0, provides: {}, latencyMs, degraded: true };
}

function isRetryable(error: unknown): boolean {
  if (error instanceof JevHttpError) return RETRYABLE_STATUS.has(error.status);
  // Timeouts are not retried: the latency budget for this turn is already spent.
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return false;
  return !(error instanceof SyntaxError) && !(error instanceof Error && error.name === 'ZodError');
}

export function createJevService(
  config: JevServiceConfig,
  logger: JevLogger,
  dispatcher: Dispatcher = new Agent({ keepAliveTimeout: 60_000, connections: 16 }),
): JevService {
  async function evaluate(body: JevRequest, signal: AbortSignal) {
    const response = await request(config.apiUrl, {
      method: 'POST',
      dispatcher,
      signal,
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.body.text();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new JevHttpError(response.statusCode, text);
    }
    return ivrJevResponseSchema.parse(JSON.parse(text));
  }

  async function classify(input: ClassifyInput): Promise<JevJudgment> {
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    const body = buildRequest(config.model, input);
    // One deadline for the whole turn, shared across retries.
    const signal = AbortSignal.timeout(config.timeoutMs);

    for (let attempt = 0; ; attempt += 1) {
      try {
        const { answers } = await evaluate(body, signal);
        return {
          intent: answers.intent.choice,
          intentConfidence: answers.intent.confidence,
          isConfident: answers.is_confident.noul,
          requiresHuman: answers.requires_human.noul,
          provides: {
            datetime: answers.provides_datetime?.noul,
            name: answers.provides_name?.noul,
            address: answers.provides_address?.noul,
            detail: answers.answers_question?.noul,
            identifier: answers.provides_identifier?.noul,
          },
          confirmation: answers.confirmation && {
            choice: answers.confirmation.choice,
            confidence: answers.confirmation.confidence,
          },
          triage: answers.equipment &&
            answers.symptom &&
            answers.is_emergency && {
              equipment: { choice: answers.equipment.choice, confidence: answers.equipment.confidence },
              symptom: { choice: answers.symptom.choice, confidence: answers.symptom.confidence },
              emergency: answers.is_emergency.noul,
            },
          latencyMs: elapsed(),
          degraded: false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt >= config.maxRetries || signal.aborted || !isRetryable(error)) {
          logger.error({ err: message, attempt, latencyMs: elapsed() }, 'Jev classification failed; using degraded judgment');
          return degradedJudgment(elapsed());
        }
        logger.warn({ err: message, attempt }, 'Jev request failed; retrying');
        await sleep(RETRY_BACKOFF_MS * 2 ** attempt);
      }
    }
  }

  return { classify, close: () => dispatcher.close() };
}
