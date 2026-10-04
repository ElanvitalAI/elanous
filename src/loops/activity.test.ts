import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { loopActivity } from './activity.js';
import type { AllLoopEntry } from './registry.js';
import type { LogStoreRow } from '../mss/logging/log-store.js';

const since = '2026-10-04T00:00:00.000Z';
const until = '2026-10-05T00:00:00.000Z';
const loops: AllLoopEntry[] = [{ id: 'alpha', kind: 'graph', title: 'Alpha', enabled: true, registered: true,
  lastRunAt: since, expectEveryMinutes: 60, recentStatuses: ['done'] }];
const event = (id: number, ts: string, category: string, name: string, data: object): LogStoreRow => ({
  id, ts, ts_ms: Date.parse(ts), category, event: name, data: JSON.stringify(data),
  level: 'debug', instance: 'test', surface: 'nexus', session_id: null, trace_id: null,
});

const empty = { listAllLoops: () => loops, readJournal: () => [], readCards: () => [] };

describe('loopActivity', () => {
  test('registry/checker nodes remain present without events, and event-only nodes do not claim a checker state', () => {
    const result = loopActivity({ since, until, root: '/unused', deps: { ...empty, queryEvents: () => [
      event(1, since, 'loop.orchestrator', 'tick', {}),
      event(2, since, 'loop.tc-seat', 'tick', {}),
      event(3, since, 'loop.checker', 'checked', {}),
    ] } });
    expect(result.nodes.map(node => [node.id, node.kind, node.state, node.events])).toEqual([
      ['alpha', 'graph', 'late', 0], ['orchestrator', 'event', null, 1], ['tc-seat', 'event', null, 1],
    ]);
    expect(result.edges).toEqual([]);
  });

  test('inclusive window aggregates observed delegation/request/reply/card edges; excludes shadow and out-of-window events', () => {
    const result = loopActivity({ since, until, root: '/unused', deps: { ...empty, queryEvents: () => [
      event(1, since, 'loop.orchestrator', 'exchange', { reason: 'queued', targetLoopId: 'tc-seat' }),
      event(2, until, 'loop.orchestrator', 'exchange', { reason: 'queued', targetLoopId: 'tc-seat' }),
      event(3, since, 'loop.orchestrator', 'would-delegate', { targetLoopId: 'tc-seat' }),
      event(4, since, 'loop.mk-seat', 'exchange', { reason: 'delegation', from: 'MK', to: 'TC' }),
      event(5, '2026-10-03T23:59:59Z', 'loop.orchestrator', 'exchange', { reason: 'queued', targetLoopId: 'tc-seat' }),
      event(6, since, 'loop.tc-seat', 'exchange', { reason: 'requeue', to: 'MK' }),
    ], readJournal: (_root, name) => name === 'requests.jsonl' ? [
      { queuedAt: since, seat: 'TC', from: 'MK' }, { queuedAt: '2026-10-06T00:00:00Z', seat: 'UX' },
    ] : [{ repliedAt: until, seat: 'TC', to: 'MK' }],
    readCards: () => [{ id: 'one', createdAt: since, sections: [{ owner: 'MK', createdAt: until },
      { owner: 'TC', createdAt: '2026-10-06T00:00:00Z' }] }] } });
    expect(result.edges).toEqual([
      { from: 'cmo-seat', to: 'card:one', kind: 'card', count: 1, lastAt: until },
      { from: 'cmo-seat', to: 'tc-seat', kind: 'delegation', count: 1, lastAt: since },
      { from: 'cmo-seat', to: 'tc-seat', kind: 'request', count: 1, lastAt: since },
      { from: 'orchestrator', to: 'tc-seat', kind: 'delegation', count: 2, lastAt: until },
      { from: 'tc-seat', to: 'cmo-seat', kind: 'reply', count: 1, lastAt: until },
    ]);
    expect(result.nodes.some(node => node.id === 'ux-seat')).toBe(false);
    expect(result.nodes.some(node => node.id === 'mk-seat')).toBe(false);
    expect(result.nodes.find(node => node.id === 'cmo-seat')).toMatchObject({ events: 1 });
  });

  test('card exchange and card ledger sections aggregate at the same card node', () => {
    const result = loopActivity({ since, until, root: '/unused', deps: { ...empty,
      queryEvents: () => [event(1, since, 'loop.mk-seat', 'exchange', { reason: 'card', from: 'MK', cardId: 'one' })],
      readCards: () => [{ id: 'one', createdAt: since, sections: [{ owner: 'MK', createdAt: until }] }],
    } });
    expect(result.edges).toEqual([{ from: 'cmo-seat', to: 'card:one', kind: 'card', count: 2, lastAt: until }]);
    expect(result.nodes.find(node => node.id === 'card:one')?.kind).toBe('card');
    expect(result.nodes.some(node => node.id === 'one')).toBe(false);
  });

  test('default file readers use read-only SQLite and journals without creating missing stores or changing contents', () => {
    const root = mkdtempSync(join(tmpdir(), 'loop-activity-'));
    try {
      expect(loopActivity({ since, until, root }).edges).toEqual([]);
      expect(existsSync(join(root, 'schedules.db'))).toBe(false);
      expect(existsSync(join(root, 'logs', 'logs.db'))).toBe(false);
      expect(existsSync(join(root, 'seat-requests'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('reads existing log DB, request journal and card ledger without modifying them', () => {
    const root = mkdtempSync(join(tmpdir(), 'loop-activity-'));
    try {
      mkdirSync(join(root, 'logs'));
      mkdirSync(join(root, 'seat-requests'));
      mkdirSync(join(root, 'task-cards'));
      const db = new Database(join(root, 'logs', 'logs.db'));
      db.run('CREATE TABLE logs(id INTEGER PRIMARY KEY, ts TEXT, ts_ms INTEGER, category TEXT, event TEXT, data TEXT)');
      db.run('INSERT INTO logs(ts,ts_ms,category,event,data) VALUES (?,?,?,?,?)', [since, Date.parse(since), 'loop.tc-seat', 'tick', '{}']);
      db.close();
      const requests = join(root, 'seat-requests', 'requests.jsonl');
      const cards = join(root, 'task-cards', 'one.jsonl');
      writeFileSync(requests, JSON.stringify({ seat: 'TC', queuedAt: since }) + '\n');
      writeFileSync(cards, [JSON.stringify({ type: 'created', id: 'one', createdAt: since }),
        JSON.stringify({ type: 'section', owner: 'TC', createdAt: until })].join('\n') + '\n');
      const before = [readFileSync(requests), readFileSync(cards), readFileSync(join(root, 'logs', 'logs.db'))];
      const result = loopActivity({ since, until, root, deps: { listAllLoops: () => loops } });
      expect(result.edges.map(edge => edge.kind)).toEqual(['card']);
      expect(result.nodes.find(node => node.id === 'tc-seat')?.events).toBe(2);
      expect([readFileSync(requests), readFileSync(cards), readFileSync(join(root, 'logs', 'logs.db'))]).toEqual(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('relative since is resolved against the supplied until clock', () => {
    const result = loopActivity({ since: '24h', until, root: '/unused', deps: { ...empty, queryEvents: () => [] } });
    expect(result.since).toBe(since);
    expect(result.until).toBe(until);
  });

  test('invalid and reversed windows are rejected without consulting dependencies', () => {
    expect(() => loopActivity({ since: 'not-a-date', deps: empty })).toThrow('invalid loop activity window');
    expect(() => loopActivity({ since: until, until: since, deps: empty })).toThrow('invalid loop activity window');
  });
});
