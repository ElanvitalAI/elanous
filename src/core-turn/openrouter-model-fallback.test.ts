/**
 * ELN-SEAT-TURN-HARD-CAP ③ — a silent OpenRouter model moves to the configured OTHER OpenRouter model once
 * (`llm.openrouter.fallbackModel`) before the provider chain (11-18: the chain's next stop was spent codex).
 * Through the real `runCoreTurn` → `streamLLMWithTools` loop; only the provider (the outside world) is fake.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import * as surfaceModule from '../session-runtime/index.js';
import * as deferredModule from '../session-runtime/tier-flip.js';
import { PROVIDERS, openrouterSameProviderFallbackModel, type LLMProvider, type LLMStreamEvent } from '../llm.js';
import { setUserConfigOverlay } from '../user-config.js';
import { TEST_FAKE_LLM_SCRIPT_ENV, resetTestFakeLlmScript } from '../ux-sim/fake-llm.js';
import { runCoreTurn } from './run-core-turn.js';
import type { CoreTurnContext } from './types.js';

const PROBE_TOOL = { name: 'probe', description: 'a tool the turn may call', parameters: { type: 'object', properties: {} } };

let events: string[] = [];
let mails: Array<{ from: string; to: readonly string[]; body: string }> = [];
const originalGrok = PROVIDERS.grok!;
const originalOpenrouter = PROVIDERS.openrouter!;
const priorScript = process.env[TEST_FAKE_LLM_SCRIPT_ENV];

beforeEach(() => {
  events = [];
  mails = [];
  spyOn(debug, 'log').mockImplementation((category: string, event: string) => {
    if (category === 'llm.stream' || category === 'core.turn' || category === 'llm.router') events.push(`${category}:${event}`);
  });
  // Same neutral surface and deferral as run-core-turn.test.ts: the probe tool stays in the catalog the model sees.
  spyOn(surfaceModule, 'resolveSessionSurfaceProfile').mockImplementation(() => ({
    id: 'default', selectionReason: 'test', baselineContexts: [], defaultFamilies: [], conditionalFamilies: [],
  }) as unknown as ReturnType<typeof surfaceModule.resolveSessionSurfaceProfile>);
  spyOn(deferredModule, 'applyDeferredTools').mockImplementation((messages, tools) => ({
    messages: [...messages],
    tools: [...tools],
    stats: { activeCount: tools.length, deferredCount: 0, warmPreloaded: [], injected: false, deferredNames: [], unhydratableNames: [], unhydratableCount: 0 },
  }) as unknown as ReturnType<typeof deferredModule.applyDeferredTools>);
});

afterEach(() => {
  mock.restore();
  setUserConfigOverlay(null);
  PROVIDERS.grok = originalGrok;
  PROVIDERS.openrouter = originalOpenrouter;
  if (priorScript === undefined) delete process.env[TEST_FAKE_LLM_SCRIPT_ENV];
  else process.env[TEST_FAKE_LLM_SCRIPT_ENV] = priorScript;
  resetTestFakeLlmScript();
});

function useChain(chain: string[], limitMs: number, fallbackModel?: string): void {
  setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto', fallbackChain: chain, turnNoProgressMs: limitMs,
    ...(fallbackModel === undefined ? {} : { openrouter: { ...config.llm.openrouter, fallbackModel } }) } }));
}

function answeringGrok(answer: string): { provider: LLMProvider; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
      name: 'grok', defaultModel: 'grok-test-model', available: () => true,
      async *chat() { yield answer; },
      async *streamChat() { calls += 1; yield { type: 'text', delta: answer }; },
    },
  };
}

function ctx(initialProvider: LLMProvider, dispatchTool: CoreTurnContext['dispatchTool'] = async () => ({ ok: true })): CoreTurnContext {
  return {
    sessionId: 'stall-session-1',
    messages: [{ role: 'user', content: 'do the work' }],
    tools: [PROBE_TOOL],
    dispatchTool,
    signal: new AbortController().signal,
    initialProvider,
  };
}

/** An OpenRouter double: the first model only «thinks» (reasoning, no output) until aborted; any other model answers. */
function openrouterByModel(silentModel: string, answer: string): { provider: LLMProvider; models: string[] } {
  const models: string[] = [];
  return {
    models,
    provider: {
      name: 'openrouter', defaultModel: silentModel, available: () => true,
      async *chat() { yield 'unused'; },
      async *streamChat(_messages, opts) {
        const model = String(opts?.model);
        models.push(model);
        if (model === silentModel) {
          for (let i = 0; i < 1_000; i += 1) {
            if (opts?.signal?.aborted) return;
            await new Promise((resolve) => setTimeout(resolve, 5));
            yield { type: 'reasoning', kind: 'inline_delta', delta: '…' };
          }
          return;
        }
        yield { type: 'text', delta: answer };
      },
    },
  };
}

describe('ELN-SEAT-TURN-HARD-CAP ③ same-provider OpenRouter model fallback', () => {
  test('a silent OpenRouter model → the configured other OpenRouter model answers; the chain (grok) is never asked', async () => {
    const router = openrouterByModel('z-ai/glm-5.3', '다른 OR 모델의 답');
    PROVIDERS.openrouter = router.provider;
    const grok = answeringGrok('불리면 안 되는 공급자');
    PROVIDERS.grok = grok.provider;
    useChain(['grok'], 80, 'openrouter/openai/gpt-6-luna');
    const result = await runCoreTurn(ctx(router.provider), { stallSeat: 'QSEAT', stallMailer: async (mail) => { mails.push(mail); } });
    expect(result.finalText).toBe('다른 OR 모델의 답');
    expect(router.models).toEqual(['z-ai/glm-5.3', 'openai/gpt-6-luna']);
    expect(grok.calls()).toBe(0);
  }, 5_000);

  test('no fallbackModel configured → the provider chain as before (grok answers)', async () => {
    const router = openrouterByModel('z-ai/glm-5.3', 'unused');
    PROVIDERS.openrouter = router.provider;
    const grok = answeringGrok('체인의 답');
    PROVIDERS.grok = grok.provider;
    useChain(['grok'], 80);
    const result = await runCoreTurn(ctx(router.provider), { stallSeat: 'QSEAT', stallMailer: async (mail) => { mails.push(mail); } });
    expect(result.finalText).toBe('체인의 답');
    expect(router.models).toEqual(['z-ai/glm-5.3']);
  }, 5_000);

  test('the other model is silent too → taken once only, then the chain', async () => {
    const router = openrouterByModel('z-ai/glm-5.3', 'unused');
    const twoSilent: LLMProvider = { ...router.provider, async *streamChat(messages, opts) {
      const model = String(opts?.model);
      if (model === 'openai/gpt-6-luna') {
        router.models.push(model);
        for (let i = 0; i < 1_000; i += 1) {
          if (opts?.signal?.aborted) return;
          await new Promise((resolve) => setTimeout(resolve, 5));
          yield { type: 'reasoning', kind: 'inline_delta', delta: '…' } as LLMStreamEvent;
        }
        return;
      }
      yield* router.provider.streamChat!(messages, opts);
    } };
    PROVIDERS.openrouter = twoSilent;
    const grok = answeringGrok('마지막 체인의 답');
    PROVIDERS.grok = grok.provider;
    useChain(['grok'], 80, 'openrouter/openai/gpt-6-luna');
    const result = await runCoreTurn(ctx(twoSilent), { stallSeat: 'QSEAT', stallMailer: async (mail) => { mails.push(mail); } });
    expect(result.finalText).toBe('마지막 체인의 답');
    expect(router.models).toEqual(['z-ai/glm-5.3', 'openai/gpt-6-luna']);
  }, 5_000);

  test('helper: malformed or same-model configuration gives no same-provider step', () => {
    expect(openrouterSameProviderFallbackModel('z-ai/glm-5.3', 'openrouter/openai/gpt-6-luna')).toBe('openai/gpt-6-luna');
    expect(openrouterSameProviderFallbackModel('z-ai/glm-5.3', 'openrouter/z-ai/glm-5.3')).toBe(null);
    // 19:0x pair: a luna turn falls back to the provider default (glm-5.3), and glm to luna.
    expect(openrouterSameProviderFallbackModel('openai/gpt-6-luna', 'openrouter/openai/gpt-6-luna', 'z-ai/glm-5.3')).toBe('z-ai/glm-5.3');
    expect(openrouterSameProviderFallbackModel('z-ai/glm-5.3', 'openrouter/z-ai/glm-5.3', 'z-ai/glm-5.3')).toBe(null);
    expect(openrouterSameProviderFallbackModel('z-ai/glm-5.3', 'openai/gpt-6-luna')).toBe(null);
    expect(openrouterSameProviderFallbackModel('z-ai/glm-5.3', undefined)).toBe(null);
  });

  test('order: GLM subscription 429 (plan limit) → OpenRouter glm-5.3 → silent → OpenRouter luna answers', async () => {
    const glmSubscription: LLMProvider = {
      name: 'glm', defaultModel: 'glm-5.3', available: () => true,
      async *chat() { yield 'unused'; },
      // eslint-disable-next-line require-yield
      async *streamChat() {
        throw Object.assign(new Error('429 {"error":{"code":"1308","message":"Usage limit reached for 5 hour"}}'), { status: 429 });
      },
    };
    const router = openrouterByModel('z-ai/glm-5.3', 'OR luna 의 답');
    PROVIDERS.openrouter = router.provider;
    const grok = answeringGrok('불리면 안 되는 공급자');
    PROVIDERS.grok = grok.provider;
    useChain(['openrouter'], 80, 'openrouter/openai/gpt-6-luna');
    const result = await runCoreTurn(ctx(glmSubscription), { stallSeat: 'QSEAT', stallMailer: async (mail) => { mails.push(mail); } });
    expect(result.finalText).toBe('OR luna 의 답');
    expect(router.models).toEqual(['z-ai/glm-5.3', 'openai/gpt-6-luna']);
    expect(grok.calls()).toBe(0);
  }, 5_000);
});
