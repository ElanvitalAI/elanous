// ── BEDROCK-PROVIDER — 공급자 본체(`makeBedrockProvider`) ──
//
// ⭐ OP Q3(10-11): `llm.ts` 에 새 provider 를 통째로 더하지 않는다 — 첫 «분리된 공급자» 선례(RFC #25983 방향).
//   자격·리전·서명·모델 id = `./bedrock.ts` · 이 파일 = 공급자 본체 · `llm.ts` = import ⊕ 표 배선만.
// ⛔ 순환 방지: `../llm.js` 는 «타입»만 정적으로 가져오고, 값(Anthropic 메시지 변환·추론 배선·SSE 파서)은
//   호출 때 동적 import 한다 — llm.ts 가 이 모듈을 정적으로 import 해도 로드 순서가 꼬이지 않는다.

import type { LLMProvider } from '../llm.js';
import type { LLMConfig as UCLLMConfig } from '../user-config.js';
import { debug, redactSecrets } from '../debug/log.js';
import { fetchApiWithRetry } from '../session-runtime/retry-api.js';
import { isVisionCapableModel } from '../llm-vision-capability.js';
import * as bedrock from './bedrock.js';

/** BEDROCK-PROVIDER 시험 seam — 자격·서명·HTTP 를 주입한다(실 AWS 호출 0). */
export interface BedrockProviderDeps {
  env?: Record<string, string | undefined>;
  resolveCredentials?: import('./bedrock.js').BedrockCredentialResolver;
  sign?: import('./bedrock.js').BedrockSigner;
  /** HTTP 송신 — 기본은 `fetchApiWithRetry`(재시도·과부하 폴백 공용). */
  send?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * ⭐ AWS Bedrock 의 Claude(«Claude in Amazon Bedrock» 메시지 엔드포인트 · SigV4 `bedrock-mantle`).
 * 몸·SSE 는 Anthropic 1st-party 와 같은 꼴이라 ***메시지 변환·캐시 4슬롯·SSE 파서를 그대로 쓴다*** —
 * 다른 것은 «주소 ⊕ 서명 ⊕ 모델 id(`anthropic.` 접두)» 셋뿐이다.
 * ⛔ 명시(provider=bedrock)할 때만 고른다 — 자동 순서·폴백 체인에 «없다».
 * ⚠️ `anthropic-beta` 헤더는 싣지 않는다(이 엔드포인트의 수용 여부 미확인 · 5.5 계열은 adaptive 가 기본이다).
 */
export function makeBedrockProvider(cfg: UCLLMConfig, deps: BedrockProviderDeps = {}): LLMProvider {
  const configuredModel = cfg.model ? bedrock.resolveBedrockModelId(cfg.model) : bedrock.BEDROCK_DEFAULT_MODEL;
  const envDeps = deps.env ? { env: deps.env } : {};
  return {
    name: 'bedrock',
    defaultModel: configuredModel,
    available: () => bedrock.bedrockAvailable(envDeps),
    async *streamChat(messages, opts = {}) {
      const {
        toAnthropicMessage, effectiveReasoningLevel, usesAdaptiveThinking,
        mapReasoningLevelToAnthropicThinking, mapReasoningLevelToAnthropicEffort,
        anthropicTemperatureField, parseAnthropicSSELines, sseLineStream, retryOptsFor,
      } = await import('../llm.js');
      const region = bedrock.resolveBedrockRegion(envDeps);
      if (!region) {
        throw new Error('Bedrock unavailable: AWS 리전이 없다 — AWS_REGION(또는 AWS_DEFAULT_REGION) 또는 ~/.aws/config 프로필 region');
      }
      const wireModel = bedrock.resolveBedrockModelId(opts.model || configuredModel);
      // 계열 판정(adaptive·vision·temperature)은 1st-party 꼴 id 로 — 헬퍼들이 `anthropic.` 접두를 모른다.
      const familyModel = bedrock.bedrockCanonicalClaudeId(wireModel);
      // ⭐ 캐시: Anthropic 공급자와 «같은 자리» 4슬롯(system·tools·history·anchor).
      const { getDefaultCacheTTL } = await import('../config.js');
      const cache = opts.promptCache !== false;
      const ttl = opts.promptCacheTTL ?? getDefaultCacheTTL();
      const {
        toAnthropicSystemBlocks, toAnthropicToolsCached,
        applyHistoryCacheBreakpoint, applyAnchorCacheBreakpoint,
      } = await import('../prompt-cache/anthropic.js');
      const system = toAnthropicSystemBlocks(messages, { cache, ttl });
      const acceptUserImages = isVisionCapableModel('anthropic', familyModel, 'userMessage');
      let convo = messages
        .filter(m => m.role !== 'system')
        .map(m => toAnthropicMessage(m, { acceptUserMessageImages: acceptUserImages }));
      convo = applyAnchorCacheBreakpoint(convo, { cache, ttl });
      convo = applyHistoryCacheBreakpoint(convo, { cache, ttl });
      const tools = toAnthropicToolsCached(opts.tools, { cache, ttl });
      // makeAnthropicProvider 와 같은 추론 배선 — 4.8+/5.x 는 adaptive ⊕ output_config.effort.
      const effLevel = effectiveReasoningLevel(cfg, 'anthropic', familyModel);
      const adaptive = usesAdaptiveThinking(familyModel);
      const thinking = adaptive ? undefined : mapReasoningLevelToAnthropicThinking(effLevel);
      const effort = adaptive ? mapReasoningLevelToAnthropicEffort(effLevel) : undefined;
      const thinkingActive = Boolean(thinking) || Boolean(effort);
      const maxTokens = thinking
        ? Math.max(opts.maxTokens ?? 2048, Math.floor(thinking.budget_tokens * 1.5) + 2048)
        : effort
          ? Math.max(opts.maxTokens ?? 8192, 8192)
          : (opts.maxTokens ?? 2048);
      const body = {
        model: wireModel,
        messages: convo,
        ...(system !== undefined ? { system } : {}),
        max_tokens: maxTokens,
        ...(thinking ? { thinking } : {}),
        ...(effort ? { thinking: { type: 'adaptive' }, output_config: { effort } } : {}),
        ...anthropicTemperatureField(familyModel, thinkingActive, opts.temperature),
        ...(tools ? { tools } : {}),
      };
      const signRequest = () => bedrock.buildSignedBedrockRequest({
        region,
        body,
        ...(deps.env ? { env: deps.env } : {}),
        ...(deps.resolveCredentials ? { resolveCredentials: deps.resolveCredentials } : {}),
        ...(deps.sign ? { sign: deps.sign } : {}),
      });
      let signed: Awaited<ReturnType<typeof signRequest>>;
      try {
        signed = await signRequest();
      } catch (err) {
        debug.log('llm.bedrock', 'credentials-unresolved', {
          provider: 'bedrock', region, model: wireModel,
          // ⛔ 임의 err.name 을 싣지 않는다 — 우리 에러면 그 고정 이름, 아니면 허용 목록/고정 문자열.
          errName: err instanceof bedrock.BedrockCredentialsUnresolvedError ? err.name : bedrock.sanitizeCredentialErrorName(err),
          credentialSignal: bedrock.bedrockCredentialSignalLabel(envDeps),
        }, { level: 'warn' });
        throw err;
      }
      debug.log('llm.bedrock', 'request', {
        provider: 'bedrock', region, model: wireModel,
        auth: signed.headers['x-api-key'] !== undefined ? 'bearer' : 'sigv4',
        cache, ttl, tools: opts.tools?.length ?? 0,
      });
      // ⛔ redirect:'error' — 검증한 호스트 밖으로 리다이렉트를 따라가 자격 헤더(x-api-key·x-amz-security-token)가 새지 않게.
      const toInit = (req: typeof signed): RequestInit => ({
        method: 'POST', headers: req.headers, body: req.body, redirect: 'error', ...(opts.signal ? { signal: opts.signal } : {}),
      });
      const init = toInit(signed);
      // ⭐ 재시도마다 다시 서명한다 — SigV4 는 `x-amz-date` 기준 수 분만 유효(긴 retry-after 뒤 옛 서명은 403).
      const response = deps.send
        ? await deps.send(signed.url, init)
        : await fetchApiWithRetry(signed.url, init, {
          ...retryOptsFor('bedrock', 'Bedrock API', opts.remainingFallbacks),
          refreshInit: async () => toInit(await signRequest()),
        });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Bedrock API ${response.status}: ${redactSecrets(text).slice(0, 500)}`);
      }
      try {
        for await (const ev of parseAnthropicSSELines(sseLineStream(response.body!))) {
          if (ev.type === 'usage') {
            // ⭐ 벤치 «캐시 칸 맞대기» — provider=bedrock 과 cachedInput 을 한 줄에.
            debug.log('llm.bedrock', 'usage', {
              provider: 'bedrock', region, model: wireModel,
              inputTokens: ev.usage.inputTokens ?? 0,
              outputTokens: ev.usage.outputTokens ?? 0,
              cachedInput: ev.usage.cacheReadInputTokens ?? 0,
              cacheCreationInput: ev.usage.cacheCreationInputTokens ?? 0,
            });
          }
          yield ev;
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        throw err;
      }
    },
    async *chat(messages, opts = {}) {
      const { textOnly } = await import('../llm.js');
      yield* textOnly(this.streamChat!(messages, opts));
    },
  };
}

/** PROVIDERS.bedrock — 설정 무관 기본 인스턴스를 처음 쓸 때 한 번 만든다(가용 판정은 호출 때 env·파일을 다시 본다). */
let bedrockSingletonInstance: LLMProvider | undefined;
function bedrockSingleton(): LLMProvider {
  bedrockSingletonInstance ??= makeBedrockProvider({ provider: 'bedrock' });
  return bedrockSingletonInstance;
}

export const BedrockProvider: LLMProvider = {
  name: 'bedrock',
  get defaultModel() { return bedrockSingleton().defaultModel; },
  available: () => bedrockSingleton().available(),
  streamChat: (messages, opts = {}) => bedrockSingleton().streamChat!(messages, opts),
  chat: (messages, opts = {}) => bedrockSingleton().chat(messages, opts),
};

/** bedrock 이 받는 모델 꼴 — `anthropic.claude-…`·`bedrock/…` ⊕ 1st-party claude id ⊕ 모르는 꼴(추론 프로필 ARN 등 · 엔드포인트가 판정).
 *  `inferProvider` 는 llm.ts 의 추론기를 인자로 받는다(순환 없이). */
export function isBedrockCompatibleModel(model: string, inferProvider: (m: string) => string | null): boolean {
  if (bedrock.isBedrockModelId(model)) return true;
  const implied = inferProvider(model);
  return implied === null || implied === 'anthropic';
}
