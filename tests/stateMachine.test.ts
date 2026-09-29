import { describe, expect, it } from 'vitest';
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
} from '../src/config/messages.js';
import { extractAddress, extractDatetime, extractIdentifier, extractName } from '../src/services/slotExtraction.js';
import {
  appendTurn,
  beginCallerTurn,
  createSession,
  decide,
  decideDtmf,
  expectationOf,
  troubleContext,
  type DecisionPolicy,
  type SessionState,
} from '../src/services/stateMachine.js';
import type { JevJudgment } from '../src/types/jev.js';
import { judgment, triage } from './helpers.js';
import { detailQuestions } from '../src/config/serviceCatalog.js';

const policy: DecisionPolicy = {
  confidenceThreshold: 0.65,
  requiresHumanThreshold: 0.7,
  maxClarifyFailures: 2,
  slotThreshold: 0.6,
  emergencyThreshold: 0.7,
  // Most flows are asserted template-only; the advice variant has its own tests below.
  triageAdvice: false,
};
const session = () => createSession({ sessionId: 'VX1', callSid: 'CA1', from: '+81300000000' });
const unclear = (extra: Partial<JevJudgment> = {}) => judgment({ intent: 'UNKNOWN', isConfident: 0.1, ...extra });
const KITCHEN_LEAK = { equipment: 'KITCHEN', symptom: 'LEAK' } as const;

/** Plays a scripted conversation and returns every decision. */
function converse(steps: readonly (readonly [string, JevJudgment])[], start: SessionState = session()) {
  const decisions = [];
  let state = start;
  for (const [utterance, j] of steps) {
    const decision = decide(state, j, utterance, policy);
    decisions.push(decision);
    state = decision.state;
  }
  return decisions;
}

const spoken = (d: { action: { kind: string; text?: string } }) => (d.action.kind === 'say' ? d.action.text : d.action.kind);

describe('repair visit intake', () => {
  it('triages in one turn, then collects date, name, address, confirms and completes', () => {
    const decisions = converse([
      ['キッチンの蛇口から水漏れしてるんです', judgment({ triage: triage('KITCHEN', 'LEAK') })],
      ['明日の3時でお願いします', judgment({ provides: { datetime: 0.98 } })],
      ['中村と申します', unclear({ provides: { name: 0.97 } })],
      ['世田谷区桜丘1丁目2の3です', unclear({ provides: { address: 0.95 } })],
      ['はい', unclear({ confirmation: { choice: 'YES', confidence: 0.95 } })],
    ]);

    expect(decisions.map(spoken)).toEqual([
      `${acknowledgeTriage(KITCHEN_LEAK)}${MESSAGES.askDatetime}`,
      askName('明日の3時'),
      askAddress('中村'),
      confirmVisit(KITCHEN_LEAK, '明日の3時', '中村', '世田谷区桜丘1丁目2の3'),
      MESSAGES.visitDone,
    ]);
    expect(decisions.map((d) => expectationOf(d.state))).toEqual(['datetime', 'name', 'address', 'confirmation', undefined]);
  });

  it('with triageAdvice, confirms the situation first, then lets the LLM remark, then asks for a date', () => {
    const advicePolicy = { ...policy, triageAdvice: true };
    const heater = { equipment: 'WATER_HEATER', symptom: 'BREAKDOWN' } as const;
    const [q1, q2] = detailQuestions(heater);
    let state = session();
    const step = (utterance: string, j: JevJudgment) => {
      const d = decide(state, j, utterance, advicePolicy);
      state = d.state;
      return d;
    };

    const first = step('給湯器が故障してお湯が出ないんです', judgment({ triage: triage('WATER_HEATER', 'BREAKDOWN') }));
    expect(first.action).toEqual({ kind: 'say', text: `${acknowledgeTriage(heater)}${q1}` });
    expect(state.task).toMatchObject({ awaiting: 'detail', answers: [] });
    expect(expectationOf(state)).toBe('detail');

    const second = step('えっと、全然出ないです', unclear({ provides: { detail: 0.95 } }));
    expect(second.action).toEqual({ kind: 'say', text: q2 });
    expect(state.task).toMatchObject({ awaiting: 'detail', answers: ['全然出ない'] });

    const third = step('エラーは出てません', unclear({ provides: { detail: 0.9 } }));
    expect(third.action).toEqual({
      kind: 'faq',
      purpose: 'advice',
      cushion: MESSAGES.thanks,
      question: `給湯器が故障してお湯が出ないんです\nQ: ${q1}\nA: 全然出ない\nQ: ${q2}\nA: エラーは出てません`,
      context: { category: 'HEATER', equipment: 'WATER_HEATER', symptom: 'BREAKDOWN' },
      followUp: `${MESSAGES.visitIntro}${MESSAGES.askDatetime}`,
    });
    expect(state.task).toEqual({ kind: 'REPAIR', awaiting: 'datetime', triage: heater });
    expect(state.clarifyFailures).toBe(0);
  });

  it('re-asks the same situation question when the reply is not an answer, and answers an FAQ in between', () => {
    const advicePolicy = { ...policy, triageAdvice: true };
    const [q1] = detailQuestions({ equipment: 'TOILET', symptom: 'CLOG' });
    const first = decide(session(), judgment({ triage: triage('TOILET', 'CLOG') }), 'トイレが詰まった', advicePolicy);
    const vague = decide(first.state, unclear({ provides: { detail: 0.1 } }), 'えーっと', advicePolicy);
    expect(vague.action).toEqual({ kind: 'say', text: `${MESSAGES.sorry}${q1}` });
    const faq = decide(vague.state, judgment({ intent: 'KNOWLEDGE_FAQ', provides: { detail: 0.1 } }), 'いくらかかりますか', advicePolicy);
    expect(faq.action).toMatchObject({ kind: 'faq', purpose: 'answer', followUp: q1 });
    expect(faq.state.task?.awaiting).toBe('detail');
  });

  it('with triageAdvice, an emergency still gets the fixed first-aid line and no LLM call', () => {
    const decision = decide(session(), judgment({ triage: triage('KITCHEN', 'LEAK', 0.95, 0.92) }), '水が止まらない', {
      ...policy,
      triageAdvice: true,
    });
    expect(decision.action.kind).toBe('say');
    expect(spoken(decision)).toContain(emergencyAdvice('KITCHEN', 'LEAK'));
  });

  it('with triageAdvice, an incomplete triage still just asks for the missing half', () => {
    const decision = decide(session(), judgment({ triage: triage('UNKNOWN', 'LEAK') }), '水漏れしてて', {
      ...policy,
      triageAdvice: true,
    });
    expect(decision.action).toEqual({ kind: 'say', text: askTriage(undefined, 'LEAK') });
  });

  it('has at least one situation question for every trouble', () => {
    for (const equipment of ['FAUCET', 'TOILET', 'WATER_HEATER', 'OUTDOOR_DRAIN', 'WASHLET'] as const) {
      for (const symptom of ['LEAK', 'CLOG', 'BREAKDOWN', 'REPLACE', 'CLEANING'] as const) {
        const questions = detailQuestions({ equipment, symptom });
        expect(questions.length).toBeGreaterThanOrEqual(1);
        expect(questions.length).toBeLessThanOrEqual(2);
      }
    }
  });

  it('asks which equipment when only the symptom is known, and merges the answer', () => {
    const decisions = converse([
      ['水漏れしてるんですけど', judgment({ triage: triage('UNKNOWN', 'LEAK') })],
      ['トイレです', judgment({ triage: triage('TOILET', 'UNKNOWN') })],
    ]);
    expect(spoken(decisions[0]!)).toBe(askTriage(undefined, 'LEAK'));
    expect(decisions[0]?.state.task).toEqual({ kind: 'REPAIR', awaiting: 'triage', triage: { symptom: 'LEAK' } });
    expect(spoken(decisions[1]!)).toBe(`${acknowledgeTriage({ equipment: 'TOILET', symptom: 'LEAK' })}${MESSAGES.askDatetime}`);
  });

  it('asks what is wrong when only the equipment is known', () => {
    const [first] = converse([['給湯器なんですけど', judgment({ triage: triage('WATER_HEATER', 'UNKNOWN') })]]);
    expect(spoken(first!)).toBe(askTriage('WATER_HEATER', undefined));
  });

  it('asks for both when nothing could be triaged and ignores low-confidence choices', () => {
    const [first] = converse([['ちょっと困ってて', judgment({ triage: triage('KITCHEN', 'LEAK', 0.3) })]]);
    expect(spoken(first!)).toBe(MESSAGES.askTriage);
    expect(first?.state.task).toEqual({ kind: 'REPAIR', awaiting: 'triage', triage: {} });
  });

  it('gives the shut-off advice once on an emergency and skips the scheduling question', () => {
    const decisions = converse([
      ['キッチンの水が止まらない！', judgment({ triage: triage('KITCHEN', 'LEAK', 0.95, 0.92) })],
      ['中村です', unclear({ provides: { name: 0.95 }, triage: triage('UNKNOWN', 'UNKNOWN', 0.1, 0.9) })],
    ]);
    expect(spoken(decisions[0]!)).toBe(
      `${emergencyAdvice('KITCHEN', 'LEAK')}${acknowledgeTriage(KITCHEN_LEAK)}${MESSAGES.emergencyDispatch}`,
    );
    expect(decisions[0]?.state).toMatchObject({
      emergencyAdvised: true,
      task: { awaiting: 'name', datetime: ASAP },
    });
    expect(spoken(decisions[1]!)).toBe(askAddress('中村'));
  });

  it('keeps an emergency on the fast track while triage is still incomplete', () => {
    const decisions = converse([
      ['水が止まらない、床が水浸し', judgment({ triage: triage('UNKNOWN', 'LEAK', 0.9, 0.95) })],
      ['お風呂です', judgment({ triage: triage('BATH', 'UNKNOWN', 0.9, 0.2) })],
    ]);
    expect(spoken(decisions[0]!)).toBe(`${emergencyAdvice(undefined, 'LEAK')}${askTriage(undefined, 'LEAK')}`);
    expect(spoken(decisions[1]!)).toBe(
      `${acknowledgeTriage({ equipment: 'BATH', symptom: 'LEAK' })}${MESSAGES.emergencyDispatch}`,
    );
    expect(decisions[1]?.state.task).toMatchObject({ awaiting: 'name', datetime: ASAP });
  });

  it('picks the first-aid line by what is known about the trouble', () => {
    expect(emergencyAdvice('KITCHEN', 'LEAK')).toContain('止水栓');
    expect(emergencyAdvice(undefined, 'LEAK')).toContain('止水栓');
    expect(emergencyAdvice('OUTDOOR_DRAIN', 'CLOG')).toContain('水を流すのをやめて');
    expect(emergencyAdvice('TOILET', 'CLOG')).toContain('水を流すのをやめて');
    expect(emergencyAdvice('WATER_HEATER', 'BREAKDOWN')).toContain('給湯器の使用をやめて');
  });

  it('starts scheduling over when the caller rejects the read-back', () => {
    const decisions = converse([
      ['トイレが詰まった', judgment({ triage: triage('TOILET', 'CLOG') })],
      ['今日の夕方', judgment({ provides: { datetime: 0.9 } })],
      ['田中です', unclear({ provides: { name: 0.9 } })],
      ['中野区中央1の2', unclear({ provides: { address: 0.9 } })],
      ['いや、時間が違う', unclear({ confirmation: { choice: 'NO', confidence: 0.9 } })],
    ]);
    expect(spoken(decisions.at(-1)!)).toBe(MESSAGES.restartDatetime);
    expect(decisions.at(-1)?.state.task).toEqual({
      kind: 'REPAIR',
      awaiting: 'datetime',
      triage: { equipment: 'TOILET', symptom: 'CLOG' },
    });
  });

  it('re-asks the pending question (not the opening one) when the answer is not usable', () => {
    const decisions = converse([
      ['お風呂の水漏れ', judgment({ triage: triage('BATH', 'LEAK') })],
      ['えーっと', unclear({ provides: { datetime: 0.05 } })],
    ]);
    expect(spoken(decisions[1]!)).toBe(`${MESSAGES.sorry}${MESSAGES.askDatetime}`);
    expect(decisions[1]?.state.task?.awaiting).toBe('datetime');
  });

  it('answers an FAQ mid-intake with the trouble context and resumes the pending question', () => {
    const decisions = converse([
      ['給湯器からお湯が出ない', judgment({ triage: triage('WATER_HEATER', 'BREAKDOWN') })],
      ['その前に、いくらくらいかかりますか', judgment({ intent: 'KNOWLEDGE_FAQ', provides: { datetime: 0.02 } })],
    ]);
    expect(decisions[1]?.action).toEqual({
      kind: 'faq',
      purpose: 'answer',
      cushion: MESSAGES.faqCushion,
      question: 'その前に、いくらくらいかかりますか',
      context: { category: 'HEATER', equipment: 'WATER_HEATER', symptom: 'BREAKDOWN' },
      followUp: MESSAGES.askDatetime,
    });
    expect(decisions[1]?.state.task?.awaiting).toBe('datetime');
  });

  it('exposes a partial context while triage is incomplete', () => {
    const [first] = converse([['止水栓ってどこですか', judgment({ triage: triage('UNKNOWN', 'LEAK') })]]);
    expect(troubleContext(first!.state)).toEqual({ category: undefined, equipment: undefined, symptom: 'LEAK' });
    expect(troubleContext(session())).toEqual({});
  });

  it('hands off after two consecutive unusable answers mid-intake', () => {
    const decisions = converse([
      ['洗面台の交換をしたい', judgment({ triage: triage('WASHSTAND', 'REPLACE') })],
      ['あー', unclear({ provides: { datetime: 0.01 } })],
      ['えー', unclear({ provides: { datetime: 0.01 } })],
    ]);
    expect(decisions.at(-1)?.action).toMatchObject({ kind: 'handoff', reason: 'CLARIFY_FAILURES' });
  });
});

describe('status check flow', () => {
  it('asks for a number, then reads the result back digit by digit', () => {
    const decisions = converse([
      ['受付できてるか確認したい', judgment({ intent: 'STATUS_CHECK' })],
      ['１２３４の５６７８です', unclear({ provides: { identifier: 0.97 } })],
    ]);
    expect(spoken(decisions[0]!)).toBe(MESSAGES.askIdentifier);
    expect(spoken(decisions[1]!)).toBe(statusResult('12345678'));
    expect(decisions[1]?.state.task).toBeUndefined();
  });

  it('asks again when Jev hears a number but no digits were transcribed', () => {
    const decisions = converse([
      ['受付の確認', judgment({ intent: 'STATUS_CHECK' })],
      ['番号はえっと', unclear({ provides: { identifier: 0.8 } })],
    ]);
    expect(spoken(decisions[1]!)).toBe(`${MESSAGES.sorry}${MESSAGES.askIdentifierAgain}`);
  });
});

describe('decide', () => {
  it('routes KNOWLEDGE_FAQ with an empty context before any triage', () => {
    const { action } = decide(session(), judgment({ intent: 'KNOWLEDGE_FAQ' }), '何時までやってますか', policy);
    expect(action).toEqual({
      kind: 'faq',
      purpose: 'answer',
      cushion: MESSAGES.faqCushion,
      question: '何時までやってますか',
      context: {},
      followUp: undefined,
    });
  });

  it('hands off on HUMAN_HANDOFF even when is_confident is low, and ends the session', () => {
    const { action, state } = decide(session(), judgment({ intent: 'HUMAN_HANDOFF', isConfident: 0.3 }), '代わって', policy);
    expect(action).toMatchObject({ kind: 'handoff', reason: 'REQUESTED' });
    expect(state.status).toBe('ended');
  });

  it('hands off when requires_human crosses its threshold, even mid-intake', () => {
    const [, second] = converse([
      ['トイレの水漏れ', judgment({ triage: triage('TOILET', 'LEAK') })],
      ['ふざけるな責任者を出せ', judgment({ requiresHuman: 0.7, provides: { datetime: 0.9 } })],
    ]);
    expect(second?.action).toMatchObject({ kind: 'handoff', reason: 'REQUIRES_HUMAN' });
  });

  it('says goodbye and hangs up when the caller is done', () => {
    // Real Jev scores is_confident ~0.2 here: declining help is not a request.
    const done = judgment({ intent: 'CLOSING', intentConfidence: 0.9, isConfident: 0.22 });
    const { action, state } = decide(session(), done, '大丈夫です', policy);
    expect(action).toEqual({ kind: 'handoff', reason: 'COMPLETED', text: MESSAGES.closing });
    expect(state.status).toBe('ended');

    const hesitant = judgment({ intent: 'CLOSING', intentConfidence: 0.4, isConfident: 0.22 });
    expect(decide(session(), hesitant, 'うーん', policy).action).toEqual({ kind: 'say', text: MESSAGES.clarify });
  });

  it('asks again on UNKNOWN, and when is_confident is below 0.65 (acts at exactly 0.65)', () => {
    expect(decide(session(), judgment({ intent: 'UNKNOWN' }), 'えーと', policy).action).toEqual({
      kind: 'say',
      text: MESSAGES.clarify,
    });
    expect(decide(session(), judgment({ isConfident: 0.64 }), 'みずもれ…', policy).state.task).toBeUndefined();
    const acted = decide(session(), judgment({ isConfident: 0.65, triage: triage('BATH', 'LEAK') }), 'お風呂の水漏れ', policy);
    expect(acted.state.task?.kind).toBe('REPAIR');
  });

  it('hands off after two consecutive failures, and resets the streak once understood', () => {
    const decisions = converse([
      ['あー', unclear()],
      ['何時までやってますか', judgment({ intent: 'KNOWLEDGE_FAQ' })],
      ['えー', unclear()],
      ['うー', unclear()],
    ]);
    expect(decisions[1]?.state.clarifyFailures).toBe(0);
    expect(decisions[2]?.action.kind).toBe('say');
    expect(decisions[3]?.action).toEqual({
      kind: 'handoff',
      reason: 'CLARIFY_FAILURES',
      text: MESSAGES.handoffAfterFailures,
    });
  });

  it('uses the hint wording on later misses when the policy allows more than two', () => {
    const lenient = { ...policy, maxClarifyFailures: 3 };
    const first = decide(session(), unclear(), 'あー', lenient);
    expect(decide(first.state, unclear(), 'うー', lenient).action).toEqual({ kind: 'say', text: MESSAGES.clarifyWithHint });
  });

  it('treats a degraded (Jev unreachable) judgment as a clarification, not a crash', () => {
    expect(decide(session(), unclear({ degraded: true }), '水漏れ', policy).action.kind).toBe('say');
  });

  it('never mutates the input state', () => {
    const state = Object.freeze(session());
    decide(state, judgment({ triage: triage('KITCHEN', 'LEAK') }), 'キッチンの水漏れ', policy);
    expect(state.task).toBeUndefined();
  });
});

describe('slot extraction', () => {
  it.each([
    ['えっと、明日の３時でお願いします', '明日の3時'],
    ['来週の金曜日、午後6時半がいいです', '来週の金曜日、午後6時半'],
    ['十二月三日の十五時', '十二月三日の十五時'],
    ['18:30で', '18:30'],
    ['明日の午前中に来てほしいです', '明日の午前中'],
    ['なるべく早めでお願いします', 'なるべく早め'],
  ])('datetime: 「%s」 -> 「%s」', (utterance, expected) => {
    expect(extractDatetime(utterance)).toBe(expected);
  });

  it.each([
    ['中村と申します', '中村'],
    ['えーと、名前は田中太郎です。', '田中太郎'],
    ['私は佐藤といいます', '佐藤'],
    ['鈴木', '鈴木'],
  ])('name: 「%s」 -> 「%s」', (utterance, expected) => {
    expect(extractName(utterance)).toBe(expected);
  });

  it.each([
    ['住所は世田谷区桜丘１丁目２の３です', '世田谷区桜丘1丁目2の3'],
    ['えっと、中野区中央1の2、サンハイツ203です', '中野区中央1の2、サンハイツ203'],
  ])('address: 「%s」 -> 「%s」', (utterance, expected) => {
    expect(extractAddress(utterance)).toBe(expected);
  });

  it('identifier: joins spoken digit groups and rejects non-numbers', () => {
    expect(extractIdentifier('090-1234-5678 です')).toBe('09012345678');
    expect(extractIdentifier('１２３４')).toBe('1234');
    expect(extractIdentifier('わかりません')).toBeUndefined();
  });
});

describe('session helpers', () => {
  it('advances the turn counter and records the caller utterance', () => {
    const next = beginCallerTurn(session(), '水漏れです');
    expect(next.turn).toBe(1);
    expect(next.history.at(-1)).toEqual({ role: 'caller', text: '水漏れです' });
  });

  it('keeps only the most recent history turns', () => {
    const state = Array.from({ length: 20 }).reduce<SessionState>(
      (acc, _, index) => appendTurn(acc, { role: 'caller', text: `t${index}` }),
      session(),
    );
    expect(state.history).toHaveLength(6);
    expect(state.history.at(-1)?.text).toBe('t19');
  });

  it('hands off on DTMF 0 and ignores other digits', () => {
    expect(decideDtmf(session(), '0')?.action).toMatchObject({ kind: 'handoff', reason: 'DTMF' });
    expect(decideDtmf(session(), '5')).toBeUndefined();
  });
});
