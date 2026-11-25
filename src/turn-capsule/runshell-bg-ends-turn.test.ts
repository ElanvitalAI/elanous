/**
 * RUNSHELL-BG-ENDS-TURN (0.3.37 P1) — a long RunShell never ends the turn silently before the answer.
 *
 * Virtual clock, real modules: shellCapsulePolicy (default cap) → runShellCapsule → installShellCapsuleSink frame →
 * wireCapsuleDoneKnock → real queue (notice producers) → createIdleWakeDoor.
 *   ① a 25 s command → its own result in the same turn (no capsule, no frame, no notice).
 *   ② a 90 s command → background at 60 s with a «will wake on completion» result → at 90 s the capsule-done frame
 *      knocks the idle door once, the queue row is actionable at once, and the task notification carries the output.
 * Expected values are literals (rule 11), not the product's constants.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskNotificationQueue } from '../agent/task-notification.js';
import { wireCapsuleDoneKnock } from '../tui/capsule-done-knock.js';
import { createChildNoticeProducers } from '../tui/core/notice-producers.js';
import { createNextTuiQueue } from '../tui/core/queue.js';
import { createIdleWakeDoor } from '../tui/idle-wake-door.js';
import { createNextTuiSteerInbox } from '../repl/next-tui-steer.js';
import { clearPendingUserInput } from '../session/pending-input.js';
import { onShellPreempt, signalShellPreempt, steerPreemptsShell } from '../session/shell-preempt.js';
import { buildBashTool } from '../skills/tools/index.js';
import { buildRunShellTool } from '../skills/tools/shell.js';
import { knownLongShellRunner, type CapsuleEvent } from './contract.js';
import { installShellCapsuleSink, runShellCapsule, shellCapsulePolicy } from './shell-capsule.js';

/** Virtual clock: timers fire only when the test advances time. */
function virtualClock() {
  let now = 1_000_000;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let ids = 0;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { const id = ++ids; timers.push({ at: now + ms, fn, id }); return id; },
    clearTimer: (id: unknown) => { timers = timers.filter((timer) => timer.id !== id); },
    requested: [] as number[],
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((timer) => timer !== due);
        now = due.at;
        due.fn();
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      now = end;
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}

interface FakeResult { readonly output: string; readonly exitCode: number | null }

function fakeCommand(clock: ReturnType<typeof virtualClock>, runsMs: number, output: string) {
  return {
    tool: 'RunShell' as const, command: `sleep ${runsMs / 1000}; echo ${output}`, clockFromSpawn: true,
    start: (_signal: AbortSignal | undefined, spawned: () => void) => new Promise<FakeResult>((resolve) => {
      spawned();
      clock.setTimer(() => resolve({ output, exitCode: 0 }), runsMs);
    }),
    describe: (result: FakeResult) => ({ status: result.exitCode === 0 ? 'ok' as const : 'failed' as const, output: result.output }),
    started: (capsuleId: string, syncCapMs: number): FakeResult => ({ output: `started ${capsuleId} ${syncCapMs}`, exitCode: null }),
  };
}

function seat(sessionId: string) {
  const frames: CapsuleEvent[] = [];
  const listeners: Array<(event: CapsuleEvent) => void> = [];
  const sink = installShellCapsuleSink(sessionId, (event) => { frames.push(event); for (const l of listeners) l(event); });
  const tuiQueue = createNextTuiQueue({ log: () => {} });
  const notices = createChildNoticeProducers(tuiQueue);
  const injected: unknown[] = [];
  let busy = true;
  const door = createIdleWakeDoor({ busy: () => busy, injectKey: (key) => { injected.push(key); }, queueWake: 'queue-wake', turnLifeLog: () => {} });
  door.register({ id: 'capsule-done' });
  const stop = wireCapsuleDoneKnock({
    sessionId, subscribe: (_id, listener) => { listeners.push(listener); return () => {}; },
    enqueue: (event, wake) => notices.capsuleDone(event, event.endedAt, wake),
    knock: () => { door.knock('capsule-done'); },
    busy: () => busy,
  });
  return { frames, tuiQueue, injected, endTurn: () => { busy = false; }, dispose: () => { stop(); sink.dispose(); } };
}

describe('RUNSHELL-BG-ENDS-TURN — default shell cap and the promised wake', () => {
  test('① 25 s command: the answer comes back in the same turn (no detach, no frame, no notice)', async () => {
    const clock = virtualClock();
    const s = seat('rs-25');
    const q = new TaskNotificationQueue(mkdtempSync(join(tmpdir(), 'rs-25-')));
    const pending = runShellCapsule(fakeCommand(clock, 25_000, 'OUT-25'), {
      policy: shellCapsulePolicy(undefined, () => undefined), queue: q, log: () => {},
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    await clock.advance(25_000);
    expect(await pending).toEqual({ output: 'OUT-25', exitCode: 0 });
    expect(s.frames).toEqual([]);
    expect(q.size).toBe(0);
    expect(s.tuiQueue.count).toBe(0);
    s.dispose();
  });

  test('② 90 s command: background at 60 s · will-wake result · completion knocks the idle door with the output', async () => {
    const clock = virtualClock();
    const s = seat('rs-90');
    const q = new TaskNotificationQueue(mkdtempSync(join(tmpdir(), 'rs-90-')));
    const pending = runShellCapsule(fakeCommand(clock, 90_000, 'OUT-90'), {
      policy: shellCapsulePolicy(undefined, () => undefined), queue: q, log: () => {},
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    await clock.advance(59_999);
    expect(s.frames).toEqual([]); // still the foreground wait
    await clock.advance(1);
    const started = await pending;
    const id = /^started (\S+) 60000$/.exec(started.output)?.[1] ?? '';
    expect(id).toMatch(/^shell-[0-9a-z]+-\d+$/);
    expect(s.frames.map((frame) => frame.type)).toEqual(['capsule-progress']);
    // The model had nothing else to do: the turn ends while the command runs.
    s.endTurn();
    await clock.advance(30_000);
    expect(s.frames.map((frame) => frame.type)).toEqual(['capsule-progress', 'capsule-done']);
    expect(s.injected).toEqual(['queue-wake']); // exactly one wake
    expect(s.tuiQueue.autoDispatchCount).toBe(1); // actionable at once, not a 120 s passive wait
    const [note] = q.drain();
    expect([note?.taskId, note?.state, note?.output, note?.durationMs]).toEqual([id, 'done', 'OUT-90', 90_000]);
    s.dispose();
  });
});

describe('RUNSHELL-BG-ENDS-TURN — only the promised wake knocks', () => {
  const done = (capsuleId: string, kind: 'shell' | 'agent') => ({
    type: 'capsule-done' as const, capsuleId, kind, sessionId: 'k-1', startedAt: 1, endedAt: 2, status: 'ok' as const, summary: 'x · ok · 1s',
  });
  function wire(busy: boolean) {
    const tuiQueue = createNextTuiQueue({ log: () => {} });
    const notices = createChildNoticeProducers(tuiQueue);
    const listeners: Array<(event: CapsuleEvent) => void> = [];
    let knocks = 0;
    wireCapsuleDoneKnock({
      sessionId: 'k-1', subscribe: (_id, listener) => { listeners.push(listener); return () => {}; },
      enqueue: (event, wake) => notices.capsuleDone(event, event.endedAt, wake), knock: () => { knocks++; }, busy: () => busy,
    });
    return { tuiQueue, emit: (event: CapsuleEvent) => { for (const l of listeners) l(event); }, knocks: () => knocks };
  }

  test('agent capsule and explicit bg shell handle stay passive (no knock)', () => {
    const w = wire(false);
    w.emit(done('agent-1', 'agent'));
    w.emit(done('shell:h-1:1', 'shell'));
    expect(w.knocks()).toBe(0);
    expect(w.tuiQueue.autoDispatchCount).toBe(0);
  });

  test('ordering: a manual (passive) completion queued first, then a promised shell completion → exactly one knock', () => {
    const w = wire(false);
    w.emit(done('agent-first', 'agent'));
    expect([w.knocks(), w.tuiQueue.autoDispatchCount]).toEqual([0, 0]);
    w.emit(done('shell-abc-9', 'shell'));
    expect([w.knocks(), w.tuiQueue.autoDispatchCount]).toEqual([1, 1]);
    w.emit(done('shell-abc-10', 'shell'));
    expect(w.knocks()).toBe(1);
  });

  test('a busy turn gets no knock, but the row is actionable for the turn-end door; a replay knocks nothing', () => {
    const w = wire(true);
    w.emit(done('shell-abc-7', 'shell'));
    expect(w.knocks()).toBe(0);
    expect(w.tuiQueue.autoDispatchCount).toBe(1);
    const idle = wire(false);
    idle.emit(done('shell-abc-8', 'shell'));
    idle.emit(done('shell-abc-8', 'shell'));
    expect(idle.knocks()).toBe(1);
  });
});

describe('RUNSHELL-BG-ENDS-TURN ① urgent steer detaches the foreground wait', () => {
  test('a person line at 20 s: the command moves to the background at once and still wakes the seat on completion', async () => {
    const clock = virtualClock();
    const s = seat('rs-preempt');
    const q = new TaskNotificationQueue(mkdtempSync(join(tmpdir(), 'rs-pre-')));
    const pending = runShellCapsule(fakeCommand(clock, 45_000, 'OUT-45'), {
      policy: shellCapsulePolicy(undefined, () => undefined), queue: q, log: () => {},
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    await clock.advance(20_000);
    expect(steerPreemptsShell(undefined)).toBe(true);
    signalShellPreempt('rs-preempt');
    const started = await pending;
    expect(started.output).toMatch(/^started shell-[0-9a-z]+-\d+ 20000$/);
    s.endTurn();
    await clock.advance(25_000);
    expect(s.injected).toEqual(['queue-wake']);
    expect(q.drain().map((n) => [n.state, n.output])).toEqual([['done', 'OUT-45']]);
    s.dispose();
  });

  test('another session\'s steer and a preempt before the spawn change nothing', async () => {
    const clock = virtualClock();
    const s = seat('rs-other');
    const q = new TaskNotificationQueue(mkdtempSync(join(tmpdir(), 'rs-oth-')));
    let spawn: () => void = () => {};
    const call = { ...fakeCommand(clock, 5_000, 'OUT-5'),
      start: (_signal: AbortSignal | undefined, spawned: () => void) => new Promise<FakeResult>((resolve) => {
        spawn = () => { spawned(); clock.setTimer(() => resolve({ output: 'OUT-5', exitCode: 0 }), 5_000); };
      }) };
    const pending = runShellCapsule(call, {
      policy: shellCapsulePolicy(undefined, () => undefined), queue: q, log: () => {},
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    signalShellPreempt('rs-other'); // approval wait: not launched yet
    spawn();
    signalShellPreempt('someone-else');
    await clock.advance(5_000);
    expect(await pending).toEqual({ output: 'OUT-5', exitCode: 0 });
    expect(s.frames).toEqual([]);
    s.dispose();
  });

  test('structured urgency only: person · crown · decision · alert preempt; info/status mail does not', () => {
    expect(steerPreemptsShell({ msgId: 1, from: 'TC', intent: 'info' })).toBe(false);
    expect(steerPreemptsShell({ msgId: 2, from: 'OP', intent: 'request' })).toBe(false);
    expect(steerPreemptsShell({ msgId: 3, from: 'X', intent: 'decision' })).toBe(true);
    expect(steerPreemptsShell({ msgId: 4, from: 'X', intent: 'alert' })).toBe(true);
    expect(steerPreemptsShell({ msgId: 5, from: 'X', intent: 'info', crownDirective: 'crown-77' })).toBe(true);
    expect(steerPreemptsShell({ msgId: 6, from: 'X', intent: 'info' }, true)).toBe(true);
  });

  test('the child steer inbox raises the preempt for a typed line, not for info mail', () => {
    const sid = 'rs-inbox';
    let fired = 0;
    const off = onShellPreempt(sid, () => { fired++; });
    const inbox = createNextTuiSteerInbox(sid, () => {});
    inbox.push('mail-1', 'status update', false, { msgId: 11, from: 'TC', intent: 'info' });
    expect(fired).toBe(0);
    inbox.push('h-1', 'stop, check the logs first', false);
    expect(fired).toBe(1);
    off();
    clearPendingUserInput(sid);
  });
});

describe('RUNSHELL-BG-ENDS-TURN ② known long runners and explicit run_in_background start detached', () => {
  test('executable + subcommand list', () => {
    expect(knownLongShellRunner(['bun', 'run', 'test:deterministic'])).toBe('bun run test:deterministic');
    expect(knownLongShellRunner('FOO=1 timeout 900 bun run test:deterministic')).toBe('bun run test:deterministic');
    expect(knownLongShellRunner('python3 /Users/x/seat-state/RES/tools/pregate.py 40103 --host minim5 --light')).toBe('pregate');
    // plain bun test / bun run test are not known-long (they take the 60 s wait like any command)
    expect(knownLongShellRunner(['bun', 'test'])).toBe(null);
    expect(knownLongShellRunner('bun test --timeout 30000')).toBe(null);
    expect(knownLongShellRunner(['bun', 'run', 'test'])).toBe(null);
    expect(knownLongShellRunner(['els', 'update-all'])).toBe('els update-all');
    expect(knownLongShellRunner(['els', 'update'])).toBe(null);
    expect(knownLongShellRunner('bash /Users/x/tools/rail-hourly-1008.sh')).toBe('rail script');
    expect(knownLongShellRunner(['/Users/x/tools/rail-asap-on-merge.sh'])).toBe('rail script');
    expect(knownLongShellRunner('echo run bun run test:deterministic later')).toBe(null);
    expect(knownLongShellRunner(['git', 'status'])).toBe(null);
  });

  test('requestedBackground detaches right after the spawn and the completion wakes the seat', async () => {
    const clock = virtualClock();
    const s = seat('rs-bg');
    const q = new TaskNotificationQueue(mkdtempSync(join(tmpdir(), 'rs-bg-')));
    const pending = runShellCapsule({ ...fakeCommand(clock, 300_000, 'OUT-300'), requestedBackground: true }, {
      policy: shellCapsulePolicy(undefined, () => undefined), queue: q, log: () => {},
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    await clock.advance(0);
    expect((await pending).output).toMatch(/^started shell-[0-9a-z]+-\d+ 0$/);
    s.endTurn();
    await clock.advance(300_000);
    expect(s.injected).toEqual(['queue-wake']);
    expect(q.drain().map((n) => n.output)).toEqual(['OUT-300']);
    s.dispose();
  });

  test('RunShell and Bash tool specs expose run_in_background as a boolean', () => {
    const runShell = buildRunShellTool().parameters as { properties: Record<string, { type: string }> };
    const bash = buildBashTool().parameters as { properties: Record<string, { type: string }> };
    expect([runShell.properties.run_in_background?.type, bash.properties.run_in_background?.type]).toEqual(['boolean', 'boolean']);
  });
});
