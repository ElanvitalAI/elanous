import { describe, it, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { runClaudeHeadless } from './claude-headless.js';

type Spawn = NonNullable<Parameters<typeof runClaudeHeadless>[0]['spawn']>;

function fakeProcess() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes: Buffer[] = [];
  stdin.on('data', (chunk: Buffer) => writes.push(chunk));
  Object.assign(child, { stdin, stdout, stderr, kill: () => { child.emit('close', null); return true; } });
  const calls: Array<{ command: string; args: string[]; options: Parameters<Spawn>[2] }> = [];
  const spawn: Spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
  return { child, stdin, stdout, stderr, writes, calls, spawn };
}

const options = { cwd: '/test/worktree', prompt: 'exact\nmission\n', env: { HOME: '/test/home' } };

describe('runClaudeHeadless', () => {
  it('pipes verbatim prompt to stdin, counts tool_use blocks and malformed lines across chunk boundaries, extracts result metadata', async () => {
    const f = fakeProcess();
    const running = runClaudeHeadless({ ...options, spawn: f.spawn, timeoutMs: 1000 });
    expect(f.calls).toEqual([{
      command: 'claude',
      args: ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'],
      options: { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] },
    }]);
    expect(Buffer.concat(f.writes).toString()).toBe(options.prompt);
    expect(f.stdin.writableEnded).toBe(true);
    f.stdout.write('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"},{"type":"text","text":"hi"}]}}\nnot json\n{"type":"assistant","message":{"content":[{"type":"tool_');
    f.stdout.write('use","name":"Edit"}]}}\n{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"session-1","num_turns":3,"duration_ms":1200,"duration_api_ms":900,"total_cost_usd":0.12,"usage":{"input_tokens":42,"output_tokens":17}}\n');
    f.child.emit('close', 0);
    expect(await running).toEqual({
      ok: true, reason: 'success', exitCode: 0, result: 'done', subtype: 'success',
      sessionId: 'session-1', isError: false, numTurns: 3, durationMs: 1200,
      durationApiMs: 900, totalCostUsd: 0.12, usage: { input_tokens: 42, output_tokens: 17 },
      toolEvents: 2, malformedLines: 1,
    });
  });

  it('bounds the Claude CLI with --max-turns when specified', async () => {
    const f = fakeProcess();
    const running = runClaudeHeadless({ ...options, spawn: f.spawn, maxTurns: 3 });
    expect(f.calls[0]?.args).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--max-turns', '3',
    ]);
    f.stdout.write('{"type":"result","subtype":"success","is_error":false,"result":"done"}\n');
    f.child.emit('close', 0);
    expect((await running).ok).toBe(true);
  });

  it('rejects an invalid maxTurns before spawning', async () => {
    const f = fakeProcess();
    await expect(runClaudeHeadless({ ...options, spawn: f.spawn, maxTurns: 0 }))
      .rejects.toThrow('maxTurns must be a positive integer');
    expect(f.calls).toHaveLength(0);
  });

  it('preserves UTF-8 result and metadata when a multibyte character crosses stdout Buffer boundaries', async () => {
    const f = fakeProcess();
    const running = runClaudeHeadless({ ...options, spawn: f.spawn });
    const result = '한국어 결과';
    const sessionId = '세션-1';
    const bytes = Buffer.from(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result, session_id: sessionId,
    }) + '\n');
    const resultSplit = bytes.indexOf(Buffer.from('한')) + 1;
    const metadataSplit = bytes.indexOf(Buffer.from('세')) + 1;
    f.stdout.write(bytes.subarray(0, resultSplit));
    f.stdout.write(bytes.subarray(resultSplit, metadataSplit));
    f.stdout.write(bytes.subarray(metadataSplit));
    f.child.emit('close', 0);
    expect(await running).toMatchObject({
      ok: true, reason: 'success', result, sessionId, malformedLines: 0,
    });
  });

  it('fails closed as no-result when CLI exits 0 without a result event (including a malformed final line)', async () => {
    const f = fakeProcess();
    const running = runClaudeHeadless({ ...options, spawn: f.spawn });
    f.stdout.write('{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}\n{broken');
    f.child.emit('close', 0);
    expect(await running).toMatchObject({ ok: false, reason: 'no-result', exitCode: 0, toolEvents: 1, malformedLines: 1 });
  });

  it('does not mistake an error result or nonzero CLI exit for success', async () => {
    for (const [event, exitCode, reason] of [
      [{ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'failure' }, 0, 'result-error'],
      [{ type: 'result', subtype: 'success', is_error: false, result: 'done' }, 2, 'cli-error'],
    ] as const) {
      const f = fakeProcess();
      const running = runClaudeHeadless({ ...options, spawn: f.spawn });
      f.stdout.write(`${JSON.stringify(event)}\n`);
      f.child.emit('close', exitCode);
      expect(await running).toMatchObject({ ok: false, reason, exitCode, result: event.result });
    }
  });

  it('keeps timeout and error results unchanged after late stdout and repeated close events', async () => {
    for (const termination of ['timeout', 'error'] as const) {
      const f = fakeProcess();
      const running = runClaudeHeadless({ ...options, spawn: f.spawn, timeoutMs: termination === 'timeout' ? 1 : 1000 });
      f.stdout.write('invalid json\n{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}');
      const onData = f.stdout.listeners('data')[0] as (chunk: string) => void;
      if (termination === 'error') f.child.emit('error', new Error('spawn failed'));
      const result = await running;
      expect(result).toMatchObject({
        ok: false, reason: termination === 'timeout' ? 'timeout' : 'spawn-error',
        result: null, usage: null, toolEvents: 1, malformedLines: 1,
      });
      const snapshot = structuredClone(result);
      expect(f.stdout.listenerCount('data')).toBe(0);
      onData('{"type":"result","subtype":"success","result":"late","usage":{"input_tokens":99}}\n');
      f.stdout.emit('data', '{"type":"result","subtype":"success","result":"late","usage":{"input_tokens":99}}\n');
      f.stdout.emit('data', '{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}\ninvalid\n');
      f.child.emit('close', 0);
      expect(result).toEqual(snapshot);
    }
  });

  it('kills and reports timeout, and reports spawn errors without hanging', async () => {
    const f = fakeProcess();
    const running = runClaudeHeadless({ ...options, spawn: f.spawn, timeoutMs: 1 });
    expect(await running).toMatchObject({ ok: false, reason: 'timeout' });
    expect(await runClaudeHeadless({ ...options, spawn: (() => { throw new Error('ENOENT'); }) as Spawn }))
      .toMatchObject({ ok: false, reason: 'spawn-error' });
  });

  it('publishes a cancellable child only when spawn returned a real pid', async () => {
    const missing = fakeProcess();
    const spawned: number[] = [];
    const running = runClaudeHeadless({ ...options, spawn: missing.spawn, timeoutMs: 1000, onSpawn: (pid) => spawned.push(pid) });
    missing.child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    expect(await running).toMatchObject({ ok: false, reason: 'spawn-error' });
    expect(spawned).toEqual([]);

    const real = fakeProcess();
    Object.assign(real.child, { pid: 4242 });
    const published = runClaudeHeadless({ ...options, spawn: real.spawn, timeoutMs: 1000, onSpawn: (pid) => spawned.push(pid) });
    real.child.emit('close', 0);
    await published;
    expect(spawned).toEqual([4242]);
  });
});
