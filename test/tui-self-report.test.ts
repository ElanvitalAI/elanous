// Interactive TUI self-report (PLAN P1b · S1). The observer throttles
// composed frames into SelfReportFrames; startTuiSelfReport wires it to
// bus + manifest + heartbeat with fully injectable deps (no real TUI).

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type SelfReportFrame } from '../src/capture/self-report-frame.js';
import {
  createTuiControlTarget, createTuiFrameObserver, registerTuiForceStopHandler, startTuiSelfReport, type TuiRowMissingEvent,
} from '../src/capture/tui-self-report.js';
import {
  getPtyManifest, removePtyManifest, setPtyManifestDbPathForTesting, updatePtyManifestFrame, upsertPtyManifest,
} from '../src/pty-shell/pty-manifest.js';

describe('createTuiFrameObserver · throttle + frame shape', () => {
  test('joins lines to text, emits a well-formed self-report frame', () => {
    const out: SelfReportFrame[] = [];
    let t = 1_000_000;
    const obs = createTuiFrameObserver({
      surfaceId: 'tui:99', instance: 'test:axon', throttleMs: 1500, now: () => t, emit: (f) => out.push(f),
    });
    obs(['❯ /command', ' status bar'], { rows: 24, cols: 80 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      surfaceId: 'tui:99', instance: 'test:axon', kind: 'tui', mode: 'self-report',
      text: '❯ /command\n status bar', cols: 80, rows: 24, at: 1_000_000,
    });
  });

  test('cfg.runId 스탬프(K4) → 프레임에 runId·부재 시 생략', () => {
    const out: SelfReportFrame[] = [];
    const withRun = createTuiFrameObserver({
      surfaceId: 'tui:99', instance: 'test:axon', runId: 'run-k4', throttleMs: 0, now: () => 1, emit: (f) => out.push(f),
    });
    withRun(['x'], { rows: 1, cols: 1 });
    expect(out[0]!.runId).toBe('run-k4');
    const noRun: SelfReportFrame[] = [];
    const without = createTuiFrameObserver({
      surfaceId: 'tui:99', instance: 'test:axon', throttleMs: 0, now: () => 1, emit: (f) => noRun.push(f),
    });
    without(['x'], { rows: 1, cols: 1 });
    expect('runId' in (noRun[0] as object)).toBe(false);   // 부재 시 키 없음
  });

  test('throttles — <throttleMs skipped, ≥throttleMs emits', () => {
    const out: SelfReportFrame[] = [];
    let t = 0;
    const obs = createTuiFrameObserver({
      surfaceId: 'tui:1', instance: 'prod', throttleMs: 1500, now: () => t, emit: (f) => out.push(f),
    });
    obs(['a'], { rows: 1, cols: 1 });          // t=0 → emit
    t = 500; obs(['b'], { rows: 1, cols: 1 });  // +500 → skip
    t = 2000; obs(['c'], { rows: 1, cols: 1 }); // +2000 → emit
    expect(out.map((f) => f.text)).toEqual(['a', 'c']);
  });

  test('emit throwing does not propagate (observation never breaks draw)', () => {
    const obs = createTuiFrameObserver({
      surfaceId: 'x', instance: 'prod', throttleMs: 0, now: () => 1, emit: () => { throw new Error('boom'); },
    });
    expect(() => obs(['a'], { rows: 1, cols: 1 })).not.toThrow();
  });
});

describe('createTuiControlTarget · foreground terminal adapter', () => {
  test('translates text and named keys through injectKey in order', () => {
    const injected: Array<{ name: string; ctrl: boolean; shift: boolean }> = [];
    const target = createTuiControlTarget('tui:input', {
      splitKeys: () => [
        { name: 'a', ctrl: false, shift: false },
        { name: 'b', ctrl: false, shift: false },
      ],
      injectKey: (key) => { injected.push(key); return true; },
    });
    target.write('ab', 'human');
    expect(injected).toEqual([
      { name: 'a', ctrl: false, shift: false },
      { name: 'b', ctrl: false, shift: false },
    ]);
  });

  test('외부 주입 라우터가 대기열로 가져가면 키를 넣지 않는다(사용자 버퍼에 안 섞인다)', () => {
    const injected: string[] = [];
    const routed: string[] = [];
    const target = createTuiControlTarget('tui:route', {
      splitKeys: (s) => [...s].map((ch) => ({ name: ch, ctrl: false, shift: false })),
      injectKey: (key) => { injected.push(key.name); return true; },
      routeExternal: (chars) => { routed.push(chars); return chars.endsWith('\r') ? 'queued' : 'passthrough'; },
    });
    target.write('외부\r', 'human');
    expect(routed).toEqual(['외부\r']);
    expect(injected).toEqual([]);
    target.write('ab', 'human');
    expect(injected).toEqual(['a', 'b']);
  });

  test('raw-mode delivery failure throws, so IPC settles it as failure rather than success', () => {
    const target = createTuiControlTarget('tui:raw-off', {
      splitKeys: () => [{ name: 'x', ctrl: false, shift: false }],
      injectKey: () => false,
    });
    expect(() => target.write('x', 'human')).toThrow('tui-input-undelivered');
  });

  test('exposes the existing arbiter decision for a human-owned TUI', () => {
    const target = createTuiControlTarget('tui:arbiter', {
      splitKeys: () => [{ name: 'x', ctrl: false, shift: false }],
      injectKey: () => true,
    });
    expect(target.canWrite('human')).toBe(true);
    expect(target.canWrite('agent')).toBe(false);
  });

  test('routes explicit force-stop requests to the registered dashboard turn owner', () => {
    let calls = 0;
    const unregister = registerTuiForceStopHandler(() => { calls += 1; return true; });
    const target = createTuiControlTarget('tui:force-stop');
    try {
      expect(target.stopTurn?.(true)).toBe(true);
      expect(calls).toBe(1);
    } finally {
      unregister();
    }
    expect(target.stopTurn?.(true)).toBe(false);
    expect(calls).toBe(1);
  });
});

describe('startTuiSelfReport · wiring (injected deps)', () => {
  function harness() {
    const calls = {
      registered: null as null | ((l: readonly string[], d: { rows: number; cols: number }) => void),
      rows: [] as Array<{ id: string; now: number }>,
      frames: [] as Array<{ id: string; text: string; now: number }>,
      published: [] as SelfReportFrame[],
      heartbeats: [] as Array<{ id: string; now: number }>,
      closed: [] as Array<{ id: string; now: number }>,
      screens: [] as Array<{ id: string; text: string }>,
      exitFn: null as null | (() => void),
    };
    const stop = startTuiSelfReport({
      surfaceId: 'tui:42',
      throttleMs: 0,
      now: () => 5_000,
      heartbeatMs: 1_000_000, // effectively never fires in the test window
      createMirror: () => null, // no real stdout tap in tests → base layer
      register: (fn) => { calls.registered = fn; },
      publishFrame: (f) => calls.published.push(f),
      registerRow: (id, now) => calls.rows.push({ id, now }),
      writeFrame: (id, text, now) => calls.frames.push({ id, text, now }),
      writeScreen: (id, text) => calls.screens.push({ id, text }),
      heartbeat: (id, now) => calls.heartbeats.push({ id, now }),
      markClosed: (id, now) => calls.closed.push({ id, now }),
      onExit: (s) => { calls.exitFn = s; },
      registerControlTarget: () => () => {},
      startControlPoller: () => () => {},
    });
    return { calls, stop };
  }

  test('registers a manifest row + a frame observer on start', () => {
    const { calls, stop } = harness();
    expect(calls.rows).toEqual([{ id: 'tui:42', now: 5_000 }]);
    expect(typeof calls.registered).toBe('function');
    stop();
  });

  test('a coloured frame → ANSI preserved in bus AND manifest producers', () => {
    const { calls, stop } = harness();
    const coloured = '\x1b[32mscreen line\x1b[0m';
    calls.registered!([coloured], { rows: 10, cols: 40 });
    expect(calls.published).toHaveLength(1);
    expect(calls.published[0]!.text).toBe(coloured);
    expect(calls.frames).toEqual([{ id: 'tui:42', text: coloured, now: 5_000 }]);
    stop();
  });

  test('a frame → writeScreen(harness-screens 파일 sink)도 발행 — elanous self screen reader 커버', () => {
    const { calls, stop } = harness();
    const coloured = '\x1b[32mscreen line\x1b[0m';
    calls.registered!([coloured], { rows: 10, cols: 40 });
    expect(calls.screens).toEqual([{ id: 'tui:42', text: coloured }]);
    stop();
  });

  test('writeScreen throwing does not break self-report (fail-soft — 관측이 draw 를 안 깬다)', () => {
    const published: SelfReportFrame[] = [];
    const frames: Array<{ id: string; text: string }> = [];
    let obs: null | ((l: readonly string[], d: { rows: number; cols: number }) => void) = null;
    const stop = startTuiSelfReport({
      surfaceId: 'tui:42', throttleMs: 0, now: () => 1, heartbeatMs: 1_000_000,
      createMirror: () => null,
      register: (fn) => { obs = fn; },
      publishFrame: (f) => published.push(f),
      registerRow: () => {},
      writeFrame: (id, text) => frames.push({ id, text }),
      writeScreen: () => { throw new Error('screen boom'); },
      heartbeat: () => {}, markClosed: () => {}, onExit: () => {}, registerControlTarget: () => () => {}, startControlPoller: () => () => {},
    });
    expect(() => obs!(['x'], { rows: 1, cols: 1 })).not.toThrow();
    expect(published).toHaveLength(1);   // 버스 발행 계속(sink 예외 격리)
    expect(frames).toHaveLength(1);      // manifest 발행 계속
    stop();
  });

  test('K4 wiring — startTuiSelfReport 가 getHarnessRunId(env) 를 읽어 발행 프레임에 스탬프', () => {
    const prev = process.env.ELANOUS_RUN_ID;
    process.env.ELANOUS_RUN_ID = 'run-wiring-42';
    const published: SelfReportFrame[] = [];
    let registered: null | ((l: readonly string[], d: { rows: number; cols: number }) => void) = null;
    let stop: () => void = () => {};
    try {
      stop = startTuiSelfReport({
        surfaceId: 'tui:42', throttleMs: 0, now: () => 5_000, heartbeatMs: 1_000_000,
        createMirror: () => null,
        register: (fn) => { registered = fn; },
        publishFrame: (f) => published.push(f),
        registerRow: () => {}, writeFrame: () => {}, heartbeat: () => {}, markClosed: () => {}, onExit: () => {}, registerControlTarget: () => () => {}, startControlPoller: () => () => {},
      });
      registered!(['screen'], { rows: 10, cols: 40 });
    } finally {
      stop();
      if (prev === undefined) delete process.env.ELANOUS_RUN_ID; else process.env.ELANOUS_RUN_ID = prev;
    }
    expect(published).toHaveLength(1);
    expect(published[0]!.runId).toBe('run-wiring-42');   // 실 발행경로(emitText)에 env runId 도달
  });

  test('stop() unregisters observer + marks manifest closed (idempotent)', () => {
    const { calls, stop } = harness();
    stop();
    stop(); // idempotent
    expect(calls.registered).toBeNull();          // observer removed
    expect(calls.closed).toEqual([{ id: 'tui:42', now: 5_000 }]);
  });

  test('--name nickname is registered on the TUI manifest row (trimmed; absent stays absent)', () => {
    const rows: Array<{ id: string; nickname?: string }> = [];
    const base = {
      createMirror: () => null, heartbeatMs: 1_000_000,
      register: () => {}, publishFrame: () => {}, writeFrame: () => {}, writeScreen: () => {},
      heartbeat: () => {}, markClosed: () => {}, onExit: () => {},
      registerControlTarget: () => () => {}, startControlPoller: () => () => {},
      registerRow: (id: string, _now: number, nickname?: string) => { rows.push({ id, ...(nickname ? { nickname } : {}) }); },
    };
    startTuiSelfReport({ ...base, surfaceId: 'tui:named', nickname: '  op ' })();
    startTuiSelfReport({ ...base, surfaceId: 'tui:plain' })();
    expect(rows).toEqual([{ id: 'tui:named', nickname: 'op' }, { id: 'tui:plain' }]);
  });

  test('starts the shared control poller and stops it with the TUI', () => {
    let registered = false;
    let pollerStarts = 0;
    let pollerStops = 0;
    const stop = startTuiSelfReport({
      surfaceId: 'tui:poller', createMirror: () => null, heartbeatMs: 1_000_000,
      register: () => {}, publishFrame: () => {}, registerRow: () => {}, writeFrame: () => {}, writeScreen: () => {},
      heartbeat: () => {}, markClosed: () => {}, onExit: () => {},
      registerControlTarget: () => { registered = true; return () => { registered = false; }; },
      startControlPoller: () => { pollerStarts++; return () => { pollerStops++; }; },
    });
    expect(registered).toBe(true);
    expect(pollerStarts).toBe(1);
    stop();
    expect(registered).toBe(false);
    expect(pollerStops).toBe(1);
  });

  test('starts the deferred-wake poller for its own pty and stops it with the TUI (TUI-H4)', () => {
    const started: string[] = [];
    let stops = 0;
    const stop = startTuiSelfReport({
      surfaceId: 'tui:wake', createMirror: () => null, heartbeatMs: 1_000_000,
      register: () => {}, publishFrame: () => {}, registerRow: () => {}, writeFrame: () => {}, writeScreen: () => {},
      heartbeat: () => {}, markClosed: () => {}, onExit: () => {},
      registerControlTarget: () => () => {}, startControlPoller: () => () => {},
      startWakePoller: id => { started.push(id); return () => { stops++; }; },
    });
    expect(started).toEqual(['tui:wake']);
    stop();
    expect(stops).toBe(1);
  });

  test('control-target registration failure is fail-soft and never advertises the TUI', () => {
    const rows: string[] = [];
    const cleanup: string[] = [];
    const failures: Array<{ stage: string; message: string }> = [];
    const target = createTuiControlTarget('tui:register-failure', { injectKey: () => true });
    const originalDeactivate = target.deactivate;
    target.deactivate = () => { cleanup.push('deactivate'); originalDeactivate(); };

    let stop: () => void = () => { throw new Error('not initialized'); };
    expect(() => {
      stop = startTuiSelfReport({
        surfaceId: target.id,
        createControlTarget: () => target,
        registerControlTarget: () => { throw new Error('register unavailable'); },
        startControlPoller: () => { throw new Error('poller must not start'); },
        registerRow: (id) => rows.push(id),
        reportControlInitFailure: (stage, error) => failures.push({ stage, message: (error as Error).message }),
      });
    }).not.toThrow();

    expect(rows).toEqual([]);
    expect(failures).toEqual([{ stage: 'register-target', message: 'register unavailable' }]);
    expect(cleanup).toEqual(['deactivate']);
    expect(target.isAlive()).toBe(false);
    expect(() => { stop(); stop(); }).not.toThrow();
  });

  test('control-poller start failure rolls back the registered target and never advertises the TUI', () => {
    const rows: string[] = [];
    const cleanup: string[] = [];
    const failures: Array<{ stage: string; message: string }> = [];
    const target = createTuiControlTarget('tui:poller-failure', { injectKey: () => true });
    const originalDeactivate = target.deactivate;
    target.deactivate = () => { cleanup.push('deactivate'); originalDeactivate(); };

    let stop: () => void = () => { throw new Error('not initialized'); };
    expect(() => {
      stop = startTuiSelfReport({
        surfaceId: target.id,
        createControlTarget: () => target,
        registerControlTarget: () => () => { cleanup.push('unregister'); },
        startControlPoller: () => { throw new Error('poller unavailable'); },
        registerRow: (id) => rows.push(id),
        reportControlInitFailure: (stage, error) => failures.push({ stage, message: (error as Error).message }),
      });
    }).not.toThrow();

    expect(rows).toEqual([]);
    expect(failures).toEqual([{ stage: 'start-poller', message: 'poller unavailable' }]);
    expect(cleanup).toEqual(['unregister', 'deactivate']);
    expect(target.isAlive()).toBe(false);
    expect(() => { stop(); stop(); }).not.toThrow();
  });

  test('manifest publish failure removes a partial row and rolls resources back in reverse order', () => {
    const cleanup: string[] = [];
    const failures: Array<{ stage: string; message: string }> = [];
    const target = createTuiControlTarget('tui:manifest-failure', { injectKey: () => true });
    const originalDeactivate = target.deactivate;
    target.deactivate = () => { cleanup.push('deactivate'); originalDeactivate(); };

    let stop: () => void = () => { throw new Error('not initialized'); };
    expect(() => {
      stop = startTuiSelfReport({
        surfaceId: target.id,
        createControlTarget: () => target,
        registerControlTarget: () => () => { cleanup.push('unregister'); },
        startControlPoller: () => () => { cleanup.push('stop-poller'); },
        registerRow: () => { cleanup.push('publish-row'); throw new Error('manifest unavailable'); },
        rollbackRow: () => { cleanup.push('remove-row'); },
        reportControlInitFailure: (stage, error) => failures.push({ stage, message: (error as Error).message }),
      });
    }).not.toThrow();

    expect(failures).toEqual([{ stage: 'publish-manifest', message: 'manifest unavailable' }]);
    expect(cleanup).toEqual(['publish-row', 'remove-row', 'stop-poller', 'unregister', 'deactivate']);
    expect(target.isAlive()).toBe(false);
    expect(() => { stop(); stop(); }).not.toThrow();
  });

  test('rollback failures are observed without escaping or preventing later cleanup', () => {
    const cleanup: string[] = [];
    const cleanupFailures: Array<{ stage: string; message: string }> = [];
    let stop: () => void = () => { throw new Error('not initialized'); };

    expect(() => {
      stop = startTuiSelfReport({
        surfaceId: 'tui:cleanup-failure',
        createControlTarget: () => ({
          ...createTuiControlTarget('tui:cleanup-failure', { injectKey: () => true }),
          deactivate: () => { cleanup.push('deactivate'); },
        }),
        registerControlTarget: () => () => { cleanup.push('unregister'); throw new Error('unregister failed'); },
        startControlPoller: () => () => { cleanup.push('stop-poller'); throw new Error('poller stop failed'); },
        registerRow: () => { throw new Error('manifest unavailable'); },
        rollbackRow: () => { cleanup.push('remove-row'); throw new Error('row removal failed'); },
        reportControlCleanupFailure: (stage, error) => cleanupFailures.push({ stage, message: (error as Error).message }),
      });
    }).not.toThrow();

    expect(cleanup).toEqual(['remove-row', 'stop-poller', 'unregister', 'deactivate']);
    expect(cleanupFailures).toEqual([
      { stage: 'rollback-manifest', message: 'row removal failed' },
      { stage: 'stop-poller', message: 'poller stop failed' },
      { stage: 'unregister-target', message: 'unregister failed' },
    ]);
    expect(() => stop()).not.toThrow();
  });

  test('exit handler is wired to stop', () => {
    const { calls } = harness();
    expect(typeof calls.exitFn).toBe('function');
    calls.exitFn!();
    expect(calls.closed).toEqual([{ id: 'tui:42', now: 5_000 }]);
  });
});

describe('startTuiSelfReport · P1b-2 mirror = TIMER-driven grid sample (captures overlays)', () => {
  test('timer tick reads mirror.renderScreen() (full frame incl. overlay), resizes, dedups idle', () => {
    let resizedTo: { c: number; r: number } | null = null as { c: number; r: number } | null;
    let disposed = false;
    let ticksCleared = false;
    let screen = 'BASE only';
    const published: SelfReportFrame[] = [];
    let tickFn: (() => void) | null = null;
    const stop = startTuiSelfReport({
      surfaceId: 'tui:m', throttleMs: 1500, now: () => 9, heartbeatMs: 1_000_000,
      publishFrame: (f: SelfReportFrame) => published.push(f),
      registerRow: () => {}, writeFrame: () => {}, heartbeat: () => {}, markClosed: () => {}, onExit: () => {}, registerControlTarget: () => () => {}, startControlPoller: () => () => {},
      termSize: () => ({ rows: 30, cols: 100 }),
      driveTicks: (fn) => { tickFn = fn; return () => { ticksCleared = true; }; },
      createMirror: () => ({
        renderScreen: () => screen,
        resize: (c: number, r: number) => { resizedTo = { c, r }; },
        stop: () => { disposed = true; },
      }),
    });
    tickFn!();                                    // 1st sample → emit
    expect(published.map((f) => f.text)).toEqual(['BASE only']);
    expect(resizedTo).toEqual({ c: 100, r: 30 });  // resized to live dims
    tickFn!();                                    // unchanged → dedup skip
    expect(published).toHaveLength(1);
    screen = 'BASE + ╭Slash picker╮';             // an overlay appears (no render() needed)
    tickFn!();                                    // changed → emit (⭐picker captured)
    expect(published.map((f) => f.text)).toEqual(['BASE only', 'BASE + ╭Slash picker╮']);
    stop();
    expect(ticksCleared).toBe(true);              // stop clears the tick timer
    expect(disposed).toBe(true);                  // stop disposes mirror (restores stdout)
  });

  test('empty grid → skipped (no phantom frame)', () => {
    const published: SelfReportFrame[] = [];
    let tickFn: (() => void) | null = null;
    startTuiSelfReport({
      surfaceId: 'tui:e', throttleMs: 1500, now: () => 1, heartbeatMs: 1_000_000,
      publishFrame: (f: SelfReportFrame) => published.push(f),
      registerRow: () => {}, writeFrame: () => {}, heartbeat: () => {}, markClosed: () => {}, onExit: () => {}, registerControlTarget: () => () => {}, startControlPoller: () => () => {},
      termSize: () => ({ rows: 1, cols: 1 }),
      driveTicks: (fn) => { tickFn = fn; return () => {}; },
      createMirror: () => ({ renderScreen: () => '', resize: () => {}, stop: () => {} }),
    });
    tickFn!();
    expect(published).toHaveLength(0);
  });
});

describe('startTuiSelfReport · 박동마다 자기 행 확인 → 사라졌으면 다시 세운다 (TUI-PTY-SELF-REREGISTER)', () => {
  function rowHarness(opts: { lookup?: (id: string) => { alive: boolean } | null; dropWrites?: boolean } = {}) {
    let t = 10_000;
    const store = new Map<string, { alive: boolean; nickname?: string; frameAt?: number; build?: string }>();
    const registered: Array<{ id: string; now: number; nickname?: string }> = [];
    const heartbeats: number[] = [];
    const missing: TuiRowMissingEvent[] = [];
    const builds: string[] = [];
    let beat: (() => void) | null = null;
    let sigcont: (() => void) | null = null;
    let observer: ((l: readonly string[], d: { rows: number; cols: number }) => void) | null = null;
    const frames: Array<{ text: string; now: number }> = [];
    const stop = startTuiSelfReport({
      surfaceId: 'tui:777', nickname: ' opt ', throttleMs: 0, now: () => t, heartbeatMs: 15_000,
      createMirror: () => null, register: (fn) => { observer = fn; }, publishFrame: () => {},
      writeFrame: (id, text, now) => {
        frames.push({ text, now });
        const row = store.get(id);
        if (row && !opts.dropWrites) row.frameAt = now;
      },
      writeScreen: () => {},
      markClosed: () => {}, onExit: () => {}, registerControlTarget: () => () => {}, startControlPoller: () => () => {},
      registerRow: (id, now, nickname) => {
        registered.push({ id, now, ...(nickname ? { nickname } : {}) });
        store.set(id, { alive: true, ...(nickname ? { nickname } : {}) });
      },
      heartbeat: (_id, now) => heartbeats.push(now),
      lookupRow: opts.lookup ?? ((id) => store.get(id) ?? null),
      restoreBuild: (id) => {
        builds.push(id);
        const row = store.get(id);
        if (row && !opts.dropWrites) row.build = 'boot';
      },
      logRowMissing: (e) => missing.push(e),
      driveHeartbeat: (tick) => { beat = tick; return () => { beat = null; }; },
      onSigcont: (fn) => { sigcont = fn; return () => { sigcont = null; }; },
    });
    return {
      store, registered, heartbeats, missing, builds, frames, stop,
      render: (text: string) => observer!([text], { rows: 1, cols: 10 }),
      advance: (ms: number) => { t += ms; },
      beat: () => beat!(),
      sigcont: () => sigcont!(),
      beatArmed: () => beat !== null,
    };
  }

  test('행이 있으면 아무것도 안 한다 — 재등록 0 · 로그 0 · 평소 박동만', () => {
    const h = rowHarness();
    expect(h.registered).toHaveLength(1);           // 기동 때 한 번
    h.advance(15_000); h.beat();
    h.advance(15_000); h.beat();
    expect(h.registered).toHaveLength(1);
    expect(h.missing).toEqual([]);
    expect(h.heartbeats).toEqual([25_000, 40_000]);
    h.stop();
  });

  test('행을 지운 뒤 박동 1회 → 별명·surfaceId 그대로 복원 ⊕ row-missing 1줄(단서 포함)', () => {
    const h = rowHarness();
    h.render('❯ idle prompt');                       // 화면 한 장 — 그 뒤 idle(거울은 같은 화면을 다시 안 낸다)
    h.advance(15_000); h.beat();                     // 25_000 에 마지막으로 봤다
    h.store.delete('tui:777');                       // 남이 걷어 갔다(정지 중 stale 수거 등)
    h.advance(70_000); h.sigcont();                  // 95_000 — 정지 뒤 재개
    h.advance(1_000); h.beat();                      // 96_000 — 박동이 71s 만에 돈다
    expect(h.store.get('tui:777')).toEqual({ alive: true, nickname: 'opt', frameAt: 96_000, build: 'boot' });
    expect(h.registered.at(-1)).toEqual({ id: 'tui:777', now: 96_000, nickname: 'opt' });
    expect(h.builds).toEqual(['tui:777']);           // 재등록이 비운 판 칸을 다시 적는다
    expect(h.frames.at(-1)).toEqual({ text: '❯ idle prompt', now: 96_000 });   // 비운 frame 칸에 마지막 화면
    expect(h.missing).toHaveLength(1);
    expect(h.missing[0]).toMatchObject({
      surfaceId: 'tui:777', pid: process.pid, state: 'absent', reRegistered: true, frameRestored: true, buildRestored: true,
      lastSeenAt: 25_000, sinceMs: 71_000, gapMs: 71_000, heartbeatMs: 15_000,
      sigcontAt: 95_000, sigcontSinceLastSeen: true,
    });
    expect('error' in h.missing[0]!).toBe(false);
    h.advance(15_000); h.beat();                     // 다음 박동 — 이제 있으니 조용하다
    expect(h.missing).toHaveLength(1);
    h.stop();
  });

  test('frame·build 쓰기가 조용히 실패하면(다시 읽어도 빈 칸) frameRestored·buildRestored=false 로 남긴다', () => {
    const h = rowHarness({ dropWrites: true });
    h.render('❯ idle prompt');
    h.store.delete('tui:777');
    h.advance(15_000); h.beat();
    expect(h.frames.at(-1)).toEqual({ text: '❯ idle prompt', now: 25_000 });   // 쓰기는 시도했다
    expect(h.missing[0]).toMatchObject({ state: 'absent', reRegistered: true, frameRestored: false, buildRestored: false });
    h.stop();
  });

  test('frame·build 쓰기가 던지면 오류를 남기고 복원 false', () => {
    let t = 1;
    const missing: TuiRowMissingEvent[] = [];
    let beat: (() => void) | null = null;
    let observer: ((l: readonly string[], d: { rows: number; cols: number }) => void) | null = null;
    const store = new Map<string, { alive: boolean }>();
    startTuiSelfReport({
      surfaceId: 'tui:890', throttleMs: 0, now: () => t, heartbeatMs: 15_000,
      createMirror: () => null, register: (fn) => { observer = fn; }, publishFrame: () => {}, writeScreen: () => {},
      writeFrame: () => { throw new Error('disk full'); },
      heartbeat: () => {}, markClosed: () => {}, onExit: () => {}, registerControlTarget: () => () => {}, startControlPoller: () => () => {},
      registerRow: (id) => { store.set(id, { alive: true }); },
      lookupRow: (id) => store.get(id) ?? null,
      restoreBuild: () => { throw new Error('no build'); },
      logRowMissing: (e) => missing.push(e),
      driveHeartbeat: (tick) => { beat = tick; return () => {}; }, onSigcont: () => () => {},
    });
    observer!(['x'], { rows: 1, cols: 1 });             // 기동 frame 쓰기도 던지지만 fail-soft
    store.delete('tui:890');
    t = 15_001; beat!();
    expect(missing[0]).toMatchObject({ reRegistered: true, frameRestored: false, buildRestored: false, error: 'build: no build; frame: disk full' });
  });

  test('행이 alive=0(closed)이어도 살아 있는 TUI 면 다시 세운다', () => {
    const h = rowHarness();
    h.store.set('tui:777', { alive: false });
    h.advance(15_000); h.beat();
    expect(h.store.get('tui:777')?.alive).toBe(true);
    expect(h.missing[0]).toMatchObject({ state: 'closed', reRegistered: true, frameRestored: false, buildRestored: true, sigcontAt: null, sigcontSinceLastSeen: false });
    h.stop();
  });

  test('조회 실패는 «없다» 가 아니다 — 재등록 0 · 로그만(reRegistered:false · error) · 박동은 계속', () => {
    const h = rowHarness({ lookup: () => { throw new Error('SQLITE_BUSY'); } });
    h.advance(15_000); h.beat();
    expect(h.registered).toHaveLength(1);
    expect(h.heartbeats).toEqual([25_000]);
    expect(h.missing).toHaveLength(1);
    expect(h.missing[0]).toMatchObject({ state: 'lookup-failed', reRegistered: false, error: 'SQLITE_BUSY' });
    h.stop();
  });

  test('등록이 조용히 실패하면(다시 읽어도 없다) reRegistered:false · error 로 남긴다', () => {
    let t = 1;
    const missing: TuiRowMissingEvent[] = [];
    let beat: (() => void) | null = null;
    startTuiSelfReport({
      surfaceId: 'tui:888', throttleMs: 0, now: () => t, heartbeatMs: 15_000,
      createMirror: () => null, register: () => {}, publishFrame: () => {}, writeFrame: () => {}, writeScreen: () => {},
      heartbeat: () => {}, markClosed: () => {}, onExit: () => {}, registerControlTarget: () => () => {}, startControlPoller: () => () => {},
      registerRow: () => {},                           // fail-soft upsert 가 삼킨 꼴
      lookupRow: () => null, restoreBuild: () => {}, logRowMissing: (e) => missing.push(e),
      driveHeartbeat: (tick) => { beat = tick; return () => {}; }, onSigcont: () => () => {},
    })();
    // stop 뒤 박동은 아무것도 안 한다
    beat!();
    expect(missing).toEqual([]);
    startTuiSelfReport({
      surfaceId: 'tui:889', throttleMs: 0, now: () => t, heartbeatMs: 15_000,
      createMirror: () => null, register: () => {}, publishFrame: () => {}, writeFrame: () => {}, writeScreen: () => {},
      heartbeat: () => {}, markClosed: () => {}, onExit: () => {}, registerControlTarget: () => () => {}, startControlPoller: () => () => {},
      registerRow: () => {}, lookupRow: () => null, restoreBuild: () => {}, logRowMissing: (e) => missing.push(e),
      driveHeartbeat: (tick) => { beat = tick; return () => {}; }, onSigcont: () => () => {},
    });
    t = 15_001; beat!();
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ state: 'absent', reRegistered: false, error: 'row-still-missing-after-register' });
  });

  test('stop 이 박동 스케줄러 ⊕ SIGCONT 훅을 함께 푼다', () => {
    const h = rowHarness();
    h.stop();
    expect(h.beatArmed()).toBe(false);
  });

  test('실 manifest — 행을 지우고 박동 1회 → getPtyManifest 가 다시 행 ⊕ 마지막 화면을 돌려준다(쓰기 스로틀 창 안이어도)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-self-rereg-'));
    setPtyManifestDbPathForTesting(join(dir, 'pty', 'manifest.db'));
    try {
      const missing: TuiRowMissingEvent[] = [];
      let beat: (() => void) | null = null;
      let t = 1_000;
      let observer: ((l: readonly string[], d: { rows: number; cols: number }) => void) | null = null;
      const stop = startTuiSelfReport({
        surfaceId: 'tui:real', nickname: 'opt', throttleMs: 0, now: () => t, heartbeatMs: 15_000,
        createMirror: () => null, register: (fn) => { observer = fn; }, publishFrame: () => {}, writeScreen: () => {},
        writeFrame: (id, text, now) => updatePtyManifestFrame(id, () => text, now),
        markClosed: () => {}, onExit: () => {}, registerControlTarget: () => () => {}, startControlPoller: () => () => {},
        registerRow: (id, now, nickname) => upsertPtyManifest({ id, kind: 'tui', ...(nickname ? { nickname } : {}), cmd: 'elanous', startedAt: now, now }),
        heartbeat: () => {},
        lookupRow: (id) => getPtyManifest(id, { strict: true }),
        restoreBuild: () => {}, logRowMissing: (e) => missing.push(e),
        driveHeartbeat: (tick) => { beat = tick; return () => {}; }, onSigcont: () => () => {},
      });
      expect(getPtyManifest('tui:real')?.alive).toBe(true);
      t = 15_000; observer!(['❯ real frame'], { rows: 1, cols: 20 });
      expect(getPtyManifest('tui:real')?.frame).toBe('❯ real frame');
      removePtyManifest('tui:real');
      expect(getPtyManifest('tui:real')).toBeNull();
      t = 16_000; beat!();                           // 앞 frame 쓰기 1s 뒤 — 쓰기 스로틀(1.5s) 창 안
      const row = getPtyManifest('tui:real');
      expect(row?.alive).toBe(true);
      expect(row?.nickname).toBe('opt');
      expect(row?.frame).toBe('❯ real frame');
      expect(row?.frameAt).toBe(16_000);
      expect(row?.ownerPid).toBe(process.pid);
      expect(missing).toHaveLength(1);
      expect(missing[0]).toMatchObject({ state: 'absent', reRegistered: true, frameRestored: true });
      stop();
    } finally {
      setPtyManifestDbPathForTesting(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('getPtyManifest strict — 행 없음은 null, 조회 실패는 던진다(기본은 둘 다 null)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-self-rereg-strict-'));
    // 디렉터리를 db 경로로 주면 열기가 실패한다.
    setPtyManifestDbPathForTesting(dir);
    try {
      expect(getPtyManifest('tui:none')).toBeNull();
      expect(() => getPtyManifest('tui:none', { strict: true })).toThrow();
    } finally {
      setPtyManifestDbPathForTesting(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
