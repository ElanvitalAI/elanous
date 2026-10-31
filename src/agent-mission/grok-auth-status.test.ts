import { expect, test } from 'bun:test';
import { probeGrokLogin } from './grok-auth-status.js';

test('Grok subscribed-access probe reports ready without returning account details', async () => {
  expect(await probeGrokLogin(() => ({ status: 0, stdout: 'OK' }))).toEqual({ ok: true });
});

test('Grok subscribed-access probe falls back on missing auth and hides raw output', async () => {
  const result = await probeGrokLogin(() => ({ status: 1, stderr: 'login required, user@example.com' }));
  expect(result).toEqual({ ok: false, reason: 'Grok login unavailable; run grok login' });
  expect(JSON.stringify(result)).not.toContain('user@example.com');
  expect(await probeGrokLogin(() => ({ status: 0, stdout: 'unexpected output' }))).toEqual({ ok: false, reason: 'Grok subscribed-access probe did not return the expected OK reply' });
});

test('Grok subscribed-access probe fails closed for timeout and empty output', async () => {
  expect(await probeGrokLogin(() => ({ status: null, error: new Error('Grok subscribed-access probe timed out') }))).toEqual({ ok: false, reason: 'Grok subscribed-access probe timed out' });
  expect(await probeGrokLogin(() => ({ status: 0, stdout: '' }))).toEqual({ ok: false, reason: 'Grok subscribed-access probe did not return the expected OK reply' });
});

test('Grok auth probe is async and bounded independently of its child process', async () => {
  let resolveProbe!: (value: { status: number; stdout: string }) => void;
  const pending = probeGrokLogin(() => new Promise(resolve => { resolveProbe = resolve; }), 1);
  await new Promise(resolve => setTimeout(resolve, 5));
  resolveProbe({ status: 0, stdout: 'OK' });
  await expect(pending).resolves.toEqual({ ok: true });
});

test('Grok auth probe defaults to the OP-approved 45-second first-response bound', async () => {
  let observedTimeout = 0;
  await probeGrokLogin(timeoutMs => { observedTimeout = timeoutMs; return { status: 0, stdout: 'OK' }; });
  expect(observedTimeout).toBe(45_000);
});
