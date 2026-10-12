import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { _setRotationConfigReaderForTesting, codexQuotaPolicyFromConfig } from './codex-account-store.js';
import { codexPolicyAllowsCredits, codexPolicyAllowsFallback, describeLaunchQuotaPolicy, resolveCodexQuotaPolicy } from './codex-quota-policy.js';

test('새 키가 이기고, 없으면 옛 codexCreditsAllowed, 그것도 없으면 fallback', () => {
  expect(resolveCodexQuotaPolicy({ codexQuotaPolicy: 'within-quota', codexCreditsAllowed: true })).toEqual({ policy: 'within-quota', source: 'config' });
  expect(resolveCodexQuotaPolicy({ codexCreditsAllowed: true })).toEqual({ policy: 'credits', source: 'legacy-credits' });
  expect(resolveCodexQuotaPolicy({})).toEqual({ policy: 'fallback', source: 'default' });
  expect(resolveCodexQuotaPolicy(undefined)).toEqual({ policy: 'fallback', source: 'default' });
  // 모르는 값은 크레딧을 켜지 않는다(돈이라 fail-closed)
  expect(resolveCodexQuotaPolicy({ codexQuotaPolicy: 'credit' })).toEqual({ policy: 'fallback', source: 'invalid' });
});

describe('policy/llm.yaml credits.codex — 읽기 호환 ⊕ 관측', () => {
  const saved = process.env.ELANOUS_CODEX_QUOTA_POLICY;
  let logs: Array<{ event: string; data: unknown }>;
  let spy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    delete process.env.ELANOUS_CODEX_QUOTA_POLICY;
    logs = [];
    spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
      if (category === 'codex.policy') logs.push({ event, data });
    }) as never);
  });
  afterEach(() => {
    spy.mockRestore();
    if (saved === undefined) delete process.env.ELANOUS_CODEX_QUOTA_POLICY; else process.env.ELANOUS_CODEX_QUOTA_POLICY = saved;
  });

  test('① 파일 never 가 옛 키 credits 를 이기고 legacy-key-shadowed 한 건을 남긴다', () => {
    expect(resolveCodexQuotaPolicy({ codexQuotaPolicy: 'credits' }, 'never')).toEqual({ policy: 'within-quota', source: 'policy-file' });
    expect(logs).toEqual([{ event: 'legacy-key-shadowed', data: { key: 'llm.codexQuotaPolicy', legacy: 'credits', file: 'never' } }]);
  });

  test('② 파일이 없으면 옛 키 credits 가 그대로 적용되고 legacy-key-applied 한 건을 남긴다', () => {
    expect(resolveCodexQuotaPolicy({ codexQuotaPolicy: 'credits' })).toEqual({ policy: 'credits', source: 'config' });
    expect(logs).toEqual([{ event: 'legacy-key-applied', data: { key: 'llm.codexQuotaPolicy', value: 'credits' } }]);
  });

  test('③ 파일도 옛 키도 없으면 fallback · default 이고 관측은 없다', () => {
    expect(resolveCodexQuotaPolicy({})).toEqual({ policy: 'fallback', source: 'default' });
    expect(logs).toEqual([]);
  });

  test('④ 파일이 깨졌으면 옛 키가 credits 라도 fallback 으로 닫는다', () => {
    expect(resolveCodexQuotaPolicy({ codexQuotaPolicy: 'credits', codexCreditsAllowed: true }, 'unreadable').policy).toBe('fallback');
    expect(logs).toEqual([]);
  });

  test('⑤ env 가 파일보다 이긴다', () => {
    process.env.ELANOUS_CODEX_QUOTA_POLICY = 'credits';
    expect(resolveCodexQuotaPolicy(undefined, 'never')).toEqual({ policy: 'credits', source: 'env' });
  });

  test('파일 값 짝 use→credits · fallback→fallback · 옛 키와 같으면 shadowed 를 안 남긴다', () => {
    expect(resolveCodexQuotaPolicy(undefined, 'use').policy).toBe('credits');
    expect(resolveCodexQuotaPolicy(undefined, 'fallback').policy).toBe('fallback');
    expect(resolveCodexQuotaPolicy({ codexCreditsAllowed: true }, 'use')).toEqual({ policy: 'credits', source: 'policy-file' });
    expect(logs).toEqual([]);
  });
});

describe('codexQuotaPolicyFromConfig — 실제 policy/llm.yaml 을 읽어 넘긴다', () => {
  let dir: string;
  beforeEach(() => {
    delete process.env.ELANOUS_CODEX_QUOTA_POLICY;
    dir = mkdtempSync(join(tmpdir(), 'codex-quota-policy-'));
    mkdirSync(join(dir, 'policy'));
    setElanousConfigDir(dir);
    _setRotationConfigReaderForTesting(() => ({ llm: { codexQuotaPolicy: 'credits' } }) as never);
  });
  afterEach(() => {
    _setRotationConfigReaderForTesting(null);
    resetElanousConfigDir();
    rmSync(dir, { recursive: true, force: true });
  });

  test('파일 never 는 옛 키 credits 를 이기고, 파일이 없으면 옛 키가 그대로 이기고, 깨진 파일은 fallback', () => {
    expect(codexQuotaPolicyFromConfig()).toBe('credits');
    writeFileSync(join(dir, 'policy', 'llm.yaml'), 'credits:\n  codex: never\n');
    expect(codexQuotaPolicyFromConfig()).toBe('within-quota');
    writeFileSync(join(dir, 'policy', 'llm.yaml'), 'credits: [unclosed\n');
    expect(codexQuotaPolicyFromConfig()).toBe('fallback');
  });
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

