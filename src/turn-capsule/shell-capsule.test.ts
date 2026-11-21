import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskNotificationQueue } from '../agent/task-notification.js';
import { dispatchBashCapsule } from '../skills/tools/index.js';
import type { CapsuleEvent, CapsulePolicy } from './contract.js';
import { installShellCapsuleSink, listDetachedShellCapsules, runShellCapsule, stopDetachedShellCapsule } from './shell-capsule.js';

const capPolicy = (syncCapMs: number): CapsulePolicy => ({ decide: () => ({ mode: 'sync', syncCapMs, reason: 'capsule-sync-cap' }) });
const noCapPolicy: CapsulePolicy = { decide: () => ({ mode: 'sync', syncCapMs: Infinity, reason: 'sync-cap-zero' }) };
const queue = () => new TaskNotificationQueue(mkdtempSync(join(tmpdir(), 'a2-capsule-')));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Manual cap timer: the test decides when 10s «passed». */
function manualTimer() {
  let fire: (() => void) | null = null;
  return {
    setTimer: (fn: () => void) => { fire = fn; return 1; },
    clearTimer: () => { fire = null; },
    elapse: () => { const f = fire; fire = null; f?.(); },
  };
}

describe('CAPSULE-A2 shell capsule', () => {
  test('no cap (syncCapMs 0): start gets the turn signal itself, no timer, no frame, no notification', async () => {
    const turn = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const frames: CapsuleEvent[] = [];
    const sink = installShellCapsuleSink('s1', (event) => frames.push(event));
    const q = queue();
    const result = await runShellCapsule({
      tool: 'Bash', command: 'echo hi', turnSignal: turn.signal,
      start: async (signal) => { seen.push(signal); return 'hi'; },
      describe: () => ({ status: 'ok', output: '' }), started: () => 'started',
    }, { policy: noCapPolicy, queue: q, setTimer: () => { throw Error('no timer without a cap'); } });
    sink.dispose();
    expect(result).toBe('hi');
    expect(seen).toEqual([turn.signal]);
    expect(frames).toEqual([]);
    expect(q.size).toBe(0);
  });

  test('done within the cap: the result is returned as is and nothing is detached', async () => {
    const timer = manualTimer();
    const q = queue();
    const result = await runShellCapsule({
      tool: 'Bash', command: 'true', start: async () => 'fast',
      describe: () => ({ status: 'ok', output: '' }), started: () => 'started',
    }, { policy: capPolicy(10_000), queue: q, setTimer: timer.setTimer, clearTimer: timer.clearTimer, log: () => {} });
    expect(result).toBe('fast');
    expect(listDetachedShellCapsules()).toEqual([]);
    expect(q.size).toBe(0);
  });

  test('past the cap: started result · Esc no longer reaches the process · one progress and one done frame · one notification', async () => {
    const timer = manualTimer();
    const turn = new AbortController();
    const frames: CapsuleEvent[] = [];
    const logs: unknown[] = [];
    const sink = installShellCapsuleSink('s1', (event) => frames.push(event));
    const q = queue();
    let finish!: (value: string) => void;
    let inner: AbortSignal | undefined;
    let clock = 1_000;
    const pending = runShellCapsule({
      tool: 'Bash', command: 'sleep 600 # token=sk-abcdefghijklmnopqrstuvwx', turnSignal: turn.signal,
      start: (signal) => { inner = signal; return new Promise<string>((resolve) => { finish = resolve; }); },
      describe: (value) => ({ status: 'ok', output: value }),
      started: (id, cap) => `started ${id} ${cap}`,
    }, { policy: capPolicy(10_000), queue: q, now: () => clock, setTimer: timer.setTimer, clearTimer: timer.clearTimer,
      log: (event, data) => logs.push([event, data]), correlation: { turnId: 't7' } });
    await tick();
    clock = 11_000;
    timer.elapse();
    const started = await pending;
    const id = started.split(' ')[1]!;
    expect(started).toBe(`started ${id} 10000`);
    expect(id).toMatch(/^shell-rs-\d+$/);
    expect(listDetachedShellCapsules().map((c) => [c.capsuleId, c.tool])).toEqual([[id, 'Bash']]);

    turn.abort();
    expect(inner!.aborted).toBe(false);

    clock = 613_000;
    finish('all done');
    await tick();
    sink.dispose();
    expect(listDetachedShellCapsules()).toEqual([]);
    expect(frames.map((f) => f.type)).toEqual(['capsule-progress', 'capsule-done']);
    expect(frames[1]).toEqual({
      type: 'capsule-done', capsuleId: id, kind: 'shell', sessionId: 's1', startedAt: 1_000, endedAt: 613_000, status: 'ok',
      summary: 'Bash sleep 600 # token=*** · ok · 612s',
    });
    expect(JSON.stringify(frames)).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(logs).toEqual([
      ['turn-life:capsule-detached', { turnId: 't7', capsuleId: id, tool: 'Bash', kind: 'shell', syncCapMs: 10000, reason: 'capsule-sync-cap' }],
      ['turn-life:capsule-done', { turnId: 't7', capsuleId: id, tool: 'Bash', kind: 'shell', status: 'ok', durationMs: 612000 }],
    ]);
    const [note] = q.drain();
    expect([note!.taskId, note!.agentName, note!.state, note!.output, note!.durationMs]).toEqual([id, 'Bash', 'done', 'all done', 612_000]);
  });

  test('Esc before the cap still stops the process (today\'s behaviour)', async () => {
    const timer = manualTimer();
    const turn = new AbortController();
    let inner: AbortSignal | undefined;
    const pending = runShellCapsule({
      tool: 'Bash', command: 'sleep 5', turnSignal: turn.signal,
      start: (signal) => { inner = signal; return new Promise<string>((resolve) => signal!.addEventListener('abort', () => resolve('aborted'))); },
      describe: () => ({ status: 'cancelled', output: '' }), started: () => 'started',
    }, { policy: capPolicy(10_000), queue: queue(), setTimer: timer.setTimer, clearTimer: timer.clearTimer, log: () => {} });
    turn.abort();
    expect(await pending).toBe('aborted');
    expect(inner!.aborted).toBe(true);
  });

  test('a detached capsule can be stopped by id; a failure is a failed notification', async () => {
    const timer = manualTimer();
    const sink = installShellCapsuleSink('s3', () => {});
    const q = queue();
    const pending = runShellCapsule({
      tool: 'RunShell', command: 'sleep 600',
      start: (signal) => new Promise<string>((_, reject) => signal!.addEventListener('abort', () => reject(new Error('killed')))),
      describe: () => ({ status: 'ok', output: '' }), started: (id) => id,
    }, { policy: capPolicy(10_000), queue: q, setTimer: timer.setTimer, clearTimer: timer.clearTimer, log: () => {} });
    await tick();
    timer.elapse();
    const id = await pending;
    expect(stopDetachedShellCapsule(id, 'foreign')).toBe(false);
    expect(q.drain()).toEqual([]);
    expect(stopDetachedShellCapsule(id)).toBe(true);
    expect(stopDetachedShellCapsule('shell-unknown')).toBe(false);
    await tick();
    sink.dispose();
    const [note] = q.drain();
    expect([note!.taskId, note!.agentName, note!.state, note!.output, note!.errorMessage]).toEqual([id, 'RunShell', 'error', 'killed', 'capsule failed']);
    // JUD #38713 ②: the notification names its session — the scoped drain never hands it to another one.
    expect(note!.parentSessionId).toBe('s3');
  });

  test('JUD #38713 ①: no sink (not the Next TUI child) — inline: no timer, nothing detached, no notification', async () => {
    const turn = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const q = queue();
    const result = await runShellCapsule({
      tool: 'Bash', command: 'sleep 15', turnSignal: turn.signal,
      start: async (signal) => { seen.push(signal); return 'inline result'; },
      describe: () => ({ status: 'ok', output: '' }), started: () => 'started',
    }, { policy: capPolicy(10_000), queue: q, setTimer: () => { throw Error('no timer without a sink'); } });
    expect(result).toBe('inline result');
    expect(seen).toEqual([turn.signal]);
    expect(listDetachedShellCapsules()).toEqual([]);
    expect(q.size).toBe(0);
  });
});

describe('CAPSULE-A2 dispatchBashCapsule (real process)', () => {
  test('a 1.5s command under a 200ms cap detaches, survives the turn abort, and reports its real output', async () => {
    const turn = new AbortController();
    const frames: CapsuleEvent[] = [];
    const sink = installShellCapsuleSink('s2', (event) => frames.push(event));
    const q = queue();
    const started = await dispatchBashCapsule({ command: 'sleep 1.5; echo capsule-finished' }, { cwd: tmpdir(), signal: turn.signal },
      { policy: capPolicy(200), queue: q, log: () => {} });
    const id = /capsule shell (\S+) started/.exec(started.output)?.[1] ?? '';
    expect(id).toMatch(/^shell-[0-9a-z]+-\d+$/);
    expect(started.exitCode).toBeNull();
    expect(started.output).toBe(`[capsule shell ${id} started] Still running after 0s, so it moved to the background (same process, same timeout). Do not wait or poll for it: finish this turn. Its result arrives as a new turn event (capsule-done ${id}).`);
    turn.abort();
    for (let i = 0; i < 60 && q.size === 0; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    sink.dispose();
    const [note] = q.drain();
    expect([note!.taskId, note!.state, note!.output.trim()]).toEqual([id, 'done', 'capsule-finished']);
    expect(frames.map((f) => [f.type, f.capsuleId])).toEqual([['capsule-progress', id], ['capsule-done', id]]);
  });

  test('JUD #38713 ①: --json/harness repl (no sink) — a command past the cap still returns its real result inline', async () => {
    const q = queue();
    const result = await dispatchBashCapsule({ command: 'sleep 0.6; echo inline-finished' }, { cwd: tmpdir() },
      { policy: capPolicy(200), queue: q, log: () => {} });
    expect([result.exitCode, result.output.trim()]).toEqual([0, 'inline-finished']);
    expect(q.size).toBe(0);
  });

  test('a short command under the cap returns its plain Bash result', async () => {
    const result = await dispatchBashCapsule({ command: 'echo quick' }, { cwd: tmpdir() }, { policy: capPolicy(10_000), queue: queue(), log: () => {} });
    expect([result.exitCode, result.output.trim()]).toEqual([0, 'quick']);
  });
});
