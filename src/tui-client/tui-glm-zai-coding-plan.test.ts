// TUI-GLM-PROVIDER-USES-ZAI-CODING-PLAN — `eln --provider glm` TUI 턴이 0초에 «요청을 처리하지 못했습니다» 로 끝났다.
// 원인: REPL 턴(session/chat.ts runTurn)은 getProviderForConfigAsync 를 타는데, 그 앞단 finalize 가 glm 을
//   «unknown provider» 로 던져 Z.ai Coding Plan 해석(키 캐시 → ZAI_API_KEY)에 닿지도 못했다.
// ⛔ 실 네트워크 0 · 실 자격 0 — 임시 키 캐시 디렉토리에 합성 키 · 요청은 fake fetch 가 받는다 · 키 값은 출력하지 않는다.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetKeyCacheForTests } from '../config.js';
import { getProviderForConfigAsync, streamLLMWithTools } from '../llm.js';
import { ZAI_CREDENTIAL_MISSING_REASON } from '../llm/zai-coding-plan.js';
import { lookupLlmTierSpec } from '../model-tier/llm-tier-map.js';
import { getUserConfig, PROVIDER_DEFAULT_MODEL } from '../user-config.js';
import { withRealProviderFakeFetchDevice } from '../ux-sim/fake-fetch.js';
import { turnReplyFailureMessage } from '../tui/core/next-public-reply.js';
import { NextTuiAuthError, preflightNextTuiGlmAuth } from './next-auth-preflight.js';
import { sessionProviderChildEnv } from './session-provider.js';

const SYNTHETIC_KEY = 'synthetic-zai-coding-plan-test-key';
const ISOLATED = ['ELANOUS_KEY_CACHE_DIR', 'ELANOUS_KEEP_ENV_KEYS', 'ELANOUS_LLM_MODE', 'ELANOUS_TEST_FAKE_LLM',
  'ELANOUS_LLM_PROVIDER', 'ELANOUS_LLM_MODEL', 'ZAI_API_KEY', 'ZHIPU_API_KEY', 'GLM_API_KEY', 'BIGMODEL_API_KEY', 'GLM_MODEL'] as const;

let saved: Record<string, string | undefined> = {};
let home = '';
beforeEach(() => {
  saved = Object.fromEntries(ISOLATED.map((key) => [key, process.env[key]]));
  for (const key of ISOLATED) delete process.env[key];
  home = mkdtempSync(join(tmpdir(), 'tui-glm-zai-'));
  process.env.ELANOUS_KEY_CACHE_DIR = join(home, '.cache');
  // The gate's global fake-LLM default would replace the configured provider; this file asserts the real resolver.
  process.env.ELANOUS_LLM_MODE = 'real';
  _resetKeyCacheForTests();
});
afterEach(() => {
  for (const key of ISOLATED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  _resetKeyCacheForTests();
  rmSync(home, { recursive: true, force: true });
});

function withCacheKey(): void {
  const dir = process.env.ELANOUS_KEY_CACHE_DIR!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'zai_api_key'), `${SYNTHETIC_KEY}\n`, { mode: 0o600 });
}

function glmConfig(model?: string) {
  const base = getUserConfig();
  return { ...base, llm: { ...base.llm, provider: 'glm' as const, model } };
}

describe('glm 턴은 Coding Plan 키 캐시로 코딩 엔드포인트를 탄다', () => {
  test('키 캐시만 있고 ZHIPU_API_KEY 없음 → api.z.ai coding/paas · 합성 키 · 모델 미지정이면 glm-5.3', async () => {
    withCacheKey();
    const seen: Array<{ host: string; path: string; authHasKey: boolean; model?: string }> = [];
    await withRealProviderFakeFetchDevice([{
      url: '/api/coding/paas/v4/chat/completions', method: 'POST',
      response: (request) => {
        const url = new URL(request.url);
        const auth = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1] ?? '';
        const body = JSON.parse(request.body ?? '{}') as { model?: string };
        seen.push({ host: url.hostname, path: url.pathname, authHasKey: auth.includes(SYNTHETIC_KEY), ...(body.model ? { model: body.model } : {}) });
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`, {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        });
      },
    }], async () => {
      // The REPL turn path: session/chat.ts runTurn → getProviderForConfigAsync(userConfig, model).
      const provider = await getProviderForConfigAsync(glmConfig(undefined));
      expect(provider.name).toBe('glm');
      expect(provider.defaultModel).toBe('glm-5.3');
      const text = await streamLLMWithTools([{ role: 'user', content: 'hi' }], { onText: () => {}, dispatchTool: async () => ({}) }, { provider, tools: [] });
      expect(text).toBe('ok');
    });
    expect(seen).toEqual([{ host: 'api.z.ai', path: '/api/coding/paas/v4/chat/completions', authHasKey: true, model: 'glm-5.3' }]);
  });

  test('키 없음 → 사람에게 보이는 이유(턴 실패 문면 · 해석기 오류 둘 다) · 0초 무언 실패가 아니다', async () => {
    await expect(getProviderForConfigAsync(glmConfig('glm-5.3'))).rejects.toThrow(ZAI_CREDENTIAL_MISSING_REASON);

    let thrown: unknown;
    try { preflightNextTuiGlmAuth('glm', () => false); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(NextTuiAuthError);
    expect((thrown as NextTuiAuthError).kind).toBe('glm-auth-missing');
    expect((thrown as Error).message).toBe(ZAI_CREDENTIAL_MISSING_REASON);
    expect(turnReplyFailureMessage('turn-1', true, 'glm-auth-missing')).toBe(ZAI_CREDENTIAL_MISSING_REASON);
    expect(ZAI_CREDENTIAL_MISSING_REASON).toContain('~/.cache/zai_api_key');
    expect(ZAI_CREDENTIAL_MISSING_REASON).toContain('ZAI_API_KEY');

    // Key present or another provider → the preflight stays out of the way.
    expect(() => preflightNextTuiGlmAuth('glm', () => true)).not.toThrow();
    expect(() => preflightNextTuiGlmAuth('openai-codex', () => false)).not.toThrow();
  });

  test('모델 기본값 = 사다리 glm balanced(glm-5.3) — 세션 선택·설정 둘 다', () => {
    expect(lookupLlmTierSpec('glm', 'balanced').model).toBe('glm-5.3');
    expect(PROVIDER_DEFAULT_MODEL.glm).toBe('glm-5.3');
    expect(sessionProviderChildEnv({ provider: 'glm' }).env.ELANOUS_LLM_MODEL).toBe('glm-5.3');
  });
});
