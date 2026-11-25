// SEARCH-BENCH query planning + the native «agent-like» pipeline every Track N / X / E strategy shares.
// The pipeline is deterministic (no model): split the query into terms (Korean particles stripped), optionally expand
// ko↔en with the glossary, run a NAME pass (filenames) and a CONTENT pass per term group through a pluggable tool
// adapter, rank by term coverage (name hits weigh more), optionally Read the top K and re-rank by what is inside.
// Strategies differ only by adapter (which tool, which flags, which caps) and by these options — so a row in the
// scorecard isolates exactly one choice.
import type { SearchKit } from './kit.js';
import { termGlossaryPairs } from '../../skills/tools/search-terms.js';

const STOP = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'is', 'are', 'where', 'what', 'how', 'does', 'do', 'its', 'it', 'with', 'and', 'or',
  'implemented', 'implementation', 'defined', 'from', 'that', 'this', 'by', 'find', 'which', 'who', 'callers', 'call', 'sites',
  '문서', '코드', '곳', '것', '만든', '구현한', '호출하는', '흡수한', '을', '를', '이', '가', '은', '는', '의', '에', '읽기', '어디', '하는',
]);
const PARTICLES = ['으로', '에서', '에게', '까지', '부터', '을', '를', '이', '가', '은', '는', '의', '에', '로', '과', '와', '도'];

export function stripParticle(word: string): string {
  if (!/[가-힣]$/.test(word) || word.length < 2) return word;
  for (const p of PARTICLES) if (word.endsWith(p) && word.length - p.length >= 1) return word.slice(0, -p.length);
  return word;
}

/** Query → ordered unique terms. Identifiers (camelCase, snake, kebab, dotted keys) stay whole. */
export function queryTerms(query: string): string[] {
  const raw = query.split(/[\s,;:!?()«»"'`]+/u).map((w) => w.replace(/^[./]+|[./]+$/g, '')).filter(Boolean);
  const out: string[] = [];
  for (const w0 of raw) {
    const w = stripParticle(w0);
    if ((w.length < 2 && !/[가-힣]/.test(w)) || STOP.has(w.toLowerCase())) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

export const isIdentifier = (t: string): boolean => /^[A-Za-z_$][\w$]*$/.test(t) && (/[a-z][A-Z]/.test(t) || /_/.test(t) || /^[A-Z][A-Z0-9_]+$/.test(t));
export const isFilenameish = (t: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{2,}$/.test(t);
export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The product term glossary (src/knowledge/term-glossary.json) — the same pairs product Grep / DocsSearch expand with. */
export function glossary(): ReadonlyArray<readonly [string, string]> {
  return termGlossaryPairs();
}

/** Each term → its group [term, ...variants] (ko→en and en→ko from the glossary when expand). */
export function termGroups(query: string, expand: boolean): string[][] {
  const terms = queryTerms(query);
  return terms.map((t) => {
    const g = [t];
    // A dotted config key (knowledge.docsRoots) is written nested in code: also look for its last segment.
    if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(t)) g.push(t.split('.').pop()!);
    if (expand) {
      const low = t.toLowerCase();
      for (const [ko, en] of glossary()) {
        if (ko === t && !g.includes(en)) g.push(en);
        if (en === low && !g.includes(ko)) g.push(ko);
      }
    }
    return g;
  });
}

/** What a tool family must provide to the pipeline. Paths returned are corpus-relative, in the order the model sees. */
export interface ToolAdapter {
  /** Files whose PATH matches the fragment (null = this tool family has no name search). */
  readonly name: ((kit: SearchKit, fragment: string) => Promise<string[]>) | null;
  /** Files whose CONTENT matches any of the alternatives. */
  readonly content: (kit: SearchKit, alternatives: readonly string[]) => Promise<string[]>;
  /** Optional structural definition search (ast-grep / def regex) for identifier terms. */
  readonly definition?: (kit: SearchKit, identifier: string) => Promise<string[]>;
  /** Optional structural call-site search for identifier terms (used when the query asks for callers). */
  readonly callers?: (kit: SearchKit, identifier: string) => Promise<string[]>;
}

export interface PipelineOptions {
  readonly expand: boolean;
  /** Read the top K candidates and re-rank by their contents (0 = no Read). */
  readonly readTopK: number;
  /** Name pass weight vs content pass (2 = filename-first, 0 = no name pass). */
  readonly nameWeight: number;
  /** Weight of structural hits for identifier terms: definitions, or call sites when the query asks for callers. */
  readonly definitionBoost: number;
  /** Also try the whole query joined by '-' as a filename fragment ("graph approval card" → graph-approval-card). */
  readonly joinedName: boolean;
}
export const CALLER_INTENT = /호출|caller|call site|called by|usages?/i;
export const DEFAULT_PIPELINE: PipelineOptions = { expand: false, readTopK: 0, nameWeight: 2, definitionBoost: 0, joinedName: false };

export async function runPipeline(query: string, kit: SearchKit, tool: ToolAdapter, opts: PipelineOptions): Promise<string[]> {
  const groups = termGroups(query, opts.expand);
  const score = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;
  const bump = (p: string, s: number) => { score.set(p, (score.get(p) ?? 0) + s); if (!firstSeen.has(p)) firstSeen.set(p, order++); };
  if (tool.name && opts.nameWeight > 0) {
    const fragments: string[][] = groups.map((g) => g.filter(isFilenameish));
    if (opts.joinedName && groups.length > 1) {
      const joined = groups.map((g) => g.find(isFilenameish)).filter(Boolean).join('-');
      if (joined.includes('-')) fragments.push([joined]);
    }
    for (const frags of fragments) {
      const hit = new Set<string>();
      for (const f of frags) for (const p of await tool.name(kit, f)) hit.add(p);
      for (const p of hit) bump(p, opts.nameWeight);
    }
  }
  for (const g of groups) {
    const hits = await tool.content(kit, g);
    hits.forEach((p, i) => bump(p, 1 + 0.001 * Math.max(0, 50 - i)));
  }
  if (opts.definitionBoost > 0) {
    const structural = CALLER_INTENT.test(query) ? tool.callers : tool.definition;
    if (structural) for (const g of groups) for (const t of g) if (isIdentifier(t)) for (const p of await structural(kit, t)) bump(p, opts.definitionBoost);
  }
  let ranked = [...score.entries()].sort((a, b) => b[1] - a[1] || firstSeen.get(a[0])! - firstSeen.get(b[0])!).map(([p]) => p);
  if (opts.readTopK > 0 && ranked.length > 0) ranked = await rerankByRead(kit, ranked, groups, opts.readTopK, CALLER_INTENT.test(query));
  return ranked;
}

/** Read the top K and re-rank: per group (any variant) occurrence → coverage, log tf, H1/title and path hits. */
export async function rerankByRead(kit: SearchKit, ranked: readonly string[], groups: readonly string[][], k: number, callerIntent = false): Promise<string[]> {
  const top = ranked.slice(0, k);
  const scored: Array<{ p: string; s: number; i: number }> = [];
  for (let i = 0; i < top.length; i += 1) {
    const p = top[i]!;
    const text = (await kit.read(p)).toLowerCase();
    const title = (/^\s*\d+\s+#\s+(.+)$/m.exec(text)?.[1] ?? '').toLowerCase();
    const path = p.toLowerCase();
    let s = 0;
    for (const g of groups) {
      let tf = 0, inTitle = false, inPath = false;
      for (const v of g) {
        const lv = v.toLowerCase();
        tf += text.split(lv).length - 1;
        if (title.includes(lv)) inTitle = true;
        if (path.includes(lv)) inPath = true;
      }
      if (tf > 0) s += 1 + Math.log1p(tf) * 0.25;
      if (inTitle) s += 1;
      if (inPath) s += 2;
    }
    for (const g of groups) for (const v of g) {
      if (!isIdentifier(v)) continue;
      const id = escapeRegex(v.toLowerCase());
      const defined = new RegExp(`(function|class|interface|type|const|let|def|fn|func|struct)\\s+${id}\\b`).test(text);
      const calls = (text.match(new RegExp(`\\b${id}\\s*\\(`, 'g')) ?? []).length - (defined ? 1 : 0);
      s += callerIntent ? (calls > 0 ? 2 : 0) - (defined ? 1 : 0) : defined ? 2 : 0;
    }
    scored.push({ p, s, i });
  }
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return [...scored.map((x) => x.p), ...ranked.slice(k)];
}

/** Reciprocal-rank fusion of ranked lists with weights. */
export function rrf(lists: ReadonlyArray<{ paths: readonly string[]; weight: number }>, k = 60): string[] {
  const s = new Map<string, number>();
  const first = new Map<string, number>();
  let n = 0;
  for (const { paths, weight } of lists) paths.forEach((p, i) => { s.set(p, (s.get(p) ?? 0) + weight / (k + i + 1)); if (!first.has(p)) first.set(p, n++); });
  return [...s.entries()].sort((a, b) => b[1] - a[1] || first.get(a[0])! - first.get(b[0])!).map(([p]) => p);
}

/** Paths of `rg`/`grep`-like `path:line:text` or `path` lines, in order, deduped. */
export function pathsFromLines(kit: SearchKit, text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = /^(.+?):\d+[:-]/.exec(line);
    const p = kit.rel(m ? m[1]! : line);
    if (!p || p.startsWith('…') || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}
