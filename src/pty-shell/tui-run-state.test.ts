// TUI 실행 상태 — 턴 기록·판독 ⊕ 기동 판 ⊕ stale 판정. 격리 tmp ELANOUS_STATE_DIR 로 실제 manifest 무접촉.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const previousStateDir = process.env.ELANOUS_STATE_DIR;
const stateDir = mkdtempSync(join(tmpdir(), 'tui-run-state-'));
process.env.ELANOUS_STATE_DIR = stateDir;

const { upsertPtyManifest, getPtyManifest, setPtyManifestDbPathForTesting, updatePtyManifestBuild, updatePtyManifestTurn, markPtyManifestClosed } = await import('./pty-manifest.js');
const {
  buildSelfHealthLine, describePtyRunState, describeTurnCell, formatTurnCell, judgeBuildStaleness, ptyTurnViewOfRow, readCurrentInstallRecord, reportTuiTurn, resetTuiRunStateForTesting,
  resolveRunningBuild, startTuiRunStateRecorder,
} = await import('./tui-run-state.js');
const { createHerdrAgentReporter } = await import('./herdr-agent-report.js');
const { startTuiSelfReport } = await import('../capture/tui-self-report.js');

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

describe('herdr agent report wiring', () => {
  test('injected herdr is start on recorder start, turn on busy then idle, release on stop', () => {
    const order: string[] = [];
    const herdr = {
      start: () => order.push('start'),
      turn: (t: 'busy' | 'idle') => order.push(`turn:${t}`),
      release: () => order.push('release'),
    };
    const stop = startTuiRunStateRecorder('tui:herdr', {
      now: () => 1,
      build: () => ({ version: 'v', sha: SHA_A, source: 'installed' }),
      writeBuild: () => { order.push('build'); return true; },
      writeTurn: (_id, t) => { order.push(`write:${t}`); return true; },
      herdr,
    });
    reportTuiTurn('busy');
    reportTuiTurn('idle');
    stop();
    // 기동 순서 = 판 → manifest 초기 idle → herdr start · 초기 turn:idle 없음(start 가 이미 idle 을 신고한다).
    expect(order).toEqual(['build', 'write:idle', 'start', 'write:busy', 'turn:busy', 'write:idle', 'turn:idle', 'release']);
  });

  test('기동 창 SIGINT 죽음에도 herdr 반납 — 녹음기가 신호 지킴이를 걸고 stop 에서 걷는다 (TUI-HERDR-EXIT-RACE)', () => {
    const order: string[] = [];
    const herdr = { start: () => order.push('start'), turn: () => {}, release: () => order.push('release') };
    const ls = new Map<string, Array<(s: NodeJS.Signals) => void>>();
    const signals = {
      pid: 1,
      on(sig: NodeJS.Signals, fn: (s: NodeJS.Signals) => void) { ls.set(sig, [...(ls.get(sig) ?? []), fn]); return signals; },
      removeListener(sig: NodeJS.Signals, fn: (s: NodeJS.Signals) => void) { ls.set(sig, (ls.get(sig) ?? []).filter((f) => f !== fn)); return signals; },
      listenerCount: (sig: NodeJS.Signals) => (ls.get(sig) ?? []).length,
      kill: (_pid: number, sig?: string | number) => { order.push(`kill:${String(sig)}`); return true; },
    };
    const stop = startTuiRunStateRecorder('tui:herdr-sig', {
      now: () => 1, build: () => ({ version: 'v', sha: SHA_A, source: 'installed' }),
      writeBuild: () => true, writeTurn: () => true, herdr, signals,
    });
    expect(signals.listenerCount('SIGINT')).toBe(1);
    for (const fn of [...(ls.get('SIGINT') ?? [])]) fn('SIGINT');
    expect(order).toEqual(['start', 'release', 'kill:SIGINT']);
    const stop2 = startTuiRunStateRecorder('tui:herdr-sig2', {
      now: () => 1, build: () => ({ version: 'v', sha: SHA_A, source: 'installed' }),
      writeBuild: () => true, writeTurn: () => true, herdr, signals,
    });
    stop2();
    expect(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM')).toBe(0);
    stop();
  });

  test('herdr.turn 이 동기로 던지면 «보낸 상태» 로 적지 않는다 — herdr 기준 값으로 다음 전이를 다시 보낸다 (r4 리뷰 sf)', () => {
    const calls: string[] = [];
    const events: string[] = [];
    let throwNext = true;
    const herdr = {
      start: () => {},
      turn: (t: 'busy' | 'idle') => { calls.push(t); if (throwNext) { throwNext = false; throw new Error('boom'); } },
      release: () => {},
    };
    const stop = startTuiRunStateRecorder('tui:herdr-throw', {
      now: () => 1,
      build: () => ({ version: 'v', sha: SHA_A, source: 'installed' }),
      writeBuild: () => true,
      writeTurn: () => true,
      log: (e) => events.push(e),
      herdr,
    });
    reportTuiTurn('busy'); // 던짐 → herdrLast 는 idle 그대로(herdr 는 여전히 idle 로 안다)
    reportTuiTurn('idle'); // herdr 기준 값도 idle — 보낼 것이 없다
    reportTuiTurn('busy'); // 다시 busy 를 보낸다(옛 코드는 herdrLast=busy 로 적어 이것도 막았다)
    stop();
    expect(calls).toEqual(['busy', 'busy']);
    expect(events).toContain('herdr-turn-threw');
  });

  test('writeTurn injected without herdr never runs the herdr binary (spy call count 0, with a positive control)', async () => {
    // 프로세스 실행 스파이 = 호출마다 한 줄 적는 가짜 herdr. 대조군(실 신고기)이 같은 스파이에 잡히는지 먼저 본다.
    const dir = mkdtempSync(join(tmpdir(), 'herdr-spy-'));
    const spyLog = join(dir, 'calls.log');
    const spyBin = join(dir, 'herdr');
    writeFileSync(spyBin, `#!/bin/sh\necho "$*" >> '${spyLog}'\n`, { mode: 0o755 });
    const spyCalls = (): number => (existsSync(spyLog) ? readFileSync(spyLog, 'utf8').split('\n').filter(Boolean).length : 0);
    const env = { HERDR_ENV: '1', HERDR_PANE_ID: 'wM:p1', HERDR_BIN_PATH: spyBin };
    const keys = ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_BIN_PATH', 'ELANOUS_HERDR_REPORT'] as const;
    const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    delete process.env.ELANOUS_HERDR_REPORT;
    try {
      // 대조군 — 기본 러너가 스파이를 실제로 부른다(스파이가 살아 있다).
      const control = createHerdrAgentReporter({ env, sessionId: 'control', seqStore: { read: () => undefined, write: () => {} } })!;
      control.start();
      for (let i = 0; i < 100 && spyCalls() < 2; i++) await new Promise((r) => setTimeout(r, 20));
      expect(spyCalls()).toBe(2);
      rmSync(spyLog, { force: true });

      const stop = startTuiRunStateRecorder('tui:no-herdr', {
        now: () => 1,
        build: () => ({ version: 'v', sha: SHA_A, source: 'installed' }),
        writeBuild: () => true,
        writeTurn: () => true,
      });
      reportTuiTurn('busy');
      reportTuiTurn('idle');
      stop();
      await new Promise((r) => setTimeout(r, 200));
      expect(spyCalls()).toBe(0);
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('self-report wiring', () => {
  test('startTuiSelfReport opens the run-state recorder after the row is registered and closes it on stop', async () => {
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

describe('매 턴 자기 건강 한 줄(TUI-SELF-HEALTH-LINE)', () => {
  const installedBuild = { version: '0.2.34', sha: SHA_A, source: 'installed' as const, codeRoot: '/r' };
  const healthy = { build: () => installedBuild, readInstalled: () => ({ sha: SHA_A, installedAt: 100 }) };

  test('낡은 판(installed-moved) → 재기동 필요 — stale-install-check 안내·명령 문면을 그대로 재사용한다', () => {
    const line = buildSelfHealthLine(null, {
      build: () => installedBuild,
      readInstalled: () => ({ sha: SHA_B, installedAt: 200 }),
      sessionId: 'sess-1',
    });
    expect(line).toBe(
      `[자기 건강] 실행 판 0.2.34@${SHA_A.slice(0, 7)}(installed) · 낡은 판 — 재기동 필요: `
      + `새 판이 깔렸습니다 (부팅 판 ${SHA_A.slice(0, 7)} → 지금 ${SHA_B.slice(0, 7)}) · `
      + `TUI 를 다시 띄우면 새 판으로 돕니다 · 다시 띄우기: elanous --resume "sess-1"`,
    );
  });

  test('재기동 안내 회차(notifiedCount ≥ 2)도 기존 문면 재료를 그대로 싣는다', () => {
    const line = buildSelfHealthLine(null, {
      build: () => installedBuild,
      readInstalled: () => ({ sha: SHA_B }),
      notifiedCount: 2,
    })!;
    expect(line).toContain('이 TUI 가 뜬 뒤 2번째 새 판');
  });

  test('같은 판 → 판 최신 · 설치본을 못 잼 → 모름(안 낡았다로 꾸미지 않는다)', () => {
    expect(buildSelfHealthLine(null, healthy)).toBe(
      `[자기 건강] 실행 판 0.2.34@${SHA_A.slice(0, 7)}(installed) · 판 최신(same-as-installed)`,
    );
    expect(buildSelfHealthLine(null, {
      build: () => installedBuild,
      readInstalled: () => ({}),   // 설치본 기록을 못 읽음 → unknown
    })).toBe(`[자기 건강] 실행 판 0.2.34@${SHA_A.slice(0, 7)}(installed) · 판 낡음 모름(unknown)`);
  });

  test('체크아웃 판이 움직인 낡은 판도 재기동 필요를 말한다(«새 판이 깔렸습니다» 는 갖다 붙이지 않는다)', () => {
    const line = buildSelfHealthLine(null, {
      build: () => ({ version: '0.2.34', sha: SHA_A, source: 'checkout' as const, codeRoot: '/r' }),
      readInstalled: () => ({ sha: SHA_B }),
      readCheckoutHead: () => SHA_B,
      sessionId: 'sess-2',
    });
    expect(line).toBe(
      `[자기 건강] 실행 판 0.2.34@${SHA_A.slice(0, 7)}(checkout) · `
      + `낡은 판(checkout-moved) — 재기동 필요 · 다시 띄우기: elanous --resume "sess-2"`,
    );
  });

  test('직전 30분 자기 오류 집계 — 건수·대표 오류를 말하고, 집계가 없으면 그 축은 말하지 않는다', () => {
    expect(buildSelfHealthLine({ count: 3, sample: 'llm.response 502 (grok)' }, healthy)).toBe(
      `[자기 건강] 실행 판 0.2.34@${SHA_A.slice(0, 7)}(installed) · 판 최신(same-as-installed) · `
      + `직전 30분 자기 오류 3건 — 대표: llm.response 502 (grok)`,
    );
    expect(buildSelfHealthLine({ count: 0 }, healthy)).toContain('직전 30분 자기 오류 0건');
    expect(buildSelfHealthLine(undefined, healthy)).not.toContain('자기 오류');
  });

  test('크레딧 사용 재료는 주어진 것만 실는다 · 판 축 재료가 깨지면 오류 축만 살아남다(null 은 아니다)', () => {
    expect(buildSelfHealthLine(null, { ...healthy, creditUsage: '1.2M tokens' })).toContain('크레딧 사용 1.2M tokens');
    expect(buildSelfHealthLine(null, healthy)).not.toContain('크레딧');
    // 판 축 재료가 깨져도 오류는 밀려나지 않는다 — 오류가 다음 턴에 말해지는 게 이 줄의 존재 이유다.
    expect(buildSelfHealthLine({ count: 1, sample: 'boom' }, {
      ...healthy, readInstalled: () => { throw new Error('boom'); },
    })).toBe('[자기 건강] 직전 30분 자기 오류 1건 — 대표: boom');
    // 말할 것이 전혀 없으면 null — 턴에 줄을 얹지 않는다.
    expect(buildSelfHealthLine(null, { ...healthy, readInstalled: () => { throw new Error('boom'); } })).toBe(null);
  });
});
