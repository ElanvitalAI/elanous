// provider↔credential SSOT — escalate 401 근본수리 회귀 가드.
//
// ⭐ 이 파일의 존재 이유: 2026-07-26 실측에서 self-dev escalate(tier=opus)가 **100% 401 즉사**했다.
//    provider 만 anthropic 으로 바뀌고 apiKey 는 openai-codex 것이 따라갔기 때문. 아래 첫 테스트가
//    **정확히 그 시나리오**를 재현한다 — 되돌리면 그 테스트가 실패한다.
import { test, expect, describe } from 'bun:test';
import { providerEnvKey, isKeylessProvider, resolveProviderCredential, observeCredentialResolution } from './provider-credentials.js';
import { debug } from '../debug/log.js';
import type { DebugEvent } from '../debug/log.js';
import { LOG_DIET_SUMMARY_MIN_INTERVAL_MS, LogDietGuard } from '../debug/log-diet.js';
import { BUILTIN_CATALOG } from '../intelligence-map/model-catalog.js';

describe('providerEnvKey — SSOT(catalog 파생 + 명시 오버레이)', () => {
  test('catalog 파생 — 모델이 선언한 envKey 가 provider 로 접힌다', () => {
    expect(providerEnvKey('anthropic')).toBe('ANTHROPIC_API_KEY');
    expect(providerEnvKey('grok')).toBe('GROK_API_KEY');
    expect(providerEnvKey('gemini')).toBe('GEMINI_API_KEY');
  });

  test('★ 명시 오버레이 — openai-codex 는 catalog 파생이 null 이라 오버레이가 없으면 조용히 깨진다', () => {
    // catalog 의 openai-codex 모델들은 OAuth 구독이라 envKey 를 안 단다(파생값 null).
    // 그러나 API 경로에선 openai 와 키 패밀리를 공유하므로 OPENAI_API_KEY 가 맞다.
    // 이 가드가 없으면 "catalog 로 SSOT 통일" 리팩토링이 codex 릴레이를 조용히 죽인다.
    expect(providerEnvKey('openai-codex')).toBe('OPENAI_API_KEY');
    expect(providerEnvKey('openai')).toBe('OPENAI_API_KEY');
  });

  test('종전 사설 맵에 없던 provider 도 catalog 에서 나온다(이중화가 만든 누락 해소)', () => {
    // kimi/qwen/glm 은 catalog 에만 있어 run-context 사설 맵에선 릴레이가 조용히 빠져 있었다.
    expect(providerEnvKey('kimi')).toBe('KIMI_API_KEY');
    expect(providerEnvKey('qwen')).toBe('DASHSCOPE_API_KEY');
  });

  test('키가 필요 없는 provider 는 undefined — 부재가 정상이다', () => {
    expect(providerEnvKey('local')).toBeUndefined();
    expect(providerEnvKey('ollama')).toBeUndefined();
    expect(providerEnvKey(undefined)).toBeUndefined();
    expect(isKeylessProvider('local')).toBe(true);
    expect(isKeylessProvider('anthropic')).toBe(false);
    // ★ should-fix(4R) — provider 미지정은 keyless 가 **아니다**. "키가 필요 없다"와 "무엇이 필요한지
    //   모른다"는 다르고, 후자를 정상으로 취급하면 `provider-key-missing` 경고가 조용히 억제된다.
    expect(isKeylessProvider(undefined)).toBe(false);
    expect(isKeylessProvider('')).toBe(false);
  });

  test("★ 'auto' 는 keyless 가 아니다 — production 미지정 경로가 auto 로 정규화되므로 (must-fix 5R)", () => {
    // 4R 수정은 `undefined` 만 고쳤는데, production 은 미지정 provider 를 normalizeProvider() 로
    // 'auto' 로 만든다 → 'auto' 가 keyless 면 실제 경로에서 누락 경고가 계속 억제된다.
    expect(isKeylessProvider('auto')).toBe(false);
    expect(providerEnvKey('auto')).toBeUndefined();   // 어느 키인지 모르는 건 맞다(추측 금지)
  });

  test('미지 provider 는 undefined(추측 금지)', () => {
    expect(providerEnvKey('nonesuch')).toBeUndefined();
  });

  // 리뷰 should-fix(#5488) — 같은 provider 가 상충하는 envKey 를 선언하면 "첫 항목 승"이 조용히
  // 인증을 결정한다. 오늘 카탈로그가 무결한지를 **직접 단정**해, 나중 편집이 이 가드에 걸리게 한다.
  test('★ SSOT 무결성 — 한 provider 의 모든 모델이 같은 envKey 를 선언한다(상충 0)', () => {
    const seen = new Map<string, { envKey: string; model: string }>();
    const conflicts: string[] = [];
    for (const e of BUILTIN_CATALOG.models) {
      if (!e.envKey) continue;
      const prev = seen.get(e.provider);
      if (!prev) { seen.set(e.provider, { envKey: e.envKey, model: e.id }); continue; }
      if (prev.envKey !== e.envKey) conflicts.push(`${e.provider}: ${prev.model}=${prev.envKey} vs ${e.id}=${e.envKey}`);
    }
    expect(conflicts).toEqual([]);
    // 무결하므로 모든 provider 가 env 해석 대상으로 살아있다(상충이면 undefined 로 떨어진다).
    for (const [provider, { envKey }] of seen) expect(providerEnvKey(provider)).toBe(envKey);
  });

  // ⭐ must-fix(3R→6R) — 상충 **처리 자체**를 검증한다. 위 테스트는 상충 0 인 실제 catalog 만 보므로
  //    first-wins 로 회귀해도 통과한다(Goodhart). 실 catalog 로는 상충을 만들 수 없으므로 파생 소스를
  //    주입해 **공개 API(`providerEnvKey`)의 동작으로** 확인한다(6R: 내부 fold 를 export 하지 않는다).
  test('★ 상충하는 envKey — first-wins 가 아니라 해석 제외(모호한 인증 결정 금지)', () => {
    const models = [
      { provider: 'acme', id: 'acme-1', envKey: 'ACME_A' },
      { provider: 'acme', id: 'acme-2', envKey: 'ACME_B' },   // ← 상충
      { provider: 'solo', id: 'solo-1', envKey: 'SOLO_KEY' },
    ];
    expect(providerEnvKey('acme', models)).toBeUndefined();   // first-wins 면 'ACME_A' 가 나온다
    expect(providerEnvKey('solo', models)).toBe('SOLO_KEY');  // 상충 없는 provider 는 무영향
  });

  test('상충이 3중이어도 해석 제외는 동일(부분 채택으로 새지 않는다)', () => {
    const models = [
      { provider: 'acme', id: 'a1', envKey: 'A' },
      { provider: 'acme', id: 'a2', envKey: 'B' },
      { provider: 'acme', id: 'a3', envKey: 'C' },
    ];
    expect(providerEnvKey('acme', models)).toBeUndefined();
  });

  test('상충하지 않는 중복 선언은 그대로 채택(같은 값 반복은 상충 아님)', () => {
    expect(providerEnvKey('acme', [
      { provider: 'acme', id: 'acme-1', envKey: 'ACME_A' },
      { provider: 'acme', id: 'acme-2', envKey: 'ACME_A' },
    ])).toBe('ACME_A');
  });

  test('envKey 미선언 모델은 fold 에 영향 없음(키 없는 provider)', () => {
    expect(providerEnvKey('acme', [
      { provider: 'acme', id: 'acme-1' },
      { provider: 'acme', id: 'acme-2', envKey: 'ACME_A' },
    ])).toBe('ACME_A');
  });

  test('오버레이는 파생 override 보다 세다(주입이 codex 배선을 흔들지 않는다)', () => {
    expect(providerEnvKey('openai-codex', [{ provider: 'openai-codex', id: 'x', envKey: 'WRONG' }]))
      .toBe('OPENAI_API_KEY');
  });
});

describe('resolveProviderCredential — 우선순위 rotation → env → (미전환 시만) 상속', () => {
  test('⭐ 401 재현 가드 — provider 가 바뀌면 base 키를 절대 상속하지 않는다', () => {
    // 2026-07-26 실측 그대로: base=openai-codex(키 보유) → escalate 로 provider 만 anthropic 이 됨.
    // 종전 코드는 여기서 openai 키를 그대로 실어 anthropic 에 붙였다 → 401.
    const r = resolveProviderCredential({
      provider: 'anthropic',
      baseProvider: 'openai-codex',
      baseApiKey: 'sk-proj-openai-key',
      env: {},
    });
    expect(r.apiKey).toBeUndefined();       // ← 틀린 키를 들고 가지 않는다
    expect(r.source).toBe('none');
    expect(r.envKey).toBe('ANTHROPIC_API_KEY');   // 무엇을 찾았어야 하는지가 진단에 남는다
  });

  test('rotation(config) 이 1순위 — env 가 있어도 config 를 쓴다(대표 결정 a)', () => {
    const r = resolveProviderCredential({
      provider: 'anthropic',
      baseProvider: 'openai-codex',
      rotation: [{ provider: 'grok', apiKey: 'xai-x' }, { provider: 'anthropic', apiKey: 'sk-ant-rot' }],
      env: { ANTHROPIC_API_KEY: 'sk-ant-env' },
    });
    expect(r.apiKey).toBe('sk-ant-rot');
    expect(r.source).toBe('rotation');
  });

  test('rotation 에 없으면 env fallback', () => {
    const r = resolveProviderCredential({
      provider: 'anthropic',
      baseProvider: 'openai-codex',
      rotation: [{ provider: 'grok', apiKey: 'xai-x' }],
      env: { ANTHROPIC_API_KEY: 'sk-ant-env' },
    });
    expect(r.apiKey).toBe('sk-ant-env');
    expect(r.source).toBe('env');
    expect(r.envKey).toBe('ANTHROPIC_API_KEY');
  });

  test('rotation 엔트리가 빈 키면 무시하고 다음 순위로(빈 문자열이 env 를 가리지 않게)', () => {
    const r = resolveProviderCredential({
      provider: 'anthropic',
      baseProvider: 'anthropic',
      rotation: [{ provider: 'anthropic', apiKey: '   ' }],
      env: { ANTHROPIC_API_KEY: 'sk-ant-env' },
    });
    expect(r.apiKey).toBe('sk-ant-env');
    expect(r.source).toBe('env');
  });

  test('★ baseProvider 를 모르면 상속하지 않는다 — fail-closed (리뷰 must-fix 2R)', () => {
    // 종전 판정은 `!switched` 라 baseProvider 부재 시 switched=false → **전환 여부를 모르는데 상속**했다.
    const r = resolveProviderCredential({ provider: 'anthropic', baseApiKey: 'sk-proj-openai-key', env: {} });
    expect(r.apiKey).toBeUndefined();
    expect(r.source).toBe('none');
  });

  test('provider 가 그대로면 base 키를 상속한다 — 무회귀(종전 동작 보존)', () => {
    const r = resolveProviderCredential({
      provider: 'openai-codex',
      baseProvider: 'openai-codex',
      baseApiKey: 'sk-proj-openai-key',
      env: {},
    });
    expect(r.apiKey).toBe('sk-proj-openai-key');
    expect(r.source).toBe('inherited');
  });

  test('키 없는 provider 로 전환 — 부재가 정상이고 envKey 도 안 남는다', () => {
    const r = resolveProviderCredential({ provider: 'local', baseProvider: 'anthropic', baseApiKey: 'sk-ant-x', env: {} });
    expect(r.apiKey).toBeUndefined();
    expect(r.source).toBe('none');
    expect(r.envKey).toBeUndefined();
    expect(isKeylessProvider('local')).toBe(true);
  });

  test('전 provider 정합 — grok/gemini 로 전환해도 같은 규칙이 적용된다(국소 수리 아님·대표 결정 b)', () => {
    for (const [provider, envKey, val] of [
      ['grok', 'GROK_API_KEY', 'xai-live'],
      ['gemini', 'GEMINI_API_KEY', 'gem-live'],
    ] as const) {
      const leaked = resolveProviderCredential({ provider, baseProvider: 'anthropic', baseApiKey: 'sk-ant-x', env: {} });
      expect(leaked.apiKey).toBeUndefined();   // anthropic 키가 grok/gemini 로 새지 않는다
      const ok = resolveProviderCredential({ provider, baseProvider: 'anthropic', baseApiKey: 'sk-ant-x', env: { [envKey]: val } });
      expect(ok.apiKey).toBe(val);
      expect(ok.source).toBe('env');
    }
  });

  test('runtime detector의 Grok primary alias XAI_API_KEY도 resolver가 읽는다', () => {
    const resolved = resolveProviderCredential({ provider: 'grok', env: { XAI_API_KEY: 'xai-primary' } });
    expect(resolved).toMatchObject({ apiKey: 'xai-primary', source: 'env', envKey: 'XAI_API_KEY' });
  });
});

// BACKLOG B13 — 런 단위 LOCAL_LLM_URL 이 config rotation 의 local 주소를 이긴다.
describe('local endpoint precedence (BACKLOG B13)', () => {
  const rotation = [{ provider: 'local', model: 'local:x', baseUrl: 'http://localhost:1234/v1', label: 'l' }] as never;
  test('env wins over rotation for local; rotation still used without env', () => {
    expect(resolveProviderCredential({ provider: 'local', rotation, env: { LOCAL_LLM_URL: 'http://node-b:1234/v1' } }).baseUrl).toBe('http://node-b:1234/v1');
    expect(resolveProviderCredential({ provider: 'local', rotation, env: {} }).baseUrl).toBe('http://localhost:1234/v1');
  });
  test('LOCAL_LLM_URL does not leak into other providers', () => {
    const rot = [{ provider: 'grok', model: 'g', baseUrl: 'https://x.test/v1', label: 'g' }] as never;
    expect(resolveProviderCredential({ provider: 'grok', rotation: rot, env: { LOCAL_LLM_URL: 'http://node-b:1234/v1' } }).baseUrl).toBe('https://x.test/v1');
  });
});

// LOG-DIET-2 (0.2.24) — emit 지점(`observeCredentialResolution`) → `debug.log` → `LogDietGuard.admit` 배선.
describe('observeCredentialResolution × LOG-DIET (칸 LOG-DIET-2)', () => {
  test('반복 provider-key-missing warn 은 원본 한 행 + 접힌 카운트 하나로 남는다', () => {
    let time = 0;
    const events: DebugEvent[] = [];
    const previousGuard = debug.setLogDietGuard(new LogDietGuard({ now: () => time }));
    const unregister = debug.registerSink({ name: 'log-diet-credential-test', emit: event => events.push(event) });
    try {
      const resolved = resolveProviderCredential({ provider: 'grok', env: {} });
      expect(resolved.source).toBe('none');
      observeCredentialResolution('grok', resolved, 'escalate');
      const missing = () => events.filter(e => e.category === 'llm.credential' && e.event === 'provider-key-missing');
      expect(missing()).toHaveLength(1);
      expect(missing()[0]).toMatchObject({ level: 'warn' });
      for (let i = 0; i < 20; i++) {
        time += 100;
        observeCredentialResolution('grok', resolved, 'escalate');
      }
      expect(missing()).toHaveLength(1); // warn 이어도 «등록된» 절식 키라 접힌다
      time = LOG_DIET_SUMMARY_MIN_INTERVAL_MS;
      debug.flush();
      const summary = events.filter(e => e.category === 'log.diet' && e.event === 'suppressed');
      expect(summary).toHaveLength(1);
      expect(summary[0]!.data).toMatchObject({
        category: 'llm.credential', event: 'provider-key-missing', count: 20,
      });
    } finally {
      unregister();
      debug.setLogDietGuard(previousGuard);
    }
  });
});
