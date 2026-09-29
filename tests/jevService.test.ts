import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJevService, IVR_QUESTIONS, type JevServiceConfig } from '../src/services/jevService.js';
import { silentLogger } from './helpers.js';

const ORIGIN = 'https://api.typesafe.ai';
const PATH = '/v1/systemone';
const config: JevServiceConfig = {
  apiKey: 'ts-test-key',
  apiUrl: `${ORIGIN}${PATH}`,
  model: 'jev-latest',
  timeoutMs: 300,
  maxRetries: 1,
};

const okBody = {
  model: 'jev-1.13.0',
  answers: {
    intent: {
      type: 'choice',
      choice: 'STATUS_CHECK',
      probabilities: { TROUBLE: 0.05, STATUS_CHECK: 0.9, KNOWLEDGE_FAQ: 0.03, HUMAN_HANDOFF: 0.01, CLOSING: 0, UNKNOWN: 0.01 },
      confidence: 0.87,
    },
    is_confident: { type: 'noul', noul: 0.93 },
    requires_human: { type: 'noul', noul: 0.04 },
  },
  usage: { input_tokens: 400, output_tokens: 40 },
};

const input = { utterance: '受付の確認をしたい', history: [{ role: 'agent' as const, text: 'ご用件をどうぞ' }], expecting: 'identifier' as const };

describe('jevService.classify', () => {
  let agent: MockAgent;
  const pool = () => agent.get(ORIGIN);

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
  });

  afterEach(async () => {
    await agent.close();
  });

  it('sends state + the three questions and normalizes the answers', async () => {
    let sent: { headers: Record<string, string>; body: Record<string, unknown> } | undefined;
    pool()
      .intercept({ path: PATH, method: 'POST' })
      .reply(200, (request) => {
        sent = {
          headers: request.headers as Record<string, string>,
          body: JSON.parse(String(request.body)) as Record<string, unknown>,
        };
        return okBody;
      });

    const result = await createJevService(config, silentLogger(), agent).classify(input);

    expect(result).toMatchObject({
      intent: 'STATUS_CHECK',
      intentConfidence: 0.87,
      isConfident: 0.93,
      requiresHuman: 0.04,
      degraded: false,
    });
    expect(sent?.headers.authorization).toBe('Bearer ts-test-key');
    expect(sent?.body).toMatchObject({
      model: 'jev-latest',
      state: {
        latest_caller_utterance: '受付の確認をしたい',
        recent_turns: [{ speaker: 'agent', text: 'ご用件をどうぞ' }],
      },
    });
    expect(Object.keys(sent?.body.questions as object)).toEqual([
      'intent',
      'is_confident',
      'requires_human',
      'provides_identifier',
    ]);
  });

  const triageAnswers = {
    equipment: { type: 'choice', choice: 'KITCHEN', probabilities: { KITCHEN: 0.9, UNKNOWN: 0.1 }, confidence: 0.88 },
    symptom: { type: 'choice', choice: 'LEAK', probabilities: { LEAK: 0.95, UNKNOWN: 0.05 }, confidence: 0.94 },
    is_emergency: { type: 'noul', noul: 0.12 },
  };

  it('asks the triage questions plus the date when nothing is pending', async () => {
    let questions: string[] = [];
    pool()
      .intercept({ path: PATH, method: 'POST' })
      .reply(200, (request) => {
        questions = Object.keys((JSON.parse(String(request.body)) as { questions: object }).questions);
        return { ...okBody, answers: { ...okBody.answers, ...triageAnswers, provides_datetime: { type: 'noul', noul: 0.02 } } };
      });

    const result = await createJevService(config, silentLogger(), agent).classify({ ...input, expecting: undefined });

    expect(questions).toEqual(['intent', 'is_confident', 'requires_human', 'equipment', 'symptom', 'is_emergency', 'provides_datetime']);
    expect(result.triage).toEqual({
      equipment: { choice: 'KITCHEN', confidence: 0.88 },
      symptom: { choice: 'LEAK', confidence: 0.94 },
      emergency: 0.12,
    });
    expect(result.provides).toEqual({ datetime: 0.02, name: undefined, address: undefined, identifier: undefined, detail: undefined });
  });

  it('asks only the triage questions while triage is pending', async () => {
    let questions: string[] = [];
    pool()
      .intercept({ path: PATH, method: 'POST' })
      .reply(200, (request) => {
        questions = Object.keys((JSON.parse(String(request.body)) as { questions: object }).questions);
        return { ...okBody, answers: { ...okBody.answers, ...triageAnswers } };
      });

    const result = await createJevService(config, silentLogger(), agent).classify({ ...input, expecting: 'triage' });

    expect(questions).toEqual(['intent', 'is_confident', 'requires_human', 'equipment', 'symptom', 'is_emergency']);
    expect(result.triage?.equipment.choice).toBe('KITCHEN');
  });

  it('offers every intent, including the no-match option, as a Choice criterion', () => {
    expect(IVR_QUESTIONS.intent.type).toBe('choice');
    expect(Object.keys((IVR_QUESTIONS.intent as { criteria: object }).criteria)).toEqual([
      'TROUBLE',
      'STATUS_CHECK',
      'KNOWLEDGE_FAQ',
      'HUMAN_HANDOFF',
      'CLOSING',
      'UNKNOWN',
    ]);
  });

  it.each([
    ['name', 'provides_name', { type: 'noul', noul: 0.97 }, { provides: { name: 0.97 } }],
    ['address', 'provides_address', { type: 'noul', noul: 0.88 }, { provides: { address: 0.88 } }],
    ['detail', 'answers_question', { type: 'noul', noul: 0.91 }, { provides: { detail: 0.91 } }],
    ['identifier', 'provides_identifier', { type: 'noul', noul: 0.9 }, { provides: { identifier: 0.9 } }],
    [
      'confirmation',
      'confirmation',
      { type: 'choice', choice: 'YES', probabilities: { YES: 0.95, NO: 0.03, NEITHER: 0.02 }, confidence: 0.92 },
      { confirmation: { choice: 'YES', confidence: 0.92 } },
    ],
  ] as const)('asks the %s slot question when the agent is expecting it', async (expecting, questionId, answer, expected) => {
    let questions: string[] = [];
    pool()
      .intercept({ path: PATH, method: 'POST' })
      .reply(200, (request) => {
        questions = Object.keys((JSON.parse(String(request.body)) as { questions: object }).questions);
        return { ...okBody, answers: { ...okBody.answers, [questionId]: answer } };
      });

    const result = await createJevService(config, silentLogger(), agent).classify({ ...input, expecting });

    expect(questions).toEqual(['intent', 'is_confident', 'requires_human', questionId]);
    expect(result).toMatchObject(expected);
  });

  it('retries once on 529 overload and succeeds', async () => {
    pool().intercept({ path: PATH, method: 'POST' }).reply(529, { error: 'overloaded' });
    pool().intercept({ path: PATH, method: 'POST' }).reply(200, okBody);
    const logger = silentLogger();

    const result = await createJevService(config, logger, agent).classify(input);

    expect(result.intent).toBe('STATUS_CHECK');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('does not retry a 401 and degrades to UNKNOWN', async () => {
    pool().intercept({ path: PATH, method: 'POST' }).reply(401, { error: 'bad key' });
    const logger = silentLogger();

    const result = await createJevService(config, logger, agent).classify(input);

    expect(result).toMatchObject({ intent: 'UNKNOWN', isConfident: 0, degraded: true });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('degrades when retries are exhausted', async () => {
    pool().intercept({ path: PATH, method: 'POST' }).reply(503, 'down').times(2);
    const result = await createJevService(config, silentLogger(), agent).classify(input);
    expect(result.degraded).toBe(true);
  });

  it('degrades on a response that does not match the schema', async () => {
    pool()
      .intercept({ path: PATH, method: 'POST' })
      .reply(200, { ...okBody, answers: { ...okBody.answers, intent: { ...okBody.answers.intent, choice: 'PIZZA' } } });
    const result = await createJevService(config, silentLogger(), agent).classify(input);
    expect(result.degraded).toBe(true);
  });

  it('degrades on timeout instead of stalling the call', async () => {
    pool().intercept({ path: PATH, method: 'POST' }).reply(200, okBody).delay(1000);
    const result = await createJevService({ ...config, timeoutMs: 50 }, silentLogger(), agent).classify(input);
    expect(result.degraded).toBe(true);
    expect(result.latencyMs).toBeLessThan(500);
  });
});
