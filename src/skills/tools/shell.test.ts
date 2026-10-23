// TUI-BG-SHELL — bg shell-handle completion → existing turn notification
// queue, exactly once per handle. Inline / omitted-mode responses stay
// byte-identical and enqueue nothing.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import {
  SHELL_DISPATCH_ARGS_TEXT_LIMIT,
  boundedShellArgsText,
  detectLongSleep,
  dispatchRunShell,
  enqueueShellCompletionNotice,
  formatLongSleepWarning,
  longSleepResumeHint,
  longSleepWarnSecondsFrom,
} from './shell.js';
import { debug } from '../../debug/log.js';
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

// TUI-RUNSHELL-LONG-SLEEP (#38) — a long in-turn wait still runs unchanged,
// but the result gains one warning line and `shell.run long-sleep` is logged.
describe('RunShell long sleep inside a turn → warning ⊕ shell.run long-sleep', () => {
  const events: Array<{ category: string; event: string; data?: unknown }> = [];
  const originalLog = debug.log.bind(debug) as typeof debug.log;

  beforeEach(() => {
    events.length = 0;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      events.push({ category, event, data });
    }) as typeof debug.log;
  });

  afterEach(() => {
    (debug as { log: typeof debug.log }).log = originalLog;
    resetShellRunnerDeps();
  });

  const longSleepEvents = () => events.filter((e) => e.category === 'shell.run' && e.event === 'long-sleep');

  test('detector: argv sleep over the limit, short sleep and unrelated commands', () => {
    expect(detectLongSleep(['sleep', '480'])).toEqual({ pattern: 'sleep', seconds: 480, limitSeconds: 60 });
    expect(detectLongSleep(['sleep', '5m'])?.seconds).toBe(300);
    expect(detectLongSleep(['sleep', '1m', '30s'])?.seconds).toBe(90);
    expect(detectLongSleep(['sleep', '2'])).toBeNull();
    expect(detectLongSleep(['sleep', '60'])).toBeNull(); // limit is exclusive
    expect(detectLongSleep(['sleep', 'abc'])).toBeNull(); // sleep rejects it — no wait
    expect(detectLongSleep(['rg', 'sleep 480', 'src'])).toBeNull();
    expect(detectLongSleep(['echo', 'sleep', '480'])).toBeNull();
  });

  test('detector: wrappers — env/nice/nohup unwrap, timeout caps the wait', () => {
    expect(detectLongSleep(['env', 'A=1', 'sleep', '480'])?.seconds).toBe(480);
    expect(detectLongSleep(['nice', '-n', '19', 'nohup', 'sleep', '120'])?.seconds).toBe(120);
    expect(detectLongSleep(['timeout', '600', 'sleep', '480'])?.seconds).toBe(480);
    expect(detectLongSleep(['timeout', '10', 'sleep', '480'])).toBeNull();
  });

  test('detector: shell -c single and summed sleeps', () => {
    expect(detectLongSleep(['bash', '-c', 'sleep 480 && echo done'])).toEqual({ pattern: 'shell-sleep', seconds: 480, limitSeconds: 60 });
    expect(detectLongSleep(['sh', '-c', 'sleep 40; date; sleep 40'])?.seconds).toBe(80);
    expect(detectLongSleep(['bash', '-lc', 'sleep 2; echo ok'])).toBeNull();
    expect(detectLongSleep(['zsh', '-c', 'echo sleep 480'])).toBeNull();
    expect(detectLongSleep(['bash', '-c', 'git log --grep "sleep 480"'])).toBeNull();
    expect(detectLongSleep(['bash', '-c', 'if true; then sleep 120; fi'])?.seconds).toBe(120);
  });

  test('detector: poll loop — unbounded while/until warns, short bounded for does not', () => {
    const poll = detectLongSleep(['bash', '-c', 'while true; do eln msg list --to OPT; sleep 30; done']);
    expect(poll).toEqual({ pattern: 'poll-loop', seconds: null, perIterationSeconds: 30, limitSeconds: 60 });
    expect(detectLongSleep(['sh', '-c', 'until [ -f /tmp/x ]; do sleep 1; done'])?.pattern).toBe('poll-loop');
    expect(detectLongSleep(['bash', '-c', 'for i in 1 2 3; do sleep 2; done'])).toBeNull();
    expect(detectLongSleep(['bash', '-c', 'for i in $(seq 1 20); do curl -s x; sleep 30; done'])).toEqual({
      pattern: 'poll-loop', seconds: 600, perIterationSeconds: 30, limitSeconds: 60,
    });
    expect(detectLongSleep(['bash', '-c', 'for i in {1..3}; do sleep 10; done'])).toBeNull();
    expect(detectLongSleep(['bash', '-c', 'for i in {1..10}; do sleep 10; done'])?.seconds).toBe(100);
    expect(detectLongSleep(['bash', '-c', 'while read l; do echo "$l"; done < f'])).toBeNull(); // loop without sleep
  });

  test('detector: python -c — literal, loop and computed sleep (#38 shape)', () => {
    expect(detectLongSleep(['python3', '-c', 'import time; time.sleep(480)'])).toEqual({ pattern: 'python-sleep', seconds: 480, limitSeconds: 60 });
    expect(detectLongSleep(['python3', '-c', 'import time; time.sleep(2)'])).toBeNull();
    expect(detectLongSleep(['python3', '-c', 'import time\nwhile True:\n    time.sleep(30)'])?.pattern).toBe('poll-loop');
    expect(detectLongSleep(['python3', '-c', 'import time\nfor _ in range(3):\n    time.sleep(1)'])).toBeNull();
    expect(detectLongSleep(['python3', '-c', 'import time,datetime as d; t=d.datetime(2026,10,14,22,45); time.sleep((t-d.datetime.now()).total_seconds())'])).toEqual({
      pattern: 'computed-sleep', seconds: null, limitSeconds: 60,
    });
  });

  test('detector: the limit comes from the argument', () => {
    expect(detectLongSleep(['sleep', '480'], 600)).toBeNull();
    expect(detectLongSleep(['sleep', '30'], 10)?.limitSeconds).toBe(10);
  });

  test('dispatch: sleep 480 warns ⊕ logs before waiting — the run itself is unchanged', async () => {
    setShellRunnerDeps({ registry: createShellRegistry(), fileEngine: createFileCaptureEngine({ spawnFn: fakeSpawnExit(0) }) });
    const warned = await dispatchRunShell({ command: ['sleep', '480'], mode: 'inline' });
    const plain = await dispatchRunShell({ command: ['sleep', '2'], mode: 'inline' });
    const [warning, summary] = warned.output.split('\n');
    expect(warning).toStartWith('⚠ RunShell long-sleep:');
    expect(warning).toContain('~480s');
    expect(warning).toContain("mode:'bg'");
    expect(summary).toStartWith('RunShell outcome=exit exitCode=0');
    expect(plain.output).toStartWith('RunShell outcome=exit exitCode=0');
    expect(plain.output).not.toContain('long-sleep');
    // Same execution fields — only the summary line gained the warning.
    for (const key of ['exitCode', 'outcome', 'stdout', 'stderr', 'truncated', 'sandboxed', 'sandboxTool'] as const) {
      expect(warned[key]).toEqual(plain[key]);
    }
    expect(longSleepEvents()).toEqual([{
      category: 'shell.run', event: 'long-sleep',
      data: { seconds: 480, pattern: 'sleep', limitSeconds: 60, path: 'runner', resumeHint: 'generic' },
    }]);
  });

  test('dispatch: poll loop with sleep 30 warns with the loop shape', async () => {
    setShellRunnerDeps({ registry: createShellRegistry(), fileEngine: createFileCaptureEngine({ spawnFn: fakeSpawnExit(0) }) });
    const r = await dispatchRunShell({ command: ['bash', '-c', 'while true; do date; sleep 30; done'], mode: 'inline' });
    expect(r.output.split('\n')[0]).toContain('poll loop sleeping 30s per iteration (total unbounded)');
    expect(longSleepEvents().map((e) => e.data)).toEqual([
      { seconds: null, pattern: 'poll-loop', perIterationSeconds: 30, limitSeconds: 60, path: 'runner', resumeHint: 'generic' },
    ]);
  });

  test('dispatch: legacy path warns too; short sleep is silent', async () => {
    const short = await dispatchRunShell({ command: ['sleep', '0'] });
    expect(short.output).toStartWith('RunShell outcome=exit');
    expect(longSleepEvents()).toEqual([]);
    // An unbounded poll loop whose body never runs: detected statically, exits at once.
    const legacy = await dispatchRunShell({ command: ['sh', '-c', 'while false; do sleep 30; done'] });
    expect(legacy.exitCode).toBe(0);
    expect(legacy.output.split('\n')[0]).toStartWith('⚠ RunShell long-sleep:');
    expect(legacy.output.split('\n')[1]).toStartWith('RunShell outcome=exit exitCode=0');
    expect(longSleepEvents().map((e) => (e.data as { path: string }).path)).toEqual(['legacy']);
  });

  test('resume hint: ScheduleWakeup offered → names it; absent → generic advice (falsifier)', async () => {
    setShellRunnerDeps({ registry: createShellRegistry(), fileEngine: createFileCaptureEngine({ spawnFn: fakeSpawnExit(0) }) });
    const tui = await dispatchRunShell(
      { command: ['sleep', '70'], mode: 'inline' },
      { availableToolNames: ['RunShell', 'ScheduleWakeup', 'logs_query'] },
    );
    const child = await dispatchRunShell(
      { command: ['sleep', '70'], mode: 'inline' },
      { availableToolNames: ['RunShell', 'logs_query'] },
    );
    const bare = await dispatchRunShell({ command: ['sleep', '70'], mode: 'inline' });
    const tuiWarning = tui.output.split('\n')[0]!;
    expect(tuiWarning).toStartWith('⚠ RunShell long-sleep:');
    expect(tuiWarning).toContain('end the turn and call ScheduleWakeup (delaySeconds ≥60, at "HH:MM", or repeatMinutes) so a wakeup turn resumes the work');
    expect(tuiWarning).not.toContain('mail wake');
    for (const r of [child, bare]) {
      const w = r.output.split('\n')[0]!;
      expect(w).toContain('end the turn and let the next turn or a mail wake resume the work');
      expect(w).not.toContain('ScheduleWakeup');
    }
    expect(longSleepEvents().map((e) => (e.data as { resumeHint: string }).resumeHint))
      .toEqual(['schedule-wakeup', 'generic', 'generic']);
  });

  test('resume hint: helper keys on the exact tool name', () => {
    expect(longSleepResumeHint(['ScheduleWakeup'])).toBe('schedule-wakeup');
    expect(longSleepResumeHint(['schedule_create', 'scheduleWakeup'])).toBe('generic');
    expect(longSleepResumeHint([])).toBe('generic');
    expect(longSleepResumeHint(undefined)).toBe('generic');
    const finding = { pattern: 'sleep' as const, seconds: 70, limitSeconds: 60 };
    expect(formatLongSleepWarning(finding, false)).toBe(formatLongSleepWarning(finding, false, 'generic'));
    expect(formatLongSleepWarning(finding, false, 'schedule-wakeup')).toEndWith('so a wakeup turn resumes the work.');
  });

  test('config: tools.runShell.longSleepWarnSeconds sets the limit; invalid values keep 60', () => {
    expect(longSleepWarnSecondsFrom({ tools: { runShell: { longSleepWarnSeconds: 600 } } })).toBe(600);
    expect(longSleepWarnSecondsFrom({})).toBe(60);
    expect(longSleepWarnSecondsFrom(undefined)).toBe(60);
    for (const bad of [0, -5, '600', null, Number.POSITIVE_INFINITY]) {
      expect(longSleepWarnSecondsFrom({ tools: { runShell: { longSleepWarnSeconds: bad } } })).toBe(60);
    }
  });

  test('dispatch: a real bg handle does not hold the turn — no warning', async () => {
    setShellRunnerDeps({ registry: createShellRegistry(), fileEngine: createFileCaptureEngine({ spawnFn: fakeSpawnExit(0) }) });
    const started = await dispatchRunShell({ command: ['sleep', '480'], mode: 'bg' });
    expect(started.output).toStartWith('RunShell outcome=started');
    expect(longSleepEvents()).toEqual([]);
    await tick();
    globalTaskNotificationQueue.clear();
  });
});

// TUI-OBS-TRACE-PERSIST — persisted RunShell dispatch records retain a bounded,
// secret-redacted rendering of the arguments that reached the dispatch entry.
describe('RunShell dispatch trace args', () => {
  afterEach(() => {
    resetShellRunnerDeps();
  });

  type PersistedTrace = {
    event?: string;
    argsText?: string;
    argsTextTruncated?: boolean;
    argsTextChars?: number;
    argsTextMarker?: string;
  };

  const persistedDispatchTraceWith = (sentinel: string): PersistedTrace | undefined => {
    debug.flush();
    const path = debug.path();
    if (!existsSync(path)) return undefined;
    const records = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { category?: string; event?: string; data?: PersistedTrace })
      .filter((record) => record.category === 'shell.dispatch');
    return records.map((record) => record.data ? { ...record.data, event: record.event } : undefined)
      .find((data) => typeof data?.argsText === 'string' && data.argsText.includes(sentinel));
  };

  const argsOfExactLength = (chars: number) => {
    const overhead = JSON.stringify({ command: ['true', ''] }).length;
    return { command: ['true', 'p'.repeat(chars - overhead)] };
  };

  test('records serialized invocation args in the persisted legacy trace', async () => {
    const sentinel = `trace-sentinel-${randomUUID()}`;
    const rawArgs = { command: ['true', `persist-args-${randomUUID()}`], description: sentinel };
    await dispatchRunShell(rawArgs);

    const trace = persistedDispatchTraceWith(sentinel);
    expect(trace?.argsText).toBe(JSON.stringify(rawArgs));
    expect(trace?.argsTextTruncated).toBe(false);
    expect(trace?.argsTextChars).toBe(JSON.stringify(rawArgs).length);
    expect(trace).not.toHaveProperty('argsTextMarker');
  });

  test('records serialized invocation args in the persisted runner trace', async () => {
    setShellRunnerDeps({
      registry: createShellRegistry(),
      fileEngine: createFileCaptureEngine({ spawnFn: fakeSpawnExit(0) }),
    });
    const sentinel = `runner-trace-${randomUUID()}`;
    const rawArgs = { command: ['true', `runner-args-${randomUUID()}`], mode: 'inline', description: sentinel };
    const result = await dispatchRunShell(rawArgs);

    const trace = persistedDispatchTraceWith(sentinel);
    expect(result.outcome).toBe('exit');
    expect(trace?.event).toBe('runner.exit');
    expect(trace?.argsText).toBe(JSON.stringify(rawArgs));
    expect(trace?.argsTextTruncated).toBe(false);
    expect(trace?.argsTextChars).toBe(JSON.stringify(rawArgs).length);
  });

  test('caps persisted text at 2048 chars and records an explicit truncation marker', async () => {
    const sentinel = `long-args-${randomUUID()}-`;
    const rawArgs = { command: ['true', sentinel + 'z'.repeat(4096)] };
    const fullText = JSON.stringify(rawArgs);
    await dispatchRunShell(rawArgs);

    const trace = persistedDispatchTraceWith(sentinel);
    const marker = '[truncated]';
    expect(trace?.argsTextTruncated).toBe(true);
    expect(trace?.argsTextChars).toBe(fullText.length);
    expect(trace?.argsTextMarker).toBe(marker);
    expect(trace?.argsText).toHaveLength(SHELL_DISPATCH_ARGS_TEXT_LIMIT);
    expect(trace?.argsText).toBe(
      `${fullText.slice(0, SHELL_DISPATCH_ARGS_TEXT_LIMIT - marker.length - 1)} ${marker}`,
    );
  });

  test('redacts recognizable secrets before the args text reaches the log file', async () => {
    const bearer = `sk-ant-api03-${'q7W2e5R9t3Y6u1I4o8P0'.repeat(2)}`;
    const sentinel = `secret-redaction-${randomUUID()}`;
    const rawArgs = {
      command: ['true', '--header', `Authorization: Bearer ${bearer}`],
      description: sentinel,
    };
    await dispatchRunShell(rawArgs);

    const trace = persistedDispatchTraceWith(sentinel);
    expect(trace?.argsText).toContain('Bearer ***');
    expect(trace?.argsText).not.toContain(bearer);
    expect(rawArgs.command[2]).toBe(`Authorization: Bearer ${bearer}`);
  });

  test('redacts fallback text when non-JSON values cannot be serialized', () => {
    const bearer = `sk-ant-api03-${'m4N8b2V6c0X3z7A1s5D9'.repeat(2)}`;
    const rawArgs = {
      value: 1n,
      toString: () => `unserializable Bearer ${bearer}`,
    };

    const trace = boundedShellArgsText(rawArgs);
    expect(trace.argsText).toContain('Bearer ***');
    expect(trace.argsText).not.toContain(bearer);
  });

  test('persists a redacted fallback string from the actual dispatch path', async () => {
    const bearer = `sk-ant-api03-${'p8R2m6T0v4X7z1A5'.repeat(2)}`;
    const sentinel = `dispatch-fallback-${randomUUID()}`;
    const rawArgs = {
      command: ['true'],
      nonJsonValue: 1n,
      toString: () => `unserializable ${sentinel} Authorization: Bearer ${bearer} ${'x'.repeat(2500)}`,
    };

    const result = await dispatchRunShell(rawArgs);

    const trace = persistedDispatchTraceWith(sentinel);
    debug.flush();
    const persistedLog = readFileSync(debug.path(), 'utf8');
    expect(result.outcome).toBe('exit');
    expect(trace?.event).toBe('legacy.exit');
    expect(trace?.argsText).toContain(sentinel);
    expect(trace?.argsText).toContain('Bearer ***');
    expect(trace?.argsText).not.toContain(bearer);
    expect(persistedLog).not.toContain(bearer);
    expect(trace?.argsText).toHaveLength(SHELL_DISPATCH_ARGS_TEXT_LIMIT);
    expect(trace?.argsText?.endsWith('[truncated]')).toBe(true);
    expect(trace?.argsTextTruncated).toBe(true);
    expect(trace?.argsTextMarker).toBe('[truncated]');
    expect(trace?.argsTextChars).toBeGreaterThan(SHELL_DISPATCH_ARGS_TEXT_LIMIT);
    expect(rawArgs.command).toEqual(['true']);
  });

  test('the exact limit remains complete and one extra character is marked as truncated', () => {
    expect(SHELL_DISPATCH_ARGS_TEXT_LIMIT).toBe(2048);
    const atLimit = argsOfExactLength(SHELL_DISPATCH_ARGS_TEXT_LIMIT);
    expect(JSON.stringify(atLimit)).toHaveLength(SHELL_DISPATCH_ARGS_TEXT_LIMIT);
    expect(boundedShellArgsText(atLimit)).toEqual({
      argsText: JSON.stringify(atLimit),
      argsTextTruncated: false,
      argsTextChars: SHELL_DISPATCH_ARGS_TEXT_LIMIT,
    });

    const overLimit = argsOfExactLength(SHELL_DISPATCH_ARGS_TEXT_LIMIT + 1);
    const overText = JSON.stringify(overLimit);
    const result = boundedShellArgsText(overLimit);
    const marker = '[truncated]';
    expect(result.argsText).toHaveLength(SHELL_DISPATCH_ARGS_TEXT_LIMIT);
    expect(result.argsText).toBe(
      `${overText.slice(0, SHELL_DISPATCH_ARGS_TEXT_LIMIT - marker.length - 1)} ${marker}`,
    );
    expect(result.argsTextTruncated).toBe(true);
    expect(result.argsTextChars).toBe(overText.length);
    expect(result.argsTextMarker).toBe(marker);
  });
});
