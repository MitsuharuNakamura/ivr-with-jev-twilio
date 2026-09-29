import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acknowledgeTriage, MESSAGES } from '../src/config/messages.js';
import type { DecisionPolicy } from '../src/services/stateMachine.js';
import { createRelayHandler, type RelayHandlerDeps } from '../src/handlers/relayHandler.js';
import type { FaqAnswer } from '../src/services/openAiService.js';
import type { JevJudgment } from '../src/types/jev.js';
import { deferred, FakeSocket, flush, judgment, silentLogger, triage } from './helpers.js';
import { detailQuestions } from '../src/config/serviceCatalog.js';
import { createCallEventBus, type CallEvent } from '../src/services/callEvents.js';

const SETUP = { type: 'setup', sessionId: 'VX1', callSid: 'CA1', from: '+81300000000', to: '+81500000000' };
const prompt = (voicePrompt: string, last = true) => ({ type: 'prompt', voicePrompt, lang: 'ja-JP', last });
const faqAnswer = (text: string): FaqAnswer => ({ text, ok: true, knowledgeIds: ['parking'], latencyMs: 700 });
const text = (token: string, extra: object = {}) => ({ type: 'text', token, last: true, lang: 'ja-JP', ...extra });

const POLICY: DecisionPolicy = {
  confidenceThreshold: 0.65,
  requiresHumanThreshold: 0.7,
  maxClarifyFailures: 2,
  slotThreshold: 0.6,
  emergencyThreshold: 0.7,
  triageAdvice: false,
};
const unclear = (extra: Partial<JevJudgment> = {}) => judgment({ intent: 'UNKNOWN', isConfident: 0.1, ...extra });
const KITCHEN_LEAK_ACK = `${acknowledgeTriage({ equipment: 'KITCHEN', symptom: 'LEAK' })}${MESSAGES.askDatetime}`;

describe('relayHandler', () => {
  let socket: FakeSocket;
  let classify: ReturnType<typeof vi.fn<RelayHandlerDeps['jev']['classify']>>;
  let answerFaq: ReturnType<typeof vi.fn<RelayHandlerDeps['openAi']['answerFaq']>>;
  let adviseOnTrouble: ReturnType<typeof vi.fn<RelayHandlerDeps['openAi']['adviseOnTrouble']>>;
  let log: ReturnType<typeof silentLogger>;

  function attach(target: FakeSocket, policy: DecisionPolicy = POLICY) {
    createRelayHandler({
      jev: { classify },
      openAi: { answerFaq, adviseOnTrouble },
      language: 'ja-JP',
      faqBargeInMinChars: 8,
      policy,
    })(target, log);
  }

  beforeEach(() => {
    socket = new FakeSocket();
    classify = vi.fn();
    answerFaq = vi.fn();
    adviseOnTrouble = vi.fn();
    log = silentLogger();
    attach(socket);
    socket.receive(SETUP);
  });

  describe('situation check and advice', () => {
    const heater = judgment({ triage: triage('WATER_HEATER', 'BREAKDOWN') });
    const ack = acknowledgeTriage({ equipment: 'WATER_HEATER', symptom: 'BREAKDOWN' });
    const [q1, q2] = detailQuestions({ equipment: 'WATER_HEATER', symptom: 'BREAKDOWN' });
    const answered = unclear({ provides: { detail: 0.95 } });

    beforeEach(() => {
      socket = new FakeSocket();
      attach(socket, { ...POLICY, triageAdvice: true });
      socket.receive(SETUP);
    });

    it('asks the situation questions one by one, then thanks, remarks, and asks for a date', async () => {
      const advice = deferred<FaqAnswer>();
      classify.mockResolvedValueOnce(heater).mockResolvedValueOnce(answered).mockResolvedValueOnce(answered);
      adviseOnTrouble.mockReturnValue(advice.promise);

      socket.receive(prompt('給湯器が故障してお湯が出ない'));
      await flush();
      expect(socket.sent).toEqual([text(`${ack}${q1}`)]);
      expect(classify).toHaveBeenLastCalledWith(expect.objectContaining({ expecting: undefined }));

      socket.receive(prompt('全然出ないです'));
      await flush();
      expect(socket.sent.at(-1)).toEqual(text(q2!));
      expect(classify).toHaveBeenLastCalledWith(expect.objectContaining({ expecting: 'detail' }));

      socket.receive(prompt('エラーは出てません'));
      await flush();
      expect(socket.sent.at(-1)).toEqual(text(MESSAGES.thanks, { interruptible: false }));
      expect(adviseOnTrouble).toHaveBeenCalledWith(
        expect.stringContaining('A: エラーは出てません'),
        { category: 'HEATER', equipment: 'WATER_HEATER', symptom: 'BREAKDOWN' },
        expect.any(AbortSignal),
      );

      advice.resolve({ text: 'ガスの元栓をご確認ください。', ok: true, knowledgeIds: ['heater-no-hot-water'], latencyMs: 900 });
      await flush();
      expect(socket.sent.at(-1)).toEqual(text(`ガスの元栓をご確認ください。${MESSAGES.visitIntro}${MESSAGES.askDatetime}`));
      expect(answerFaq).not.toHaveBeenCalled();
    });

    it('goes straight on to the date question when no remark could be generated', async () => {
      classify.mockResolvedValueOnce(heater).mockResolvedValue(answered);
      adviseOnTrouble.mockResolvedValue({ text: '', ok: false, knowledgeIds: [], latencyMs: 8000 });

      socket.receive(prompt('給湯器が故障してお湯が出ない'));
      await flush();
      socket.receive(prompt('全然出ない'));
      await flush();
      socket.receive(prompt('出てない'));
      await flush();
      expect(socket.sent.map((m) => (m.type === 'text' ? m.token : m.type)).slice(-2)).toEqual([MESSAGES.thanks, `${MESSAGES.visitIntro}${MESSAGES.askDatetime}`]);
    });

    it('treats the date spoken during the remark as the answer to the pending question', async () => {
      const advice = deferred<FaqAnswer>();
      classify
        .mockResolvedValueOnce(heater)
        .mockResolvedValueOnce(answered)
        .mockResolvedValueOnce(answered)
        .mockResolvedValueOnce(judgment({ provides: { datetime: 0.97 } }));
      adviseOnTrouble.mockReturnValue(advice.promise);

      socket.receive(prompt('給湯器が故障してお湯が出ない'));
      await flush();
      socket.receive(prompt('全然出ない'));
      await flush();
      socket.receive(prompt('エラーは出てない'));
      await flush();
      socket.receive(prompt('明日の午前中に来てほしいです'));
      await flush();
      advice.resolve({ text: '遅れて届いた一言', ok: true, knowledgeIds: [], latencyMs: 2000 });
      await flush();

      expect(adviseOnTrouble.mock.calls[0]?.[2]?.aborted).toBe(true);
      expect(socket.sent.at(-1)).toEqual(text('明日の午前中ですね。お名前を教えてください。'));
      expect(socket.sent.map((m) => (m.type === 'text' ? m.token : ''))).not.toContain('遅れて届いた一言');
    });
  });

  it('replies to a triaged TROUBLE with the template without touching OpenAI', async () => {
    classify.mockResolvedValue(judgment({ triage: triage('KITCHEN', 'LEAK') }));
    socket.receive(prompt('キッチンの水漏れです'));
    await flush();

    expect(socket.sent).toEqual([text(KITCHEN_LEAK_ACK)]);
    expect(answerFaq).not.toHaveBeenCalled();
  });

  it('passes prior conversation (not the current utterance) to Jev as history', async () => {
    classify.mockResolvedValue(judgment({ intent: 'STATUS_CHECK' }));
    socket.receive(prompt('受付の確認です'));
    await flush();

    expect(classify).toHaveBeenCalledWith({
      utterance: '受付の確認です',
      history: [{ role: 'agent', text: MESSAGES.welcome }],
      expecting: undefined,
    });
    expect(socket.sent).toEqual([text(MESSAGES.askIdentifier)]);
  });

  it('sends the cushion immediately, then the generated FAQ answer', async () => {
    const answer = deferred<FaqAnswer>();
    classify.mockResolvedValue(judgment({ intent: 'KNOWLEDGE_FAQ' }));
    answerFaq.mockReturnValue(answer.promise);

    socket.receive(prompt('駐車場はありますか'));
    await flush();
    expect(socket.sent).toEqual([text(MESSAGES.faqCushion, { interruptible: false })]);

    answer.resolve(faqAnswer('はい、8台分の無料駐車場がございます。'));
    await flush();
    expect(socket.sent.at(-1)).toEqual(text('はい、8台分の無料駐車場がございます。'));
    expect(answerFaq).toHaveBeenCalledWith('駐車場はありますか', {}, expect.any(AbortSignal));
  });

  it('keeps generating when the caller only backchannels during the cushion', async () => {
    const answer = deferred<FaqAnswer>();
    classify.mockResolvedValue(judgment({ intent: 'KNOWLEDGE_FAQ' }));
    answerFaq.mockReturnValue(answer.promise);

    socket.receive(prompt('駐車場はありますか'));
    await flush();
    socket.receive(prompt('はい'));
    answer.resolve(faqAnswer('ございます。'));
    await flush();

    expect(classify).toHaveBeenCalledOnce();
    expect(socket.sent.at(-1)).toEqual(text('ございます。'));
  });

  it('aborts the pending FAQ and drops its answer when the caller barges in with a new request', async () => {
    const answer = deferred<FaqAnswer>();
    classify
      .mockResolvedValueOnce(judgment({ intent: 'KNOWLEDGE_FAQ' }))
      .mockResolvedValueOnce(judgment({ triage: triage('TOILET', 'CLOG') }));
    answerFaq.mockReturnValue(answer.promise);

    socket.receive(prompt('駐車場はありますか'));
    await flush();
    socket.receive(prompt('やっぱりトイレの詰まりを直してほしいです'));
    await flush();
    answer.resolve(faqAnswer('遅れて届いた回答'));
    await flush();

    expect(answerFaq.mock.calls[0]?.[2]?.aborted).toBe(true);
    expect(socket.sent.map((m) => (m.type === 'text' ? m.token : m.type))).toEqual([
      MESSAGES.faqCushion,
      `${acknowledgeTriage({ equipment: 'TOILET', symptom: 'CLOG' })}${MESSAGES.askDatetime}`,
    ]);
  });

  it('drops a stale Jev judgment when a newer utterance arrived first', async () => {
    const slow = deferred<JevJudgment>();
    classify.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(judgment({ intent: 'STATUS_CHECK' }));

    socket.receive(prompt('水漏れ'));
    socket.receive(prompt('受付の確認をしたいです'));
    await flush();
    slow.resolve(judgment({ triage: triage('KITCHEN', 'LEAK') }));
    await flush();

    expect(socket.sent).toEqual([text(MESSAGES.askIdentifier)]);
  });

  it('asks again once, then hands off on the second consecutive failure', async () => {
    classify.mockResolvedValue(judgment({ intent: 'UNKNOWN', isConfident: 0.2 }));

    socket.receive(prompt('あのー'));
    await flush();
    expect(socket.sent).toEqual([text(MESSAGES.clarify)]);

    socket.receive(prompt('えーと'));
    await flush();
    const end = socket.sent.at(-1);
    expect(end?.type).toBe('end');
    expect(JSON.parse((end as { handoffData: string }).handoffData)).toEqual({
      reason: 'CLARIFY_FAILURES',
      message: MESSAGES.handoffAfterFailures,
      sessionId: 'VX1',
    });
  });

  it('ends the relay with handoff data on HUMAN_HANDOFF and ignores later prompts', async () => {
    classify.mockResolvedValue(judgment({ intent: 'HUMAN_HANDOFF' }));
    socket.receive(prompt('オペレーターにつないでください'));
    await flush();
    socket.receive(prompt('もしもし'));
    await flush();

    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({ type: 'end' });
    expect(classify).toHaveBeenCalledOnce();
  });

  it('hands off on DTMF 0', async () => {
    socket.receive({ type: 'dtmf', digit: '0' });
    await flush();
    expect(JSON.parse((socket.sent[0] as { handoffData: string }).handoffData).reason).toBe('DTMF');
  });

  it('ignores partial transcripts, blank prompts, junk and unknown message types', async () => {
    socket.receive(prompt('よや', false));
    socket.receive(prompt('   '));
    socket.receive('not json');
    socket.receive({ type: 'mystery' });
    socket.receive({ type: 'interrupt', utteranceUntilInterrupt: 'ご予約', durationUntilInterruptMs: 300 });
    socket.receive({ type: 'error', description: 'boom' });
    await flush();

    expect(classify).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('ignores prompts that arrive before setup', async () => {
    const early = new FakeSocket();
    attach(early);
    early.receive(prompt('水漏れです'));
    await flush();
    expect(classify).not.toHaveBeenCalled();
  });

  it('escalates to a human if handling throws unexpectedly', async () => {
    classify.mockRejectedValue(new Error('unexpected'));
    socket.receive(prompt('水漏れです'));
    await flush();
    expect(JSON.parse((socket.sent[0] as { handoffData: string }).handoffData).reason).toBe('SYSTEM_ERROR');
  });

  it('apologizes if the FAQ service rejects without an abort', async () => {
    classify.mockResolvedValue(judgment({ intent: 'KNOWLEDGE_FAQ' }));
    answerFaq.mockRejectedValue(new Error('boom'));
    socket.receive(prompt('駐車場はありますか'));
    await flush();
    expect(socket.sent.at(-1)).toEqual(text(MESSAGES.faqFailed));
  });

  it('aborts in-flight work and stops sending once the socket closes', async () => {
    const answer = deferred<FaqAnswer>();
    classify.mockResolvedValue(judgment({ intent: 'KNOWLEDGE_FAQ' }));
    answerFaq.mockReturnValue(answer.promise);
    socket.receive(prompt('駐車場はありますか'));
    await flush();

    socket.readyState = 3;
    socket.emit('close');
    socket.emit('error', new Error('reset'));
    answer.resolve(faqAnswer('遅い回答'));
    await flush();

    expect(answerFaq.mock.calls[0]?.[2]?.aborted).toBe(true);
    expect(socket.sent).toHaveLength(1);
  });

  describe('call events for the browser phone page', () => {
    const IDENTITY = 'browser-0123456789ab';

    function attachWithEvents(policy: DecisionPolicy = POLICY) {
      const bus = createCallEventBus();
      const received: CallEvent[] = [];
      bus.subscribe(IDENTITY, (event) => received.push(event));
      const target = new FakeSocket();
      createRelayHandler({
        jev: { classify },
        openAi: { answerFaq, adviseOnTrouble },
        language: 'ja-JP',
        faqBargeInMinChars: 8,
        policy,
        events: bus,
      })(target, log);
      target.receive({ ...SETUP, customParameters: { identity: IDENTITY } });
      return { target, received };
    }

    it('reports a template turn as Jev-only with the judgment and server time', async () => {
      const { target, received } = attachWithEvents();
      classify.mockResolvedValue(judgment({ triage: triage('KITCHEN', 'LEAK'), latencyMs: 230 }));
      target.receive(prompt('キッチンの水漏れです'));
      await flush();

      expect(received[0]).toEqual({ type: 'caller', turn: 1, text: 'キッチンの水漏れです' });
      expect(received[1]).toMatchObject({
        type: 'agent',
        turn: 1,
        source: 'template',
        text: KITCHEN_LEAK_ACK,
        jevMs: 230,
        intent: 'TROUBLE',
        category: 'WATER',
        equipment: 'KITCHEN',
        symptom: 'LEAK',
        degraded: false,
      });
      expect((received[1] as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it('reports the cushion as Jev-only and the generated answer as OpenAI', async () => {
      const { target, received } = attachWithEvents();
      classify.mockResolvedValue(judgment({ intent: 'KNOWLEDGE_FAQ' }));
      answerFaq.mockResolvedValue({ text: '朝8時からです。', ok: true, knowledgeIds: ['service-area-hours'], latencyMs: 900 });
      target.receive(prompt('何時からやってますか'));
      await flush();

      expect(received.map((e) => (e.type === 'agent' ? e.source : e.type))).toEqual(['caller', 'template', 'openai']);
      expect(received[2]).toMatchObject({ text: '朝8時からです。', openAiMs: 900 });
    });

    it('reports the end of the call', async () => {
      const { target, received } = attachWithEvents();
      classify.mockResolvedValue(judgment({ intent: 'HUMAN_HANDOFF' }));
      target.receive(prompt('オペレーターにつないで'));
      await flush();
      expect(received.at(-1)).toMatchObject({ type: 'end', reason: 'REQUESTED', text: MESSAGES.handoff });
    });

    it('publishes nothing for calls without a browser identity', async () => {
      const bus = createCallEventBus();
      const publish = vi.spyOn(bus, 'publish');
      const target = new FakeSocket();
      createRelayHandler({ jev: { classify }, openAi: { answerFaq, adviseOnTrouble }, language: 'ja-JP', faqBargeInMinChars: 8, policy: POLICY, events: bus })(target, log);
      target.receive(SETUP);
      classify.mockResolvedValue(judgment({ triage: triage('KITCHEN', 'LEAK') }));
      target.receive(prompt('キッチンの水漏れです'));
      await flush();
      expect(publish).not.toHaveBeenCalled();
    });
  });
});
