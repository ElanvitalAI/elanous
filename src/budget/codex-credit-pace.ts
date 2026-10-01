import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { codexCredentialRoot } from './codex-reset-credit-state.js';
import type { LlmPolicy } from '../policy/llm-policy.js';

interface CreditDay {
  day: string;
  accounts: Record<string, { dayOpen: number; balance: number }>;
}

export type CreditBalances = Readonly<Record<string, number>>;

function kstDay(now: Date): string {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

function dayNumber(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / 86_400_000;
}

function creditDayPath(stateDir?: string): string {
  return join(stateDir ?? codexCredentialRoot(), 'budget', 'codex-credit-day.json');
}

function readCreditDay(stateDir?: string): CreditDay | undefined {
  try {
    const parsed = JSON.parse(readFileSync(creditDayPath(stateDir), 'utf8')) as CreditDay;
    return typeof parsed.day === 'string' && parsed.accounts && typeof parsed.accounts === 'object' && !Array.isArray(parsed.accounts)
      ? parsed : undefined;
  } catch { return undefined; }
}

/** Only a poller's observed balance can move the opening balance; readers never modify the ledger. */
export function recordCreditBalances(balances: CreditBalances, now: Date = new Date(), stateDir?: string): void {
  const day = kstDay(now);
  const previous = readCreditDay(stateDir);
  const accounts: CreditDay['accounts'] = previous?.day === day ? { ...previous.accounts } : {};
  for (const [name, balance] of Object.entries(balances)) {
    if (!Number.isFinite(balance) || balance < 0) continue;
    const prior = Object.prototype.hasOwnProperty.call(accounts, name) ? accounts[name] : undefined;
    const dayOpen = prior && Number.isFinite(prior.dayOpen) && Number.isFinite(prior.balance)
      ? (balance > prior.balance ? balance : prior.dayOpen)
      : balance;
    Object.defineProperty(accounts, name, { value: { dayOpen, balance }, enumerable: true, configurable: true, writable: true });
  }
  const path = creditDayPath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ day, accounts }, null, 2)}\n`);
  renameSync(temporary, path);
}

export function creditPaceStatus({ policy, balances, now = new Date(), stateDir }: {
  policy: LlmPolicy;
  balances: CreditBalances;
  now?: Date;
  stateDir?: string;
}): { active: boolean; todaySpent: number; target: number; remaining: number; daysLeft: number; projectedAtUntil: number } {
  const day = kstDay(now);
  const ledger = readCreditDay(stateDir);
  const observed = Object.entries(balances).filter(([, balance]) => Number.isFinite(balance) && balance >= 0);
  const todaySpent = ledger?.day === day ? observed.reduce((sum, [name, balance]) => {
    const open = Object.prototype.hasOwnProperty.call(ledger.accounts, name) ? ledger.accounts[name]?.dayOpen : undefined;
    return sum + (typeof open === 'number' && Number.isFinite(open) ? Math.max(0, open - balance) : 0);
  }, 0) : 0;
  const remaining = observed.reduce((sum, [, balance]) => sum + balance, 0);
  const until = policy.credits.pace?.until;
  const expiry = until ? Date.parse(`${until}T15:00:00Z`) : NaN;
  const daysLeft = until ? Math.max(1, dayNumber(until) - dayNumber(day) + 1) : 1;
  // The poller's opening observation anchors today's allocation. Spending cannot lower it;
  // a new grant or the next KST day changes the opening observation.
  const startingBalance = ledger?.day === day
    ? observed.reduce((sum, [name, balance]) => {
      const entry = Object.prototype.hasOwnProperty.call(ledger.accounts, name) ? ledger.accounts[name] : undefined;
      return sum + (entry && Number.isFinite(entry.dayOpen) ? entry.dayOpen : balance);
    }, 0)
    : remaining;
  const target = until ? Math.ceil(startingBalance / daysLeft) : 0;
  return {
    active: policy.credits.codex === 'use' && !!until && now.getTime() < expiry && remaining > 0 && todaySpent < target,
    todaySpent, target, remaining, daysLeft,
    projectedAtUntil: Math.max(0, remaining - Math.max(0, target - todaySpent) - target * (daysLeft - 1)),
  };
}
