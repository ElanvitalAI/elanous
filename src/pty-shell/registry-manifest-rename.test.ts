import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const repo = new URL('../..', import.meta.url).pathname;

function runRename(stateDir: string, failManifest = false): string {
  const script = `
    import { startPty, renamePty, setPtyAdapterForTesting, unregisterPty } from './src/pty-shell/registry.ts';
    import { getPtyManifest, listPtyManifest } from './src/pty-shell/pty-manifest.ts';
    import { resolvePtyRef } from './src/pty-shell/pty-ref.ts';
    setPtyAdapterForTesting(() => ({ pid: 1, write() {}, kill() {}, resize() {}, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) }));
    const handle = startPty({ cmd: 'x', detach: true });
    const renamed = renamePty(handle.id, 'later-name');
    const renamedState = { renamed, nickname: handle.nickname, manifest: getPtyManifest(handle.id)?.nickname };
    handle.setNickname('  direct-name  ');
    const directState = { nickname: handle.nickname, manifest: getPtyManifest(handle.id)?.nickname };
    const remoteRef = resolvePtyRef('direct-name', listPtyManifest().map(({ id, kind, nickname }) => ({ id, kind, nickname }))).match?.id;
    handle.setNickname('   ');
    const clearedState = { nickname: handle.nickname, manifest: getPtyManifest(handle.id)?.nickname };
    console.log(JSON.stringify({ renamedState, directState, remoteRef, clearedState }));
    unregisterPty(handle.id);
    process.exit(0);
  `;
  const result = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: repo,
    env: { ...process.env, NODE_ENV: 'production', ELANOUS_STATE_DIR: stateDir, ...(failManifest ? { ELANOUS_STATE_DIR: '/dev/null/blocked' } : {}) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode).toBe(0);
  return new TextDecoder().decode(result.stdout).trim();
}

function runOutputTotalOnExit(stateDir: string, failedExitFlushes = 0): unknown {
  const script = `
    import { Database } from 'bun:sqlite';
    import { startPty, setPtyAdapterForTesting, unregisterPty } from './src/pty-shell/registry.ts';
    import { getPtyManifest } from './src/pty-shell/pty-manifest.ts';
    let onData;
    let onExit;
    setPtyAdapterForTesting(() => ({
      pid: 1, write() {}, kill() {}, resize() {},
      onData(cb) { onData = cb; return { dispose() {} }; },
      onExit(cb) { onExit = cb; return { dispose() {} }; },
    }));
    const handle = startPty({ cmd: 'x', detach: true });
    onData('a');
    const afterFirst = getPtyManifest(handle.id)?.outputBytesTotal;
    let outputUpdateAttempts = 0;
    const scheduled = new Map();
    let timerSequence = 0;
    const runNextTimer = () => {
      const next = scheduled.entries().next().value;
      if (!next) return false;
      const [timer, callback] = next;
      scheduled.delete(timer);
      callback();
      return true;
    };
    // ⛔⭐ 타이머 스텁은 «두 번째 onData 앞»에 선다 — throttle 이 막은 출력도 trailing flush 를
    //   예약하므로(회귀 #7471 리뷰 must-fix), 스텁을 뒤에 두면 그 예약이 «진짜» 타이머로 새어
    //   통제 시계 밖에서 잡히고 이후 재시도 사슬이 「이미 예약됨」 가드에 막힌다.
    //   ⚠️ Database 스텁은 «그대로 뒤에» 둔다 — 앞으로 옮기면 첫 flush 까지 실패로 세어 계수가 달라진다.
    if (${failedExitFlushes} > 0) {
      globalThis.setTimeout = (callback) => {
        const timer = { id: ++timerSequence, unref() {} };
        scheduled.set(timer, callback);
        return timer;
      };
      globalThis.clearTimeout = (timer) => { scheduled.delete(timer); };
    }
    onData('한');
    const beforeExit = getPtyManifest(handle.id)?.outputBytesTotal;
    if (${failedExitFlushes} > 0) {
      const originalRun = Database.prototype.run;
      Database.prototype.run = function(sql, ...args) {
        if (typeof sql === 'string' && sql.includes('output_bytes_total = output_bytes_total + ?')) {
          outputUpdateAttempts++;
          if (outputUpdateAttempts <= ${failedExitFlushes}) return { changes: 0, lastInsertRowid: 0 };
        }
        return originalRun.call(this, sql, ...args);
      };
    }
    onExit({ exitCode: 0 });
    const afterExit = getPtyManifest(handle.id)?.outputBytesTotal;
    const closedAfterExit = getPtyManifest(handle.id)?.alive === false;
    const retryTotals = [];
    while (runNextTimer()) retryTotals.push(getPtyManifest(handle.id)?.outputBytesTotal);
    const afterRecovery = getPtyManifest(handle.id)?.outputBytesTotal;
    const attemptsAfterRecovery = outputUpdateAttempts;
    const timerRanAfterRecovery = runNextTimer();
    const afterExtraAdvance = getPtyManifest(handle.id)?.outputBytesTotal;
    const result = { afterFirst, beforeExit, afterExit, closedAfterExit, afterRecovery, afterExtraAdvance, timerRanAfterRecovery, scheduledTimers: scheduled.size, ...( ${failedExitFlushes} > 0 ? { outputUpdateAttempts, attemptsAfterRecovery, retryTotals } : {}) };
    console.log(JSON.stringify(result));
    unregisterPty(handle.id);
    process.exit(0);
  `;
  const result = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: repo,
    env: { ...process.env, NODE_ENV: 'production', ELANOUS_STATE_DIR: stateDir },
    stdout: 'pipe', stderr: 'pipe',
  });
  expect(result.exitCode).toBe(0);
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

describe('registry rename manifest synchronization', () => {
  test('later rename updates the manifest nickname used by remote refs', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'pty-rename-manifest-'));
    try {
      expect(JSON.parse(runRename(stateDir))).toEqual({
        renamedState: { renamed: true, nickname: 'later-name', manifest: 'later-name' },
        directState: { nickname: 'direct-name', manifest: 'direct-name' },
        remoteRef: expect.stringMatching(/^pty_/),
        clearedState: {},
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 15_000);

  test('manifest write failure remains fail-soft for the local rename', () => {
    expect(JSON.parse(runRename('', true))).toMatchObject({
      renamedState: { renamed: true, nickname: 'later-name' },
      directState: { nickname: 'direct-name' },
    });
  }, 15_000);

  test('flushes throttled trailing UTF-8 output exactly once before manifest close', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'pty-output-total-exit-'));
    try {
      expect(runOutputTotalOnExit(stateDir)).toEqual({
        afterFirst: 1,
        beforeExit: 1,
        afterExit: 4,
        closedAfterExit: true,
        afterRecovery: 4,
        afterExtraAdvance: 4,
        timerRanAfterRecovery: false,
        scheduledTimers: 0,
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 15_000);

  test('keeps closed trailing output pending across consecutive failures and stops retrying after one recovery commit', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'pty-output-total-exit-retry-'));
    try {
      expect(runOutputTotalOnExit(stateDir, 3)).toEqual({
        afterFirst: 1,
        beforeExit: 1,
        afterExit: 1,
        closedAfterExit: true,
        retryTotals: [1, 1, 4],
        afterRecovery: 4,
        attemptsAfterRecovery: 4,
        outputUpdateAttempts: 4,
        afterExtraAdvance: 4,
        timerRanAfterRecovery: false,
        scheduledTimers: 0,
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 15_000);
});
