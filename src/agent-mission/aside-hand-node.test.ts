import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRunLedger } from '../self-implement/run-ledger.js';
import { simBrowserHand } from '../ux-sim/browser-hand.js';

const stateRoots: string[] = [];
const previousStateDir = process.env.ELANOUS_STATE_DIR;
afterEach(() => {
  for (const root of stateRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previousStateDir;
});

test('ASIDE-HAND-NODE fake-CDP repair is recorded on the active research-run graph ledger', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'aside-hand-node-'));
  stateRoots.push(stateRoot);
  process.env.ELANOUS_STATE_DIR = stateRoot;

  const result = await simBrowserHand('paywall-fallback');
  expect(result.result.repairNode?.graphEvent).toMatchObject({ type: 'node-added', kind: 'hand', decider: 'browser-hand' });
  expect(result.browserActions).toEqual(['https://archive.example.test/filing']);

  const rows = loadRunLedger('run-ux-sim-browser-hand') ?? [];
  expect(rows.filter(row => row.event === 'node-added')).toEqual([
    expect.objectContaining({
      event: 'node-added',
      data: expect.objectContaining({
        node: result.result.repairNode?.graphEvent.node,
        kind: 'hand',
        decider: 'browser-hand',
        missionId: 'c0ffee00-0000-4000-8000-000000000001',
        outcome: 'detoured',
        blockedOn: 'paywall:https://ir.example.test/filing',
        detourUrl: 'https://archive.example.test/filing',
      }),
      seq: expect.any(Number),
    }),
  ]);
});
