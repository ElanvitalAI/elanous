import { expect, test } from 'bun:test';
import { proposeHqPromotion, type HqOpRequest } from './promote.js';

const input = { holder: 'mbp', standby: 'node-b', generation: 7, streak: 3 };

test('a promotion proposal is one OP seat request per lease generation, never a promotion', () => {
  const rows: HqOpRequest[] = [];
  const request = (row: HqOpRequest) => { const created = !rows.some((r) => r.key === row.key); if (created) rows.push(row); return { key: row.key, created }; };
  const events: Array<{ category: string; event: string; data: unknown }> = [];
  const log = ((category: string, event: string, data?: unknown) => { events.push({ category, event, data }); }) as typeof import('../debug/log.js').debug.log;
  const first = proposeHqPromotion(input, { request, log });
  const again = proposeHqPromotion({ ...input, streak: 4 }, { request, log });
  expect(first).toEqual({ promoted: false, requestKey: 'hq:promote:mbp:7', created: true });
  expect(again).toEqual({ promoted: false, requestKey: 'hq:promote:mbp:7', created: false });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.text).toContain('node-b');
  expect(events[0]).toMatchObject({ category: 'hq.arbiter', event: 'promote-proposed', data: { mode: 'op-request', created: true } });
  expect(proposeHqPromotion({ ...input, generation: 8 }, { request, log }).created).toBe(true);
  expect(rows).toHaveLength(2);
});
