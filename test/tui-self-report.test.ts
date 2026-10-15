// Interactive TUI self-report (PLAN P1b · S1). The observer throttles
// composed frames into SelfReportFrames; startTuiSelfReport wires it to
// bus + manifest + heartbeat with fully injectable deps (no real TUI).

import { describe, expect, test } from 'bun:test';

import { type SelfReportFrame } from '../src/capture/self-report-frame.js';
import { createTuiControlTarget, createTuiFrameObserver, startTuiSelfReport } from '../src/capture/tui-self-report.js';

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
