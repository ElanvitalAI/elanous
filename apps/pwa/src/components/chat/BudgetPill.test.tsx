import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BudgetStatusBody } from '@/lib/budget-status';
import {
  BUDGET_PILL_POLL_MS,
  BUDGET_PILL_UNREAD_LABEL,
  BUDGET_PILL_UNREAD_TOOLTIP,
  budgetPillEmphasized,
  budgetPillLabel,
} from './budget-pill-view';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, 'BudgetPill.tsx'), 'utf8');

const okStatus: BudgetStatusBody = {
  status: 'ok',
  percent: 12,
  notifyAtPct: 80,
  monthSoFarUsd: 1.234,
  monthYYYYMM: '2026-09',
};

describe('BudgetPill', () => {
  test('fake status monthSoFarUsd 1.234 · percent 12 shows $1.23 and 12% with no TODO', () => {
    const label = budgetPillLabel(okStatus);
    expect(label).toContain('$1.23');
    expect(label).toContain('12%');
    expect(label).toBe('이번 달 $1.23 · 12%');
    expect(label).not.toContain('TODO');
    expect(SOURCE).not.toContain('TODO');
    expect(SOURCE).not.toContain('WT-L');
  });

  test('null shows budget — and the unread tooltip', () => {
    expect(BUDGET_PILL_UNREAD_LABEL).toBe('budget —');
    expect(BUDGET_PILL_UNREAD_TOOLTIP).toBe('예산 상태를 읽지 못했습니다');
    expect(SOURCE).toContain('BUDGET_PILL_UNREAD_LABEL');
    expect(SOURCE).toContain('BUDGET_PILL_UNREAD_TOOLTIP');
    expect(SOURCE).not.toContain('TODO');
  });

  test('warning and cap-exceeded are emphasized; percent is omitted when absent', () => {
    expect(budgetPillEmphasized('warning')).toBe(true);
    expect(budgetPillEmphasized('cap-exceeded')).toBe(true);
    expect(budgetPillEmphasized('ok')).toBe(false);
    expect(budgetPillLabel({ ...okStatus, percent: null })).toBe('이번 달 $1.23');
    expect(SOURCE).toContain('data-budget-emphasis');
  });

  test('mount calls fetchBudgetStatus and polls every 60s, same as BudgetGuardWatcher', () => {
    expect(BUDGET_PILL_POLL_MS).toBe(60_000);
    expect(SOURCE).toContain('fetchBudgetStatus');
    expect(SOURCE).toContain('setInterval');
    expect(SOURCE).toContain('BUDGET_PILL_POLL_MS');
    expect(SOURCE).toContain('useEffect');
  });
});
