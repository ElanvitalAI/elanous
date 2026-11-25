import { describe, expect, test } from 'bun:test';
import { runPoolCase } from './federation-hand-pool-world.js';

describe('FEDERATION-HAND-POOL', () => {
  test('hand pool [B] · TC board empty ⊕ UX/JUD backlog ⊕ demo P0 in UX: before TC hands exit 3 all day; after they take the UX demo P0 first, then borrow UX, never JUD', () => {
    const before = runPoolCase('before');
    const after = runPoolCase('after');
    expect(before.firstRound).toEqual({ 'TC-H1': 3, 'TC-H2': 3, 'TC-H3': 3, 'TC-H4': 3, 'JUD-H1': 0 });
    expect([before.firstTcClaim, before.tcClaims, before.lends, before.exit3Calls, before.cellsGreen]).toEqual([null, 0, 0, 48, 3]);
    expect(after.firstRound).toEqual({ 'TC-H1': 0, 'TC-H2': 0, 'TC-H3': 0, 'TC-H4': 0, 'JUD-H1': 0 });
    expect([after.firstTcClaim, after.tcClaims, after.lends, after.exit3Calls, after.cellsGreen]).toEqual(['UX-DEMO-1', 6, 6, 30, 9]);
    expect(after.lendRows.slice(0, 2)).toEqual(['TC-H1 TC→UX UX-DEMO-1', 'TC-H2 TC→UX UX-P1-1']);
    expect([before.crossRoleClaims, after.crossRoleClaims]).toEqual([0, 0]);
  });
});
