import { expect, test } from 'bun:test';
import { codexPolicyAllowsCredits, codexPolicyAllowsFallback, resolveCodexQuotaPolicy } from './codex-quota-policy.js';

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
