import { describe, expect, test } from 'bun:test';
import { formatCycleFiredDecision, judgeCycleFired, main, type LogQueryObserver } from './cycle-fired-judge.js';

const measuredAt = new Date('2026-09-04T01:00:00.000Z');
const meta = (opened = 2, unopened = 0) => JSON.stringify({ _meta: { type: 'log-query-opened-stores', stores: Array.from({ length: opened }, (_, index) => ({ name: `store-${index}` })), scope: { unopenedStores: unopened } } });
const event = (ts: string, name: string, data: Record<string, unknown> = {}) => JSON.stringify({ ts, category: 'mission-loop.composite', event: name, data });

describe('cycle fired judge', () => {
  test('array JSONL and array event data stay harmless while a later valid cycle is counted', () => {
    const decision = judgeCycleFired([
      '[]',
      JSON.stringify({ ts: '2026-09-03T23:05:01.995Z', category: 'mission-loop.composite', event: 'cycle-started', data: [] }),
      JSON.stringify({ ts: '2026-09-03T23:06:01.995Z', category: 'mission-loop.composite', event: 'request-decision', data: [] }),
      event('2026-09-03T23:07:01.995Z', 'cycle-completed'),
    ].join('\n'), measuredAt);
    expect(decision).toMatchObject({ status: 'fired', decisions: ['unknown'], seenEventRows: 4 });
  });

  test('today KST started and completed is fired, includes decisions and excludes meta from row count', () => {
    const decision = judgeCycleFired([
      meta(3, 1),
      JSON.stringify({ _meta: { type: 'log-query-multi-surface-duplicates' } }),
      event('2026-09-03T23:05:01.995Z', 'cycle-started'),
      event('2026-09-03T23:06:01.995Z', 'request-decision', { action: 'executed' }),
      event('2026-09-03T23:07:01.995Z', 'request-decision', { action: 'escalated' }),
      event('2026-09-03T23:08:01.995Z', 'cycle-completed'),
    ].join('\n'), measuredAt);
    expect(decision).toEqual({ status: 'fired', kstDate: '2026-09-04', decisions: ['executed', 'escalated'], openedStores: 3, unopenedStores: 1, seenEventRows: 4 });
    expect(formatCycleFiredDecision(decision)).toContain('돌았다');
    expect(formatCycleFiredDecision(decision)).toContain('KST 2026-09-04');
  });

  test('UTC today but KST yesterday is not fired', () => {
    const decision = judgeCycleFired(event('2026-09-03T14:59:59.000Z', 'cycle-started'), measuredAt);
    expect(decision.status).toBe('not-fired');
    expect(formatCycleFiredDecision(decision)).toContain('안 돌았다');
  });

  test('meta-only output has zero seen event rows', () => {
    const decision = judgeCycleFired(`${meta(2, 5)}\n${JSON.stringify({ _meta: { type: 'log-query-multi-surface-duplicates' } })}`, measuredAt);
    expect(decision.seenEventRows).toBe(0);
    expect(decision.openedStores).toBe(2);
    expect(decision.unopenedStores).toBe(5);
  });

  test('started without completed is incomplete rather than fired', () => {
    const decision = judgeCycleFired(event('2026-09-03T23:05:01.995Z', 'cycle-started'), measuredAt);
    expect(decision.status).toBe('incomplete');
    expect(formatCycleFiredDecision(decision)).toContain('미완료');
    expect(formatCycleFiredDecision(decision)).not.toContain('돌았다');
  });

  test('the date discriminator rejects an always-today implementation', () => {
    const yesterdayOnly = judgeCycleFired(event('2026-09-03T14:59:59.000Z', 'cycle-started'), measuredAt);
    expect(yesterdayOnly.status).toBe('not-fired');
  });

  test('uses only the latest start through its completed boundary and excludes other-cycle decisions', () => {
    const decision = judgeCycleFired([
      event('2026-09-03T23:00:00.000Z', 'cycle-completed'),
      event('2026-09-03T23:01:00.000Z', 'request-decision', { action: 'before-first-start' }),
      event('2026-09-03T23:02:00.000Z', 'cycle-started'),
      event('2026-09-03T23:03:00.000Z', 'request-decision', { action: 'old-cycle' }),
      event('2026-09-03T23:04:00.000Z', 'cycle-completed'),
      event('2026-09-03T23:05:00.000Z', 'request-decision', { action: 'after-old-completed' }),
      event('2026-09-03T23:06:00.000Z', 'cycle-started'),
      event('2026-09-03T23:07:00.000Z', 'request-decision', { action: 'executed' }),
      event('2026-09-03T23:08:00.000Z', 'cycle-completed'),
      event('2026-09-03T23:09:00.000Z', 'request-decision', { action: 'after-target-completed' }),
    ].join('\n'), measuredAt);
    expect(decision).toMatchObject({ status: 'fired', decisions: ['executed'] });
  });

  test('a following start bounds an incomplete latest cycle from an earlier completed cycle', () => {
    const decision = judgeCycleFired([
      event('2026-09-03T23:01:00.000Z', 'cycle-started'),
      event('2026-09-03T23:02:00.000Z', 'cycle-completed'),
      event('2026-09-03T23:03:00.000Z', 'cycle-started'),
    ].join('\n'), measuredAt);
    expect(decision.status).toBe('incomplete');
  });

  test('orders merged JSONL by timestamp rather than row order before finding the latest cycle boundary', () => {
    const decision = judgeCycleFired([
      event('2026-09-03T23:20:00.000Z', 'cycle-completed'),
      event('2026-09-03T23:30:00.000Z', 'cycle-started'),
      event('2026-09-03T23:25:00.000Z', 'request-decision', { action: 'before-target' }),
      event('2026-09-03T23:10:00.000Z', 'cycle-started'),
      event('2026-09-03T23:35:00.000Z', 'request-decision', { action: 'executed' }),
      event('2026-09-03T23:40:00.000Z', 'cycle-completed'),
      event('2026-09-03T23:45:00.000Z', 'request-decision', { action: 'after-target' }),
    ].join('\n'), measuredAt);
    expect(decision).toMatchObject({ status: 'fired', decisions: ['executed'] });
  });

  test('main injects the observer, requests the complete JSON CLI scope, and prints one evidence line', async () => {
    const calls: string[][] = [];
    const observer: LogQueryObserver = async (args) => {
      calls.push(args);
      return `${meta()}\n${event('2026-09-03T23:05:01.995Z', 'cycle-started')}\n${event('2026-09-03T23:06:01.995Z', 'cycle-completed')}`;
    };
    const lines: string[] = [];
    const original = console.log;
    try {
      console.log = (line: string) => { lines.push(line); };
      await expect(main(observer, measuredAt)).resolves.toMatchObject({ status: 'fired' });
      expect(calls).toEqual([['--all', '--include-test', '--json', '--json-data', '--exact-category', 'mission-loop.composite']]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('연 스토어 2');
    } finally {
      console.log = original;
    }
  });
});
