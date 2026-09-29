import OpenAI from 'openai';
import rawErrorCodes from '../errorCodes.json' with { type: 'json' };
import rawKnowledge from '../mockKnowledge.json' with { type: 'json' };
import { MESSAGES } from '../config/messages.js';
import { CATEGORY_LABEL, describeTriage, EQUIPMENT_LABEL, SYMPTOM_LABEL } from '../config/serviceCatalog.js';
import { describeErrorCodes, findErrorCodes, parseErrorCodes, type ErrorCodeEntry } from './errorCodes.js';
import { parseKnowledge, searchKnowledge, type KnowledgeEntry, type KnowledgeHit } from './knowledgeSearch.js';
import type { TroubleContext } from './stateMachine.js';

const TEMPERATURE = 0.2;
// ~100 Japanese characters fit comfortably; the cap only guards against runaway output.
const MAX_COMPLETION_TOKENS = 200;

export interface OpenAiServiceConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  /** Limit for FAQ answers. */
  readonly maxChars: number;
  /** Limit for the remark spoken right after triage. */
  readonly adviceMaxChars: number;
}

export interface OpenAiLogger {
  error(obj: object, msg: string): void;
}

export interface FaqAnswer {
  readonly text: string;
  /** False when generation failed and `text` is the canned apology. */
  readonly ok: boolean;
  readonly knowledgeIds: readonly string[];
  readonly latencyMs: number;
}

export interface OpenAiService {
  /** Rejects only when `signal` is aborted (caller barged in); other failures resolve with `ok: false`. */
  answerFaq(question: string, context?: TroubleContext, signal?: AbortSignal): Promise<FaqAnswer>;
  /**
   * One or two sentences about the trouble the caller just described (a check they can do now,
   * first aid, or reassurance). On failure resolves with `text: ''` so the intake simply goes on.
   */
  adviseOnTrouble(utterance: string, context: TroubleContext, signal?: AbortSignal): Promise<FaqAnswer>;
}

export interface CompletionParams {
  readonly system: string;
  readonly user: string;
  readonly signal?: AbortSignal;
}

export type CompleteFn = (params: CompletionParams) => Promise<string | null>;

export function buildSystemPrompt(maxChars: number): string {
  return [
    'あなたは水まわり修理業者（水道・給湯器・排水・トイレリフォーム）の電話自動応答の音声アシスタントです。回答はそのまま音声合成で読み上げられます。',
    '# 厳守するルール',
    `- 回答は必ず${maxChars}文字以内。1〜2文の簡潔で自然な話し言葉（です・ます調）にする。`,
    '- 記号、箇条書き、絵文字、URL、Markdown、括弧書きは使わない。数字は聞き取りやすい形で述べる。',
    '- 「参考情報」に書かれている事実だけを根拠に答える。推測や創作はしない。',
    '- 参考情報に答えがない場合は、分かりかねる旨を伝え、オペレーターにおつなぎできると一言で案内する。',
    '- 前置き、復唱、締めの挨拶は不要。質問への答えだけを述べる。',
    '- 安全第一。分解や工具を使う作業、電気やガスの配線に触れる作業は勧めない。ガスのにおいがある場合は使用中止と換気を最優先で案内する。',
  ].join('\n');
}

/** 「給湯器の修理: 給湯器の故障」 — what Jev found out, so the answer fits the caller's situation. */
export function describeContext(context: TroubleContext): string | undefined {
  const { category, equipment, symptom } = context;
  if (equipment && symptom) return `${CATEGORY_LABEL[category ?? 'WATER']}: ${describeTriage({ equipment, symptom })}`;
  if (equipment) return `${EQUIPMENT_LABEL[equipment]}のトラブル`;
  if (symptom) return `${SYMPTOM_LABEL[symptom]}のトラブル`;
  return undefined;
}

function knowledgeBlock(hits: readonly KnowledgeHit[]): string {
  return hits.length === 0
    ? '（該当する情報なし）'
    : hits.map(({ entry }, index) => `${index + 1}. Q: ${entry.question}\n   A: ${entry.answer}`).join('\n');
}

export function buildUserPrompt(
  question: string,
  hits: readonly KnowledgeHit[],
  context: TroubleContext = {},
  errorCodes?: string,
): string {
  const situation = describeContext(context);
  return [
    `# 参考情報\n${knowledgeBlock(hits)}`,
    errorCodes && `${errorCodes}\nコードは一桁ずつ読む（例: 140 は「いち、よん、ぜろ」）。`,
    situation && `# お客様の状況\n${situation}`,
    `# お客様の質問\n${question}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** A replacement or cleaning is a planned job, not a fault: the remark should be about the work, not first aid. */
const isPlannedWork = (context: TroubleContext) => context.symptom === 'REPLACE' || context.symptom === 'CLEANING';

export function buildAdvicePrompt(
  utterance: string,
  hits: readonly KnowledgeHit[],
  context: TroubleContext,
  maxChars: number,
  errorCodes?: string,
): string {
  const focus = isPlannedWork(context)
    ? '内容は、作業の概要、所要時間や料金の目安、事前に確認しておくとよい点のいずれか。応急処置の話はしない。'
    : '内容は、今すぐできる確認や応急処置、または安心につながる情報のいずれか。';
  const codeRule = errorCodes
    ? 'お客様が口にしたエラーコードには、エラーコード情報の意味と対処を最優先で答える。コードは一桁ずつ読む（例: 111 は「いち、いち、いち」）。'
    : 'エラーコードについて、エラーコード情報がない場合は、番号を復唱したり意味を推測したり「お伺いします」と約束したりしない。';
  return [
    `# お客様の申告（最初の申告と、確認の質問への答え）\n${utterance}`,
    `# お客様の状況\n${describeContext(context) ?? '不明'}`,
    errorCodes,
    `# 参考情報\n${knowledgeBlock(hits)}`,
    '# 指示',
    `これから訪問の受付に進みます。その前にお客様へ伝える一言を${maxChars}文字以内、1〜2文で作ってください。`,
    `${codeRule}${focus}お客様がすでに答えた内容（確認済みのこと、試したこと）を聞き直したり繰り返したりしない。参考情報にないことは断定しない。`,
    '質問はしない（日時や名前はこのあとシステムが聞きます）。挨拶や復唱も不要。「お伺いします」という言葉は、このあとシステムが訪問の案内に使うので、ここでは使わない。',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Makes LLM output safe to read aloud and enforces the hard character limit. */
export function toSpeech(text: string, maxChars: number): string {
  const cleaned = text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#`>|~]/g, '')
    .replace(/^\s*[-・]\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(cleaned);
  if (chars.length <= maxChars) return cleaned;

  const head = chars.slice(0, maxChars).join('');
  const sentenceEnd = Math.max(head.lastIndexOf('。'), head.lastIndexOf('？'), head.lastIndexOf('！'));
  if (sentenceEnd > 0) return head.slice(0, sentenceEnd + 1);
  return `${chars.slice(0, maxChars - 1).join('')}。`;
}

function createCompleteFn(config: OpenAiServiceConfig): CompleteFn {
  const client = new OpenAI({ apiKey: config.apiKey, timeout: config.timeoutMs, maxRetries: 1 });
  return async ({ system, user, signal }) => {
    const completion = await client.chat.completions.create(
      {
        model: config.model,
        temperature: TEMPERATURE,
        max_tokens: MAX_COMPLETION_TOKENS,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
      { signal },
    );
    return completion.choices[0]?.message.content ?? null;
  };
}

export function createOpenAiService(
  config: OpenAiServiceConfig,
  logger: OpenAiLogger,
  deps: { complete?: CompleteFn; knowledge?: readonly KnowledgeEntry[]; errorCodes?: readonly ErrorCodeEntry[] } = {},
): OpenAiService {
  const complete = deps.complete ?? createCompleteFn(config);
  const knowledge = deps.knowledge ?? parseKnowledge(rawKnowledge);
  const errorCodes = deps.errorCodes ?? parseErrorCodes(rawErrorCodes);
  const codesIn = (text: string) => describeErrorCodes(findErrorCodes(text, errorCodes));
  const system = buildSystemPrompt(config.maxChars);

  async function answerFaq(question: string, context: TroubleContext = {}, signal?: AbortSignal): Promise<FaqAnswer> {
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    const hits = searchKnowledge(knowledge, question, { category: context.category, equipment: context.equipment });
    const knowledgeIds = hits.map((hit) => hit.entry.id);

    try {
      const content = await complete({ system, user: buildUserPrompt(question, hits, context, codesIn(question)), signal });
      const text = toSpeech(content ?? '', config.maxChars);
      if (text === '') throw new Error('OpenAI returned an empty completion');
      return { text, ok: true, knowledgeIds, latencyMs: elapsed() };
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: message, latencyMs: elapsed() }, 'FAQ generation failed');
      return { text: MESSAGES.faqFailed, ok: false, knowledgeIds, latencyMs: elapsed() };
    }
  }

  async function adviseOnTrouble(utterance: string, context: TroubleContext, signal?: AbortSignal): Promise<FaqAnswer> {
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    const situation = context.equipment && context.symptom ? describeTriage({ equipment: context.equipment, symptom: context.symptom }) : '';
    const hits = searchKnowledge(knowledge, `${situation} ${utterance}`, { category: context.category, equipment: context.equipment });
    const knowledgeIds = hits.map((hit) => hit.entry.id);

    try {
      const user = buildAdvicePrompt(utterance, hits, context, config.adviceMaxChars, codesIn(utterance));
      const content = await complete({ system, user, signal });
      const text = toSpeech(content ?? '', config.adviceMaxChars);
      if (text === '') throw new Error('OpenAI returned an empty completion');
      return { text, ok: true, knowledgeIds, latencyMs: elapsed() };
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: message, latencyMs: elapsed() }, 'triage advice generation failed; continuing without it');
      return { text: '', ok: false, knowledgeIds, latencyMs: elapsed() };
    }
  }

  return { answerFaq, adviseOnTrouble };
}
