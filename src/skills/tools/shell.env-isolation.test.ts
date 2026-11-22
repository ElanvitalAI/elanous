import { afterEach, expect, test } from 'bun:test';
import { dispatchRunShell } from './shell.js';
import { SHELL_MAX_OUTPUT } from '../../shell-primitive/types.js';

const CANARY = 'synthetic-cx15-secret';
const previous = process.env.ELN_FAKE_SECRET;

afterEach(() => {
  if (previous === undefined) delete process.env.ELN_FAKE_SECRET;
  else process.env.ELN_FAKE_SECRET = previous;
});

test('RunShell default legacy path does not inherit a synthetic secret', async () => {
  process.env.ELN_FAKE_SECRET = CANARY;
  const result = await dispatchRunShell({
    command: [process.execPath, '-e', 'process.stdout.write(process.env.ELN_FAKE_SECRET || "absent")'],
    approval: 'none',
  });
  expect(result.outcome).toBe('exit');
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('absent');
  expect(JSON.stringify(result)).not.toContain(CANARY);
});

test('RunShell default legacy path bounds combined UTF-8 output bytes', async () => {
  const result = await dispatchRunShell({
    command: [process.execPath, '-e', 'process.stdout.write("가".repeat(80000)); process.stderr.write("나".repeat(80000))'],
    approval: 'none',
  });
  expect(result.exitCode).toBe(0);
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(SHELL_MAX_OUTPUT);
});
