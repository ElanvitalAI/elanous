// LLM 지출 정책 스키마 시험 — 틀린 키·범위 밖·모르는 공급자·비밀 모양·출처 병합(없는 키 = 기본값).
import { describe, expect, test } from 'bun:test';
import {
  applySpendPolicyOverlay, defaultSpendPolicyDoc, defaultSpendPolicySources, looksLikeLongRandom,
  resolveSpendRolePolicy, safeToken, secretShapeReason, serializeSpendPolicyDoc, validateSpendPolicyDoc,
} from './schema.js';
import type { LlmSpendPolicyDoc, SubscriptionRowPolicy } from './types.js';

function baseOptions(doc?: unknown) {
  const defaults = defaultSpendPolicyDoc();
  return {
    knownRows: Object.keys(defaults.providers),
    baseRows: Object.fromEntries(Object.entries(defaults.providers).map(([key, row]) => [key, row.kind])) as Record<string, 'subscription' | 'credit' | 'acp-device'>,
    ...(doc ? { doc } : {}),
  };
}

function validDoc(): Record<string, unknown> {
  return {
    version: 1,
    providers: {
      'codex-default': { kind: 'subscription', provider: 'openai-codex', capPct: 95, onExhausted: ['codex-team', 'stop'] }, // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
      openrouter: { kind: 'credit', provider: 'openrouter', models: ['openrouter/z-ai/glm-5.3'], spendCap: { dailyUsd: 300 } },
    },
    fallbackOrder: ['codex-default', 'openrouter'],
    returnOnReset: true,
    roles: { review: { creditOk: true, deny: ['glm'] } },
  };
}

describe('validateSpendPolicyDoc — 정상', () => {
  test('완전한 문서는 통과한다', () => {
    const result = validateSpendPolicyDoc(validDoc(), baseOptions());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
  test('코드 기본 문서 자체도 통과한다', () => {
    const result = validateSpendPolicyDoc(defaultSpendPolicyDoc(), { knownRows: Object.keys(defaultSpendPolicyDoc().providers) });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
  test('기본 행을 참조만 하는 짧은 저장 문서도 통과한다(fallbackOrder 가 기본 행을 가리킨다)', () => {
    const result = validateSpendPolicyDoc({ fallbackOrder: ['codex-default', 'claude-code-sub'] }, baseOptions());
    expect(result.valid).toBe(true);
  });
  test('기본 행 위 부분 행(없는 키 = 코드 기본값)은 capPct 생략이 가능하다', () => {
    const result = validateSpendPolicyDoc({ providers: { 'codex-team': { kind: 'subscription', provider: 'openai-codex' } } }, baseOptions());
    expect(result.valid).toBe(true);
  });
});

describe('validateSpendPolicyDoc — 틀린 키', () => {
  test('모르는 최상위 키는 거부+사유', () => {
    const result = validateSpendPolicyDoc({ ...validDoc(), spendlimit: 5 }, baseOptions());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('unknown field spendlimit'))).toBe(true);
  });
  test('행 안 모르는 키는 거부+사유', () => {
    const doc = validDoc();
    (doc.providers as Record<string, unknown>)['codex-default'] = { kind: 'subscription', provider: 'openai-codex', capPct: 95, apiKey: 'x' }; // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
    const result = validateSpendPolicyDoc(doc, baseOptions());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('providers.codex-default.apiKey'))).toBe(true);
  });
  test('역할 절 모르는 키는 거부+사유', () => {
    const result = validateSpendPolicyDoc({ roles: { review: { creditOk: true, budget: 5 } } }, baseOptions()); // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('roles.review.budget'))).toBe(true);
  });
  test('모르는 역할 이름은 거부+사유', () => {
    const result = validateSpendPolicyDoc({ roles: { pirate: { creditOk: true } } }, baseOptions());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("unknown role 'pirate'"))).toBe(true);
  });
});

describe('validateSpendPolicyDoc — 범위 밖', () => {
  test('capPct > 100 은 거부한다', () => {
    const result = validateSpendPolicyDoc({ providers: { 'codex-default': { kind: 'subscription', provider: 'openai-codex', capPct: 101 } } }, baseOptions()); // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('capPct is out of range'))).toBe(true);
  });
  test('capPct 음수는 거부한다', () => {
    const result = validateSpendPolicyDoc({ providers: { 'codex-default': { kind: 'subscription', provider: 'openai-codex', capPct: -1 } } }, baseOptions());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('capPct is out of range'))).toBe(true);
  });
  test('spendCap < 0 은 거부한다', () => {
    const result = validateSpendPolicyDoc({ providers: { openrouter: { kind: 'credit', provider: 'openrouter', spendCap: { dailyUsd: -5 } } } }, baseOptions());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('spendCap.dailyUsd is out of range'))).toBe(true);
  });
  test('window.hours 0 이하는 거부한다', () => {
    const result = validateSpendPolicyDoc({ providers: { 'codex-default': { kind: 'subscription', provider: 'openai-codex', capPct: 95, window: { hours: 0 } } } }, baseOptions()); // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('window.hours is out of range'))).toBe(true);
  });
  test('capPct 빠진 «새» 구독 행은 거부한다(기본 행을 덮어쓰는 게 아니면 필수)', () => {
    const result = validateSpendPolicyDoc({ providers: { 'codex-forth': { kind: 'subscription', provider: 'openai-codex' } } }, baseOptions());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('capPct is required for new subscription rows'))).toBe(true);
  });
});

describe('validateSpendPolicyDoc — 모르는 공급자·행 참조', () => {
  test('모르는 공급자는 거부+사유', () => {
    const result = validateSpendPolicyDoc({ providers: { weird: { kind: 'subscription', provider: 'nonexistent-llm', capPct: 50 } } }, baseOptions()); // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("'nonexistent-llm' is not a known provider"))).toBe(true);
  });
  test('fallbackOrder 가 모르는 행을 가리키면 거부한다', () => {
    const result = validateSpendPolicyDoc({ fallbackOrder: ['codex-default', 'ghost-row'] }, baseOptions());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("fallbackOrder references unknown row 'ghost-row'"))).toBe(true);
  });
  test('onExhausted 가 모르는 행을 가리키면 거부한다', () => {
    const result = validateSpendPolicyDoc({ providers: { 'codex-default': { kind: 'subscription', provider: 'openai-codex', capPct: 95, onExhausted: ['ghost-row'] } } }, baseOptions()); // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("onExhausted references unknown row 'ghost-row'"))).toBe(true);
  });
  test('fallbackOrder 중복 행은 거부한다', () => {
    const result = validateSpendPolicyDoc({ fallbackOrder: ['codex-default', 'codex-default'] }, baseOptions());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("fallbackOrder repeats 'codex-default'"))).toBe(true);
  });
  test('빈 fallbackOrder 는 거부한다', () => {
    const result = validateSpendPolicyDoc({ fallbackOrder: [] }, baseOptions());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('fallbackOrder must be a non-empty list'))).toBe(true);
  });
});

describe('validateSpendPolicyDoc — 비밀 모양 거부(JUD ①)', () => {
  test('sk- 토큰 모양은 행 어느 필드든 거부한다', () => {
    const result = validateSpendPolicyDoc({ providers: { 'codex-default': { kind: 'subscription', provider: 'openai-codex', capPct: 95, vault: 'sk-abc123def456ghi789' } } }, baseOptions()); // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('비밀 키 모양'))).toBe(true);
  });
  test('ghp_ 토큰도 거부한다', () => {
    expect(secretShapeReason('ghp_' + 'a'.repeat(36))).toContain('GitHub');
  });
  test('JWT(eyJ…)도 거부한다', () => {
    expect(secretShapeReason('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4.')).toContain('JWT');
  });
  test('마디 구분 없는 긴 무작위도 거부한다', () => {
    expect(secretShapeReason('a3f9c8e7d2b1f0a4c5e6d7b8a9f0e1d2c3b4a5f6')).toContain('긴 무작');
  });
  test('사람이 지은 긴 모델명은 무작위로 오탐하지 않는다', () => {
    expect(looksLikeLongRandom('claude-3-7-sonnet-20250219-thinking')).toBe(false);
    expect(secretShapeReason('claude-3-7-sonnet-20250219-thinking')).toBeNull();
  });
  test('금고 «이름» 형식은 통과한다', () => {
    expect(secretShapeReason('oauth:codex:default')).toBeNull();
    expect(secretShapeReason('cred:openrouter.api_key')).toBeNull();
  });
  test('모델 목록 안에 몰래 실은 토큰도 잡는다(전체 문서 깊이 걷기)', () => {
    const doc = validDoc();
    (doc.providers as Record<string, unknown>).openrouter = { kind: 'credit', provider: 'openrouter', models: ['openrouter/z-ai/glm-5.3', 'sk-or-v1-1234567890abcdef1234567890abcdef'], spendCap: { dailyUsd: 300 } };
    const result = validateSpendPolicyDoc(doc, baseOptions());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('비밀 키 모양'))).toBe(true);
  });
});

describe('applySpendPolicyOverlay — 출처 병합(없는 키 = 코드 기본값)', () => {
  test('저장 문서의 잎은 stored, 나머지는 default 로 표기한다', () => {
    const applied = applySpendPolicyOverlay({ providers: { 'codex-default': { capPct: 90 } } }); // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
    expect('error' in applied).toBe(false);
    const ok = applied as { policy: LlmSpendPolicyDoc; sources: Record<string, string> };
    expect((ok.policy.providers['codex-default'] as SubscriptionRowPolicy).capPct).toBe(90);
    expect(ok.sources['providers.codex-default.capPct']).toBe('stored');
    expect(ok.sources['providers.codex-default.kind']).toBe('default');
    expect(ok.sources['fallbackOrder']).toBe('default');
  });
  test('없는 키는 코드 기본값을 그대로 쓴다', () => {
    const applied = applySpendPolicyOverlay({ roles: { review: { creditOk: false } } }) as { policy: LlmSpendPolicyDoc };
    expect((applied.policy.providers['codex-team'] as SubscriptionRowPolicy).capPct).toBe(60);
    expect(applied.policy.fallbackOrder[0]).toBe('codex-default');
    expect(applied.policy.returnOnReset).toBe(true);
  });
  test('같은 행 키에 kind 가 다르면 fail-closed 로 병합을 거부한다', () => {
    const applied = applySpendPolicyOverlay({ providers: { openrouter: { kind: 'subscription', provider: 'openai-codex', capPct: 50 } } }); // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
    expect('error' in applied).toBe(true);
    expect((applied as { error: string }).error).toContain('kind mismatch');
  });
  test('직렬화 허용 목록 — 알려진 필드만 나간다', () => {
    const doc = defaultSpendPolicyDoc();
    const out = serializeSpendPolicyDoc(doc);
    const row = (out.providers as Record<string, Record<string, unknown>>)['codex-default']!;
    expect(Object.keys(row).sort()).toEqual(['capPct', 'kind', 'onExhausted', 'provider', 'vault', 'window']);
    expect(Object.keys(out).sort()).toEqual(['fallbackOrder', 'providers', 'returnOnReset', 'roles', 'shiftOrder', 'version']);
  });
});

describe('resolveSpendRolePolicy — creditOk 빠짐 = false(fail-closed)', () => {
  test('지정 역할의 creditOk 를 그대로 쓴다', () => {
    const doc = defaultSpendPolicyDoc();
    expect(resolveSpendRolePolicy(doc, 'review').creditOk).toBe(true);
    expect(resolveSpendRolePolicy(doc, 'ta-child').creditOk).toBe(false);
  });
  test('역할 절에 없는 역할은 creditOk=false · prefer/deny 빈 목록', () => {
    const doc = defaultSpendPolicyDoc();
    const resolved = resolveSpendRolePolicy(doc, 'hand-seat');
    expect(resolved.creditOk).toBe(false);
    expect(resolved.prefer).toEqual([]);
    expect(resolved.deny).toEqual([]);
  });
  test('역할 없음(undefined)도 creditOk=false 로 떨어진다', () => {
    expect(resolveSpendRolePolicy(defaultSpendPolicyDoc(), undefined).creditOk).toBe(false);
  });
});

describe('기본 문서 무결성', () => {
  test('기본 출처 표는 모든 잎을 default 로 적는다', () => {
    const sources = defaultSpendPolicySources();
    expect(sources['fallbackOrder']).toBe('default');
    expect(sources['providers.codex-default.capPct']).toBe('default');
    expect(sources['roles.review.creditOk']).toBe('default');
  });
  test('기본 문서는 알려진 공급자만 쓴다', () => {
    for (const row of Object.values(defaultSpendPolicyDoc().providers)) {
      expect(row.provider).toMatch(/^(openai-codex|anthropic|claude-acp|openrouter)$/);
    }
  });
});

describe('확장 칸 검증 — difficulty·creditSpendCap·shiftOrder·maxSessions', () => {
  const check = (doc: unknown) => validateSpendPolicyDoc(doc, baseOptions(doc));
  test('정상 역할 확장은 통과한다', () => {
    const r = check({ version: 1, shiftOrder: ['ta-child', 'authoring'], providers: { 'claude-acp': { maxSessions: 2 } }, // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
      roles: { review: { difficulty: { high: ['gpt-5.5'], low: ['gpt-5.5-mini'] }, creditSpendCap: { dailyUsd: 50 }, creditOk: true } } });
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });
  test('모르는 난이도·음수 몫·모르는 역할 이동·잘못된 세션 상한은 거부', () => {
    expect(check({ version: 1, roles: { review: { difficulty: { epic: ['x'] } } } }).valid).toBe(false);
    expect(check({ version: 1, roles: { review: { creditSpendCap: { dailyUsd: -1 } } } }).valid).toBe(false);
    expect(check({ version: 1, shiftOrder: ['nobody'] }).valid).toBe(false);
    expect(check({ version: 1, shiftOrder: ['ta-child', 'ta-child'] }).valid).toBe(false);
    expect(check({ version: 1, providers: { 'claude-acp': { maxSessions: 0 } } }).valid).toBe(false); // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
    expect(check({ version: 1, providers: { 'codex-default': { maxSessions: 2 } } }).valid).toBe(false); // 출처: #39171 정책 표 시험 픽스처(설계 LLM-SPEND-POLICY-ONE-SHOT.md)
  });
  test('기본 claude-acp 행: hostOnly true · capPct 85 · maxSessions 있음', () => {
    const row = defaultSpendPolicyDoc().providers['claude-acp']!;
    expect(row.kind).toBe('acp-device');
    if (row.kind === 'acp-device') { expect(row.hostOnly).toBe(true); expect(row.capPct).toBe(85); expect(row.maxSessions).toBe(4); }
  });
  test('직렬화는 difficulty·creditSpendCap 을 보존한다', () => {
    const doc = { ...defaultSpendPolicyDoc(), roles: { review: { prefer: [], creditOk: true, deny: [], difficulty: { high: ['a'] }, creditSpendCap: { dailyUsd: 5 } } } } as LlmSpendPolicyDoc;
    const out = serializeSpendPolicyDoc(doc) as { roles: Record<string, Record<string, unknown>> };
    expect(out.roles.review!.difficulty).toEqual({ high: ['a'] });
    expect(out.roles.review!.creditSpendCap).toEqual({ dailyUsd: 5 });
  });
});

describe('fail-closed 보강 — 무효 kind · 비밀 모양 매핑 키', () => {
  test('명시된 무효 kind(bogus)는 «생략» 으로 취급되지 않고 거부된다', () => {
    const result = validateSpendPolicyDoc({ providers: { 'codex-default': { kind: 'bogus', capPct: 80 } } }, baseOptions()); // 출처: #39171 정책 표 시험 픽스처
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('codex-default.kind must be');
  });
  test('비밀 모양 매핑 키는 거부되고 오류에 키 값이 찍히지 않는다', () => {
    const secretKey = 'sk-1234567890abcdef';
    const result = validateSpendPolicyDoc({ providers: { [secretKey]: { kind: 'subscription', provider: 'openai-codex', capPct: 50 } } }, baseOptions()); // 출처: #39171 정책 표 시험 픽스처
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('매핑 키가 비밀 키 모양');
    expect(JSON.stringify(result)).not.toContain(secretKey);
  });
});

describe('비밀 모양 탐침 — 모든 키·값 자리에서 오류 문구에 원문 0 (JUD #109425 must①)', () => {
  const probes = [
    'sk-ant-api03-abcdefghijklmnop',
    'ghp_abcdefghijklmnop1234',
    'ems_abcdefghijklmnop1234',
    'emt_abcdefghijklmnop1234',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghij',
    'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LmNbVcXz12', // 40자 무작위 — 출처: #39171 JUD 탐침 규격(40자+)
  ];
  for (const probe of probes) {
    test(`탐침 ${probe.slice(0, 4)}… 는 어느 자리에서도 원문이 오류에 안 나온다`, () => {
      const docs: unknown[] = [
        { providers: { [probe]: { capPct: 50 } } },
        { providers: { [probe]: { kind: 'subscription', capPct: 50 } } },
        { providers: { 'codex-default': { [probe]: 1 } } },
        { providers: { 'codex-default': { provider: probe, window: { [probe]: 1 } } } },
        { providers: { openrouter: { vault: probe, models: [probe, 3], spendCap: { [probe]: 1 }, autoTopUp: { status: 'measured', [probe]: 1 } } } },
        { providers: { 'codex-default': { onExhausted: [probe, probe] } } },
        { fallbackOrder: [probe, probe] },
        { shiftOrder: [probe] },
        { [probe]: 1 },
        { roles: { [probe]: { prefer: [] } } },
        { roles: { review: { [probe]: 1, prefer: [probe, 7], deny: [probe, 7], difficulty: { [probe]: [probe], high: [probe, 7] }, creditSpendCap: { [probe]: 1 } } } },
      ];
      for (const doc of docs) {
        const result = validateSpendPolicyDoc(doc, baseOptions());
        expect(result.valid).toBe(false);
        expect(JSON.stringify(result)).not.toContain(probe);
      }
    });
  }
  test('safeToken 은 비밀 모양이면 길이만 남기고 평범한 이름은 그대로 둔다', () => {
    expect(safeToken('sk-ant-api03-abcdefghijklmnop')).toBe('<redacted len=29>');
    expect(safeToken('codex-default')).toBe('codex-default');
  });
  test('비밀 검사가 오류 목록의 맨 앞에 온다', () => {
    const result = validateSpendPolicyDoc({ bogus: 1, providers: { 'sk-ant-api03-abcdefghijklmnop': { capPct: 50 } } }, baseOptions());
    expect(result.errors[0]).toContain('비밀 키 모양');
  });
});
