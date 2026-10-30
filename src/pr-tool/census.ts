/** Shared PR inventory and creation guard for the CLI and harness. All incomplete reads stay unknown. */
import { debug } from '../debug/log.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { withFileLockSync } from '../storage/file-lock.js';
import { resolveHostId } from '../platform/host-id.js';
import { spawnSync } from 'node:child_process';

export interface PrToolCommandResult { ok: boolean; out: string; err?: string }
export type PrToolCommand = (command: string, args: readonly string[], opts?: { cwd?: string }) => PrToolCommandResult;
export interface PrToolCall { command: string; args: readonly string[]; opts?: { cwd?: string } }
/** PR-CENSUS-PARALLEL: run every call with at most `concurrency` in flight; results stay in input order. */
export type PrToolParallelCommand = (calls: readonly PrToolCall[], concurrency: number) => PrToolCommandResult[];
export type Seat = 'OP' | 'TC' | 'MK' | 'UX';
export interface OpenPr {
  number: number;
  headRefName?: string;
  title: string;
  draft: boolean;
  updatedAt: string;
  headSha: string;
  labels: readonly string[];
  files: readonly string[];
  seat: Seat | null;
  lastCommitAt?: string;
  cellId: string | null;
  cardId?: string | null;
  cardMarkerPresent?: boolean;
  /** «조각 i/N — 부모 <칸>» 표지가 있으면 그 조각 번호(없으면 null) — sibling-slice 판정용. */
  slice?: { slice: number; total: number } | null;
  hunks?: readonly DiffHunk[];
}
export type Inventory = { status: 'checked'; prs: readonly OpenPr[] } | { status: 'unknown'; reason: string };
export interface CensusRow { seat: Seat | 'unknown'; open: number; goalOnly: number; staleDraft: number; supersededOpen: number }
export type Census = { status: 'checked'; total: number; rows: readonly CensusRow[]; closeCandidates: readonly { number: number; reason: 'goal-only' | 'stale-draft' | 'superseded-open' }[] }
  | { status: 'unknown'; reason: string };
export interface DiffHunk { path: string; start: number; end: number }
export type GuardCode = 'inventory-unknown' | 'candidate-unknown' | 'goal-only' | 'file-overlap' | 'hunk-overlap' | 'same-cell' | 'seat-cap' | 'seat-unattributed';
export interface GuardReason { code: GuardCode; detail: string; prs?: readonly number[]; files?: readonly string[] }
/** PR-GUARD-HUNK-WARN (대표 10-17): 줄 겹침은 기본 경고 — 착지 쪽 스마트 머지가 푼다. 'refuse' = 옛 거부 동작. */
export type HunkOverlapMode = 'refuse' | 'warn';
export interface GuardVerdict { status: 'allow' | 'refuse' | 'unknown'; reasons: readonly GuardReason[]; warnings: readonly GuardReason[];
  sameCellConflicts?: readonly { pr: number; branch: string | null; headSha: string; cardId: string | null; slice?: { slice: number; total: number } | null }[];
  sameCellReuse?: { number: number; branch: string; headSha: string; cellId: string; cardId: string; legacyBound?: true } }

const SEATS = ['OP', 'TC', 'MK', 'UX'] as const;
const DEFAULT_SEAT_CAP = 30;
const DRAFT_STALE_MS = 2 * 24 * 60 * 60 * 1000;
const MAX_PAGES = 100;
const MAX_FILES = 3000; // GitHub does not expose more than 3000 PR files.
const UNMEASURED_WINDOW_MS = 60 * 60 * 1000;
const UNMEASURED_ALLOW_COUNT = 3;

export const DEFAULT_DIFF_CONCURRENCY = 6;
const DIFF_CACHE_MAX = 2000;
const DIFF_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const DIFF_CACHE_ENTRY_MAX_BYTES = 4 * 1024 * 1024;
const PARALLEL_CALL_TIMEOUT_MS = 120_000;
/** Whole pool ceiling, independent of the call count — a stuck pool fails (inventory unknown) instead of hanging the guard. */
const PARALLEL_POOL_TIMEOUT_MS = 10 * 60 * 1000;
const PARALLEL_MAX_BUFFER = 256 * 1024 * 1024;

/** `gh pr diff` patches keyed by PR number ⊕ head sha. A head sha fixes the diff, so a retry or a second guard
 *  call in the same process never refetches it. Bounded by entry count and total bytes (the oldest entry leaves
 *  first); a single patch above the per-entry limit is not cached at all. */
export class CensusDiffCache {
  private readonly entries = new Map<string, { patch: string; bytes: number }>();
  private totalBytes = 0;
  constructor(private readonly max = DIFF_CACHE_MAX, private readonly maxBytes = DIFF_CACHE_MAX_BYTES,
    private readonly entryMaxBytes = DIFF_CACHE_ENTRY_MAX_BYTES) {}
  private key(number: number, headSha: string): string { return `${number}@${headSha}`; }
  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.totalBytes -= entry.bytes;
    this.entries.delete(key);
  }
  get(number: number, headSha: string): string | undefined { return this.entries.get(this.key(number, headSha))?.patch; }
  set(number: number, headSha: string, patch: string): void {
    const key = this.key(number, headSha);
    this.drop(key);
    const bytes = Buffer.byteLength(patch, 'utf8');
    if (bytes > this.entryMaxBytes || bytes > this.maxBytes) return;
    while (this.entries.size > 0 && (this.entries.size >= this.max || this.totalBytes + bytes > this.maxBytes)) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    this.entries.set(key, { patch, bytes });
    this.totalBytes += bytes;
  }
  get size(): number { return this.entries.size; }
  get bytes(): number { return this.totalBytes; }
  clear(): void { this.entries.clear(); this.totalBytes = 0; }
}
/** Process-lifetime cache for production callers (PR creation guard · `pr open-guard`). Tests pass their own. */
export const sharedCensusDiffCache = new CensusDiffCache();
export function resetCensusDiffCache(): void { sharedCensusDiffCache.clear(); }

// Runs inside a child `bun`/`node` so the synchronous inventory API can still fan out. stdin: { calls, concurrency,
// timeoutMs } · stdout: one result per call, input order. Each call runs in its own process group (detached) so a
// per-call timeout, or this pool ending on SIGTERM/SIGINT/SIGHUP from the outer ceiling, kills the whole group —
// no `gh` (or its children) outlives the pool.
const PARALLEL_SCRIPT = `
const { spawn } = require('node:child_process');
const live = new Set();
const killGroup = pid => { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } };
const killAll = () => { for (const pid of live) killGroup(pid); live.clear(); };
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { killAll(); process.exit(124); });
process.on('exit', killAll);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const { calls, concurrency, timeoutMs } = JSON.parse(input);
  const results = new Array(calls.length);
  let next = 0;
  const one = index => new Promise(resolve => {
    const call = calls[index];
    const out = []; const err = [];
    let settled = false; let timedOut = false; let timer;
    let child;
    const finish = result => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (child && child.pid) { killGroup(child.pid); live.delete(child.pid); }
      results[index] = result; resolve();
    };
    try { child = spawn(call.command, call.args, { cwd: call.cwd || undefined, stdio: ['ignore', 'pipe', 'pipe'], detached: true }); }
    catch (error) { results[index] = { ok: false, out: '', err: String(error && error.message || error) }; resolve(); return; }
    if (child.pid) live.add(child.pid);
    timer = setTimeout(() => { timedOut = true; if (child.pid) killGroup(child.pid); }, timeoutMs);
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', error => finish({ ok: false, out: '', err: String(error && error.message || error) }));
    child.on('close', (code, signal) => finish({ ok: code === 0 && !signal && !timedOut, out: Buffer.concat(out).toString('utf8').trim(),
      err: [Buffer.concat(err).toString('utf8').trim(), timedOut ? 'timed out after ' + timeoutMs + 'ms' : signal ? 'terminated by ' + signal : ''].filter(Boolean).join('\\n') }));
  });
  const worker = async () => { while (next < calls.length) { const index = next++; await one(index); } };
  Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, calls.length)) }, worker))
    .then(() => process.stdout.write(JSON.stringify(results)));
});
`;

/** Real-spawn {@link PrToolParallelCommand}: one child runtime fans out the calls with a bounded pool. Any failure of
 *  the pool itself (including the fixed pool ceiling) returns every call as failed, so the caller's conservative
 *  unknown rule applies. `timeoutMs` = per call · `poolTimeoutMs` = whole pool (tests inject short values). */
export function spawnParallelCommands(calls: readonly PrToolCall[], options: { concurrency?: number; env?: NodeJS.ProcessEnv; timeoutMs?: number; poolTimeoutMs?: number } = {}): PrToolCommandResult[] {
  if (calls.length === 0) return [];
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_DIFF_CONCURRENCY));
  const timeoutMs = options.timeoutMs ?? PARALLEL_CALL_TIMEOUT_MS;
  const failAll = (err: string) => calls.map(() => ({ ok: false, out: '', err }));
  try {
    const r = spawnSync(process.execPath, ['-e', PARALLEL_SCRIPT], {
      input: JSON.stringify({ calls: calls.map(call => ({ command: call.command, args: [...call.args], cwd: call.opts?.cwd })), concurrency, timeoutMs }),
      encoding: 'utf-8', maxBuffer: PARALLEL_MAX_BUFFER, timeout: options.poolTimeoutMs ?? PARALLEL_POOL_TIMEOUT_MS, killSignal: 'SIGTERM',
      ...(options.env ? { env: options.env } : {}),
    });
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS') return failAll('parallel output exceeded 256MiB (ENOBUFS)');
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || r.signal) return failAll(`parallel runner timed out or was killed (${r.signal ?? 'ETIMEDOUT'})`);
    if (r.status !== 0) return failAll(`parallel runner rc=${r.status}: ${(r.stderr ?? '').trim().slice(0, 300)}`);
    const parsed: unknown = JSON.parse(r.stdout ?? '');
    if (!Array.isArray(parsed) || parsed.length !== calls.length) return failAll('parallel runner result shape mismatch');
    return parsed.map(row => {
      const value = row as { ok?: unknown; out?: unknown; err?: unknown } | null;
      return value && typeof value.ok === 'boolean' && typeof value.out === 'string'
        ? { ok: value.ok, out: value.out, err: typeof value.err === 'string' ? value.err : '' }
        : { ok: false, out: '', err: 'parallel runner row missing' };
    });
  } catch (error) {
    return failAll(`parallel runner: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function unknown(reason: string): Inventory { return { status: 'unknown', reason }; }
function seatValue(value: unknown): Seat | null { return SEATS.find(seat => seat === value) ?? null; }
function seatFromLabels(labels: readonly string[]): Seat | null {
  return SEATS.find(seat => labels.includes(`seat:${seat}`)) ?? null;
}
export function cellIdFromBody(body: string): string | null {
  return /^\s*(?:[-*]\s*)?칸\s*:\s*([A-Z][A-Z0-9-]{2,})\s*$/m.exec(body)?.[1] ?? null;
}
export function cardIdFromBody(body: string): string | null {
  const ids = [...body.matchAll(/^\s*(?:[-*]\s*)?카드\s*:\s*([^\r\n]*)$/gm)].map(match => match[1]!.trim());
  return ids.length > 0 && ids.every(id => /^[A-Za-z0-9][A-Za-z0-9._:-]{2,}$/.test(id) && id === ids[0]) ? ids[0]! : null;
}
export function hasCardMarker(body: string): boolean {
  return /^\s*(?:[-*]\s*)?카드\s*:/m.test(body);
}
/** 골/PR 본문의 «조각 i/N — 부모 <칸>» 표지 → {slice,total}. 표지 없으면 null, 1≤i≤N 아니면 null. */
export function sliceMarkerFromBody(body: string): { slice: number; total: number } | null {
  const m = /^\s*(?:[-*]\s*)?(?:«\s*)?조각\s*(\d+)\s*\/\s*(\d+)\s*(?:»)?\s*—\s*부모\s+\S[^\r\n]*$/m.exec(body);
  if (!m) return null;
  const slice = Number(m[1]);
  const total = Number(m[2]);
  return Number.isSafeInteger(slice) && Number.isSafeInteger(total) && slice >= 1 && total >= 1 && slice <= total
    ? { slice, total } : null;
}

export function parseDiffHunks(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let path: string | null = null;
  let fileHeaderPending = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) { path = null; fileHeaderPending = true; continue; }
    if (fileHeaderPending && line.startsWith('--- ')) {
      if (line.startsWith('--- a/')) path = line.slice('--- a/'.length);
      continue;
    }
    if (fileHeaderPending && line.startsWith('+++ ')) {
      if (line.startsWith('+++ b/')) path = line.slice('+++ b/'.length);
      fileHeaderPending = false;
      continue;
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (path && match) {
      // This is an approximate comparison of old-side lines; PRs with different
      // base trees can shift line numbers. The full merge gate remains authoritative.
      // An insertion or new file has no old-side lines: use its insertion anchor.
      const oldStart = Number(match[1]);
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      const start = oldCount === 0 && oldStart === 0 ? Number(match[3]) : oldStart;
      const count = oldCount === 0 ? 1 : oldCount;
      hunks.push({ path, start, end: start + Math.max(1, count) - 1 });
    }
  }
  return hunks;
}

/** `gh api --paginate --slurp` must return every REST page, including the last page. */
function pagesArgs(endpoint: string): string[] { return ['api', '--paginate', '--slurp', endpoint]; }
function parsePages(result: PrToolCommandResult, endpoint: string): readonly unknown[] {
  if (!result.ok) throw new Error(`gh api ${endpoint}: ${result.err || result.out || '조회 실패'}`);
  let parsed: unknown;
  try { parsed = JSON.parse(result.out); } catch { throw new Error(`gh api ${endpoint}: JSON 오류`); }
  if (!Array.isArray(parsed) || parsed.length >= MAX_PAGES || !parsed.every(page => Array.isArray(page) && page.length <= 100)) {
    throw new Error(`gh api ${endpoint}: 페이지 형식·상한 판정 불가`);
  }
  return parsed.flat();
}
function pages(run: PrToolCommand, endpoint: string, cwd?: string): readonly unknown[] {
  return parsePages(run('gh', pagesArgs(endpoint), cwd ? { cwd } : undefined), endpoint);
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('PR 응답 행 형식 오류');
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 누락`);
  return value;
}
function date(value: unknown, name: string): string {
  const raw = text(value, name);
  if (!Number.isFinite(Date.parse(raw))) throw new Error(`${name} 날짜 오류`);
  return raw;
}
function filesEndpoint(number: number): string { return `repos/{owner}/{repo}/pulls/${number}/files?per_page=100`; }
function pathsFromFilesResult(result: PrToolCommandResult, number: number): string[] {
  const rows = parsePages(result, filesEndpoint(number));
  if (rows.length >= MAX_FILES) throw new Error(`PR #${number}: 파일 ${MAX_FILES}개 GitHub 상한에 닿음`);
  return rows.map(row => text(object(row).filename, `PR #${number} 파일명`));
}

interface FileProjection {
  files: Map<number, string[]>;
  /** Set when the one-shot list produced nothing usable — every PR then takes the REST file fallback. */
  failure?: string;
  /** Rows the projection could not vouch for (malformed · file list shorter than changedFiles, e.g. >100 files). */
  skipped: number;
}

/** Fast file projection; the REST page census below remains the authority for which PRs exist. A failed or partial
 *  projection is never silent: the reason and skipped row count go to the `diff-scan` observation. */
function projectedFiles(run: PrToolCommand, count: number, cwd?: string): FileProjection {
  const result = run('gh', ['pr', 'list', '--state', 'open', '--limit', String(Math.max(count, 1)), '--json', 'number,changedFiles,files'], cwd ? { cwd } : undefined);
  if (!result.ok) return { files: new Map(), skipped: 0, failure: `gh pr list 실패: ${(result.err || result.out || 'rc≠0').trim().slice(0, 200)}` };
  let rows: unknown;
  try { rows = JSON.parse(result.out); } catch { return { files: new Map(), skipped: 0, failure: `gh pr list JSON 오류 (${result.out.length}자)` }; }
  if (!Array.isArray(rows)) return { files: new Map(), skipped: 0, failure: 'gh pr list 응답이 배열 아님' };
  const projection = new Map<number, string[]>();
  let skipped = 0;
  for (const value of rows) {
    try {
      const row = object(value);
      if (!Number.isSafeInteger(row.number) || (row.number as number) <= 0 || !Number.isSafeInteger(row.changedFiles) || (row.changedFiles as number) < 0 || !Array.isArray(row.files)) { skipped += 1; continue; }
      const paths = row.files.map(file => text(object(file).path, 'PR 파일명'));
      if (paths.length === row.changedFiles && paths.length < MAX_FILES && !projection.has(row.number as number)) projection.set(row.number as number, paths);
      else skipped += 1;
    } catch { skipped += 1; /* malformed projection: REST file endpoint below decides this PR */ }
  }
  if (rows.length > 0 && projection.size === 0) return { files: projection, skipped, failure: `gh pr list ${rows.length}행 모두 사용 불가` };
  return { files: projection, skipped };
}

/** Run `calls` through the bounded pool when given, else one by one with the injected runner, stopping at the first
 *  failure (the historical order and call count). The result may be shorter than `calls` only in that sequential case. */
function runCalls(run: PrToolCommand, calls: readonly PrToolCall[], runParallel: PrToolParallelCommand | undefined, concurrency: number, what: string): PrToolCommandResult[] {
  if (runParallel) {
    const results = runParallel(calls, concurrency);
    if (results.length !== calls.length) throw new Error(`${what} 결과 ${results.length}/${calls.length}건 · 판정 불가`);
    return results;
  }
  const results: PrToolCommandResult[] = [];
  for (const call of calls) {
    const result = run(call.command, call.args, call.opts);
    results.push(result);
    if (!result.ok) break;
  }
  return results;
}

export function readOpenPrs(run: PrToolCommand, options: {
  cwd?: string;
  seatOfPr?: (pr: { number: number; headRefName: string; body: string; labels: readonly string[] }) => Seat | null;
  includeDraftCommitDates?: boolean;
  candidateFiles?: readonly string[];
  /** Bounded parallel REST-file fallback and diff fetch. Absent ⇒ the injected `run`, one by one (historical order and call count). */
  runParallel?: PrToolParallelCommand;
  /** Operations default {@link DEFAULT_DIFF_CONCURRENCY} (6) — production callers do not pass it; for test injection. */
  diffConcurrency?: number;
  /** Absent ⇒ no cache. Production callers pass {@link sharedCensusDiffCache}. */
  diffCache?: CensusDiffCache;
} = {}): Inventory {
  const started = Date.now();
  const callOpts = options.cwd ? { opts: { cwd: options.cwd } } : {};
  const concurrency = options.runParallel ? Math.max(1, Math.floor(options.diffConcurrency ?? DEFAULT_DIFF_CONCURRENCY)) : 1;
  const scan = { openPrs: 0, projected: 0, restFallback: 0, projectionFailed: false, projectionReason: undefined as string | undefined,
    projectionSkipped: 0, fileOverlap: 0, patchFetched: 0, cacheHits: 0 };
  let status: 'checked' | 'inventory-unknown' | 'files-failed' | 'diff-failed' | 'commit-date-failed' = 'inventory-unknown';
  const logDiffScan = () => {
    debug.log('pr-tool.census', 'diff-scan', { ...scan, concurrency, elapsedMs: Date.now() - started, status });
  };
  try {
    const rows = pages(run, 'repos/{owner}/{repo}/pulls?state=open&per_page=100', options.cwd);
    const projection = projectedFiles(run, rows.length, options.cwd);
    scan.projectionFailed = projection.failure !== undefined;
    scan.projectionReason = projection.failure;
    scan.projectionSkipped = projection.skipped;
    const prs: OpenPr[] = [];
    const seen = new Set<number>();
    for (const value of rows) {
      const row = object(value);
      const number = row.number;
      if (!Number.isSafeInteger(number) || (number as number) <= 0 || seen.has(number as number)) throw new Error('PR 번호 누락·중복');
      seen.add(number as number);
      if (row.state !== 'open' || typeof row.draft !== 'boolean') throw new Error(`PR #${number}: OPEN 상태·draft 판정 불가`);
      const head = object(row.head);
      const labels = row.labels;
      if (!Array.isArray(labels)) throw new Error(`PR #${number}: 라벨 판정 불가`);
      const labelNames = labels.map(label => text(object(label).name, `PR #${number} 라벨`));
      const headRefName = text(head.ref, `PR #${number} head ref`);
      const headSha = text(head.sha, `PR #${number} head sha`);
      const body = typeof row.body === 'string' ? row.body : '';
      const seat = seatValue(options.seatOfPr?.({ number: number as number, headRefName, body, labels: labelNames })) ?? seatFromLabels(labelNames);
      prs.push({
        number: number as number, headRefName, title: text(row.title, `PR #${number} title`), draft: row.draft,
        updatedAt: date(row.updated_at, `PR #${number} updated_at`), headSha, labels: labelNames,
        files: projection.files.get(number as number) ?? [], seat,
        cellId: cellIdFromBody(body), cardId: cardIdFromBody(body), cardMarkerPresent: hasCardMarker(body),
        slice: sliceMarkerFromBody(body),
      });
    }
    scan.openPrs = prs.length;
    // Files: PRs the one-shot projection did not cover take the REST file endpoint — in the pool when given.
    const restPrs = prs.filter(pr => !projection.files.has(pr.number));
    scan.projected = prs.length - restPrs.length;
    scan.restFallback = restPrs.length;
    if (restPrs.length) {
      status = 'files-failed';
      const results = runCalls(run, restPrs.map(pr => ({ command: 'gh', args: pagesArgs(filesEndpoint(pr.number)), ...callOpts })), options.runParallel, concurrency, 'PR 파일 조회');
      // The first failure in input order decides the reason; one failure keeps the whole inventory unknown.
      // Invariant: a result is missing only after an earlier failure (sequential stop), which throws first. Still,
      // a missing result is a failure (unknown), never an empty file list.
      restPrs.forEach((pr, index) => {
        const result = results[index];
        if (!result) throw new Error(`PR #${pr.number}: 파일 조회 결과 없음 · 판정 불가`);
        pr.files = pathsFromFilesResult(result, pr.number);
      });
    }
    // Diffs: only PRs sharing a candidate file; a cached (number, headSha) patch is not refetched.
    const pendingDiffs: OpenPr[] = [];
    for (const pr of prs) {
      if (!options.candidateFiles?.some(file => pr.files.includes(file))) continue;
      scan.fileOverlap += 1;
      const cached = options.diffCache?.get(pr.number, pr.headSha);
      if (cached !== undefined) { pr.hunks = parseDiffHunks(cached); scan.cacheHits += 1; }
      else pendingDiffs.push(pr);
    }
    if (pendingDiffs.length) {
      status = 'diff-failed';
      const results = runCalls(run, pendingDiffs.map(pr => ({ command: 'gh', args: ['pr', 'diff', String(pr.number), '--patch'], ...callOpts })), options.runParallel, concurrency, '수정 줄 조회');
      scan.patchFetched = results.length;
      pendingDiffs.forEach((pr, index) => {
        const patch = results[index];
        if (!patch) throw new Error(`PR #${pr.number}: 수정 줄 조회 결과 없음 · 판정 불가`);
        if (!patch.ok) throw new Error(`PR #${pr.number}: 수정 줄 조회 실패: ${patch.err || patch.out}`);
      });
      pendingDiffs.forEach((pr, index) => {
        const patch = results[index]!;
        pr.hunks = parseDiffHunks(patch.out);
        options.diffCache?.set(pr.number, pr.headSha, patch.out);
      });
    }
    if (options.includeDraftCommitDates) {
      status = 'commit-date-failed';
      for (const pr of prs) {
        if (!pr.draft) continue;
        const commit = run('gh', ['api', `repos/{owner}/{repo}/commits/${pr.headSha}`, '--jq', '.commit.committer.date'], options.cwd ? { cwd: options.cwd } : undefined);
        if (!commit.ok) throw new Error(`PR #${pr.number}: 마지막 커밋 날짜 조회 실패: ${commit.err || commit.out}`);
        pr.lastCommitAt = date(commit.out.trim(), `PR #${pr.number} 마지막 커밋`);
      }
    }
    status = 'checked';
    logDiffScan();
    return { status: 'checked', prs };
  } catch (error) {
    logDiffScan();
    return unknown(error instanceof Error ? error.message : String(error));
  }
}

export function isGoalOnly(files: readonly string[]): boolean {
  return files.length > 0 && files.every(path => path.startsWith('docs/goals/') && path.length > 'docs/goals/'.length);
}

export function censusOpenPrs(inventory: Inventory, now = Date.now()): Census {
  if (inventory.status === 'unknown') {
    debug.log('pr.tool', 'census', { status: 'unknown', reason: inventory.reason });
    return inventory;
  }
  const rows = new Map<Seat | 'unknown', CensusRow>();
  const closeCandidates: Array<{ number: number; reason: 'goal-only' | 'stale-draft' | 'superseded-open' }> = [];
  for (const pr of inventory.prs) {
    const key = pr.seat ?? 'unknown';
    const row = rows.get(key) ?? { seat: key, open: 0, goalOnly: 0, staleDraft: 0, supersededOpen: 0 };
    row.open += 1;
    if (isGoalOnly(pr.files)) { row.goalOnly += 1; closeCandidates.push({ number: pr.number, reason: 'goal-only' }); }
    if (pr.draft) {
      if (!pr.lastCommitAt) {
        const reason = `PR #${pr.number}: draft 마지막 커밋 날짜 없음`;
        debug.log('pr.tool', 'census', { status: 'unknown', reason });
        return { status: 'unknown', reason };
      }
      if (now - Date.parse(pr.lastCommitAt) >= DRAFT_STALE_MS) { row.staleDraft += 1; closeCandidates.push({ number: pr.number, reason: 'stale-draft' }); }
    }
    if (pr.labels.includes('elanous:superseded')) { row.supersededOpen += 1; closeCandidates.push({ number: pr.number, reason: 'superseded-open' }); }
    rows.set(key, row);
  }
  const result: Census = { status: 'checked', total: inventory.prs.length, rows: [...rows.values()], closeCandidates };
  debug.log('pr.tool', 'census', { status: 'checked', total: result.total, candidates: closeCandidates.length });
  return result;
}

export function guardNewPr(input: { files: readonly string[] | null; seat?: Seat | null; seatCap?: number; cellId?: string | null; cardId?: string | null; slice?: { slice: number; total: number } | null; boundPrNumber?: number; hunks?: readonly DiffHunk[]; hunkOverlap?: HunkOverlapMode }, inventory: Inventory): GuardVerdict {
  if (!input.files || input.files.length === 0 || input.files.some(file => !file || file.startsWith('/') || file.includes('..'))) {
    const reasons: GuardReason[] = [{ code: 'candidate-unknown', detail: '새 PR 변경 파일을 확인할 수 없음' }];
    debug.log('pr.tool', 'guard-refuse', { status: 'unknown', reasons });
    return { status: 'unknown', reasons, warnings: [] };
  }
  if (inventory.status === 'unknown') {
    const reasons: GuardReason[] = [{ code: 'inventory-unknown', detail: inventory.reason }];
    return { status: 'unknown', reasons, warnings: [] };
  }
  const reasons: GuardReason[] = [];
  const warnings: GuardReason[] = [];
  if (isGoalOnly(input.files)) reasons.push({ code: 'goal-only', detail: '골 문서만 변경 · 구현 0' });
  const candidate = new Set(input.files);
  const sameCell = input.cellId ? inventory.prs.filter(pr => pr.cellId === input.cellId) : [];
  if (sameCell.length) reasons.push({ code: 'same-cell', detail: `같은 칸 ${input.cellId} OPEN PR이 있음`, prs: sameCell.map(pr => pr.number) });
  const overlaps = inventory.prs.filter(pr => pr.files.some(file => candidate.has(file)));
  const hunkFiles = new Set<string>();
  const sameHunk = overlaps.filter(pr => {
    const paths = (pr.hunks ?? []).filter(other => input.hunks?.some(own => own.path === other.path && own.start <= other.end && other.start <= own.end)).map(other => other.path);
    for (const path of paths) hunkFiles.add(path);
    return paths.length > 0;
  });
  if (sameHunk.length) {
    const refuseHunk = input.hunkOverlap === 'refuse';
    (refuseHunk ? reasons : warnings).push({
      code: 'hunk-overlap',
      detail: refuseHunk ? '같은 파일의 수정 줄 범위가 겹침' : '같은 파일의 수정 줄 범위가 겹침 · 착지 때 머지로 푼다',
      prs: sameHunk.map(pr => pr.number),
      files: [...hunkFiles],
    });
  }
  if (overlaps.length) warnings.push({ code: 'file-overlap', detail: '같은 파일의 OPEN PR이 있음 · 줄 겹침은 별도 판정', prs: overlaps.map(pr => pr.number) });
  const seat = seatValue(input.seat);
  if (input.seat !== undefined && input.seat !== null && !seat) reasons.push({ code: 'candidate-unknown', detail: '호출자 자리 값 오류' });
  const cap = input.seatCap ?? DEFAULT_SEAT_CAP;
  if (!Number.isSafeInteger(cap) || cap < 1) {
    reasons.push({ code: 'candidate-unknown', detail: '자리별 PR 상한 설정 오류' });
  } else if (!seat) {
    warnings.push({ code: 'seat-unattributed', detail: `호출자 자리 미상 · 전체 OPEN PR ${inventory.prs.length}건` });
  } else {
    const count = inventory.prs.filter(pr => pr.seat === seat).length;
    if (count >= cap) warnings.push({ code: 'seat-cap', detail: `${seat} OPEN PR ${count}건 · 상한 ${cap}` });
    const unattributed = inventory.prs.filter(pr => pr.seat === null).length;
    if (unattributed) warnings.push({ code: 'seat-unattributed', detail: `귀속 미상 ${unattributed}건 · 전체 OPEN PR ${inventory.prs.length}건` });
  }
  const status = reasons.some(reason => reason.code === 'candidate-unknown') ? 'unknown' : reasons.length ? 'refuse' : 'allow';
  if (status !== 'allow') debug.log('pr.tool', 'guard-refuse', { status, reasons, warnings });
  else if (warnings.length) debug.log('pr.tool', 'guard-warn', { warnings });
  const legacyBound = sameCell.length === 1 && sameCell[0]?.cardMarkerPresent === false
    && input.boundPrNumber === sameCell[0].number;
  const reusable = status === 'refuse' && reasons.length === 1 && reasons[0]?.code === 'same-cell'
    && input.cardId && sameCell.length === 1 && (sameCell[0]?.cardId === input.cardId || legacyBound)
    && (input.slice?.slice ?? null) === (sameCell[0]?.slice?.slice ?? null)
    && (input.slice?.total ?? null) === (sameCell[0]?.slice?.total ?? null)
    && sameCell[0].headRefName && /^[0-9a-f]{40}$/i.test(sameCell[0].headSha)
    ? { number: sameCell[0].number, branch: sameCell[0].headRefName, headSha: sameCell[0].headSha,
      cellId: input.cellId!, cardId: input.cardId, ...(legacyBound ? { legacyBound: true as const } : {}) } : undefined;
  return { status, reasons, warnings,
    ...(sameCell.length ? { sameCellConflicts: sameCell.map(pr => ({ pr: pr.number, branch: pr.headRefName ?? null,
      headSha: pr.headSha, cardId: pr.cardId ?? null, slice: pr.slice ?? null })) } : {}),
    ...(reusable ? { sameCellReuse: reusable } : {}) };
}

/** Persist the unknown-read budget across harness processes sharing one instance state root. */
export function recordGuardUnmeasured(input: { seat: Seat | null; reason: string; stateRoot?: string; host?: string; now?: number }): { count: number; blocked: boolean; reason?: string } {
  const now = input.now ?? Date.now();
  const seat = input.seat ?? 'unknown';
  const host = input.host ?? resolveHostId();
  try {
    const dir = join(input.stateRoot ?? effectiveInstanceRoot(), 'pr-tool');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'guard-unmeasured.jsonl');
    return withFileLockSync(`${file}.lock`, () => {
      const rows = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
      const retained: Array<{ at: number; seat: string; host: string }> = [];
      let count = 0;
      for (const line of rows) {
        let value: unknown;
        try { value = JSON.parse(line); } catch { return { count: 0, blocked: true, reason: '판정 불가 원장 JSON 오류' }; }
        if (value && typeof value === 'object') {
          const row = value as { at?: unknown; seat?: unknown; host?: unknown };
          if (typeof row.at !== 'number' || typeof row.seat !== 'string' || typeof row.host !== 'string') return { count: 0, blocked: true, reason: '판정 불가 원장 행 형식 오류' };
          if (row.at > now - UNMEASURED_WINDOW_MS && row.at <= now) {
            retained.push({ at: row.at, seat: row.seat, host: row.host });
            if (row.seat === seat && row.host === host) count += 1;
          }
        } else return { count: 0, blocked: true, reason: '판정 불가 원장 행 형식 오류' };
      }
      retained.push({ at: now, seat, host });
      count += 1;
      writeFileSync(file, `${retained.map(row => JSON.stringify(row)).join('\n')}\n`);
      const blocked = count > UNMEASURED_ALLOW_COUNT;
      debug.log('pr-tool.open-guard', 'guard-unmeasured', { seat, host, count, blocked, reason: input.reason });
      return { count, blocked };
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debug.log('pr-tool.open-guard', 'guard-unmeasured', { seat, host, blocked: true, reason: `원장 오류: ${reason}` });
    return { count: 0, blocked: true, reason };
  }
}
