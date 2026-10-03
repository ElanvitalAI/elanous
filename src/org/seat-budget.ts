import { getUserConfig, type UserConfig } from '../user-config.js';
import type { SeatEntry } from '../seat-loop/seat-loop.js';

export const DEFAULT_DAILY_GOALS = 6;
export const DEFAULT_CONCURRENT_PODS = 2;

export type SeatBudgetResult = { allowed: true } | { allowed: false; reason: string };
export type RunningSeatPod = { seat: string; substrate?: string; status?: string };
export type SeatBudgetInput = {
  seat: string;
  now: Date;
  ledger: readonly SeatEntry[];
  running: readonly RunningSeatPod[];
  config?: Pick<UserConfig, 'org'>;
};

function limit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function day(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** A read-only seat quota judgment; the caller owns the launch and ledger write. */
export function checkSeatBudget({ seat, now, ledger, running, config }: SeatBudgetInput): SeatBudgetResult {
  const override = (config ?? getUserConfig()).org?.budget?.[seat];
  const dailyGoals = limit(override?.dailyGoals, DEFAULT_DAILY_GOALS);
  const concurrentPods = limit(override?.concurrentPods, DEFAULT_CONCURRENT_PODS);
  const today = day(now);
  const launchedToday = ledger.filter((entry) => entry.seat === seat && entry.status === 'launched'
    && Number.isFinite(Date.parse(entry.ts ?? entry.at))
    && day(new Date(entry.ts ?? entry.at)) === today).length;
  if (launchedToday >= dailyGoals) {
    return { allowed: false, reason: `${seat} daily goals budget reached (${launchedToday}/${dailyGoals})` };
  }
  const active = running.filter((run) => run.seat === seat && (run.status === undefined || run.status === 'running' || run.status === 'unknown'));
  // Confirmed = a Pod known to be running; an unknown substrate OR unknown liveness only counts as «cannot verify».
  const pods = active.filter((run) => run.substrate === 'pod' && run.status !== 'unknown').length;
  if (pods >= concurrentPods) {
    return { allowed: false, reason: `${seat} concurrent Pods budget reached (${pods}/${concurrentPods})` };
  }
  const unknown = active.filter((run) => run.substrate === undefined || run.status === 'unknown').length;
  if (pods + unknown >= concurrentPods) {
    return { allowed: false, reason: `${seat} concurrent Pods budget cannot be verified (${pods} confirmed, ${unknown} unknown; limit ${concurrentPods})` };
  }
  return { allowed: true };
}
