import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { runCodexExec } from './codex-exec.js';

type Spawn = NonNullable<Parameters<typeof runCodexExec>[0]['spawn']>;

function fakeProcess() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes: Buffer[] = [];
  stdin.on('data', chunk => writes.push(Buffer.from(chunk)));
  Object.assign(child, { stdin, stdout, stderr, kill: () => { child.emit('close', null); return true; } });
  const calls: Array<{ command: string; args: string[]; options: Parameters<Spawn>[2] }> = [];
  const spawn: Spawn = (command, args, options) => { calls.push({ command, args, options }); return child; };
  return { child, stdin, stdout, writes, calls, spawn };
}

describe('runCodexExec resumable turns', () => {
  it('starts a JSONL exec session and resumes the same thread for follow-up', async () => {
    const first = fakeProcess();
    const firstRun = runCodexExec({ cwd: '/tmp/worktree', prompt: 'first question', env: { HOME: '/tmp/home' }, spawn: first.spawn });
    expect(first.calls).toEqual([{
      command: 'codex',
      args: ['exec', '--json', '--approve-for-me', '-'],
      options: { cwd: '/tmp/worktree', env: { HOME: '/tmp/home' }, stdio: ['pipe', 'pipe', 'pipe'] },
    }]);
    expect(Buffer.concat(first.writes).toString()).toBe('first question');
    first.stdout.write('{"type":"thread.started","thread_id":"thread-123"}\n{"type":"turn.started","turn_id":"turn-1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"initial draft"}}\n{"type":"turn.completed","turn_id":"turn-1"}\n');
    first.child.emit('close', 0);
    expect(await firstRun).toEqual({
      ok: true, reason: 'success', exitCode: 0, sessionId: 'thread-123', result: 'initial draft', numTurns: 1, malformedLines: 0,
    });

    const follow = fakeProcess();
    const followRun = runCodexExec({ cwd: '/tmp/worktree', prompt: 'follow-up', resumeSessionId: 'thread-123', env: { HOME: '/tmp/home' }, spawn: follow.spawn });
    expect(follow.calls[0]?.args).toEqual([
      'exec', 'resume', '--json', '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"', 'thread-123', '-',
    ]);
    expect(Buffer.concat(follow.writes).toString()).toBe('follow-up');
    follow.stdout.write('{"type":"thread.started","thread_id":"thread-123"}\n{"type":"turn.started","turn_id":"turn-2"}\n{"type":"item.completed","item":{"type":"agent_message","text":"revised result"}}\n{"type":"turn.completed","turn_id":"turn-2"}\n');
    follow.child.emit('close', 0);
    expect(await followRun).toMatchObject({ ok: true, reason: 'success', sessionId: 'thread-123', result: 'revised result', numTurns: 1 });
  });

  it('fails closed if an initial exec completes without a thread id', async () => {
    const f = fakeProcess();
    const running = runCodexExec({ cwd: '/tmp/worktree', prompt: 'question', env: {}, spawn: f.spawn });
    f.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}\n{"type":"turn.completed"}\n');
    f.child.emit('close', 0);
    expect(await running).toMatchObject({ ok: false, reason: 'no-session', result: 'answer' });
  });

  it('preserves a different thread.started id from a resume stream so the driver can reject it', async () => {
    const f = fakeProcess();
    const running = runCodexExec({ cwd: '/tmp/worktree', prompt: 'follow-up', resumeSessionId: 'thread-123', env: {}, spawn: f.spawn });
    f.stdout.write('{"type":"thread.started","thread_id":"thread-other"}\n{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}\n{"type":"turn.completed"}\n');
    f.child.emit('close', 0);
    expect(await running).toMatchObject({ ok: true, sessionId: 'thread-other', result: 'answer' });
  });

  it('fails closed if a resume stream completes without a thread id', async () => {
    const f = fakeProcess();
    const running = runCodexExec({ cwd: '/tmp/worktree', prompt: 'follow-up', resumeSessionId: 'thread-123', env: {}, spawn: f.spawn });
    f.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}\n{"type":"turn.completed"}\n');
    f.child.emit('close', 0);
    expect(await running).toMatchObject({ ok: false, reason: 'no-session', sessionId: null, result: 'answer' });
  });
});
