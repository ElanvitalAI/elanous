// FOLLOWUP-LOOP① — leftover findings after a merge or blocked run become
// follow-up drafts. Default mode is shadow; only merged drafts in `live` mode
// enqueue through the same function as `harness queue add`.
//
// The test process injects every store. Nothing here opens the operational
// ledger or queue unless the caller passes those seams.

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { addHarnessQueue, type QueueSeat } from '../harness/harness-queue.js';
import { debug } from '../debug/log.js';
import { withFileLockSync } from '../storage/file-lock.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { checklistDevVersion, listChecklist, parseOwner } from '../release-loop/checklist.js';
import { getUserConfig } from '../user-config.js';

export const FOLLOW_UP_DEPTH_LIMIT = 3;
export const FOLLOW_UP_OP_CARD_REQUIRED = 'OP 카드 필요';

const REMAINING_SECTION = '남은 조각';
const SEATS = ['OP', 'TC', 'MK', 'UX'] as const;

export type FollowUpMode = 'shadow' | 'live';

export interface FollowUpDraftRecord {
  prNumber: number;
  ending?: 'blocked';
  runId?: string;
  stage?: 'review-blocked' | 'gate-failed';
  cellId: string;
  depth: number;
  draftHash: string;
  kind: 'draft' | 'op-card-required';
  originalAskFirstLine: string;
  remainings: readonly string[];
  draft?: string;
  note?: string;
  queued: boolean;
  /** live 대기열 넣기가 실패했을 때의 이유(초안은 그대로 남는다). */
  enqueueError?: string;
  seat?: QueueSeat;
}

export interface FollowUpMergeInput {
  prNumber: number;
  /** Result field set when the review budget is exhausted. */
  followUpMustFix?: readonly string[];
  /** Last review's non-blocking findings. */
  shouldFix?: readonly string[];
  /** Opened PR body — the «남은 조각» section is read verbatim. */
  prBody?: string;
  /** Original request. Only its first line enters the draft. */
  feature: string;
  /** Release-cell id. Absent means the goal file's GoalId, else the feature's first token. */
  cellId?: string;
  goalFile?: string;
}

export interface FollowUpBlockedInput {
  runId: string;
  prNumber?: number;
  stage: 'review-blocked' | 'gate-failed';
  unresolvedMustFix?: readonly string[];
  decompositionPieces?: readonly string[];
  feature: string;
  cellId?: string;
  goalFile?: string;
}

export interface FollowUpSeams {
  stateRoot?: string;
  mode?: FollowUpMode;
  /**
   * Prior follow-up records for this cell, oldest first.
   * Absent means the caller did not hand over a store — the test process writes nothing.
   * Production `defaultSeams` always sets this to the state-root ledger.
   */
  readDrafts?: (cellId: string) => readonly FollowUpDraftRecord[];
  appendDraft?: (record: FollowUpDraftRecord) => void;
  /** Same function `harness queue add` calls. Injected in tests so the real queue is never opened. */
  enqueue?: (input: { seat: QueueSeat; say: string; idempotencyKey: string }) => Promise<unknown> | unknown;
  /** Release-cell owner (`TC`, `TC/rel`, …). Absent means look up the developing checklist. */
  cellOwner?: (cellId: string) => string | undefined;
  log?: (category: string, event: string, data?: unknown) => void;
}

export function followUpDraftsPath(stateRoot = elanousStateRoot()): string {
  return join(stateRoot, 'follow-up', 'drafts.jsonl');
}

export function readFollowUpMode(read: () => { harness?: { followUp?: unknown } } = getUserConfig): FollowUpMode {
  return read().harness?.followUp === 'live' ? 'live' : 'shadow';
}

/** Lines under a markdown heading «남은 조각», verbatim, without the bullet mark. */
export function remainingPiecesFromPrBody(body: string | undefined): string[] {
  if (!body) return [];
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${REMAINING_SECTION}`);
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    const item = line.match(/^\s*[-*]\s+(.+?)\s*$/)?.[1];
    if (item) out.push(item);
  }
  return out;
}

export function collectRemainings(input: Pick<FollowUpMergeInput, 'followUpMustFix' | 'shouldFix' | 'prBody'>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [
    ...(input.followUpMustFix ?? []),
    ...(input.shouldFix ?? []),
    ...remainingPiecesFromPrBody(input.prBody),
  ]) {
    const text = item.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

export function followUpCellId(input: Pick<FollowUpMergeInput, 'cellId' | 'goalFile' | 'feature'>, readGoal: (path: string) => string = (path) => readFileSync(path, 'utf8')): string | undefined {
  const explicit = input.cellId?.trim();
  if (explicit) return explicit;
  if (input.goalFile) {
    try {
      const goalId = readGoal(input.goalFile).match(/^- GoalId:\s*(\S+)\s*$/m)?.[1];
      if (goalId) return goalId;
    } catch { /* a missing goal file is not a cell id */ }
  }
  // 자리 발사 머리(`[MK 자리 · 0.2.16 체크리스트 칸 FOLLOWUP-LOOP · …]`)가 칸을 «명시»한 경우만 읽는다.
  // 추정(요청문 첫 단어)으로는 기록하지 않는다 — 다른 골이 한 칸으로 합쳐져 깊이·담당이 틀린다.
  // 자리 머리 줄만 본다 — 본문이 다른 칸을 언급해도 그 칸으로 기록하지 않는다.
  // 저작 Pod 규칙(OP 10-06)에서 첫 줄은 `대상 경로:` 이고 머리는 둘째 줄이라, 앞의 `대상 경로:` 줄 하나는 건너뛴다.
  const lines = input.feature.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const header = /^대상 경로:/u.test(lines[0] ?? '') ? lines[1] : lines[0];
  return header?.match(/^\[(?:OP|MK|TC|UX) 자리 · [^\]]*?체크리스트 칸 ([A-Z][A-Z0-9-]*[A-Z0-9])(?: ·|\])/u)?.[1];
}

export function originalAskFirstLine(feature: string): string {
  return feature.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}

export function followUpDraftText(firstLine: string, remainings: readonly string[]): string {
  return [
    firstLine,
    ...remainings,
    'origin/main 에서 시작 · 남은 것만',
  ].join('\n');
}

export function followUpDraftHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Legacy merge rows have no ending; blocked rows use run identity even without a PR. */
function followUpRecordKey(record: Pick<FollowUpDraftRecord, 'prNumber' | 'ending' | 'runId'>): string {
  return record.ending === 'blocked' ? `run:${record.runId}` : `pr:${record.prNumber}`;
}

/** Chain length of follow-up goals already recorded for this cell, before this one. */
export function followUpChainDepth(prior: readonly Pick<FollowUpDraftRecord, 'kind' | 'prNumber' | 'ending' | 'runId'>[]): number {
  // 기록 → 대기열 확정 두 줄은 하나로 세되, PR 없는 서로 다른 런은 분리한다.
  return new Set(prior.filter((record) => record.kind === 'draft' || record.kind === 'op-card-required').map(followUpRecordKey)).size;
}

/** Seat = the cell's owner. `TC/rel` keeps the seat `TC`. Unknown or absent owners go to OP (ONEDOOR). */
export function seatForCellOwner(owner: string | undefined): QueueSeat {
  if (!owner) return 'OP';
  try {
    const seat = parseOwner(owner.trim()).seat;
    if ((SEATS as readonly string[]).includes(seat)) return seat as QueueSeat;
  } catch { /* not a seat */ }
  const head = owner.trim().split(/[/\s·]/)[0] ?? '';
  return (SEATS as readonly string[]).includes(head) ? head as QueueSeat : 'OP';
}

function defaultReadDrafts(stateRoot: string, cellId: string): FollowUpDraftRecord[] {
  let text = '';
  try { text = readFileSync(followUpDraftsPath(stateRoot), 'utf8'); } catch { return []; }
  const out: FollowUpDraftRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as FollowUpDraftRecord;
      if (record.cellId === cellId) out.push(record);
    } catch { /* a torn line does not invent a chain */ }
  }
  return out;
}

/** 같은 PR 또는 같은 blocked 런은 칸과 무관하게 한 번 기록한다. */
function defaultRecordExists(stateRoot: string, key: string): boolean {
  let text = '';
  try { text = readFileSync(followUpDraftsPath(stateRoot), 'utf8'); } catch { return false; }
  return text.split('\n').some((line) => {
    if (!line.trim()) return false;
    try { return followUpRecordKey(JSON.parse(line) as FollowUpDraftRecord) === key; } catch { return false; }
  });
}

function defaultAppendFirst(stateRoot: string, record: FollowUpDraftRecord): boolean {
  const path = followUpDraftsPath(stateRoot);
  mkdirSync(dirname(path), { recursive: true });
  return withFileLockSync(`${path}.lock`, () => {
    if (defaultRecordExists(stateRoot, followUpRecordKey(record))) return false;
    defaultAppendDraft(stateRoot, record);
    return true;
  });
}

function defaultAppendDraft(stateRoot: string, record: FollowUpDraftRecord): void {
  const path = followUpDraftsPath(stateRoot);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

function defaultCellOwner(cellId: string): string | undefined {
  try {
    return listChecklist(checklistDevVersion()).items.find((item) => item.id === cellId)?.owner;
  } catch {
    return undefined;
  }
}

/**
 * Record one follow-up draft for a merged PR. Same PR is recorded once.
 * Depth above {@link FOLLOW_UP_DEPTH_LIMIT} records «OP 카드 필요» instead of a draft.
 * `live` enqueues; `shadow` (the default) only records. Returns null when nothing remains.
 * Every failure is `debug.log` only — the merge result is the caller's to return unchanged.
 */
export async function recordFollowUpOnMerge(input: FollowUpMergeInput, seams: FollowUpSeams = {}): Promise<FollowUpDraftRecord | null> {
  const log = seams.log ?? ((category, event, data) => { debug.log(category, event, data); });
  try {
    const remainings = collectRemainings(input);
    if (remainings.length === 0) {
      log('self-implement.follow-up', 'draft-skipped-empty', { ending: 'merged', prNumber: input.prNumber });
      return null;
    }
    // No injected store and no explicit state root: this is the test process.
    // Do not open the operational ledger or the harness queue.
    // A test process handed the operational root (defaultSeams) is refused the same way.
    const testProcess = process.env.NODE_ENV === 'test' || !!process.env.ELANOUS_TEST_HOME;
    if (!seams.readDrafts && !seams.appendDraft && (!seams.stateRoot || (testProcess && seams.stateRoot === elanousStateRoot()))) return null;
    const stateRoot = seams.stateRoot ?? elanousStateRoot();
    const cellId = followUpCellId(input);
    if (!cellId) {
      log('self-implement.follow-up', 'draft-skipped-no-cell', { prNumber: input.prNumber });
      return null;
    }
    const prior = (seams.readDrafts ?? ((id) => defaultReadDrafts(stateRoot, id)))(cellId);
    const key = followUpRecordKey({ prNumber: input.prNumber });
    if (prior.some((record) => followUpRecordKey(record) === key)) return null;
    if (!seams.readDrafts && defaultRecordExists(stateRoot, key)) return null;
    const depth = followUpChainDepth(prior) + 1;
    const firstLine = originalAskFirstLine(input.feature);
    const mode = seams.mode ?? readFollowUpMode();
    const overDepth = depth > FOLLOW_UP_DEPTH_LIMIT;
    const draft = overDepth ? undefined : followUpDraftText(firstLine, remainings);
    const record: FollowUpDraftRecord = {
      prNumber: input.prNumber,
      cellId,
      depth,
      draftHash: followUpDraftHash(draft ?? `${firstLine}\n${FOLLOW_UP_OP_CARD_REQUIRED}`),
      kind: overDepth ? 'op-card-required' : 'draft',
      originalAskFirstLine: firstLine,
      remainings,
      ...(draft ? { draft } : {}),
      ...(overDepth ? { note: FOLLOW_UP_OP_CARD_REQUIRED } : {}),
      queued: false,
    };
    // 운영 원장은 «같은 PR 확인 ⊕ 첫 기록»을 한 잠금 안에서 한다 — 동시 병합 둘이 초안 둘을 만들지 않게.
    const append = seams.appendDraft ?? ((row: FollowUpDraftRecord) => defaultAppendDraft(stateRoot, row));
    const appendFirst = seams.appendDraft
      ? (row: FollowUpDraftRecord) => { append(row); return true; }
      : (row: FollowUpDraftRecord) => defaultAppendFirst(stateRoot, row);
    if (!overDepth && mode === 'live' && draft) record.seat = seatForCellOwner((seams.cellOwner ?? defaultCellOwner)(cellId));
    // 원장 기록을 먼저 확정한다 — 기록이 실패하면 대기열에 넣지 않는다(같은 PR 한 번 · 원장 밖 연결골 0).
    if (!appendFirst(record)) return null;
    if (!overDepth && mode === 'live' && draft && record.seat) {
      const seat = record.seat;
      if (!(testProcess && !seams.enqueue)) {
        try {
          await (seams.enqueue ?? ((item) => addHarnessQueue({ seat: item.seat, say: item.say, idempotencyKey: item.idempotencyKey })))({
            seat,
            say: draft,
            idempotencyKey: `follow-up:${input.prNumber}`,
          });
          record.queued = true;
        } catch (error) {
          // 대기열 넣기가 실패해도 초안은 남긴다 — 같은 PR 은 다시 오지 않으므로 여기서 잃으면 영영 없다.
          // queued=false ⊕ enqueueError 로 원장에 남기고, 재투입은 같은 idempotencyKey 로 사람이·다음 수리 노드가 한다.
          record.enqueueError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
          log('self-implement.follow-up', 'enqueue-failed', { prNumber: input.prNumber, seat, error: record.enqueueError });
        }
        // 대기열 결과를 원장에 한 줄 더 — 이 쓰기의 실패는 대기열 실패와 다른 사건이다.
        try {
          append({ ...record });
        } catch (error) {
          log('self-implement.follow-up', 'ledger-confirm-failed', {
            prNumber: input.prNumber, seat, queued: record.queued, error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    log('self-implement.follow-up', 'drafted', { ending: 'merged', prNumber: input.prNumber, cellId, depth, kind: record.kind, mode, queued: record.queued, remainingCount: remainings.length });
    return record;
  } catch (error) {
    log('self-implement.follow-up', 'draft-failed', {
      prNumber: input.prNumber,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Blocked runs leave a draft in the ledger only, even when follow-up mode is live. */
export async function recordFollowUpOnBlocked(input: FollowUpBlockedInput, seams: FollowUpSeams = {}): Promise<FollowUpDraftRecord | null> {
  const log = seams.log ?? ((category, event, data) => { debug.log(category, event, data); });
  const prNumber = input.prNumber ?? 0;
  try {
    const remainings = collectRemainings({ followUpMustFix: input.unresolvedMustFix, shouldFix: input.decompositionPieces });
    if (remainings.length === 0) {
      log('self-implement.follow-up', 'draft-skipped-empty', { ending: 'blocked', prNumber, runId: input.runId });
      return null;
    }
    const testProcess = process.env.NODE_ENV === 'test' || !!process.env.ELANOUS_TEST_HOME;
    if (!seams.readDrafts && !seams.appendDraft && (!seams.stateRoot || (testProcess && seams.stateRoot === elanousStateRoot()))) return null;
    const stateRoot = seams.stateRoot ?? elanousStateRoot();
    const cellId = followUpCellId(input);
    if (!cellId) {
      log('self-implement.follow-up', 'draft-skipped-no-cell', { ending: 'blocked', prNumber, runId: input.runId });
      return null;
    }
    const prior = (seams.readDrafts ?? ((id) => defaultReadDrafts(stateRoot, id)))(cellId);
    const key = followUpRecordKey({ ending: 'blocked', runId: input.runId, prNumber });
    if (prior.some((record) => followUpRecordKey(record) === key)) return null;
    if (!seams.readDrafts && defaultRecordExists(stateRoot, key)) return null;
    const depth = followUpChainDepth(prior) + 1;
    const firstLine = originalAskFirstLine(input.feature);
    const mode = seams.mode ?? readFollowUpMode();
    const overDepth = depth > FOLLOW_UP_DEPTH_LIMIT;
    const draft = overDepth ? undefined : followUpDraftText(firstLine, remainings);
    const record: FollowUpDraftRecord = {
      ending: 'blocked', runId: input.runId, stage: input.stage, prNumber, cellId, depth,
      draftHash: followUpDraftHash(draft ?? `${firstLine}\n${FOLLOW_UP_OP_CARD_REQUIRED}`),
      kind: overDepth ? 'op-card-required' : 'draft', originalAskFirstLine: firstLine, remainings,
      ...(draft ? { draft } : {}),
      ...(overDepth ? { note: FOLLOW_UP_OP_CARD_REQUIRED } : {}),
      queued: false,
    };
    if (seams.appendDraft) seams.appendDraft(record);
    else if (!defaultAppendFirst(stateRoot, record)) return null;
    log('self-implement.follow-up', 'drafted', { ending: 'blocked', prNumber, runId: input.runId, stage: input.stage, cellId, depth, kind: record.kind, mode, queued: false, remainingCount: remainings.length });
    return record;
  } catch (error) {
    log('self-implement.follow-up', 'draft-failed', { ending: 'blocked', prNumber, runId: input.runId, stage: input.stage, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
