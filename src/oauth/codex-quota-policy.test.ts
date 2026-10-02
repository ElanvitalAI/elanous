import { describe, expect, test } from 'bun:test';
import { codexPolicyAllowsCredits, codexPolicyAllowsFallback, describeLaunchQuotaPolicy, resolveCodexQuotaPolicy } from './codex-quota-policy.js';

test('새 키가 이기고, 없으면 옛 codexCreditsAllowed, 그것도 없으면 fallback', () => {
  expect(resolveCodexQuotaPolicy({ codexQuotaPolicy: 'within-quota', codexCreditsAllowed: true })).toEqual({ policy: 'within-quota', source: 'config' });
  expect(resolveCodexQuotaPolicy({ codexCreditsAllowed: true })).toEqual({ policy: 'credits', source: 'legacy-credits' });
  expect(resolveCodexQuotaPolicy({})).toEqual({ policy: 'fallback', source: 'default' });
  expect(resolveCodexQuotaPolicy(undefined)).toEqual({ policy: 'fallback', source: 'default' });
  // 모르는 값은 크레딧을 켜지 않는다(돈이라 fail-closed)
  expect(resolveCodexQuotaPolicy({ codexQuotaPolicy: 'credit' })).toEqual({ policy: 'fallback', source: 'invalid' });
});

test('정책 셋의 크레딧·폴백 허가 표', () => {
  expect([codexPolicyAllowsCredits('within-quota'), codexPolicyAllowsFallback('within-quota')]).toEqual([false, false]);
  expect([codexPolicyAllowsCredits('fallback'), codexPolicyAllowsFallback('fallback')]).toEqual([false, true]);
  expect([codexPolicyAllowsCredits('credits'), codexPolicyAllowsFallback('credits')]).toEqual([true, true]);
});

describe('POL1 — launch line', () => {
  test('a test universe that disagrees with production gets a loud warning naming the fix', () => {
    const d = describeLaunchQuotaPolicy({ current: { policy: 'fallback', source: 'default' }, universe: { kind: 'test', root: '/tree/.elanous-test' }, production: { policy: 'credits', source: 'config' } });
    expect(d.line).toContain('codex 한도 정책 = fallback');
    expect(d.line).toContain('출처 default');
    expect(d.line).toContain('우주 test /tree/.elanous-test');
    expect(d.warning).toContain('운영(credits)');
    expect(d.warning).toContain('config sync-test');
  });
  test('agreeing universes and production itself get the line only', () => {
    expect(describeLaunchQuotaPolicy({ current: { policy: 'credits', source: 'config' }, universe: { kind: 'test', root: '/t' }, production: { policy: 'credits', source: 'config' } }).warning).toBeUndefined();
    expect(describeLaunchQuotaPolicy({ current: { policy: 'credits', source: 'config' }, universe: { kind: 'prod', root: '/p' } }).warning).toBeUndefined();
  });
});

