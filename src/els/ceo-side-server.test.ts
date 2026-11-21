import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestEls } from './client.js';
import { createCeoSideAlertWriter } from './ceo-side-alert.js';
import { elsSocketPath, startElsServer } from './server.js';

test('real els owner list carries the 30-second red count into the app payload and clears after eyes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ceo-side-server-'));
  const started = await startElsServer({ stateRoot: root, stall: false });
  if ('exitCode' in started) throw new Error(started.message);
  try {
    const writer = createCeoSideAlertWriter(root);
    const list = async () => {
      const answer = await requestEls(elsSocketPath(root), { op: 'ls' });
      expect(answer.exitCode).toBe(0);
      return JSON.parse(answer.message) as { ceoSide?: { pendingRed: number } };
    };
    expect((await list()).ceoSide).toBeUndefined();
    expect(writer.update('telegram', 'chat', 'm1', 'pending-red')).toBe(true);
    expect((await list()).ceoSide).toEqual({ pendingRed: 1 });
    expect(writer.update('telegram', 'chat', 'm1', 'seen')).toBe(true);
    expect((await list()).ceoSide).toEqual({ pendingRed: 0 });
  } finally { await started.close(); rmSync(root, { recursive: true, force: true }); }
});
