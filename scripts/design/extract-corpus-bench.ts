#!/usr/bin/env bun
/**
 * Corpus bench for design-system extraction.
 *
 *   bun scripts/design/extract-corpus-bench.ts \
 *     [--corpus docs/design/corpus/sites-v1.tsv] [--out <dir>] \
 *     [--only dev|holdout] [--repeat N] [--compare <old result dir>] \
 *     [--json] [--show-holdout]
 *
 * Each site is extracted in an isolated universe (`--test=<out>/universe`).
 * This script never writes the operating universe.
 *
 * Human output lists per-site failures for the dev set only. The holdout set
 * is numbers only, so a rule is not written by looking at holdout sites
 * (`--show-holdout` is the only way to print those rows).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  summarize,
  summarizeBy,
  scoreSite,
  type SiteScore,
  type Summary,
  type SummaryRow,
  type TokensJson,
} from './extract-corpus-score';

export const DEFAULT_CORPUS = 'docs/design/corpus/sites-v1.tsv';
export const SITE_TIMEOUT_MS = 90_000;

export type CorpusSet = 'dev' | 'holdout';

export interface CorpusSite {
  readonly set: CorpusSet;
  readonly category: string;
  readonly url: string;
  readonly id: string;
}

export interface FromUrlResult {
  readonly id?: string;
  readonly saved?: boolean;
  readonly extractDir?: string;
  readonly provenance?: unknown;
  readonly tokensCss?: string;
}

/** The id the CLI reported, or the corpus id when the payload omitted it. */
export function fromUrlId(result: FromUrlResult, fallback: string): string {
  return typeof result.id === 'string' && result.id !== '' ? result.id : fallback;
}

/** `saved: false` is a failed promotion even when the process exited 0. */
export function fromUrlSaved(result: FromUrlResult): boolean {
  return result.saved !== false;
}

/** Provenance is recorded, not scored. Missing provenance is an empty note. */
export function provenanceNote(result: FromUrlResult): string {
  if (result.provenance == null) return '';
  if (typeof result.provenance === 'string') return result.provenance;
  try {
    return JSON.stringify(result.provenance);
  } catch {
    return '';
  }
}

export interface SiteRun {
  readonly site: CorpusSite;
  readonly repeat: number;
  readonly sec: number;
  /** Process exited 0 and the CLI did not report `saved: false`. */
  readonly okRun: boolean;
  readonly error?: string;
  readonly score: SiteScore;
  /** Id the CLI returned (`FromUrlResult.id`), falling back to the corpus id. */
  readonly reportedId: string;
  /** `FromUrlResult.saved`. Absent means the payload did not say. */
  readonly saved?: boolean;
  /** Serialized `FromUrlResult.provenance`, empty when the CLI sent none. */
  readonly provenance: string;
  readonly fromUrl?: FromUrlResult;
}

export interface BenchStamp {
  readonly commit: string;
  readonly date: string;
  readonly corpusSha: string;
  readonly corpus: string;
}

export interface BenchOptions {
  readonly corpusPath: string;
  readonly outDir: string;
  readonly only?: CorpusSet;
  readonly repeat: number;
  readonly compareDir?: string;
  readonly json: boolean;
  readonly showHoldout: boolean;
  readonly repoRoot: string;
  /** Test seam. Production calls the isolated CLI. */
  readonly runSite?: SiteRunner;
  readonly now?: Date;
  readonly commit?: string;
}

export type SiteRunner = (site: CorpusSite, ctx: { outDir: string; universe: string; repoRoot: string }) => Promise<{
  sec: number;
  fromUrl: FromUrlResult;
  tokensJson: TokensJson | null;
  error?: string;
}>;

export function siteId(url: string): string {
  const host = url.replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/[^a-z0-9.]+/gi, '-');
  return host.slice(0, 80);
}

export function parseCorpus(text: string): CorpusSite[] {
  const sites: CorpusSite[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [set, category, url] = trimmed.split('\t');
    if ((set !== 'dev' && set !== 'holdout') || !category || !url) continue;
    sites.push({ set, category, url, id: siteId(url) });
  }
  return sites;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function gitHead(repoRoot: string): string {
  try {
    const r = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    return (r.stdout ?? '').trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Argv of the isolated extract. The binary is whatever `bun` is on PATH
 * (the test puts a stub there). `--test` is only `<out>/universe`.
 * There is no second universe and no operating-universe flag.
 */
export function isolatedFromUrlArgv(
  site: CorpusSite,
  ctx: { outDir: string; universe: string; repoRoot: string },
): readonly string[] {
  return [
    join(ctx.repoRoot, 'bin/elanous.mjs'),
    `--test=${ctx.universe}`,
    'repo', 'design-system', 'from-url', site.url,
    '--id', site.id,
    '--json',
  ];
}

/** Production runner. Always passes `--test=<out>/universe` — never the operating universe. */
export async function runIsolatedFromUrl(
  site: CorpusSite,
  ctx: { outDir: string; universe: string; repoRoot: string },
): Promise<{ sec: number; fromUrl: FromUrlResult; tokensJson: TokensJson | null; error?: string }> {
  const args = isolatedFromUrlArgv(site, ctx);
  const started = Date.now();
  const stdout = await new Promise<string>((resolveOut, reject) => {
    const child = spawn('bun', args, { cwd: ctx.repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timeout ${SITE_TIMEOUT_MS}ms`));
    }, SITE_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(err.trim() || `exit ${code}`));
      else resolveOut(out);
    });
  }).catch((e: Error) => {
    return { __error: e.message } as const;
  });
  const sec = (Date.now() - started) / 1000;
  if (typeof stdout !== 'string') {
    return { sec, fromUrl: {}, tokensJson: null, error: stdout.__error };
  }
  const jsonStart = stdout.indexOf('{');
  const fromUrl = jsonStart === -1 ? {} : JSON.parse(stdout.slice(jsonStart)) as FromUrlResult;
  let tokensJson: TokensJson | null = null;
  if (fromUrl.extractDir) {
    tokensJson = readJsonFile<TokensJson>(join(fromUrl.extractDir, 'tokens.json'));
  }
  return { sec, fromUrl, tokensJson };
}

export interface BenchResult {
  readonly stamp: BenchStamp;
  readonly runs: readonly SiteRun[];
  readonly human: string;
  readonly indexTsv: string;
}

/** Ledger `ok` and the summary `ok` are the same bit: call succeeded and core == 6. */
export function runOk(run: Pick<SiteRun, 'okRun' | 'score'>): boolean {
  return run.okRun && run.score.core === 6;
}

function rowOf(run: SiteRun): SummaryRow {
  return {
    set: run.site.set,
    category: run.site.category,
    core: run.score.core,
    contrast: run.score.contrast,
    accentOk: run.score.accentOk,
    painted: run.score.painted,
    empty: run.score.empty,
    sec: run.sec,
    ok: runOk(run),
  };
}

function fmtRatio(pass: number, denom: number): string {
  if (denom === 0) return `${pass}/0`;
  return `${pass}/${denom} (${((pass / denom) * 100).toFixed(0)}%)`;
}

function fmtSummary(label: string, s: Summary): string {
  const med = s.medianSec === null ? '—' : s.medianSec.toFixed(2);
  return [
    label.padEnd(16),
    `n=${s.n}`,
    `ok=${fmtRatio(s.ok, s.n)}`,
    `coreAvg=${s.coreAvg.toFixed(2)}`,
    `contrast=${fmtRatio(s.contrastPass, s.contrastN)}`,
    `accent=${fmtRatio(s.accentOk, s.accentN)}`,
    `empty=${s.empty}`,
    `medianSec=${med}`,
  ].join('  ');
}

function loadCompare(dir: string): Map<string, SiteRun> {
  const map = new Map<string, SiteRun>();
  const index = readJsonFile<{ runs?: SiteRun[] }>(join(dir, 'runs.json'));
  if (!index?.runs) return map;
  for (const run of index.runs) {
    if (run.repeat !== 0 && run.repeat !== undefined) continue;
    map.set(run.site.id, run);
  }
  return map;
}

function cellDelta(before: string, after: string): string {
  return `${before} → ${after}`;
}

export function renderHuman(opts: {
  stamp: BenchStamp;
  runs: readonly SiteRun[];
  showHoldout: boolean;
  compare?: Map<string, SiteRun>;
}): string {
  const lines: string[] = [];
  lines.push(`STAMP  commit=${opts.stamp.commit}  date=${opts.stamp.date}  corpus=${opts.stamp.corpusSha}`);
  const first = opts.runs.filter((r) => r.repeat === 0);
  const groups: Array<[string, SiteRun[]]> = [['all', [...first]]];
  for (const set of ['dev', 'holdout'] as const) {
    const rows = first.filter((r) => r.site.set === set);
    if (rows.length) groups.push([set, rows]);
  }
  const categories = [...new Set(first.map((r) => r.site.category))];
  for (const cat of categories) groups.push([`cat:${cat}`, first.filter((r) => r.site.category === cat)]);
  lines.push('');
  lines.push('table');
  const summaryRows = first.map(rowOf);
  const bySet = summarizeBy(summaryRows, 'set');
  const byCategory = summarizeBy(summaryRows, 'category');
  for (const [label, rows] of groups) {
    const axis = label.startsWith('cat:') ? 'category' : 'set';
    const key = label.startsWith('cat:') ? label.slice(4) : label === 'all' ? '' : label;
    const fromGroup = key === ''
      ? summarize(rows.map(rowOf), axis)
      : (axis === 'category' ? byCategory : bySet).get(key) ?? summarize(rows.map(rowOf), axis);
    lines.push(fmtSummary(label, fromGroup));
  }
  if (opts.compare && opts.compare.size > 0) {
    lines.push('');
    lines.push('compare  (before → after)');
    const beforeRows = [...opts.compare.values()];
    const beforeAll = summarize(beforeRows.map(rowOf), 'set');
    const afterAll = summarize(first.map(rowOf), 'set');
    lines.push(`all  ok ${cellDelta(String(beforeAll.ok), String(afterAll.ok))}  coreAvg ${cellDelta(beforeAll.coreAvg.toFixed(2), afterAll.coreAvg.toFixed(2))}  contrast ${cellDelta(`${beforeAll.contrastPass}/${beforeAll.contrastN}`, `${afterAll.contrastPass}/${afterAll.contrastN}`)}  accent ${cellDelta(`${beforeAll.accentOk}/${beforeAll.accentN}`, `${afterAll.accentOk}/${afterAll.accentN}`)}  empty ${cellDelta(String(beforeAll.empty), String(afterAll.empty))}`);
  }
  const repeats = opts.runs.filter((r) => r.repeat > 0);
  if (repeats.length > 0) {
    const byId = new Map<string, SiteRun[]>();
    for (const run of opts.runs) {
      const list = byId.get(run.site.id) ?? [];
      list.push(run);
      byId.set(run.site.id, list);
    }
    const shaky: string[] = [];
    for (const [id, list] of byId) {
      const site = list[0]?.site;
      if (site?.set === 'holdout' && !opts.showHoldout) continue;
      const cores = new Set(list.map((r) => r.score.core));
      const empties = new Set(list.map((r) => String(r.score.empty)));
      if (cores.size > 1 || empties.size > 1) shaky.push(`${id} core=${[...cores].join('/')} empty=${[...empties].join('/')}`);
    }
    lines.push('');
    lines.push(shaky.length === 0 ? 'shake  none' : `shake  ${shaky.join(' · ')}`);
  }
  lines.push('');
  lines.push('sites  (dev failures; holdout hidden unless --show-holdout)');
  for (const run of first) {
    const failed = !runOk(run) || run.score.empty === true || !run.score.accentOk || (run.score.contrast !== null && run.score.contrast < 4.5);
    if (!failed) continue;
    if (run.site.set === 'holdout' && !opts.showHoldout) continue;
    const bits = [
      run.site.set,
      run.site.category,
      run.site.id,
      `core=${run.score.core}`,
      run.score.contrast === null ? 'contrast=—' : `contrast=${run.score.contrast.toFixed(2)}`,
      `accent=${run.score.accentOk ? 'ok' : 'no'}`,
      run.score.painted === null ? 'painted=?' : `painted=${run.score.painted}`,
      run.score.empty === true ? 'EMPTY' : run.score.empty === null ? 'paint=unknown' : '',
      run.error ? `err=${run.error}` : '',
    ].filter(Boolean);
    lines.push(bits.join('  '));
  }
  return `${lines.join('\n')}\n`;
}

export function renderIndex(runs: readonly SiteRun[]): string {
  const header = 'set\tcategory\tid\turl\trepeat\tsec\tok\tcore\tcontrast\taccentOk\tpainted\tempty\terror';
  const body = runs.map((r) => [
    r.site.set,
    r.site.category,
    r.site.id,
    r.site.url,
    String(r.repeat),
    r.sec.toFixed(3),
    runOk(r) ? '1' : '0',
    String(r.score.core),
    r.score.contrast === null ? '' : r.score.contrast.toFixed(3),
    r.score.accentOk ? '1' : '0',
    r.score.painted === null ? '' : String(r.score.painted),
    r.score.empty === true ? '1' : r.score.empty === false ? '0' : '',
    r.error ?? '',
  ].join('\t'));
  return `${header}\n${body.join('\n')}\n`;
}

export async function runBench(opts: BenchOptions): Promise<BenchResult> {
  const corpusText = readFileSync(opts.corpusPath, 'utf8');
  let sites = parseCorpus(corpusText);
  if (opts.only) sites = sites.filter((s) => s.set === opts.only);
  const stamp: BenchStamp = {
    commit: opts.commit ?? gitHead(opts.repoRoot),
    date: (opts.now ?? new Date()).toISOString(),
    corpusSha: sha256(corpusText),
    corpus: opts.corpusPath,
  };
  mkdirSync(opts.outDir, { recursive: true });
  const universe = join(opts.outDir, 'universe');
  mkdirSync(universe, { recursive: true });
  const runner = opts.runSite ?? runIsolatedFromUrl;
  const runs: SiteRun[] = [];
  const repeat = Math.max(1, opts.repeat);
  for (const site of sites) {
    for (let i = 0; i < repeat; i++) {
      let captured: Awaited<ReturnType<SiteRunner>>;
      try {
        captured = await runner(site, { outDir: opts.outDir, universe, repoRoot: opts.repoRoot });
      } catch (e) {
        captured = { sec: 0, fromUrl: {}, tokensJson: null, error: e instanceof Error ? e.message : String(e) };
      }
      const score = scoreSite({
        tokensCss: captured.fromUrl.tokensCss ?? '',
        tokensJson: captured.tokensJson,
      });
      const saved = captured.fromUrl.saved;
      const savedOk = fromUrlSaved(captured.fromUrl);
      const run: SiteRun = {
        site,
        repeat: i,
        sec: captured.sec,
        okRun: !captured.error && savedOk,
        error: captured.error ?? (saved === false ? 'saved=false' : undefined),
        score,
        reportedId: fromUrlId(captured.fromUrl, site.id),
        saved,
        provenance: provenanceNote(captured.fromUrl),
        fromUrl: captured.fromUrl,
      };
      runs.push(run);
      writeFileSync(join(opts.outDir, `${site.id}.json`), `${JSON.stringify(run, null, 2)}\n`);
    }
  }
  const compare = opts.compareDir ? loadCompare(opts.compareDir) : undefined;
  const human = renderHuman({ stamp, runs, showHoldout: opts.showHoldout, compare });
  const indexTsv = renderIndex(runs);
  writeFileSync(join(opts.outDir, 'STAMP'), `commit=${stamp.commit}\ndate=${stamp.date}\ncorpusSha=${stamp.corpusSha}\ncorpus=${stamp.corpus}\n`);
  writeFileSync(join(opts.outDir, 'index.tsv'), indexTsv);
  writeFileSync(join(opts.outDir, 'runs.json'), `${JSON.stringify({ stamp, runs }, null, 2)}\n`);
  writeFileSync(join(opts.outDir, 'report.txt'), human);
  return { stamp, runs, human, indexTsv };
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  return argv[i + 1];
}

export function optionsFromArgv(argv: readonly string[], repoRoot: string): BenchOptions {
  const onlyRaw = argValue(argv, '--only');
  const only = onlyRaw === 'dev' || onlyRaw === 'holdout' ? onlyRaw : undefined;
  const repeatRaw = Number(argValue(argv, '--repeat') ?? '1');
  return {
    corpusPath: resolve(repoRoot, argValue(argv, '--corpus') ?? DEFAULT_CORPUS),
    outDir: resolve(repoRoot, argValue(argv, '--out') ?? 'docs/design/corpus/out'),
    only,
    repeat: Number.isFinite(repeatRaw) && repeatRaw > 0 ? Math.floor(repeatRaw) : 1,
    compareDir: argValue(argv, '--compare') ? resolve(repoRoot, argValue(argv, '--compare')!) : undefined,
    json: argv.includes('--json'),
    showHoldout: argv.includes('--show-holdout'),
    repoRoot,
  };
}

async function main(): Promise<number> {
  const repoRoot = resolve(import.meta.dir, '../..');
  const opts = optionsFromArgv(process.argv.slice(2), repoRoot);
  const result = await runBench(opts);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ stamp: result.stamp, runs: result.runs }, null, 2)}\n`);
  } else {
    process.stdout.write(result.human);
  }
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
