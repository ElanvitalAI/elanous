import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { debug } from '../debug/log.js';
import { loopAgentContractErrors } from './contract/validate.js';
import { judgeNeighbor, type Neighbor } from './neighbors.js';

const neighbor: Neighbor = {
  id: 'op-seat', exchange: ['status'],
  heartbeat: { everyMinutes: 5, missedTicks: 2 },
  onAbsent: { action: 'delegate', delegateTo: 'steward' },
};
const lastSeenAt = '2026-10-04T00:00:00.000Z';
let log: ReturnType<typeof spyOn<typeof debug, 'log'>>;
beforeEach(() => { log = spyOn(debug, 'log').mockImplementation(() => {}); });
afterEach(() => log.mockRestore());

function judge(at: string, overrides: { lastSeenAt?: string | null; lastSendError?: unknown; neighbor?: Neighbor } = {}) {
  return judgeNeighbor({ neighbor: overrides.neighbor ?? neighbor,
    lastSeenAt: 'lastSeenAt' in overrides ? overrides.lastSeenAt : lastSeenAt,
    lastSendError: overrides.lastSendError, now: new Date(at) });
}

test('ACK within the window remains present without action', () => {
  expect(judge('2026-10-04T00:09:59.999Z')).toEqual({ state: 'present', reason: 'within-heartbeat-window' });
  expect(log).toHaveBeenCalledWith('loop.neighbors', 'judged', {
    loop: null, neighbor: 'op-seat', state: 'present', action: undefined, reason: 'within-heartbeat-window',
  });
});

test('at the exact everyMinutes × missedTicks boundary and beyond, absence carries the declared action', () => {
  const action = { action: 'escalate', delegateTo: 'orchestrator' } as const;
  const tc = { ...neighbor, onAbsent: action };
  expect(judge('2026-10-04T00:10:00.000Z', { neighbor: tc })).toEqual({
    state: 'absent', action, reason: 'heartbeat-missed',
  });
  expect(judge('2026-10-04T00:12:00.000Z', { neighbor: tc })).toEqual({
    state: 'absent', action, reason: 'heartbeat-missed',
  });
  expect(log).toHaveBeenCalledWith('loop.neighbors', 'judged', {
    loop: null, neighbor: 'op-seat', state: 'absent', action, reason: 'heartbeat-missed',
  });
});

test('unreadable or missing ACK stays unknown rather than absent', () => {
  for (const seen of [null, undefined, 'not-a-date']) {
    expect(judge('2026-10-04T00:12:00.000Z', { lastSeenAt: seen })).toEqual({
      state: 'unknown', reason: 'last-ack-unknown',
    });
  }
});

test('send failure is unknown even beyond the window; never proves peer inactivity', () => {
  expect(judge('2026-10-04T00:12:00.000Z', { lastSendError: new Error('transport down') })).toEqual({
    state: 'unknown', reason: 'send-failed',
  });
  expect(judge('2026-10-04T00:12:00.000Z', { lastSeenAt: null, lastSendError: 'offline' })).toEqual({
    state: 'unknown', reason: 'send-failed',
  });
  expect(log).toHaveBeenCalledWith('loop.neighbors', 'judged', {
    loop: null, neighbor: 'op-seat', state: 'unknown', action: undefined, reason: 'send-failed',
  });
});

test('a neighbor from a manifest accepted by the contract validator passes its action through', () => {
  const manifest = parseYaml(readFileSync(new URL('./contract/examples/cmo-seat.loop.yaml', import.meta.url), 'utf8'));
  expect(loopAgentContractErrors(manifest)).toEqual([]);
  const declared = manifest.neighbors[0] as Neighbor;
  const result = judgeNeighbor({ neighbor: declared, lastSeenAt, now: new Date('2026-10-06T00:00:00.000Z') });
  expect(result.action).toBe(declared.onAbsent);
  expect(result).toEqual({ state: 'absent', action: { action: 'defer', delegateTo: 'orchestrator' }, reason: 'heartbeat-missed' });
});
