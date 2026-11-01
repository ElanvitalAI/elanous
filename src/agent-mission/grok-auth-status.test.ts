import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { probeGrokLogin, runAuthProbe } from './grok-auth-status.js';

test('Grok subscribed-access probe reports ready without returning account details', async () => {
  expect(await probeGrokLogin(() => ({ status: 0, stdout: 'OK', stage: 'response', durationMs: 12 }))).toEqual({ ok: true, stage: 'response', durationMs: 12 });
});

test('Grok subscribed-access probe falls back on missing auth and hides raw output', async () => {
  const result = await probeGrokLogin(() => ({ status: 1, stderr: 'login required, user@example.com' }));
  expect(result.ok).toBe(false);
  expect(result.stage).toBe('auth');
  expect(result.reason).toContain('Grok login unavailable; run grok login');
  expect(result.reason).toContain('[redacted-email]');
  expect(JSON.stringify(result)).not.toContain('user@example.com');
  expect(await probeGrokLogin(() => ({ status: 0, stdout: 'unexpected output' }))).toMatchObject({ ok: false, reason: expect.stringContaining('Grok subscribed-access probe did not return the expected OK reply') });
});

test('Grok subscribed-access probe fails closed for timeout and empty output', async () => {
  expect(await probeGrokLogin(() => ({ status: null, error: new Error('Grok subscribed-access probe timed out') }))).toMatchObject({ ok: false, stage: 'first-byte', reason: expect.stringContaining('Grok subscribed-access probe timed out (first-byte') });
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
  expect(result.durationMs).toBeGreaterThanOrEqual(10);
  expect(result.durationMs).toBeLessThan(1_000);
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
  expect(result.durationMs).toBeGreaterThanOrEqual(5);
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
