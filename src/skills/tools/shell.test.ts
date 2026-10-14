// TUI-BG-SHELL — bg shell-handle completion → existing turn notification
// queue, exactly once per handle. Inline / omitted-mode responses stay
// byte-identical and enqueue nothing.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { dispatchRunShell, enqueueShellCompletionNotice } from './shell.js';
import { setShellRunnerDeps, resetShellRunnerDeps } from '../../shell-runner/dispatch.js';
import { createFileCaptureEngine } from '../../shell-runner/file-engine.js';
import { createShellRegistry } from '../../shell-runner/registry.js';
import {
  globalTaskNotificationQueue,
  renderTaskNotificationsXml,
  TaskNotificationQueue,
} from '../../agent/task-notification.js';
import type {
  ShellHandle,
  ShellResult,
} from '../../shell-runner/types.js';

function fakeSpawnExit(exitCode: number) {
  return () => {
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit('exit', exitCode, null);
    });
    return child;
  };
}

function fakeBgHandle(id: string, result: Promise<ShellResult>): ShellHandle {
  const noopUnsub = (() => (() => {})) as any;
  const base = {
    id,
    mode: 'bg' as const,
    get status() { return 'running' as const; },
    bookmark: { row: 0, col: 0, ts: 0, bytes: 0 },
    kill() { /* noop */ },
    background() { return false; },
    promote() { return false; },
    write() { /* noop */ },
    resize() { /* noop */ },
    onChunk: noopUnsub,
    onStatus: noopUnsub,
    onBoundary: noopUnsub,
    result,
  };
  return base as unknown as ShellHandle;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('RunShell bg completion → turn notification queue', () => {
  beforeEach(() => {
    globalTaskNotificationQueue.clear();
  });

  afterEach(() => {
    globalTaskNotificationQueue.clear();
    resetShellRunnerDeps();
  });

  test('bg success enqueues exactly one done notification per handle', async () => {
    const registry = createShellRegistry();
    setShellRunnerDeps({
      registry,
      fileEngine: createFileCaptureEngine({ spawnFn: fakeSpawnExit(0) }),
    });
    const started = await dispatchRunShell({ command: ['bg-notify-ok'], mode: 'bg' });
    expect(started.outcome).toBe('started');
    expect(globalTaskNotificationQueue.size).toBe(0);
    const handleId = registry.list()[0]!.id;
    await registry.list()[0]!.result;
    await tick();
    const drained = globalTaskNotificationQueue.drain();
    expect(drained).toHaveLength(1);
    const notice = drained[0]!;
    expect(notice.taskId.startsWith(`shell:${handleId}:`)).toBe(true);
    expect(notice.agentName).toBe('RunShell');
    expect(notice.state).toBe('done');
    expect(notice.output).toContain(`handle=${handleId}`);
    expect(notice.output).toContain('exitCode=0');
    // Drain empties the queue — no duplicate completion notice.
    expect(globalTaskNotificationQueue.size).toBe(0);
  });

  test('bg nonzero exit enqueues an error with its exit code', async () => {
    const registry = createShellRegistry();
    setShellRunnerDeps({
      registry,
      fileEngine: createFileCaptureEngine({ spawnFn: fakeSpawnExit(1) }),
    });
    const started = await dispatchRunShell({ command: ['bg-notify-nonzero'], mode: 'bg' });
    expect(started.outcome).toBe('started');
    const handle = registry.list()[0]!;
    const result = await handle.result;
    expect(result.exitCode).toBe(1);
    await tick();
    const drained = globalTaskNotificationQueue.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]?.taskId.startsWith(`shell:${handle.id}:`)).toBe(true);
    expect(drained[0]?.state).toBe('error');
    expect(drained[0]?.output).toContain('failed');
    expect(drained[0]?.output).toContain('exitCode=1');
    expect(drained[0]?.errorMessage).toBe('exitCode=1');
  });

  test('bg failure enqueues exactly one error notification per handle', async () => {
    let rejectResult!: (reason: Error) => void;
    const result = new Promise<ShellResult>((_resolve, reject) => { rejectResult = reject; });
    const handle = fakeBgHandle('bg-notify-fail', result);
    const registry = createShellRegistry();
    setShellRunnerDeps({
      registry,
      fileEngine: { kind: 'file', run: () => handle },
    });
    const started = await dispatchRunShell({ command: ['bg-notify-fail'], mode: 'bg' });
    expect(started.outcome).toBe('started');
    expect(globalTaskNotificationQueue.size).toBe(0);
    rejectResult(new Error('command failed'));
    await tick();
    const drained = globalTaskNotificationQueue.drain();
    expect(drained).toHaveLength(1);
    const notice = drained[0]!;
    expect(notice.taskId.startsWith('shell:bg-notify-fail:')).toBe(true);
    expect(notice.state).toBe('error');
    expect(notice.errorMessage).toBe('command failed');
    expect(notice.output).toContain('failed');
    expect(notice.output).not.toContain('exitCode=null');
    expect(globalTaskNotificationQueue.size).toBe(0);
  });

  test('inline mode completes without enqueuing any notification', async () => {
    const registry = createShellRegistry();
    setShellRunnerDeps({
      registry,
      fileEngine: createFileCaptureEngine({ spawnFn: fakeSpawnExit(0) }),
    });
    const r = await dispatchRunShell({ command: ['inline-notify'], mode: 'inline' });
    expect(r.outcome).toBe('exit');
    expect(globalTaskNotificationQueue.size).toBe(0);
  });

  test('duplicate completion settles into a single enqueue per handle', () => {
    const queue = new TaskNotificationQueue();
    const handle = fakeBgHandle('dup-1', Promise.resolve({} as ShellResult));
    const input = { handle, ok: true, exitCode: 0, durationMs: 5 };
    expect(enqueueShellCompletionNotice(input, queue)).toBe(true);
    expect(enqueueShellCompletionNotice(input, queue)).toBe(false);
    expect(queue.size).toBe(1);
    expect(queue.drain()[0]?.state).toBe('done');
    expect(enqueueShellCompletionNotice(input, queue)).toBe(false);
    expect(queue.size).toBe(0);
  });

  test('fresh handle reusing a settled id gets a second notification through the real dispatch path', async () => {
    const result = Promise.resolve({ outcome: 'exit', exitCode: 0, durationMs: 1 } as ShellResult);
    const handles = [fakeBgHandle('reused-id', result), fakeBgHandle('reused-id', result)];
    const registry = createShellRegistry();
    setShellRunnerDeps({ registry, fileEngine: { kind: 'file', run: () => handles.shift()! } });
    const first = await dispatchRunShell({ command: ['first'], mode: 'bg' });
    expect(first.outcome).toBe('started');
    await tick();
    const firstNotice = globalTaskNotificationQueue.drain();
    expect(firstNotice).toHaveLength(1);
    expect(firstNotice[0]?.output).toContain('handle=reused-id');

    const second = await dispatchRunShell({ command: ['second'], mode: 'bg' });
    expect(second.outcome).toBe('started');
    await tick();
    const secondNotice = globalTaskNotificationQueue.drain();
    expect(secondNotice).toHaveLength(1);
    expect(secondNotice[0]?.output).toContain('handle=reused-id');
    expect(secondNotice[0]?.taskId).not.toBe(firstNotice[0]?.taskId);
    expect(globalTaskNotificationQueue.size).toBe(0);
  });

  test('bg notice label with quotes renders as an escaped XML name attribute', async () => {
    const registry = createShellRegistry();
    setShellRunnerDeps({
      registry,
      fileEngine: createFileCaptureEngine({ spawnFn: fakeSpawnExit(0) }),
    });
    await dispatchRunShell({
      command: ['bg-notify-label'],
      mode: 'bg',
      description: 'label "quoted" & <tag>',
    });
    await registry.list()[0]!.result;
    await tick();
    const [notice] = globalTaskNotificationQueue.drain();
    expect(notice?.label).toBe('label "quoted" & <tag>');
    const xml = renderTaskNotificationsXml([notice!]);
    expect(xml).toContain('name="label &quot;quoted&quot; &amp; &lt;tag&gt;"');
  });
});
