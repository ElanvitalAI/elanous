import { expect, test } from 'bun:test';
import type { DecisionEntry } from '../decisions/decision-ledger.js';
import type { CoordEvent } from './coord-events.js';
import { condenseContextDay, type MemorySource } from './long-term-memory.js';

const day = '2026-10-02';
const now = new Date('2026-10-03T00:00:00.000Z');
const event = (n: number, seat = 'TC', kind = '보고'): CoordEvent => ({
  id: `event-${n}`, at: `${day}T${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}:00.000Z`,
  kind, text: `project-alpha/topic-${n}/on`, summary: `project-alpha/topic-${n}/on`,
  refs: { seat, recipients: [], all: false, kind, slot: null, deadline: null, url: `https://example.test/${n}` },
});
const summarize = async (source: MemorySource) => {
  const [project, topic, value] = source.text.split('/');
  return { project: project!, topic: topic!, summary: `${topic} is ${value}`, claim: { key: topic!, value: value! } };
};

test('twenty fake journal rows become project/seat items; newer corrections win, opposite claims flag OP, and >30 days retires', async () => {
  const events = Array.from({ length: 20 }, (_, n) => event(n));
  events[15] = { ...event(15, 'UX'), summary: 'project-beta/topic-15/on' };
  events[16] = { ...event(16), summary: 'project-alpha/topic-0/off', kind: '정정' };
  events[17] = { ...event(17), summary: 'project-alpha/topic-1/off' };
  events[18] = { ...event(18), summary: 'project-alpha/topic-1/on' };
  events[19] = { ...event(19), summary: 'project-alpha/topic-1/off' };
  const previous = [{ project: 'project-alpha', seat: 'TC', topic: 'ancient', summary: 'ancient is on',
    source: 'https://example.test/old', updatedAt: '2026-09-02T23:59:59.000Z', status: 'active' as const }];
  const items = await condenseContextDay(day, previous, { summarize, events: () => events.slice().reverse(), decisions: () => [] }, now);
  expect(events).toHaveLength(20);
  expect(items).toHaveLength(17);
  expect(items.find(i => i.topic === 'topic-0')).toMatchObject({ project: 'project-alpha', seat: 'TC',
    summary: 'topic-0 is off', source: 'https://example.test/16', updatedAt: events[16]!.at, status: 'active' });
  expect(items.find(i => i.topic === 'topic-0')?.conflict).toBeUndefined();
  expect(items.find(i => i.topic === 'topic-1')).toMatchObject({ summary: 'topic-1 is off', source: 'https://example.test/19' });
  expect(items.find(i => i.topic === 'topic-1')?.conflict).toBeUndefined();
  expect(items.find(i => i.topic === 'topic-15')).toMatchObject({ project: 'project-beta', seat: 'UX' });
  expect(items.find(i => i.topic === 'ancient')).toMatchObject({ status: 'retired', updatedAt: previous[0]!.updatedAt });
  expect(items.filter(i => i.status === 'active')).toHaveLength(16);
});

test('decided ledger entries join the same day without touching the ledger, and stale input cannot overwrite a newer snapshot', async () => {
  const decision = { id: 'D-20261002-01', title: 'release route', status: 'decided', decidedAt: `${day}T09:00:00.000Z`,
    scqa: { s: 'release', c: 'route', a: 'suggest canary' }, options: [{ key: 'a', label: 'use canary', consequence: 'staged' }],
    choice: 'a', raisedBy: { agent: 'TC', track: 'TC' },
  } as DecisionEntry;
  const items = await condenseContextDay(day, [{ project: 'project-alpha', seat: 'TC', topic: 'release route',
    summary: 'use production', source: 'elanous://decisions/later', updatedAt: `${day}T10:00:00.000Z`, status: 'active' }], {
    events: () => [event(0, 'MK')], decisions: () => [decision],
    summarize: async source => source.kind === 'decision'
      ? { project: 'project-alpha', topic: 'release route', summary: source.text }
      : { project: 'project-alpha', topic: 'MK update', summary: source.text },
  }, now);
  expect(items).toHaveLength(2);
  expect(items.find(i => i.topic === 'release route')).toMatchObject({ summary: 'use production', source: 'elanous://decisions/later' });
  expect(items.find(i => i.topic === 'MK update')).toMatchObject({ seat: 'MK', source: 'https://example.test/0' });
  const fresh = await condenseContextDay(day, [], { events: () => [], decisions: () => [decision],
    summarize: async source => ({ project: 'project-alpha', topic: 'release route', summary: source.text }) }, now);
  expect(fresh).toMatchObject([{ seat: 'TC', topic: 'release route', summary: 'release route: use canary',
    source: 'elanous://decisions/D-20261002-01', updatedAt: decision.decidedAt }]);
});

test('opposing facts across seats flag an OP decision-card candidate with both source links', async () => {
  const items = await condenseContextDay(day, [], { events: () => [
    { ...event(0, 'TC'), summary: 'alpha/release/on' },
    { ...event(1, 'UX'), summary: 'alpha/release/off' },
  ], decisions: () => [], summarize }, now);
  expect(items).toHaveLength(2);
  expect(items.find(i => i.seat === 'UX')).toMatchObject({
    conflict: { owner: 'OP', sources: ['https://example.test/0', 'https://example.test/1'] },
  });
});

test('same project and claim key across different topics and seats flag an OP candidate', async () => {
  const items = await condenseContextDay(day, [], { events: () => [
    { ...event(0, 'TC'), summary: 'alpha/release-ready/on' },
    { ...event(1, 'UX'), summary: 'alpha/launch-status/off' },
  ], decisions: () => [], summarize: async source => {
    const [project, topic, value] = source.text.split('/');
    return { project: project!, topic: topic!, summary: `${topic} is ${value}`,
      claim: { key: 'release-ready', value: value! } };
  } }, now);
  expect(items.find(i => i.topic === 'launch-status')?.conflict).toEqual({
    owner: 'OP', sources: ['https://example.test/0', 'https://example.test/1'],
  });
});

test('opposing claims within the same project and seat but different topics flag OP; another project does not', async () => {
  const items = await condenseContextDay(day, [], { events: () => [
    { ...event(0), summary: 'alpha/deployment/on' },
    { ...event(1), summary: 'alpha/rollout/off' },
    { ...event(2), summary: 'beta/readiness/off' },
  ], decisions: () => [], summarize: async source => {
    const [project, topic, value] = source.text.split('/');
    return { project: project!, topic: topic!, summary: `${topic} is ${value}`,
      claim: { key: 'deployment-state', value: value! } };
  } }, now);
  expect(items.find(i => i.topic === 'rollout')?.conflict).toEqual({
    owner: 'OP', sources: ['https://example.test/0', 'https://example.test/1'],
  });
  expect(items.find(i => i.topic === 'readiness')?.conflict).toBeUndefined();
});

test('a later TC correction resolves the conflict left on UX by an earlier opposing claim', async () => {
  const items = await condenseContextDay(day, [], { events: () => [
    { ...event(0, 'TC'), summary: 'alpha/release/on' },
    { ...event(1, 'UX'), summary: 'alpha/release/off' },
    { ...event(2, 'TC', '정정'), summary: 'alpha/release/off' },
  ], decisions: () => [], summarize }, now);
  expect(items).toHaveLength(2);
  expect(items.find(i => i.seat === 'TC')).toMatchObject({ summary: 'release is off', source: 'https://example.test/2' });
  expect(items.find(i => i.seat === 'TC')?.conflict).toBeUndefined();
  expect(items.find(i => i.seat === 'UX')?.conflict).toBeUndefined();
});

test('opposite claims sharing one URL still produce an OP decision-card candidate', async () => {
  const url = 'https://example.test/shared';
  const items = await condenseContextDay(day, [], { events: () => [
    { ...event(0, 'TC'), summary: 'alpha/release/on', refs: { ...event(0).refs, url } },
    { ...event(1, 'UX'), summary: 'alpha/release/off', refs: { ...event(1, 'UX').refs, url } },
  ], decisions: () => [], summarize }, now);
  expect(items.map(i => i.seat)).toEqual(['TC', 'UX']);
  expect(items.find(i => i.seat === 'UX')?.conflict).toEqual({ owner: 'OP', sources: [url, url] });
});

test('UTC day membership and newest winner use parsed instants across timezone offsets', async () => {
  let requestedSince = '';
  const items = await condenseContextDay(day, [], { events: since => {
    requestedSince = since;
    return [
      { ...event(0), at: '2026-10-03T01:00:00+02:00', summary: 'alpha/release/on' },
      { ...event(1), at: '2026-10-01T23:30:00-02:00', summary: 'alpha/release/off' },
      { ...event(2), at: '2026-10-02T00:30:00Z', summary: 'alpha/release/on' },
      { ...event(3), at: '2026-10-02T23:30:00-02:00', summary: 'alpha/excluded/on' },
      { ...event(4), at: '2026-10-02T00:30:00+02:00', summary: 'alpha/excluded/off' },
    ];
  }, decisions: () => [], summarize }, now);
  expect(requestedSince).toBe('2026-10-01T00:00:00.000Z');
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ topic: 'release', summary: 'release is on',
    source: 'https://example.test/0', updatedAt: '2026-10-03T01:00:00+02:00' });
});

test('day window excludes adjacent days and summaries never include a second line', async () => {
  let called = 0;
  const items = await condenseContextDay(day, [], { events: () => [
    { ...event(1), at: '2026-10-01T23:59:59.000Z' }, event(2),
    { ...event(3), at: '2026-10-03T00:00:00.000Z' },
  ], decisions: () => [], summarize: async source => {
    called++;
    return { project: 'alpha', topic: 'topic', summary: `${source.text}\nprivate text` };
  } }, now);
  expect(called).toBe(1);
  expect(items).toHaveLength(1);
  expect(JSON.stringify(items)).not.toContain('private text');
});
