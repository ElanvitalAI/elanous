import { expect, test } from 'bun:test';
import { runShell } from './runtime.js';
import { runtimeProcessIdentity } from '../els/seat-runtime.js';

test('shell tool child receives the live eln runtime identity', async () => {
  if (process.platform !== 'darwin') return;
  const self = runtimeProcessIdentity(process.pid);
  expect(self).toBeDefined();
  const result = await runShell({ command: [process.execPath, '-e', 'process.stdout.write(process.env.ELN_SEAT_RUNTIME || "")'], approval: 'none' });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ pid: process.pid, start: self!.start });
});
