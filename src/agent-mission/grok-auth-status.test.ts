import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { debug } from '../debug/log.js';
import type { LogRecord } from '../mss/logging/record.js';
import { probeGrokLogin, runAuthProbe } from './grok-auth-status.js';

test('Grok subscribed-access probe reports ready without returning account details', async () => {
  expect(await probeGrokLogin(() => ({ status: 0, stdout: 'OK', stage: 'response', elapsedMs: 12 }), 45_000)).toEqual({ ok: true, classification: 'success', stage: 'response', timeoutMs: 45_000, elapsedMs: 12, durationMs: 12 });
});

test('Grok probe logs safe classifications for success and failures', async () => {
  const originalLog = debug.log;
  const entries: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  debug.log = ((category: string, event: string, data: Record<string, unknown>) => { entries.push({ category, event, data }); }) as typeof debug.log;
  try {
    await probeGrokLogin(() => ({ status: 0, stdout: 'OK', elapsedMs: 8 }), 1_000);
    await probeGrokLogin(() => ({ status: 1, stderr: 'login required; api_key=secret-value', elapsedMs: 9 }), 1_000);
    await probeGrokLogin(() => ({ status: 1, stderr: 'connect ECONNRESET api.grok.com', elapsedMs: 10 }), 1_000);
    await probeGrokLogin(() => ({ status: null, stderr: 'connect ECONNRESET api.grok.com', error: new Error('probe timed out'), elapsedMs: 11 }), 1_000);
    await probeGrokLogin(() => ({ status: 7, stderr: 'unexpected exit', elapsedMs: 12 }), 1_000);

    expect(JSON.stringify(entries.map(({ category, event, data }) => ({ category, event, data: { ...data, taskId: '<generated>' } })))).toBe(JSON.stringify([
      { category: 'grok.auth-probe', event: 'grok-probe-result', data: { taskId: '<generated>', ok: true, classification: 'success', stage: 'response', timeoutMs: 1_000, elapsedMs: 8 } },
      { category: 'grok.auth-probe', event: 'grok-probe-result', data: { taskId: '<generated>', ok: false, classification: 'auth-rejected', stage: 'auth', timeoutMs: 1_000, elapsedMs: 9 } },
      { category: 'grok.auth-probe', event: 'grok-probe-result', data: { taskId: '<generated>', ok: false, classification: 'network', stage: 'connect', timeoutMs: 1_000, elapsedMs: 10 } },
      { category: 'grok.auth-probe', event: 'grok-probe-result', data: { taskId: '<generated>', ok: false, classification: 'timeout', stage: 'connect', timeoutMs: 1_000, elapsedMs: 11 } },
      { category: 'grok.auth-probe', event: 'grok-probe-result', data: { taskId: '<generated>', ok: false, classification: 'unexpected-exit', stage: 'exit', timeoutMs: 1_000, elapsedMs: 12 } },
    ]));
    expect(JSON.stringify(entries)).not.toContain('secret-value');
    expect(JSON.stringify(entries)).not.toContain('login required');
    expect(entries.every(({ data }) => typeof data.taskId === 'string' && data.taskId.length > 0)).toBe(true);
  } finally { debug.log = originalLog; }
});

test('Grok probe errors fail closed and successful replies override network warnings', async () => {
  expect(await probeGrokLogin(() => ({ status: 0, stdout: 'OK', error: new Error('EPIPE'), stage: 'response' })))
    .toMatchObject({ ok: false, classification: 'unexpected-exit' });
  expect(await probeGrokLogin(() => ({ status: 0, stdout: 'OK', stderr: 'warning: ECONNRESET retrying' })))
    .toMatchObject({ ok: true, classification: 'success', stage: 'response' });
});

test('real runAuthProbe keeps response stage separate from network failure cause', async () => {
  const controlledSpawn = (() => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.emit('spawn');
      child.stdout.write('partial response');
      child.stderr.write('connect ECONNRESET api.grok.com');
      child.emit('close', 1);
    });
    return child;
  }) as unknown as Parameters<typeof runAuthProbe>[1];
  const result = await probeGrokLogin(timeout => runAuthProbe(timeout, controlledSpawn), 100);
  expect(result).toMatchObject({ ok: false, classification: 'network', stage: 'response' });
});

test('real runAuthProbe timeout and unexpected exit retain classification and elapsed timing', async () => {
  const timeoutSpawn = (() => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.emit('spawn');
      child.stderr.write('connect ECONNRESET api.grok.com');
    });
    return child;
  }) as unknown as Parameters<typeof runAuthProbe>[1];
  const timedOut = await probeGrokLogin(timeout => runAuthProbe(timeout, timeoutSpawn), 25);
  expect(timedOut).toMatchObject({ ok: false, classification: 'timeout', stage: 'connect', timeoutMs: 25 });
  expect(timedOut.elapsedMs).toBeGreaterThanOrEqual(15);
  expect(timedOut.elapsedMs).toBeLessThan(1_000);
  expect(timedOut.durationMs).toBe(timedOut.elapsedMs);

  const exitSpawn = (() => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => { child.emit('spawn'); child.emit('close', 1); });
    return child;
  }) as unknown as Parameters<typeof runAuthProbe>[1];
  const exited = await probeGrokLogin(timeout => runAuthProbe(timeout, exitSpawn), 50);
  expect(exited).toMatchObject({ ok: false, classification: 'unexpected-exit', timeoutMs: 50 });
  expect(exited.elapsedMs).toBe(exited.durationMs);
});

test('debug sink receives safe success and failure classifications from one probe run', async () => {
  const captured: Array<{ category: string; event: string; data: unknown }> = [];
  const unregister = debug.registerSink({
    name: 'grok-auth-status-test-sink',
    emit(rec: LogRecord) { captured.push({ category: rec.category, event: rec.event, data: rec.data }); },
  });
  try {
    await probeGrokLogin(() => ({ status: 0, stdout: 'OK', stage: 'response', elapsedMs: 12 }));
    await probeGrokLogin(() => ({ status: 1, stderr: 'login required, api_key=supersecretvalue', elapsedMs: 34 }));
  } finally {
    unregister();
  }
  const classified = captured.filter(rec => rec.category === 'grok.auth-probe' && rec.event === 'grok-probe-result');
  expect(classified.length).toBe(2);
  const payload = (rec: { data: unknown } | undefined) => (rec?.data ?? {}) as Record<string, unknown>;
  expect(payload(classified[0])).toMatchObject({ ok: true, classification: 'success', timeoutMs: 45_000, elapsedMs: 12, stage: 'response' });
  expect(payload(classified[1])).toMatchObject({ ok: false, classification: 'auth-rejected', timeoutMs: 45_000, elapsedMs: 34, stage: 'auth' });
  const allowedKeys = ['taskId', 'ok', 'classification', 'timeoutMs', 'elapsedMs', 'stage'];
  const unexpectedKeys = classified.flatMap(rec => Object.keys(payload(rec)).filter(key => !allowedKeys.includes(key)));
  expect(unexpectedKeys).toEqual([]);
  expect(JSON.stringify(classified)).not.toContain('supersecretvalue');
});


test('Grok subscribed-access probe falls back on missing auth and hides raw output', async () => {
  const result = await probeGrokLogin(() => ({ status: 1, stderr: 'login required, user@example.com' }));
  expect(result.ok).toBe(false);
  expect(result.stage).toBe('auth');
  expect(result.classification).toBe('auth-rejected');
  expect(result.reason).toContain('Grok login unavailable; run grok login');
  expect(result.reason).toContain('[redacted-email]');
  expect(result).toMatchObject({ timeoutMs: 45_000 });
  expect(JSON.stringify(result)).not.toContain('user@example.com');
  expect(await probeGrokLogin(() => ({ status: 0, stdout: 'unexpected output' }))).toMatchObject({ ok: false, reason: expect.stringContaining('Grok subscribed-access probe did not return the expected OK reply') });
});

test('Grok subscribed-access probe fails closed for timeout and empty output', async () => {
  expect(await probeGrokLogin(() => ({ status: null, error: new Error('Grok subscribed-access probe timed out') }))).toMatchObject({ ok: false, classification: 'timeout', stage: 'first-byte', reason: expect.stringContaining('Grok subscribed-access probe timed out (first-byte') });
  expect(await probeGrokLogin(() => ({ status: null, stderr: 'connect ECONNRESET api.grok.com', error: new Error('probe timed out') }))).toMatchObject({ ok: false, stage: 'connect', reason: expect.stringContaining('ECONNRESET api.grok.com') });
  expect(await probeGrokLogin(() => ({ status: null, stdout: 'partial', stderr: 'Bearer xai-1234567890secret', error: new Error('probe timed out') }))).toMatchObject({ ok: false, stage: 'response', reason: expect.stringContaining('Bearer [redacted]') });
  expect(await probeGrokLogin(() => ({ status: 0, stdout: '' }))).toMatchObject({ ok: false, reason: expect.stringContaining('Grok subscribed-access probe did not return the expected OK reply') });
});

test('Grok auth probe is async and bounded independently of its child process', async () => {
  let resolveProbe!: (value: { status: number; stdout: string }) => void;
  const pending = probeGrokLogin(() => new Promise(resolve => { resolveProbe = resolve; }), 1);
  await new Promise(resolve => setTimeout(resolve, 5));
  resolveProbe({ status: 0, stdout: 'OK' });
  await expect(pending).resolves.toMatchObject({ ok: true, stage: 'response' });
});

test('Grok auth probe defaults to the OP-approved 45-second first-response bound', async () => {
  let observedTimeout = 0;
  await probeGrokLogin(timeoutMs => { observedTimeout = timeoutMs; return { status: 0, stdout: 'OK' }; });
  expect(observedTimeout).toBe(45_000);
});

test('real probe records first-byte stage and elapsed time when only a warning reaches stderr', async () => {
  const controlledSpawn = (() => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.emit('spawn');
      child.stderr.write('warning: startup is slow');
    });
    return child;
  }) as unknown as Parameters<typeof runAuthProbe>[1];
  const result = await probeGrokLogin(timeout => runAuthProbe(timeout, controlledSpawn), 20);
  expect(result.ok).toBe(false);
  expect(result.stage).toBe('first-byte');
  expect(result.timeoutMs).toBe(20);
  expect(result.elapsedMs).toBeGreaterThanOrEqual(10);
  expect(result.elapsedMs).toBeLessThan(1_000);
});

test('Grok diagnostics redact auth schemes and key-value credentials', async () => {
  const result = await probeGrokLogin(() => ({ status: 1, stderr: 'Authorization: Basic dXNlcjpwYXNz Authorization: ApiKey headerSecret api_key=supersecretvalue GROK_API_KEY=plaintextSecret refresh_token=refreshSecret' }));
  expect(JSON.stringify(result)).not.toContain('dXNlcjpwYXNz');
  expect(JSON.stringify(result)).not.toContain('headerSecret');
  expect(JSON.stringify(result)).not.toContain('supersecretvalue');
  expect(JSON.stringify(result)).not.toContain('plaintextSecret');
  expect(JSON.stringify(result)).not.toContain('refreshSecret');
  expect(result.reason).toContain('[redacted]');
});

test('real probe preserves spawn stage when timeout precedes the spawn event', async () => {
  const controlledSpawn = (() => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    return child;
  }) as unknown as Parameters<typeof runAuthProbe>[1];
  const result = await probeGrokLogin(timeout => runAuthProbe(timeout, controlledSpawn), 10);
  expect(result.ok).toBe(false);
  expect(result.stage).toBe('spawn');
  expect(result).toMatchObject({ timeoutMs: 10 });
  expect(result.elapsedMs).toBeGreaterThanOrEqual(5);
});

test('real probe preserves observed stage when child emits an error after spawn', async () => {
  const controlledSpawn = (() => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => { child.emit('spawn'); child.emit('error', new Error('EPIPE')); });
    return child;
  }) as unknown as Parameters<typeof runAuthProbe>[1];
  const result = await probeGrokLogin(timeout => runAuthProbe(timeout, controlledSpawn), 100);
  expect(result).toMatchObject({ ok: false, stage: 'first-byte' });
});

test('api_token is redacted independently in failure reason and stderr chunk shapes', async () => {
  const failure = await probeGrokLogin(() => ({ status: 1, stderr: 'api_token=plainFailureValue' }));
  expect(failure.reason).toContain('[redacted credential]');
  expect(JSON.stringify(failure)).not.toContain('plainFailureValue');

  const capture = async (chunks: string[]) => {
    const controlledSpawn = (() => {
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => {
        child.emit('spawn');
        for (const chunk of chunks) child.stderr.write(chunk);
        child.emit('close', 1);
      });
      return child;
    }) as unknown as Parameters<typeof runAuthProbe>[1];
    return runAuthProbe(100, controlledSpawn);
  };

  const singleChunk = await capture(['api_token=singleChunkValue\n']);
  expect(singleChunk.stderr).toContain('[redacted credential]');
  expect(singleChunk.stderr).not.toContain('singleChunkValue');

  const splitChunks = await capture(['api_token=', 'splitChunkValue\n']);
  expect(splitChunks.stderr).toContain('[redacted credential]');
  expect(splitChunks.stderr).not.toContain('splitChunkValue');

  const longChunk = await capture([`api_token=${' '.repeat(12_000)}longChunkValue\n`]);
  expect(longChunk.stderr).toContain('[redacted credential]');
  expect(longChunk.stderr).not.toContain('longChunkValue');

  const delimiterBeyondBuffer = await capture([`api_token${' '.repeat(64_001)}`, '=boundarySecret\n']);
  expect(delimiterBeyondBuffer.stderr).not.toContain('boundarySecret');
  expect(JSON.stringify(await probeGrokLogin(() => delimiterBeyondBuffer, 100))).not.toContain('boundarySecret');
});

test('real probe redacts credentials before trimming long stderr chunks', async () => {
  const controlledSpawn = (() => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.emit('spawn');
      child.stderr.write(`Authorization: ApiKey${' '.repeat(12_000)}lateHeaderSecret refresh_token=${' '.repeat(12_000)}lateRefreshSecret`);
    });
    return child;
  }) as unknown as Parameters<typeof runAuthProbe>[1];
  const result = await probeGrokLogin(timeout => runAuthProbe(timeout, controlledSpawn), 20);
  expect(JSON.stringify(result)).not.toContain('lateHeaderSecret');
  expect(JSON.stringify(result)).not.toContain('lateRefreshSecret');
});

test('real probe redacts credentials split across stderr chunks', async () => {
  const controlledSpawn = (() => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.emit('spawn');
      child.stderr.write('Authorization: Basic ');
      setTimeout(() => {
        child.stderr.write('splitBasicSecret refresh_token=');
        setTimeout(() => { child.stderr.write('splitRefreshSecret\n'); child.emit('close', 1); }, 1);
      }, 1);
    });
    return child;
  }) as unknown as Parameters<typeof runAuthProbe>[1];
  const result = await runAuthProbe(100, controlledSpawn);
  expect(result.stderr).not.toContain('splitBasicSecret');
  expect(result.stderr).not.toContain('splitRefreshSecret');
});
