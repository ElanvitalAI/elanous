/** Shared PR inventory and creation guard for the CLI and harness. All incomplete reads stay unknown. */
import { debug } from '../debug/log.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { withFileLockSync } from '../storage/file-lock.js';
import { resolveHostId } from '../platform/host-id.js';

export interface PrToolCommandResult { ok: boolean; out: string; err?: string }
export type PrToolCommand = (command: string, args: readonly string[], opts?: { cwd?: string }) => PrToolCommandResult;
export type Seat = 'OP' | 'TC' | 'MK' | 'UX';
export interface OpenPr {
  number: number;
  title: string;
  draft: boolean;
  updatedAt: string;
  headSha: string;
  labels: readonly string[];
  files: readonly string[];
  seat: Seat | null;
  lastCommitAt?: string;
  cellId: string | null;
  hunks?: readonly DiffHunk[];
}
export type Inventory = { status: 'checked'; prs: readonly OpenPr[] } | { status: 'unknown'; reason: string };
export interface CensusRow { seat: Seat | 'unknown'; open: number; goalOnly: number; staleDraft: number; supersededOpen: number }
export type Census = { status: 'checked'; total: number; rows: readonly CensusRow[]; closeCandidates: readonly { number: number; reason: 'goal-only' | 'stale-draft' | 'superseded-open' }[] }
  | { status: 'unknown'; reason: string };
export interface DiffHunk { path: string; start: number; end: number }
export type GuardCode = 'inventory-unknown' | 'candidate-unknown' | 'goal-only' | 'file-overlap' | 'hunk-overlap' | 'same-cell' | 'seat-cap' | 'seat-unattributed';
export interface GuardReason { code: GuardCode; detail: string; prs?: readonly number[] }
export interface GuardVerdict { status: 'allow' | 'refuse' | 'unknown'; reasons: readonly GuardReason[]; warnings: readonly GuardReason[] }

const SEATS = ['OP', 'TC', 'MK', 'UX'] as const;
const DEFAULT_SEAT_CAP = 30;
const DRAFT_STALE_MS = 2 * 24 * 60 * 60 * 1000;
const MAX_PAGES = 100;
const MAX_FILES = 3000; // GitHub does not expose more than 3000 PR files.
const UNMEASURED_WINDOW_MS = 60 * 60 * 1000;
const UNMEASURED_ALLOW_COUNT = 3;

function unknown(reason: string): Inventory { return { status: 'unknown', reason }; }
function seatValue(value: unknown): Seat | null { return SEATS.find(seat => seat === value) ?? null; }
function seatFromLabels(labels: readonly string[]): Seat | null {
  return SEATS.find(seat => labels.includes(`seat:${seat}`)) ?? null;
}
export function cellIdFromBody(body: string): string | null {
  return /^\s*(?:[-*]\s*)?칸\s*:\s*([A-Z][A-Z0-9-]{2,})\s*$/m.exec(body)?.[1] ?? null;
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
function pages(run: PrToolCommand, endpoint: string, cwd?: string): readonly unknown[] {
  const result = run('gh', ['api', '--paginate', '--slurp', endpoint], cwd ? { cwd } : undefined);
  if (!result.ok) throw new Error(`gh api ${endpoint}: ${result.err || result.out || '조회 실패'}`);
  let parsed: unknown;
  try { parsed = JSON.parse(result.out); } catch { throw new Error(`gh api ${endpoint}: JSON 오류`); }
  if (!Array.isArray(parsed) || parsed.length >= MAX_PAGES || !parsed.every(page => Array.isArray(page) && page.length <= 100)) {
    throw new Error(`gh api ${endpoint}: 페이지 형식·상한 판정 불가`);
  }
  return parsed.flat();
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
function pathsForPr(run: PrToolCommand, number: number, cwd?: string): string[] {
  const rows = pages(run, `repos/{owner}/{repo}/pulls/${number}/files?per_page=100`, cwd);
  if (rows.length >= MAX_FILES) throw new Error(`PR #${number}: 파일 ${MAX_FILES}개 GitHub 상한에 닿음`);
  return rows.map(row => text(object(row).filename, `PR #${number} 파일명`));
}

/** Fast file projection; the REST page census below remains the authority for which PRs exist. */
function projectedFiles(run: PrToolCommand, count: number, cwd?: string): Map<number, string[]> {
  const result = run('gh', ['pr', 'list', '--state', 'open', '--limit', String(Math.max(count, 1)), '--json', 'number,changedFiles,files'], cwd ? { cwd } : undefined);
  if (!result.ok) return new Map();
  let rows: unknown;
  try { rows = JSON.parse(result.out); } catch { return new Map(); }
  if (!Array.isArray(rows)) return new Map();
  const projection = new Map<number, string[]>();
  for (const value of rows) {
    try {
      const row = object(value);
      if (!Number.isSafeInteger(row.number) || (row.number as number) <= 0 || !Number.isSafeInteger(row.changedFiles) || (row.changedFiles as number) < 0 || !Array.isArray(row.files)) continue;
      const paths = row.files.map(file => text(object(file).path, 'PR 파일명'));
      if (paths.length === row.changedFiles && paths.length < MAX_FILES && !projection.has(row.number as number)) projection.set(row.number as number, paths);
    } catch { /* malformed projection: REST file endpoint below decides this PR */ }
  }
  return projection;
}

export function readOpenPrs(run: PrToolCommand, options: {
  cwd?: string;
  seatOfPr?: (pr: { number: number; headRefName: string; body: string; labels: readonly string[] }) => Seat | null;
  includeDraftCommitDates?: boolean;
  candidateFiles?: readonly string[];
} = {}): Inventory {
  try {
    const rows = pages(run, 'repos/{owner}/{repo}/pulls?state=open&per_page=100', options.cwd);
    const projected = projectedFiles(run, rows.length, options.cwd);
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
      const pr: OpenPr = {
        number: number as number, title: text(row.title, `PR #${number} title`), draft: row.draft,
        updatedAt: date(row.updated_at, `PR #${number} updated_at`), headSha, labels: labelNames,
        files: projected.get(number as number) ?? pathsForPr(run, number as number, options.cwd), seat,
        cellId: cellIdFromBody(body),
      };
      if (options.candidateFiles?.some(file => pr.files.includes(file))) {
        const patch = run('gh', ['pr', 'diff', String(number), '--patch'], options.cwd ? { cwd: options.cwd } : undefined);
        if (!patch.ok) throw new Error(`PR #${number}: 수정 줄 조회 실패: ${patch.err || patch.out}`);
        pr.hunks = parseDiffHunks(patch.out);
      }
      if (pr.draft && options.includeDraftCommitDates) {
        const commit = run('gh', ['api', `repos/{owner}/{repo}/commits/${headSha}`, '--jq', '.commit.committer.date'], options.cwd ? { cwd: options.cwd } : undefined);
        if (!commit.ok) throw new Error(`PR #${number}: 마지막 커밋 날짜 조회 실패: ${commit.err || commit.out}`);
        pr.lastCommitAt = date(commit.out.trim(), `PR #${number} 마지막 커밋`);
      }
      prs.push(pr);
    }
    return { status: 'checked', prs };
  } catch (error) {
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

export function guardNewPr(input: { files: readonly string[] | null; seat?: Seat | null; seatCap?: number; cellId?: string | null; hunks?: readonly DiffHunk[] }, inventory: Inventory): GuardVerdict {
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
  const sameHunk = overlaps.filter(pr => pr.hunks?.some(other => input.hunks?.some(own => own.path === other.path && own.start <= other.end && other.start <= own.end)));
  if (sameHunk.length) reasons.push({ code: 'hunk-overlap', detail: '같은 파일의 수정 줄 범위가 겹침', prs: sameHunk.map(pr => pr.number) });
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
  return { status, reasons, warnings };
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
