import { expect, test } from 'bun:test';
import { readSeatBudgetUsage } from './seat-autowake-budget.js';

test('no valid budget means no ledger read', () => {
  for (const budget of [null, '', '0', '-1', '1.5', '1x']) {
    let reads = 0;
    const result = readSeatBudgetUsage({ seat: 'TC', budgetText: budget, now: new Date('2026-11-18T23:59:00Z'), readUsage: () => { reads++; return null; } });
    expect(result).toEqual({ budget: null, used: null });
    expect(reads).toBe(0);
  }
});

test('uses UTC today and counts only the requested seat, roles and sites', () => {
  const calls: string[] = [];
  const result = readSeatBudgetUsage({ seat: 'TC', budgetText: '100', now: new Date('2026-11-18T23:59:00Z'), roles: ['agent'], sites: ['agent-turn'], readUsage: day => {
    calls.push(day);
    return [
      { day: '2026-11-18', seat: 'TC', role: 'agent', site: 'agent-turn', inputTokens: 20, outputTokens: 5 },
      { day: '2026-11-18', seat: 'OP', role: 'agent', site: 'agent-turn', inputTokens: 500, outputTokens: 0 },
      { day: '2026-11-18', seat: 'TC', role: 'other', site: 'agent-turn', inputTokens: 90, outputTokens: 0 },
      { day: '2026-11-17', seat: 'TC', role: 'agent', site: 'agent-turn', inputTokens: 80, outputTokens: 0 },
    ];
  } });
  expect(calls).toEqual(['2026-11-18']);
  // 출처: #38013 분리 요구 · 위 독립 픽스처 예산 100, TC 입력 20 + 출력 5.
  expect(result).toEqual({ budget: 100, used: 25 });
});

test('unattributed relevant usage and read errors are unknown, never zero', () => {
  const base = { seat: 'TC', budgetText: '100', now: new Date('2026-11-18T00:00:00Z') };
  // 출처: #38013 분리 요구 · 바로 위 픽스처 예산 100, 미귀속 원장 행.
  expect(readSeatBudgetUsage({ ...base, readUsage: () => [{ day: '2026-11-18', seat: '(none)', role: 'agent', site: 'agent-turn', inputTokens: 3, outputTokens: 1 }] })).toEqual({ budget: 100, used: null });
  // 출처: #38013 분리 요구 · 바로 위 픽스처 예산 100, 읽기 실패.
  expect(readSeatBudgetUsage({ ...base, readUsage: () => { throw new Error('unavailable'); } })).toEqual({ budget: 100, used: null });
});

test('site filter excludes rows whose only mismatch is site', () => {
  const result = readSeatBudgetUsage({ seat: 'TC', budgetText: '100', now: new Date('2026-11-18T12:00:00Z'), roles: ['agent'], sites: ['agent-turn'], readUsage: () => [
    { day: '2026-11-18', seat: 'TC', role: 'agent', site: 'agent-turn', inputTokens: 7, outputTokens: 3 },
    { day: '2026-11-18', seat: 'TC', role: 'agent', site: 'other-site', inputTokens: 400, outputTokens: 50 },
  ] });
  // 출처: #39241 site 만 다른 행 회귀 · 위 독립 픽스처 예산 100, site 일치 행 입력 7 + 출력 3.
  expect(result).toEqual({ budget: 100, used: 10 });
});
