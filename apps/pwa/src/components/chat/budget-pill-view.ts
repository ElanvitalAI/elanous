import type { BudgetStatusBody } from '@/lib/budget-status';

/** Same cadence as BudgetGuardWatcher. */
export const BUDGET_PILL_POLL_MS = 60_000;

export const BUDGET_PILL_UNREAD_LABEL = 'budget —';
export const BUDGET_PILL_UNREAD_TOOLTIP = '예산 상태를 읽지 못했습니다';

function formatMonthUsd(usd: number): string {
  const value = Number.isFinite(usd) ? usd : 0;
  return `$${value.toFixed(2)}`;
}

export function budgetPillLabel(body: BudgetStatusBody): string {
  const amount = `이번 달 ${formatMonthUsd(body.monthSoFarUsd)}`;
  if (body.percent == null || !Number.isFinite(body.percent)) return amount;
  return `${amount} · ${body.percent}%`;
}

export function budgetPillEmphasized(status: BudgetStatusBody['status']): boolean {
  return status === 'warning' || status === 'cap-exceeded';
}
