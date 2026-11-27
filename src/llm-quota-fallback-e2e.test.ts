// LLM-AUTO-FALLBACK-ON-QUOTA 실제 종단(OP #135034 · OP #135160 확정 처방) — 합성 시험
// (session-runtime/llm-quota-fallback.test.ts)이 «판정기 decideProviderFallback» 만 묻는다면,
// 이 파일은 «실제 라우터»를 돌려 429 소진 오류가
//   ① 체인의 다음 공급자로 실제 전환되고(src/llm.ts L5069 streamLLM 폴백 루프 → L5290 continue)
//   ② 전부 소진하면 종단되며(텍스트 경로: [LLM PROVIDER BLOCKED] 화면 텍스트 반환 L5320 /
//      도구 경로: ProviderFallbackError throw L9905)
//   ③ 구성 llm.fallbackChain 순서를 그대로 따르는지(configuredFallbackChainSteps →
//      explainFallbackCandidates L4420 — 구성 체인 먼저, 자동 후보는 그 뒤)
// 를 독립 기대값으로 검증한다. 실제 원격 API 호출 0 — provider 스트림을 로컬 생성기로 교체하고
// config 는 setUserConfigOverlay 로 강제하며 가용성(available)도 전 provider 를 고정한다.
// 선례 기법: llm-usage-attribution.test.ts L169-201(동일한 overlay ⊕ streamChat 교체 ⊕ initialProvider 주입).
// ⛔ 새 경로 0 — 기존 라우터·체인 해석을 그대로 재사용하는 회귀 시험이다(OP #135160: 기존 구현 종결 단정 금지).
import { describe, expect, spyOn, test } from 'bun:test';
import { PROVIDERS, streamLLM, streamLLMWithTools, type LLMProvider } from './llm.js';
import { setUserConfigOverlay } from './user-config.js';
import { ProviderFallbackError } from './session-runtime/retry-policy.js';

const FALLBACK_EXHAUST_TITLE = '[LLM PROVIDER BLOCKED]'; // 출처: #135034 — 소진 종단 화면 제목(retry-policy.ts formatProviderFallbackOutput)

/** 429 소진 오류 합성 — 판정기가 읽는 것과 같은 모양(status · 영문 message). */
function quota429Error(): Error & { status: number } {
  const err = new Error('429 usage_limit_reached: quota exhausted for this window');
  return Object.assign(err, { status: 429 }); // 출처: #135034 — HTTP 429 소진 신호(status)
}

interface StreamPlan { fail429?: boolean; answer?: string }

/** provider 스트림을 로컬 생성기로 교체하고 실제 호출 순서를 기록한다(구성 순서 독립 기대값). */
function replaceProviderStreams(plans: Record<string, StreamPlan>): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const originals = new Map<string, LLMProvider['streamChat']>();
  for (const [name, plan] of Object.entries(plans)) {
    const provider = (PROVIDERS as Record<string, LLMProvider | undefined>)[name];
    if (!provider) throw new Error(`test fixture: unknown provider ${name}`);
    originals.set(name, provider.streamChat);
    provider.streamChat = async function* () {
      calls.push(name);
      if (plan.fail429) throw quota429Error();
      yield { type: 'text', delta: plan.answer ?? 'fallback-answer' };
    };
  }
  return {
    calls,
    restore: () => {
      for (const [name, stream] of originals) {
        (PROVIDERS as Record<string, LLMProvider | undefined>)[name]!.streamChat = stream;
      }
    },
  };
}

/** 전 provider 가용성을 명시적으로 고정한다(미지정 provider 는 후보에서 빠진다 — 기대값이 키·호스트 상태에 의존하지 않게). */
function pinAvailability(availableNames: readonly string[]): () => void {
  const restores: Array<() => void> = [];
  for (const name of Object.keys(PROVIDERS)) {
    const provider = (PROVIDERS as Record<string, LLMProvider | undefined>)[name]!;
    const spy = spyOn(provider, 'available').mockReturnValue(availableNames.includes(name));
    restores.push(() => spy.mockRestore());
  }
  return () => { for (const restore of restores) restore(); };
}

function withAutoChain(fallbackChain: string[]): void {
  setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'auto', fallbackChain } }));
}

describe('LLM-AUTO-FALLBACK-ON-QUOTA 실제 종단 — streamLLM/streamLLMWithTools 429 폴백 (OP #135034 · #135160)', () => {
  test('실제 streamLLM — 429 소진 오류를 체인의 다음 공급자(grok)로 넘겨 응답한다', async () => {
    withAutoChain(['codex-rotate', 'grok']);
    const availability = pinAvailability(['openai-codex', 'grok']);
    const streams = replaceProviderStreams({
      'openai-codex': { fail429: true },
      grok: { answer: 'grok-recovered' },
    });
    try {
      const answer = await streamLLM(
        [{ role: 'user', content: 'question' }],
        () => {},
        { initialProvider: PROVIDERS['openai-codex'] },
      );
      expect(answer).toBe('grok-recovered');
      // 실제 전환 — openai-codex(429 소진) → grok(체인 다음 칸) 순서 그대로.
      expect(streams.calls).toEqual(['openai-codex', 'grok']);
    } finally {
      streams.restore(); availability(); setUserConfigOverlay(null);
    }
  });

  test('실제 streamLLM — 구성 fallbackChain 순서 그대로 시도한다(자동 후보 순서가 아니라 체인 순서 zai→glm 먼저)', async () => {
    // 유효 체인 칸은 FALLBACK_STEPS 6개뿐(oauth/fallback-chain.ts) — 'anthropic' 은 칸 이름이
    // 아니어서 unknown-step 로 건너뛴다. 칸→provider 매핑(retry-policy.ts providerNamesFromFallbackChain):
    // zai→glm · grok→grok · codex-rotate/codex-credits→openai-codex.
    // AUTOMATIC_PROVIDER_ORDER = ['grok','anthropic','gemini','local'] — glm 은 자동 후보에 «없다».
    // 구성 체인 ['zai','grok'] 을 준다: 체인을 따르면 glm 이 grok «앞에» 시도되고, 자동 후보 순서만
    // 따랐다면 glm 은 아예 시도되지 않는다 — 그래서 이 기대값이 순서 판별자다.
    withAutoChain(['zai', 'grok']);
    const availability = pinAvailability(['openai-codex', 'glm', 'grok']);
    const streams = replaceProviderStreams({
      'openai-codex': { fail429: true },
      glm: { fail429: true },
      grok: { answer: 'grok-second-in-chain' },
    });
    try {
      const answer = await streamLLM(
        [{ role: 'user', content: 'question' }],
        () => {},
        { initialProvider: PROVIDERS['openai-codex'] },
      );
      expect(answer).toBe('grok-second-in-chain');
      // 구성 순서(zai→glm 먼저) — 자동 후보 순서(grok 먼저·glm 부재)가 아니라는 것이 이 시험의 요지다.
      expect(streams.calls).toEqual(['openai-codex', 'glm', 'grok']);
    } finally {
      streams.restore(); availability(); setUserConfigOverlay(null);
    }
  });

  test('실제 streamLLM — 체인 전부 429 소진이면 [LLM PROVIDER BLOCKED] 종단 텍스트를 반환한다(영문)', async () => {
    withAutoChain(['codex-rotate', 'grok']);
    const availability = pinAvailability(['openai-codex', 'grok']);
    const streams = replaceProviderStreams({
      'openai-codex': { fail429: true },
      grok: { fail429: true },
    });
    try {
      const answer = await streamLLM(
        [{ role: 'user', content: 'question' }],
        () => {},
        { initialProvider: PROVIDERS['openai-codex'] },
      );
      expect(answer).toContain(FALLBACK_EXHAUST_TITLE);
      expect(answer).toContain('fallback candidates exhausted');
      // 시도한 두 공급자가 모두 종단 텍스트에 남는다(formatProviderFallbackOutput attempts 행).
      expect(answer).toContain('openai-codex');
      expect(answer).toContain('grok');
      // ⛔ 영어 오류 —(/[가-힣]/ 없음). 사람이 다른 자리(런·PR)에서 이 종단을 읽을 때
      //   공급자 폴백 소진임을 영문 그대로 알 수 있어야 한다(OP #135034 «전부 소진 = 영어 오류»).
      expect(answer).not.toMatch(/[가-힣]/);
      expect(streams.calls).toEqual(['openai-codex', 'grok']);
    } finally {
      streams.restore(); availability(); setUserConfigOverlay(null);
    }
  });

  test('실제 streamLLMWithTools — 429 소진 오류를 다음 공급자(grok)로 넘겨 응답한다', async () => {
    withAutoChain(['codex-rotate', 'grok']);
    const availability = pinAvailability(['openai-codex', 'grok']);
    const streams = replaceProviderStreams({
      'openai-codex': { fail429: true },
      grok: { answer: 'grok-tools-recovered' },
    });
    try {
      const answer = await streamLLMWithTools(
        [{ role: 'user', content: 'question' }],
        { onText() {}, dispatchTool: async () => 'unused' },
        {
          initialProvider: PROVIDERS['openai-codex'],
          tools: [{ name: 'noop', description: 'noop', parameters: { type: 'object', properties: {} } }],
        },
      );
      expect(answer).toBe('grok-tools-recovered');
      expect(streams.calls).toEqual(['openai-codex', 'grok']);
    } finally {
      streams.restore(); availability(); setUserConfigOverlay(null);
    }
  });

  test('실제 streamLLMWithTools — 체인 전부 429 소진이면 ProviderFallbackError(exhaust·영문)로 종단한다', async () => {
    withAutoChain(['codex-rotate', 'grok']);
    const availability = pinAvailability(['openai-codex', 'grok']);
    const streams = replaceProviderStreams({
      'openai-codex': { fail429: true },
      grok: { fail429: true },
    });
    try {
      let caught: unknown;
      try {
        await streamLLMWithTools(
          [{ role: 'user', content: 'question' }],
          { onText() {}, dispatchTool: async () => 'unused' },
          {
            initialProvider: PROVIDERS['openai-codex'],
            tools: [{ name: 'noop', description: 'noop', parameters: { type: 'object', properties: {} } }],
          },
        );
      } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(ProviderFallbackError);
      const terminal = caught as ProviderFallbackError;
      expect(terminal.action).toBe('exhaust');
      // 두 시도가 그 순서로 시도 기록(attempts)에 남는다.
      expect(terminal.attempts.map((entry) => entry.provider)).toEqual(['openai-codex', 'grok']);
      // ⛔ 영어 오류 — OP #135034 «전부 소진 = 영어 오류»(ProviderFallbackError.message 는
      //   formatProviderFallbackOutput 결과 그 자미다).
      expect(terminal.message).not.toMatch(/[가-힣]/);
      // 원본 429 오류가 비열거 원인 슬롯에 그대로 보존된다(originalCause).
      expect((terminal.originalCause as { status?: unknown } | undefined)?.status).toBe(429); // 출처: #135034 — 원본 429 보존 단언
      expect(streams.calls).toEqual(['openai-codex', 'grok']);
    } finally {
      streams.restore(); availability(); setUserConfigOverlay(null);
    }
  });
});