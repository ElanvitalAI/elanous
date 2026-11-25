import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskNotificationQueue } from '../agent/task-notification.js';
import { dispatchRunShellCapsule, runShellCapsuleNoticeText, runShellCapsuleStatus } from '../skills/tools/shell.js';
import type { CapsuleEvent, CapsulePolicy } from './contract.js';
import { installShellCapsuleSink, listDetachedShellCapsules, runShellCapsule } from './shell-capsule.js';

const capPolicy = (syncCapMs: number): CapsulePolicy => ({ decide: () => ({ mode: 'sync', syncCapMs, reason: 'capsule-sync-cap' }) });
const noCapPolicy: CapsulePolicy = { decide: () => ({ mode: 'sync', syncCapMs: Infinity, reason: 'sync-cap-zero' }) };
const queue = () => new TaskNotificationQueue(mkdtempSync(join(tmpdir(), 'a2b-capsule-')));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('CAPSULE-A2 RunShell — the sync clock starts at spawn', () => {
  test('an approval wait longer than the cap never detaches; the cap counts from spawned()', async () => {
    let fire: (() => void) | null = null;
    let armed = 0;
    let spawned!: () => void;
    let finish!: (value: string) => void;
    const sink = installShellCapsuleSink('s-rs', () => {});
    const pending = runShellCapsule({
      tool: 'RunShell', command: 'sleep 600', clockFromSpawn: true,
      start: (_signal, onSpawn) => { spawned = onSpawn; return new Promise<string>((resolve) => { finish = resolve; }); },
      describe: () => ({ status: 'ok', output: '' }), started: (id) => `started ${id}`,
    }, { policy: capPolicy(10_000), queue: queue(), log: () => {},
      setTimer: (fn) => { armed++; fire = fn; return 1; }, clearTimer: () => { fire = null; } });
    await tick();
    expect(armed).toBe(0);
    spawned();
    spawned();
    expect(armed).toBe(1);
    fire!();
    expect(await pending).toMatch(/^started shell-[0-9a-z]+-\d+$/);
    finish('done');
    await tick();
    expect(listDetachedShellCapsules()).toEqual([]);
    sink.dispose();
  });

  test('notice text = stdout · stderr · summary (summary last so the bounded tail keeps it)', () => {
    const base = { exitCode: 0, elapsedMs: 1, truncated: false, approvalKey: 'k', sandboxed: false, sandboxTool: 'none' as const, outcome: 'exit' as const };
    expect([
      runShellCapsuleNoticeText({ ...base, output: 'RunShell outcome=exit', stdout: 'out\n', stderr: '' }),
      runShellCapsuleNoticeText({ ...base, output: 'RunShell outcome=exit', stdout: '', stderr: 'err\n' }),
      runShellCapsuleNoticeText({ ...base, output: 'RunShell outcome=exit', stdout: '', stderr: '' }),
    ]).toEqual(['out\nRunShell outcome=exit', '--- stderr ---\nerr\nRunShell outcome=exit', 'RunShell outcome=exit']);
  });

  test('status mapping', () => {
    const base = { output: '', exitCode: 0, elapsedMs: 1, stdout: '', stderr: '', truncated: false, approvalKey: 'k', sandboxed: false, sandboxTool: 'none' as const };
    expect([
      runShellCapsuleStatus({ ...base, outcome: 'exit' }),
      runShellCapsuleStatus({ ...base, outcome: 'exit', exitCode: 2 }),
      runShellCapsuleStatus({ ...base, outcome: 'timeout', exitCode: null }),
      runShellCapsuleStatus({ ...base, outcome: 'aborted', exitCode: null }),
      runShellCapsuleStatus({ ...base, outcome: 'spawn-error', exitCode: null }),
    ]).toEqual(['ok', 'failed', 'timeout', 'cancelled', 'failed']);
  });
});

describe('CAPSULE-A2 dispatchRunShellCapsule (real legacy RunShell process)', () => {
  test('a 1.5s argv command under a 200ms cap detaches, survives the turn abort, and reports its exit', async () => {
    const turn = new AbortController();
    const frames: CapsuleEvent[] = [];
    const sink = installShellCapsuleSink('s3', (event) => frames.push(event));
    const q = queue();
    const started = await dispatchRunShellCapsule({ command: ['sh', '-c', 'sleep 1.5; echo PAYLOAD-OUT; echo PAYLOAD-ERR >&2'], cwd: tmpdir() },
      { signal: turn.signal }, { policy: capPolicy(200), queue: q, log: () => {} });
    const id = /capsule=(\S+)/.exec(started.output)?.[1] ?? '';
    expect(id).toMatch(/^shell-[0-9a-z]+-\d+$/);
    expect([started.outcome, started.exitCode]).toEqual(['started', null]);
    expect(started.output).toBe(`RunShell outcome=started capsule=${id} · running in background · will wake on completion — still running after 0s (same process, same timeout). If this turn has other work, continue it; otherwise end the turn with one line saying you are waiting for it — a new turn opens with its output (capsule-done ${id}) when it finishes. Do not poll or sleep for it.`);
    turn.abort();
    for (let i = 0; i < 60 && q.size === 0; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    sink.dispose();
    const [note] = q.drain();
    expect([note?.taskId, note?.agentName, note?.state]).toEqual([id, 'RunShell', 'done']);
    // JUD #38592 must ⓑ: the command's own output reaches the next turn, not only the summary line.
    expect(note?.output).toMatch(/^PAYLOAD-OUT\n--- stderr ---\nPAYLOAD-ERR\nRunShell outcome=exit exitCode=0 elapsed=\d+ms$/);
    expect(frames.map((f) => [f.type, f.capsuleId, f.kind])).toEqual([['capsule-progress', id, 'shell'], ['capsule-done', id, 'shell']]);
  });

  test('no cap (syncCapMs 0): plain RunShell result', async () => {
    const result = await dispatchRunShellCapsule({ command: ['sh', '-c', 'echo off'], cwd: tmpdir() }, {}, { policy: noCapPolicy, queue: queue() });
    expect([result.outcome, result.exitCode, result.stdout.trim()]).toEqual(['exit', 0, 'off']);
  });
});
