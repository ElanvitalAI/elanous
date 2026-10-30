// TUI 실행 상태 — 턴 기록·판독 ⊕ 기동 판 ⊕ stale 판정. 격리 tmp ELANOUS_STATE_DIR 로 실제 manifest 무접촉.
import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';

// manifest 저장소가 이 격리 환경에서 한 op 당 수 초가 걸린다(실측 27s/2 tests) — 기본 5s 로는 판정선과 무관한
// 시간초과가 나므로 파일 기본 상한을 올려 «단언 실패»와 «환경 지연» 을 구분한다.
setDefaultTimeout(60_000);
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const previousStateDir = process.env.ELANOUS_STATE_DIR;
const stateDir = mkdtempSync(join(tmpdir(), 'tui-run-state-'));
process.env.ELANOUS_STATE_DIR = stateDir;

const { upsertPtyManifest, getPtyManifest, setPtyManifestDbPathForTesting, updatePtyManifestBuild, updatePtyManifestProgress, updatePtyManifestTurn, markPtyManifestClosed } = await import('./pty-manifest.js');
const {
  buildSelfHealthLine, describePtyRunState, describeTurnCell, formatTurnCell, judgeBuildStaleness, judgeTurnProgress, ptyTurnViewOfRow, readCurrentInstallRecord, reportTuiAbortRequested, reportTuiProgress, reportTuiTurn, resetTuiRunStateForTesting,
  resolveRunningBuild, startTuiRunStateRecorder, DEFAULT_ABORT_IGNORE_MS, DEFAULT_SLOW_TURN_MS, DEFAULT_TURN_STALL_MS,
  DEFAULT_SELF_RESTART_IDLE_MS, decideSelfRestart,
  setTuiRelaunchSpawnForTesting, TUI_RELAUNCH_FLAG,
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
    const spyLines = (): string[] => (existsSync(spyLog) ? readFileSync(spyLog, 'utf8').split('\n').filter(Boolean) : []);
    const env = { HERDR_ENV: '1', HERDR_PANE_ID: 'wM:p1', HERDR_BIN_PATH: spyBin };
    const keys = ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_BIN_PATH', 'ELANOUS_HERDR_REPORT'] as const;
    const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    delete process.env.ELANOUS_HERDR_REPORT;
    try {
      // 대조군 — herdr 가 있는 경로는 startup prune 을 동기로 부르고 등록 둘을 비동기로 보낸다.
      // 총 호출 수를 기대하지 말고 두 등록 완료를 확인해, 늦은 대조군 호출이 herdr 없는 경로를 오염시키지 않게 한다.
      const control = createHerdrAgentReporter({ env, sessionId: 'control', seqStore: { read: () => undefined, write: () => {} } })!;
      control.start();
      const registrationsComplete = () => {
        const lines = spyLines();
        return lines.some((line) => line.includes('pane report-agent --source'))
          && lines.some((line) => line.includes('pane report-agent-session --source'));
      };
      for (let i = 0; i < 100 && !registrationsComplete(); i++) await new Promise((r) => setTimeout(r, 20));
      expect(registrationsComplete()).toBe(true);
      expect(spyLines().some((line) => /^pane release-agent wM:p1 --source custom:elanous --agent elanous --seq \d+$/.test(line))).toBe(true);
      control.release();
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
      expect(spyLines()).toHaveLength(0);
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

// ── TUI-H9-IDLE-SELF-RESTART ────────────────────────────────────────────────
// 무대: mock-deps/fake-clock — 가짜 시계(now) ⊕ 주입한 감시 tick ⊕ 가짜 재기동. 실 CLI·실 spawn 없음(L2).
// 판정선(정본 TUI-H9): «재기동 필요» ∧ 유휴 ∧ 사람 입력 없음 ⇒ 스스로 재기동(새 세션 ⊕ 자리 맥락 재주입).
describe('TUI-H9-IDLE-SELF-RESTART — 낡은 판 ∧ 유휴 ∧ 사람 입력 없음 ⇒ 스스로 재기동', () => {
  const STALE = { stale: true as const, reason: 'installed-moved' as const };
  const humanInputIdle = { stale: true, staleReason: 'installed-moved' as const, turn: 'idle' as const, idleMs: DEFAULT_SELF_RESTART_IDLE_MS, humanInputPending: false };

  test('판정선: 세 조건이 모두 참일 때만 재기동 — 조건 하나라도 거짓이면 재기동 없음', () => {
    expect(decideSelfRestart(humanInputIdle)).toEqual({ restart: true, reason: 'stale-idle-no-input' });
    // ① 재기동 필요가 거짓
    expect(decideSelfRestart({ ...humanInputIdle, stale: false })).toEqual({ restart: false, reason: 'not-stale' });
    expect(decideSelfRestart({ ...humanInputIdle, stale: null })).toEqual({ restart: false, reason: 'staleness-unknown' });
    // ② 유휴가 거짓
    expect(decideSelfRestart({ ...humanInputIdle, turn: 'busy' })).toEqual({ restart: false, reason: 'turn-busy' });
    expect(decideSelfRestart({ ...humanInputIdle, turn: 'unknown' })).toEqual({ restart: false, reason: 'turn-unknown' });
    expect(decideSelfRestart({ ...humanInputIdle, idleMs: DEFAULT_SELF_RESTART_IDLE_MS - 1 })).toEqual({ restart: false, reason: 'still-warm' });
    expect(decideSelfRestart({ ...humanInputIdle, idleMs: null })).toEqual({ restart: false, reason: 'still-warm' });
    // ③ 사람 입력이 있으면 재기동 없음
    expect(decideSelfRestart({ ...humanInputIdle, humanInputPending: true })).toEqual({ restart: false, reason: 'human-input-pending' });
  });

  test('생산 경로: recorder → reportTuiTurn(busy→idle) 뒤 유휴 감시 tick 이 낡은 판에서 재기동을 한 번만 일으킨다', () => {
    let now = 5_000_000;
    const restarts: Array<{ surfaceId: string; staleReason: string; idleMs: number; relaunchCommand: string | null }> = [];
    const seenTurns: string[] = [];
    let tickers: Array<() => void> = [];
    const stop = startTuiRunStateRecorder('tui:h9', {
      now: () => now,
      writeBuild: () => true,
      writeTurn: (_id, turn) => { seenTurns.push(turn); return true; },
      herdr: null,
      signals: null,
      selfRestart: {
        staleness: () => STALE,
        humanInputPending: () => false,
        sessionId: 'sess-h9',
        restart: (plan) => { restarts.push(plan as (typeof restarts)[number]); },
        watch: (tick) => {
          tickers.push(tick);
          const off = () => { tickers = tickers.filter((t) => t !== tick); };
          return off;
        },
      },
    });
    expect(tickers).toHaveLength(1);
    reportTuiTurn('busy');
    now += 1_000;
    reportTuiTurn('idle');
    const tick = tickers[0]!;
    tick();
    expect(restarts).toHaveLength(0); // 유휴 경과가 유예보다 짧다

    now += DEFAULT_SELF_RESTART_IDLE_MS;
    tick();
    expect(restarts).toHaveLength(1);
    expect(restarts[0]!.surfaceId).toBe('tui:h9');
    expect(restarts[0]!.staleReason).toBe('installed-moved');
    expect(restarts[0]!.relaunchCommand).toBe('elanous --resume "sess-h9"'); // 새 세션 ⊕ 자리 맥락 재주입
    expect(restarts[0]!.idleMs).toBe(DEFAULT_SELF_RESTART_IDLE_MS); // 유휴 0초 = busy→idle 로 바뀐 순간

    tick(); // 같은 낡음 판에 두 번 재기동하지 않는다
    expect(restarts).toHaveLength(1);
    expect(seenTurns).toEqual(['idle', 'busy', 'idle']); // 원장 형식은 그대로 — 턴 기록이 늘지 않는다

    stop();
    expect(tickers).toHaveLength(0);
  });

  test('생산 경로 부정: 판이 최신이거나 사람 입력이 대기 중이면 유휴가 길어도 재기동 없음', () => {
    let now = 7_000_000;
    const restarts: unknown[] = [];
    let tickers: Array<() => void> = [];
    let staleness: { stale: boolean | null; reason: string } = { stale: false, reason: 'same-as-installed' };
    let humanInputPending = false;
    const stop = startTuiRunStateRecorder('tui:h9b', {
      now: () => now,
      writeBuild: () => true,
      writeTurn: () => true,
      herdr: null,
      signals: null,
      selfRestart: {
        staleness: () => staleness as never,
        humanInputPending: () => humanInputPending,
        sessionId: 'sess-h9b',
        restart: (plan) => { restarts.push(plan); },
        watch: (tick) => { tickers.push(tick); return () => { tickers = tickers.filter((t) => t !== tick); }; },
      },
    });
    reportTuiTurn('idle');
    now += DEFAULT_SELF_RESTART_IDLE_MS * 3;
    tickers[0]!();
    expect(restarts).toHaveLength(0); // 판이 최신

    staleness = STALE;
    humanInputPending = true;
    tickers[0]!();
    expect(restarts).toHaveLength(0); // 사람 입력 대기

    humanInputPending = false;
    tickers[0]!();
    expect(restarts).toHaveLength(1);
    stop();
  });

  test('세션 id를 모르면 좌석을 양도하지 않고, 나중에 읽히면 재시도한다', () => {
    let now = 8_000_000;
    let sessionId: string | null = null;
    const restarts: string[] = [];
    const yielded: string[] = [];
    const events: string[] = [];
    const turns: string[] = [];
    let tick = () => {};
    const stop = startTuiRunStateRecorder('tui:h9-no-session', {
      now: () => now,
      writeBuild: () => true,
      writeTurn: (_id, turn) => { turns.push(turn); return true; },
      log: (event) => { events.push(event); },
      herdr: null,
      signals: null,
      selfRestart: {
        staleness: () => STALE,
        humanInputPending: () => false,
        readSessionId: () => sessionId,
        restart: () => { restarts.push('restart'); },
        yieldSeat: () => { yielded.push('yield'); },
        minIdleMs: 1_000,
        watch: (next) => { tick = next; return () => {}; },
      },
    });
    reportTuiTurn('idle');
    now += 2_000;

    tick();
    expect(events).toContain('self-restart-no-session');
    expect(yielded).toEqual([]);
    expect(restarts).toEqual([]);
    reportTuiTurn('busy');
    expect(turns).toEqual(['idle', 'busy']); // 세션 부재로도 기존 좌석 녹음기는 살아 있다

    sessionId = 'sess-h9-recovered';
    reportTuiTurn('idle');
    now += 2_000;
    tick();
    expect(restarts).toEqual(['restart']);
    expect(yielded).toEqual(['yield']);
    stop();
  });

  test('재기동 동기 실패는 좌석 양도를 하지 않고 다음 틱 재시도를 허용한다', () => {
    let now = 9_000_000;
    let shouldFail = true;
    const yielded: string[] = [];
    const events: string[] = [];
    const turns: string[] = [];
    let tick = () => {};
    const stop = startTuiRunStateRecorder('tui:h9-restart-failure', {
      now: () => now,
      writeBuild: () => true,
      writeTurn: (_id, turn) => { turns.push(turn); return true; },
      log: (event) => { events.push(event); },
      herdr: null,
      signals: null,
      selfRestart: {
        staleness: () => STALE,
        humanInputPending: () => false,
        sessionId: 'sess-h9-failure',
        restart: () => { if (shouldFail) throw new Error('restart failed'); },
        yieldSeat: () => { yielded.push('yield'); },
        minIdleMs: 1_000,
        watch: (next) => { tick = next; return () => {}; },
      },
    });
    reportTuiTurn('idle');
    now += 2_000;

    tick();
    expect(events).toContain('self-restart-failed');
    expect(yielded).toEqual([]);
    reportTuiTurn('busy');
    expect(turns).toEqual(['idle', 'busy']);

    shouldFail = false;
    reportTuiTurn('idle');
    now += 2_000;
    tick();
    expect(yielded).toEqual(['yield']);
    stop();
  });

  test('사람 입력 신호가 빠지면 unknown으로 취급해 재기동하지 않는다', () => {
    let now = 10_000_000;
    const restarts: string[] = [];
    const turns: string[] = [];
    let tick = () => {};
    const stop = startTuiRunStateRecorder('tui:h9-no-input-signal', {
      now: () => now,
      writeBuild: () => true,
      writeTurn: (_id, turn) => { turns.push(turn); return true; },
      herdr: null,
      signals: null,
      selfRestart: {
        staleness: () => STALE,
        sessionId: 'sess-h9-no-input-signal',
        restart: () => { restarts.push('restart'); },
        minIdleMs: 1_000,
        watch: (next) => { tick = next; return () => {}; },
      },
    });
    reportTuiTurn('idle');
    now += 2_000;

    tick();

    expect(restarts).toEqual([]);
    reportTuiTurn('busy');
    expect(turns).toEqual(['idle', 'busy']);
    stop();
  });
});

// ── 무대: 생산 spawnTuiRelaunch ⊕ 생산 defaultWatch ──
// watch·restart 를 «주입하지 않는다» — 실제 setInterval 감시와 실제 재기동 수행자가 그대로 지나고,
// 프로세스를 띄우는 syscall 한 곳만 fake-spawn 으로 바꿔 argv·옵션·unref 를 그대로 본다.
type TuiRelaunchSpawn = NonNullable<Parameters<typeof setTuiRelaunchSpawnForTesting>[0]>;

interface H9SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: { detached: boolean; stdio: 'ignore' };
  unrefCalled: boolean;
}

const H9_STALE = { stale: true, reason: 'installed-moved' } as const;
const sleepMs = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

describe('TUI-H9 무대 — 생산 spawnTuiRelaunch · 생산 defaultWatch (fake-spawn)', () => {
  let calls: H9SpawnCall[] = [];
  let order: string[] = [];

  const fakeSpawn: TuiRelaunchSpawn = (command, args, options) => {
    const call: H9SpawnCall = { command, args, options, unrefCalled: false };
    calls.push(call);
    order.push('spawn');
    return {
      on: (event, listener) => {
        if (event === 'spawn') (listener as () => void)();
        return undefined;
      },
      unref: () => { call.unrefCalled = true; },
    };
  };

  beforeEach(() => {
    calls = [];
    order = [];
    setTuiRelaunchSpawnForTesting(fakeSpawn);
  });
  afterAll(() => {
    setTuiRelaunchSpawnForTesting();
  });

  test('낡음 ∧ 유휴 ∧ 사람 입력 없음 → 생산 감시 틱이 «elanous --resume sess-h9» 를 detached/stdio:ignore 로 띄우고 좌석을 양도한다', async () => {
    let now = 5_000_000;
    const events: string[] = [];
    const turns: string[] = [];
    const stop = startTuiRunStateRecorder('tui:h9-stage', {
      now: () => now,
      build: () => ({ sha: SHA_A, version: '0.2.37', source: 'installed' }),
      writeBuild: () => true,
      writeTurn: (_id, turn) => { turns.push(turn); return true; },
      log: (event) => { events.push(event); },
      herdr: null,
      signals: null,
      selfRestart: {
        staleness: () => H9_STALE as never,
        humanInputPending: () => false,
        sessionId: 'sess-h9',
        minIdleMs: 1_000,
        intervalMs: 20,
      },
    });
    now += 60_000; // 유휴 하한을 넘긴다 — 판정선 ② 유휴
    await sleepMs(150); // 생산 defaultWatch(setInterval 20ms)가 실제로 여러 번 돈다

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([TUI_RELAUNCH_FLAG, 'sess-h9']);
    expect(calls[0]!.options).toEqual({ detached: true, stdio: 'ignore' });
    expect(calls[0]!.unrefCalled).toBe(true);
    expect(events).toContain('self-restart-handover');

    // 양도: 낡은 TUI 는 그 좌석 행을 더 쓰지 않는다 — 두 프로세스가 한 좌석을 겹쳐 쓰지 않는다.
    turns.length = 0;
    reportTuiTurn('busy');
    expect(turns).toEqual([]);
    stop();
  });

  test('사람 입력이 있으면 생산 감시가 여러 번 돌아도 spawn 없음 — 조용한 좌석을 뺏지 않는다', async () => {
    let now = 5_000_000;
    let ticks = 0;
    const stop = startTuiRunStateRecorder('tui:h9-human', {
      now: () => now,
      build: () => ({ sha: SHA_A, version: '0.2.37', source: 'installed' }),
      writeBuild: () => true,
      writeTurn: () => true,
      log: () => undefined,
      herdr: null,
      signals: null,
      selfRestart: {
        staleness: () => { ticks += 1; return H9_STALE as never; },
        humanInputPending: () => true,
        sessionId: 'sess-h9-human',
        minIdleMs: 1_000,
        intervalMs: 20,
      },
    });
    now += 60_000;
    await sleepMs(150);

    expect(ticks).toBeGreaterThan(1); // 생산 defaultWatch 경로가 반복해서 돈다
    expect(calls).toHaveLength(0);
    stop();
  });

  test('턴이 busy 면 생산 감시가 돌아도 spawn 없음', async () => {
    let now = 5_000_000;
    const stop = startTuiRunStateRecorder('tui:h9-busy', {
      now: () => now,
      build: () => ({ sha: SHA_A, version: '0.2.37', source: 'installed' }),
      writeBuild: () => true,
      writeTurn: () => true,
      log: () => undefined,
      herdr: null,
      signals: null,
      selfRestart: {
        staleness: () => H9_STALE as never,
        humanInputPending: () => false,
        sessionId: 'sess-h9-busy',
        minIdleMs: 1_000,
        intervalMs: 20,
      },
    });
    reportTuiTurn('busy');
    now += 60_000;
    await sleepMs(150);

    expect(calls).toHaveLength(0);
    stop();
  });

  test('spawn 성공 뒤에 좌석을 놓는다', async () => {
    let now = 5_000_000;
    const yielded: string[] = [];
    const stop = startTuiRunStateRecorder('tui:h9-yield', {
      now: () => now,
      build: () => ({ sha: SHA_A, version: '0.2.37', source: 'installed' }),
      writeBuild: () => true,
      writeTurn: () => true,
      log: () => undefined,
      herdr: null,
      signals: null,
      selfRestart: {
        staleness: () => H9_STALE as never,
        humanInputPending: () => false,
        sessionId: 'sess-h9-yield',
        minIdleMs: 1_000,
        intervalMs: 20,
        yieldSeat: (plan) => { yielded.push(plan.staleReason); order.push('yield'); },
      },
    });
    now += 60_000;
    await sleepMs(150);

    expect(yielded).toEqual(['installed-moved']);
    expect(order).toEqual(['spawn', 'yield']);
    stop();
  });

  test('spawn error 전에는 handoff하지 않고, 기존 좌석 녹음을 유지한다', async () => {
    const yielded: string[] = [];
    const turns: string[] = [];
    let now = 11_000_000;
    let tick = () => {};
    setTuiRelaunchSpawnForTesting((_command, _args, options) => {
      expect(options).toEqual({ detached: true, stdio: 'ignore' });
      return {
        on: (event, listener) => {
          if (event === 'error') queueMicrotask(() => (listener as (error: Error) => void)(new Error('spawn failed')));
          return undefined;
        },
        unref: () => {},
      };
    });
    const stop = startTuiRunStateRecorder('tui:h9-spawn-error', {
      now: () => now,
      writeBuild: () => true,
      writeTurn: (_id, turn) => { turns.push(turn); return true; },
      log: () => {},
      herdr: null,
      signals: null,
      selfRestart: {
        staleness: () => H9_STALE as never,
        humanInputPending: () => false,
        sessionId: 'sess-h9-spawn-error',
        minIdleMs: 1_000,
        yieldSeat: () => { yielded.push('yield'); },
        watch: (next) => { tick = next; return () => {}; },
      },
    });
    reportTuiTurn('idle');
    now += 2_000;
    tick();
    await sleepMs(0);

    expect(yielded).toEqual([]);
    reportTuiTurn('busy');
    expect(turns).toEqual(['idle', 'busy']);
    stop();
  });
});

// ── SURVIVAL-PROGRESS-CLOCK ────────────────────────────────────────────────
// 마지막 진전 시각(progress_at)으로 느림·정체·Esc 무시를 가른다. 판정은 순수(L0) — 가짜 시계 값으로.
describe('SURVIVAL-PROGRESS-CLOCK — judgeTurnProgress 네 판정', () => {
  const MIN = 60 * 1000;

  test('진전이 이어지면 98분 busy 도 slow 이지 stalled 가 아니다', () => {
    const now = 100 * MIN;
    expect(judgeTurnProgress({ turn: 'busy', turnAt: 2 * MIN, progressAt: now - 5_000, now }))
      .toBe('slow');
    // 진전이 «방금»이면 정체가 아니다 — 길이는 느림으로만 말한다.
    expect(judgeTurnProgress({ turn: 'busy', turnAt: 2 * MIN, progressAt: now - 5_000, now })).not.toBe('stalled');
  });

  test('진전이 12분 끊기면 stalled 다', () => {
    const now = 100 * MIN;
    expect(judgeTurnProgress({ turn: 'busy', turnAt: now - 98 * MIN, progressAt: now - 12 * MIN, now }))
      .toBe('stalled');
    // 진전 기록이 아예 없어도 턴 시작 뒤 12분이면 정체로 본다.
    expect(judgeTurnProgress({ turn: 'busy', turnAt: now - 12 * MIN, now })).toBe('stalled');
  });

  test('Esc 청구 뒤 30초가 지나도 busy 면 abort-ignored 다', () => {
    const now = 100 * MIN;
    expect(judgeTurnProgress({ turn: 'busy', turnAt: now - 40 * MIN, progressAt: now - 1_000, abortRequestedAt: now - 30_000, now }))
      .toBe('abort-ignored');
    // 30초 전이면 아직 무시라고 못 한다.
    expect(judgeTurnProgress({ turn: 'busy', turnAt: now - 40 * MIN, progressAt: now - 1_000, abortRequestedAt: now - 29_000, now }))
      .toBe('slow');
  });

  test('짧은 턴은 progressing 이다 · idle·재료 없음은 unknown', () => {
    const now = 100 * MIN;
    expect(judgeTurnProgress({ turn: 'busy', turnAt: now - 5_000, progressAt: now - 1_000, now }))
      .toBe('progressing');
    expect(judgeTurnProgress({ turn: 'idle', turnAt: now - 5_000, now })).toBe('unknown');
    expect(judgeTurnProgress({ turn: 'unknown', now })).toBe('unknown');
    expect(judgeTurnProgress({ turn: 'busy', now })).toBe('unknown');
  });

  test('기본 임계는 정체 12분 · 느린 턴 20분 · Esc 무시 30초다(임계 주입으로 덮을 수 있다)', () => {
    expect(DEFAULT_TURN_STALL_MS).toBe(12 * MIN);
    expect(DEFAULT_SLOW_TURN_MS).toBe(20 * MIN);
    expect(DEFAULT_ABORT_IGNORE_MS).toBe(30_000);
    const now = 1_000_000;
    expect(judgeTurnProgress({ turn: 'busy', turnAt: 0, progressAt: now - 60_000, now, stallMs: 30_000, slowTurnMs: 10 * MIN }))
      .toBe('stalled');
  });
});

describe('SURVIVAL-PROGRESS-CLOCK — 진전·Esc 청구 기록(recorder)', () => {
  test('reportTuiProgress 는 progress_at 을 올리고 5초 스로틀은 생략 · 실패는 관측만 남긴다', () => {
    upsertPtyManifest({ id: 'tui:progress', kind: 'tui', cmd: 'elanous', startedAt: 1, now: 1 });
    let t = 1_000;
    const logs: Array<[string, Record<string, unknown>]> = [];
    const stop = startTuiRunStateRecorder('tui:progress', {
      now: () => t,
      build: () => ({ version: 'v', sha: SHA_A, source: 'installed' }),
      log: (e, d) => logs.push([e, d]),
      herdr: null,
    });
    reportTuiProgress();
    expect(getPtyManifest('tui:progress')?.progressAt).toBe(1_000);
    t = 2_000;
    reportTuiProgress(); // 5초 안 — 스로틀 생략(실패 관측 없음)
    expect(getPtyManifest('tui:progress')?.progressAt).toBe(1_000);
    expect(logs.filter(([e]) => e === 'progress-write-failed')).toEqual([]);
    t = 7_000;
    reportTuiProgress();
    expect(getPtyManifest('tui:progress')?.progressAt).toBe(7_000);
    stop();
    // 녹음기가 없으면 아무 일도 안 한다.
    resetTuiRunStateForTesting();
    reportTuiProgress();
    expect(getPtyManifest('tui:progress')?.progressAt).toBe(7_000);
  });

  test('reportTuiTurn(\'busy\') 는 이전 턴의 progress_at 을 리셋한다(턴 시작 = 진전 0초)', () => {
    upsertPtyManifest({ id: 'tui:busy-reset', kind: 'tui', cmd: 'elanous', startedAt: 1, now: 1 });
    let t = 5_000;
    startTuiRunStateRecorder('tui:busy-reset', {
      now: () => t,
      build: () => ({ version: 'v', sha: SHA_A, source: 'installed' }),
      log: () => {},
      herdr: null,
    });
    reportTuiProgress();
    expect(getPtyManifest('tui:busy-reset')?.progressAt).toBe(5_000);
    // 이전 턴의 마지막 진전이 정체 임계(12분)보다 오래 묵은 뒤 새 busy 턴.
    t = 5_000 + 20 * 60_000;
    reportTuiTurn('busy');
    expect(getPtyManifest('tui:busy-reset')).toMatchObject({ turnState: 'busy', turnAt: t, progressAt: t });
    // busy 직후 5초 안 진전 기록은 스로틀 생략 — progress_at 은 리셋값(t) 유지.
    reportTuiProgress();
    expect(getPtyManifest('tui:busy-reset')?.progressAt).toBe(t);
    resetTuiRunStateForTesting();
  });

  test('reportTuiAbortRequested 는 abort_requested_at 을 남기고 새 busy 턴은 비운다', () => {
    upsertPtyManifest({ id: 'tui:abort', kind: 'tui', cmd: 'elanous', startedAt: 1, now: 1 });
    let t = 5_000;
    startTuiRunStateRecorder('tui:abort', {
      now: () => t,
      build: () => ({ version: 'v', sha: SHA_A, source: 'installed' }),
      log: () => {},
      herdr: null,
    });
    reportTuiAbortRequested();
    expect(getPtyManifest('tui:abort')?.abortRequestedAt).toBe(5_000);
    t = 6_000;
    reportTuiTurn('busy'); // 새 busy 턴 — 이전 Esc 청구는 이번 턴과 무관하다
    expect(getPtyManifest('tui:abort')?.abortRequestedAt).toBeUndefined();
    expect(getPtyManifest('tui:abort')).toMatchObject({ turnState: 'busy', turnAt: 6_000 });
    resetTuiRunStateForTesting();
    reportTuiAbortRequested();
    expect(getPtyManifest('tui:abort')?.abortRequestedAt).toBeUndefined();
  });

  test('진전 기록 실패(행 없음)는 턴을 막지 않고 관측으로 남긴다', () => {
    const logs: Array<[string, Record<string, unknown>]> = [];
    let fail = false;
    const stop = startTuiRunStateRecorder('tui:progress-fail', {
      now: () => 1,
      build: () => ({ version: 'v', sha: SHA_A, source: 'installed' }),
      writeBuild: () => true,
      writeTurn: () => true,
      writeProgress: () => fail,
      log: (e, d) => logs.push([e, d]),
    });
    reportTuiProgress();
    expect(logs.filter(([e]) => e === 'progress-write-failed')).toEqual([['progress-write-failed', { ptyId: 'tui:progress-fail', at: 1 }]]);
    fail = true;
    reportTuiProgress(); // 이번엔 성공 — 실패 관측 추가 없음
    expect(logs.filter(([e]) => e === 'progress-write-failed')).toHaveLength(1);
    stop();
  });
});

// TUI-SEAT-PILOT-2H-COMPARE — 판정 신호 한 줄: 실행 명령·runId·시작/끝 시각·두 표면의 원장 행·
// 산출 바이트·오류 수·결과를 «한 줄» 로 직렬화하고, 재지 못한 필드는 «미측정» 으로 남겨 측정된 0 과 섞지 않는다.
// 무대 = 격리 ELANOUS_STATE_DIR + fake clock(now 주입) + 실제 SQLite pty_events 경유.
describe('TUI-SEAT-PILOT-2H-COMPARE: 판정 신호 한 줄', () => {
  test('판정 신호 한 줄 — 실행 명령·runId·시작/끝 시각·두 표면 원장 행·산출 바이트·오류 수·결과를 직렬화하고 미측정 필드는 «미측정»으로 0과 구분된다', async () => {
    const ptyEventLog = await import('./pty-event-log.js');
    ptyEventLog.resetPtyEventLogForTesting();
    const surfaceId = `tui:seat-compare-${Date.now()}`;
    ptyEventLog.appendPtyEvent({ instance: 'test', surfaceId, kind: 'state', state: 'working', agent: 'codex', now: 1_000 });
    const lastSeq = ptyEventLog.appendPtyEvent({ instance: 'test', surfaceId, kind: 'state', state: 'idle', agent: 'codex', now: 2_000 });

    const startedAt = 1_700_000_000_000;
    let clock = startedAt;
    const lines: string[] = [];
    const stop = startTuiRunStateRecorder(surfaceId, {
      now: () => clock,
      build: () => ({ version: 'v', sha: SHA_A, source: 'installed' }),
      writeBuild: () => true,
      writeTurn: () => true,
      writeProgress: () => true,
      log: () => {},
      seatCompare: {
        runId: 'run-seat-2h-1',
        command: 'elanous tui --test',
        result: 'idle',
        write: (line) => { lines.push(line); return true; },
      },
    });
    reportTuiTurn('busy');
    reportTuiTurn('idle');
    clock = startedAt + 2 * 60 * 60_000;
    stop();

    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.includes('\n')).toBe(false);
    expect(line).toContain('run=run-seat-2h-1');
    expect(line).toContain('cmd=elanous tui --test');
    expect(line).toContain('start=2023-11-14T22:13:20.000Z');
    expect(line).toContain('end=2023-11-15T00:13:20.000Z');
    expect(line).toContain(`ledger:pty-event-log rows=2 lastSeq=${lastSeq} lastState=idle`);
    expect(line).toContain('ledger:tui-run-state rows=3 lastSeq=미측정 lastState=idle');
    expect(line).toContain('bytes=미측정');
    expect(line).toContain('errors=0');
    expect(line).toContain('result=idle');
  });

  test('생산 스위치 — ELANOUS_SEAT_COMPARE_RUN_ID 가 켠 녹음기의 종료 경로가 실 sim-log 파일에 한 줄을 append 한다', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { seatCompareDepsFromEnv } = await import('./tui-run-state.js');
    const logPath = join(mkdtempSync(join(stateDir, 'seat-compare-env-')), 'sim-log.log');
    const savedRunId = process.env.ELANOUS_SEAT_COMPARE_RUN_ID;
    const savedCommand = process.env.ELANOUS_SEAT_COMPARE_COMMAND;
    const savedLog = process.env.ELANOUS_SEAT_COMPARE_LOG;
    try {
      process.env.ELANOUS_SEAT_COMPARE_RUN_ID = 'run-seat-env-1';
      process.env.ELANOUS_SEAT_COMPARE_COMMAND = 'elanous tui --test';
      process.env.ELANOUS_SEAT_COMPARE_LOG = logPath;
      // 스위치가 꺼져 있으면 녹음기는 아무 줄도 안 남긴다(미실행=미측정).
      expect(seatCompareDepsFromEnv({})).toBeNull();
      const seatCompare = seatCompareDepsFromEnv();
      expect(seatCompare).not.toBeNull();
      let clock = 1_700_000_000_000;
      const stop = startTuiRunStateRecorder(`tui:seat-compare-env-${Date.now()}`, {
        now: () => clock,
        build: () => ({ version: 'v', sha: SHA_A, source: 'installed' }),
        writeBuild: () => true,
        writeTurn: () => true,
        writeProgress: () => true,
        log: () => {},
        seatCompare: seatCompare!,
      });
      reportTuiTurn('busy');
      reportTuiTurn('idle');
      clock += 60_000;
      stop();

      expect(existsSync(logPath)).toBe(true);
      const written = readFileSync(logPath, 'utf8').trimEnd().split('\n');
      expect(written).toHaveLength(1);
      expect(written[0]).toContain('run=run-seat-env-1');
      expect(written[0]).toContain('cmd=elanous tui --test');
      expect(written[0]).toContain('result=idle');
    } finally {
      if (savedRunId === undefined) delete process.env.ELANOUS_SEAT_COMPARE_RUN_ID;
      else process.env.ELANOUS_SEAT_COMPARE_RUN_ID = savedRunId;
      if (savedCommand === undefined) delete process.env.ELANOUS_SEAT_COMPARE_COMMAND;
      else process.env.ELANOUS_SEAT_COMPARE_COMMAND = savedCommand;
      if (savedLog === undefined) delete process.env.ELANOUS_SEAT_COMPARE_LOG;
      else process.env.ELANOUS_SEAT_COMPARE_LOG = savedLog;
    }
  });

  test('미측정 ≠ 0 — 못 잰 필드는 «미측정», 측정된 0 은 0 으로 직렬화된다', async () => {
    const { buildSeatCompareSignalLine, SEAT_COMPARE_UNMEASURED } = await import('./tui-run-state.js');
    const unknown = buildSeatCompareSignalLine({
      runId: null, command: null, startedAt: null, endedAt: null, outputBytes: null, errors: null, result: null,
      tuiRunState: { surface: 'tui-run-state', rows: null, lastSeq: null, lastState: null },
      ptyEventLog: { surface: 'pty-event-log', rows: null, lastSeq: null, lastState: null },
    });
    const measured = buildSeatCompareSignalLine({
      runId: 'run-0', command: 'elanous tui', startedAt: 0, endedAt: 0, outputBytes: 0, errors: 0, result: 'ok',
      tuiRunState: { surface: 'tui-run-state', rows: 0, lastSeq: 0, lastState: 'idle' },
      ptyEventLog: { surface: 'pty-event-log', rows: 0, lastSeq: 0, lastState: 'idle' },
    });
    expect(SEAT_COMPARE_UNMEASURED).toBe('미측정');
    expect(unknown).toContain('bytes=미측정');
    expect(unknown).toContain('errors=미측정');
    expect(unknown).toContain('ledger:pty-event-log rows=미측정 lastSeq=미측정 lastState=미측정');
    expect(unknown).toContain('start=미측정');
    expect(measured).toContain('bytes=0');
    expect(measured).toContain('errors=0');
    expect(measured).toContain('ledger:pty-event-log rows=0');
    expect(measured).toContain('start=1970-01-01T00:00:00.000Z');
  });

  test('run-f398f7dd fixture — 같은 Pod 종료로 뭉친 자식 실패 원인을 result로 구분하고 누락은 미측정으로 남긴다', async () => {
    const { buildSeatCompareSignalLine, SEAT_COMPARE_UNMEASURED } = await import('./tui-run-state.js');
    const common = {
      runId: 'run-f398f7dd',
      command: 'TUI-SEAT-PILOT-2H-COMPARE',
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_001_000,
      tuiRunState: { surface: 'tui-run-state', rows: 1, lastSeq: 1, lastState: 'idle' },
      ptyEventLog: { surface: 'pty-event-log', rows: 1, lastSeq: 1, lastState: 'idle' },
      outputBytes: 0,
      errors: 1,
    } as const;
    const outcomes = [
      buildSeatCompareSignalLine({ ...common, result: 'provider-failed:goal-elaboration' }),
      buildSeatCompareSignalLine({ ...common, result: 'boundary-rejected:sed' }),
      buildSeatCompareSignalLine({ ...common, result: 'aborted:no-change' }),
      buildSeatCompareSignalLine({ ...common, result: null }),
    ];

    expect(new Set(outcomes).size).toBe(4);
    expect(outcomes[0]).toContain('result=provider-failed:goal-elaboration');
    expect(outcomes[1]).toContain('result=boundary-rejected:sed');
    expect(outcomes[2]).toContain('result=aborted:no-change');
    expect(outcomes[3]).toContain(`result=${SEAT_COMPARE_UNMEASURED}`);
  });

  test('sim-log 기록 도구 — 한 줄을 append 하고 미실행이면 아무 줄도 남기지 않는다', async () => {
    const { appendSeatCompareSignalLine, buildSeatCompareSignalLine } = await import('./tui-run-state.js');
    const logPath = join(mkdtempSync(join(stateDir, 'sim-log-')), 'nested', 'sim-log.log');
    const line = buildSeatCompareSignalLine({
      runId: 'run-append', command: 'bun test', startedAt: 5, endedAt: 9, outputBytes: 12, errors: 1, result: 'fail',
      tuiRunState: { surface: 'tui-run-state', rows: 1, lastSeq: null, lastState: 'idle' },
      ptyEventLog: { surface: 'pty-event-log', rows: 0, lastSeq: 0, lastState: 'idle' },
    });
    expect(existsSync(logPath)).toBe(false);
    expect(appendSeatCompareSignalLine(line, { path: logPath })).toBe(true);
    expect(appendSeatCompareSignalLine(line, { path: logPath })).toBe(true);
    const written = readFileSync(logPath, 'utf8').trimEnd().split('\n');
    expect(written).toHaveLength(2);
    expect(written[0]).toBe(line);
  });

});
