import { expect, test } from 'bun:test';
import { runDedupeWorld } from './wake-assign-dedupe-world.js';

test('SIM-WAKE-ASSIGN-DEDUPE: shared wake ledger ⊕ live-steward assignment rule cut duplicate wakes (H1) and double assigns (H2)', async () => {
  const before = await runDedupeWorld(false);
  const after = await runDedupeWorld(true);
  if (process.env.SIM_OUT) console.log(JSON.stringify({ before, after }));
  // 출처: this device's first measurement (11-25 17:4x) — the literals pin it; a change in either direction is a finding.
  expect(before).toEqual({ h1: 32, h2: 5, wakes: 48, assigns: 6, refused: 0 });
  // The one H2 left is the P0 push (`--p0`), the exception path by design; its wake is skipped by the ledger.
  expect(after).toEqual({ h1: 0, h2: 1, wakes: 24, assigns: 1, refused: 5 });
});
