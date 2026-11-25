// DEMO-1126-INVEST-ORCH — «엘라누스 지휘 × 코나투스 투자 엔진 × codex/claude/eln 패널» one graph run.
// The graph (graphs/demo/invest-orch/invest-orch.yaml) names every node `handler:<name>`; this module is that registry.
// Two modes, one code path:
//   live      — skills (omni-crawl · omni-market · kr-flow · asset-attractiveness), Conatus (investment pack →
//               research-bridge), and the panel CLIs (eln llm · codex exec · claude -p), optionally in els panes.
//   fixtures  — the recorded results under graphs/demo/invest-orch/fixtures (no network, no model): rehearsal and the
//               live-failure fallback. A live data node that fails falls back to its fixture and says so (source field).
// Safety: research only. Nothing here places, stages or simulates an order; the Conatus judge node reads the trade
// mandate and records «집행: 비활성» — it never calls an executor.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { curateStageHeadlines, tickerHeadlines } from './headline-curate.js';
import { panelName } from '../../src/tui/widgets/scenes/invest-run.js';
import type { InProcessHandler, InProcessHandlerContext, InProcessHandlerRegistry, InProcessHandlerResult } from '../../src/graph-runner/in-process-registry.js';

export const DISCLAIMER = '리서치 시연 · 투자 권유 아님';
export const DEFAULT_QUESTION = '2027 한국 증시 전망';
export const DASHBOARD_SCHEMA = 'invest-orch.dashboard/1';
export const GRAPH_DIR = resolve(import.meta.dir, '../../graphs/demo/invest-orch');
export const FIXTURE_DIR = join(GRAPH_DIR, 'fixtures');
const REPO_ROOT = resolve(import.meta.dir, '../..');
const SKILLS = process.env.INVEST_DEMO_SKILLS_DIR ?? join(homedir(), '.claude/skills');
export const MENTOR_PACK_PATH = join(homedir(), 'elanous-hq/seat-state/OP/demo-aib/mentor-seed-pack-1121.md');
/** The mentor pack was formed on this date; the event-shock node collects what happened after it. */
export const MENTOR_PACK_DATE = '2026-11-21';

export type Runtime = 'eln' | 'codex' | 'claude';
export interface DemoInput {
  readonly question?: string;
  readonly ticker?: string;
  /** Recorded fixtures only (no network, no model). */
  readonly fixtures?: boolean;
  /** Open one els pane per panel CLI (live) or per simulated pane (fixtures). */
  readonly els?: boolean;
  readonly elsWorkspace?: string;
  /** Escalate the human decision cards through `eln decisions raise` (live only). */
  readonly raiseDecisions?: boolean;
  readonly outDir?: string;
  readonly mentorPack?: string;
  /** Fixture mode: how long each simulated panel answer takes (ms). */
  readonly simDelayMs?: number;
  /** Live panel CLI timeout (ms). */
  readonly panelTimeoutMs?: number;
  /** DEMO-INVEST-ELS-TARGET: the els socket the panel tabs open in (run.ts resolves it — `investElsTarget`). */
  readonly elsSocket?: string;
}

/**
 * DEMO-INVEST-ELS-TARGET (demo-check 11-25: a test-universe rehearsal opened 30 panel tabs in the OPS els): the els this
 * run shows its tabs in. An explicit socket (`--els-socket`) wins; otherwise the els of the universe the run is in
 * (ELANOUS_STATE_DIR — run.ts pins it before this is asked). An inherited ELANOUS_ELS_SOCKET never decides: a rehearsal
 * started from inside an operational pane must not reach the operational els.
 */
export function investElsTarget(env: Readonly<Record<string, string | undefined>>, explicitSocket?: string): { readonly socket: string; readonly stateRoot: string } {
  if (explicitSocket?.trim()) {
    const socket = resolve(explicitSocket.trim());
    return { socket, stateRoot: dirname(dirname(socket)) };
  }
  const root = env.ELANOUS_STATE_DIR?.trim();
  if (!root) throw new Error('invest-orch: no universe for the els target — set ELANOUS_STATE_DIR or pass --els-socket');
  const stateRoot = resolve(root);
  return { socket: join(stateRoot, 'els', 'els.sock'), stateRoot };
}

/** The env of an `els new` aimed at `target`: its state root, and no els credential or socket inherited from another els. */
export function investElsEnv(env: NodeJS.ProcessEnv, target: { readonly socket: string; readonly stateRoot: string }): NodeJS.ProcessEnv {
  const same = env.ELANOUS_ELS_SOCKET === target.socket;
  const out: NodeJS.ProcessEnv = { ...env, ELANOUS_STATE_DIR: target.stateRoot };
  if (!same) for (const key of ['ELANOUS_ELS_SOCKET', 'ELANOUS_ELS_PANE_TOKEN', 'ELANOUS_ELS_OWNER_TOKEN', 'ELANOUS_ELS_PANE', 'ELANOUS_ELS_WS']) delete out[key];
  return out;
}
interface PanelNodeInput { readonly role: 'panel' | 'mentor'; readonly persona?: string; readonly slot?: number; readonly runtime: Runtime; readonly model?: string; readonly provider?: string }

const ok = (result: unknown): InProcessHandlerResult => ({ ok: true, outcome: 'ok', result });
const inputOf = (ctx: InProcessHandlerContext): DemoInput => {
  const raw = (ctx.graphInput ?? ctx.input) as unknown;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as DemoInput : {};
};
const resultOf = <T>(ctx: InProcessHandlerContext, nodeId: string): T | undefined => {
  const out = ctx.outputs[nodeId] as { result?: T } | undefined;
  return out && typeof out === 'object' ? out.result : undefined;
};
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8')) as T;
/** Fixture mode: the model a runtime's default resolved to in the recorded live run (never the word «default»). */
export const recordedDefaultModel = (runtime: Runtime): string => fixture<Partial<Record<Runtime, string>>>('panel-models')[runtime] ?? (runtime === 'claude' ? 'haiku' : 'default');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const progress = (ctx: InProcessHandlerContext, phase: 'verify' | 'generate' | 'materialize' | 'publish', note: string) =>
  ctx.reportProgress?.({ phase, note }).catch(() => undefined);

// ── process helpers ────────────────────────────────────────────────────────────────────────────────────────────────
interface Run { code: number; stdout: string; stderr: string; ms: number }
function run(cmd: string, args: readonly string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; stdin?: string } = {}): Promise<Run> {
  const started = Date.now();
  return new Promise((done) => {
    const child = execFile(cmd, [...args], { cwd: opts.cwd, env: opts.env ?? process.env, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => done({ code: error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0,
        stdout: String(stdout), stderr: String(stderr), ms: Date.now() - started }));
    if (opts.stdin !== undefined) { child.stdin?.end(opts.stdin); }
  });
}
const node24Path = (): string => existsSync('/opt/homebrew/opt/node@24/bin') ? `/opt/homebrew/opt/node@24/bin:${process.env.PATH}` : process.env.PATH ?? '';
const between = (text: string, begin: string): unknown => {
  const at = text.indexOf(begin);
  if (at < 0) return undefined;
  const body = text.slice(at + begin.length);
  const end = body.indexOf('---END');
  try { return JSON.parse((end < 0 ? body : body.slice(0, end)).trim()); } catch { return undefined; }
};

/** Last JSON object in a model answer (fenced or bare). */
export function lastJsonObject(text: string): Record<string, unknown> | undefined {
  // Fenced blocks (last fence first), then a brace scan from the end — the outermost object of each tail comes first.
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gu)].map((m) => m[1]!).reverse();
  const scanned: string[] = [];
  for (let end = text.lastIndexOf('}'); end >= 0 && scanned.length < 6; end = text.lastIndexOf('}', end - 1)) {
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      if (text[i] === '}') depth++;
      else if (text[i] === '{' && --depth === 0) { scanned.push(text.slice(i, end + 1)); break; }
    }
  }
  const parsed = [...fenced, ...scanned].flatMap((raw) => {
    try { const v = JSON.parse(raw.trim()); return v && typeof v === 'object' && !Array.isArray(v) ? [v as Record<string, unknown>] : []; } catch { return []; }
  });
  return parsed.find((v) => 'action' in v) ?? parsed[0];
}

// ── data nodes ─────────────────────────────────────────────────────────────────────────────────────────────────────
interface SeriesStat { symbol: string; date: string; last: number; chg1m: number | null; chg3m: number | null; high1y: number; low1y: number }
export interface MarketResult { asOf: string; source: string; series: Record<string, SeriesStat> }
const MARKET_SYMBOLS: Record<string, string> = {
  KOSPI: 'KS11.INDX', US10Y: 'US10Y.GBOND', DXY: 'DXY.INDX', USDKRW: 'USDKRW.FOREX', WTI: 'CL=F',
  SAMSUNG: '005930.KO', SKHYNIX: '000660.KO', SOXX: 'SOXX.US', NVDA: 'NVDA.US',
};
function stat(symbol: string, raw: Array<{ date: string; close: number; adjusted_close?: number }>): SeriesStat | undefined {
  // adjusted_close when present: a split (e.g. SOXX) otherwise reads as a −70% month.
  const rows = raw.map((r) => ({ date: r.date, close: typeof r.adjusted_close === 'number' && Number.isFinite(r.adjusted_close) ? r.adjusted_close : r.close }));
  const valid = rows.filter((r) => typeof r.close === 'number' && Number.isFinite(r.close));
  if (!valid.length) return undefined;
  const last = valid.at(-1)!;
  const back = (days: number) => {
    const cut = new Date(Date.parse(last.date) - days * 86_400_000).toISOString().slice(0, 10);
    const row = [...valid].reverse().find((r) => r.date <= cut);
    return row ? Math.round((last.close / row.close - 1) * 10_000) / 100 : null;
  };
  const closes = valid.map((r) => r.close);
  return { symbol, date: last.date, last: last.close, chg1m: back(30), chg3m: back(91), high1y: Math.max(...closes), low1y: Math.min(...closes) };
}
async function liveMarket(): Promise<MarketResult> {
  const cwd = join(SKILLS, 'omni-market');
  const entries = await Promise.all(Object.entries(MARKET_SYMBOLS).map(async ([key, symbol]) => {
    const r = await run('bun', ['scripts/main.ts', 'eod', symbol, '--from', '-1y', '--json'], { cwd, timeoutMs: 45_000 });
    const m = /\[[\s\S]*\]/u.exec(r.stdout);
    try { const s = m ? stat(symbol, JSON.parse(m[0]) as Array<{ date: string; close: number; adjusted_close?: number }>) : undefined; return s ? [key, s] as const : undefined; }
    catch { return undefined; }
  }));
  const series = Object.fromEntries(entries.filter((e): e is readonly [string, SeriesStat] => !!e));
  if (!series.KOSPI || !series.US10Y) throw new Error(`omni-market returned ${Object.keys(series).length}/9 series (KOSPI/US10Y missing)`);
  return { asOf: series.KOSPI.date, source: 'live:omni-market', series };
}

export interface FlowsResult { source: string; kospi: { foreign5dMillion: number; foreign20dMillion: number; inst5dMillion: number; days: Array<{ date: string; foreign: number; inst: number; retail: number }> }; samsungForeign5dShares: number | null }
const num = (s: string) => Number(s.replace(/[,\s]/gu, ''));
async function liveFlows(): Promise<FlowsResult> {
  const cwd = join(SKILLS, 'kr-flow');
  const py = (args: string[]) => run('uv', ['run', '-q', '--with', 'requests', 'python', 'scripts/main.py', ...args], { cwd, timeoutMs: 60_000 });
  const [market, sam] = await Promise.all([py(['market-flow', 'KSP']), py(['foreign-net', '005930', '--json'])]);
  const days = [...market.stdout.matchAll(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([-\d,]+)\s*\|\s*([-\d,]+)\s*\|\s*([-\d,]+)\s*\|/gmu)]
    .map((m) => ({ date: m[1]!, foreign: num(m[2]!), inst: num(m[3]!), retail: num(m[4]!) }));
  if (days.length < 5) throw new Error(`kr-flow market-flow parsed ${days.length} rows`);
  const sum = (n: number, k: 'foreign' | 'inst') => days.slice(0, n).reduce((a, d) => a + d[k], 0);
  let samsungForeign5dShares: number | null = null;
  try {
    const rows = (JSON.parse(sam.stdout.slice(sam.stdout.indexOf('{'))) as { rows: Array<{ net_shares: number }> }).rows;
    samsungForeign5dShares = rows.slice(-5).reduce((a, r) => a + r.net_shares, 0);
  } catch { /* stays null — reported as unmeasured */ }
  return { source: 'live:kr-flow', kospi: { foreign5dMillion: sum(5, 'foreign'), foreign20dMillion: sum(20, 'foreign'), inst5dMillion: sum(5, 'inst'), days: days.slice(0, 5) }, samsungForeign5dShares };
}

interface CrawlItem { title: string; url: string; snippet: string; query?: string }
async function crawl(query: string, args: readonly string[], timeoutMs = 60_000): Promise<{ items: CrawlItem[]; summary: string | null }> {
  const r = await run('bun', ['scripts/main.ts', query, '--json', '--no-save', ...args], { cwd: join(SKILLS, 'omni-crawl'), timeoutMs });
  const parsed = between(r.stdout, '---BEGIN_OMNI_CRAWL_JSON---') as { results?: Array<{ summary?: string | null; items?: Array<{ url?: string; title?: string; text?: string; content?: string; snippet?: string }> }> } | undefined;
  if (!parsed?.results) throw new Error(`omni-crawl gave no JSON (exit ${r.code})`);
  const items = parsed.results.flatMap((g) => g.items ?? []).map((i) => ({ title: String(i.title ?? '').slice(0, 160), url: String(i.url ?? ''),
    snippet: String(i.snippet ?? i.text ?? i.content ?? '').replace(/\s+/gu, ' ').slice(0, 280), query }));
  return { items, summary: parsed.results.find((g) => g.summary)?.summary ?? null };
}

export interface ScoreResult { source: string; asOf: string; symbol: string; preset: string; total: number; z: number; signal: string; tiers: Record<string, { weight: number; score: number }>; lineage: Record<string, number> }
async function liveScore(symbol: string): Promise<ScoreResult> {
  const r = await run('npx', ['tsx', 'scripts/main.ts', 'score', symbol, '--preset', 'semis'], { cwd: join(SKILLS, 'asset-attractiveness'), timeoutMs: 90_000, env: { ...process.env, PATH: node24Path() } });
  const at = r.stdout.indexOf('{');
  if (at < 0) throw new Error(`asset-attractiveness score exit ${r.code}: ${r.stderr.trim().split('\n').at(-1) ?? ''}`);
  const j = JSON.parse(r.stdout.slice(at)) as { as_of: string; score: { total: number; z_score: number; signal: string }; tiers: Record<string, { weight: number; score: number }>; data_lineage: Record<string, unknown[]> };
  return { source: 'live:asset-attractiveness', asOf: j.as_of, symbol, preset: 'semis', total: j.score.total, z: j.score.z_score, signal: j.score.signal,
    tiers: Object.fromEntries(Object.entries(j.tiers).map(([k, v]) => [k, { weight: v.weight, score: v.score }])),
    lineage: Object.fromEntries(Object.entries(j.data_lineage).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])) };
}

/** Live with fixture fallback: a failed live source is a recorded substitution (and later a decision item). */
async function liveOr<T extends { source: string }>(ctx: InProcessHandlerContext, name: string, live: () => Promise<T>): Promise<InProcessHandlerResult> {
  const input = inputOf(ctx);
  if (input.fixtures) { await progress(ctx, 'materialize', `${name} · fixture`); return ok({ ...fixture<T>(name), source: 'fixture' }); }
  await progress(ctx, 'materialize', `${name} · live`);
  try { return ok(await live()); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await progress(ctx, 'materialize', `${name} · live failed → fixture`);
    return ok({ ...fixture<T>(name), source: 'fixture-fallback', fallbackReason: reason.slice(0, 300) });
  }
}

// ── Conatus ────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ConatusResearchResult { source: string; pack: 'investment'; needed: boolean; reason: string; ok: boolean; summary: string; durationMs: number; skill: string; fallbackReason?: string }
/** The Conatus research agent takes minutes (measured 11-24: > 150 s); a pre-warmed live result keeps the run ≤ 5 min. */
export const conatusCachePath = () => join(process.env.ELANOUS_STATE_DIR ?? join(homedir(), '.elanous'), 'invest-demo', 'conatus-research.cache.json');
const CONATUS_CACHE_MAX_AGE_MS = 12 * 3_600_000;
export async function prewarmConatusResearch(question: string): Promise<ConatusResearchResult> {
  const result = await liveConatusResearch(question, 30 * 60_000);
  mkdirSync(join(conatusCachePath(), '..'), { recursive: true });
  writeFileSync(conatusCachePath(), `${JSON.stringify({ question, at: new Date().toISOString(), result }, null, 2)}\n`);
  return result;
}
function cachedConatusResearch(question: string): ConatusResearchResult | undefined {
  try {
    const c = JSON.parse(readFileSync(conatusCachePath(), 'utf8')) as { question: string; at: string; result: ConatusResearchResult };
    if (c.question !== question || Date.now() - Date.parse(c.at) > CONATUS_CACHE_MAX_AGE_MS) return undefined;
    return { ...c.result, source: `live-cache:conatus@${c.at}` };
  } catch { return undefined; }
}
async function liveConatusResearch(question: string, timeoutMs: number): Promise<ConatusResearchResult> {
  const { INVESTMENT_PACK } = await import('../../src/autopilot/domain/investment-pack.js');
  const research = INVESTMENT_PACK.research!;
  const need = await research.assessNeed(question);
  const started = Date.now();
  const outcome = await Promise.race([research.invoke(`${question} — 코스피·삼성전자·SK하이닉스 중심, 최근 1주 시장 국면`),
    sleep(timeoutMs).then(() => undefined)]);
  if (!outcome) throw new Error(`Conatus research did not finish in ${Math.round(timeoutMs / 1000)}s`);
  if (!outcome.ok || !outcome.output.trim()) throw new Error('Conatus research returned no output');
  return { source: 'live:conatus', pack: 'investment', needed: need.needed, reason: need.reason, ok: true,
    summary: outcome.output.replace(/\s+\n/gu, '\n').slice(0, 1800), durationMs: Date.now() - started, skill: 'omni-crawl (research-bridge)' };
}
export interface ConatusOpsResult { source: string; loops: { count: number; armed: boolean; live: boolean; executionMode: string }; missions: number; anomalies: number; traces: Array<{ file: string; ageMin: number }> }
async function liveConatusOps(): Promise<ConatusOpsResult> {
  const r = await run('eln', ['ops', 'status', '--json'], { timeoutMs: 20_000 });
  const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) as { missions?: { total?: number }; loops?: { loops?: unknown[]; armed?: boolean; live?: boolean; executionMode?: string }; health?: { anomalyCount?: number } };
  const dir = join(homedir(), '.elanous/conatus');
  const traces = existsSync(dir) ? readdirSync(dir).map((file) => ({ file, mtime: statSync(join(dir, file)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime).slice(0, 5).map((t) => ({ file: t.file, ageMin: Math.round((Date.now() - t.mtime) / 60_000) })) : [];
  return { source: 'live:eln-ops', loops: { count: j.loops?.loops?.length ?? 0, armed: j.loops?.armed === true, live: j.loops?.live === true, executionMode: j.loops?.executionMode ?? 'unknown' },
    missions: j.missions?.total ?? 0, anomalies: j.health?.anomalyCount ?? 0, traces };
}

// ── mentors (private pack — loaded at run time, never committed) ─────────────────────────────────────────────────────
export interface Mentor { slot: number; name: string; gist: string; direction: string; frame: string }
export function parseMentorPack(text: string): Mentor[] {
  const sections = text.split(/^## /mu).slice(1).filter((s) => !s.startsWith('종합'));
  const summary = new Map<string, { gist: string; direction: string }>();
  for (const m of text.matchAll(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/gmu)) {
    if (m[1] === '멘토' || /^-+$/u.test(m[1]!)) continue;
    summary.set(m[1]!, { gist: m[2]!, direction: m[3]! });
  }
  return sections.map((body, index) => {
    const name = body.split('\n')[0]!.replace(/\s*\(.*$/u, '').trim();
    const pick = (label: string) => body.match(new RegExp(`^- ${label}: (.+)$`, 'mu'))?.[1]?.trim() ?? '';
    const s = summary.get(name);
    // The frame carries view · evidence · verification only; quotes stay out of every prompt and output.
    return { slot: index + 1, name, gist: s?.gist ?? pick('관점').slice(0, 60), direction: s?.direction ?? '', frame: [`관점: ${pick('관점')}`, `근거: ${pick('근거')}`, `검증: ${pick('검증')}`].join('\n') };
  }).filter((m) => m.name);
}

/** Verification hooks per mentor slot — each one a literal rule over the gathered data. ✓ supported · ✗ contradicted · ? unmeasured. */
export interface HookResult { id: string; claim: string; status: '✓' | '✗' | '?'; observed: string }
type Hook = { id: string; claim: string; check: (m: MarketResult | undefined, f: FlowsResult | undefined) => { status: HookResult['status']; observed: string } };
const s = (m: MarketResult | undefined, k: string) => m?.series[k];
const unmeasured = (why: string) => ({ status: '?' as const, observed: why });
const HOOKS: Record<number, Hook[]> = {
  1: [
    { id: 'foreign-not-returning', claim: '외국인 유입 낙관 안 함 (KOSPI 외국인 5일 순매도)', check: (_m, f) => !f ? unmeasured('수급 없음')
      : { status: f.kospi.foreign5dMillion < 0 ? '✓' : '✗', observed: `외국인 5일 ${(f.kospi.foreign5dMillion / 1_000_000).toFixed(2)}조원` } },
    { id: 'memory-vs-sox', claim: '메모리(삼성·SK하이닉스) 1개월 상대강도 > SOXX', check: (m) => {
      const a = s(m, 'SAMSUNG')?.chg1m, b = s(m, 'SKHYNIX')?.chg1m, x = s(m, 'SOXX')?.chg1m;
      if (a == null || b == null || x == null) return unmeasured('시세 없음');
      return { status: (a + b) / 2 > x ? '✓' : '✗', observed: `삼성 ${a}% · SK ${b}% vs SOXX ${x}% (1M)` };
    } },
    { id: 'fwd-per', claim: 'KOSPI 12M 선행 PER 회복', check: () => unmeasured('선행 PER 데이터 소스 없음(EODHD 지수 PER 미제공)') },
    { id: 'credit-peak', claim: '크레딧(CDS) 1분기 정점 뒤 완화', check: () => unmeasured('CDS 시계열 미연결') },
  ],
  2: [
    { id: 'us10y-below-5', claim: 'US10Y 5% 아래 유지', check: (m) => { const v = s(m, 'US10Y'); return !v ? unmeasured('US10Y 없음') : { status: v.last < 5 ? '✓' : '✗', observed: `US10Y ${v.last}% (${v.date})` }; } },
    { id: 'dxy-below-100', claim: '달러인덱스 100 아래 (외국인 유입 조건)', check: (m) => { const v = s(m, 'DXY'); return !v ? unmeasured('DXY 없음') : { status: v.last < 100 ? '✓' : '✗', observed: `DXY ${v.last}` }; } },
    { id: 'usdkrw-falling', claim: 'USDKRW 하락(원화 강세) 1개월', check: (m) => { const v = s(m, 'USDKRW'); return v?.chg1m == null ? unmeasured('USDKRW 없음') : { status: v.chg1m < 0 ? '✓' : '✗', observed: `USDKRW ${v.last} (1M ${v.chg1m}%)` }; } },
    { id: 'foreign-turn', claim: '외국인 순매수 전환', check: (_m, f) => !f ? unmeasured('수급 없음') : { status: f.kospi.foreign5dMillion > 0 ? '✓' : '✗', observed: `외국인 5일 ${(f.kospi.foreign5dMillion / 1_000_000).toFixed(2)}조원` } },
    { id: 'fomc-hold', claim: '2027 상반기 FOMC 동결', check: () => unmeasured('미래 이벤트') },
  ],
  3: [
    { id: 'kospi-floor', claim: 'KOSPI 1차 바닥 4,600~4,800 (4,300대 지지)', check: (m) => { const v = s(m, 'KOSPI'); if (!v) return unmeasured('KOSPI 없음');
      return v.last < 4300 ? { status: '✗', observed: `KOSPI ${Math.round(v.last)} — 4,300 하회` } : v.last <= 4800 ? { status: '✓', observed: `KOSPI ${Math.round(v.last)} — 바닥대 안` }
        : { status: '?', observed: `KOSPI ${Math.round(v.last)} — 아직 바닥대 미도달(1Y 고점 ${Math.round(v.high1y)})` }; } },
    { id: 'us10y-stress', claim: 'US10Y 5.1% 이상 = 신용 스트레스 구간', check: (m) => { const v = s(m, 'US10Y'); return !v ? unmeasured('US10Y 없음') : { status: v.last >= 5.1 ? '✓' : '✗', observed: `US10Y ${v.last}%` }; } },
    { id: 'dxy-104', claim: 'DXY ≈104 강달러(유동성 부족)', check: (m) => { const v = s(m, 'DXY'); return !v ? unmeasured('DXY 없음') : { status: v.last >= 102 ? '✓' : '✗', observed: `DXY ${v.last}` }; } },
    { id: 'wti-below-50', claim: 'WTI 50 아래 (2분기 강세 조건)', check: (m) => { const v = s(m, 'WTI'); return !v ? unmeasured('WTI 없음') : { status: v.last < 50 ? '✓' : '✗', observed: `WTI ${Math.round(v.last * 10) / 10} — 현재 미충족이면 ✗` }; } },
    { id: 'tga', claim: 'TGA 잔고 확대 → 1분기 유동성 부족', check: () => unmeasured('TGA 시계열 미연결') },
  ],
};
export function verifyMentor(slot: number, market: MarketResult | undefined, flows: FlowsResult | undefined): HookResult[] {
  return (HOOKS[slot] ?? []).map((h) => ({ id: h.id, claim: h.claim, ...h.check(market, flows) }));
}

// ── panel ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface Persona { id: string; name_kr: string; tier_owned: string; dimension: string; frame: string; voice: string; consensus_weight: number; emoji: string }
/** The attractiveness-panel skill's fixed semis panel (v0.4 core 12 — v0.5.1 regime pair and the retail PoC are left out). */
export const PANEL_EXCLUDED = ['regime-strategist', 'change-point-detector', 'korean-retail-sentiment'];
export function loadPanel(): { personas: Persona[]; source: string } {
  const path = join(SKILLS, 'attractiveness-panel/panels/semis.json');
  try {
    const all = (JSON.parse(readFileSync(path, 'utf8')) as { panel: Persona[] }).panel;
    return { personas: all.filter((p) => !PANEL_EXCLUDED.includes(p.id)), source: path };
  } catch { return { personas: fixture<{ panel: Persona[] }>('semis-panel').panel, source: 'fixture:semis-panel' }; }
}

export interface PanelAnswer {
  id: string; role: 'panel' | 'mentor'; label: string; runtime: Runtime; model: string; account: string; pane: string;
  status: 'ok' | 'failed'; durationMs: number; source: string; error?: string; retried?: string;
  action?: 'BUY' | 'HOLD' | 'SELL'; confidence?: number; view?: string; divergence?: string;
  eventImpact?: string; eventWhy?: string;
  // panel only
  tier?: string; weight?: number; emoji?: string;
  // mentor only
  slot?: number; gist?: string; direction?: string; scenario?: { q1: string; q2: string; h2: string }; verification?: HookResult[];
}

function promptFor(role: 'panel' | 'mentor', who: { persona?: Persona; mentor?: Mentor }, question: string, factsheet: string, eventText: string, hooks: HookResult[]): string {
  const common = [`질문: «${question}» (삼성전자·SK하이닉스는 예시 종목).`, '', '## 공유 팩트시트 (엘라누스 그래프가 방금 모은 실데이터)', factsheet, '',
    `## 이벤트 충격 · 최근 7일 뉴스 (${MENTOR_PACK_DATE} 이후)`, eventText, ''];
  const rules = ['규칙: 리서치 의견만. 주문·매매 지시 금지. 도구 호출·파일 쓰기 하지 말고 위 자료로만 답한다. 한국어 5~7문장 뒤, 마지막 줄에 JSON 한 줄만.'];
  if (role === 'mentor') {
    const m = who.mentor!;
    return [`너는 투자 멘토 «${m.name}»의 관점 틀을 적용하는 분석가다. 아래 틀은 ${MENTOR_PACK_DATE}에 형성됐다 — 그 뒤 이벤트(아래 뉴스)가 이 관점을 강화하는지 약화하는지 이유와 함께 말하라.`,
      '## 멘토 관점 틀 (비공개 — 원문을 인용하지 말고 요지로만 말할 것)', m.frame, '', ...common,
      '## 실데이터 검증 결과 (코드가 방금 판정)', ...hooks.map((h) => `${h.status} ${h.claim} — ${h.observed}`), '', ...rules,
      'JSON: {"direction":"강세|중립|약세|약세→강세 등","action":"BUY|HOLD|SELL","confidence":1-10,"view":"2027 KOSPI 한 줄","scenario":{"q1":"1분기","q2":"2분기","h2":"하반기"},"eventImpact":"강화|약화|유지","eventWhy":"한 줄"}'].join('\n');
  }
  const p = who.persona!;
  return [`너는 ${p.emoji} ${p.name_kr} (${p.tier_owned} 담당 · ${p.dimension}). 시각: ${p.frame} 말투: ${p.voice}`,
    `패널 견해는 ${MENTOR_PACK_DATE} 기준 팩트시트에 최근 이벤트를 더해 판단한다 — 이벤트가 네 견해를 강화/약화하는지 말하라.`, ...common, ...rules,
    'JSON: {"action":"BUY|HOLD|SELL","confidence":1-10,"view":"한 줄 요지","divergence":"framework 와 다른 점 한 줄 또는 align","eventImpact":"강화|약화|유지","eventWhy":"한 줄"}'].join('\n');
}

interface CliResult { text: string; model: string; account: string; pane: string; durationMs: number; code: number }
const shq = (s: string) => `'${s.replace(/'/gu, `'\\''`)}'`;
/** One panel CLI run: a script that the els pane (or a headless child) executes; the answer lands in <dir>/<id>.out. */
async function runPanelCli(id: string, label: string, binding: PanelNodeInput, prompt: string, dir: string, input: DemoInput, simulated?: string): Promise<CliResult> {
  mkdirSync(dir, { recursive: true });
  const promptFile = join(dir, `${id}.prompt.md`), outFile = join(dir, `${id}.out`), rcFile = join(dir, `${id}.rc`), script = join(dir, `${id}.sh`);
  writeFileSync(promptFile, prompt);
  const scrub = binding.runtime === 'claude' ? 'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDECODE CLAUDE_CODE_ENTRYPOINT'
    : binding.runtime === 'codex' ? 'unset OPENAI_API_KEY CODEX_API_KEY' : ':';
  const model = binding.model;
  let body: string;
  if (simulated !== undefined) {
    writeFileSync(join(dir, `${id}.sim.txt`), simulated);
    const lines = Math.max(1, simulated.split('\n').length);
    body = `while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; sleep ${Math.max(0.02, (input.simDelayMs ?? 1500) / 1000 / lines).toFixed(3)}; done < ${shq(join(dir, `${id}.sim.txt`))} | tee ${shq(outFile)}`;
  } else if (binding.runtime === 'eln') {
    const env = [binding.provider ? `ELANOUS_LLM_PROVIDER=${shq(binding.provider)}` : '', model ? `ELANOUS_LLM_MODEL=${shq(model)}` : ''].filter(Boolean).join(' ');
    body = `${env} bun ${shq(join(REPO_ROOT, 'bin/elanous.mjs'))} llm --json "$(cat ${shq(promptFile)})" | tee ${shq(outFile)}`;
  } else if (binding.runtime === 'codex') {
    body = `CODEX_HOME=${shq(process.env.INVEST_DEMO_CODEX_HOME ?? join(homedir(), '.codex-third-owner'))} codex exec --skip-git-repo-check --ephemeral -s read-only -C ${shq(dir)} ${model ? `-m ${shq(model)} ` : ''}-o ${shq(`${outFile}.last`)} - < ${shq(promptFile)} 2>&1 | tee ${shq(outFile)}`;
  } else {
    body = `claude -p --model ${shq(model ?? 'haiku')} --no-session-persistence --disallowed-tools Bash Edit Write WebFetch WebSearch < ${shq(promptFile)} 2>&1 | tee ${shq(outFile)}`;
  }
  writeFileSync(script, ['#!/bin/bash', `export PATH=${shq(process.env.PATH ?? '')}`, `export HOME=${shq(homedir())}`,
    ...(process.env.ELANOUS_STATE_DIR ? [`export ELANOUS_STATE_DIR=${shq(process.env.ELANOUS_STATE_DIR)}`] : []), scrub,
    `printf '\\033[1m▶ %s\\033[0m\\n' ${shq(`${label} · ${binding.runtime}${model ? ` · ${model}` : ''}${simulated !== undefined ? ' · simulated' : ''}`)}`,
    `printf '%s\\n\\n' ${shq(prompt.split('\n')[0]!.slice(0, 120))}`, body, 'rc=${PIPESTATUS[0]}', `echo $rc > ${shq(rcFile)}`, 'printf "\\n[done rc=%s]\\n" $rc', ''].join('\n'));
  const started = Date.now();
  const timeoutMs = simulated !== undefined ? (input.simDelayMs ?? 1500) + 30_000 : input.panelTimeoutMs ?? 150_000;
  let pane = 'headless';
  if (input.els) {
    const ws = input.elsWorkspace ?? 'invest-demo';
    // DEMO-INVEST-ELS-TARGET: the tab opens in the els this run targets (its universe's, or --els-socket) — through this
    // tree's own CLI unless INVEST_DEMO_ELN names another, never through the installed operational binary by default.
    const target = investElsTarget(process.env, input.elsSocket);
    const cli = process.env.INVEST_DEMO_ELN ? [process.env.INVEST_DEMO_ELN] : [process.execPath, join(REPO_ROOT, 'bin/elanous.mjs')];
    const r = await run(cli[0]!, [...cli.slice(1), 'side', 'new', '--ws', ws, '--title', investTabTitle(id, binding.runtime), '--cwd', dir, '--', 'bash', script],
      { timeoutMs: 15_000, env: investElsEnv(process.env, target) });
    if (r.code === 0) pane = `els:${ws}/${label}`;
  }
  let code = 1;
  if (pane === 'headless') {
    const child = spawn('bash', [script], { stdio: 'ignore' });
    code = await new Promise<number>((done) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); done(124); }, timeoutMs);
      child.on('exit', (c) => { clearTimeout(timer); done(c ?? 1); });
    });
  } else {
    while (Date.now() - started < timeoutMs && !existsSync(rcFile)) await sleep(500);
    code = existsSync(rcFile) ? Number(readFileSync(rcFile, 'utf8').trim()) : 124;
  }
  const raw = existsSync(`${outFile}.last`) ? readFileSync(`${outFile}.last`, 'utf8') : existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  let text = raw, usedModel = model ?? (simulated !== undefined ? recordedDefaultModel(binding.runtime) : binding.runtime === 'claude' ? 'haiku' : 'default');
  if (simulated === undefined && binding.runtime === 'eln') {
    let j: { reply?: string; model?: string; provider?: string } | undefined;
    for (const line of raw.trim().split('\n').reverse()) { try { j = JSON.parse(line) as typeof j; break; } catch { /* not the envelope line */ } }
    if (j?.reply) { text = j.reply; usedModel = `${j.provider ?? ''}/${j.model ?? ''}`; }
  }
  if (simulated === undefined && binding.runtime === 'codex') {
    const m = /^model:\s*(\S+)/mu.exec(existsSync(outFile) ? readFileSync(outFile, 'utf8') : '');
    if (m) usedModel = m[1]!;
  }
  const account = simulated !== undefined ? 'fixture' : binding.runtime === 'claude' ? 'claude CLI login (subscription; API keys scrubbed)'
    : binding.runtime === 'codex' ? `codex CLI · CODEX_HOME=${process.env.INVEST_DEMO_CODEX_HOME ?? '~/.codex-third-owner'} (subscription; API keys scrubbed)` : 'eln test-universe router';
  return { text, model: usedModel, account, pane, durationMs: Date.now() - started, code };
}

const ACTIONS = new Set(['BUY', 'HOLD', 'SELL']);
function parseAnswer(text: string): Partial<PanelAnswer> | undefined {
  const j = lastJsonObject(text);
  if (!j) return undefined;
  const action = String(j.action ?? '').toUpperCase();
  const confidence = Math.max(1, Math.min(10, Math.round(Number(j.confidence))));
  if (!ACTIONS.has(action) || !Number.isFinite(confidence)) return undefined;
  const scenario = j.scenario && typeof j.scenario === 'object' ? j.scenario as Record<string, unknown> : undefined;
  return { action: action as PanelAnswer['action'], confidence, view: String(j.view ?? '').slice(0, 240), divergence: j.divergence === undefined ? undefined : String(j.divergence).slice(0, 200),
    eventImpact: j.eventImpact === undefined ? undefined : String(j.eventImpact).slice(0, 20), eventWhy: j.eventWhy === undefined ? undefined : String(j.eventWhy).slice(0, 200),
    direction: j.direction === undefined ? undefined : String(j.direction).slice(0, 40),
    scenario: scenario ? { q1: String(scenario.q1 ?? '').slice(0, 120), q2: String(scenario.q2 ?? '').slice(0, 120), h2: String(scenario.h2 ?? '').slice(0, 120) } : undefined };
}

// ── consensus (attractiveness-panel SKILL.md Step 5 — the skill ships the formula, not a script) ─────────────────────
const SIGN = { BUY: 1, HOLD: 0, SELL: -1 } as const;
const actionFor = (score: number) => score >= 0.3 ? 'BUY' : score <= -0.3 ? 'SELL' : 'HOLD';
export function panelConsensus(answers: readonly PanelAnswer[], frameworkSignal: string) {
  const returned = answers.filter((a) => a.status === 'ok' && a.action && a.confidence);
  const total = returned.reduce((sum, a) => sum + (a.weight ?? 0), 0) || 1;
  const w = (a: PanelAnswer) => (a.weight ?? 0) / total; // renormalised over the panelists who answered (SKILL robustness note)
  const score = returned.reduce((sum, a) => sum + w(a) * (a.confidence! / 10) * SIGN[a.action!], 0);
  const finalAction = actionFor(score);
  const confPct = Math.round(returned.reduce((sum, a) => sum + w(a) * (a.confidence! / 10), 0) * 100);
  const votes = { BUY: 0, HOLD: 0, SELL: 0 };
  for (const a of returned) votes[a.action!]++;
  const tiers: Record<string, { weight: number; score: number; action: string }> = {};
  for (const a of returned) {
    const t = tiers[a.tier ?? 'other'] ??= { weight: 0, score: 0, action: 'HOLD' };
    t.weight += w(a); t.score += w(a) * (a.confidence! / 10) * SIGN[a.action!];
  }
  for (const t of Object.values(tiers)) { t.action = actionFor(t.weight ? t.score / t.weight : 0); t.weight = Math.round(t.weight * 1000) / 1000; t.score = Math.round(t.score * 1000) / 1000; }
  const divergent = returned.filter((a) => a.divergence && !/^align/iu.test(a.divergence.trim())).length;
  const alignment = finalAction === frameworkSignal ? 'aligned' : (finalAction === 'HOLD' || frameworkSignal === 'HOLD') ? 'partial' : 'opposed';
  return { n: returned.length, of: answers.length, score: Math.round(score * 1000) / 1000, action: finalAction, confidencePct: confPct, votes, tiers,
    divergenceRatePct: returned.length ? Math.round(divergent / returned.length * 100) : 0, frameworkSignal, alignment };
}
export function mentorConsensus(mentors: readonly PanelAnswer[]) {
  const returned = mentors.filter((m) => m.status === 'ok' && m.action && m.confidence);
  const score = returned.length ? returned.reduce((sum, m) => sum + (m.confidence! / 10) * SIGN[m.action!], 0) / returned.length : 0;
  return { n: returned.length, of: mentors.length, score: Math.round(score * 1000) / 1000, action: actionFor(score), weighting: 'equal' };
}

// ── decision triage («결정 분류» — Manager/Coordinator) ────────────────────────────────────────────────────────────
export interface DecisionItem { id: string; title: string; mode: 'auto' | 'human'; criterion: string; evidence: string }
export function triageDecisions(args: { sources: Array<{ node: string; source: string; reason?: string }>; answers: readonly PanelAnswer[]; panelOk: number; panelOf: number;
  mentorDirections: Array<{ name: string; action?: string }>; contradicted: Array<{ mentor: string; claim: string; observed: string }>; mandateArmed: boolean; fixtures: boolean;
  /** The run raises the human cards (--raise-decisions): publishing is then a person's call in rehearsal too. */
  raiseDecisions?: boolean }): DecisionItem[] {
  const items: DecisionItem[] = [];
  for (const s of args.sources.filter((x) => x.source === 'missing')) {
    items.push({ id: `source-missing:${s.node}`, title: `${s.node} 결과 없음 — 이 소스 없이 진행할까?`, mode: s.node === 'market' ? 'human' : 'auto',
      criterion: s.node === 'market' ? '규칙: 시세 없이는 검증표가 비므로 사람 확인' : '규칙: 보조 소스 누락은 리포트 출처 줄(missing)에 남기고 진행', evidence: '' });
  }
  for (const s of args.sources.filter((x) => x.source === 'fixture-fallback')) {
    items.push({ id: `source-substitution:${s.node}`, title: `${s.node} 라이브 실패 → 녹화 데이터로 대체할까?`, mode: s.node === 'market' ? 'human' : 'auto',
      criterion: s.node === 'market' ? '규칙: 시세(검증표의 근거)는 대체 시 사람 확인' : '규칙: 보조 소스 대체는 출처 표기(source=fixture-fallback) 영수가 있으면 자동 승인', evidence: s.reason ?? '' });
  }
  // DEMO-INVEST-ORCH-PIN: every panel answer is one triage item — accepted into the consensus or failed — so the count
  // is the same on every run of the same fixture (15 answers + sources + claims + the fixed four).
  for (const a of args.answers.filter((x) => x.status !== 'failed')) {
    items.push({ id: `answer-accepted:${a.id}`, title: `${a.label}(${a.runtime} · ${a.model}) 응답을 합의에 넣을까?`, mode: 'auto',
      criterion: '규칙: 파싱된 응답 + 사용 모델 기록이 있으면 자동 반영', evidence: `${a.action ?? '?'} ${a.confidence ?? '?'}/10` });
  }
  for (const a of args.answers.filter((x) => x.status === 'failed')) {
    items.push({ id: `panelist-failed:${a.id}`, title: `${a.label}(${a.runtime}) 응답 실패 — 재시도하거나 제외할까?`, mode: 'auto',
      criterion: 'SKILL 규칙: 1~2명 실패는 [failed] 표시 후 가중치 재정규화(재시도 없음)', evidence: a.error ?? '' });
  }
  for (const a of args.answers.filter((x) => x.retried)) {
    items.push({ id: `model-fallback:${a.id}`, title: `${a.label}: 지정 모델 실패 → 라우터 기본 모델로 대체해도 되나?`, mode: 'auto',
      criterion: '규칙: 같은 런타임 안의 모델 대체는 사용 모델 기록(model 필드)이 있으면 자동 승인', evidence: a.retried! });
  }
  items.push({ id: 'panel-quorum', title: `패널 정족수 ${args.panelOk}/${args.panelOf} — 합의를 발표해도 되나?`, mode: args.panelOk >= Math.ceil(args.panelOf * 2 / 3) ? 'auto' : 'human',
    criterion: '규칙: 응답 ≥ 2/3 이면 자동 · 미만이면 사람', evidence: `${args.panelOk}/${args.panelOf}` });
  const dirs = args.mentorDirections.filter((m) => m.action);
  for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) {
    if (dirs[i]!.action !== dirs[j]!.action && dirs[i]!.action !== 'HOLD' && dirs[j]!.action !== 'HOLD') items.push({ id: `mentor-conflict:${i + 1}-${j + 1}`,
      title: `멘토 상충 — ${dirs[i]!.name} ${dirs[i]!.action} vs ${dirs[j]!.name} ${dirs[j]!.action}: 어느 쪽을 헤드라인에?`, mode: 'human',
      criterion: '규칙: 반대 방향(BUY↔SELL) 상충은 해석 판단 — 사람', evidence: '' });
  }
  for (const c of args.contradicted) {
    items.push({ id: `contradicted-claim:${c.mentor}:${c.claim}`.slice(0, 120), title: `${c.mentor} 주장 «${c.claim}» 이 현재 데이터와 반대 — 리포트에 넣을까?`, mode: 'auto',
      criterion: '규칙: 검증표에 ✗ 로 표기해 그대로 싣는다(삭제 금지)', evidence: c.observed });
  }
  items.push({ id: 'conatus-execution', title: '합의 결과로 코나투스 주문을 낼까?', mode: 'auto',
    criterion: `규칙: 시연 그래프는 집행 노드가 없다 · mandate armed=${args.mandateArmed} → 집행 안 함`, evidence: 'execution: disabled' });
  const publishByHand = !args.fixtures || args.raiseDecisions === true;
  items.push({ id: 'publish-dashboard', title: '웹 계기판에 결과 JSON 을 공개할까?', mode: publishByHand ? 'human' : 'auto',
    criterion: publishByHand ? '규칙: 공개(publish)는 사람 결정' : '규칙: 녹화(dry-run) 결과는 로컬 파일만 — 공개 없음', evidence: '' });
  items.push({ id: 'disclaimer', title: '리포트 첫 줄 고지 문구를 넣을까?', mode: 'auto', criterion: `규칙: «${DISCLAIMER}» 항상 첫 줄`, evidence: '' });
  return items;
}

// ── handlers ───────────────────────────────────────────────────────────────────────────────────────────────────────
export function createInvestDemoHandlers(): InProcessHandlerRegistry {
  const handlers: Record<string, InProcessHandler> = {};
  handlers.plan = async (ctx) => {
    const input = inputOf(ctx);
    const outDir = resolve(input.outDir ?? join(process.env.ELANOUS_STATE_DIR ?? join(homedir(), '.elanous'), 'invest-demo', ctx.runId));
    mkdirSync(join(outDir, 'panes'), { recursive: true });
    await progress(ctx, 'materialize', `plan · ${input.fixtures ? 'fixtures' : 'live'} · ${input.question ?? DEFAULT_QUESTION}`);
    return ok({ question: input.question ?? DEFAULT_QUESTION, ticker: input.ticker ?? '005930.KO', mode: input.fixtures ? 'fixtures' : 'live', outDir, startedAt: new Date().toISOString() });
  };
  handlers['conatus-research'] = async (ctx) => {
    const question = resultOf<{ question: string }>(ctx, 'plan')?.question ?? DEFAULT_QUESTION;
    return liveOr(ctx, 'conatus-research', async () => cachedConatusResearch(question) ?? liveConatusResearch(question, 150_000));
  };
  handlers['conatus-ops'] = (ctx) => liveOr(ctx, 'conatus-ops', liveConatusOps);
  handlers.market = (ctx) => liveOr(ctx, 'market', liveMarket);
  handlers.flows = (ctx) => liveOr(ctx, 'flows', liveFlows);
  handlers.score = (ctx) => liveOr(ctx, 'score', () => liveScore(resultOf<{ ticker: string }>(ctx, 'plan')?.ticker ?? '005930.KO'));
  handlers.news = (ctx) => liveOr(ctx, 'news', async () => ({ source: 'live:omni-crawl', ...(await crawl('2027 코스피 전망 삼성전자 SK하이닉스', ['--time-range', 'week', '--limit', '6'])) }));
  handlers['x-pulse'] = (ctx) => liveOr(ctx, 'x-pulse', async () => ({ source: 'live:omni-crawl/grok-x', ...(await crawl('KOSPI 2027 outlook Samsung SK hynix', ['--engine', 'grok-x'], 90_000)) }));
  handlers['event-shock'] = (ctx) => liveOr(ctx, 'event-shock', async () => {
    // Query wording matters (measured 11-24): «reinstated NVIDIA CEO» surfaced the 11-17 «will not reinstate» stories first;
    // the board-statement wording surfaces the 11-23 reinstatement and the NVDA +30% day.
    const queries = ['NVIDIA board reinstates Jensen Huang as president and CEO', 'Nvidia stock surge after Jensen Huang reinstatement', 'AI capex HBM demand hyperscaler', '코스피 외국인 엔비디아 반도체'];
    const groups = await Promise.all(queries.map((q) => crawl(q, ['--time-range', 'week', '--limit', '4']).catch(() => ({ items: [] as CrawlItem[], summary: null }))));
    const items = curateStageHeadlines(groups.flatMap((g) => g.items).filter((i, n, all) => i.url && all.findIndex((j) => j.url === i.url) === n)).slice(0, 12);
    if (!items.length) throw new Error('event-shock: no items');
    return { source: 'live:omni-crawl', since: MENTOR_PACK_DATE, queries, items };
  });
  handlers.factsheet = async (ctx) => {
    const input = inputOf(ctx);
    const market = resultOf<MarketResult>(ctx, 'market'), flows = resultOf<FlowsResult>(ctx, 'flows'), score = resultOf<ScoreResult>(ctx, 'score');
    const news = resultOf<{ items: CrawlItem[] }>(ctx, 'news'), x = resultOf<{ summary: string | null; items: CrawlItem[] }>(ctx, 'x-pulse');
    const event = resultOf<{ items: CrawlItem[] }>(ctx, 'event-shock'), conatus = resultOf<ConatusResearchResult>(ctx, 'conatus-research');
    const line = (k: string, unit = '') => { const v = market?.series[k]; return v ? `${k} ${Math.round(v.last * 100) / 100}${unit} (${v.date} · 1M ${v.chg1m ?? '?'}% · 3M ${v.chg3m ?? '?'}% · 1Y 고 ${Math.round(v.high1y)} 저 ${Math.round(v.low1y)})` : `${k} 없음`; };
    const facts = [
      `시세: ${['KOSPI', 'SAMSUNG', 'SKHYNIX', 'SOXX', 'NVDA'].map((k) => line(k)).join(' | ')}`,
      `거시: ${line('US10Y', '%')} | ${line('DXY')} | ${line('USDKRW')} | ${line('WTI')}`,
      flows ? `수급(KOSPI, 백만원): 외국인 5일 ${flows.kospi.foreign5dMillion} · 20일 ${flows.kospi.foreign20dMillion} · 기관 5일 ${flows.kospi.inst5dMillion} · 삼성전자 외국인 5일 ${flows.samsungForeign5dShares ?? '?'}주` : '수급 없음',
      score ? `매력도(asset-attractiveness semis · ${score.symbol} · ${score.asOf}): ${score.total}/100 · ${score.signal} · z ${score.z} · ${Object.entries(score.tiers).map(([k, v]) => `${k} ${v.score}`).join(' · ')}` : '매력도 없음',
      `뉴스: ${(news?.items ?? []).slice(0, 4).map((i) => i.title).join(' / ')}`,
      `X 여론: ${(x?.summary ?? '').replace(/\s+/gu, ' ').slice(0, 400)}`,
      `코나투스 리서치: ${(conatus?.summary ?? '').replace(/\s+/gu, ' ').slice(0, 500)}`,
    ].join('\n');
    const eventText = (event?.items ?? []).slice(0, 8).map((i) => `- ${i.title} — ${i.snippet.slice(0, 160)} (${i.url})`).join('\n') || '- (수집 없음)';
    let mentors: Mentor[]; let mentorSource: string;
    const packPath = input.mentorPack ?? (input.fixtures ? join(FIXTURE_DIR, 'mentor-pack.fixture.md') : MENTOR_PACK_PATH);
    try { mentors = parseMentorPack(readFileSync(packPath, 'utf8')); mentorSource = packPath === MENTOR_PACK_PATH ? 'private-pack' : packPath.startsWith(FIXTURE_DIR) ? 'fixture' : 'custom'; }
    catch { mentors = parseMentorPack(readFileSync(join(FIXTURE_DIR, 'mentor-pack.fixture.md'), 'utf8')); mentorSource = 'fixture-fallback'; }
    await progress(ctx, 'materialize', `factsheet · mentors ${mentors.length} (${mentorSource})`);
    return ok({ factsheet: facts, eventText, mentors, mentorSource, market, flows });
  };
  const panelist: InProcessHandler = async (ctx) => {
    const input = inputOf(ctx);
    const binding = ctx.nodeInput as PanelNodeInput;
    const plan = resultOf<{ question: string; outDir: string }>(ctx, 'plan')!;
    const fs = resultOf<{ factsheet: string; eventText: string; mentors: Mentor[]; market?: MarketResult; flows?: FlowsResult }>(ctx, 'factsheet')!;
    const market = fs.market, flows = fs.flows;
    let label: string; let prompt: string; let base: Partial<PanelAnswer>;
    if (binding.role === 'mentor') {
      const mentor = fs.mentors.find((m) => m.slot === binding.slot);
      if (!mentor) return ok({ id: ctx.nodeId, role: 'mentor', label: `mentor-${binding.slot}`, runtime: binding.runtime, model: '-', account: '-', pane: '-', status: 'failed', durationMs: 0, source: '-', error: 'no mentor in pack' } satisfies PanelAnswer);
      await progress(ctx, 'verify', `${mentor.name} 검증 훅 · runtime=${binding.runtime}`);
      const verification = verifyMentor(mentor.slot, market, flows);
      label = mentor.name;
      prompt = promptFor('mentor', { mentor }, plan.question, fs.factsheet, fs.eventText, verification);
      base = { slot: mentor.slot, gist: mentor.gist, verification };
    } else {
      const persona = loadPanel().personas.find((p) => p.id === binding.persona);
      if (!persona) return ok({ id: ctx.nodeId, role: 'panel', label: binding.persona ?? ctx.nodeId, runtime: binding.runtime, model: '-', account: '-', pane: '-', status: 'failed', durationMs: 0, source: '-', error: 'unknown persona' } satisfies PanelAnswer);
      label = persona.name_kr;
      prompt = promptFor('panel', { persona }, plan.question, fs.factsheet, fs.eventText, []);
      base = { tier: persona.tier_owned, weight: persona.consensus_weight, emoji: persona.emoji };
    }
    await progress(ctx, 'generate', `runtime=${binding.runtime} model=${binding.model ?? (input.fixtures ? recordedDefaultModel(binding.runtime) : 'default')} · ${label}`);
    const dir = join(plan.outDir, 'panes');
    const simulated = input.fixtures ? (fixture<Record<string, string>>('panel-answers')[ctx.nodeId] ?? '') : undefined;
    let cli = await runPanelCli(ctx.nodeId, label, binding, prompt, dir, input, simulated);
    let parsed = parseAnswer(cli.text);
    let retried: string | undefined;
    if (!parsed && simulated === undefined && binding.runtime === 'eln' && (binding.model || binding.provider)) {
      retried = `${binding.provider ?? ''}/${binding.model ?? ''} 실패(rc ${cli.code}) → 라우터 기본`;
      await progress(ctx, 'generate', `runtime=eln model=router-default · ${label} (retry)`);
      cli = await runPanelCli(`${ctx.nodeId}-retry`, label, { ...binding, model: undefined, provider: undefined }, prompt, dir, input);
      parsed = parseAnswer(cli.text);
    }
    const answer: PanelAnswer = { id: ctx.nodeId, role: binding.role, label, runtime: binding.runtime, model: cli.model, account: cli.account, pane: cli.pane,
      status: parsed ? 'ok' : 'failed', durationMs: cli.durationMs, source: simulated !== undefined ? 'fixture' : 'live', ...base, ...(parsed ?? {}),
      ...(parsed ? {} : { error: `no parsable answer (rc ${cli.code}): ${cli.text.trim().split('\n').at(-1)?.slice(0, 160) ?? ''}` }), ...(retried ? { retried } : {}) };
    // Last line first (the note is capped at 80 chars): verdict · who · the answer's own one-line view.
    await progress(ctx, 'generate', `runtime=${binding.runtime} model=${cli.model} · ${answer.status === 'ok' ? `${answer.action} ${answer.confidence}/10` : 'failed'} · ${label}${answer.view ? ` · ${answer.view}` : ''}`);
    return ok(answer);
  };
  handlers.panelist = panelist;
  handlers.consensus = async (ctx) => {
    const answers = Object.values(ctx.outputs).map((o) => (o as { result?: PanelAnswer } | null)?.result).filter((r): r is PanelAnswer => !!r && typeof r === 'object' && 'role' in r && 'runtime' in r);
    const score = resultOf<ScoreResult>(ctx, 'score');
    const panel = answers.filter((a) => a.role === 'panel'), mentors = answers.filter((a) => a.role === 'mentor').sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
    const p = panelConsensus(panel, score?.signal ?? 'HOLD');
    const m = mentorConsensus(mentors);
    const blend = { panel: 0.5, mentors: 0.5 };
    const overallScore = Math.round((blend.panel * p.score + blend.mentors * m.score) * 1000) / 1000;
    await progress(ctx, 'verify', `consensus ${p.action} ${p.score} · mentors ${m.action} · overall ${actionFor(overallScore)}`);
    return ok({ panel: p, mentors: m, overall: { score: overallScore, action: actionFor(overallScore), blend }, answers: [...panel, ...mentors] });
  };
  handlers['conatus-judge'] = async (ctx) => {
    const { loadMandate, tradeMandatePath } = await import('../../src/domains/trade-mandate.js');
    const { INVESTMENT_PACK } = await import('../../src/autopilot/domain/investment-pack.js');
    const mandate = loadMandate();
    const c = resultOf<{ overall: { action: string; score: number }; panel: { n: number; of: number } }>(ctx, 'consensus');
    const checks = [
      { id: 'observe-research', pass: !!resultOf(ctx, 'market') && !!resultOf(ctx, 'conatus-research'), note: '관측·리서치 단계를 거쳤다 (phaseShapeHint: 매매 직행 금지)' },
      { id: 'quorum', pass: (c?.panel.n ?? 0) >= 8, note: `패널 응답 ${c?.panel.n ?? 0}/${c?.panel.of ?? 0}` },
      { id: 'no-execution', pass: true, note: '이 그래프에는 집행 노드가 없다 — executor 호출 0' },
    ];
    await progress(ctx, 'verify', `Conatus 판단·검증 · mandate armed=${mandate.armed} live=${mandate.live} · 집행 비활성`);
    return ok({ engine: 'Conatus (investment pack D3 · dry)', phases: ['관측 ✓', '리서치 ✓', '판단 ✓', '집행 ✗ 비활성', '검증 ✓'],
      phaseShapeHint: (INVESTMENT_PACK.decompose.phaseShapeHint ?? '').slice(0, 80), judgement: c ? `${c.overall.action} (overall ${c.overall.score}) — 리서치 의견, 주문 없음` : 'no consensus',
      mandate: { path: tradeMandatePath(), armed: mandate.armed, live: mandate.live }, execution: `집행: 비활성(${mandate.armed ? 'mandate armed 이나 시연 그래프는 집행 노드 없음' : 'mandate disarmed'})`, checks });
  };
  handlers['decision-triage'] = async (ctx) => {
    const input = inputOf(ctx);
    const sources = ['conatus-research', 'conatus-ops', 'market', 'flows', 'score', 'news', 'x-pulse', 'event-shock']
      .map((node) => ({ node, ...(resultOf<{ source: string; fallbackReason?: string }>(ctx, node) ?? { source: 'missing' }) }))
      .map((s) => ({ node: s.node, source: s.source, reason: (s as { fallbackReason?: string }).fallbackReason }));
    const c = resultOf<{ answers: PanelAnswer[]; panel: { n: number; of: number } }>(ctx, 'consensus');
    const judge = resultOf<{ mandate: { armed: boolean } }>(ctx, 'conatus-judge');
    const answers = c?.answers ?? [];
    const mentors = answers.filter((a) => a.role === 'mentor');
    const items = triageDecisions({ sources, answers, panelOk: c?.panel.n ?? 0, panelOf: c?.panel.of ?? 0,
      mentorDirections: mentors.map((m) => ({ name: m.label, action: m.action })),
      contradicted: mentors.flatMap((m) => (m.verification ?? []).filter((h) => h.status === '✗').map((h) => ({ mentor: m.label, claim: h.claim, observed: h.observed }))),
      mandateArmed: judge?.mandate.armed ?? false, fixtures: input.fixtures === true, raiseDecisions: input.raiseDecisions === true });
    const human = items.filter((i) => i.mode === 'human');
    const raised: Array<{ id: string; ok: boolean; detail: string }> = [];
    if (input.raiseDecisions && !input.fixtures) {
      for (const item of human) {
        const r = await run(process.env.INVEST_DEMO_ELN ?? 'eln', ['decisions', 'raise', '--title', `[투자 리서치 시연] ${item.title}`.slice(0, 120), '--category', item.id === 'publish-dashboard' ? 'publish' : 'other',
          '--s', `DEMO-1126-INVEST-ORCH 그래프 런 ${ctx.runId}`, '--c', item.criterion, '--option', 'yes=진행:리포트에 반영', '--option', 'no=보류:리포트에서 제외',
          '--recommend', 'yes', '--why', item.evidence || item.criterion, '--no-xcheck', '시연 런 자동 카드', '--json'], { timeoutMs: 30_000 });
        raised.push({ id: item.id, ok: r.code === 0, detail: (r.code === 0 ? r.stdout : r.stderr).trim().split('\n').at(-1)?.slice(0, 200) ?? '' });
      }
    }
    const summary = `결정 대기 ${items.length}건 → 기준 자동 처리 ${items.length - human.length}건 · 사람 결정 ${human.length}건`;
    await progress(ctx, 'verify', summary);
    return ok({ summary, summaryEn: investDecisionSummaryEn(items.length, human.length), items, raised, cards: human.map((i) => `[결정 카드] ${i.title} · 기준: ${i.criterion}`) });
  };
  handlers.report = async (ctx) => {
    const plan = resultOf<{ question: string; ticker: string; mode: string; outDir: string; startedAt: string }>(ctx, 'plan')!;
    const c = resultOf<{ panel: ReturnType<typeof panelConsensus>; mentors: ReturnType<typeof mentorConsensus>; overall: { score: number; action: string; blend: { panel: number; mentors: number } }; answers: PanelAnswer[] }>(ctx, 'consensus')!;
    const judge = resultOf<{ engine: string; phases: string[]; judgement: string; execution: string; mandate: { armed: boolean; live: boolean } }>(ctx, 'conatus-judge')!;
    const triage = resultOf<{ summary: string; items: DecisionItem[]; cards: string[]; raised: unknown[] }>(ctx, 'decision-triage')!;
    const score = resultOf<ScoreResult>(ctx, 'score'), market = resultOf<MarketResult>(ctx, 'market'), flows = resultOf<FlowsResult>(ctx, 'flows');
    const event = resultOf<{ items: CrawlItem[] }>(ctx, 'event-shock'), ops = resultOf<ConatusOpsResult>(ctx, 'conatus-ops'), research = resultOf<ConatusResearchResult>(ctx, 'conatus-research');
    const panel = c.answers.filter((a) => a.role === 'panel'), mentors = c.answers.filter((a) => a.role === 'mentor');
    const sources = Object.fromEntries(['conatus-research', 'conatus-ops', 'market', 'flows', 'score', 'news', 'x-pulse', 'event-shock'].map((n) => [n, resultOf<{ source: string }>(ctx, n)?.source ?? 'missing']));
    const finishedAt = new Date().toISOString();
    const dashboard = {
      schema: DASHBOARD_SCHEMA, disclaimer: DISCLAIMER, question: plan.question, ticker: plan.ticker, mode: plan.mode, runId: ctx.runId,
      startedAt: plan.startedAt, finishedAt, durationMs: Date.parse(finishedAt) - Date.parse(plan.startedAt), sources,
      orchestration: { conductor: 'elanous graph-runner', engine: 'Conatus', runtimes: (['eln', 'codex', 'claude'] as const).map((r) => ({ runtime: r, nodes: c.answers.filter((a) => a.runtime === r).map((a) => a.id) })) },
      conatus: { research: research ? { label: 'Conatus research', source: research.source, needed: research.needed, durationMs: research.durationMs } : null,
        ops: ops ? { label: 'Conatus ops (read-only)', loops: ops.loops, missions: ops.missions, traces: ops.traces } : null,
        judge: { label: 'Conatus 판단·검증', phases: judge.phases, judgement: judge.judgement, execution: judge.execution, mandate: judge.mandate } },
      market: market ? Object.fromEntries(Object.entries(market.series).map(([k, v]) => [k, { last: v.last, date: v.date, chg1m: v.chg1m, chg3m: v.chg3m }])) : null,
      flows: flows ? { foreign5dMillion: flows.kospi.foreign5dMillion, foreign20dMillion: flows.kospi.foreign20dMillion, inst5dMillion: flows.kospi.inst5dMillion } : null,
      framework: score ? { total: score.total, signal: score.signal, z: score.z, tiers: score.tiers, asOf: score.asOf } : null,
      events: tickerHeadlines(plan.ticker, [resultOf<{ items: CrawlItem[] }>(ctx, 'news')?.items ?? [], event?.items ?? []]).slice(0, 8).map((i) => ({ title: i.title, url: i.url })),
      panel: panel.map((a) => ({ id: a.id, label: a.label, emoji: a.emoji, tier: a.tier, weight: a.weight, runtime: a.runtime, model: a.model, pane: a.pane, status: a.status,
        action: a.action ?? null, confidence: a.confidence ?? null, view: a.view ?? null, eventImpact: a.eventImpact ?? null, durationMs: a.durationMs })),
      mentors: mentors.map((a) => ({ id: a.id, name: a.label, gist: a.gist, runtime: a.runtime, model: a.model, status: a.status, direction: a.direction ?? null, action: a.action ?? null,
        confidence: a.confidence ?? null, durationMs: a.durationMs, pane: a.pane, scenario: a.scenario ?? null, changeSince1121: a.eventImpact ? { impact: a.eventImpact, why: a.eventWhy ?? '' } : null,
        verification: a.verification ?? [] })),
      consensus: { panel: c.panel, mentors: c.mentors, overall: c.overall },
      decisions: triage.items.map((i) => ({ id: i.id, title: i.title, mode: i.mode, criterion: i.criterion })), decisionSummary: triage.summary,
    };
    const fmt = (a: PanelAnswer) => a.status === 'ok' ? `${a.action} ${a.confidence}/10` : '[failed]';
    const md = [
      `# ${DISCLAIMER}`, '',
      `## ${plan.question} — 엘라누스 지휘 × 코나투스 투자 엔진 × codex/claude/eln 패널`, '',
      `런 ${ctx.runId} · ${plan.mode} · ${Math.round(dashboard.durationMs / 1000)}초 · 출처 ${Object.entries(sources).map(([k, v]) => `${k}=${v}`).join(' · ')}`, '',
      '### 1. 프레임워크 팩트시트', score ? `asset-attractiveness(semis · ${score.symbol}) **${score.total}/100 · ${score.signal}** · z ${score.z}` : '(없음)', '',
      '### 2. 이벤트 충격 · 최근 7일 (멘토 팩 11-21 이후)', ...(event?.items ?? []).slice(0, 5).map((i) => `- ${i.title} (${i.url})`), '',
      '### 3. 패널 (가중 합의 · attractiveness-panel 공식)', '| 패널 | 런타임 · 모델 | 의견 | 11-21 대비 | 요지 |', '|---|---|---|---|---|',
      ...panel.map((a) => `| ${a.emoji ?? ''} ${a.label} (w ${a.weight}) | ${a.runtime} · ${a.model} | ${fmt(a)} | ${a.eventImpact ?? '-'} | ${(a.view ?? a.error ?? '').replace(/\|/gu, '/')} |`), '',
      `가중 점수 **${c.panel.score}** → **${c.panel.action}** · 신뢰도 ${c.panel.confidencePct}/100 · 표 BUY ${c.panel.votes.BUY} · HOLD ${c.panel.votes.HOLD} · SELL ${c.panel.votes.SELL} · 응답 ${c.panel.n}/${c.panel.of} · 프레임워크 ${c.panel.frameworkSignal} 와 ${c.panel.alignment}`, '',
      '### 4. 멘토 시나리오 (이름 + 요지만 · 원문 비공개)', '| 멘토 | 요지 | 런타임 | 방향 | 1분기 | 2분기 | 하반기 | 11-21 대비 변화 |', '|---|---|---|---|---|---|---|---|',
      ...mentors.map((a) => `| ${a.label} | ${a.gist ?? ''} | ${a.runtime} · ${a.model} | ${a.direction ?? fmt(a)} | ${a.scenario?.q1 ?? '-'} | ${a.scenario?.q2 ?? '-'} | ${a.scenario?.h2 ?? '-'} | ${a.eventImpact ?? '-'}${a.eventWhy ? ` — ${a.eventWhy}` : ''} |`.replace(/\n/gu, ' ')), '',
      '### 5. 검증표 — 노하우 팩 × 실데이터', '| 멘토 | 주장 | 판정 | 관측 |', '|---|---|---|---|',
      ...mentors.flatMap((a) => (a.verification ?? []).map((h) => `| ${a.label} | ${h.claim} | ${h.status} | ${h.observed} |`)), '',
      `### 6. 종합 — 패널 ${c.panel.action}(${c.panel.score}) × 멘토 ${c.mentors.action}(${c.mentors.score}) → **${c.overall.action}** (${c.overall.score} · 가중 ${c.overall.blend.panel}/${c.overall.blend.mentors})`, '',
      `### 7. Conatus 판단·검증`, `${judge.phases.join(' → ')} · ${judge.judgement}`, `**${judge.execution}**`,
      ops ? `코나투스 운영(읽기 전용): 투자 루프 ${ops.loops.count}개 · armed=${ops.loops.armed} · live=${ops.loops.live} · 최근 런타임 기록 ${ops.traces.slice(0, 3).map((t) => `${t.file}(${t.ageMin}분 전)`).join(', ')}` : '', '',
      '### 8. 결정 분류', `**${triage.summary}**`, ...triage.items.map((i) => `- [${i.mode === 'auto' ? '자동' : '사람'}] ${i.title} — ${i.criterion}`), ...(triage.cards.length ? ['', ...triage.cards] : []), '',
      `— ${DISCLAIMER}. 자동 주문 없음.`, '',
    ].join('\n');
    mkdirSync(plan.outDir, { recursive: true });
    writeFileSync(join(plan.outDir, 'report.md'), md);
    writeFileSync(join(plan.outDir, 'dashboard.json'), `${JSON.stringify(dashboard, null, 2)}\n`);
    await progress(ctx, 'publish', `report · ${c.overall.action} · ${triage.summary}`);
    return ok({ report: join(plan.outDir, 'report.md'), dashboard: join(plan.outDir, 'dashboard.json'), firstLine: md.split('\n')[0], consensusLine: `패널 ${c.panel.action}(${c.panel.score}) · 멘토 ${c.mentors.action}(${c.mentors.score}) · 종합 ${c.overall.action}(${c.overall.score})`, decisionSummary: triage.summary,
      summaryLines: investRunSummaryLines(c, triage.items.length, triage.items.filter((i) => i.mode === 'human').length) });
  };
  return handlers;
}

/** Product text for the els tab of one panelist — English stage name · runtime («Global macro · eln»). */
export const investTabTitle = (nodeId: string, runtime: string): string =>
  `${panelName(nodeId.replace(/-retry$/u, ''))} · ${runtime}${nodeId.endsWith('-retry') ? ' · retry' : ''}`;

/** «25 decisions → 24 automatic · 1 for you» — the English line the run summary prints. */
export const investDecisionSummaryEn = (total: number, human: number): string =>
  `${total} decision${total === 1 ? '' : 's'} → ${total - human} automatic · ${human} for you`;

/** The CLI run summary a demo viewer reads (the Korean report.md stays the operator's artifact). */
export function investRunSummaryLines(c: { panel: { action: string; score: number }; mentors: { action: string; score: number }; overall: { action: string; score: number } }, total: number, human: number): string[] {
  return ['Research demo · not investment advice · no order is placed',
    `Panel ${c.panel.action} (${c.panel.score}) · mentors ${c.mentors.action} (${c.mentors.score}) · overall ${c.overall.action} (${c.overall.score})`,
    investDecisionSummaryEn(total, human)];
}
