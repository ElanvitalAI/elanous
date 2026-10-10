// FU3 (PLAN-config-unification-elanous-root-2026-05-10 closing follow-up):
//   Cross-process advisory file lock for read-modify-write of the
//   unified `~/.elanous/config.json`.
//
// Primitive: `fs.openSync(path, 'wx')` is an atomic exclusive-create —
// the second concurrent caller fails with EEXIST. Holder writes its PID
// to the lock file (debuggability) and unlinks on release.
//
// Stale lock detection: if the lock's mtime is older than STALE_MS, we
// assume the previous holder crashed mid-write and steal it. This keeps
// us from getting wedged after a kill -9.
//
// Limits:
//   - Synchronous wait via short busy-loop · contention is expected to
//     be rare so this is acceptable. Async variant deferred.
//   - The current saveUserConfig contract gives last-writer-wins atomic
//     consistency via tmp+rename even WITHOUT this lock. The lock adds
//     mutual exclusion across the read-modify-write boundary so two
//     concurrent writers don't lose updates relative to each other.

import {
  closeSync, fstatSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';

const STALE_MS = 30_000;
const RETRY_BUSY_MS = 25;
const MAX_TRIES = 240; // ~6s upper bound

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

function busyWaitMs(ms: number): void {
  // ⭐ A real sleep, not a CPU spin — a waiter may wait minutes (pod image ship lock, 10-08 flood).
  try { Atomics.wait(SLEEP_CELL, 0, 0, ms); return; }
  catch { /* Atomics.wait unavailable on this thread · fall back to the spin */ }
  const target = Date.now() + ms;
  while (Date.now() < target) { /* spin */ }
}

export interface LockOpts {
  staleMs?: number;
  retryBusyMs?: number;
  maxTries?: number;
  /**
   * Sync lock only: also break the lock when the pid on its first line is a dead process
   * (a holder killed with -9 must not wedge waiters for `staleMs`).
   */
  breakDeadHolder?: boolean;
  /** Called once, the first time the lock is found held by someone else. */
  onWait?: (holder: string) => void;
}

function holderIsDead(lockPath: string): boolean {
  let pid: number;
  try { pid = Number.parseInt(readFileSync(lockPath, 'utf8').split(/[\n:]/)[0] ?? '', 10); }
  catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return false; }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'ESRCH'; }
}

export type ReleaseLock = () => void;

export function acquireLockSync(lockPath: string, opts: LockOpts = {}): ReleaseLock {
  const staleMs = opts.staleMs ?? STALE_MS;
  const retryBusyMs = opts.retryBusyMs ?? RETRY_BUSY_MS;
  const maxTries = opts.maxTries ?? MAX_TRIES;
  let waited = false;

  for (let attempt = 0; attempt < maxTries; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      try { writeSync(fd, `${process.pid}\n`); }
      catch { /* metadata only · not fatal */ }
      const acquired = fstatSync(fd);
      closeSync(fd);
      return () => {
        try {
          if (statSync(lockPath).ino === acquired.ino) unlinkSync(lockPath);
        } catch { /* stale recovery or replacement won the path */ }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      // Lock exists · check for staleness.
      try {
        const seen = statSync(lockPath);
        const age = Date.now() - seen.mtimeMs;
        if (age > staleMs || (opts.breakDeadHolder && holderIsDead(lockPath))) {
          // Narrow the race: only unlink the file we judged (a fresh holder may have replaced it meanwhile).
          try { if (statSync(lockPath).ino === seen.ino) unlinkSync(lockPath); } catch { /* race · retry */ }
          continue;
        }
      } catch {
        // Race: lock disappeared between EEXIST and stat → retry.
        continue;
      }
      if (!waited && opts.onWait) {
        waited = true;
        let holder = '';
        try { holder = readFileSync(lockPath, 'utf8').trim(); } catch { /* gone */ }
        try { opts.onWait(holder); } catch { /* observer only */ }
      }
      busyWaitMs(retryBusyMs);
    }
  }

  throw new Error(`acquireLockSync: timed out at ${lockPath} after ${maxTries} attempts`);
}

/**
 * ⭐ 위 머리말이 미뤄 둔 **async 변형**. 같은 의미론(원자 배타 생성 · stale 회수 · inode 확인 해제)인데
 * 대기가 **busy-loop 이 아니라 await** 다. ⛔ 동기 변형은 이벤트 루프를 막아서, 같은 프로세스 안 두
 * async 변경이 서로를 기다리면 **먼저 잡은 쪽이 해제하지 못해** 둘 다 실패한다(실측: 큐 동시성 테스트 2건).
 */
/**
 * 비동기 잠금 핸들.
 *
 * ⛔ `acquireLockSync` 는 **함수 하나**를 돌려주는데 이쪽은 객체다. 이유는 `stillHeld()` 다 —
 *   mtime 기반 stale 회수는 *"멈췄다가 되살아난 정상 보유자"* 를 **원리적으로 완전히는** 가려낼 수
 *   없다(POSIX 에 fd 기준 unlink 가 없다). ⇒ 오판을 0 으로 만들려 하지 말고, 오판당한 보유자가
 *   **그 사실을 알고 쓰기를 포기**하게 만든다.
 */
export interface AsyncLockHandle {
  /** 잠금을 놓는다. 이미 남의 것이 됐으면 건드리지 않는다. */
  release(): void;
  /** ⭐ **쓰기 직전에 묻는다.** 탈취당했으면 false — 임계구역의 쓰기를 fail-closed 로 막는 관문. */
  stillHeld(): boolean;
}

export async function acquireLockAsync(lockPath: string, opts: LockOpts = {}): Promise<AsyncLockHandle> {
  const staleMs = opts.staleMs ?? STALE_MS;
  const retryBusyMs = opts.retryBusyMs ?? RETRY_BUSY_MS;
  const maxTries = opts.maxTries ?? MAX_TRIES;
  // ⭐ **heartbeat** — 보유자가 mtime 을 주기적으로 갱신한다. 이것이 없으면 오래 걸리는 **정상** 보유를
  //   다른 프로세스가 stale 로 오인해 탈취하고 갱신이 유실된다(리뷰 must-fix). 갱신 주기는 stale 의 1/3.
  const heartbeatMs = Math.max(50, Math.floor(staleMs / 3));
  // ⭐ **소유 토큰** — inode 보다 강하다(inode 는 재사용된다). 파일 내용이 곧 소유 증명이다.
  const token = `${process.pid}:${randomUUID()}`;
  let waited = false;

  for (let attempt = 0; attempt < maxTries; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      try { writeSync(fd, `${token}\n`); }
      finally { closeSync(fd); }

      let lost = false;
      const ownsFile = (): boolean => {
        try { return readFileSync(lockPath, 'utf8').trim() === token; }
        catch { return false; }
      };
      const beat = setInterval(() => {
        if (lost) return;
        // ⭐ 탈취를 **보유자가 스스로 안다** — 토큰이 사라졌거나 남의 것이면 그 순간부터 lost 다.
        if (!ownsFile()) { lost = true; clearInterval(beat); return; }
        try { const now = new Date(); utimesSync(lockPath, now, now); }
        catch { lost = true; clearInterval(beat); }
      }, heartbeatMs);
      (beat as unknown as { unref?: () => void }).unref?.();

      return {
        release: () => {
          clearInterval(beat);
          // ⛔ 내 토큰일 때만 지운다 — 아니면 **남의 잠금을 지우는 것**이다.
          if (ownsFile()) { try { unlinkSync(lockPath); } catch { /* 이미 회수됨 */ } }
        },
        stillHeld: () => !lost && ownsFile(),
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      try {
        const observed = statSync(lockPath);
        if (Date.now() - observed.mtimeMs > staleMs) {
          // ⭐ **원자적 클레임** — `unlink` 가 아니라 `rename` 으로 뺏는다.
          //   ⓐ `rename` 은 원자라 여러 회수자 중 **하나만** 이긴다. 각자 unlink 후 create 하면
          //      둘 다 *"내가 잡았다"* 고 믿는 창이 생긴다.
          //   ⓑ 뺏긴 보유자는 다음 heartbeat 에서 **토큰이 사라진 것을 보고 스스로 `lost`** 가 되고,
          //      그 뒤의 쓰기는 `stillHeld()` 가 막는다 ⇒ stale 오판이 **데이터 손상으로 번지지 않는다**.
          //   ⚠️ 이것이 요점이다 — 오판 자체를 0 으로 만드는 것이 아니라 **결과를 무해하게** 만든다.
          const claimed = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
          try { renameSync(lockPath, claimed); }
          catch { continue; }   // 남이 먼저 이겼다 · 재시도
          try { unlinkSync(claimed); } catch { /* 남겨져도 다음 회수에 방해되지 않는다 */ }
          continue;
        }
      } catch {
        continue;
      }
      if (!waited && opts.onWait) {
        waited = true;
        let holder = '';
        try { holder = readFileSync(lockPath, 'utf8').trim(); } catch { /* gone */ }
        try { opts.onWait(holder); } catch { /* observer only */ }
      }
      await new Promise((resolve) => { setTimeout(resolve, retryBusyMs); });
    }
  }

  throw new Error(`acquireLockAsync: timed out at ${lockPath} after ${maxTries} attempts`);
}

/** Convenience: acquire → run → always release (even on throw). */
export function withFileLockSync<T>(
  lockPath: string,
  fn: () => T,
  opts?: LockOpts,
): T {
  const release = acquireLockSync(lockPath, opts);
  try { return fn(); }
  finally { release(); }
}
