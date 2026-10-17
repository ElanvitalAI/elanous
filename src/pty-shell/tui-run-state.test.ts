// TUI 실행 상태 — 턴 기록·판독 ⊕ 기동 판 ⊕ stale 판정. 격리 tmp ELANOUS_STATE_DIR 로 실제 manifest 무접촉.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const previousStateDir = process.env.ELANOUS_STATE_DIR;
const stateDir = mkdtempSync(join(tmpdir(), 'tui-run-state-'));
process.env.ELANOUS_STATE_DIR = stateDir;

const { upsertPtyManifest, getPtyManifest, setPtyManifestDbPathForTesting, updatePtyManifestBuild, updatePtyManifestTurn, markPtyManifestClosed } = await import('./pty-manifest.js');
const {
  describePtyRunState, describeTurnCell, formatTurnCell, judgeBuildStaleness, ptyTurnViewOfRow, readCurrentInstallRecord, reportTuiTurn, resetTuiRunStateForTesting,
  resolveRunningBuild, startTuiRunStateRecorder,
} = await import('./tui-run-state.js');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

beforeEach(() => {
  setPtyManifestDbPathForTesting(join(mkdtempSync(join(stateDir, 'store-')), 'pty', 'manifest.db'));
  resetTuiRunStateForTesting();
});
afterAll(() => {
  setPtyManifestDbPathForTesting(null);
  resetTuiRunStateForTesting();
  if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previousStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

describe('manifest turn/build columns', () => {
  test('round-trip: build ⊕ turn written to the row are read back; re-register resets them', () => {
    upsertPtyManifest({ id: 'tui:1', kind: 'tui', cmd: 'elanous', startedAt: 10, now: 10 });
    expect(getPtyManifest('tui:1')?.turnState).toBeUndefined();
    expect(getPtyManifest('tui:1')?.build).toBeUndefined();
    expect(updatePtyManifestBuild('tui:1', { version: '0.2.29', sha: SHA_A, source: 'installed', codeRoot: '/x' })).toBe(true);
    expect(updatePtyManifestTurn('tui:1', 'busy', 20)).toBe(true);
    const row = getPtyManifest('tui:1')!;
    expect(row.turnState).toBe('busy');
    expect(row.turnAt).toBe(20);
    expect(row.build).toEqual({ version: '0.2.29', sha: SHA_A, source: 'installed', codeRoot: '/x' });
    upsertPtyManifest({ id: 'tui:1', kind: 'tui', cmd: 'elanous', startedAt: 30, now: 30 });
    expect(getPtyManifest('tui:1')?.turnState).toBeUndefined();
    expect(getPtyManifest('tui:1')?.build).toBeUndefined();
  });

  test('writes against a missing row report false (caller observes it)', () => {
    expect(updatePtyManifestTurn('tui:none', 'idle', 1)).toBe(false);
    expect(updatePtyManifestBuild('tui:none', { version: 'v', sha: SHA_A, source: 'installed' })).toBe(false);
  });
});

describe('recorder (TUI side)', () => {
  test('records build ⊕ idle at start, then busy/idle per turn into the manifest', () => {
    upsertPtyManifest({ id: 'tui:7', kind: 'tui', cmd: 'elanous', startedAt: 1, now: 1 });
    let t = 100;
    const logs: Array<[string, Record<string, unknown>]> = [];
    const stop = startTuiRunStateRecorder('tui:7', {
      now: () => t, build: () => ({ version: 'v1', sha: SHA_A, source: 'installed' }), log: (e, d) => logs.push([e, d]),
    });
    expect(getPtyManifest('tui:7')).toMatchObject({ turnState: 'idle', turnAt: 100, build: { sha: SHA_A, source: 'installed' } });
    t = 200; reportTuiTurn('busy');
    expect(getPtyManifest('tui:7')).toMatchObject({ turnState: 'busy', turnAt: 200 });
    t = 300; reportTuiTurn('idle');
    expect(getPtyManifest('tui:7')).toMatchObject({ turnState: 'idle', turnAt: 300 });
    expect(logs.map(([e]) => e)).toEqual(['build-recorded']);
    stop();
    t = 400; reportTuiTurn('busy');   // 녹음기 해제 뒤엔 아무것도 안 쓴다
    expect(getPtyManifest('tui:7')).toMatchObject({ turnState: 'idle', turnAt: 300 });
  });

  test('turn write failure is observed via debug log and retried on the next report', () => {
    const logs: Array<[string, Record<string, unknown>]> = [];
    let fail = true; const writes: string[] = [];
    startTuiRunStateRecorder('tui:9', {
      now: () => 5, build: () => ({ version: 'v', sha: SHA_A, source: 'installed' }), writeBuild: () => true,
      writeTurn: (_id, turn) => { writes.push(turn); return !fail; }, log: (e, d) => logs.push([e, d]),
    });
    expect(logs.filter(([e]) => e === 'turn-write-failed')).toEqual([['turn-write-failed', { ptyId: 'tui:9', turn: 'idle', at: 5 }]]);
    fail = false; reportTuiTurn('idle');   // 실패한 값은 «기록됨»으로 치지 않는다 → 다시 쓴다
    reportTuiTurn('idle');                 // 성공 뒤 같은 값은 다시 안 쓴다
    expect(writes).toEqual(['idle', 'idle']);
  });

  test('without a recorder, reportTuiTurn is a no-op', () => {
    upsertPtyManifest({ id: 'tui:8', kind: 'tui', cmd: 'elanous', startedAt: 1, now: 1 });
    reportTuiTurn('busy');
    expect(getPtyManifest('tui:8')?.turnState).toBeUndefined();
  });
});

describe('running build', () => {
  test('installed version folder → install.json commit; otherwise checkout HEAD; neither → unknown', () => {
    expect(resolveRunningBuild({
      codeRoot: '/r', version: () => '0.2.29', versionDirOf: () => '/inst/versions/v1',
      readInstallCommit: (p) => (p === join('/inst/versions/v1', 'install.json') ? SHA_A : undefined), revision: () => SHA_B,
    })).toEqual({ version: '0.2.29', sha: SHA_A, source: 'installed', codeRoot: '/r' });
    // 판 폴더인데 install.json 을 못 읽으면 git 으로 메우지 않는다 — 모른다.
    expect(resolveRunningBuild({ codeRoot: '/r', version: () => 'v', versionDirOf: () => '/inst/versions/v1', readInstallCommit: () => undefined, revision: () => SHA_B }))
      .toEqual({ version: 'v', sha: '', source: 'unknown', codeRoot: '/r' });
    expect(resolveRunningBuild({ codeRoot: '/r', version: () => 'v', versionDirOf: () => undefined, revision: () => SHA_B }))
      .toEqual({ version: 'v', sha: SHA_B, source: 'checkout', codeRoot: '/r' });
    expect(resolveRunningBuild({ codeRoot: '/r', version: () => 'v', versionDirOf: () => undefined, revision: () => undefined }))
      .toEqual({ version: 'v', sha: '', source: 'unknown', codeRoot: '/r' });
  });

  test('readCurrentInstallRecord reads commit and installedAt from current/install.json', () => {
    const root = mkdtempSync(join(stateDir, 'inst-'));
    mkdirSync(join(root, 'current'));
    writeFileSync(join(root, 'current', 'install.json'), JSON.stringify({ commit: SHA_B, installedAt: '2026-10-14T06:30:17Z' }));
    expect(readCurrentInstallRecord(root)).toEqual({ sha: SHA_B, installedAt: Date.parse('2026-10-14T06:30:17Z') });
    expect(readCurrentInstallRecord(join(root, 'missing'))).toEqual({});
  });
});

describe('stale judgment', () => {
  const installed = (sha?: string, installedAt?: number) => ({ ...(sha ? { sha } : {}), ...(installedAt !== undefined ? { installedAt } : {}) });
  test('installed boot build vs current installed commit', () => {
    expect(judgeBuildStaleness({ build: { version: 'v', sha: SHA_A, source: 'installed' }, installed: installed(SHA_A) })).toEqual({ stale: false, reason: 'same-as-installed' });
    expect(judgeBuildStaleness({ build: { version: 'v', sha: SHA_A, source: 'installed' }, installed: installed(SHA_B) })).toEqual({ stale: true, reason: 'installed-moved' });
    expect(judgeBuildStaleness({ build: { version: 'v', sha: SHA_A, source: 'installed' }, installed: installed() })).toEqual({ stale: null, reason: 'unknown' });
  });
  test('checkout boot build vs that checkout HEAD now', () => {
    const build = { version: 'v', sha: SHA_A, source: 'checkout' as const, codeRoot: '/r' };
    expect(judgeBuildStaleness({ build, installed: installed(SHA_B), checkoutHead: SHA_A })).toEqual({ stale: false, reason: 'same-as-checkout' });
    expect(judgeBuildStaleness({ build, installed: installed(SHA_A), checkoutHead: SHA_B })).toEqual({ stale: true, reason: 'checkout-moved' });
    expect(judgeBuildStaleness({ build, installed: installed(SHA_A) })).toEqual({ stale: null, reason: 'unknown' });
  });
  test('legacy row without a build: started before the current install → inferred stale; otherwise unknown (not false)', () => {
    expect(judgeBuildStaleness({ installed: installed(SHA_B, 200), startedAt: 100 })).toEqual({ stale: true, reason: 'started-before-install' });
    expect(judgeBuildStaleness({ installed: installed(SHA_B, 50), startedAt: 100 })).toEqual({ stale: null, reason: 'unknown' });
  });

  test('describePtyRunState: dead row → turn unknown; shell rows never get the legacy inference', () => {
    const base = { alive: true, startedAt: 100, kind: 'tui', turnState: 'busy' as const, turnAt: 120 };
    const deps = { readInstalled: () => installed(SHA_B, 200), readCheckoutHead: () => undefined };
    expect(describePtyRunState(base, deps)).toMatchObject({ turn: 'busy', turnAt: 120, build: null, installed: SHA_B, stale: true, staleReason: 'started-before-install' });
    expect(describePtyRunState({ ...base, alive: false }, deps)).toMatchObject({ turn: 'unknown' });
    expect(describePtyRunState({ ...base, kind: 'shell' }, deps)).toMatchObject({ stale: null, staleReason: 'unknown' });
    expect(describePtyRunState(null, deps)).toMatchObject({ turn: 'unknown', build: null, stale: null });
  });

  test('closed row reads back as turn unknown through the manifest', () => {
    upsertPtyManifest({ id: 'tui:5', kind: 'tui', cmd: 'elanous', startedAt: 1, now: 1 });
    updatePtyManifestTurn('tui:5', 'busy', 2);
    markPtyManifestClosed('tui:5', 0, 3);
    expect(describePtyRunState(getPtyManifest('tui:5'), { readInstalled: () => ({}) }).turn).toBe('unknown');
  });
});

describe('self-report wiring', () => {
  test('startTuiSelfReport opens the run-state recorder after the row is registered and closes it on stop', async () => {
    const { startTuiSelfReport } = await import('../capture/tui-self-report.js');
    const order: string[] = [];
    const stop = startTuiSelfReport({
      surfaceId: 'tui:wire', now: () => 1, heartbeatMs: 60_000,
      register: () => {}, publishFrame: () => {}, writeFrame: () => {}, writeScreen: () => {}, heartbeat: () => {},
      registerRow: (id) => order.push(`row:${id}`), markClosed: () => order.push('closed'), rollbackRow: () => {},
      createMirror: () => null,
      createControlTarget: (id) => ({ id, deactivate() {} } as never), registerControlTarget: () => () => {}, startControlPoller: () => () => {},
      startRunState: (id) => { order.push(`run-state:${id}`); return () => order.push('run-state-stop'); },
      onExit: () => {},
    });
    stop();
    expect(order).toEqual(['row:tui:wire', 'run-state:tui:wire', 'run-state-stop', 'closed']);
  });
});

describe('turn cell (H10 · pty list 턴 칸)', () => {
  test('busy → 이 턴 경과 초 · idle → 한가한 지 초 · 시각 없음/턴 모름은 «모른다»', () => {
    expect(describeTurnCell({ turn: 'busy', turnAt: 10_000 }, 52_900)).toEqual({ state: 'busy', at: 10_000, sinceSec: 42 });
    expect(formatTurnCell(describeTurnCell({ turn: 'busy', turnAt: 10_000 }, 52_900))).toBe('busy,42s');
    expect(formatTurnCell(describeTurnCell({ turn: 'idle', turnAt: 10_000 }, 11_000))).toBe('idle,1s');
    expect(describeTurnCell({ turn: 'busy' }, 1)).toEqual({ state: 'busy', at: null, sinceSec: null });
    expect(formatTurnCell(describeTurnCell({ turn: 'busy' }, 1))).toBe('busy,?s');
    expect(formatTurnCell(describeTurnCell({ turn: 'unknown', turnAt: 5 }, 9))).toBe('?');
    // 시계 역행은 음수 대신 0 — 「경과」가 음수일 수는 없다.
    expect(describeTurnCell({ turn: 'idle', turnAt: 9_000 }, 1_000).sinceSec).toBe(0);
  });

  test('행의 턴만 읽는다 — 죽은 행·기록 없음은 unknown · describePtyRunState 와 같은 값', () => {
    expect(ptyTurnViewOfRow({ alive: true, turnState: 'busy', turnAt: 5 })).toEqual({ turn: 'busy', turnAt: 5 });
    expect(ptyTurnViewOfRow({ alive: false, turnState: 'busy', turnAt: 5 })).toEqual({ turn: 'unknown' });
    expect(ptyTurnViewOfRow({ alive: true })).toEqual({ turn: 'unknown' });
    expect(ptyTurnViewOfRow(null)).toEqual({ turn: 'unknown' });
  });

  test('기록된 턴 시각으로 잰다 — busy 로 바뀐 순간이 경과의 0초다', () => {
    upsertPtyManifest({ id: 'tui:cell', kind: 'tui', cmd: 'elanous', startedAt: 1, now: 1 });
    expect(updatePtyManifestTurn('tui:cell', 'busy', 70_000)).toBe(true);
    const view = describePtyRunState(getPtyManifest('tui:cell'), { readInstalled: () => ({}) });
    expect(describeTurnCell(view, 100_000)).toEqual({ state: 'busy', at: 70_000, sinceSec: 30 });
    expect(updatePtyManifestTurn('tui:cell', 'idle', 100_000)).toBe(true);
    expect(formatTurnCell(describeTurnCell(ptyTurnViewOfRow(getPtyManifest('tui:cell')), 100_500))).toBe('idle,0s');
  });
});
