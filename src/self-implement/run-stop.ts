/**
 * STOP-RECORD (0.2.20 P0) — 런이 «멈춘» 자리마다 런 원장에 `event='stop'` 한 줄을 «더한다».
 *
 * 멈추는 자리 넷이 이 함수 하나를 부른다:
 *   ① 병합 보류(`mergeReason !== 'auto'`) · ② implement aborted — `orchestrator.ts` `runSelfImplement`
 *   ③ Pod exit 비0 — `harness-cli-command.ts` `onPod`
 *   ④ 발사 직후 자식 비0 종료(launch-failed) — `tasks-cli.ts` `defaultTaskLauncher`
 *
 * ⛔ 보존 계약: 기존 PR 본문·런 원장 항목·logs.db 사건(exit-classified 등)은 손대지 않고 «더하기»만 한다.
 * ⭐ 이 스키마(`RunStopRecord`·`RUN_STOP_CLASSES`)는 STOP-AUTOHEAL 이 읽는다 — 칸 이름·닫힌 목록을 바꾸지 않는다(더하기만).
 */
import { debug } from '../debug/log.js';
import { appendRunLedgerEntry, type RunLedgerEntry, type RunLedgerWriter, type RunShardIdentity } from './run-ledger.js';

/** 닫힌 목록 — 못 고르면 `unclassified`. */
export const RUN_STOP_CLASSES = [
  'env-unrelated', 'main-sync', 'pod-died', 'review-repeat',
  'review-out-of-scope', 'evidence-uncovered', 'fabric', 'launch-failed', 'unclassified',
] as const;
export type RunStopClass = typeof RUN_STOP_CLASSES[number];

/** 런 원장 `event='stop'` 줄의 `data` 모양(STOP-AUTOHEAL 이 소비한다). */
export interface RunStopRecord {
  class: RunStopClass;
  /** 한 줄 · ≤120자 · 결정 라벨(원 로그 꼬리 금지). */
  cause: string;
  /** 근거 위치 — PR URL · `run-ledger:<runId>:<event>` · 파일 경로. */
  evidenceRef: string;
  /** 다음 한 수(사람·힐러가 읽는다). */
  nextMove: string;
}

export const RUN_STOP_EVENT = 'stop';
export const RUN_STOP_CAUSE_MAX = 120;

export interface RunStopInput {
  runId: string;
  goalId?: string;
  shardIdentity?: RunShardIdentity;
  /** 닫힌 목록 밖이거나 비면 `unclassified`. */
  class?: string;
  cause: string;
  evidenceRef: string;
  nextMove: string;
  /** 관측용 — 어느 자리가 불렀나(merge-hold · implement-aborted · draft-pr-open-failed · pod-exit · launch-failed). */
  site?: string;
}

export function isRunStopClass(value: unknown): value is RunStopClass {
  return typeof value === 'string' && (RUN_STOP_CLASSES as readonly string[]).includes(value);
}

/** 원 로그 꼬리가 아니라 «한 줄»로 — 첫 비어 있지 않은 줄 · ANSI 제거 · 공백 접기 · ≤120자(코드 포인트). */
export function boundRunStopCause(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const plain = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => (c === '\r' ? '\n' : ' '));
  const first = plain.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).find((line) => line.length > 0) ?? '';
  return Array.from(first).slice(0, RUN_STOP_CAUSE_MAX).join('') || 'stop reason unclassified';
}

/** 병합 보류 사유 → 닫힌 목록. 모르면 `unclassified`. */
export function classifyMergeHoldStop(mergeReason: string | undefined): RunStopClass {
  const reason = mergeReason ?? '';
  if (reason.startsWith('main-sync') || reason === 'default-branch-unresolved') return 'main-sync';
  if (reason === 'required-evidence-uncovered') return 'evidence-uncovered';
  if (reason === 'review-must-fix' || reason === 'review-warn-with-must-fix' || reason.startsWith('review-budget')) return 'review-repeat';
  if (reason.startsWith('review-diff') || reason === 'no-real-review') return 'review-out-of-scope';
  return 'unclassified';
}

/** Pod exit 분류 사유 → 닫힌 목록. */
export function classifyPodExitStop(reason: string | undefined): RunStopClass {
  switch (reason) {
    case 'pod-failure': case 'pod-error': case 'OOMKilled': case 'ENOBUFS': case 'signal': return 'pod-died';
    case 'no-launch': return 'launch-failed';
    default: return 'unclassified';
  }
}

/** 이 프로세스에서 stop 을 이미 쓴 런 — 한 런이 두 자리(예: draft PR 실패 ⊕ aborted)에서 두 줄을 쓰지 않게. */
const recordedThisProcess = new Set<string>();
const RECORDED_MAX = 4096;

/** 이 프로세스가 그 런에 stop 을 이미 썼나(원장 재독 없이 · 같은 프로세스 안 중복 방지용). */
export function runStopRecorded(runId: string): boolean {
  return recordedThisProcess.has(runId);
}

/** 런 시작 때 부른다 — 같은 runId 로 다시 도는 런(재시도·시험)이 지난 판의 표시에 막히지 않게. */
export function forgetRunStop(runId: string): void {
  recordedThisProcess.delete(runId);
}

/** 멈춘 런에 stop 한 줄을 더한다 — 기존 관측은 바꾸지 않는다. 쓴 줄을 돌려준다. */
export function recordRunStop(input: RunStopInput, write: RunLedgerWriter = appendRunLedgerEntry): RunLedgerEntry {
  const record: RunStopRecord = {
    class: isRunStopClass(input.class) ? input.class : 'unclassified',
    cause: boundRunStopCause(input.cause),
    evidenceRef: input.evidenceRef,
    nextMove: input.nextMove,
  };
  const entry: RunLedgerEntry = {
    timestamp: new Date().toISOString(), runId: input.runId, event: RUN_STOP_EVENT,
    data: { ...record },
    ...(input.goalId ? { goalId: input.goalId } : {}),
    ...input.shardIdentity,
  };
  write(entry);
  if (recordedThisProcess.size >= RECORDED_MAX) recordedThisProcess.clear();
  recordedThisProcess.add(input.runId);
  try {
    debug.log('self-implement.run-stop', 'recorded', { runId: input.runId, site: input.site ?? null, ...record, requestedClass: input.class ?? null });
  } catch { /* observation is fail-soft */ }
  return entry;
}

/** 원장 항목이 stop 줄이면 그 레코드를 돌려준다(STOP-AUTOHEAL 소비용). */
export function readRunStopRecord(entry: RunLedgerEntry): RunStopRecord | undefined {
  if (entry.event !== RUN_STOP_EVENT) return undefined;
  const data = entry.data as Partial<RunStopRecord>;
  if (typeof data.cause !== 'string' || typeof data.evidenceRef !== 'string' || typeof data.nextMove !== 'string') return undefined;
  return { class: isRunStopClass(data.class) ? data.class : 'unclassified', cause: data.cause, evidenceRef: data.evidenceRef, nextMove: data.nextMove };
}
