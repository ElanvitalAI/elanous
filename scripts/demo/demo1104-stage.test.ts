import { expect, test } from 'bun:test';
import { DEMO1104_STAGE_CONFIG } from './demo1104-stage.config.js';
import { createDemoStageConsole, parseStageArgs, runMockStage } from './demo1104-stage.js';

test('the script config has target times for every act and V1–V6 fallbacks for acts 1–6', () => {
  expect(DEMO1104_STAGE_CONFIG.acts.map(act => [act.id, act.targetStartSec, act.targetEndSec])).toEqual([
    ['prologue', 0, 40], ['act-1', 40, 90], ['act-2', 90, 210], ['act-3', 210, 240],
    ['act-4', 240, 420], ['act-5', 420, 510], ['act-6', 510, 570], ['epilogue', 570, 600],
  ]);
  expect(DEMO1104_STAGE_CONFIG.acts.slice(1, 7).map(act => act.highlightVideoId)).toEqual(['V1', 'V2', 'V3', 'V4', 'V5', 'V6']);
  expect(DEMO1104_STAGE_CONFIG.lanes.map(lane => lane.id)).toEqual(['secretary', 'maker']);
  expect(DEMO1104_STAGE_CONFIG.lanes.every(lane => lane.startsAtAct === 'prologue')).toBe(true);
});

test('mock stage opens both work lines on the same rehearsal tick without live adapters', async () => {
  let now = 1_000;
  const starts: Array<{ lane: string; at: number }> = [];
  const stage = createDemoStageConsole({
    now: () => now,
    adapters: {
      async startLane(lane) { starts.push({ lane: lane.id, at: now }); },
      async runAct() {},
      async showVideo() {},
    },
  });

  await stage.start();
  now += 12_000;
  const snapshot = stage.snapshot();
  expect(starts).toEqual([{ lane: 'secretary', at: 1_000 }, { lane: 'maker', at: 1_000 }]);
  expect(snapshot.lanes.map(lane => lane.status)).toEqual(['started', 'started']);
  expect(snapshot.elapsedMs).toBe(12_000);
});

test('injected act failure starts its configured highlight transition within five seconds', async () => {
  const calls: string[] = [];
  const stage = createDemoStageConsole({
    adapters: {
      async startLane(lane) { calls.push(`start:${lane.id}`); },
      async runAct(act) { calls.push(`run:${act.id}`); throw new Error('fixture failure'); },
      async showVideo(videoId, act) { calls.push(`video:${act.id}:${videoId}`); },
    },
  });
  await stage.start();
  await stage.runActNow('act-4');
  const snapshot = stage.snapshot();

  expect(calls).toEqual(['start:secretary', 'start:maker', 'run:act-4', 'video:act-4:V4']);
  expect(snapshot.acts.find(act => act.id === 'act-4')?.status).toBe('video');
  expect(snapshot.transitions).toHaveLength(1);
  expect(snapshot.transitions[0]).toMatchObject({ actId: 'act-4', videoId: 'V4', trigger: 'failure', status: 'shown', requestedAt: expect.any(Number), completedAt: expect.any(Number) });
  expect(snapshot.transitions[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  expect(snapshot.transitions[0]!.latencyMs).toBeLessThanOrEqual(5_000);
});

test('a hung act switches to video within five seconds and CLI prints the observed transition', async () => {
  let now = 1_000;
  const scheduled: number[] = [];
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => { output.push(values.join(' ')); };
  let snapshot!: Awaited<ReturnType<typeof runMockStage>>;
  try {
    const args = parseStageArgs(['--mock', '--run-act', 'act-4', '--hang-act', 'act-4']);
    snapshot = await runMockStage(args, {
      now: () => now,
      timers: {
        setTimeout(callback, delayMs) { scheduled.push(delayMs); return setTimeout(() => { now += delayMs; callback(); }, 0); },
        clearTimeout(handle) { clearTimeout(handle); },
      },
    });
  } finally { console.log = originalLog; }

  expect(scheduled).toEqual([5_000, 5_000]);
  expect(snapshot.acts.find(act => act.id === 'act-4')?.status).toBe('video');
  expect(snapshot.transitions[0]).toMatchObject({ actId: 'act-4', videoId: 'V4', trigger: 'deadline', status: 'shown', failedAt: 6_000, requestedAt: 6_000, completedAt: 6_000, latencyMs: 0 });
  expect(output.some(line => line.includes('씬 정체 · 영상 전환 완료: act-4 → V4 · 0ms'))).toBe(true);
});

test('a video display that exceeds its deadline is reported failed and never counted as shown', async () => {
  let now = 1_000;
  const stage = createDemoStageConsole({
    now: () => now,
    timers: {
      setTimeout(callback, delayMs) { return setTimeout(() => { now += delayMs; callback(); }, 0); },
      clearTimeout(handle) { clearTimeout(handle); },
    },
    adapters: { async startLane() {}, async runAct() { throw new Error('injected'); }, showVideo() { return new Promise<void>(() => {}); } },
  });
  await stage.start();
  await expect(stage.runActNow('act-4')).rejects.toThrow('video display exceeded 5000ms');
  const snapshot = stage.snapshot();
  expect(snapshot.acts.find(act => act.id === 'act-4')?.status).toBe('failed');
  expect(snapshot.transitions[0]).toMatchObject({ status: 'failed', completedAt: null, latencyMs: null, error: 'video display exceeded 5000ms' });
});

test('a video adapter resolving after five seconds records actual completion but does not count as shown', async () => {
  let now = 1_000;
  const stage = createDemoStageConsole({
    now: () => now,
    adapters: {
      async startLane() {},
      async runAct() { throw new Error('injected'); },
      async showVideo() { now += 5_001; },
    },
  });
  await stage.start();
  await expect(stage.runActNow('act-4')).rejects.toThrow('video display exceeded 5000ms');
  expect(stage.snapshot().transitions[0]).toMatchObject({ status: 'failed', completedAt: 6_001, latencyMs: 5_001, error: 'video display exceeded 5000ms' });
});

test('manual video switch aborts a hung act and clears its deadline timer immediately', async () => {
  const scheduled: Array<{ delayMs: number; handle: ReturnType<typeof setTimeout> }> = [];
  const cleared: ReturnType<typeof setTimeout>[] = [];
  const stage = createDemoStageConsole({
    timers: {
      setTimeout(_callback, delayMs) {
        const handle = globalThis.setTimeout(() => {}, 60_000);
        scheduled.push({ delayMs, handle });
        return handle;
      },
      clearTimeout(handle) { cleared.push(handle); globalThis.clearTimeout(handle); },
    },
    adapters: {
      async startLane() {},
      runAct() { return new Promise<void>(() => {}); },
      async showVideo() {},
    },
  });
  await stage.start();
  const running = stage.runActNow('act-4');
  await Promise.resolve();
  expect(scheduled.map(timer => timer.delayMs)).toEqual([5_000]);
  await stage.switchToVideo('act-4');
  await running;
  expect(cleared).toContain(scheduled[0]!.handle);
  expect(stage.snapshot().acts.find(act => act.id === 'act-4')?.status).toBe('video');
});

test('superseded video transition cannot commit after a newer manual transition', async () => {
  let startedFirst: (() => void) | undefined;
  const firstStarted = new Promise<void>(resolve => { startedFirst = resolve; });
  let firstSignal: AbortSignal | undefined;
  let calls = 0;
  const stage = createDemoStageConsole({
    adapters: {
      async startLane() {},
      async runAct() { throw new Error('injected'); },
      showVideo(_videoId, _act, signal) {
        calls += 1;
        if (calls > 1) return Promise.resolve();
        firstSignal = signal;
        startedFirst?.();
        return new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      },
    },
  });
  await stage.start();
  const failedRun = stage.runActNow('act-4');
  await firstStarted;
  await stage.switchToVideo('act-4');
  await failedRun;
  expect(firstSignal?.aborted).toBe(true);
  expect(stage.snapshot().transitions.map(transition => transition.status)).toEqual(['superseded', 'shown']);
});

test('late completion from an act cannot overwrite a manual video transition', async () => {
  let resolveAct: (() => void) | undefined;
  let videoCalls = 0;
  const stage = createDemoStageConsole({
    adapters: {
      async startLane() {},
      runAct() { return new Promise<void>(resolve => { resolveAct = resolve; }); },
      async showVideo() { videoCalls++; },
    },
  });
  await stage.start();
  const running = stage.runActNow('act-4');
  await Promise.resolve();
  await stage.switchToVideo('act-4');
  resolveAct?.();
  await running;
  expect(videoCalls).toBe(1);
  expect(stage.snapshot().acts.find(act => act.id === 'act-4')?.status).toBe('video');
  expect(stage.snapshot().transitions).toHaveLength(1);
});

test('CLI requires mock mode and only allows explicitly injected acts', async () => {
  expect(() => parseStageArgs([])).toThrow('--mock');
  expect(() => parseStageArgs(['--mock', '--fail-act', 'act-4'])).toThrow('--fail-act must match');
  expect(parseStageArgs(['--mock', '--run-act', 'act-4', '--fail-act', 'act-4'])).toEqual({ mock: true, runAct: 'act-4', failAct: 'act-4' });
  expect(parseStageArgs(['--mock', '--run-act', 'act-4', '--hang-act', 'act-4'])).toEqual({ mock: true, runAct: 'act-4', hangAct: 'act-4' });
  expect(() => parseStageArgs(['--mock', '--run-act', 'act-4', '--fail-act', 'act-4', '--hang-act', 'act-4'])).toThrow('--hang-act cannot be combined');
  expect(parseStageArgs(['--help'])).toMatchObject({ help: true });
  expect(() => parseStageArgs(['--mock', '--fail-act', 'epilogue'])).toThrow('no configured highlight video');
  expect(parseStageArgs(['--mock', '--switch-to-video', 'act-5'])).toEqual({ mock: true, switchToVideo: 'act-5' });
  const failureOutput: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => { failureOutput.push(values.join(' ')); };
  let snapshot!: Awaited<ReturnType<typeof runMockStage>>;
  try { snapshot = await runMockStage({ mock: true, runAct: 'act-4', failAct: 'act-4' }); }
  finally { console.log = originalLog; }
  expect(snapshot.acts.find(act => act.id === 'act-4')?.status).toBe('video');
  expect(failureOutput.some(line => line.includes('씬 실패 · 영상 전환 완료: act-4 → V4'))).toBe(true);
  const switched = await runMockStage({ mock: true, switchToVideo: 'act-5' });
  expect(switched.acts.find(act => act.id === 'act-5')?.status).toBe('video');
});
