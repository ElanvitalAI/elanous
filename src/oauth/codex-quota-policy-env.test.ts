import { afterEach, expect, test } from 'bun:test';
import { resolveCodexQuotaPolicy } from './codex-quota-policy.js';

const saved = process.env.ELANOUS_CODEX_QUOTA_POLICY;
afterEach(() => { if (saved === undefined) delete process.env.ELANOUS_CODEX_QUOTA_POLICY; else process.env.ELANOUS_CODEX_QUOTA_POLICY = saved; });

test('ELANOUS_CODEX_QUOTA_POLICY (set by the Pod launcher) wins over a missing or different config', () => {
  process.env.ELANOUS_CODEX_QUOTA_POLICY = 'credits';
  expect(resolveCodexQuotaPolicy(undefined)).toEqual({ policy: 'credits', source: 'env' });
  expect(resolveCodexQuotaPolicy({ codexQuotaPolicy: 'within-quota' })).toEqual({ policy: 'credits', source: 'env' });
  process.env.ELANOUS_CODEX_QUOTA_POLICY = 'bogus';
  expect(resolveCodexQuotaPolicy(undefined)).toEqual({ policy: 'fallback', source: 'default' });
  delete process.env.ELANOUS_CODEX_QUOTA_POLICY;
  expect(resolveCodexQuotaPolicy({ codexQuotaPolicy: 'credits' })).toEqual({ policy: 'credits', source: 'config' });
});
