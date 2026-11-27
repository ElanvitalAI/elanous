import { expect, test } from 'bun:test';
import { runDedupeWorld } from './wake-assign-dedupe-world.js';

test('SIM-WAKE-ASSIGN-DEDUPE: shared wake ledger ⊕ live-steward assignment rule cut duplicate wakes (H1) and double assigns (H2)', async () => {
  const before = await runDedupeWorld(false);
  const after = await runDedupeWorld(true);
  if (process.env.SIM_OUT) console.log(JSON.stringify({ before, after }));
  // 출처: this device's first measurement (11-25 17:4x) — the literals pin it; a change in either direction is a finding.
  expect(before).toEqual({ h1: 32, h2: 5, wakes: 48, assigns: 6, refused: 0 });
  // COORD-RIGHTS (CEO 11-27 08:0x · re-measured): the live steward no longer refuses OP — all 6 OP assigns land (refused 0),
  // audited op-direct. The wake ledger still holds H1 at 0; H2 = 4 (was 1 under the steward refusal, 5 before both rules):
  // the price of OP control, paid as audited double assigns the steward can veto instead of OP being blocked.
  expect(after).toEqual({ h1: 0, h2: 4, wakes: 25, assigns: 6, refused: 0 });
});
