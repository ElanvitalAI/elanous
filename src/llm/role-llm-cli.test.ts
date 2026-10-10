import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRoleLlmFlags, formatRoleLlmSpec } from './role-llm-cli.js';
import { resolveRoleLlm, resolveRoleModel, MODEL_ROLES, getUserConfig } from '../user-config.js';

// Classification: unlike dev-pipeline's default-seam leak, these tests call role
// resolution directly. Supply an explicit non-credentialed local config so they test
// resolver precedence rather than ambient provider discovery; no reviewer seam exists here.
function resolverTestConfig() {
  const config = getUserConfig();
  return {
    ...config,
    llm: { ...config.llm, provider: 'local' as const, baseUrl: 'http://resolver.invalid/v1', model: 'test-resolver-model' },
  };
}

describe('role-llm 입력 파서 — ⛔ 조용히 삼키지 않는다', () => {
  test('provider ⊕ tier 를 판다', () => {
    const r = parseRoleLlmFlags(['implement=grok/best']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.overrides.implement).toEqual({ provider: 'grok', tier: 'best' });
  });

  test('provider 만 줘도 된다 — 「일부분만」이 1급', () => {
    const r = parseRoleLlmFlags(['review=anthropic']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.overrides.review).toEqual({ provider: 'anthropic' });
  });

  test('tier 만도 된다', () => {
    const r = parseRoleLlmFlags(['planning=/best']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.overrides.planning).toEqual({ tier: 'best' });
  });

  test('여러 역할을 한 번에', () => {
    const r = parseRoleLlmFlags(['implement=grok', 'review=anthropic/loaded']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.overrides).sort()).toEqual(['implement', 'review']);
  });

  // ⭐ 이 네 개가 110차 F42(--acp-backend 가 조용히 무시됨)의 «직접» 처방이다.
  test('모르는 역할은 거부하고 이름을 댄다', () => {
    const r = parseRoleLlmFlags(['nope=grok']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('nope');
  });

  test('모르는 provider 는 거부한다', () => {
    const r = parseRoleLlmFlags(['implement=notaprovider']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('provider');
  });

  test('모르는 tier 는 거부한다', () => {
    const r = parseRoleLlmFlags(['implement=grok/notatier']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('tier');
  });

  test('하나가 틀리면 «전체»를 거부한다 — 일부만 먹는 것이 최악이다', () => {
    const r = parseRoleLlmFlags(['implement=grok', 'review=notaprovider']);
    expect(r.ok).toBe(false);
  });

  test('= 없는 토큰 · 빈 값 · / 뒤 공백을 거부한다', () => {
    expect(parseRoleLlmFlags(['implement']).ok).toBe(false);
    expect(parseRoleLlmFlags(['implement=']).ok).toBe(false);
    expect(parseRoleLlmFlags(['implement=grok/']).ok).toBe(false);
  });

  test('formatRoleLlmSpec 은 빈 칸을 「없음」으로 말한다', () => {
    expect(formatRoleLlmSpec('implement', undefined)).toContain('없음');
    expect(formatRoleLlmSpec('implement', { provider: 'grok', tier: 'best' })).toContain('provider=grok');
  });
});

test('config roleLlm.planning invalid effort only drops effort and preserves the model', () => {
  const root = mkdtempSync(join(tmpdir(), 'author-role-config-'));
  try {
    const path = join(root, 'config.json');
    writeFileSync(path, JSON.stringify({ roleLlm: { planning: { model: 'gpt-6-sol', effort: 'turbo' } } }));
    const parsed = getUserConfig(path).roleLlm?.planning;
    expect(parsed).toEqual({ model: 'gpt-6-sol' });
    writeFileSync(path, JSON.stringify({ roleLlm: { planning: { model: 'gpt-6-sol', effort: 'medium' } } }));
    expect(getUserConfig(path).roleLlm?.planning).toEqual({ model: 'gpt-6-sol', effort: 'medium' });
    writeFileSync(path, JSON.stringify({ roleLlm: { planning: { effort: 'low' } } }));
    expect(getUserConfig(path).roleLlm?.planning).toEqual({ effort: 'low' });
    writeFileSync(path, JSON.stringify({ roleLlm: { planning: { effort: 'turbo' } } }));
    expect(getUserConfig(path).roleLlm?.planning).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe('resolveRoleLlm 사다리', () => {
  test('flag 가 config·기본을 이긴다 ⊕ source 를 말한다', () => {
    const r = resolveRoleLlm('planning', { config: resolverTestConfig(), overrides: { planning: { provider: 'grok', tier: 'best' } } });
    expect(r.provider).toBe('grok');
    expect(r.tier).toBe('best');
    expect(r.source).toBe('flag');
  });

  test('⭐ 「일부분만」 — 한 역할만 갈리고 나머지는 «건드려지지 않는다»', () => {
    // ⛔ 대조군을 「특정 provider 이름」으로 쓰면 환경(기본 provider)에 따라 참·거짓이 뒤집힌다.
    //    주장은 「implement 가 «안 변했다»」이므로 override 없는 같은 호출과 대조한다.
    const config = resolverTestConfig();
    const baseline = resolveRoleLlm('implement', { config });
    const overrides = { planning: { provider: 'anthropic' as const } };
    const planning = resolveRoleLlm('planning', { config, overrides });
    const implement = resolveRoleLlm('implement', { config, overrides });
    expect(planning.provider).toBe('anthropic');
    expect(planning.source).toBe('flag');
    expect(implement.provider).toBe(baseline.provider);
    expect(implement.model).toBe(baseline.model);
    expect(implement.source).not.toBe('flag');
  });

  test('provider 만 준 override 는 «모델 이름을 박는 층»을 건너뛴다', () => {
    // 이름은 provider 에 매인 값이라 다른 provider 로 부르면 「없는 모델」이 된다.
    const r = resolveRoleLlm('implement', { config: resolverTestConfig(), overrides: { implement: { provider: 'anthropic' } } });
    expect(r.provider).toBe('anthropic');
    expect(r.tier).toBeDefined();          // 티어 층으로 떨어졌다
    expect(r.source).toBe('flag');
  });

  test('⛔ §4f 불변식 — override 가 «없으면» 여섯 역할 산출이 종전 resolveRoleModel 과 같다', () => {
    // NL 로 하니스를 시작해도 문제가 없다 = 아무 인자도 안 주면 값이 안 변한다.
    const config = resolverTestConfig();
    for (const role of MODEL_ROLES) {
      expect(resolveRoleLlm(role, { config }).model).toBe(resolveRoleModel(role, config).model);
    }
  });

  test('빈 spec({}) 은 «선언이 아니라» 아래 층으로 흐른다', () => {
    const config = resolverTestConfig();
    const r = resolveRoleLlm('implement', { config, overrides: { implement: {} } });
    expect(r.source).not.toBe('flag');
    expect(r.model).toBe(resolveRoleModel('implement', config).model);
  });
});
