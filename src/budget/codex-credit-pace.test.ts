import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { creditPaceStatus, recordCreditBalances } from './codex-credit-pace.js';
import { defaultLlmPolicy } from '../policy/llm-policy.js';

const roots: string[] = [];
function isolatedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'codex-credit-day-'));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('daily target remains fixed while spending, and rises only on a new grant', () => {
  const root = isolatedRoot();
  const policy = defaultLlmPolicy();
  policy.credits.codex = 'use';
  policy.credits.pace = { targetPerDay: 1, until: '2026-10-01' };
  const now = new Date('2026-09-30T14:50:00Z');
  const status = (balance: number) => creditPaceStatus({ policy, balances: { team: balance }, now, stateDir: root });
  recordCreditBalances({ team: 100 }, now, root);
  expect(status(100)).toMatchObject({ target: 50, todaySpent: 0, active: true });
  recordCreditBalances({ team: 60 }, now, root);
  expect(status(60)).toMatchObject({ target: 50, todaySpent: 40, remaining: 60, active: true });
  recordCreditBalances({ team: 50 }, now, root);
  expect(status(50)).toMatchObject({ target: 50, todaySpent: 50, active: false });
  expect(status(150)).toMatchObject({ target: 50, todaySpent: 0, active: true });
  recordCreditBalances({ team: 150 }, now, root);
  expect(status(150)).toMatchObject({ target: 75, todaySpent: 0, active: true });
  recordCreditBalances({ team: 110 }, now, root);
  expect(status(110)).toMatchObject({ target: 75, todaySpent: 40, active: true });
});

test('KST day rollover, grant, daily target and policy guard', () => {
  const root = isolatedRoot();
  const policy = defaultLlmPolicy();
  policy.credits.codex = 'use';
  policy.credits.pace = { targetPerDay: 1, until: '2026-10-03' };
  const at = (iso: string, balances: Record<string, number>) => creditPaceStatus({ policy, balances, now: new Date(iso), stateDir: root });
  recordCreditBalances({ team: 100, third: 20 }, new Date('2026-09-30T14:50:00Z'), root);
  expect(at('2026-09-30T14:55:00Z', { team: 90, third: 20 })).toMatchObject({ active: true, todaySpent: 10, remaining: 110, daysLeft: 4, target: 30, projectedAtUntil: 0 });
  recordCreditBalances({ team: 90, third: 20 }, new Date('2026-09-30T14:55:00Z'), root);
  recordCreditBalances({ team: 150, third: 20 }, new Date('2026-09-30T14:56:00Z'), root);
  expect(at('2026-09-30T14:56:00Z', { team: 150, third: 20 }).todaySpent).toBe(0);
  expect(JSON.parse(readFileSync(join(root, 'budget/codex-credit-day.json'), 'utf8')).accounts.team.dayOpen).toBe(150);
  recordCreditBalances({ team: 140, third: 20 }, new Date('2026-09-30T14:57:00Z'), root);
  expect(at('2026-09-30T14:57:00Z', { team: 140, third: 20 }).todaySpent).toBe(10);
  expect(at('2026-09-30T14:57:00Z', { team: 0, third: 20 }).todaySpent).toBe(150);
  recordCreditBalances({ team: 140, third: 20 }, new Date('2026-09-30T15:01:00Z'), root);
  expect(at('2026-09-30T15:01:00Z', { team: 140, third: 20 })).toMatchObject({ todaySpent: 0, target: 54, daysLeft: 3 });
  policy.credits.codex = 'never';
  expect(at('2026-09-30T15:01:00Z', { team: 140 }).active).toBe(false);
  policy.credits.codex = 'fallback';
  expect(at('2026-09-30T15:01:00Z', { team: 140 }).active).toBe(false);
  policy.credits.codex = 'use';
  expect(at('2026-10-03T15:00:00Z', { team: 140 }).active).toBe(false);
  delete policy.credits.pace;
  expect(at('2026-09-30T15:01:00Z', { team: 140 }).active).toBe(false);
});
