import { MESSAGES } from '../config/messages.js';
import type { CallEvent, CallEventBus } from '../services/callEvents.js';
import type { JevService } from '../services/jevService.js';
import type { OpenAiService } from '../services/openAiService.js';
import {
  appendTurn,
  beginCallerTurn,
  createSession,
  decide,
  decideDtmf,
  endSession,
  expectationOf,
  troubleContext,
  type Action,
  type DecisionPolicy,
  type SessionState,
} from '../services/stateMachine.js';
import type { JevJudgment } from '../types/jev.js';
import {
  inboundMessageSchema,
  type HandoffData,
  type HandoffReason,
  type InboundMessage,
  type OutboundMessage,
  type PromptMessage,
  type SetupMessage,
} from '../types/conversation-relay.js';

const WS_OPEN = 1;

/** The subset of `ws.WebSocket` the handler relies on. */
export interface RelaySocket {
  readonly readyState: number;
  send(data: string): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface RelayLogger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface RelayHandlerDeps {
  readonly jev: Pick<JevService, 'classify'>;
  readonly openAi: OpenAiService;
  readonly policy: DecisionPolicy;
  readonly language: string;
  readonly faqBargeInMinChars: number;
  /** Optional: turn-by-turn events for the browser phone page. */
  readonly events?: CallEventBus;
}

const IDENTITY_PARAM = 'identity';

type FaqAction = Extract<Action, { kind: 'faq' }>;

export function createRelayHandler(deps: RelayHandlerDeps) {
  return function handleRelaySession(socket: RelaySocket, log: RelayLogger): void {
    // Session state is immutable; this binding is the only thing that changes.
    let state: SessionState | undefined;
    let pendingFaq: AbortController | undefined;
    // Browser phone identity (from the TwiML <Parameter>), when the caller is the /phone page.
    let identity: string | undefined;
    let promptReceivedAt = 0;
    let lastJudgment: JevJudgment | undefined;

    const elapsed = () => Math.round(performance.now() - promptReceivedAt);

    function emit(event: CallEvent): void {
      if (identity) deps.events?.publish(identity, event);
    }

    /** Fields the page shows next to an agent line: what Jev decided and how long things took. */
    function judged(): Partial<Extract<CallEvent, { type: 'agent' }>> {
      const j = lastJudgment;
      const context = state ? troubleContext(state) : {};
      return {
        elapsedMs: elapsed(),
        jevMs: j?.latencyMs,
        intent: j?.intent,
        category: context.category,
        equipment: context.equipment,
        symptom: context.symptom,
        emergency: j?.triage?.emergency,
        degraded: j?.degraded,
      };
    }

    const isCurrent = (turn: number) => state?.status === 'active' && state.turn === turn;

    function send(message: OutboundMessage): void {
      if (socket.readyState !== WS_OPEN) return;
      socket.send(JSON.stringify(message));
    }

    function say(text: string, options: { interruptible?: boolean } = {}): void {
      send({ type: 'text', token: text, last: true, lang: deps.language, ...options });
      if (state) state = appendTurn(state, { role: 'agent', text });
    }

    function cancelPendingFaq(): void {
      pendingFaq?.abort();
      pendingFaq = undefined;
    }

    function handoff(reason: HandoffReason, message: string): void {
      cancelPendingFaq();
      // The message is spoken by the /twiml/handoff TwiML: `end` closes the relay
      // immediately, so text queued right before it could be cut off.
      const data: HandoffData = { reason, message, sessionId: state?.sessionId };
      send({ type: 'end', handoffData: JSON.stringify(data) });
      emit({ type: 'end', turn: state?.turn ?? 0, reason, text: message, elapsedMs: elapsed() });
      if (state) state = endSession(state);
      log.info({ reason }, reason === 'COMPLETED' ? 'call completed' : 'handing off to human');
    }

    async function runFaq(action: FaqAction, turn: number): Promise<void> {
      // Cushion first so the caller hears something while the LLM works.
      say(action.cushion, { interruptible: false });
      emit({ type: 'agent', turn, text: action.cushion, source: 'template', ...judged(), elapsedMs: elapsed() });
      const controller = new AbortController();
      pendingFaq = controller;
      try {
        const answer =
          action.purpose === 'advice'
            ? await deps.openAi.adviseOnTrouble(action.question, action.context, controller.signal)
            : await deps.openAi.answerFaq(action.question, action.context, controller.signal);
        if (!isCurrent(turn)) return;
        // Mid-task, resume by re-asking the pending question in the same utterance.
        const spoken = [answer.text, action.followUp].filter(Boolean).join('');
        say(spoken);
        emit({
          type: 'agent',
          turn,
          text: spoken,
          source: answer.ok ? 'openai' : 'template',
          ...judged(),
          elapsedMs: elapsed(),
          openAiMs: answer.latencyMs,
        });
        log.info(
          { turn, purpose: action.purpose, ok: answer.ok, knowledgeIds: answer.knowledgeIds, openAiMs: answer.latencyMs },
          'deep path spoken',
        );
      } catch (error) {
        if (controller.signal.aborted || !isCurrent(turn)) return;
        log.error({ err: error instanceof Error ? error.message : String(error) }, 'faq path failed');
        say(MESSAGES.faqFailed);
        emit({ type: 'agent', turn, text: MESSAGES.faqFailed, source: 'template', ...judged(), elapsedMs: elapsed() });
      } finally {
        if (pendingFaq === controller) pendingFaq = undefined;
      }
    }

    async function run(action: Action, turn: number): Promise<void> {
      switch (action.kind) {
        case 'say':
          say(action.text);
          emit({ type: 'agent', turn, text: action.text, source: 'template', ...judged(), elapsedMs: elapsed() });
          return;
        case 'faq':
          return runFaq(action, turn);
        case 'handoff':
          return handoff(action.reason, action.text);
      }
    }

    function onSetup(message: SetupMessage): void {
      state = createSession({ sessionId: message.sessionId, callSid: message.callSid, from: message.from });
      identity = message.customParameters?.[IDENTITY_PARAM];
      log.info({ sessionId: message.sessionId, callSid: message.callSid, identity }, 'relay session started');
    }

    async function onPrompt(message: PromptMessage): Promise<void> {
      const utterance = message.voicePrompt.trim();
      if (!state || state.status !== 'active' || message.last === false || utterance === '') return;

      if (pendingFaq && Array.from(utterance).length < deps.faqBargeInMinChars) {
        log.debug({ utterance }, 'ignoring backchannel while faq answer is pending');
        return;
      }
      cancelPendingFaq();
      promptReceivedAt = performance.now();

      const history = state.history;
      const expecting = expectationOf(state);
      state = beginCallerTurn(state, utterance);
      const turn = state.turn;
      emit({ type: 'caller', turn, text: utterance });

      const judgment = await deps.jev.classify({ utterance, history, expecting });
      // The caller may have spoken again (barge-in) while Jev was judging.
      if (!state || !isCurrent(turn)) return;
      lastJudgment = judgment;

      const decision = decide(state, judgment, utterance, deps.policy);
      state = decision.state;
      log.info(
        {
          turn,
          utterance,
          intent: judgment.intent,
          intentConfidence: judgment.intentConfidence,
          isConfident: judgment.isConfident,
          requiresHuman: judgment.requiresHuman,
          expecting,
          triage: judgment.triage && {
            equipment: judgment.triage.equipment.choice,
            equipmentConfidence: judgment.triage.equipment.confidence,
            symptom: judgment.triage.symptom.choice,
            symptomConfidence: judgment.triage.symptom.confidence,
            emergency: judgment.triage.emergency,
          },
          provides: judgment.provides,
          confirmation: judgment.confirmation?.choice,
          task: decision.state.task?.awaiting,
          degraded: judgment.degraded,
          jevMs: judgment.latencyMs,
          action: decision.action.kind,
        },
        'turn decided',
      );
      await run(decision.action, turn);
    }

    async function dispatch(message: InboundMessage): Promise<void> {
      switch (message.type) {
        case 'setup':
          return onSetup(message);
        case 'prompt':
          return onPrompt(message);
        case 'dtmf': {
          const decision = state?.status === 'active' ? decideDtmf(state, message.digit) : undefined;
          if (decision) {
            state = decision.state;
            await run(decision.action, decision.state.turn);
          }
          return;
        }
        case 'interrupt':
          log.debug({ afterMs: message.durationUntilInterruptMs }, 'caller interrupted playback');
          return;
        case 'error':
          log.warn({ description: message.description }, 'ConversationRelay reported an error');
          return;
      }
    }

    function parse(raw: unknown): InboundMessage | undefined {
      try {
        const parsed = inboundMessageSchema.safeParse(JSON.parse(String(raw)));
        if (parsed.success) return parsed.data;
        log.debug({ issues: parsed.error.issues.length }, 'ignoring unsupported relay message');
      } catch {
        log.warn({}, 'ignoring non-JSON relay message');
      }
      return undefined;
    }

    socket.on('message', (raw: unknown) => {
      const message = parse(raw);
      if (!message) return;
      dispatch(message).catch((error: unknown) => {
        log.error({ err: error instanceof Error ? error.message : String(error) }, 'relay message handling failed');
        if (state?.status === 'active') handoff('SYSTEM_ERROR', MESSAGES.systemError);
      });
    });

    socket.on('close', () => {
      cancelPendingFaq();
      if (state) state = endSession(state);
      log.info({ sessionId: state?.sessionId }, 'relay session closed');
    });

    socket.on('error', (error: unknown) => {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'relay socket error');
    });
  };
}
