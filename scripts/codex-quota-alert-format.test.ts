import { describe, expect, test } from 'bun:test';
import { creditsSummary, formatCreditsSummary } from './codex-quota-alert-format.js';

const accounts = [
  { name: 'default', balance: 19_787, perHour: -5_234, resetInHours: 158 },
  { name: 'team', balance: 29_998, perHour: -1.8, resetInHours: 138 },
  { name: 'third', balance: 25_000, resetInHours: 151 },
];

describe('combined codex credits', () => {
  test('three accounts sum balance and measured speed, excluding unknown speed', () => {
    const summary = creditsSummary(accounts);
    expect(summary.totalBalance).toBe(74_785);
    expect(summary.unknownBalanceCount).toBe(0);
    expect(summary.totalPerHour).toBeCloseTo(-5_235.8);
    expect(summary.unknownSpeedCount).toBe(1);
    expect(summary.etaHours).toBeCloseTo(74_785 / 5_235.8);
    expect(summary.earliestResetHours).toBe(138);
    expect(summary.beforeReset).toBe(true);
    expect(formatCreditsSummary(summary)).toContain('속도 모름 1개');
    expect(formatCreditsSummary(summary)).toContain('합계');
    expect(formatCreditsSummary(summary)).toContain('시간당 −5,235.8');
  });

  test('without a measured drain, ETA and beforeReset remain unknown', () => {
    const summary = creditsSummary([{ name: 'only', balance: 100, resetInHours: 10 }]);
    expect(summary.totalPerHour).toBeNull();
    expect(summary.etaHours).toBeNull();
    expect(summary.beforeReset).toBeNull();
    expect(formatCreditsSummary(summary)).toContain('시간당 미상 · 속도 모름 1개 · 고갈 시각 미상');
    expect(formatCreditsSummary(summary)).not.toContain('시간당 0');
  });

  test('unknown balance reports only the known subtotal, not a whole-account ETA', () => {
    const summary = creditsSummary([
      { name: 'known', balance: 100, perHour: -10, resetInHours: 20 },
      { name: 'unreadable', perHour: -2, resetInHours: 30 },
    ]);
    expect(summary.totalBalance).toBe(100);
    expect(summary.unknownBalanceCount).toBe(1);
    expect(summary.etaHours).toBeNull();
    expect(summary.beforeReset).toBeNull();
    expect(formatCreditsSummary(summary)).toContain('확인된 계정 합계 100 · 잔액 모름 1개');
    expect(formatCreditsSummary(summary)).not.toContain('크레딧 합계 100');
  });

  test('unknown reset does not certify earliest reset or beforeReset', () => {
    const summary = creditsSummary([
      { name: 'known', balance: 100, perHour: -10, resetInHours: 20 },
      { name: 'unknown-reset', balance: 50, perHour: -5 },
    ]);
    expect(summary.etaHours).toBe(10);
    expect(summary.earliestResetHours).toBeNull();
    expect(summary.beforeReset).toBeNull();
    expect(formatCreditsSummary(summary)).toContain('가장 이른 리셋 시각 미상');
    expect(formatCreditsSummary(summary)).not.toContain('가장 이른 리셋(20시간)');
  });

  test('reset first is not an early exhaustion', () => {
    const summary = creditsSummary([{ name: 'only', balance: 100, perHour: -1, resetInHours: 10 }]);
    expect(summary.beforeReset).toBe(false);
  });
});
