import { describe, expect, test } from 'bun:test';
import { legacyPullPolicy, recentDeclaredPr } from './index.js';

const now = Date.parse('2026-11-28T06:00:00Z');
const policy = { ...legacyPullPolicy(), writerLeaseMin: 30, progress: ['pr-update'] as const };
const pr = (body: string, ageMin = 0) => ({ body, updatedAt: new Date(now - ageMin * 60_000).toISOString() });

describe('recent open PR cell declaration', () => {
  test('protects an explicitly declared cell through the lease boundary', () => {
    expect(recentDeclaredPr('CELL-A', [pr('칸: `CELL-A`', 30)], now, policy)).toBe(true);
    expect(recentDeclaredPr('CELL-A', [pr('칸: CELL-A', 31)], now, policy)).toBe(false);
  });
  test('does not confuse mentions or other cell identifiers with declarations', () => {
    expect(recentDeclaredPr('CELL-A', [pr('See CELL-A'), pr('칸: CELL-A-OTHER')], now, policy)).toBe(false);
    expect(recentDeclaredPr('CELL-A', [pr('칸: cell-a')], now, policy)).toBe(true);
  });
  test('rejects invalid or future dates and respects the policy signal', () => {
    expect(recentDeclaredPr('CELL-A', [{ body: '칸: CELL-A', updatedAt: 'bad' }, pr('칸: CELL-A', -1)], now, policy)).toBe(false);
    expect(recentDeclaredPr('CELL-A', [pr('칸: CELL-A')], now, legacyPullPolicy())).toBe(false);
  });
});
