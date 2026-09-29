import {
  acknowledgeTriage,
  ASAP,
  askAddress,
  askName,
  askTriage,
  confirmVisit,
  emergencyAdvice,
  MESSAGES,
  statusResult,
} from '../config/messages.js';
import {
  categoryOf,
  detailQuestions,
  isKnownEquipment,
  isKnownSymptom,
  type Category,
  type Equipment,
  type Symptom,
  type Triage,
} from '../config/serviceCatalog.js';
import type { HandoffReason } from '../types/conversation-relay.js';
import type { Expectation, JevJudgment } from '../types/jev.js';
import { extractAddress, extractDatetime, extractIdentifier, extractName, tidy } from './slotExtraction.js';

const MAX_HISTORY_TURNS = 6;

export interface ConversationTurn {
  readonly role: 'caller' | 'agent';
  readonly text: string;
}

type KnownEquipment = Exclude<Equipment, 'UNKNOWN'>;
type KnownSymptom = Exclude<Symptom, 'UNKNOWN'>;

/** What has been learned about the trouble so far. Complete once both halves are known. */
export interface PartialTriage {
  readonly equipment?: KnownEquipment;
  readonly symptom?: KnownSymptom;
}

/** A repair-visit intake in progress: what has been collected and what the agent is waiting for. */
export type Task =
  | { readonly kind: 'REPAIR'; readonly awaiting: 'triage'; readonly triage: PartialTriage }
  | {
      readonly kind: 'REPAIR';
      readonly awaiting: 'detail';
      readonly triage: Triage;
      /** What the caller said when reporting the trouble. */
      readonly report: string;
      readonly questions: readonly string[];
      /** Answers so far, verbatim; the next question is `questions[answers.length]`. */
      readonly answers: readonly string[];
    }
  | { readonly kind: 'REPAIR'; readonly awaiting: 'datetime'; readonly triage: Triage }
  | { readonly kind: 'REPAIR'; readonly awaiting: 'name'; readonly triage: Triage; readonly datetime: string }
  | {
      readonly kind: 'REPAIR';
      readonly awaiting: 'address';
      readonly triage: Triage;
      readonly datetime: string;
      readonly name: string;
    }
  | {
      readonly kind: 'REPAIR';
      readonly awaiting: 'confirmation';
      readonly triage: Triage;
      readonly datetime: string;
      readonly name: string;
      readonly address: string;
    }
  | { readonly kind: 'STATUS_CHECK'; readonly awaiting: 'identifier' };

export interface SessionState {
  readonly sessionId: string;
  readonly callSid: string;
  readonly from?: string;
  readonly status: 'active' | 'ended';
  /** Monotonic counter of caller turns; used to discard stale async results. */
  readonly turn: number;
  /** Consecutive turns where the caller could not be understood. */
  readonly clarifyFailures: number;
  /** The shut-off-valve advice is given once per call. */
  readonly emergencyAdvised: boolean;
  readonly task?: Task;
  readonly history: readonly ConversationTurn[];
}

export interface DecisionPolicy {
  readonly confidenceThreshold: number;
  readonly requiresHumanThreshold: number;
  readonly maxClarifyFailures: number;
  /** Minimum Noul for "the utterance supplies the slot we asked for". */
  readonly slotThreshold: number;
  /** Minimum Noul for "this is an emergency". */
  readonly emergencyThreshold: number;
  /** Add an LLM-generated remark about the trouble right after triage (Deep Path); false keeps it template-only. */
  readonly triageAdvice: boolean;
}

/** What the caller's trouble is, for scoping FAQ retrieval. */
export interface TroubleContext {
  readonly category?: Category;
  readonly equipment?: KnownEquipment;
  readonly symptom?: KnownSymptom;
}

export type Action =
  /** Fast path: speak a fixed template immediately. */
  | { readonly kind: 'say'; readonly text: string }
  /** Deep path: speak the cushion now, then the LLM text (+ `followUp` to resume a task). */
  | {
      readonly kind: 'faq';
      /** `answer` replies to a question; `advice` remarks on the trouble just triaged. */
      readonly purpose: 'answer' | 'advice';
      readonly cushion: string;
      readonly question: string;
      readonly context: TroubleContext;
      readonly followUp?: string;
    }
  /** Ends the relay; `text` is spoken by the handoff TwiML. `COMPLETED` hangs up instead of dialing. */
  | { readonly kind: 'handoff'; readonly text: string; readonly reason: HandoffReason };

export interface Decision {
  readonly state: SessionState;
  readonly action: Action;
}

export function createSession(params: { sessionId: string; callSid: string; from?: string }): SessionState {
  return {
    sessionId: params.sessionId,
    callSid: params.callSid,
    from: params.from,
    status: 'active',
    turn: 0,
    clarifyFailures: 0,
    emergencyAdvised: false,
    history: [{ role: 'agent', text: MESSAGES.welcome }],
  };
}

export function appendTurn(state: SessionState, turn: ConversationTurn): SessionState {
  return { ...state, history: [...state.history, turn].slice(-MAX_HISTORY_TURNS) };
}

/** Registers a completed caller utterance and advances the turn counter. */
export function beginCallerTurn(state: SessionState, utterance: string): SessionState {
  return { ...appendTurn(state, { role: 'caller', text: utterance }), turn: state.turn + 1 };
}

export function endSession(state: SessionState): SessionState {
  return { ...state, status: 'ended' };
}

/** Which extra judgment to request from Jev for the next caller utterance. */
export function expectationOf(state: SessionState): Expectation | undefined {
  return state.task?.awaiting;
}

export function troubleContext(state: SessionState): TroubleContext {
  const triage = state.task?.kind === 'REPAIR' ? state.task.triage : undefined;
  if (!triage) return {};
  const category = triage.equipment && triage.symptom ? categoryOf({ equipment: triage.equipment, symptom: triage.symptom }) : undefined;
  return { category, equipment: triage.equipment, symptom: triage.symptom };
}

function promptFor(task: Task): string {
  switch (task.awaiting) {
    case 'triage':
      return askTriage(task.triage.equipment, task.triage.symptom);
    case 'detail':
      return task.questions[task.answers.length] ?? MESSAGES.askDatetime;
    case 'datetime':
      return MESSAGES.askDatetime;
    case 'name':
      return MESSAGES.askNameAgain;
    case 'address':
      return MESSAGES.askAddressAgain;
    case 'confirmation':
      return confirmVisit(task.triage, task.datetime, task.name, task.address);
    case 'identifier':
      return MESSAGES.askIdentifierAgain;
  }
}

function handoff(state: SessionState, reason: HandoffReason, text: string): Decision {
  return { state: endSession(state), action: { kind: 'handoff', text, reason } };
}

/** The caller was understood: reset the failure streak and move the task along. */
function proceed(state: SessionState, task: Task | undefined, text: string): Decision {
  return { state: { ...state, clarifyFailures: 0, task }, action: { kind: 'say', text } };
}

function clarify(state: SessionState, policy: DecisionPolicy): Decision {
  const failures = state.clarifyFailures + 1;
  if (failures >= policy.maxClarifyFailures) {
    return handoff(state, 'CLARIFY_FAILURES', MESSAGES.handoffAfterFailures);
  }
  // Mid-task, re-ask the pending question instead of going back to "what can I do for you".
  const text = state.task
    ? `${MESSAGES.sorry}${promptFor(state.task)}`
    : failures === 1
      ? MESSAGES.clarify
      : MESSAGES.clarifyWithHint;
  return { state: { ...state, clarifyFailures: failures }, action: { kind: 'say', text } };
}

/** Merges this turn's equipment / symptom judgments into what was already known. */
function mergeTriage(known: PartialTriage, judgment: JevJudgment, policy: DecisionPolicy): PartialTriage {
  const answer = judgment.triage;
  if (!answer) return known;
  const equipment = answer.equipment.confidence >= policy.confidenceThreshold ? answer.equipment.choice : undefined;
  const symptom = answer.symptom.confidence >= policy.confidenceThreshold ? answer.symptom.choice : undefined;
  return {
    equipment: isKnownEquipment(equipment) ? equipment : known.equipment,
    symptom: isKnownSymptom(symptom) ? symptom : known.symptom,
  };
}

function isComplete(triage: PartialTriage): triage is Triage {
  return triage.equipment !== undefined && triage.symptom !== undefined;
}

/**
 * Moves the intake forward from the triage step. An emergency gets the shut-off
 * advice once and skips the scheduling question: the visit is "as soon as possible".
 */
function advanceTriage(
  state: SessionState,
  known: PartialTriage,
  judgment: JevJudgment,
  utterance: string,
  policy: DecisionPolicy,
): Decision {
  const triage = mergeTriage(known, judgment, policy);
  const emergency = !state.emergencyAdvised && (judgment.triage?.emergency ?? 0) >= policy.emergencyThreshold;
  const advised = emergency ? { ...state, emergencyAdvised: true } : state;
  const prefix = emergency ? emergencyAdvice(triage.equipment, triage.symptom) : '';

  if (!isComplete(triage)) {
    return proceed(advised, { kind: 'REPAIR', awaiting: 'triage', triage }, `${prefix}${askTriage(triage.equipment, triage.symptom)}`);
  }
  if (emergency || state.emergencyAdvised) {
    return proceed(
      advised,
      { kind: 'REPAIR', awaiting: 'name', triage, datetime: ASAP },
      `${prefix}${acknowledgeTriage(triage)}${MESSAGES.emergencyDispatch}`,
    );
  }
  if (!policy.triageAdvice) {
    return proceed(advised, { kind: 'REPAIR', awaiting: 'datetime', triage }, `${acknowledgeTriage(triage)}${MESSAGES.askDatetime}`);
  }
  // Like a call-centre agent: confirm the situation first, advise after, schedule last.
  const questions = detailQuestions(triage);
  const detail: Task = { kind: 'REPAIR', awaiting: 'detail', triage, report: utterance, questions, answers: [] };
  if (questions.length > 0) return proceed(advised, detail, `${acknowledgeTriage(triage)}${questions[0]}`);
  return advise(advised, detail, acknowledgeTriage(triage));
}

/** 「給湯器の故障ですね。」/「ありがとうございます。」 is spoken at once; the LLM remark and the date question follow. */
function advise(state: SessionState, task: Extract<Task, { awaiting: 'detail' }>, cushion: string): Decision {
  const { triage } = task;
  const report = [task.report, ...task.questions.slice(0, task.answers.length).map((q, i) => `Q: ${q}\nA: ${task.answers[i]}`)].join('\n');
  return {
    state: { ...state, clarifyFailures: 0, task: { kind: 'REPAIR', awaiting: 'datetime', triage } },
    action: {
      kind: 'faq',
      purpose: 'advice',
      cushion,
      question: report,
      context: { category: categoryOf(triage), equipment: triage.equipment, symptom: triage.symptom },
      followUp: `${MESSAGES.visitIntro}${MESSAGES.askDatetime}`,
    },
  };
}

/** Tries to consume the utterance as the answer to the pending question. */
function fillSlot(
  state: SessionState,
  task: Task,
  judgment: JevJudgment,
  utterance: string,
  policy: DecisionPolicy,
): Decision | undefined {
  const supplied = (probability: number | undefined) => (probability ?? 0) >= policy.slotThreshold;

  switch (task.awaiting) {
    case 'triage': {
      const merged = mergeTriage(task.triage, judgment, policy);
      // Only an answer that adds something counts; otherwise fall through to intent handling.
      const learned = merged.equipment !== task.triage.equipment || merged.symptom !== task.triage.symptom;
      return learned ? advanceTriage(state, task.triage, judgment, utterance, policy) : undefined;
    }
    case 'detail': {
      const answer = tidy(utterance);
      if (!supplied(judgment.provides.detail) || answer === '') return undefined;
      const next = { ...task, answers: [...task.answers, answer] };
      const question = next.questions[next.answers.length];
      return question === undefined ? advise(state, next, MESSAGES.thanks) : proceed(state, next, question);
    }
    case 'datetime': {
      if (!supplied(judgment.provides.datetime)) return undefined;
      const datetime = extractDatetime(utterance);
      return proceed(state, { ...task, awaiting: 'name', datetime }, askName(datetime));
    }
    case 'name': {
      const name = extractName(utterance);
      if (!supplied(judgment.provides.name) || name === '') return undefined;
      return proceed(state, { ...task, awaiting: 'address', name }, askAddress(name));
    }
    case 'address': {
      const address = extractAddress(utterance);
      if (!supplied(judgment.provides.address) || address === '') return undefined;
      const next: Task = { ...task, awaiting: 'confirmation', address };
      return proceed(state, next, promptFor(next));
    }
    case 'confirmation': {
      const answer = judgment.confirmation;
      if (!answer || answer.confidence < policy.confidenceThreshold) return undefined;
      // Mock: a real deployment registers the visit here.
      if (answer.choice === 'YES') return proceed(state, undefined, MESSAGES.visitDone);
      if (answer.choice === 'NO') {
        return proceed(state, { kind: 'REPAIR', awaiting: 'datetime', triage: task.triage }, MESSAGES.restartDatetime);
      }
      return undefined;
    }
    case 'identifier': {
      const identifier = extractIdentifier(utterance);
      if (!supplied(judgment.provides.identifier) || identifier === undefined) return undefined;
      // Mock lookup: a real deployment queries the booking system here.
      return proceed(state, undefined, statusResult(identifier));
    }
  }
}

/**
 * Pure transition: current state + Jev judgment -> next state + what to do.
 * Order: a need for a human wins; then the answer to a pending question; then
 * closing; then uncertainty; then a (new) intent.
 */
export function decide(
  state: SessionState,
  judgment: JevJudgment,
  utterance: string,
  policy: DecisionPolicy,
): Decision {
  if (judgment.requiresHuman >= policy.requiresHumanThreshold) {
    return handoff(state, 'REQUIRES_HUMAN', MESSAGES.handoff);
  }

  const filled = state.task && fillSlot(state, state.task, judgment, utterance, policy);
  if (filled) return filled;

  // 「大丈夫です」 or 「代わって」 is not a repair request, so is_confident ("what help is being
  // asked for") is low by design. These are gated on how decisively Jev picked the intent instead.
  if (judgment.intentConfidence >= policy.confidenceThreshold) {
    if (judgment.intent === 'CLOSING') return handoff(state, 'COMPLETED', MESSAGES.closing);
    if (judgment.intent === 'HUMAN_HANDOFF') return handoff(state, 'REQUESTED', MESSAGES.handoff);
  }

  if (judgment.intent === 'UNKNOWN' || judgment.isConfident < policy.confidenceThreshold) {
    return clarify(state, policy);
  }

  switch (judgment.intent) {
    case 'TROUBLE':
      // Already collecting a visit and this was not an answer: ask again rather than restart.
      return state.task?.kind === 'REPAIR' ? clarify(state, policy) : advanceTriage(state, {}, judgment, utterance, policy);
    case 'STATUS_CHECK':
      return state.task?.kind === 'STATUS_CHECK'
        ? clarify(state, policy)
        : proceed(state, { kind: 'STATUS_CHECK', awaiting: 'identifier' }, MESSAGES.askIdentifier);
    case 'KNOWLEDGE_FAQ':
      return {
        state: { ...state, clarifyFailures: 0 },
        action: {
          kind: 'faq',
          purpose: 'answer',
          cushion: MESSAGES.faqCushion,
          question: utterance,
          context: troubleContext(state),
          followUp: state.task && promptFor(state.task),
        },
      };
    case 'HUMAN_HANDOFF':
      return handoff(state, 'REQUESTED', MESSAGES.handoff);
    case 'CLOSING':
      return clarify(state, policy);
  }
}

export function decideDtmf(state: SessionState, digit: string): Decision | undefined {
  return digit === '0' ? handoff(state, 'DTMF', MESSAGES.handoff) : undefined;
}
