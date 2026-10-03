import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUserConfig } from '../user-config.js';
import type { SeatEntry } from '../seat-loop/seat-loop.js';
import { checkSeatBudget, DEFAULT_CONCURRENT_PODS, DEFAULT_DAILY_GOALS, type SeatBudgetInput } from './seat-budget.js';

const now = new Date('2026-10-02T23:20:00Z'); // 2026-10-03 in Seoul
const input = (overrides: Partial<SeatBudgetInput> = {}): SeatBudgetInput =>
  ({ seat: 'TC', now, ledger: [], running: [], config: {}, ...overrides });
const launched = (seat: string, at: string): SeatEntry => ({ seat, at, status: 'launched' });

test('defaults allow up to six daily goals and two concurrent Pods, denying the next launch at the boundary', () => {
  expect(DEFAULT_DAILY_GOALS).toBe(6);
  expect(DEFAULT_CONCURRENT_PODS).toBe(2);
  const five = Array.from({ length: 5 }, () => launched('TC', now.toISOString()));
  expect(checkSeatBudget(input({ ledger: five, running: [{ seat: 'TC', substrate: 'pod' }] }))).toEqual({ allowed: true });
  expect(checkSeatBudget(input({ ledger: [...five, launched('TC', now.toISOString())] })))
    .toEqual({ allowed: false, reason: 'TC daily goals budget reached (6/6)' });
  expect(checkSeatBudget(input({ running: [{ seat: 'TC', substrate: 'pod' }, { seat: 'TC', substrate: 'pod' }] })))
    .toEqual({ allowed: false, reason: 'TC concurrent Pods budget reached (2/2)' });
});

test('daily goals count only this seat’s launches on the current Seoul date', () => {
  const ledger: SeatEntry[] = [
    launched('TC', '2026-10-02T14:59:59Z'), // previous KST date
    launched('UX', now.toISOString()),
    { seat: 'TC', at: now.toISOString(), status: 'attempting' },
    { seat: 'TC', at: now.toISOString(), status: 'skipped-budget' },
    launched('TC', now.toISOString()),
  ];
  expect(checkSeatBudget(input({ ledger, config: { org: { budget: { TC: { dailyGoals: 2 } } } } }))).toEqual({ allowed: true });
  expect(checkSeatBudget(input({ ledger: [...ledger, launched('TC', now.toISOString())], config: { org: { budget: { TC: { dailyGoals: 2 } } } } })))
    .toEqual({ allowed: false, reason: 'TC daily goals budget reached (2/2)' });
});

test('per-seat overrides apply independently, partial and invalid overrides keep their defaults', () => {
  const config = { org: { budget: { TC: { dailyGoals: 1, concurrentPods: 3 }, UX: { dailyGoals: 9 }, MK: { dailyGoals: -1, concurrentPods: 1.5 } } } };
  expect(checkSeatBudget(input({ config, ledger: [launched('TC', now.toISOString())] })))
    .toEqual({ allowed: false, reason: 'TC daily goals budget reached (1/1)' });
  expect(checkSeatBudget(input({ config, seat: 'UX', running: [{ seat: 'UX' }, { seat: 'UX' }] })))
    .toEqual({ allowed: false, reason: 'UX concurrent Pods budget cannot be verified (0 confirmed, 2 unknown; limit 2)' });
  expect(checkSeatBudget(input({ config, seat: 'MK', ledger: Array.from({ length: 5 }, () => launched('MK', now.toISOString())), running: [{ seat: 'TC' }] })))
    .toEqual({ allowed: true });
  expect(checkSeatBudget(input({ config, running: [{ seat: 'TC' }, { seat: 'TC' }] }))).toEqual({ allowed: true });
  expect(checkSeatBudget(input({ config, running: [{ seat: 'TC', substrate: 'pod' }, { seat: 'TC' }, { seat: 'TC' }] })))
    .toEqual({ allowed: false, reason: 'TC concurrent Pods budget cannot be verified (1 confirmed, 2 unknown; limit 3)' });
  expect(checkSeatBudget(input({ running: [
    { seat: 'TC', substrate: 'local', status: 'running' },
    { seat: 'TC', substrate: 'pod', status: 'done' },
    { seat: 'UX', substrate: 'pod', status: 'running' },
  ] }))).toEqual({ allowed: true });
  expect(checkSeatBudget(input({ config: { org: { budget: { TC: { dailyGoals: 0 } } } } })))
    .toEqual({ allowed: false, reason: 'TC daily goals budget reached (0/0)' });
});

test('configured org.budget.<seat> survives config parsing for the default config reader', () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-budget-'));
  try {
    const file = join(root, 'config.json');
    writeFileSync(file, JSON.stringify({ org: { budget: { TC: { dailyGoals: 1, concurrentPods: 0 }, UX: { dailyGoals: 'invalid' }, EXTRA: { dailyGoals: 20 } } } }));
    const parsed = buildUserConfig(file);
    expect(parsed.org?.budget).toEqual({ TC: { dailyGoals: 1, concurrentPods: 0 }, UX: {}, EXTRA: { dailyGoals: 20 } });
    expect(checkSeatBudget(input({ config: parsed, running: [] })))
      .toEqual({ allowed: false, reason: 'TC concurrent Pods budget reached (0/0)' });
    expect(checkSeatBudget(input({ seat: 'EXTRA', config: parsed, ledger: Array.from({ length: 6 }, () => launched('EXTRA', now.toISOString())) })))
      .toEqual({ allowed: true });
    expect(checkSeatBudget(input({ seat: 'EXTRA', config: parsed, ledger: Array.from({ length: 20 }, () => launched('EXTRA', now.toISOString())) })))
      .toEqual({ allowed: false, reason: 'EXTRA daily goals budget reached (20/20)' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
