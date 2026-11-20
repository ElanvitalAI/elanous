// LLM 지출 예약 원장 — 원자 예약(reserve) · 확정(commit) · 해제(release) (CODEX-SUBSCRIPTION-CREDIT-GUARD · #39172 JUD must②)
//
// ⛔ 결정 함수(decideLlmSpend)는 순수 그대로다. 이 파일은 «상태 저장부» 뿐 — 주입형 인터페이스(SpendReservationLedger)와
//   두 구현(메모리 · 파일 원자 쓰기)을 낸다. «잔여 ≥ 요청 추정액일 때만 차감» 은 결정 함수가 예약 합을 실측에 더해 판정하고,
//   그 판정 + reserve 가 «한 임계 구역» 안에서 일어나도록 runLlmSpendGuard 가 withSpendLock 으로 직렬화한다.
// ⭐ 교차 프로세스: 파일 원장은 O_EXCL 락파일(소유 pid·시각 · 죽은 pid/오래된 락 회수)로 «판정 + 예약» 임계 구역을 프로세스 사이에서도 직렬화한다
//   (withExclusive — runLlmSpendGuard 가 withSpendLock «위에 겹쳐» 쓴다). 변경(reserve/commit/release)은 짧은 동기 락을 잡는다.
// ⭐ 만료: crash 로 commit/release 없이 남은 reserved 는 expiresAt(기본 TTL) 이후 snapshot 에서 빠지고 다음 reserve 때 원장에서 걷힌다.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LlmSpendPolicyRole } from '../nexus/llm-spend-policy/types.js';
import type { SpendReservation } from './llm-spend-decision.js';

export interface SpendReserveInput {
  readonly id: string;
  readonly row: string;
  readonly role?: LlmSpendPolicyRole;
  readonly estimateUsd: number;
  readonly at: string;
  /** 만료 시각(ISO) — 없으면 at + RESERVATION_TTL_MS. */
  readonly expiresAt?: string;
}

export interface SpendReservationLedger {
  /** 현재 원장 스냅샷(예약 중 + 아직 실측에 안 들어온 확정). 만료된 reserved 는 뺀다(now 기본 = 시스템 시각). 결정 함수의 request.reservations 로 넘긴다. */
  snapshot(now?: Date): readonly SpendReservation[];
  /** (선택) 교차 프로세스 배타 구역 — 파일 원장만 구현. 안에서 snapshot→판정→reserve 가 다른 프로세스와 겹치지 않는다. */
  withExclusive?<T>(fn: () => Promise<T>): Promise<T>;
  /** 예약 — 추정액이 유한한 0 이상 수이고 id 가 새것일 때만 차감. 아니면 false(원장 불변). */
  reserve(input: SpendReserveInput): boolean;
  /** 확정 — 실제 지출액으로 바꾼다(실측이 따라잡을 때까지 합에 남는다). 없는 id = false. */
  commit(id: string, actualUsd: number, at: string): boolean;
  /** 해제 — 예약을 없앤다(호출이 안 일어났을 때). 없는 id = false. */
  release(id: string): boolean;
}

/** 확정 후 이 시간이 지난 committed 는 원장에서 걷는다(실측이 이미 따라잡았다고 본다 — 원장 무한 증식 방지). */
export const COMMITTED_RETENTION_MS = 24 * 60 * 60 * 1000; // 출처: #39172 JUD(msg 109296 must②) — 확정 항목 보존 24h(코드 상수 · 일 상한 창과 동일)

/** 예약(reserved) 수명 — 이 시간 안에 commit/release 가 없으면 crash 로 본다(잔여 상한을 영영 막지 않게). */
export const RESERVATION_TTL_MS = 15 * 60 * 1000; // 출처: JUD «배선 전 필수 FU②»(crash 로 남은 reserved 만료 정리) — 초기값 15분(한 LLM 호출 상한보다 길게 · 운영 실측 뒤 조정)

/** 락 파일이 이 시간보다 오래되면 소유 pid 가 살아 있어도 낡은 것으로 회수한다(pid 재사용·멈춘 프로세스 대비). */
export const LOCK_STALE_MS = 60 * 1000; // 출처: JUD «배선 전 필수 FU①»(교차 프로세스 락) — 판정+예약 한 번은 초 단위, 60초면 «멈춘 소유자» 로 본다(초기값)
/** 락 대기 최대 시간 — 넘으면 reserve 거부(fail-closed). */
export const LOCK_WAIT_MS = 10 * 1000; // 출처: JUD «배선 전 필수 FU①» — 초기값 10초(대기 초과 = 차감 0)
const LOCK_POLL_MS = 5; // 출처: 락 폴링 간격 코드 상수(충돌 시 짧게 재시도)

function expiryMs(e: SpendReservation): number {
  const exp = Date.parse((e as SpendReservation & { expiresAt?: string }).expiresAt ?? '');
  if (Number.isFinite(exp)) return exp;
  const at = Date.parse(e.at);
  return Number.isFinite(at) ? at + RESERVATION_TTL_MS : Infinity; // 시각을 모르면 만료시키지 않는다(fail-closed)
}

function isExpiredReserved(e: SpendReservation, nowMs: number): boolean {
  return e.state === 'reserved' && Number.isFinite(nowMs) && expiryMs(e) <= nowMs;
}

function sanitizeEstimate(n: number): boolean { return typeof n === 'number' && Number.isFinite(n) && n >= 0; }

function prune(entries: SpendReservation[], nowIso: string): SpendReservation[] {
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) return entries;
  return entries.filter((e) => !isExpiredReserved(e, now) && (e.state !== 'committed' || !(now - Date.parse(e.committedAt ?? e.at) > COMMITTED_RETENTION_MS)));
}

function applyOps(entries: SpendReservation[]): SpendReservationLedger & { readonly entries: () => SpendReservation[] } {
  // 내부 헬퍼 — 저장 방식과 무관한 변경 로직(메모리 배열 위).
  const self = {
    entries: () => entries,
    snapshot: (now: Date = new Date()) => entries.filter((e) => !isExpiredReserved(e, now.getTime())).map((e) => ({ ...e })),
    reserve(input: SpendReserveInput): boolean {
      if (!sanitizeEstimate(input.estimateUsd) || entries.some((e) => e.id === input.id)) return false;
      const atMs = Date.parse(input.at);
      const expiresAt = input.expiresAt ?? (Number.isFinite(atMs) ? new Date(atMs + RESERVATION_TTL_MS).toISOString() : undefined);
      entries.push({ id: input.id, row: input.row, ...(input.role !== undefined ? { role: input.role } : {}), state: 'reserved', usd: input.estimateUsd, at: input.at, ...(expiresAt !== undefined ? { expiresAt } : {}) });
      return true;
    },
    commit(id: string, actualUsd: number, at: string): boolean {
      const i = entries.findIndex((e) => e.id === id && e.state === 'reserved');
      if (i < 0 || !sanitizeEstimate(actualUsd)) return false;
      entries[i] = { ...entries[i]!, state: 'committed', usd: actualUsd, committedAt: at };
      return true;
    },
    release(id: string): boolean {
      const i = entries.findIndex((e) => e.id === id && e.state === 'reserved');
      if (i < 0) return false;
      entries.splice(i, 1);
      return true;
    },
  };
  return self;
}

export function createInMemoryReservationLedger(): SpendReservationLedger {
  const ops = applyOps([]);
  return {
    snapshot: ops.snapshot,
    reserve: (input) => { const ok = ops.reserve(input); if (ok) { const kept = prune(ops.entries(), input.at); ops.entries().splice(0, ops.entries().length, ...kept); } return ok; },
    commit: ops.commit,
    release: ops.release,
  };
}

// ── 교차 프로세스 락(O_EXCL 락파일) ───────────────────────────────────────────

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function tryCreateLock(lockPath: string): boolean {
  let fd: number;
  try { fd = openSync(lockPath, 'wx', 0o600); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try { writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } finally { closeSync(fd); }
  return true;
}

/** 낡은 락인가 — 소유 pid 가 죽었거나 LOCK_STALE_MS 보다 오래됐다. 내용이 깨졌으면(쓰는 중일 수 있어) 나이로만 본다. */
function lockIsStale(lockPath: string, nowMs: number): boolean {
  let raw: string;
  try { raw = readFileSync(lockPath, 'utf8'); } catch { return false; } // 사라졌다 = 곧 잡을 수 있다
  try {
    const parsed = JSON.parse(raw) as { pid?: number; at?: string };
    const at = Date.parse(parsed.at ?? '');
    if (typeof parsed.pid === 'number' && !pidAlive(parsed.pid)) return true;
    return Number.isFinite(at) && nowMs - at > LOCK_STALE_MS;
  } catch {
    try { return nowMs - statSync(lockPath).mtimeMs > LOCK_STALE_MS; } catch { return false; }
  }
}

/** 낡은 락 회수 — 회수 자체도 `.reclaim` O_EXCL 로 한 번에 한 프로세스만(둘이 서로의 새 락을 지우는 경쟁 방지). */
function reclaimIfStale(lockPath: string): void {
  const reclaim = `${lockPath}.reclaim`;
  if (!tryCreateLock(reclaim)) {
    if (lockIsStale(reclaim, Date.now())) { try { unlinkSync(reclaim); } catch { /* 다른 쪽이 이미 */ } }
    return;
  }
  try { if (lockIsStale(lockPath, Date.now())) { try { unlinkSync(lockPath); } catch { /* 이미 없음 */ } } }
  finally { try { unlinkSync(reclaim); } catch { /* 이미 없음 */ } }
}

function acquireStep(lockPath: string): boolean {
  mkdirSync(dirname(lockPath), { recursive: true });
  if (tryCreateLock(lockPath)) return true;
  reclaimIfStale(lockPath);
  return false;
}

function releaseLock(lockPath: string): void {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number };
    if (parsed.pid !== process.pid) return; // 회수당해 남의 락이 됐으면 건드리지 않는다
    unlinkSync(lockPath);
  } catch { /* 이미 없음 */ }
}

/** 동기 락 — 잡으면 fn 실행 뒤 해제. LOCK_WAIT_MS 안에 못 잡으면 null(호출자는 fail-closed). */
function withLockSync<T>(lockPath: string, fn: () => T): { value: T } | null {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!acquireStep(lockPath)) { if (Date.now() >= deadline) return null; sleepSync(LOCK_POLL_MS); }
  try { return { value: fn() }; } finally { releaseLock(lockPath); }
}

/** 비동기 락 — 판정 + 예약 같은 await 가 낀 구역용. 못 잡으면 throw(guard 가 멈춤으로 바꾼다). */
export async function withCrossProcessLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!acquireStep(lockPath)) {
    if (Date.now() >= deadline) throw new Error(`spend-lock-timeout(${lockPath})`);
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
  try { return await fn(); } finally { releaseLock(lockPath); }
}

/** 파일 원장 — 변경마다 «락 → 읽기 → 변경 → tmp 쓰기 → rename → 해제» (원자 쓰기 + 교차 프로세스 직렬화). 못 읽거나 깨졌거나 락을 못 잡으면 reserve 거부(fail-closed: 모르는 원장에 차감 0). */
export function createFileReservationLedger(path: string): SpendReservationLedger {
  const lockPath = `${path}.lock`;
  let held = 0; // 이 인스턴스가 withExclusive 로 이미 락을 쥔 깊이(같은 프로세스 안 재진입 — 변경은 동기라 끼어들어도 안전)
  const load = (): SpendReservation[] | null => {
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: SpendReservation[] };
      return Array.isArray(parsed.entries) ? parsed.entries : null;
    } catch { return null; }
  };
  const save = (entries: SpendReservation[]): void => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, JSON.stringify({ entries }), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  };
  const mutateUnlocked = (fn: (ops: ReturnType<typeof applyOps>) => boolean, pruneAt?: string): boolean => {
    const loaded = load();
    if (loaded === null) return false;
    const ops = applyOps(pruneAt ? prune(loaded, pruneAt) : loaded);
    const ok = fn(ops);
    if (ok) { try { save(ops.entries()); } catch { return false; } }
    return ok;
  };
  const mutate = (fn: (ops: ReturnType<typeof applyOps>) => boolean, pruneAt?: string): boolean => {
    if (held > 0) return mutateUnlocked(fn, pruneAt);
    try { return withLockSync(lockPath, () => mutateUnlocked(fn, pruneAt))?.value ?? false; } catch { return false; }
  };
  return {
    // 못 읽으면 «무한 예약» 하나가 있는 것처럼 보여 결정 함수가 크레딧을 거부한다(fail-closed). 만료된 reserved 는 뺀다.
    snapshot: (now: Date = new Date()) => {
      const loaded = load();
      return loaded === null
        ? [{ id: 'ledger-unreadable', row: '*', state: 'reserved', usd: NaN, at: '' }]
        : loaded.filter((e) => !isExpiredReserved(e, now.getTime()));
    },
    reserve: (input) => mutate((ops) => ops.reserve(input), input.at),
    commit: (id, actualUsd, at) => mutate((ops) => ops.commit(id, actualUsd, at)),
    release: (id) => mutate((ops) => ops.release(id)),
    withExclusive: async <T,>(fn: () => Promise<T>): Promise<T> => {
      if (held > 0) return fn();
      return withCrossProcessLock(lockPath, async () => { held++; try { return await fn(); } finally { held--; } });
    },
  };
}

// ── 같은 프로세스 직렬화(락/큐) ─────────────────────────────────────────────────

const tails = new WeakMap<object, Promise<unknown>>();

/** key(원장 객체)별 FIFO 직렬화 — fn 들이 겹치지 않고 호출 순서대로 하나씩 돈다. fn 이 throw 해도 다음 것은 진행한다. */
export function withSpendLock<T>(key: object, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  tails.set(key, run.then(() => undefined, () => undefined));
  return run;
}
