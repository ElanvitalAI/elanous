// Search term expansion — ko↔en variants from the term glossary (src/knowledge/term-glossary.json), shared by the
// product Grep (files_with_matches) and DocsSearch. Same file the search-bench expand=true strategies read, so the
// bench measures exactly what ships.
//
// Why (search-bench #40045, N4 ablation): dropping ko↔en expansion cost recall@5 −0.09 — a seat asks «판정국 부하»
// while the code says `judge` / `load`, and the reverse.
// Three faces: observe = the «[expanded: …]» line in the tool result · judge = only plain-word alternatives expand
// (a regex alternative is never rewritten) · repair = none needed; an unknown word passes through unchanged.
import glossaryJson from '../../knowledge/term-glossary.json' with { type: 'json' };

type Pair = readonly [string, string];
const PAIRS: readonly Pair[] = (glossaryJson as unknown as { pairs: Array<[string, string]> }).pairs;

/** ko→en and en→ko pairs (ko first). */
export function termGlossaryPairs(): readonly Pair[] {
  return PAIRS;
}

const PARTICLES = ['으로', '에서', '에게', '까지', '부터', '을', '를', '이', '가', '은', '는', '의', '에', '로', '과', '와', '도'];

/** «착지를» → «착지». Non-Hangul words and one-syllable words pass through. */
export function stripKoParticle(word: string): string {
  if (!/[가-힣]$/.test(word) || word.length < 2) return word;
  for (const p of PARTICLES) if (word.endsWith(p) && word.length - p.length >= 1) return word.slice(0, -p.length);
  return word;
}

/** Glossary variants of one word (itself excluded). A variant shorter than 2 characters is dropped — one Hangul
 *  syllable («줄», «창») matches far too much text to be a useful expansion of an English word. */
export function termVariants(word: string): string[] {
  const low = word.toLowerCase();
  const base = stripKoParticle(word);
  const out: string[] = [];
  for (const [ko, en] of PAIRS) {
    if ((ko === word || ko === base) && !out.includes(en)) out.push(en);
    if (en === low && !out.includes(ko)) out.push(ko);
  }
  return out.filter((v) => v.length >= 2 && v.toLowerCase() !== low);
}

/** Top-level `|` alternatives of a regex (escapes, character classes and groups respected). */
export function topLevelAlternatives(pattern: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inClass = false;
  let cur = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!;
    if (c === '\\') { cur += c + (pattern[i + 1] ?? ''); i += 1; continue; }
    if (inClass) { if (c === ']') inClass = false; cur += c; continue; }
    if (c === '[') inClass = true;
    else if (c === '(') depth += 1;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === '|' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

const PLAIN_WORD = /^[\p{L}\p{N}_]+$/u;

/** Grep pattern → the same pattern with glossary variants of its plain-word alternatives appended as more
 *  alternatives. A pattern with no plain-word alternative (any regex syntax) comes back unchanged. */
export function expandGrepPattern(pattern: string): { pattern: string; added: string[]; from: string[] } {
  const alts = topLevelAlternatives(pattern);
  const have = new Set(alts.map((a) => a.toLowerCase()));
  const added: string[] = [];
  const from: string[] = [];
  for (const a of alts) {
    if (!PLAIN_WORD.test(a)) continue;
    const vs = termVariants(a).filter((v) => !have.has(v.toLowerCase()) && !added.includes(v));
    if (vs.length) { from.push(a); added.push(...vs); }
  }
  return { pattern: added.length ? [pattern, ...added].join('|') : pattern, added, from };
}

/** DocsSearch query → the query with glossary variants of its words appended («판정국 부하» → «판정국 부하 judge load»). */
export function expandQueryWords(query: string): { query: string; added: string[] } {
  const words = query.split(/[\s,·/|]+/).map((w) => w.trim()).filter(Boolean);
  const have = new Set(words.map((w) => w.toLowerCase()));
  const added: string[] = [];
  for (const w of words) {
    for (const v of termVariants(w)) if (!have.has(v.toLowerCase()) && !added.includes(v)) added.push(v);
  }
  return { query: added.length ? `${query} ${added.join(' ')}` : query, added };
}
