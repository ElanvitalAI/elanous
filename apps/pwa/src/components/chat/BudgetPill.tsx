'use client';

import { useEffect, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { fetchBudgetStatus, type BudgetStatusBody } from '@/lib/budget-status';
import type { DaemonHttpConfig } from '@/lib/model-tier-sync';
import {
  BUDGET_PILL_POLL_MS,
  BUDGET_PILL_UNREAD_LABEL,
  BUDGET_PILL_UNREAD_TOOLTIP,
  budgetPillEmphasized,
  budgetPillLabel,
} from './budget-pill-view';

export {
  BUDGET_PILL_POLL_MS,
  BUDGET_PILL_UNREAD_LABEL,
  BUDGET_PILL_UNREAD_TOOLTIP,
  budgetPillEmphasized,
  budgetPillLabel,
} from './budget-pill-view';

export interface BudgetPillProps {
  /** Test seam. Production omits this and calls fetchBudgetStatus. */
  loadStatus?: (cfg: DaemonHttpConfig) => Promise<BudgetStatusBody | null>;
  /** Test seam. 0 disables the interval (initial read still runs). */
  pollMs?: number;
  /** Already-read status. Lets a static render show the value before the poll lands. */
  initialStatus?: BudgetStatusBody | null;
}

export function BudgetPill(props: BudgetPillProps = {}) {
  const { loadStatus = fetchBudgetStatus, pollMs = BUDGET_PILL_POLL_MS, initialStatus } = props;
  const { config } = useDaemon();
  const [body, setBody] = useState<BudgetStatusBody | null | undefined>(
    initialStatus === undefined ? undefined : initialStatus,
  );

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      if (!config.baseUrl) {
        if (!cancelled) setBody(null);
        return;
      }
      const next = await loadStatus({
        baseUrl: config.baseUrl,
        ...(config.token ? { token: config.token } : {}),
      });
      if (!cancelled) setBody(next);
    };
    void tick();
    if (pollMs <= 0) return () => { cancelled = true; };
    const handle = setInterval(() => { void tick(); }, pollMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [config.baseUrl, config.token, loadStatus, pollMs]);

  if (body === undefined) return null;

  if (body === null) {
    return (
      <div
        className="rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground"
        title={BUDGET_PILL_UNREAD_TOOLTIP}
        data-elanous-pill="budget"
        data-budget-status="unread"
      >
        {BUDGET_PILL_UNREAD_LABEL}
      </div>
    );
  }

  const emphasized = budgetPillEmphasized(body.status);
  return (
    <div
      className={
        emphasized
          ? 'rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300'
          : 'rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground'
      }
      title={`${body.monthYYYYMM} · ${body.status}`}
      data-elanous-pill="budget"
      data-budget-status={body.status}
      data-budget-emphasis={emphasized ? 'true' : 'false'}
    >
      {budgetPillLabel(body)}
    </div>
  );
}
