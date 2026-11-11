// FU3 (PLAN-config-unification-elanous-root-2026-05-10 closing follow-up):
//   src/storage/file-lock.ts — cross-process advisory lock primitive
//   used by saveUserConfig + patchUserConfig.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLockAsync, acquireLockSync, withFileLockSync,
} from '../src/storage/file-lock';

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
  lockPath = join(dir, 'config.lock');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('acquireLockSync', () => {
  test('first acquire succeeds and creates lock file', () => {
    const release = acquireLockSync(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test('lock file contains the holder PID', () => {
    const release = acquireLockSync(lockPath);
    const content = require('node:fs').readFileSync(lockPath, 'utf-8');
    expect(content.trim()).toBe(String(process.pid));
    release();
  });

  test('second acquire while held → times out', () => {
    const release = acquireLockSync(lockPath);
    // Tight retry budget for fast test; would otherwise busy-wait 6s.
    expect(() => acquireLockSync(lockPath, { maxTries: 3, retryBusyMs: 5 }))
      .toThrow(/timed out/);
    release();
  });

  test('release allows next acquire to succeed', () => {
    const r1 = acquireLockSync(lockPath);
    r1();
    const r2 = acquireLockSync(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    r2();
  });

  test('stale lock (mtime > staleMs ago) is stolen', () => {
    // Plant an aged lock file simulating crashed holder.
    writeFileSync(lockPath, '99999\n');
    const past = (Date.now() / 1000) - 60; // 1 minute ago
    utimesSync(lockPath, past, past);

    const release = acquireLockSync(lockPath, { staleMs: 30_000 });
    expect(existsSync(lockPath)).toBe(true);
    // Stolen → recreated → mtime should be near now.
    const age = Date.now() - statSync(lockPath).mtimeMs;
    expect(age).toBeLessThan(2000);
    release();
  });

  test('non-stale held lock is NOT stolen', () => {
    writeFileSync(lockPath, '12345\n');
    // mtime stays at "now" implicitly → not stale.
    expect(() => acquireLockSync(lockPath, { staleMs: 30_000, maxTries: 3, retryBusyMs: 5 }))
      .toThrow(/timed out/);
  });
});

describe('withFileLockSync', () => {
  test('runs body and releases on success', () => {
    const result = withFileLockSync(lockPath, () => 42);
    expect(result).toBe(42);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('releases lock even when body throws', () => {
    expect(() => withFileLockSync(lockPath, () => {
      throw new Error('body failure');
    })).toThrow('body failure');
    expect(existsSync(lockPath)).toBe(false);
  });

  test('serializes nested calls (re-entry → timeout)', () => {
    expect(() => withFileLockSync(lockPath, () => {
      // Inner attempt should time out since outer still holds.
      return withFileLockSync(lockPath, () => 'inner', { maxTries: 3, retryBusyMs: 5 });
    })).toThrow(/timed out/);
    // After throw, lock cleaned up.
    expect(existsSync(lockPath)).toBe(false);
  });
});

// ⛔⭐ 리뷰가 **세 라운드 연속** 든 것: mtime 기반 stale 회수는 *"멈췄다가 되살아난 정상 보유자"* 를
//   원리적으로 완전히는 가려낼 수 없다(POSIX 에 fd 기준 unlink 가 없다). ⇒ 오판을 0 으로 만들려 하지
//   말고 **오판의 결과를 무해하게** 만든다 — 뺏긴 보유자가 그것을 **알고** 쓰기를 포기한다.
describe('acquireLockAsync — 탈취를 보유자가 안다 (fail-closed)', () => {
  test('stillHeld() flips to false when another holder takes the path', async () => {
    const lock = await acquireLockAsync(lockPath, { staleMs: 1_000 });
    expect(lock.stillHeld()).toBe(true);

    // 다른 보유자가 회수해 갔다 — 토큰이 바뀐다(inode 가 아니라 **내용**이 소유 증명이다).
    writeFileSync(lockPath, 'someone-else\n');
    expect(lock.stillHeld()).toBe(false);

    // ⭐ 그리고 release 가 **남의 잠금을 지우지 않는다**.
    lock.release();
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8').trim()).toBe('someone-else');
  });

  test('a stale lock is reclaimed atomically and the evicted holder reports the loss', async () => {
    const stalled = await acquireLockAsync(lockPath, { staleMs: 50 });
    expect(stalled.stillHeld()).toBe(true);
    const firstToken = readFileSync(lockPath, 'utf8').trim();

    // 보유자가 멈춘 것처럼 mtime 을 과거로 돌린다(heartbeat 가 못 돈 상태).
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    // 두 번째 획득자가 stale 을 회수한다 — rename 클레임이라 하나만 이긴다.
    const reclaimer = await acquireLockAsync(lockPath, { staleMs: 50, retryBusyMs: 5 });
    expect(reclaimer.stillHeld()).toBe(true);
    expect(readFileSync(lockPath, 'utf8').trim()).not.toBe(firstToken);

    // ⭐ 핵심 — 뺏긴 쪽이 **자기가 더 이상 보유자가 아님을 안다**. 이것이 있으면 stale 오판이
    //   "두 writer" 가 아니라 "한 쪽이 멈춤" 으로 끝난다.
    expect(stalled.stillHeld()).toBe(false);

    // 뺏긴 쪽의 release 는 새 보유자의 잠금을 건드리지 않는다.
    stalled.release();
    expect(reclaimer.stillHeld()).toBe(true);
    reclaimer.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test('a live lock is not stolen and stays with its holder', async () => {
    const lock = await acquireLockAsync(lockPath, { staleMs: 10_000 });
    await expect(acquireLockAsync(lockPath, { staleMs: 10_000, maxTries: 3, retryBusyMs: 5 }))
      .rejects.toThrow(/timed out/);
    expect(lock.stillHeld()).toBe(true);
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test('breakDeadHolder does not evict a live async holder just because its heartbeat is old', async () => {
    // Source: #36315 short fixture lease and old mtime force stale-age path while owner PID stays alive.
    const lock = await acquireLockAsync(lockPath, { staleMs: 50, breakDeadHolder: true });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    // Source: #36315 retry bounds make the held-lock timeout deterministic in the fixture.
    await expect(acquireLockAsync(lockPath, { staleMs: 50, breakDeadHolder: true, maxTries: 3, retryBusyMs: 5 }))
      .rejects.toThrow(/timed out/);
    expect(lock.stillHeld()).toBe(true);
    lock.release();
  });
});
