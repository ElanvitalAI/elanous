// Codex prepaid-credit plan: days left until the credits expire, the daily spend that would use the balance up,
// and what was actually spent over the last 7 days. Disk only — the balance history is appended by
// writeQuotaSignal whenever a measured balance changes; nothing here touches the network.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DAY_MS = 86_400_000;
const HISTORY_KEEP_MS = 30 * DAY_MS;
const HISTORY_FILE = 'codex-credit-history.jsonl';

export interface CreditHistoryEntry { at: string; home: string; balance: number }

export function creditHistoryPath(signalDir: string): string {
  return join(signalDir, HISTORY_FILE);
}

export function readCreditHistory(signalDir: string): CreditHistoryEntry[] {
  try {
    const path = creditHistoryPath(signalDir);
    if (!existsSync(path)) return [];
    const out: CreditHistoryEntry[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Partial<CreditHistoryEntry>;
        if (typeof e.at === 'string' && typeof e.home === 'string' && typeof e.balance === 'number' && Number.isFinite(e.balance)) out.push(e as CreditHistoryEntry);
      } catch { /* a torn line is skipped */ }
    }
    return out;
  } catch { return []; }
}

/** Appends only when this home's balance changed; prunes entries older than 30 days. Fail-soft. */
export function appendCreditHistory(signalDir: string, home: string, balance: number, now: number = Date.now()): void {
  try {
    if (!Number.isFinite(balance)) return;
    const history = readCreditHistory(signalDir);
    const last = [...history].reverse().find((e) => e.home === home);
    if (last && last.balance === balance) return;
    mkdirSync(signalDir, { recursive: true });
    const entry: CreditHistoryEntry = { at: new Date(now).toISOString(), home, balance };
    const kept = history.filter((e) => now - Date.parse(e.at) <= HISTORY_KEEP_MS);
    if (kept.length !== history.length) {
      writeFileSync(creditHistoryPath(signalDir), [...kept, entry].map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    } else {
      appendFileSync(creditHistoryPath(signalDir), `${JSON.stringify(entry)}\n`, 'utf8');
    }
  } catch { /* observation never blocks the fetch */ }
}

/** Credits spent in the window: sum of balance drops per home (rises are top-ups and are not spend). */
export function creditSpend(history: readonly CreditHistoryEntry[], now: number, windowMs = 7 * DAY_MS): { spent: number; spanDays: number } | null {
  const since = now - windowMs;
  let spent = 0;
  let earliest = Infinity;
  const byHome = new Map<string, CreditHistoryEntry[]>();
  for (const e of history) {
    const at = Date.parse(e.at);
    if (!Number.isFinite(at) || at > now) continue;
    byHome.set(e.home, [...(byHome.get(e.home) ?? []), e]);
  }
  for (const entries of byHome.values()) {
    entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    // The last entry before the window is the baseline for the first change inside it.
    let start = entries.findIndex((e) => Date.parse(e.at) >= since);
    if (start === -1) continue;
    if (start > 0) start -= 1;
    const used = entries.slice(start);
    if (used.length < 2) continue;
    earliest = Math.min(earliest, Math.max(since, Date.parse(used[0]!.at)));
    for (let i = 1; i < used.length; i++) {
      const drop = used[i - 1]!.balance - used[i]!.balance;
      if (drop > 0) spent += drop;
    }
  }
  if (!Number.isFinite(earliest)) return null;
  return { spent, spanDays: Math.max((now - earliest) / DAY_MS, 1 / 24) };
}

export interface CodexCreditPlan {
  /** policy credits.pace.until, else the earliest grant expiry; null when the policy records neither. */
  expiresAt: string | null;
  daysLeft: number | null;
  /** Sum of the known per-account balances; null when no balance is known. */
  totalBalance: number | null;
  unknownBalances: number;
  accounts: Array<{ name: string; balance: number | null; expires: string | null }>;
  /** Credits per day that would use the balance up by the expiry date. */
  dailyNeeded: number | null;
  /** policy credits.pace.targetPerDay — the declared pace, shown beside the computed one. */
  targetPerDay: number | null;
  /** Credits actually spent per day over the last 7 days (or the shorter recorded span). */
  actualPerDay: number | null;
  actualSpanDays: number | null;
  /** policy credits.pace.why */
  note: string | null;
}

export interface CreditPolicyView {
  codex: string;
  grants: ReadonlyArray<{ account: string; amount: number; expires: string }>;
  pace?: { targetPerDay: number; until: string; why?: string };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function codexCreditPlan(input: {
  now: number;
  balances: ReadonlyArray<{ name: string; balance?: number }>;
  credits: CreditPolicyView;
  history: readonly CreditHistoryEntry[];
}): CodexCreditPlan {
  const { credits } = input;
  const accounts = input.balances.map((a) => {
    const grantDates = credits.grants.filter((g) => g.account === a.name && DATE.test(g.expires)).map((g) => g.expires).sort();
    return { name: a.name, balance: typeof a.balance === 'number' && Number.isFinite(a.balance) ? a.balance : null, expires: grantDates[0] ?? null };
  });
  const known = accounts.map((a) => a.balance).filter((b): b is number => b !== null);
  const totalBalance = known.length ? known.reduce((x, y) => x + y, 0) : null;
  const earliestGrant = credits.grants.map((g) => g.expires).filter((d) => DATE.test(d)).sort()[0];
  const expiresAt = credits.pace?.until && DATE.test(credits.pace.until) ? credits.pace.until : earliestGrant ?? null;
  const expiry = expiresAt ? Date.parse(`${expiresAt}T23:59:59+09:00`) : NaN;
  const daysLeft = Number.isFinite(expiry) ? Math.max(0, Math.ceil((expiry - input.now) / DAY_MS)) : null;
  const spend = creditSpend(input.history, input.now);
  return {
    expiresAt,
    daysLeft,
    totalBalance,
    unknownBalances: accounts.length - known.length,
    accounts,
    dailyNeeded: daysLeft && totalBalance !== null ? totalBalance / daysLeft : null,
    targetPerDay: credits.pace?.targetPerDay ?? null,
    actualPerDay: spend ? spend.spent / Math.min(7, spend.spanDays) : null,
    actualSpanDays: spend ? Math.round(Math.min(7, spend.spanDays) * 10) / 10 : null,
    note: credits.pace?.why?.trim() || null,
  };
}

/** The lines both surfaces print under the policy line. */
export function formatCodexCreditPlan(plan: CodexCreditPlan): string[] {
  const n = (v: number) => String(Math.round(v));
  const unknown = plan.unknownBalances ? ` (+${plan.unknownBalances}개 계정 모름)` : '';
  const perAccount = plan.accounts.map((a) => `${a.name} ${a.balance === null ? '?' : n(a.balance)}${a.expires ? `(~${a.expires})` : ''}`).join(' · ');
  const lines = [
    `크레딧    잔액 합 ${plan.totalBalance === null ? '?' : n(plan.totalBalance)}${unknown} · 만료 ${plan.expiresAt ?? '모름 (policy credits.pace.until · credits.grants)'}${perAccount ? ` · ${perAccount}` : ''}`,
  ];
  const days = plan.daysLeft === null ? '만료일 모름' : `만료까지 ${plan.daysLeft}일`;
  const needed = plan.dailyNeeded === null ? '?' : n(plan.dailyNeeded);
  const target = plan.targetPerDay === null ? '' : ` (목표 ${n(plan.targetPerDay)})`;
  const actual = plan.actualPerDay === null ? '기록 없음' : `${n(plan.actualPerDay)}/일${plan.actualSpanDays !== null && plan.actualSpanDays < 7 ? ` (기록 ${plan.actualSpanDays}일)` : ''}`;
  lines.push(`계산      ${days} · 하루 소진 필요 ${needed}${target} · 최근 7일 실제 ${actual}`);
  if (plan.note) lines.push(`메모      ${plan.note}`);
  return lines;
}
