import { z } from 'zod';
import { EQUIPMENT } from '../config/serviceCatalog.js';

/**
 * Error codes shown on equipment displays (e.g. the bath remote of a water heater),
 * kept in `src/errorCodes.json` so the business can add or change entries without
 * touching code. Matched codes are handed to the LLM as facts; unknown codes are
 * reported as unknown so it does not guess.
 */
export const errorCodeEntrySchema = z.object({
  code: z.string().regex(/^[A-Z]?\d{1,4}$/, 'code must be digits, optionally with a letter prefix (111, E1)'),
  equipment: z.enum(EQUIPMENT),
  meaning: z.string().min(1),
  action: z.string().min(1),
  needsVisit: z.string().min(1),
});

export type ErrorCodeEntry = Readonly<z.infer<typeof errorCodeEntrySchema>>;

export interface ErrorCodeMatch {
  readonly code: string;
  /** Undefined when the code was spoken but is not in the table. */
  readonly entry?: ErrorCodeEntry;
}

// 3–4 digits (111, 888) or a letter plus 1–2 digits (E1, F14), as a whole token.
const CODE_PATTERN = /(?<![\dA-Z])(?:[A-Z]\d{1,2}|\d{3,4})(?![\dA-Z])/g;

export function parseErrorCodes(raw: unknown): readonly ErrorCodeEntry[] {
  const entries = z.array(errorCodeEntrySchema).parse(raw);
  const duplicates = entries.map((e) => e.code).filter((code, i, all) => all.indexOf(code) !== i);
  if (duplicates.length > 0) throw new Error(`errorCodes.json: duplicate code(s) ${duplicates.join(', ')}`);
  return entries;
}

const KANJI_DIGITS: Readonly<Record<string, string>> = {
  '〇': '0', '零': '0', '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9',
};
// Digit words as speech-to-text sometimes spells them (「いちいちいち」). Longest first so 「きゅう」 wins over 「く」.
const KANA_DIGITS: readonly (readonly [string, string])[] = [
  ['ぜろ', '0'], ['れい', '0'], ['いち', '1'], ['さん', '3'], ['よん', '4'], ['ろく', '6'], ['なな', '7'], ['しち', '7'],
  ['はち', '8'], ['きゅう', '9'], ['に', '2'], ['し', '4'], ['ご', '5'], ['く', '9'],
];
const KANA_DIGIT_RUN = new RegExp(`(?:${KANA_DIGITS.map(([word]) => word).join('|')}){3,}`, 'g');

/** 「一一一」 → "111", 「いちよんぜろ」 → "140". Kana runs shorter than three digit words are left alone (に, ご …). */
export function spokenDigitsToAscii(text: string): string {
  const kanji = text.replace(/[〇零一二三四五六七八九]/g, (char) => KANJI_DIGITS[char] ?? char);
  return kanji.replace(KANA_DIGIT_RUN, (run) =>
    run.replace(new RegExp(KANA_DIGITS.map(([word]) => word).join('|'), 'g'), (word) => KANA_DIGITS.find(([w]) => w === word)?.[1] ?? word),
  );
}

/** Codes mentioned in the text, in order of appearance, each looked up in the table. */
export function findErrorCodes(text: string, entries: readonly ErrorCodeEntry[]): readonly ErrorCodeMatch[] {
  const spoken = spokenDigitsToAscii(text.normalize('NFKC').replace(/[\s\-ー－、,.。・]/g, ''));
  const normalized = spoken.toUpperCase();
  const codes = [...new Set(normalized.match(CODE_PATTERN) ?? [])];
  return codes.map((code) => ({ code, entry: entries.find((entry) => entry.code === code) }));
}

/** Prompt block describing the codes the caller mentioned; undefined when there are none. */
export function describeErrorCodes(matches: readonly ErrorCodeMatch[]): string | undefined {
  if (matches.length === 0) return undefined;
  const lines = matches.map(({ code, entry }) =>
    entry
      ? `- コード ${code}: ${entry.meaning}。対処: ${entry.action} ${entry.needsVisit}`
      : `- コード ${code}: 登録なし。意味を推測せず、訪問時に確認すると伝える。`,
  );
  return `# エラーコード情報（お客様が口にしたコード）\n${lines.join('\n')}`;
}
