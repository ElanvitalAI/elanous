import { describe, expect, test } from 'bun:test';
import { EXTERNAL_CALL_CATEGORIES, ExternalCallZeroGuard, type ExternalCallAuditEntry } from './external-call-zero.js';

const FIXED_AT = new Date('2026-10-15T21:04:00.000Z');

describe('ExternalCallZeroGuard (외부 호출 0 모드 가드)', () => {
  test('the guard vocabulary is exactly llm · search · crawl', () => {
    expect([...EXTERNAL_CALL_CATEGORIES]).toEqual(['llm', 'search', 'crawl']);
  });

  test('enabled mode denies every llm/search/crawl attempt and audits each one', () => {
    const guard = new ExternalCallZeroGuard({ enabled: true, now: () => FIXED_AT });
    for (const category of EXTERNAL_CALL_CATEGORIES) {
      expect(guard.attempt(category, `caller-of-${category}`).denied).toBe(true);
    }
    expect(guard.ledger().map((entry) => [entry.category, entry.caller])).toEqual([
      ['llm', 'caller-of-llm'],
      ['search', 'caller-of-search'],
      ['crawl', 'caller-of-crawl'],
    ]);
  });

  test('each denied attempt is written as one ledger line with timestamp, category, caller', () => {
    const guard = new ExternalCallZeroGuard({ enabled: true, now: () => FIXED_AT });
    const first = guard.attempt('llm', 'run-supervisor.ts superviseRun').entry!;
    expect(first).toEqual({ seq: 0, at: '2026-10-15T21:04:00.000Z', category: 'llm', caller: 'run-supervisor.ts superviseRun' });
    const second = guard.attempt('search', 'run-supervisor.ts superviseRun').entry!;
    expect(second.seq).toBe(1);
    expect(guard.ledger()).toHaveLength(2);
  });

  test('disabled mode passes attempts through and records nothing', () => {
    const guard = new ExternalCallZeroGuard({ now: () => FIXED_AT });
    expect(guard.enabled).toBe(false);
    for (const category of EXTERNAL_CALL_CATEGORIES) {
      expect(guard.attempt(category, 'caller')).toEqual({ denied: false });
    }
    expect(guard.ledger()).toEqual([]);
  });

  test('the ledger is append-only — entries and the read view cannot be rewritten', () => {
    const guard = new ExternalCallZeroGuard({ enabled: true, now: () => FIXED_AT });
    guard.attempt('llm', 'first');
    const view = guard.ledger();
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view[0])).toBe(true);
    expect(() => (view as ExternalCallAuditEntry[]).push({ seq: 9, at: 'forged', category: 'llm', caller: 'forged' })).toThrow();
    const local = [...guard.ledger()];
    local.pop();
    expect(guard.ledger()).toHaveLength(1);
    expect(guard.ledger()[0]?.caller).toBe('first');
  });

  test('the default wall clock yields ISO 8601 timestamps', () => {
    const guard = new ExternalCallZeroGuard({ enabled: true });
    const at = guard.attempt('crawl', 'caller').entry!.at;
    expect(Number.isNaN(Date.parse(at))).toBe(false);
  });
});
