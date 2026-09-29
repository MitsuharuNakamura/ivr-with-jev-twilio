import { describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/config/messages.js';
import rawKnowledge from '../src/mockKnowledge.json' with { type: 'json' };
import { parseKnowledge, searchKnowledge } from '../src/services/knowledgeSearch.js';
import {
  buildSystemPrompt,
  createOpenAiService,
  toSpeech,
  type CompleteFn,
} from '../src/services/openAiService.js';
import { silentLogger } from './helpers.js';

const config = { apiKey: 'sk-test', model: 'gpt-4o-mini', timeoutMs: 1000, maxChars: 100, adviceMaxChars: 60 };
const knowledge = parseKnowledge(rawKnowledge);

describe('searchKnowledge', () => {
  it.each([
    ['キッチンの止水栓ってどこにあるの', 'shutoff-kitchen'],
    ['お湯が出ないんだけど何を確認すればいい', 'heater-no-hot-water'],
    ['何時まで営業してますか', 'service-area-hours'],
    ['ウォシュレットの取り付けはできますか', 'remodel-washlet'],
  ])('finds the right entry for 「%s」', (query, expectedId) => {
    expect(searchKnowledge(knowledge, query)[0]?.entry.id).toBe(expectedId);
  });

  it('prefers entries matching the triaged category and equipment', () => {
    const query = '止水栓はどこですか';
    expect(searchKnowledge(knowledge, query, { category: 'WATER', equipment: 'TOILET' })[0]?.entry.id).toBe('shutoff-toilet');
    expect(searchKnowledge(knowledge, query, { category: 'WATER', equipment: 'KITCHEN' })[0]?.entry.id).toBe('shutoff-kitchen');
  });

  it('still finds general entries when the context does not match them', () => {
    const hits = searchKnowledge(knowledge, '支払いはカードでもいいですか', { category: 'HEATER', equipment: 'WATER_HEATER' });
    expect(hits[0]?.entry.id).toBe('payment');
  });

  it('returns nothing for unrelated or empty queries', () => {
    expect(searchKnowledge(knowledge, '量子コンピュータの仕組み')).toEqual([]);
    expect(searchKnowledge(knowledge, '')).toEqual([]);
  });

  it('respects the result limit', () => {
    expect(searchKnowledge(knowledge, '水漏れと詰まりの料金', { limit: 1, minScore: 0 })).toHaveLength(1);
  });
});

describe('toSpeech', () => {
  it('strips markdown, URLs and line breaks', () => {
    expect(toSpeech('**はい**、あります。\n- 詳細は https://example.com をご覧ください。', 100)).toBe(
      'はい、あります。 詳細は をご覧ください。',
    );
  });

  it('cuts at the last sentence boundary within the limit', () => {
    const text = `${'あ'.repeat(40)}。${'い'.repeat(80)}。`;
    expect(toSpeech(text, 100)).toBe(`${'あ'.repeat(40)}。`);
  });

  it('hard-truncates a single over-long sentence', () => {
    const result = toSpeech('あ'.repeat(150), 100);
    expect(Array.from(result)).toHaveLength(100);
    expect(result.endsWith('。')).toBe(true);
  });
});

describe('openAiService.answerFaq', () => {
  it('grounds the prompt in category-scoped knowledge and the caller situation', async () => {
    const complete = vi.fn<CompleteFn>().mockResolvedValue('タンク横の給水管にある止水栓を右に回して閉めてください。');
    const service = createOpenAiService(config, silentLogger(), { complete });

    const answer = await service.answerFaq('止水栓はどこですか', { category: 'WATER', equipment: 'TOILET', symptom: 'LEAK' });

    expect(answer).toMatchObject({ ok: true, text: 'タンク横の給水管にある止水栓を右に回して閉めてください。' });
    expect(answer.knowledgeIds[0]).toBe('shutoff-toilet');
    const params = complete.mock.calls[0]?.[0];
    expect(params?.system).toBe(buildSystemPrompt(100));
    expect(params?.system).toContain('100文字以内');
    expect(params?.system).toContain('水まわり修理業者');
    expect(params?.user).toContain('タンクの横の壁');
    expect(params?.user).toContain('# お客様の状況\n水道の修理: トイレの水漏れ');
    expect(params?.user).toContain('止水栓はどこですか');
  });

  it('also looks codes up for a direct FAQ question', async () => {
    const complete = vi.fn<CompleteFn>().mockResolvedValue('点検時期のお知らせで、故障ではありません。');
    await createOpenAiService(config, silentLogger(), { complete }).answerFaq('888って何ですか', { category: 'HEATER', equipment: 'WATER_HEATER', symptom: 'BREAKDOWN' });
    expect(complete.mock.calls[0]?.[0].user).toContain('コード 888: 点検時期のお知らせ');
  });

  it('omits the situation block before any triage', async () => {
    const complete = vi.fn<CompleteFn>().mockResolvedValue('朝8時から夜10時までです。');
    await createOpenAiService(config, silentLogger(), { complete }).answerFaq('何時までやってますか');
    expect(complete.mock.calls[0]?.[0].user).not.toContain('お客様の状況');
  });

  it('tells the model when no knowledge matched', async () => {
    const complete = vi.fn<CompleteFn>().mockResolvedValue('申し訳ございません、分かりかねます。');
    await createOpenAiService(config, silentLogger(), { complete }).answerFaq('量子コンピュータの仕組み');
    expect(complete.mock.calls[0]?.[0].user).toContain('該当する情報なし');
  });

  it('clamps answers that ignore the length instruction', async () => {
    const complete = vi.fn<CompleteFn>().mockResolvedValue('あ'.repeat(300));
    const answer = await createOpenAiService(config, silentLogger(), { complete }).answerFaq('料金');
    expect(Array.from(answer.text).length).toBeLessThanOrEqual(100);
  });

  it.each([
    ['an API error', () => Promise.reject(new Error('503'))],
    ['an empty completion', () => Promise.resolve(null)],
  ])('falls back to the apology on %s', async (_label, impl) => {
    const logger = silentLogger();
    const service = createOpenAiService(config, logger, { complete: vi.fn<CompleteFn>().mockImplementation(impl) });
    expect(await service.answerFaq('いくらかかりますか')).toMatchObject({ ok: false, text: MESSAGES.faqFailed });
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('rejects when aborted so the caller can drop the stale answer', async () => {
    const controller = new AbortController();
    const complete: CompleteFn = ({ signal }) =>
      new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    const pending = createOpenAiService(config, silentLogger(), { complete }).answerFaq('料金', {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });
});

describe('openAiService.adviseOnTrouble', () => {
  const heater = { category: 'HEATER', equipment: 'WATER_HEATER', symptom: 'BREAKDOWN' } as const;

  it('asks for a short, question-free remark grounded in the caller situation and knowledge', async () => {
    const complete = vi.fn<CompleteFn>().mockResolvedValue('リモコンにエラー番号が出ていないかご確認ください。');
    const answer = await createOpenAiService(config, silentLogger(), { complete }).adviseOnTrouble('給湯器が壊れてお湯が出ない', heater);

    expect(answer).toMatchObject({ ok: true, text: 'リモコンにエラー番号が出ていないかご確認ください。' });
    expect(answer.knowledgeIds).toContain('heater-no-hot-water');
    const user = complete.mock.calls[0]?.[0].user ?? '';
    expect(user).toContain('確認の質問への答え）\n給湯器が壊れてお湯が出ない');
    expect(user).toContain('# お客様の状況\n給湯器の修理: 給湯器の故障');
    expect(user).toContain('エラー番号が出ていないか');
    expect(user).toContain('60文字以内');
    expect(user).toContain('質問はしない');
  });

  it('passes the meaning and remedy of a spoken error code to the LLM', async () => {
    const complete = vi.fn<CompleteFn>().mockResolvedValue('点火不良の表示です。ガスの元栓を確認し、運転を入れ直してください。');
    const report = '給湯器が故障してお湯が出ない\nQ: お風呂のリモコンにエラー番号は出ていますか。\nA: 111が出てます';
    await createOpenAiService(config, silentLogger(), { complete }).adviseOnTrouble(report, heater);
    const user = complete.mock.calls[0]?.[0].user ?? '';
    expect(user).toContain('# エラーコード情報');
    expect(user).toContain('コード 111: 点火不良');
    expect(user).toContain('エラーコード情報の意味と対処を最優先で答える');
  });

  it('tells the LLM not to guess an unregistered code', async () => {
    const complete = vi.fn<CompleteFn>().mockResolvedValue('登録のないコードですので、お伺いの際に確認します。');
    await createOpenAiService(config, silentLogger(), { complete }).adviseOnTrouble('リモコンに999が出ています', heater);
    expect(complete.mock.calls[0]?.[0].user).toContain('コード 999: 登録なし');
  });

  it('omits the error-code block when no code was spoken', async () => {
    const complete = vi.fn<CompleteFn>().mockResolvedValue('ガスの元栓をご確認ください。');
    await createOpenAiService(config, silentLogger(), { complete }).adviseOnTrouble('お湯が全然出ない', heater);
    expect(complete.mock.calls[0]?.[0].user).not.toContain('# エラーコード情報');
    expect(complete.mock.calls[0]?.[0].user).toContain('「お伺いします」と約束したりしない');
  });

  it('asks about the work rather than first aid for a planned replacement or cleaning', async () => {
    const complete = vi.fn<CompleteFn>().mockResolvedValue('作業は2時間ほどで、料金は2万円からです。');
    await createOpenAiService(config, silentLogger(), { complete }).adviseOnTrouble('高圧洗浄をお願いしたい', {
      category: 'DRAINAGE',
      equipment: 'OUTDOOR_DRAIN',
      symptom: 'CLEANING',
    });
    const user = complete.mock.calls[0]?.[0].user ?? '';
    expect(user).toContain('作業の概要');
    expect(user).toContain('応急処置の話はしない');
  });

  it('clamps the remark to the advice limit', async () => {
    const complete = vi.fn<CompleteFn>().mockResolvedValue('あ'.repeat(200));
    const answer = await createOpenAiService(config, silentLogger(), { complete }).adviseOnTrouble('蛇口が水漏れ', { category: 'WATER', equipment: 'FAUCET', symptom: 'LEAK' });
    expect(Array.from(answer.text).length).toBeLessThanOrEqual(60);
  });

  it.each([
    ['an API error', () => Promise.reject(new Error('503'))],
    ['an empty completion', () => Promise.resolve(null)],
  ])('returns an empty remark (not an apology) on %s', async (_label, impl) => {
    const logger = silentLogger();
    const service = createOpenAiService(config, logger, { complete: vi.fn<CompleteFn>().mockImplementation(impl) });
    expect(await service.adviseOnTrouble('お湯が出ない', heater)).toMatchObject({ ok: false, text: '' });
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('rejects when aborted', async () => {
    const controller = new AbortController();
    const complete: CompleteFn = ({ signal }) =>
      new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    const pending = createOpenAiService(config, silentLogger(), { complete }).adviseOnTrouble('お湯が出ない', heater, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });
});
