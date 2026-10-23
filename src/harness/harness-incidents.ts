import { Database } from 'bun:sqlite';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecretText } from '../debug/log.js';
import { refuseProductionLedgerWriteInTest } from './ledger-write-guard.js';
import type { PodChildEvidence } from '../task-orchestrator/surfaces/self-implement.js';
import { parsePodTermination, type PodTermination } from '../task-orchestrator/surfaces/pod-failure-reason.js';

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

/** Scrub before bounding: a token crossing the 200-character boundary must not leak. */
export function incidentLastLines(output: string): string[] {
  return output.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-3)
    .map((line) => redactSecretText(line).slice(0, 200));
}

const KST_OFFSET_MS = 9 * 60 * 60_000;
const INCIDENT_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function kstDate(at: number): string {
  return new Date(at + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// ── INCIDENT-REASON-FROM-LASTLINES (0.2.36 · 10-22 · OP 대응 피처) ───────────────────────────────
// 기록된 reason 이 «unknown» 인데 마지막 출력 줄에 사유가 그대로 있는 사고가 다수(10-22 경보) — 읽는 쪽에서
// 결정론으로 다시 분류한다. 우선순위 = 더 구체적인 종료 사유 먼저. 아무것도 안 맞으면 unknown 그대로(추측 0).
const LAST_LINE_REASONS: ReadonlyArray<[RegExp, string]> = [
  // 근본 원인 먼저 — 뒤 조각의 DEPENDENCY_NEEDS_HUMAN 은 앞 조각 실패의 «증상»이라 맨 뒤 쪽.
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

/** lastLines 에서 종료 사유를 꺼낸다 — 안 맞으면 null(unknown 유지). */
export function classifyIncidentReasonFromLastLines(lines: readonly string[] | undefined): string | null {
  if (!lines?.length) return null;
  const text = lines.join('\n');
  for (const [pattern, reason] of LAST_LINE_REASONS) if (pattern.test(text)) return reason;
  return null;
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
      });
    }
  }
  return rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.runId.localeCompare(b.runId));
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
        const safeRow = row.lastLines === undefined ? row : {
          ...row, lastLines: row.lastLines.slice(-3).map((line) => redactSecretText(line).slice(0, 200)),
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
