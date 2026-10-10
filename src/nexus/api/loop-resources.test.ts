import { expect, test } from 'bun:test';
import { handleLoopResourcesGet, observeLoopResources } from './loop-resources.js';
import { trafficTick } from '../../loops/orchestrator/traffic.js';

const now = new Date('2026-10-05T00:00:00Z');
const result = trafficTick({ now, caps: { OP: 2, TC: 4, MK: 6, UX: 2 }, totalSlots: 14,
  processes: [{ seat: 'MK', elapsedSeconds: 2400, command: 'bun bin/elanous.mjs harness ask goal' }],
  openCells: [{ owner: 'MK', status: 'yellow', id: 'MK-1', title: 'next job' }], nextRound: [] });

test('production observation returns pending MK work with no running processes and no launch approval', async () => {
  const cell = { id: 'MK-WAIT', title: 'waiting work', owner: 'MK', status: 'yellow' as const };
  const response = handleLoopResourcesGet(() => observeLoopResources({
    now, processes: { status: 'ok', records: [], excludedCount: 0 }, version: '0.2.28',
    openCells: [cell], nextRound: [], totalSlots: 0,
  }));
  expect(response.status).toBe(200);
  const body = await response.json() as { resource: { seats: Array<{ seat: string; running: number; idle: boolean;
    nextCell: { id: string } | null }> } };
  expect(body.resource.seats.find(row => row.seat === 'MK')).toMatchObject({
    running: 0, idle: false, nextCell: { id: 'MK-WAIT' },
  });
});

test('resource GET returns the actual traffic decision without writing a new ledger shape', async () => {
  const response = handleLoopResourcesGet(() => result);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ resource: JSON.parse(JSON.stringify(result)) });
  const failed = handleLoopResourcesGet(() => { throw Error('observation unavailable'); });
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({ error: 'resource-unavailable' });
});
