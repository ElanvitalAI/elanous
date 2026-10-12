/**
 * Measures the changed-file gate against the whole program on recently merged PRs.
 * The narrowed run is the gate's default root check (changed .ts ∪ direct importers), so `missed` / `same` judge that mode:
 * the run pins TSC_GATE_ROOTS to a non-`full` value and disables the rollback switch
 * even when the caller's shell requests a full run.
 * `missed > 0` is reverted without a code change by running the gate with env `TSC_GATE_ROOTS=full`.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { debug } from '../src/debug/log.js';
import { parseTypecheckErrors, tscEnv } from '../src/typecheck-ratchet.js';
import { compareDiagnostics, normalizeDiagnostics, type NormalizedDiagnostic } from './tsc-baseline-comparison.js';

export interface CommandResult {
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
  durationMs: number;
}
export type Runner = (command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<CommandResult>;
export interface Metrics { durationMs: number | null; rssMb: number | null; }
export interface PrMeasurement {
  pr: number;
  head: string;
  base: string;
  verdict: 'missed' | 'same' | 'stricter' | 'unmeasured';
  missedDiagnostics: NormalizedDiagnostic[];
  addedDiagnostics: NormalizedDiagnostic[];
  fullBase: Metrics;
  fullHead: Metrics;
  narrowed: Metrics;
  gateExitCode: number | null;
  reason?: string;
  worktree: string;
}
export interface MeasurementReport {
  prs: PrMeasurement[];
  summary: { missed: number; same: number; stricter: number; unmeasured: number; of: number };
  exitCode: number;
}
export interface Options { run?: Runner; platform?: NodeJS.Platform; makeTemp?: () => string; removeTemp?: (path: string) => void; }
interface Pr { number: number; mergeCommit: { oid: string } | null; files: { path: string }[]; mergedAt?: string; changedFiles?: number; }
const emptyMetrics = (): Metrics => ({ durationMs: null, rssMb: null });
const hash = (text: string): boolean => /^[0-9a-f]{40}$/i.test(text);
const reason = (result: CommandResult): string => result.error?.message ?? (result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);

export const spawnRunner: Runner = (command, args, cwd, extraEnv) => new Promise((done) => {
  const started = performance.now();
  const env = tscEnv({ ...process.env, ...extraEnv });
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  let child;
  try { child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (cause) {
    done({ status: null, stdout: '', stderr: '', error: cause instanceof Error ? cause : new Error(String(cause)), durationMs: performance.now() - started });
    return;
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  let error: Error | undefined;
  child.on('error', (cause: Error) => { error = cause; });
  child.on('close', (status, signal) => done({ status, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), error, durationMs: performance.now() - started }));
});

export function parseRss(output: string, platform: NodeJS.Platform): number | null {
  const mac = output.match(/^\s*(\d+)\s+maximum resident set size\s*$/im);
  const linux = output.match(/^\s*Maximum resident set size \(kbytes\):\s*(\d+)\s*$/im);
  const value = platform === 'darwin' ? mac : platform === 'linux' ? linux : null;
  if (!value) return null;
  const bytes = Number(value[1]) * (platform === 'linux' ? 1024 : 1);
  return Number.isSafeInteger(bytes) ? bytes / 1048576 : null;
}

function optionsFromArgs(argv: readonly string[]): { numbers: number[] | null; recent: number; keep: boolean } {
  let numbers: number[] | null = null;
  let recent = 10;
  let explicitRecent = false;
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--prs' || arg === '--recent') {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--prs') {
        if (numbers || explicitRecent || !/^\d+(,\d+)*$/.test(value)) throw new Error('invalid --prs list');
        numbers = value.split(',').map(Number);
        if (numbers.some((n) => !Number.isSafeInteger(n) || n < 1) || new Set(numbers).size !== numbers.length) throw new Error('invalid --prs list');
      } else {
        if (numbers || explicitRecent || !/^\d+$/.test(value)) throw new Error('invalid --recent count');
        recent = Number(value);
        if (!Number.isSafeInteger(recent) || recent < 1) throw new Error('invalid --recent count');
        explicitRecent = true;
      }
    } else if (arg === '--json') continue;
    else if (arg === '--keep') keep = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return { numbers, recent, keep };
}

async function required(run: Runner, command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  const result = await run(command, args, cwd, env);
  if (result.error || result.signal || result.status !== 0) throw new Error(`${command} ${args.join(' ')}: ${reason(result)}`);
  return result;
}
function parsePr(value: unknown): Pr {
  if (!value || typeof value !== 'object') throw new Error('invalid PR response');
  const pr = value as Pr;
  if (!Number.isSafeInteger(pr.number) || pr.number < 1 || !pr.mergeCommit || !hash(pr.mergeCommit.oid) || !Array.isArray(pr.files) || !pr.files.every((file) => typeof file?.path === 'string')) throw new Error(`invalid merged PR response: ${JSON.stringify(value)}`);
  return pr;
}
const typeScriptFile = (path: string): boolean => /\.[cm]?tsx?$/.test(path);
/** The list API truncates `files`; when the listed files are fewer than `changedFiles`, read the full paginated list. */
async function touchesTypeScript(run: Runner, repo: string, pr: Pr): Promise<boolean> {
  if (pr.files.some((file) => typeScriptFile(file.path))) return true;
  if (typeof pr.changedFiles === 'number' && pr.changedFiles <= pr.files.length) return false;
  const all = (await required(run, 'gh', ['api', '--paginate', `repos/{owner}/{repo}/pulls/${pr.number}/files`, '--jq', '.[].filename'], repo)).stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  if (typeof pr.changedFiles === 'number' && all.length < pr.changedFiles) throw new Error(`PR #${pr.number}: file list incomplete (${all.length} of ${pr.changedFiles})`);
  return all.some(typeScriptFile);
}
async function selectPrs(repo: string, opts: ReturnType<typeof optionsFromArgs>, run: Runner): Promise<Pr[]> {
  if (opts.numbers) {
    const prs: Pr[] = [];
    for (const n of opts.numbers) {
      const pr = parsePr(JSON.parse((await required(run, 'gh', ['pr', 'view', String(n), '--json', 'number,mergeCommit,files'], repo)).stdout));
      if (pr.number !== n) throw new Error(`requested PR #${n} but received #${pr.number}`);
      prs.push(pr);
    }
    return prs;
  }
  let limit = Math.max(100, opts.recent);
  let previousCount = -1;
  for (;;) {
    const result = await required(run, 'gh', ['pr', 'list', '--state', 'merged', '--base', 'main', '--search', 'sort:merged-desc', '--limit', String(limit), '--json', 'number,mergeCommit,files,mergedAt,changedFiles'], repo);
    const raw: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(raw)) throw new Error('invalid merged PR list');
    if (raw.some((item) => typeof item?.mergedAt !== 'string')) throw new Error('merged PR list has no merge dates');
    const prs: Pr[] = [];
    for (const pr of raw.map(parsePr)) if (await touchesTypeScript(run, repo, pr)) prs.push(pr);
    if (prs.length >= opts.recent || raw.length < limit || raw.length === previousCount) return prs.sort((a, b) => b.mergedAt!.localeCompare(a.mergedAt!)).slice(0, opts.recent);
    previousCount = raw.length;
    limit += 100;
  }
}

function elapsed(result: CommandResult, platform: NodeJS.Platform): Metrics {
  return { durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null, rssMb: parseRss(result.stderr, platform) };
}
function checked(result: CommandResult, label: string, output: string): void {
  if (result.error || result.signal || ![0, 1, 2].includes(result.status ?? -1) || /error TS(?:2688|5083|6053)\b|heap out of memory|Ineffective mark-compacts near heap limit/i.test(output)) throw new Error(`${label}: tsc not measured: ${reason(result)}`);
  const diagnostics = parseTypecheckErrors(output);
  if (result.status !== 0 && diagnostics.length === 0) throw new Error(`${label}: nonzero exit without parseable diagnostics: ${reason(result)}`);
  if ((/error TS\d+/.test(output) && diagnostics.length === 0) || (result.status === 0 && diagnostics.length > 0 && label === 'full')) throw new Error(`${label}: inconsistent tsc diagnostics and exit status`);
}
function fullDiagnostics(result: CommandResult, root: string): NormalizedDiagnostic[] {
  const output = `${result.stdout}\n${result.stderr}`;
  checked(result, 'full', output);
  return normalizeDiagnostics(parseTypecheckErrors(output), root);
}
function gateDiagnostics(result: CommandResult, root: string): NormalizedDiagnostic[] {
  const output = `${result.stdout}\n${result.stderr}`;
  const diagnosticOutput = output.split('\n').map((line) => line.replace(/^  /, '')).join('\n');
  checked(result, 'narrowed', diagnosticOutput);
  if (/tsc 를 «못 쟀다»|tsc 가 정상 실행됐음을 확인할 수 없다|변경 파일 없음|변경 파일 수집 실패/i.test(output)
    || (result.status === 0 && !/\[tsc-gate\] PASS —/.test(output))
    || (result.status !== 0 && !/\[tsc-gate\] FAIL —/.test(output))) throw new Error('narrowed gate did not measure tsc');
  return normalizeDiagnostics(parseTypecheckErrors(diagnosticOutput), root);
}
async function timed(run: Runner, platform: NodeJS.Platform, command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  if (platform === 'darwin' || platform === 'linux') return run('/usr/bin/time', [platform === 'darwin' ? '-l' : '-v', command, ...args], cwd, env);
  return run(command, args, cwd, env);
}

/**
 * The pre-merge base of the whole PR. Merge commit → first parent. Single-parent merge commit: the PR's complete
 * commit count comes from REST (`pulls/N .commits`) for every PR — never from the possibly truncated listed commits.
 * One commit → `head^1`. k > 1 commits → squash (one commit on main) or rebase-merge (k rewritten commits); the
 * method is decided by GitHub's commit↔PR association of `head~1 … head~(k-1)` (all ours → rebase → `head~k`,
 * none ours → squash → `head^1`), never by commit subjects. Anything else is ambiguous and the PR is unmeasured,
 * so an error introduced by an earlier rebased commit is never hidden behind a wrong baseline.
 */
async function preMergeRevision(run: Runner, repo: string, pr: Pr, head: string): Promise<string> {
  const parents = (await required(run, 'git', ['rev-list', '--parents', '-n', '1', head], repo)).stdout.trim().split(/\s+/).filter(Boolean);
  if (parents.length > 2) return `${head}^1`;
  const totalText = (await required(run, 'gh', ['api', `repos/{owner}/{repo}/pulls/${pr.number}`, '--jq', '.commits'], repo)).stdout.trim();
  const total = Number(totalText);
  if (!/^\d+$/.test(totalText) || !Number.isSafeInteger(total) || total < 1) throw new Error(`PR #${pr.number}: commit count unreadable (${totalText || 'empty'}) — pre-merge base not determinable`);
  if (total === 1) return `${head}^1`;
  const ours: boolean[] = [];
  for (let back = 1; back < total; back += 1) {
    const sha = (await required(run, 'git', ['rev-parse', `${head}~${back}`], repo)).stdout.trim();
    if (!hash(sha)) throw new Error(`PR #${pr.number}: ${head}~${back} unresolvable — pre-merge base not determinable`);
    const numbers = (await required(run, 'gh', ['api', `repos/{owner}/{repo}/commits/${sha}/pulls`, '--jq', '.[].number'], repo)).stdout.split(/\s+/).filter(Boolean);
    ours.push(numbers.includes(String(pr.number)));
  }
  if (ours.every(Boolean)) return `${head}~${total}`;
  if (ours.every((owned) => !owned)) return `${head}^1`;
  throw new Error(`PR #${pr.number}: merge method ambiguous (${ours.filter(Boolean).length}/${ours.length} of the preceding commits belong to the PR) — pre-merge base not determinable`);
}

async function measurePr(repo: string, pr: Pr, run: Runner, platform: NodeJS.Platform, keep: boolean, makeTemp: () => string, removeTemp: (path: string) => void): Promise<PrMeasurement> {
  const head = pr.mergeCommit!.oid;
  const workspace = makeTemp();
  const worktree = join(workspace, 'pr');
  const result: PrMeasurement = { pr: pr.number, head, base: '', worktree, verdict: 'unmeasured', missedDiagnostics: [], addedDiagnostics: [], fullBase: emptyMetrics(), fullHead: emptyMetrics(), narrowed: emptyMetrics(), gateExitCode: null };
  let attempted = false;
  try {
    const base = (await required(run, 'git', ['rev-parse', await preMergeRevision(run, repo, pr, head)], repo)).stdout.trim();
    if (!hash(base)) throw new Error(`invalid first parent of ${head}: ${base}`);
    result.base = base;
    attempted = true;
    await required(run, 'git', ['worktree', 'add', '--detach', worktree, head], repo);
    await required(run, 'git', ['checkout', '--detach', base], worktree);
    await required(run, 'bun', ['install', '--frozen-lockfile'], worktree);
    const baseRun = await timed(run, platform, './node_modules/.bin/tsc', ['--noEmit', '-p', 'tsconfig.gate.json'], worktree);
    result.fullBase = elapsed(baseRun, platform);
    const baseline = fullDiagnostics(baseRun, worktree);
    await required(run, 'git', ['checkout', '--detach', head], worktree);
    await required(run, 'bun', ['install', '--frozen-lockfile'], worktree);
    const headRun = await timed(run, platform, './node_modules/.bin/tsc', ['--noEmit', '-p', 'tsconfig.gate.json'], worktree);
    result.fullHead = elapsed(headRun, platform);
    const current = fullDiagnostics(headRun, worktree);
    const added = compareDiagnostics(current, baseline);
    if (added.kind === 'unavailable') throw new Error(added.reason);
    result.addedDiagnostics = added.added;
    const gateRun = await timed(run, platform, 'bun', ['scripts/ci-typecheck-changed.ts', '--local'], worktree, {
      ...process.env, TSC_BASE_REF: base, TSC_GATE_ROOTS: 'affected', ELANOUS_TSC_AFFECTED_ROOTS: '1',
    });
    result.narrowed = elapsed(gateRun, platform);
    result.gateExitCode = gateRun.status;
    const seen = gateDiagnostics(gateRun, worktree);
    const unseen = compareDiagnostics(added.added, seen);
    result.missedDiagnostics = unseen.kind === 'added' ? unseen.added : [];
    result.verdict = added.added.length > 0
      ? gateRun.status === 0 || result.missedDiagnostics.length > 0 ? 'missed' : 'same'
      : gateRun.status === 0 ? 'same' : 'stricter';
  } catch (error) {
    result.reason = error instanceof Error ? error.message : String(error);
    result.verdict = 'unmeasured';
  } finally {
    if (!keep) {
      try {
        if (attempted) {
          const removed = await run('git', ['worktree', 'remove', '--force', worktree], repo);
          if (removed.error || removed.signal || (removed.status !== 0 && !/is not a working tree|is not a worktree/i.test(removed.stderr))) throw new Error(`git worktree remove: ${reason(removed)}`);
        }
      } catch (error) {
        if (result.verdict !== 'missed') result.verdict = 'unmeasured';
        result.reason = `${result.reason ? `${result.reason}; ` : ''}cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      try { removeTemp(workspace); }
      catch (error) {
        if (result.verdict !== 'missed') result.verdict = 'unmeasured';
        result.reason = `${result.reason ? `${result.reason}; ` : ''}workspace cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    debug.log('tsc.affected-roots', 'measure-pr', { pr: result.pr, head, base: result.base, verdict: result.verdict, missedDiagnostics: result.missedDiagnostics.length, fullBase: result.fullBase, fullHead: result.fullHead, narrowed: result.narrowed, reason: result.reason });
  }
  return result;
}

export async function measureAffectedRoots(repo: string, argv: readonly string[] = [], options: Options = {}): Promise<MeasurementReport> {
  const opts = optionsFromArgs(argv);
  const run = options.run ?? spawnRunner;
  const prs = await selectPrs(repo, opts, run);
  if (prs.length === 0) throw new Error('no merged TypeScript PRs to measure');
  const rows: PrMeasurement[] = [];
  for (const pr of prs) rows.push(await measurePr(repo, pr, run, options.platform ?? process.platform, opts.keep, options.makeTemp ?? (() => mkdtempSync(join(tmpdir(), 'tsc-affected-roots-'))), options.removeTemp ?? ((path) => rmSync(path, { recursive: true, force: true }))));
  const summary = { missed: rows.filter((row) => row.verdict === 'missed').length, same: rows.filter((row) => row.verdict === 'same').length, stricter: rows.filter((row) => row.verdict === 'stricter').length, unmeasured: rows.filter((row) => row.verdict === 'unmeasured').length, of: rows.length };
  return { prs: rows, summary, exitCode: summary.missed ? 1 : summary.unmeasured ? 2 : 0 };
}
export function formatReport(report: MeasurementReport, json = false): string {
  if (json) return JSON.stringify(report);
  const metric = (m: Metrics) => `${m.durationMs === null ? '—' : Math.round(m.durationMs)} / ${m.rssMb === null ? '—' : m.rssMb}`;
  return [
    'PR | verdict | missed diagnostics | full base ms/RSS MB | full head ms/RSS MB | narrowed ms/RSS MB',
    ...report.prs.map((row) => `#${row.pr} | ${row.verdict} | ${row.missedDiagnostics.length} | ${metric(row.fullBase)} | ${metric(row.fullHead)} | ${metric(row.narrowed)}${row.reason ? ` | ${row.reason}` : ''}`),
    `missed=${report.summary.missed} same=${report.summary.same} stricter=${report.summary.stricter} unmeasured=${report.summary.unmeasured} of ${report.summary.of}`,
  ].join('\n');
}
if (import.meta.main) {
  try {
    const argv = process.argv.slice(2);
    const report = await measureAffectedRoots(resolve(process.cwd()), argv);
    console.log(formatReport(report, argv.includes('--json')));
    process.exitCode = report.exitCode;
  } catch (error) {
    console.error(`tsc affected roots measurement unavailable: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
