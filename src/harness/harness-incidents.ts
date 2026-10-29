import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecretText } from '../debug/log.js';
import { refuseProductionLedgerWriteInTest } from './ledger-write-guard.js';
import type { PodChildEvidence } from '../task-orchestrator/surfaces/self-implement.js';
import { parsePodTermination, type PodTermination } from '../task-orchestrator/surfaces/pod-failure-reason.js';
import { loadRunLedger, runLedgerDir, type RunLedgerEntry } from '../self-implement/run-ledger.js';

export interface RunExit {
  runId: string;
  reason: string;
  status: number | null;
  signal: string | null;
  at: string;
  entrance?: string;
  seat?: string;
  cwd?: string;
  hostname?: string;
  pid?: number;
  lastLines?: string[];
  childEvidence?: PodChildEvidence;
  /** JOB-FAILURE-TERMINATION-CAPTURE — the current attempt's Job/Pod termination facts, captured before GC. */
  podTermination?: PodTermination;
  /** Current Pod attempt + bounded child output + container exit + parent verdict, joined under this runId. */
  terminalEvidence?: {
    job: string;
    childRunId: string;
    attempt: number | 'unknown';
    childOutputTail: string[] | 'unknown';
    containerExitCode: number | 'unknown';
    parentVerdict: string;
    failureClassification: string | 'unknown';
    terminationReason: string | 'unknown';
    childFailureStage: string | 'unknown';
    childRunStatus: { stage: string | 'unknown'; status: string | 'unknown'; failureKind: string | 'unknown' };
    shardIdentityReadFailure: string | 'none' | 'unknown';
    providerFailure: 'credential-not-configured' | 'provider-failed' | 'none' | 'unknown';
  };
  /** INCIDENT-REASON-FROM-LASTLINES — 기록된 reason 이 unknown 이라 lastLines 로 다시 분류했으면 원래 값. */
  recordedReason?: string;
  /** reason 을 어디서 얻었나 — 'lastLines' 면 위 분류 규칙으로 정했다(기록 원문은 recordedReason). */
  reasonSource?: 'lastLines';
  /** lastLines 에 ux-sim 장치 조각 경로가 보였다 — 장치 먼저 조각의 실패를 따로 셀 수 있게. */
  slice?: 'device';
}

export interface IncidentBurst {
  reason: string;
  count: number;
  firstAt: string;
  lastAt: string;
  runIds: string[];
  entrance?: string;
  seat?: string;
  hostname?: string;
}

export type TcellHealthClass = 'healthy' | 'slow' | 'stalled' | 'infected' | 'zombie';

/** A read-only health-card snapshot supplied to the guardian tick. Times are epoch milliseconds. */
export interface TcellHealthCard {
  runId: string;
  stage: string;
  startedAt: number;
  progressAt: number | null;
  stageBudgetMs: number;
  heartbeatAt: number | null;
  parentPresent: boolean;
  leaseExpiresAt: number | null;
  riskSignal: boolean;
  stopClass?: string;
  site?: string;
  /** Stable signature tail, already bounded by the producer. Raw log tails are not accepted here. */
  signatureTail?: string;
  /** Deliberately excluded from cause grouping. */
  hostname?: string;
}

export interface TcellHealthDecision {
  runId: string;
  stage: string;
  classification: TcellHealthClass;
  reason: 'heartbeat-missing' | 'parent-missing' | 'lease-expired' | 'risk-signal' | 'cause-quorum' | 'no-progress-30m' | 'over-stage-budget' | 'within-stage-budget';
  causeGroupId?: string;
  causeGroupSize?: number;
}

export interface TcellHealthClassification {
  total: number;
  measured: number;
  unmeasuredRunIds: string[];
  counts: Record<TcellHealthClass, number>;
  decisions: TcellHealthDecision[];
}

const TCELL_STALLED_AFTER_MS = 30 * 60_000;
const TCELL_CAUSE_QUORUM = 3;

function tcellCauseGroupId(card: TcellHealthCard): string | undefined {
  const stopClass = card.stopClass?.trim();
  const site = card.site?.trim();
  const signatureTail = card.signatureTail?.trim();
  if (!stopClass || !site || !signatureTail) return undefined;
  // Hash the exact stop.class + site + signature-tail tuple. Host is deliberately absent.
  return createHash('sha256').update(JSON.stringify([stopClass, site, signatureTail])).digest('hex').slice(0, 16);
}

/** Pure shadow classification. Invalid/incomplete cards are reported as unmeasured, never as healthy or zombie. */
export function classifyTcellHealthCards(cards: readonly TcellHealthCard[], now: number): TcellHealthClassification {
  if (!Number.isFinite(now)) throw new RangeError('invalid T-cell patrol time');
  const valid: TcellHealthCard[] = [];
  const unmeasuredRunIds: string[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    const measured = typeof card.runId === 'string' && !!card.runId.trim() && !seen.has(card.runId)
      && typeof card.stage === 'string' && !!card.stage.trim()
      && Number.isFinite(card.startedAt) && card.startedAt <= now
      && (card.progressAt === null || (Number.isFinite(card.progressAt) && card.progressAt <= now))
      && Number.isFinite(card.stageBudgetMs) && card.stageBudgetMs > 0
      && (card.heartbeatAt === null || (Number.isFinite(card.heartbeatAt) && card.heartbeatAt <= now))
      && typeof card.parentPresent === 'boolean'
      && (card.leaseExpiresAt === null || Number.isFinite(card.leaseExpiresAt))
      && typeof card.riskSignal === 'boolean';
    if (!measured) {
      if (typeof card.runId === 'string' && card.runId.trim()) unmeasuredRunIds.push(card.runId);
      continue;
    }
    seen.add(card.runId);
    valid.push(card);
  }

  const groups = new Map<string, Set<string>>();
  for (const card of valid) {
    const groupId = tcellCauseGroupId(card);
    if (!groupId) continue;
    const members = groups.get(groupId) ?? new Set<string>();
    members.add(card.runId);
    groups.set(groupId, members);
  }

  const counts: Record<TcellHealthClass, number> = { healthy: 0, slow: 0, stalled: 0, infected: 0, zombie: 0 };
  const decisions = valid.map((card): TcellHealthDecision => {
    const causeGroupId = tcellCauseGroupId(card);
    const causeGroupSize = causeGroupId ? groups.get(causeGroupId)?.size : undefined;
    const progressAge = now - (card.progressAt ?? card.startedAt);
    let classification: TcellHealthClass;
    let reason: TcellHealthDecision['reason'];
    if (card.heartbeatAt === null) { classification = 'zombie'; reason = 'heartbeat-missing'; }
    else if (!card.parentPresent) { classification = 'zombie'; reason = 'parent-missing'; }
    else if (card.leaseExpiresAt === null || card.leaseExpiresAt <= now) { classification = 'zombie'; reason = 'lease-expired'; }
    else if (card.riskSignal) { classification = 'infected'; reason = 'risk-signal'; }
    else if ((causeGroupSize ?? 0) >= TCELL_CAUSE_QUORUM) { classification = 'infected'; reason = 'cause-quorum'; }
    else if (progressAge >= TCELL_STALLED_AFTER_MS) { classification = 'stalled'; reason = 'no-progress-30m'; }
    else if (progressAge > card.stageBudgetMs * 2) { classification = 'slow'; reason = 'over-stage-budget'; }
    else { classification = 'healthy'; reason = 'within-stage-budget'; }
    counts[classification] += 1;
    return { runId: card.runId, stage: card.stage, classification, reason,
      ...(causeGroupId ? { causeGroupId, causeGroupSize } : {}) };
  });
  return { total: cards.length, measured: valid.length, unmeasuredRunIds, counts, decisions };
}

/** Scrub before bounding: a token crossing the 200-character boundary must not leak. */
export function incidentLastLines(output: string): string[] {
  return output.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-3)
    .map((line) => redactSecretText(line).slice(0, 200));
}

function safeChildEvidence(value: PodChildEvidence | undefined): PodChildEvidence | undefined {
  if (!value) return undefined;
  const safeText = (text: string): string => redactSecretText(text).slice(0, 200);
  return {
    ...value,
    ...(typeof value.error === 'string' ? { error: safeText(value.error) } : {}),
    ...(typeof value.detail === 'string' ? { detail: safeText(value.detail) } : {}),
    ...(typeof value.stderr === 'string' ? { stderr: safeText(value.stderr) } : {}),
    ...(typeof value.podLogUnavailable === 'string' ? { podLogUnavailable: safeText(value.podLogUnavailable) } : {}),
    ...(Array.isArray(value.podLogTail) ? { podLogTail: value.podLogTail.slice(-3).map(safeText) } : {}),
    ...(value.prFailure && typeof value.prFailure.errorTail === 'string'
      ? { prFailure: { ...value.prFailure, errorTail: safeText(value.prFailure.errorTail) } } : {}),
  };
}

const KST_OFFSET_MS = 9 * 60 * 60_000;
const INCIDENT_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function kstDate(at: number): string {
  return new Date(at + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// ── INCIDENT-REASON-FROM-LASTLINES (0.2.36 · 10-22 · OP 대응 피처) ───────────────────────────────
// 기록된 reason 이 «unknown» 인데 마지막 출력 줄에 사유가 그대로 있는 사고가 다수(10-22 경보) — 읽는 쪽에서
// 결정론으로 다시 분류한다. 꼬리 전체에서 서로 다른 사유가 «정확히 하나» 일 때만 그 사유를 쓰고,
// 0개(무증거)나 2개 이상(충돌)이면 unknown 그대로 둔다(추측 0). 표 순서는 «첫 매치 우선순위»가 아니다.
const LAST_LINE_REASONS: ReadonlyArray<[RegExp, string]> = [
  [/goal-elaboration needs-human:\s*goal-elaboration-ungrounded-path\b/, 'goal-elaboration-ungrounded-path'],
  [/goal-elaboration needs-human:\s*goal-elaboration-protected-path\b/, 'goal-elaboration-protected-path'],
  [/goal-elaboration needs-human:\s*goal-elaboration-scope-conflict\b/, 'goal-elaboration-scope-conflict'],
  [/goal-elaboration needs-human:\s*goal-elaboration-fixed-layer-conflict\b/, 'goal-elaboration-fixed-layer-conflict'],
  [/pod-deadline-exceeded|DeadlineExceeded/, 'pod-deadline-exceeded'],
  [/GOAL_DONE_BOUNDARY_MISSING/, 'goal-done-boundary-missing'],
  [/BackoffLimitExceeded/, 'pod-backoff-limit'],
  [/childError=no-resul/, 'pod-child-no-result'],
  [/pod-job-failed/, 'pod-job-failed'],
  [/DEPENDENCY_NEEDS_HUMAN/, 'dependency-needs-human'],
  [/\[needs-human\]|needs-human/, 'needs-human'],
];
const DEVICE_SLICE_PATH = /src\/ux-sim\/[\w.-]*-device(?:\.test)?\.ts|DEVICE-FIRST/;

// 한 사건을 두 이름으로 서술한 꼬리(상세 표지 ⊕ 일반 표지)는 충돌이 아니다 — 상세 표지가 일반 표지를 흡수한다.
// 서로 다른 사건을 말하는 표지끼리만 충돌이다(예: GOAL_DONE_BOUNDARY_MISSING ⊕ DEPENDENCY_NEEDS_HUMAN).
const REASON_ABSORBS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['goal-elaboration-ungrounded-path', ['needs-human']],
  ['goal-elaboration-protected-path', ['needs-human']],
  ['goal-elaboration-scope-conflict', ['needs-human']],
  ['goal-elaboration-fixed-layer-conflict', ['needs-human']],
  ['goal-done-boundary-missing', ['needs-human']],
  ['pod-backoff-limit', ['pod-job-failed']],
  ['pod-child-no-result', ['pod-job-failed']],
  ['dependency-needs-human', ['needs-human']],
];

/** lastLines 에서 종료 사유를 꺼낸다 — 무증거·충돌이면 null(unknown 유지). */
export function classifyIncidentReasonFromLastLines(lines: readonly string[] | undefined): string | null {
  if (!lines?.length) return null;
  const text = lines.join('\n');
  const matched = LAST_LINE_REASONS.filter(([pattern]) => pattern.test(text)).map(([, reason]) => reason);
  const distinct = [...new Set(matched)].filter(
    (reason) => !REASON_ABSORBS.some(([specific, absorbed]) => specific !== reason && matched.includes(specific) && absorbed.includes(reason)),
  );
  return distinct.length === 1 ? (distinct[0] ?? null) : null;
}

function refinedReasonFields(reason: string, lines: readonly string[] | undefined): Pick<RunExit, 'reason' | 'recordedReason' | 'reasonSource' | 'slice'> {
  const slice = lines?.some((line) => DEVICE_SLICE_PATH.test(line)) ? { slice: 'device' as const } : {};
  if (reason !== 'unknown') return { reason, ...slice };
  const refined = classifyIncidentReasonFromLastLines(lines);
  return refined ? { reason: refined, recordedReason: reason, reasonSource: 'lastLines', ...slice } : { reason, ...slice };
}

/** Read only recorded exits. Missing ledgers are not evidence that no runs failed. */
export function readRunExits(root: string): RunExit[] {
  const dir = join(root, 'incidents');
  if (!existsSync(dir)) return [];
  const rows: RunExit[] = [];
  const seen = new Set<string>();
  for (const file of readdirSync(dir).filter((name) => INCIDENT_FILE.test(name)).sort()) {
    const path = join(dir, file);
    let text: string;
    try {
      if (!statSync(path).isFile()) continue;
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; }
      if (!value || typeof value !== 'object') continue;
      const row = value as Partial<RunExit>;
      if (typeof row.runId !== 'string' || !row.runId.trim() || seen.has(row.runId)
        || typeof row.reason !== 'string' || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at))
        || !(row.status === null || typeof row.status === 'number')
        || !(row.signal === null || typeof row.signal === 'string')) continue;
      seen.add(row.runId);
      const lines = Array.isArray(row.lastLines) && row.lastLines.every((line) => typeof line === 'string') ? row.lastLines : undefined;
      rows.push({ runId: row.runId, ...refinedReasonFields(row.reason, lines), status: row.status, signal: row.signal, at: row.at,
        ...(typeof row.entrance === 'string' ? { entrance: row.entrance } : {}),
        ...(typeof row.seat === 'string' ? { seat: row.seat } : {}),
        ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}),
        ...(typeof row.hostname === 'string' ? { hostname: row.hostname } : {}),
        ...(typeof row.pid === 'number' && Number.isSafeInteger(row.pid) ? { pid: row.pid } : {}),
        ...(Array.isArray(row.lastLines) && row.lastLines.every((line) => typeof line === 'string')
          ? { lastLines: row.lastLines } : {}),
        ...(row.childEvidence && typeof row.childEvidence === 'object' && !Array.isArray(row.childEvidence)
          ? { childEvidence: row.childEvidence } : {}),
        ...podTerminationField(row.podTermination),
        ...terminalEvidenceField(row.terminalEvidence),
      });
    }
  }
  return rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.runId.localeCompare(b.runId));
}

function terminalEvidenceField(value: unknown): { terminalEvidence?: RunExit['terminalEvidence'] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  const attempt = row.attempt;
  const tail = row.childOutputTail;
  const exitCode = row.containerExitCode;
  if (typeof row.job !== 'string' || !row.job.trim() || typeof row.childRunId !== 'string' || !row.childRunId.trim()
    || !(attempt === 'unknown' || (typeof attempt === 'number' && Number.isSafeInteger(attempt) && attempt > 0))
    || !(tail === 'unknown' || (Array.isArray(tail) && tail.every((line) => typeof line === 'string')))
    || !(exitCode === 'unknown' || (typeof exitCode === 'number' && Number.isSafeInteger(exitCode) && exitCode >= 0))
    || typeof row.parentVerdict !== 'string'
    || !(row.failureClassification === undefined || row.failureClassification === null || row.failureClassification === 'unknown' || typeof row.failureClassification === 'string')
    || !(row.terminationReason === undefined || row.terminationReason === null || row.terminationReason === 'unknown' || typeof row.terminationReason === 'string')) return {};
  const childOutputTail = tail === 'unknown' ? tail
    : tail.slice(-3).map((line) => redactSecretText(line).slice(0, 200));
  const failureClassification = row.failureClassification === undefined || row.failureClassification === null
    ? 'unknown' : row.failureClassification === 'unknown' ? 'unknown' : redactSecretText(row.failureClassification).slice(0, 120);
  const terminationReason = row.terminationReason === undefined || row.terminationReason === null
    ? 'unknown' : row.terminationReason === 'unknown' ? 'unknown' : redactSecretText(row.terminationReason).slice(0, 200);
  const childFailureStage = typeof row.childFailureStage === 'string' && row.childFailureStage.trim()
    ? redactSecretText(row.childFailureStage).slice(0, 120) : 'unknown';
  const childRunStatus = readChildRunStatus(row.childRunStatus);
  const shardIdentityReadFailure = row.shardIdentityReadFailure === 'none' || row.shardIdentityReadFailure === 'unknown'
    ? row.shardIdentityReadFailure
    : typeof row.shardIdentityReadFailure === 'string' && row.shardIdentityReadFailure.trim()
      ? redactSecretText(row.shardIdentityReadFailure).slice(0, 120) : 'unknown';
  const providerFailure = row.providerFailure === 'credential-not-configured' || row.providerFailure === 'provider-failed'
    || row.providerFailure === 'none' || row.providerFailure === 'unknown' ? row.providerFailure : 'unknown';
  return { terminalEvidence: { job: row.job, childRunId: row.childRunId, attempt, childOutputTail,
    containerExitCode: exitCode, parentVerdict: row.parentVerdict, failureClassification, terminationReason,
    childFailureStage, childRunStatus, shardIdentityReadFailure, providerFailure } };
}

function readChildRunStatus(value: unknown): NonNullable<RunExit['terminalEvidence']>['childRunStatus'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { stage: 'unknown', status: 'unknown', failureKind: 'unknown' };
  const row = value as Record<string, unknown>;
  const safe = (field: unknown): string | 'unknown' => typeof field === 'string' && field.trim()
    ? redactSecretText(field).slice(0, 120) : 'unknown';
  return { stage: safe(row.stage), status: safe(row.status), failureKind: safe(row.failureKind) };
}

function podTerminationField(value: unknown): { podTermination?: PodTermination } {
  const job = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).job : undefined;
  const parsed = typeof job === 'string' ? parsePodTermination(value, job) : undefined;
  return parsed ? { podTermination: parsed } : {};
}

/** SQLite's process-owned write lock serializes ledger checks and appends across processes. */
export function recordRunExit(row: RunExit, root: string): void {
  if (refuseProductionLedgerWriteInTest(root, 'incidents')) return;
  if (!row.runId?.trim()) return;
  const at = Date.parse(row.at);
  if (!Number.isFinite(at)) throw new Error('invalid incident exit time');
  const dir = join(root, 'incidents');
  mkdirSync(dir, { recursive: true });
  const lock = new Database(join(root, '.incident-write-lock.sqlite'));
  try {
    lock.exec('PRAGMA busy_timeout = 60000');
    lock.exec('BEGIN IMMEDIATE');
    try {
      if (!readRunExits(root).some((record) => record.runId === row.runId)) {
        const terminalEvidence = deriveTerminalEvidence(row, root);
        const safeRow: RunExit = {
          ...row,
          ...(row.lastLines === undefined ? {} : { lastLines: row.lastLines.slice(-3).map((line) => redactSecretText(line).slice(0, 200)) }),
          ...(row.childEvidence === undefined ? {} : { childEvidence: safeChildEvidence(row.childEvidence) }),
          ...(terminalEvidence ? { terminalEvidence } : {}),
        };
        appendFileSync(join(dir, `${kstDate(at)}.jsonl`), `${JSON.stringify(safeRow)}\n`);
      }
      lock.exec('COMMIT');
    } catch (error) {
      lock.exec('ROLLBACK');
      throw error;
    }
  } finally {
    lock.close();
  }
}

/** Join exit facts through the last pod-child-run fence; never borrow a previous Pod attempt. */
function deriveTerminalEvidence(row: RunExit, root: string): RunExit['terminalEvidence'] | undefined {
  let entries: RunLedgerEntry[] | null;
  try { entries = loadRunLedger(row.runId, runLedgerDir(root)); }
  catch { return undefined; /* observing the child ledger cannot block the parent incident record */ }
  if (!entries) return undefined;
  let startIndex = -1;
  entries.forEach((entry, index) => { if (entry.event === 'pod-child-run') startIndex = index; });
  const startEntry = startIndex >= 0 ? entries[startIndex] : undefined;
  const start = startEntry?.data;
  if (!start || typeof start.job !== 'string' || !start.job.trim()
    || typeof start.childRunId !== 'string' || !start.childRunId.trim()) return undefined;
  const currentRows = entries.slice(startIndex + 1).filter((entry) => entry.event === 'pod-child-evidence'
    && entry.data.job === start.job && entry.data.childRunId === start.childRunId).map((entry) => entry.data);
  const evidenceRow = currentRows.slice().reverse().find((data) => Object.hasOwn(data, 'childEvidence'));
  const childEvidence = evidenceRow?.childEvidence && typeof evidenceRow.childEvidence === 'object' && !Array.isArray(evidenceRow.childEvidence)
    ? evidenceRow.childEvidence as Record<string, unknown> : undefined;
  const tailSource = Array.isArray(childEvidence?.podLogTail) && childEvidence.podLogTail.every((line) => typeof line === 'string')
    ? childEvidence.podLogTail
    : typeof childEvidence?.stderr === 'string' ? childEvidence.stderr.split(/\r?\n/) : undefined;
  const childOutputTail = tailSource?.length
    ? tailSource.slice(-3).map((line) => redactSecretText(line).slice(0, 200))
    : 'unknown';
  let termination: PodTermination | undefined;
  for (const data of currentRows.slice().reverse()) {
    termination = parsePodTermination(data.podTermination, start.job);
    if (termination) break;
  }
  const finished = entries.slice(startIndex + 1).slice().reverse().find((entry) => {
    if (entry.event !== 'pod-launch-finished' || entry.data.job !== start.job) return false;
    const childRunId = typeof entry.data.childRun === 'string' ? entry.data.childRun : entry.data.run;
    if (childRunId !== start.childRunId) return false;
    const startAttempt = Number.isSafeInteger(start.attempt) && Number(start.attempt) > 0 ? Number(start.attempt) : undefined;
    const finishAttempt = Number.isSafeInteger(entry.data.attempt) && Number(entry.data.attempt) > 0 ? Number(entry.data.attempt) : undefined;
    return startAttempt === undefined || finishAttempt === startAttempt;
  });
  const classification = finished?.data.failureClassification;
  const terminationReason = finished?.data.terminationReason;
  const childRunDiagnosis = childRunDiagnosisFields(start.childRunId, root, {
    job: start.job,
    attempt: Number.isSafeInteger(start.attempt) && Number(start.attempt) > 0 ? Number(start.attempt) : undefined,
    startedAt: startEntry?.timestamp,
    finishedAt: finished?.timestamp,
  });
  return {
    job: start.job,
    childRunId: start.childRunId,
    attempt: Number.isSafeInteger(start.attempt) && Number(start.attempt) > 0 ? Number(start.attempt) : 'unknown',
    childOutputTail,
    containerExitCode: typeof termination?.exitCode === 'number' ? termination.exitCode : 'unknown',
    parentVerdict: row.reason,
    failureClassification: typeof finished?.data.podExitClass === 'string' && finished.data.podExitClass
      ? redactSecretText(finished.data.podExitClass).slice(0, 120)
      : typeof classification === 'string' && classification ? redactSecretText(classification).slice(0, 120) : 'unknown',
    terminationReason: typeof terminationReason === 'string' && terminationReason ? redactSecretText(terminationReason).slice(0, 200) : 'unknown',
    childFailureStage: typeof finished?.data.childFailureStage === 'string' && finished.data.childFailureStage.trim()
      ? redactSecretText(finished.data.childFailureStage).slice(0, 120) : 'unknown',
    ...childRunDiagnosis,
  };
}

function childRunDiagnosisFields(childRunId: string, root: string, current: {
  job: string; attempt?: number; startedAt?: string; finishedAt?: string;
}): Pick<NonNullable<RunExit['terminalEvidence']>, 'childRunStatus' | 'shardIdentityReadFailure' | 'providerFailure'> {
  let entries: RunLedgerEntry[] | null;
  try { entries = loadRunLedger(childRunId, runLedgerDir(root)); }
  catch { entries = null; }
  const startedAt = typeof current.startedAt === 'string' ? Date.parse(current.startedAt) : NaN;
  const finishedAt = typeof current.finishedAt === 'string' ? Date.parse(current.finishedAt) : NaN;
  if (!entries || !current.job.trim() || current.attempt === undefined
    || !Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) return {
    childRunStatus: { stage: 'unknown', status: 'unknown', failureKind: 'unknown' },
    shardIdentityReadFailure: 'unknown', providerFailure: 'unknown',
  };

  // Child ledgers can outlive a Pod retry that reuses childRunId. Only trust events
  // timestamped inside this parent's exact Job/attempt interval; otherwise report unknown.
  const attemptEntries = entries.filter((entry) => {
    const timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    return Number.isFinite(timestamp) && timestamp >= startedAt && timestamp <= finishedAt;
  });
  const status = attemptEntries.slice().reverse().find((entry) => entry.event === 'run-status')?.data;
  const shardObservation = attemptEntries.slice().reverse().find((entry) => Object.hasOwn(entry, 'shardIdentityReadFailure')
    || entry.event === 'shard-sibling-query');
  // RunLedgerEntry's canonical shard identity is top-level (makeRunObserver writes it there).
  // Accept data.* too for older/imported child rows that nested the field.
  const shardValue = shardObservation?.shardIdentityReadFailure ?? shardObservation?.data.shardIdentityReadFailure;
  const shardFailure = typeof shardValue === 'string' && shardValue !== 'none' && shardValue !== 'unknown' && shardValue.trim()
    ? shardValue : undefined;
  const providerSkip = attemptEntries.slice().reverse().find((entry) => entry.event === 'goal-elaboration-skipped'
    && entry.data.outcome === 'skipped' && entry.data.reason === 'provider-failed');
  const providerError = typeof providerSkip?.data.error === 'string' ? providerSkip.data.error : '';
  const providerFailure: NonNullable<RunExit['terminalEvidence']>['providerFailure'] = providerSkip
    ? /unavailable:\s*configure apiKey/iu.test(providerError) ? 'credential-not-configured' : 'provider-failed'
    : 'unknown';
  const safe = (value: unknown): string | 'unknown' => typeof value === 'string' && value.trim()
    ? redactSecretText(value).slice(0, 120) : 'unknown';
  return {
    childRunStatus: { stage: safe(status?.stage), status: safe(status?.runStatus), failureKind: safe(status?.failureKind) },
    shardIdentityReadFailure: shardFailure ? redactSecretText(shardFailure).slice(0, 120)
      : shardValue === 'unknown' ? 'unknown'
        : shardObservation?.event === 'shard-sibling-query' && shardObservation.data.reason === 'not-sharded' ? 'none' : 'unknown',
    providerFailure,
  };
}

const HOSTNAME_BURST_WINDOW_MS = 60 * 60_000;

function uniqueRunExits(rows: readonly RunExit[]): RunExit[] {
  const unique: RunExit[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.runId || seen.has(row.runId) || !Number.isFinite(Date.parse(row.at))) continue;
    seen.add(row.runId);
    unique.push(row);
  }
  return unique;
}

function groupRunExits(rows: readonly RunExit[], keyOf: (row: RunExit) => string): RunExit[][] {
  const byIdentity = new Map<string, RunExit[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = byIdentity.get(key) ?? [];
    group.push(row);
    byIdentity.set(key, group);
  }
  return [...byIdentity.values()];
}

function burstMemberWindows(group: RunExit[], windowMs: number, threshold: number): RunExit[][] {
  const sorted = group.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.runId.localeCompare(b.runId));
  const windows: RunExit[][] = [];
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && Date.parse(sorted[end]!.at) - Date.parse(sorted[start]!.at) <= windowMs) end++;
    if (end - start < threshold) { start++; continue; }
    windows.push(sorted.slice(start, end));
    start = end;
  }
  return windows;
}

function burstFromMembers(members: RunExit[], extra: Pick<IncidentBurst, 'seat' | 'entrance' | 'hostname'>): IncidentBurst {
  return {
    reason: members[0]!.reason, count: members.length, firstAt: members[0]!.at,
    lastAt: members[members.length - 1]!.at, runIds: members.map((row) => row.runId),
    ...(extra.seat ? { seat: extra.seat } : {}),
    ...(extra.entrance ? { entrance: extra.entrance } : {}),
    ...(extra.hostname ? { hostname: extra.hostname } : {}),
  };
}

/** Non-overlapping windows within each identity; seat and host are independent views of an exit. */
export function detectBursts(rows: readonly RunExit[], { windowMs = 60_000, threshold = 3 }: {
  windowMs?: number; threshold?: number;
} = {}): IncidentBurst[] {
  const unique = uniqueRunExits(rows);
  const bursts: IncidentBurst[] = [];
  for (const group of groupRunExits(unique, (row) => JSON.stringify([row.reason, row.seat ?? null, row.entrance ?? null]))) {
    const { seat, entrance } = group[0]!;
    for (const members of burstMemberWindows(group, windowMs, threshold)) {
      bursts.push(burstFromMembers(members, { ...(seat ? { seat } : {}), ...(entrance ? { entrance } : {}) }));
    }
  }
  for (const group of groupRunExits(unique.filter((row) => row.hostname), (row) => JSON.stringify([row.reason, row.hostname]))) {
    const hostname = group[0]!.hostname;
    for (const members of burstMemberWindows(group, HOSTNAME_BURST_WINDOW_MS, 3)) {
      bursts.push(burstFromMembers(members, { ...(hostname ? { hostname } : {}) }));
    }
  }
  return bursts.sort((a, b) => Date.parse(a.firstAt) - Date.parse(b.firstAt) || a.reason.localeCompare(b.reason));
}

/** Common-cause candidates: same hostname+reason exits within a 60-minute window, across seats and entrances; hostless rows stay unobserved. */
export function detectCommonCauseBursts(rows: readonly RunExit[]): IncidentBurst[] {
  const unique = uniqueRunExits(rows).filter((row) => row.hostname);
  const bursts: IncidentBurst[] = [];
  for (const group of groupRunExits(unique, (row) => JSON.stringify([row.reason, row.hostname]))) {
    const hostname = group[0]!.hostname;
    for (const members of burstMemberWindows(group, HOSTNAME_BURST_WINDOW_MS, 3)) {
      bursts.push(burstFromMembers(members, { ...(hostname ? { hostname } : {}) }));
    }
  }
  return bursts.sort((a, b) => Date.parse(a.firstAt) - Date.parse(b.firstAt) || a.reason.localeCompare(b.reason));
}

export function recentBurst(root: string, now: Date | number, { lookbackMs = 15 * 60_000, seat, entrance }: {
  lookbackMs?: number; seat?: string; entrance?: string;
} = {}): IncidentBurst | null {
  const time = typeof now === 'number' ? now : now.getTime();
  const recent = detectBursts(readRunExits(root)).filter((burst) => {
    const last = Date.parse(burst.lastAt);
    return !burst.hostname && last <= time && last >= time - lookbackMs
      && burst.seat === seat && burst.entrance === entrance;
  });
  return recent.sort((a, b) => Date.parse(a.lastAt) - Date.parse(b.lastAt)).at(-1) ?? null;
}

/** 사고 선례 1건 — 현재 사고 이전의 같은 reason 종료 기록(결정론 · 기록된 실제 exit 만). */
export interface IncidentPrecedent {
  runId: string;
  reason: string;
  status: number | null;
  signal: string | null;
  at: string;
  lastLines?: string[];
}

/**
 * 사고 선례 연결 — 현재 사고(reason·at) 이전에 같은 reason 으로 종료된 기록된 실제 exit 만
 * 돌려준다(유사 과거 지어내기 금지 · readRunExits 재사용 · READ-ONLY). 현재 runId 는 제외하고
 * 시간 내림차순, 기본 5건까지. 기록이 없으면 빈 배열(«기록 없음»).
 */
export function findIncidentPrecedents(
  current: { reason: string; at: string; runId?: string },
  root: string,
  { limit = 5 }: { limit?: number } = {},
): IncidentPrecedent[] {
  const at = Date.parse(current.at);
  if (!current.reason.trim() || !Number.isFinite(at)) return [];
  return readRunExits(root)
    .filter((row) => row.reason === current.reason && row.runId !== current.runId
      && Date.parse(row.at) < at)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.runId.localeCompare(a.runId))
    .slice(0, Math.max(0, limit))
    .map((row) => ({
      runId: row.runId, reason: row.reason, status: row.status, signal: row.signal, at: row.at,
      ...(Array.isArray(row.lastLines) ? { lastLines: row.lastLines } : {}),
    }));
}

export function formatIncidentBurstWarning(burst: IncidentBurst): string {
  const time = new Date(Date.parse(burst.lastAt) + KST_OFFSET_MS).toISOString().slice(11, 16);
  const owner = burst.seat || burst.entrance ? ` [seat=${burst.seat ?? '-'} entrance=${burst.entrance ?? '-'}]` : '';
  return `⚠ 최근 묶음 사고${owner}: ${burst.reason} ×${burst.count} (${time} KST) — 원인 확인 전 재발사는 중복·재사고 위험 · elanous harness incidents`;
}
