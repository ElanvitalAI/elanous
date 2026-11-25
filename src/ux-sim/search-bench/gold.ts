// SEARCH-BENCH gold loader — versioned JSON beside this file (gold-elanous.json · gold-ref.json). Strict validation so
// a typo never silently becomes a «0 recall» row.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GOLD_CATEGORIES, type GoldItem, type GoldSet } from './types.js';

export const GOLD_DIR = import.meta.dir;
export const goldPath = (corpus: 'elanous' | 'ref'): string => join(GOLD_DIR, `gold-${corpus}.json`);

export function parseGold(raw: unknown): GoldSet {
  const v = raw as Partial<GoldSet> | null;
  if (!v || v.schema !== 'search-bench.gold/1') throw new Error('gold: schema must be search-bench.gold/1');
  if (v.corpus !== 'elanous' && v.corpus !== 'ref') throw new Error('gold: corpus must be elanous or ref');
  if (typeof v.version !== 'number' || typeof v.pinnedSha !== 'string' || !Array.isArray(v.items)) throw new Error('gold: version, pinnedSha and items are required');
  const seen = new Set<string>();
  const items: GoldItem[] = v.items.map((row, index) => {
    const it = row as Partial<GoldItem>;
    const where = `gold.items[${index}]`;
    if (typeof it.id !== 'string' || !it.id) throw new Error(`${where}: id is required`);
    if (seen.has(it.id)) throw new Error(`${where}: duplicate id ${it.id}`);
    seen.add(it.id);
    if (it.domain !== 'code' && it.domain !== 'docs') throw new Error(`${where}: domain must be code or docs`);
    if (!(GOLD_CATEGORIES as readonly string[]).includes(String(it.category))) throw new Error(`${where}: unknown category ${String(it.category)}`);
    if (typeof it.query !== 'string' || !it.query.trim()) throw new Error(`${where}: query is required`);
    if (!Array.isArray(it.expected) || it.expected.length === 0 || it.expected.some((p) => typeof p !== 'string' || p.startsWith('/') || p.includes('..')))
      throw new Error(`${where}: expected must be non-empty relative paths`);
    return { id: it.id, domain: it.domain, category: it.category as GoldItem['category'], query: it.query, expected: [...it.expected], ...(it.note ? { note: it.note } : {}) };
  });
  return { schema: 'search-bench.gold/1', corpus: v.corpus, version: v.version, pinnedSha: v.pinnedSha, ...(v.repos ? { repos: [...v.repos] } : {}), items };
}

export function loadGold(path: string): { gold: GoldSet; sha256: string } {
  const text = readFileSync(path, 'utf8');
  return { gold: parseGold(JSON.parse(text)), sha256: createHash('sha256').update(text).digest('hex') };
}

/** Expected paths absent from the corpus (a stale gold set is a bench defect, not a strategy miss). */
export function missingGoldPaths(gold: GoldSet, corpusRoot: string): string[] {
  return gold.items.flatMap((it) => it.expected.filter((p) => !existsSync(join(corpusRoot, p))).map((p) => `${it.id}:${p}`));
}
