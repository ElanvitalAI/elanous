import { expect, test } from 'bun:test';
import { kcbPhoneVerdicts, type KcbPhoneReceipt } from './kcb-phone-rehearsal.js';

const start = '2026-11-13T01:00:00.000Z';
const rows: KcbPhoneReceipt[] = [1, 2, 3].map(index => ({
  device: `phone-${index}`, mode: 'fake-oidc', qrScannedAt: start,
  firstResultAt: new Date(Date.parse(start) + 60_000 + index * 10_000).toISOString(),
  example: 'day-plan',
}));

test('three device receipts calculate the boundary from recorded timestamps', () => {
  expect(kcbPhoneVerdicts(rows).map(row => [row.elapsedMs, row.withinTwoMinutes]))
    .toEqual([[70_000, true], [80_000, true], [90_000, true]]);
  expect(kcbPhoneVerdicts([{ ...rows[0]!, firstResultAt: new Date(Date.parse(start) + 120_001).toISOString() }, ...rows.slice(1)])[0]?.withinTwoMinutes).toBe(false);
});

test('missing, duplicate and reversed phone records cannot pass', () => {
  expect(() => kcbPhoneVerdicts(rows.slice(0, 2))).toThrow();
  expect(() => kcbPhoneVerdicts([rows[0]!, rows[0]!, rows[2]!])).toThrow();
  expect(() => kcbPhoneVerdicts([{ ...rows[0]!, firstResultAt: '2026-11-13T00:59:59.000Z' }, ...rows.slice(1)])).toThrow();
  expect(kcbPhoneVerdicts([{ ...rows[0]!, firstResultAt: null }, ...rows.slice(1)])[0])
    .toMatchObject({ elapsedMs: null, withinTwoMinutes: false });
});
