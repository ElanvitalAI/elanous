/** Isolated calculation for the autowake daily budget; caller owns file and ledger access. */
export interface SeatUsageBucket {
  day: string;
  seat: string;
  role: string;
  site: string;
  inputTokens: number;
  outputTokens: number;
}

export function readSeatBudgetUsage(input: {
  seat: string;
  budgetText: string | null;
  now: Date;
  roles?: readonly string[];
  sites?: readonly string[];
  readUsage: (sinceDay: string) => readonly SeatUsageBucket[] | null;
}): { budget: number | null; used: number | null } {
  const raw = input.budgetText?.trim() ?? '';
  const budget = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(budget) || budget <= 0) return { budget: null, used: null };
  try {
    const today = input.now.toISOString().slice(0, 10);
    const rows = input.readUsage(today);
    if (rows === null) return { budget, used: null };
    let used = 0;
    for (const row of rows) {
      if (row.day !== today || (input.roles && !input.roles.includes(row.role)) || (input.sites && !input.sites.includes(row.site))) continue;
      if (!row.seat || row.seat === '(none)') return { budget, used: null };
      if (row.seat !== input.seat) continue;
      if (![row.inputTokens, row.outputTokens].every(n => Number.isSafeInteger(n) && n >= 0)) return { budget, used: null };
      used += row.inputTokens + row.outputTokens;
      if (!Number.isSafeInteger(used)) return { budget, used: null };
    }
    return { budget, used };
  } catch {
    return { budget, used: null };
  }
}
