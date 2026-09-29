import { z } from 'zod';
import { CATEGORIES, EQUIPMENT, type Category, type Equipment } from '../config/serviceCatalog.js';

export const knowledgeEntrySchema = z.object({
  id: z.string().min(1),
  category: z.enum(CATEGORIES),
  /** Equipment this entry applies to; empty = general (hours, payment …). */
  equipment: z.array(z.enum(EQUIPMENT)).default([]),
  question: z.string().min(1),
  keywords: z.array(z.string()).default([]),
  answer: z.string().min(1),
});

export type KnowledgeEntry = Readonly<z.infer<typeof knowledgeEntrySchema>>;

export interface KnowledgeHit {
  readonly entry: KnowledgeEntry;
  readonly score: number;
}

const KEYWORD_BONUS = 0.5;
// Retrieval is scoped by what Jev already found out about the caller's trouble.
// Bonuses rather than filters: a general question mid-repair still finds "hours" or "payment".
const CATEGORY_BONUS = 0.3;
const EQUIPMENT_BONUS = 0.3;
const DEFAULT_MIN_SCORE = 0.2;
const DEFAULT_LIMIT = 3;

export function parseKnowledge(raw: unknown): readonly KnowledgeEntry[] {
  return z.array(knowledgeEntrySchema).parse(raw);
}

function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

/** Character bigrams: a tokenizer-free similarity signal that works for Japanese. */
function bigrams(text: string): ReadonlySet<string> {
  const chars = Array.from(normalize(text));
  return new Set(chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`));
}

function scoreEntry(queryGrams: ReadonlySet<string>, normalizedQuery: string, entry: KnowledgeEntry): number {
  if (queryGrams.size === 0) return 0;
  const entryGrams = bigrams(`${entry.question}${entry.keywords.join('')}`);
  const overlap = [...queryGrams].filter((gram) => entryGrams.has(gram)).length / queryGrams.size;
  const keywordHit = entry.keywords.some((keyword) => normalizedQuery.includes(normalize(keyword)));
  return overlap + (keywordHit ? KEYWORD_BONUS : 0);
}

export interface SearchOptions {
  readonly limit?: number;
  readonly minScore?: number;
  readonly category?: Category;
  readonly equipment?: Equipment;
}

/** Entries without equipment (hours, payment …) apply to every caller and are never out of context. */
const isGeneral = (entry: KnowledgeEntry) => entry.equipment.length === 0;

function contextBonus(entry: KnowledgeEntry, options: SearchOptions): number {
  const inCategory = entry.category === options.category || isGeneral(entry);
  const category = options.category !== undefined && inCategory ? CATEGORY_BONUS : 0;
  const equipment = options.equipment !== undefined && entry.equipment.includes(options.equipment) ? EQUIPMENT_BONUS : 0;
  return category + equipment;
}

/**
 * Dummy retrieval over the in-memory knowledge base. Swap this for a vector
 * store / real RAG without touching the callers.
 */
export function searchKnowledge(
  entries: readonly KnowledgeEntry[],
  query: string,
  options: SearchOptions = {},
): readonly KnowledgeHit[] {
  const { limit = DEFAULT_LIMIT, minScore = DEFAULT_MIN_SCORE } = options;
  const queryGrams = bigrams(query);
  const normalizedQuery = normalize(query);
  return entries
    .map((entry) => {
      const textScore = scoreEntry(queryGrams, normalizedQuery, entry);
      // Context alone never surfaces an entry: the text has to match at least a little.
      return { entry, score: textScore > 0 ? textScore + contextBonus(entry, options) : 0 };
    })
    .filter((hit) => hit.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
