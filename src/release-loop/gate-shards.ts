// GATE-LIVE-OBS — 게이트 «조각 상태» 한 장(`<ledger>/release/<v>/gate-logs/cut/shards.json`)의 계약.
// 쓰는 쪽 = gate-node(TC · GATE-TIMEOUT-HEAL) · 읽는 쪽 = /v1/ops/release/runs ⊕ 외출 알림(UX).
// 로그가 아니라 발행 원장 파일인 이유: 게이트 사건은 실행 트리의 test 우주로 가지만 원장은 운영 한 곳이다(TC·OP 10-07 19:12).
// ⛔ 못 읽으면 `null` — 「조각 0」으로 읽지 않는다.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { releaseLedgerRoot } from '../instance/resolve.js';

export const SHARD_STATES = ['pending', 'running', 'stop-requested', 'done', 'retry', 'timeout', 'failed'] as const;
export type ShardState = typeof SHARD_STATES[number];

export interface GateShard {
  id: string;
  state: ShardState;
  /** Kubernetes Job for the current attempt; lets the gate watchdog reconcile a lost completion callback. */
  job?: string;
  /** Attempt identity associated with the currently recorded Job/result marker. */
  attemptId?: string;
  /** Result JSON for the current attempt; retries replace this so an older marker cannot close a new Job. */
  resultFile?: string;
  startedAt?: string;
  endedAt?: string;
  /** 설치(install) 단계에 쓴 초. */
  installSec?: number;
  rc?: number;
  /** 대기 이유(예: «CPU 부족 31.2/32»). pending 일 때 화면이 그대로 보인다. */
  waitReason?: string;
  /** 계획 분 — 남은 시간 추정의 재료. */
  plannedMin?: number;
  /** GATE-MULTI-HOST — 이 조각(가장 최근 시도)이 놓인 풀 멤버(kubectl 컨텍스트). 놓이기 전엔 없다. */
  host?: string;
  /** Gate receipt decision shown to operators; older ledger rows omit these fields. */
  reuseDecision?: 'reuse' | 'rerun';
  reuseReason?: string;
}

/** 게이트 노드의 판정 결과 — 끝난 조각의 rc≠0 을 «새로 생긴 실패»와 «기존 실패»로 가른 수. */
export interface GateShardsVerdict {
  introduced: number;
  preexisting: number;
}

export interface GateShardsFile {
  v: 1;
  version: string;
  /** Graph run that owns this version-scoped board; absent legacy/direct boards are not run-scoped. */
  runId?: string;
  updatedAt: string;
  shards: GateShard[];
  /** 판정이 나기 전에는 없다. 옛 파일(필드 없음)도 그대로 읽는다 — `v` 를 올리지 않는다. */
  verdict?: GateShardsVerdict;
}

export function gateShardsPath(version: string, root: string = releaseLedgerRoot()): string {
  return join(root, 'release', version, 'gate-logs', 'cut', 'shards.json');
}

const str = (value: unknown, max = 160): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function shardOf(value: unknown): GateShard | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = str(raw.id, 80);
  const state = SHARD_STATES.find((s) => s === raw.state);
  if (!id || !state) return null;
  const startedAt = str(raw.startedAt, 40);
  const endedAt = str(raw.endedAt, 40);
  const installSec = num(raw.installSec);
  const rc = num(raw.rc);
  const waitReason = str(raw.waitReason);
  const plannedMin = num(raw.plannedMin);
  const host = str(raw.host, 120);
  const reuseDecision = raw.reuseDecision === 'reuse' || raw.reuseDecision === 'rerun' ? raw.reuseDecision : undefined;
  const reuseReason = str(raw.reuseReason, 240);
  const job = str(raw.job, 120);
  const attemptId = str(raw.attemptId, 120);
  const resultFile = str(raw.resultFile, 200);
  return {
    id, state,
    ...(job ? { job } : {}),
    ...(attemptId ? { attemptId } : {}),
    ...(resultFile ? { resultFile } : {}),
    ...(startedAt ? { startedAt } : {}), ...(endedAt ? { endedAt } : {}),
    ...(installSec !== undefined ? { installSec } : {}), ...(rc !== undefined ? { rc } : {}),
    ...(waitReason ? { waitReason } : {}), ...(plannedMin !== undefined ? { plannedMin } : {}),
    ...(host ? { host } : {}),
    ...(reuseDecision ? { reuseDecision } : {}), ...(reuseReason ? { reuseReason } : {}),
  };
}

export type GateJobTerminal = 'complete' | 'failed';

/** Forget the prior child Job before a shard descends into a retry/split attempt. */
export function beginGateShardAttempt(shard: GateShard, now = new Date()): GateShard {
  const next: GateShard = { ...shard, state: 'retry', startedAt: now.toISOString() };
  delete next.endedAt;
  delete next.waitReason;
  delete next.host;
  delete next.job;
  delete next.resultFile;
  delete next.attemptId;
  return next;
}

/**
 * Close each stale running row when its result marker or Kubernetes Job has terminal evidence.
 * A result marker can close a row even when the Kubernetes status read is unavailable.
 */
export function finalizeTerminalGateShards(
  file: GateShardsFile,
  terminalJobs: ReadonlyMap<string, GateJobTerminal>,
  results: ReadonlyMap<string, { completed?: boolean; jobName?: string; attemptId?: string; jobFailed?: boolean; rc?: number | null; reason?: 'timeout' | 'stall' }>,
  now: Date = new Date(),
  staleAfterMs = 120_000,
): GateShardsFile {
  const active = file.shards.filter((shard) => shard.state === 'running' || shard.state === 'retry' || shard.state === 'stop-requested');
  if (!active.length) return file;
  const at = now.getTime();
  const ready = active.map((shard) => {
    const result = results.get(shard.id);
    const resultTerminal = result?.completed === true && result.jobName === shard.job && result.attemptId === shard.attemptId;
    const k8sTerminal = shard.job ? terminalJobs.get(shard.job) : undefined;
    const startedAt = shard.startedAt ? Date.parse(shard.startedAt) : Number.NaN;
    // A stop request is only intent. A completed result marker can race with a still-live Job,
    // so cancellation is terminal only after the Kubernetes status itself is terminal.
    if (shard.state === 'stop-requested' ? !k8sTerminal : !resultTerminal && !k8sTerminal) return undefined;
    if (shard.state !== 'stop-requested' && (!Number.isFinite(startedAt) || at - startedAt < staleAfterMs)) return undefined;
    return { shard, result, state: shard.state === 'stop-requested' && k8sTerminal === 'failed' ? 'failed' as const : resultTerminal
      ? (result!.reason === 'timeout' ? 'timeout' as const : result!.reason === 'stall' || result!.jobFailed === true ? 'failed' as const : 'done' as const)
      : k8sTerminal === 'failed' ? 'failed' as const : 'done' as const };
  });
  const finalized = ready.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  if (!finalized.length) return file;
  const byId = new Map(finalized.map(({ shard, result, state }) => {
    const current = { ...shard };
    delete current.waitReason;
    return [shard.id, { ...current, state, endedAt: now.toISOString(), ...(result && typeof result.rc === 'number' ? { rc: result.rc } : {}) } satisfies GateShard];
  }));
  return { ...file, updatedAt: now.toISOString(), shards: file.shards.map((shard) => byId.get(shard.id) ?? shard) };
}

function verdictOf(value: unknown): GateShardsVerdict | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const introduced = num(raw.introduced);
  const preexisting = num(raw.preexisting);
  return introduced !== undefined && preexisting !== undefined ? { introduced, preexisting } : undefined;
}

/** 파일이 없거나 깨졌으면 null. 알 수 없는 상태값의 조각은 버리되 파일 전체는 살린다(깨진 verdict 도 필드만 버린다). */
export function readGateShards(path: string): GateShardsFile | null {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = parsed as Record<string, unknown>;
  if (raw.v !== 1 || !Array.isArray(raw.shards)) return null;
  const version = str(raw.version, 40);
  const runId = str(raw.runId, 160);
  const updatedAt = str(raw.updatedAt, 40);
  if (!version || !updatedAt) return null;
  const verdict = verdictOf(raw.verdict);
  return {
    v: 1, version, ...(runId ? { runId } : {}), updatedAt, shards: raw.shards.map(shardOf).filter((s): s is GateShard => s !== null),
    ...(verdict ? { verdict } : {}),
  };
}

/** tmp → rename — 읽는 쪽이 반쯤 쓴 파일을 보지 않게. */
export function writeGateShards(path: string, file: GateShardsFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file)}\n`);
  renameSync(tmp, path);
}

/** Serialize read/modify/write updates across gate runner, stop command, and observer processes. */
export function updateGateShards(path: string, update: (current: GateShardsFile) => GateShardsFile | null, initial?: GateShardsFile): GateShardsFile | null {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 5_000;
  let lock: number | undefined;
  while (lock === undefined) {
    try { lock = openSync(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw error;
      // Never unlink an apparently stale lock: checking its owner and then unlinking is a TOCTOU
      // race that can remove a new owner's lock. Wait for release and fail closed on timeout.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    writeSync(lock, `${process.pid}\n`);
    const current = readGateShards(path) ?? initial ?? null;
    if (!current) return null;
    const next = update(current);
    if (!next) return null;
    if (next === current) return current;
    writeGateShards(path, next);
    return next;
  } finally {
    closeSync(lock);
    try { unlinkSync(lockPath); } catch { /* lock cleanup is best effort */ }
  }
}

/** Apply a runner snapshot's changed rows to the latest board while preserving concurrent rows and stop intent. */
export function mergeGateShardBoardChanges(current: GateShardsFile, previous: readonly GateShard[], desired: readonly GateShard[], now = new Date(), allowStopFinalize = false): GateShardsFile {
  const before = new Map(previous.map((shard) => [shard.id, shard]));
  const incoming = new Map(desired.map((shard) => [shard.id, shard]));
  const rows = new Map(current.shards.map((shard) => [shard.id, shard]));
  for (const shard of desired) {
    if (JSON.stringify(before.get(shard.id)) === JSON.stringify(shard)) continue;
    const existing = rows.get(shard.id);
    if (existing?.state === 'stop-requested' && !(allowStopFinalize && (shard.state === 'done' || shard.state === 'failed' || shard.state === 'timeout'))) continue;
    const prior = before.get(shard.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(prior) && JSON.stringify(existing) !== JSON.stringify(shard)) continue;
    rows.set(shard.id, shard);
  }
  for (const shard of current.shards) if (!incoming.has(shard.id)) rows.set(shard.id, shard);
  return { ...current, updatedAt: now.toISOString(), shards: [...rows.values()] };
}

/** Record cancellation intent without claiming a still-running Kubernetes Job has terminated. */
export function markGateShardsStopRequested(path: string, runId: string, now: Date = new Date()): GateShardsFile | null {
  return updateGateShards(path, (file) => requestGateShardsStop(file, runId, now));
}

export function requestGateShardsStop(file: GateShardsFile, runId: string, now: Date = new Date()): GateShardsFile | null {
  if (file.runId !== runId) return null;
  const shards = file.shards.map((shard) => shard.state === 'running' || shard.state === 'pending' || shard.state === 'retry'
    ? { ...shard, state: 'stop-requested' as const, waitReason: 'graph-run-stop-requested' } : shard);
  if (shards.every((shard, index) => shard === file.shards[index])) return file;
  return { ...file, updatedAt: now.toISOString(), shards };
}

/**
 * GATE-LIVE-OBS-RC-WORDING ⓒ — the gate node writes its verdict into the board it already keeps, after judging.
 * No board (a local, non-Pod gate) ⇒ false and nothing is written: a verdict never creates a board out of thin air.
 */
export function recordGateShardsVerdict(path: string, verdict: GateShardsVerdict, now: Date = new Date()): boolean {
  return updateGateShards(path, (file) => ({ ...file, updatedAt: now.toISOString(), verdict })) !== null;
}

export interface GateShardsSummary {
  total: number;
  counts: Record<ShardState, number>;
  /** 대기 이유별 조각 수(많은 순). */
  waitReasons: Array<{ reason: string; count: number }>;
  /** 남은 분 추정 — 계획 분이 모자라면 null(«추정 불가»). */
  etaMin: number | null;
  /** 끝났지만 rc≠0 인 조각 수 — 쓰는 쪽의 `done` 은 «조각 끝»일 뿐 «통과»가 아니다(판정은 게이트 노드가 기존/새로 가른다).
   *  0.2.20 컷 실측: 끝난 넷이 모두 rc 1 인데 화면이 «통과»로 읽었다. */
  doneWithFailures: number;
  /** 게이트 노드의 판정(기존/새로). null = «판정 전» — 「새 실패 0」과 다른 값이다.
   *  `summarizeShards` 는 늘 채운다(선택 필드인 것은 이 요약을 손으로 만드는 픽스처·읽는 쪽을 깨지 않으려는 것). */
  verdict?: GateShardsVerdict | null;
  /** 도는 조각 중 계획 분을 가장 많이 넘긴 분(없으면 0). 넘겼으면 etaMin 은 «하한»일 뿐이라 화면이 그렇게 말한다
   *  — canary 10-07 실측: 계획 0.1분 · 실제 22분 → 넘김을 안 보이면 내내 «남은 약 0분». */
  overrunMin: number;
  /** 파일이 마지막으로 바뀐 뒤 지난 분. 크면 쓰는 쪽이 멎었다는 뜻이다. */
  staleMin: number | null;
}

const minutesBetween = (fromIso: string | undefined, now: number): number | null => {
  const at = fromIso ? Date.parse(fromIso) : Number.NaN;
  return Number.isFinite(at) ? Math.max(0, (now - at) / 60_000) : null;
};

/**
 * 남은 시간 추정: 도는 조각은 «계획 − 경과», 기다리는 조각(pending·retry)은 계획 분을 지금 도는 자리 수로 나눠 뒤에 잇는다.
 * 도는 조각이 없으면 자리 1로 본다. 계획 분이 없는 조각이 하나라도 남아 있으면 null.
 */
function estimate(shards: GateShard[], now: number): number | null {
  if (shards.some((s) => s.state === 'stop-requested')) return null;
  const running = shards.filter((s) => s.state === 'running');
  const waiting = shards.filter((s) => s.state === 'pending' || s.state === 'retry');
  if (!running.length && !waiting.length) return 0;
  if ([...running, ...waiting].some((s) => s.plannedMin === undefined)) return null;
  const runningLeft = running.map((s) => Math.max(0, s.plannedMin! - (minutesBetween(s.startedAt, now) ?? 0)));
  const slots = Math.max(1, running.length);
  const waitingSum = waiting.reduce((sum, s) => sum + s.plannedMin!, 0);
  return Math.ceil(Math.max(0, ...runningLeft) + waitingSum / slots);
}

export function summarizeShards(file: GateShardsFile, now: number = Date.now()): GateShardsSummary {
  const counts = Object.fromEntries(SHARD_STATES.map((s) => [s, 0])) as Record<ShardState, number>;
  const reasons = new Map<string, number>();
  for (const shard of file.shards) {
    counts[shard.state] += 1;
    if (shard.waitReason && (shard.state === 'pending' || shard.state === 'retry' || shard.state === 'stop-requested')) {
      reasons.set(shard.waitReason, (reasons.get(shard.waitReason) ?? 0) + 1);
    }
  }
  const stale = minutesBetween(file.updatedAt, now);
  const overrun = Math.max(0, ...file.shards
    .filter((s) => s.state === 'running' && s.plannedMin !== undefined)
    .map((s) => (minutesBetween(s.startedAt, now) ?? 0) - s.plannedMin!));
  return {
    total: file.shards.length,
    counts,
    waitReasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    doneWithFailures: file.shards.filter((s) => s.state === 'done' && s.rc !== undefined && s.rc !== 0).length,
    verdict: file.verdict ?? null,
    etaMin: estimate(file.shards, now),
    overrunMin: Math.floor(overrun),
    staleMin: stale === null ? null : Math.floor(stale),
  };
}

export const SHARD_WORD: Record<ShardState, string> = {
  pending: '대기', running: '돌기', 'stop-requested': '종료 확인 대기', done: '끝', retry: '재시도', timeout: '잘림', failed: '실패',
};

/**
 * `끝` 꼬리. 기존 실패가 있는 판에선 조각 전부가 rc 1 로 끝난다(0.2.21 컷: 24/24) — 그래서 판정 전엔 rc≠0 을 «실패»라 부르지 않고,
 * 판정 뒤엔 새로 생긴 실패만 싣는다(기존 실패 수는 줄에 안 싣는다).
 */
function doneTail(summary: GateShardsSummary): string {
  if (summary.verdict) return summary.verdict.introduced > 0 ? `(새 실패 ${summary.verdict.introduced})` : '';
  return summary.doneWithFailures ? `(rc≠0 ${summary.doneWithFailures} · 기존 실패 포함 · 판정 전)` : '';
}

/** 외출 알림·/release 한 줄 — «조각 24 · 돌기 5 · 대기 8(CPU 부족 8) · 잘림 2 · 끝 9(rc≠0 3 · 기존 실패 포함 · 판정 전) · 남은 약 40분». */
export function shardsLine(summary: GateShardsSummary): string {
  const order: ShardState[] = ['running', 'stop-requested', 'pending', 'retry', 'timeout', 'failed', 'done'];
  const parts = [`조각 ${summary.total}`];
  for (const state of order) {
    const n = summary.counts[state];
    if (!n) continue;
    const why = state === 'pending' && summary.waitReasons.length
      ? `(${summary.waitReasons.slice(0, 2).map((w) => `${w.reason} ${w.count}`).join(' · ')})` : '';
    const reported = state === 'done' ? doneTail(summary) : '';
    parts.push(`${SHARD_WORD[state]} ${n}${why}${reported}`);
  }
  if (summary.overrunMin >= 1) parts.push(`계획보다 ${summary.overrunMin}분 넘게 도는 중 — 남은 시간 추정 불가`);
  else parts.push(summary.etaMin === null ? '남은 시간 추정 불가(계획 분 없음)' : `남은 약 ${summary.etaMin}분`);
  if (summary.staleMin !== null && summary.staleMin >= 15) parts.push(`⚠️ ${summary.staleMin}분째 갱신 없음`);
  return parts.join(' · ');
}
