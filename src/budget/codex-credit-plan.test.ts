import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCreditHistory, codexCreditPlan, creditHistoryPath, creditSpend, formatCodexCreditPlan, readCreditHistory, type CreditHistoryEntry } from './codex-credit-plan.js';
import { quotaSignalDir, writeQuotaSignal } from './codex-reset-credit-state.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-01T12:00:00Z');
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe('credit history ledger', () => {
  test('appends only when a home balance changes and prunes entries older than 30 days', () => {
    const dir = mkdtempSync(join(tmpdir(), 'credit-history-'));
    try {
      writeFileSync(creditHistoryPath(dir), `${JSON.stringify({ at: at(40 * DAY), home: '/h/a', balance: 9000 })}\n`);
      appendCreditHistory(dir, '/h/a', 5000, NOW - DAY);
      appendCreditHistory(dir, '/h/a', 5000, NOW - DAY / 2);
      appendCreditHistory(dir, '/h/b', 5000, NOW - DAY / 2);
      appendCreditHistory(dir, '/h/a', 4200, NOW);
      const rows = readCreditHistory(dir);
      expect(rows.map((r) => [r.home, r.balance])).toEqual([['/h/a', 5000], ['/h/b', 5000], ['/h/a', 4200]]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('writeQuotaSignal records a measured balance in the ledger next to the signal', () => {
    const root = mkdtempSync(join(tmpdir(), 'credit-signal-'));
    try {
      writeQuotaSignal(undefined, 40, '/h/acct', { root }, { balance: 1234, hasCredits: true });
      writeQuotaSignal(undefined, 41, '/h/acct', { root }, { balance: 1234, hasCredits: true });
      writeQuotaSignal(undefined, 42, '/h/acct', { root });
      const rows = readCreditHistory(quotaSignalDir(root));
      expect(rows.map((r) => r.balance)).toEqual([1234]);
      expect(readFileSync(creditHistoryPath(quotaSignalDir(root)), 'utf8').trim().split('\n')).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('creditSpend', () => {
  test('sums drops inside 7 days from the baseline before the window; top-ups are not spend', () => {
    const history: CreditHistoryEntry[] = [
      { at: at(10 * DAY), home: 'a', balance: 10_000 },
      { at: at(5 * DAY), home: 'a', balance: 9_000 },
      { at: at(4 * DAY), home: 'a', balance: 12_000 },
      { at: at(1 * DAY), home: 'a', balance: 11_000 },
      { at: at(3 * DAY), home: 'b', balance: 500 },
      { at: at(2 * DAY), home: 'b', balance: 200 },
    ];
    const spend = creditSpend(history, NOW)!;
    expect(spend.spent).toBe(1_000 + 1_000 + 300);
    expect(spend.spanDays).toBeCloseTo(7, 5);
  });

  test('no history and a single point both mean «unknown», not zero', () => {
    expect(creditSpend([], NOW)).toBeNull();
    expect(creditSpend([{ at: at(DAY), home: 'a', balance: 5 }], NOW)).toBeNull();
  });
});

describe('codexCreditPlan', () => {
  const credits = {
    codex: 'use',
    grants: [{ account: 'team', amount: 50_000, expires: '2026-12-31', source: 'grant' }],
    pace: { targetPerDay: 600, until: '2026-12-31', why: '12월 말까지 크레딧 소진이 목표' },
  };

  test('reads expiry, target and note from the policy and computes days left and daily need', () => {
    const plan = codexCreditPlan({
      now: NOW,
      balances: [{ name: 'team', balance: 30_000 }, { name: 'third', balance: 15_000 }, { name: 'default' }],
      credits,
      history: [{ at: at(2 * DAY), home: 'h', balance: 46_000 }, { at: at(0), home: 'h', balance: 45_000 }],
    });
    expect(plan.expiresAt).toBe('2026-12-31');
    expect(plan.daysLeft).toBe(92);
    expect(plan.totalBalance).toBe(45_000);
    expect(plan.unknownBalances).toBe(1);
    expect(plan.dailyNeeded).toBeCloseTo(45_000 / 92, 5);
    expect(plan.targetPerDay).toBe(600);
    expect(plan.actualPerDay).toBeCloseTo(500, 5);
    expect(plan.actualSpanDays).toBe(2);
    expect(plan.note).toBe('12월 말까지 크레딧 소진이 목표');
    expect(plan.accounts).toEqual([
      { name: 'team', balance: 30_000, expires: '2026-12-31' },
      { name: 'third', balance: 15_000, expires: null },
      { name: 'default', balance: null, expires: null },
    ]);
    const lines = formatCodexCreditPlan(plan);
    expect(lines[0]).toContain('잔액 합 45000 (+1개 계정 모름) · 만료 2026-12-31');
    expect(lines[0]).toContain('team 30000(~2026-12-31)');
    expect(lines[1]).toBe('계산      만료까지 92일 · 하루 소진 필요 489 (목표 600) · 최근 7일 실제 500/일 (기록 2일)');
    expect(lines[2]).toBe('메모      12월 말까지 크레딧 소진이 목표');
  });

  test('a policy without pace or grants says the expiry is unknown and where to set it', () => {
    const plan = codexCreditPlan({ now: NOW, balances: [{ name: 'team', balance: 100 }], credits: { codex: 'use', grants: [] }, history: [] });
    expect(plan.expiresAt).toBeNull();
    expect(plan.daysLeft).toBeNull();
    expect(plan.dailyNeeded).toBeNull();
    expect(plan.actualPerDay).toBeNull();
    const lines = formatCodexCreditPlan(plan);
    expect(lines[0]).toContain('만료 모름 (policy credits.pace.until · credits.grants)');
    expect(lines[1]).toBe('계산      만료일 모름 · 하루 소진 필요 ? · 최근 7일 실제 기록 없음');
    expect(lines).toHaveLength(2);
  });
});
