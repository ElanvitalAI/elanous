import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SimWorldScenarioContext } from '../types.js';
import { simWorldScenarios } from './c5-wakeup.js';

test('C5 restart restores a past-due one-shot and opens exactly one restart turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'c5-wakeup-'));
  const events: Array<{ name: string; data: unknown }> = [];
  try {
    const ctx = { universeRoot: root, recorder: { event: (name: string, data: unknown) => { events.push({ name, data }); } } } as unknown as SimWorldScenarioContext;
    const result = await simWorldScenarios[0]!.run(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the partial-axis verdict');
    expect(result.reason).toBe('C5 gate-declined and pty axes unmeasured');
    expect(events).toEqual([{ name: 'c5-wakeup-restart',
      data: { busyDropped: 0, busyOpened: 1, restartDiscarded: [], restartLate: 1, restartOpened: 1, restartPending: [] } }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});