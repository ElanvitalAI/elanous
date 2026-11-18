// OP #80390 (대표 «GLM 구독 한도 차면 OpenRouter 로 자동 전환»): the TUI glm turn path (#37972 · getProviderForConfigAsync →
// Z.ai Coding Plan provider) must follow llm.zaiCodingPlan.overage=openrouter on a plan-limit (1308) response.
// ⛔ No network and no real credentials — synthetic keys in a temp key cache, a temp state dir for the limit ledger,
// and a fake fetch that answers both endpoints.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetKeyCacheForTests } from '../config.js';
import { debug } from '../debug/log.js';
import { getProviderForConfigAsync, streamLLMWithTools } from '../llm.js';
import { ZAI_OPENROUTER_FALLBACK_MODEL } from '../llm/zai-coding-plan.js';
import { getUserConfig } from '../user-config.js';
import { withRealProviderFakeFetchDevice } from '../ux-sim/fake-fetch.js';

const ISOLATED = ['ELANOUS_KEY_CACHE_DIR', 'ELANOUS_STATE_DIR', 'ELANOUS_KEEP_ENV_KEYS', 'ELANOUS_LLM_MODE', 'ELANOUS_TEST_FAKE_LLM',
  'ELANOUS_LLM_PROVIDER', 'ELANOUS_LLM_MODEL', 'ZAI_API_KEY', 'ZHIPU_API_KEY', 'OPENROUTER_API_KEY', 'GLM_MODEL'] as const;
let saved: Record<string, string | undefined> = {};
let home = '';
beforeEach(() => {
  saved = Object.fromEntries(ISOLATED.map((key) => [key, process.env[key]]));
  for (const key of ISOLATED) delete process.env[key];
  home = mkdtempSync(join(tmpdir(), 'tui-glm-overage-'));
  const cache = join(home, '.cache');
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, 'zai_api_key'), 'synthetic-zai-key\n', { mode: 0o600 });
  writeFileSync(join(cache, 'openrouter_api_key'), 'synthetic-openrouter-key\n', { mode: 0o600 });
  process.env.ELANOUS_KEY_CACHE_DIR = cache;
  process.env.ELANOUS_STATE_DIR = join(home, 'state');
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

test('plan-limit 1308 on the TUI glm path → next request goes to OpenRouter z-ai/glm-5.3 with one fallback log line', async () => {
  const base = getUserConfig();
  const config = { ...base, llm: { ...base.llm, provider: 'glm' as const, model: undefined, zaiCodingPlan: { ...(base.llm.zaiCodingPlan ?? {}), overage: 'openrouter' as const } } };
  const logs = spyOn(debug, 'log');
  const seen: Array<{ host: string; model?: string }> = [];
  const record = (request: { url: string; body: string | null }) => {
    const body = JSON.parse(request.body ?? '{}') as { model?: string };
    seen.push({ host: new URL(request.url).hostname, ...(body.model ? { model: body.model } : {}) });
  };
  try {
    await withRealProviderFakeFetchDevice([
      { url: '/api/coding/paas/v4/chat/completions', method: 'POST', response: (request) => {
        record(request);
        return new Response(JSON.stringify({ error: { code: '1308', message: 'Usage limit reached for 5 hour. Resets at 2026-11-17 03:00:00' } }), {
          status: 429, headers: { 'content-type': 'application/json' },
        });
      } },
      { url: '/api/v1/chat/completions', method: 'POST', response: (request) => {
        record(request);
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'from openrouter' } }] })}\n\ndata: [DONE]\n\n`, {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        });
      } },
    ], async () => {
      const provider = await getProviderForConfigAsync(config);
      expect(provider.name).toBe('glm');
      const text = await streamLLMWithTools([{ role: 'user', content: 'hi' }], { onText: () => {}, dispatchTool: async () => ({}) }, { provider, tools: [] });
      expect(text).toBe('from openrouter');
    });
    expect(seen.map((call) => call.host)).toEqual(['api.z.ai', 'openrouter.ai']);
    expect(seen[1]?.model).toBe(ZAI_OPENROUTER_FALLBACK_MODEL.replace(/^openrouter\//, ''));
    const fallbacks = logs.mock.calls.filter((call) => call[0] === 'zai.coding-plan' && call[1] === 'fallback');
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]?.[2]).toMatchObject({ code: 1308, limitKind: 'plan-limit', policy: 'openrouter', to: ZAI_OPENROUTER_FALLBACK_MODEL, openRouterKey: true });
  } finally {
    logs.mockRestore();
  }
});
