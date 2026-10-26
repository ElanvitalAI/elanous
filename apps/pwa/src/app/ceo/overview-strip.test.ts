import { expect, test } from 'bun:test';
import { OVERVIEW_STALE_MS, OVERVIEW_VERDICT_LABEL, parseOverviewStrip } from './overview-strip';

test('parseOverviewStrip maps closed verdict vocabulary and marks stale cache', () => {
  expect(parseOverviewStrip({
    verdict: 'supply-empty',
    reasons: ['빈 자리 2 · 발사 가능 칸 0'],
    cacheAgeMs: 900,
  })).toEqual({
    verdict: 'supply-empty',
    label: OVERVIEW_VERDICT_LABEL['supply-empty'],
    reason: '빈 자리 2 · 발사 가능 칸 0',
    stale: false,
  });
  expect(parseOverviewStrip({
    verdict: 'blocked',
    reasons: ['결정 대기'],
    cacheAgeMs: OVERVIEW_STALE_MS,
  })?.stale).toBe(true);
});

test('parseOverviewStrip rejects unknown or inherited verdict keys', () => {
  expect(parseOverviewStrip({ verdict: 'not-a-verdict', reasons: ['x'], cacheAgeMs: 0 })).toBeNull();
  expect(parseOverviewStrip({ verdict: 'constructor', reasons: ['x'], cacheAgeMs: 0 })).toBeNull();
  expect(parseOverviewStrip({ reasons: ['x'], cacheAgeMs: 0 })).toBeNull();
});
