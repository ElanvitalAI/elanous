import { describe, test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { debug } from '../../src/debug/log.js';
import { dispatchRunShell } from '../../src/skills/tools/shell.js';
import { setShellRunnerDeps, resetShellRunnerDeps } from '../../src/shell-runner/dispatch.js';
import { createFileCaptureEngine } from '../../src/shell-runner/file-engine.js';

import {
  buildShellListTool,
  buildShellPollTool,
  buildShellKillTool,
  dispatchShellList,
  dispatchShellPoll,
  dispatchShellKill,
} from '../../src/skills/tools/shell-runner.js';
import { createShellRegistry } from '../../src/shell-runner/registry.js';
import type {
  BufferMark,
  ShellHandle,
  ShellMode,
  ShellResult,
  ShellStatus,
  Unsubscribe,
} from '../../src/shell-runner/types.js';

function fakeHandle(id: string, opts: {
  mode?: ShellMode;
  status?: ShellStatus;
} = {}): ShellHandle & { killed: boolean; killSignal?: string } {
  const statusSubs = new Set<(s: ShellStatus) => void>();
  let status: ShellStatus = (opts.status ?? 'running');
  let killed = false;
  let killSignal: string | undefined;
  const bookmark: BufferMark = { row: 0, col: 0, ts: 0, bytes: 0 };
  const result = new Promise<ShellResult>(() => { /* never */ });
  return {
    id,
    mode: (opts.mode ?? 'inline') as any,
    get status() { return status; },
    bookmark,
    kill(sig) {
      killed = true;
      killSignal = sig ?? 'SIGTERM';
      status = 'killed';
      for (const cb of statusSubs) cb(status);
    },
    background() { return false; },
    promote() { return false; },
    write() { /* noop */ },
    resize() { /* noop */ },
    onChunk() { return (() => {}) as Unsubscribe; },
    onStatus(cb) { statusSubs.add(cb); return (() => statusSubs.delete(cb)) as Unsubscribe; },
    onBoundary() { return (() => {}) as Unsubscribe; },
    result,
    get killed() { return killed; },
    get killSignal() { return killSignal; },
  };
}

describe('ShellList / ShellPoll / ShellKill — schemas', () => {
  test('schemas declare the expected names and required fields', () => {
    expect(buildShellListTool().name).toBe('ShellList');
    const list = buildShellListTool();
    // List has no required fields.
    expect((list.parameters as any).required).toBeUndefined();
    const poll = buildShellPollTool();
    expect(poll.name).toBe('ShellPoll');
    expect((poll.parameters as any).required).toEqual(['id']);
    const kill = buildShellKillTool();
    expect(kill.name).toBe('ShellKill');
    expect((kill.parameters as any).required).toEqual(['id']);
  });
});

describe('dispatchShellList', () => {
  test('empty registry → count=0', () => {
    const r = createShellRegistry();
    const out = dispatchShellList({}, r);
    expect(out.count).toBe(0);
    expect(out.entries).toEqual([]);
  });

  test('all entries appear when no filter', () => {
    const r = createShellRegistry();
    r.register(fakeHandle('a', { mode: 'inline' }));
    r.register(fakeHandle('b', { mode: 'vw', status: 'backgrounded' }));
    const out = dispatchShellList({}, r);
    expect(out.count).toBe(2);
    expect(out.entries.map(e => e.id).sort()).toEqual(['a', 'b']);
  });

  test('status filter narrows', () => {
    const r = createShellRegistry();
    r.register(fakeHandle('a'));
    r.register(fakeHandle('b', { status: 'backgrounded' }));
    const out = dispatchShellList({ status: 'backgrounded' }, r);
    expect(out.count).toBe(1);
    expect(out.entries[0]?.id).toBe('b');
  });

  test('mode filter narrows', () => {
    const r = createShellRegistry();
    r.register(fakeHandle('a', { mode: 'inline' }));
    r.register(fakeHandle('b', { mode: 'vw' }));
    const out = dispatchShellList({ mode: 'vw' }, r);
    expect(out.count).toBe(1);
    expect(out.entries[0]?.id).toBe('b');
  });

  test('invalid status throws', () => {
    const r = createShellRegistry();
    expect(() => dispatchShellList({ status: 'nonsense' }, r)).toThrow(/invalid status/);
  });

  // PR-1 — capability + userExposure (Layer 1) appear in summary entries.
  test('bg-mode handle exposes hidden + agent-only capability', () => {
    const r = createShellRegistry();
    r.register(fakeHandle('bg-1', { mode: 'bg', status: 'running' }));
    const out = dispatchShellList({}, r);
    const entry = out.entries.find(e => e.id === 'bg-1');
    expect(entry?.userExposure).toBe('hidden');
    expect(entry?.capability).toEqual({
      canRead: false,
      canInterrupt: false,
      canWrite: false,
      canInspect: false,
    });
  });

  test('inline-mode handle exposes null posture (no user-facing surface)', () => {
    const r = createShellRegistry();
    r.register(fakeHandle('inline-1', { mode: 'inline', status: 'running' }));
    const out = dispatchShellList({}, r);
    const entry = out.entries.find(e => e.id === 'inline-1');
    expect(entry?.userExposure).toBe(null);
    expect(entry?.capability).toBe(null);
  });
});

describe('dispatchShellPoll', () => {
  test('unknown id → found=false', () => {
    const r = createShellRegistry();
    const out = dispatchShellPoll({ id: 'ghost' }, r);
    expect(out.found).toBe(false);
    expect(out.output).toContain('ghost');
  });

  test('known id → status + mode + finished', () => {
    const r = createShellRegistry();
    const h = fakeHandle('live', { mode: 'vw', status: 'backgrounded' });
    r.register(h);
    const out = dispatchShellPoll({ id: 'live' }, r);
    expect(out.found).toBe(true);
    expect(out.mode).toBe('vw');
    expect(out.status).toBe('backgrounded');
    expect(out.finished).toBe(false);
  });

  test('completed handle → finished=true', () => {
    const r = createShellRegistry();
    r.register(fakeHandle('done', { status: 'completed' }));
    expect(dispatchShellPoll({ id: 'done' }, r).finished).toBe(true);
  });

  test('missing id throws', () => {
    const r = createShellRegistry();
    expect(() => dispatchShellPoll({}, r)).toThrow(/'id'/);
  });

  // PR-1 — output line carries compact capability summary so LLM can
  // glance the boolean vector without parsing JSON.
  test('bg handle output includes user= and cap= one-line summary', () => {
    const r = createShellRegistry();
    r.register(fakeHandle('bg-poll', { mode: 'bg', status: 'running' }));
    const out = dispatchShellPoll({ id: 'bg-poll' }, r);
    expect(out.output).toContain('user=hidden');
    expect(out.output).toContain('cap=----');
    expect(out.userExposure).toBe('hidden');
    expect(out.capability).toEqual({
      canRead: false,
      canInterrupt: false,
      canWrite: false,
      canInspect: false,
    });
  });

  test('inline handle output omits user/cap (null posture)', () => {
    const r = createShellRegistry();
    r.register(fakeHandle('inline-poll', { mode: 'inline', status: 'running' }));
    const out = dispatchShellPoll({ id: 'inline-poll' }, r);
    expect(out.output).not.toContain('user=');
    expect(out.output).not.toContain('cap=');
    expect(out.userExposure).toBe(null);
    expect(out.capability).toBe(null);
  });
});

describe('RunShell background mode', () => {
  test('bg mode returns before the command finishes and records a completion notice', async () => {
    let resolveCommand!: () => void;
    const commandFinished = new Promise<void>((resolve) => { resolveCommand = resolve; });
    const fakeSpawn = () => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => true;
      void commandFinished.then(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('exit', 0, null);
      });
      return child;
    };
    const registry = createShellRegistry();
    setShellRunnerDeps({ registry, fileEngine: createFileCaptureEngine({ spawnFn: fakeSpawn }) });
    const seen: Array<{ category: string; event: string; data?: unknown }> = [];
    const off = debug.registerSink({
      name: 'skill-tool-shell-bg-capture',
      emit: (record) => seen.push({ category: record.category, event: record.event, data: record.data }),
    });
    try {
      const started = await dispatchRunShell({ command: ['slow-command'], mode: 'bg' });
      expect(started.outcome).toBe('started');
      expect(started.exitCode).toBeNull();
      expect(started.output).toMatch(/^RunShell outcome=started handle=.+ bg=.+$/);
      expect(registry.size()).toBe(1);
      expect(seen.some((record) => record.category === 'skill-tool.shell' && record.event === 'bg-finished')).toBe(false);

      resolveCommand();
      await registry.list()[0]!.result;
      await Promise.resolve();
      const notice = seen.find((record) => record.category === 'skill-tool.shell' && record.event === 'bg-finished');
      expect(notice?.data).toMatchObject({ handle: registry.list()[0]!.id, exitCode: 0 });
      expect(typeof (notice?.data as { durationMs?: unknown }).durationMs).toBe('number');
    } finally {
      off();
      resetShellRunnerDeps();
    }
  });

  test('bg result rejection is handled and records a completion notice', async () => {
    let rejectResult!: (reason: Error) => void;
    const result = new Promise<ShellResult>((_resolve, reject) => { rejectResult = reject; });
    const handle = fakeHandle('rejected-bg', { mode: 'bg' });
    Object.defineProperty(handle, 'result', { value: result });
    const registry = createShellRegistry();
    setShellRunnerDeps({
      registry,
      fileEngine: { kind: 'file', run: () => handle },
    });
    const seen: Array<{ category: string; event: string; data?: unknown }> = [];
    const off = debug.registerSink({
      name: 'skill-tool-shell-bg-rejection-capture',
      emit: (record) => seen.push({ category: record.category, event: record.event, data: record.data }),
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const started = await dispatchRunShell({ command: ['rejecting-command'], mode: 'bg' });
      expect(started.outcome).toBe('started');
      rejectResult(new Error('command failed'));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const notices = seen.filter((record) => record.category === 'skill-tool.shell' && record.event === 'bg-finished');
      expect(notices).toHaveLength(1);
      expect(notices[0]?.data).toMatchObject({ handle: 'rejected-bg', exitCode: null, error: 'command failed' });
      expect(typeof (notices[0]?.data as { durationMs?: unknown }).durationMs).toBe('number');
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      off();
      resetShellRunnerDeps();
    }
  });
});

describe('dispatchShellKill', () => {
  test('unknown id → found=false, no kill', async () => {
    const r = createShellRegistry();
    const out = await dispatchShellKill({ id: 'ghost' }, r);
    expect(out.found).toBe(false);
  });

  test('default signal is SIGTERM', async () => {
    const r = createShellRegistry();
    const h = fakeHandle('x');
    r.register(h);
    const out = await dispatchShellKill({ id: 'x' }, r);
    expect(h.killed).toBe(true);
    expect(h.killSignal).toBe('SIGTERM');
    expect(out.status).toBe('killed');
  });

  test('explicit SIGKILL forwards', async () => {
    const r = createShellRegistry();
    const h = fakeHandle('x');
    r.register(h);
    await dispatchShellKill({ id: 'x', signal: 'SIGKILL' }, r);
    expect(h.killSignal).toBe('SIGKILL');
  });

  test('invalid signal rejected', async () => {
    const r = createShellRegistry();
    r.register(fakeHandle('x'));
    await expect(dispatchShellKill({ id: 'x', signal: 'SIGWAT' }, r))
      .rejects.toThrow(/signal/);
  });
});
