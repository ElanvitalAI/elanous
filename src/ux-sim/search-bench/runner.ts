// SEARCH-BENCH runner — strategies × gold over one corpus → scorecard; run history (dated scorecards with corpus sha
// and strategy versions) for continuous experiments; one-screen table; run-vs-run comparison.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { SearchKit, type CorpusContext } from './kit.js';
import { scoreQuery, summarize } from './metrics.js';
import type { GoldSet, QueryResult, Scorecard, SearchStrategy, StrategySummary } from './types.js';

export interface RunBenchOptions {
  readonly ctx: CorpusContext;
  readonly gold: GoldSet;
  readonly goldSha256: string;
  readonly corpusSha: string;
  readonly corpusFiles: number;
  readonly strategies: readonly SearchStrategy[];
  readonly runId?: string;
  readonly label?: string;
  readonly host?: string;
  readonly now?: () => Date;
  readonly onStrategy?: (summary: StrategySummary) => void;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export async function runBench(o: RunBenchOptions): Promise<Scorecard> {
  const now = o.now ?? (() => new Date());
  const started = now();
  const results: QueryResult[] = [];
  const strategies: StrategySummary[] = [];
  for (const s of o.strategies) {
    const rows: QueryResult[] = [];
    for (const item of o.gold.items) {
      const kit = new SearchKit(o.ctx);
      const t = performance.now();
      let ranked: readonly string[] = [];
      let error: string | undefined;
      try { ranked = await s.run(item.query, kit); } catch (e) { error = e instanceof Error ? e.message : String(e); }
      rows.push(scoreQuery(s.id, item, ranked, kit.trace, Math.round(performance.now() - t), error));
    }
    results.push(...rows);
    const summary = summarize(s, rows, o.gold.items);
    strategies.push(summary);
    o.onStrategy?.(summary);
  }
  const stamp = started.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return {
    schema: 'search-bench.scorecard/1',
    runId: o.runId ?? `${stamp}-${o.gold.corpus}-${o.corpusSha.slice(0, 7)}${o.label ? `-${o.label.replace(/[^A-Za-z0-9_-]+/g, '_')}` : ''}`,
    createdAt: started.toISOString(), host: o.host ?? hostname().split('.')[0]!, corpus: o.gold.corpus, corpusSha: o.corpusSha,
    corpusFiles: o.corpusFiles, goldVersion: o.gold.version, goldSha256: o.goldSha256, ...(o.label ? { label: o.label } : {}),
    meta: { ...(o.meta ?? {}), indexBuild: { ...o.ctx.buildNotes } },
    strategies, results,
  };
}

/** Everything except wall-clock fields — two runs over the same corpus/gold/strategies must be equal on this. */
export function deterministicView(sc: Scorecard): unknown {
  return {
    corpus: sc.corpus, corpusSha: sc.corpusSha, goldSha256: sc.goldSha256,
    strategies: sc.strategies.map((s) => ({ id: s.id, version: s.version, all: { ...s.all, ms: 0 },
      byDomain: Object.fromEntries(Object.entries(s.byDomain).map(([k, v]) => [k, { ...v, ms: 0 }])) })),
    results: sc.results.map((r) => ({ ...r, ms: 0, trace: r.trace.map((t) => ({ ...t, ms: 0 })) })),
  };
}

// ── history ───────────────────────────────────────────────────────────────────────────────────────────────────
export const runsDir = (stateRoot: string) => join(stateRoot, 'search-bench', 'runs');
export function saveScorecard(stateRoot: string, sc: Scorecard): string {
  const dir = runsDir(stateRoot);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sc.runId}.json`);
  writeFileSync(path, `${JSON.stringify(sc, null, 1)}\n`);
  return path;
}
export function loadScorecard(stateRoot: string, runIdOrPath: string): Scorecard {
  const path = existsSync(runIdOrPath) ? runIdOrPath : join(runsDir(stateRoot), `${runIdOrPath}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as Scorecard;
}
export function historyTable(stateRoot: string): string[] {
  const dir = runsDir(stateRoot);
  if (!existsSync(dir)) return ['(no runs)'];
  const rows = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Scorecard);
  return ['runId | host | corpus | sha | strategies | best r@5 (id)', ...rows.map((sc) => {
    const best = [...sc.strategies].sort((a, b) => b.all.recall5 - a.all.recall5)[0];
    return `${sc.runId} | ${sc.host} | ${sc.corpus} | ${sc.corpusSha.slice(0, 10)} | ${sc.strategies.length} | ${best ? `${best.all.recall5.toFixed(2)} (${best.id})` : '-'}`;
  })];
}

// ── rendering ─────────────────────────────────────────────────────────────────────────────────────────────────
const f2 = (x: number | undefined) => (x === undefined ? '  -  ' : x.toFixed(2));
export function scorecardTable(sc: Scorecard): string[] {
  const head = `${sc.corpus} @ ${sc.corpusSha.slice(0, 10)} · ${sc.corpusFiles} files · gold v${sc.goldVersion} (${sc.results.length / Math.max(1, sc.strategies.length)} q) · ${sc.host} · ${sc.runId}`;
  const cols = 'track | strategy | code r@5 | docs r@5 | r@1 | r@5 | MRR | calls | KB | ms | decoy@5';
  const lines = sc.strategies.map((s) => [s.track, s.id, f2(s.byDomain.code?.recall5), f2(s.byDomain.docs?.recall5), f2(s.all.recall1), f2(s.all.recall5),
    f2(s.all.mrr), s.all.calls.toFixed(1), (s.all.bytes / 1024).toFixed(1), String(s.all.ms), s.all.decoy5.toFixed(2)].join(' | '));
  return [head, cols, ...lines];
}

/** Markdown table (PR body / timeline doc). */
export function scorecardMarkdown(sc: Scorecard): string[] {
  const t = scorecardTable(sc);
  return [`_${t[0]}_`, '', `| ${t[1]} |`, `|${t[1]!.split('|').map(() => '---').join('|')}|`, ...t.slice(2).map((l) => `| ${l} |`)];
}

export function categoryTable(sc: Scorecard, ids?: readonly string[]): string[] {
  const cats = [...new Set(sc.strategies.flatMap((s) => Object.keys(s.byCategory)))].sort();
  const pick = ids ? sc.strategies.filter((s) => ids.includes(s.id)) : sc.strategies;
  return [`strategy | ${cats.join(' | ')}  (recall@5)`, ...pick.map((s) => `${s.id} | ${cats.map((c) => f2(s.byCategory[c]?.recall5)).join(' | ')}`)];
}

export function compareRuns(a: Scorecard, b: Scorecard): string[] {
  const out = [`A ${a.runId} (${a.corpusSha.slice(0, 10)}) → B ${b.runId} (${b.corpusSha.slice(0, 10)})`, 'strategy | vA→vB | r@5 A → B (Δ) | MRR A → B | KB A → B'];
  for (const sb of b.strategies) {
    const sa = a.strategies.find((s) => s.id === sb.id);
    if (!sa) { out.push(`${sb.id} | new v${sb.version} | ${f2(sb.all.recall5)} | ${f2(sb.all.mrr)} | ${(sb.all.bytes / 1024).toFixed(1)}`); continue; }
    const d = sb.all.recall5 - sa.all.recall5;
    out.push(`${sb.id} | v${sa.version}→v${sb.version} | ${f2(sa.all.recall5)} → ${f2(sb.all.recall5)} (${d >= 0 ? '+' : ''}${d.toFixed(2)}) | ${f2(sa.all.mrr)} → ${f2(sb.all.mrr)} | ${(sa.all.bytes / 1024).toFixed(1)} → ${(sb.all.bytes / 1024).toFixed(1)}`);
  }
  for (const sa of a.strategies) if (!b.strategies.some((s) => s.id === sa.id)) out.push(`${sa.id} | removed`);
  return out;
}
