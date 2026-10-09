// ⑨ 런컨텍스트 자기인지 (2026-07-20) — elanous 가 "자기가 지금 어떤 환경에서 도는지"(production /
// benchmark / simulator / self-build)를 env 로 인지해 서피스·로깅을 적응한다.
//
// [[PLAN-unified-autonomous-agent-substrate-2026-07-20]] §6·§9. 제1원칙(자기인지)의 실체화.
// 주 소비자 = PTY 로 자식 elanous 를 띄우는 경로(driveHeadlessElanous): 자율빌드/시뮬 컨텍스트면
// telegram/discord/nexus autostart 등 outward 서피스를 억제해 운영 데몬과 충돌(409)·노이즈를 막는다.
// ⚠️ 헤드리스 subcommand 경로(chat/self implement)는 서피스를 애초에 안 띄우므로 이 신호가 no-op.
// per-run 관측 신호라 env 허용([[feedback_config_over_env]] 예외 — per-run observation).

import { normalizeChildLlmProvider } from '../self-dev/dev-cli.js';
import { providerEnvKey } from '../llm/provider-credentials.js';

export type RunContext = 'production' | 'benchmark' | 'simulator' | 'self-build';

const CONTEXTS: readonly RunContext[] = ['production', 'benchmark', 'simulator', 'self-build'];

/** 이 프로세스의 런컨텍스트(부모가 env ELANOUS_RUN_CONTEXT 로 주입·기본 production). */
export function getRunContext(): RunContext {
  const raw = (process.env.ELANOUS_RUN_CONTEXT ?? '').trim() as RunContext;
  return (CONTEXTS as readonly string[]).includes(raw) ? raw : 'production';
}

/** 자율빌드/측정/시뮬 컨텍스트인가 — outward 서피스(telegram/discord/nexus) 억제 대상. */
export function isAutonomousRunContext(): boolean {
  return getRunContext() !== 'production';
}

/** 자식 프로세스 env 에 실을 런컨텍스트. 부모 spawn 시 `{ ...env, ...childRunContextEnv('self-build') }`. */
export function childRunContextEnv(ctx: RunContext): Record<string, string> {
  return { ELANOUS_RUN_CONTEXT: ctx };
}

/** 자식 spawn(replace env)에 provider API key 릴레이(2026-07-22 대표) — 자식이 부모와 **다른 provider**를
 *  써야 할 때(예: self-dev escalate → opus/anthropic) 부모 env 의 그 provider 키를 명시 전파한다. spawn env 는
 *  replace 라 자동 상속 안 되므로(childRunContextEnv 동형 릴레이 패턴), 여기서 실어 자식이 인증할 수 있게 한다.
 *  키가 부모 env 에 없으면 {}(자식은 config auth.json 으로 폴백).
 *
 *  ⭐ 2026-07-26 — 사설 PROVIDER_ENV_KEY 를 **삭제**하고 `providerEnvKey()` SSOT 로 위임했다. 종전엔 이 맵과
 *  model-catalog `envKey` 가 이중화돼 "정합" 이라 적어놓고 실제로는 어긋나 있었다(kimi/qwen/glm 은 catalog 에만
 *  있어 여기선 릴레이가 조용히 누락). SSOT 는 catalog 파생 + 명시 오버레이(openai-codex 등)다. */
export function childProviderKeyEnv(provider: string | undefined): Record<string, string> {
  const key = providerEnvKey(provider);
  const val = key ? process.env[key] : undefined;
  return key && val ? { [key]: val } : {};
}

/** 자식 LLM 이 낼 «추론 노력». ⛔ 모델마다 상한(`reasoningEffortCeiling`)이 다르다. */
export type ChildLlmEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ChildLlmSelection {
  provider: string;
  model: string;
  /** ⭐ 판마다 주는 추론 노력. ⛔ 안 주면 «종전»(전역 config·모델 기본)이다 — 「medium」이 아니다. */
  effort?: ChildLlmEffort;
  /** 선택이 CLI 플래그에서 왔나, self-dev 설정에서 왔나. 같은 모델이라도 다른 사실이다. */
  source: 'flag' | 'config';
  /** Grok weekly cap rerouted this run to Codex: allow prepaid credits even when subscription quota is exhausted. */
  codexQuotaPolicy?: 'credits';
}

/** ⭐⭐ **가르는 축은 「키냐 주소냐」가 «아니라» 「그 자격이 «파일»에 사나 «env»에 사나」다**
 *  (2026-08-14 `[T]` 정정 · 이 함수의 초판 이름·주석이 그 축을 «provider 이름»으로 좁혀 잡았다):
 *    · 홈 파일 자격(예: 구독 OAuth `~/.grok/auth.json`) → 자식이 «그대로 읽는다» ⇒ 릴레이 «불요»
 *    · env 로만 오는 자격/주소(로컬 OpenAI-compat 엔드포인트) → ⛔ 릴레이가 «없으면 자식이 못 부른다»
 *  ⇒ 📌 새 provider 를 붙일 때 물을 것은 하나다 — ***「이 자격은 어디 사나」***.
 *
 *  OpenAI-compat 로컬 provider 는 그 축에서 «env» 쪽이라 주소를 명시 릴레이한다
 *  (`childProviderKeyEnv` 동형 — spawn env 는 replace 라 자동 상속이 없다).
 *
 *  ⛔ 2026-08-14 실측: 이 릴레이가 «없어서» `--child-llm-provider local` 로 띄운 자식이
 *  `❌ Local LLM unavailable: set llm.baseUrl … or LOCAL_LLM_URL env` 로 서고 **파일을 하나도 안 건드린 채**
 *  abandoned 됐다. 그 런을 하마터면 「그 모델이 못 한다」로 읽을 뻔했다 — 모델은 «호출조차» 안 됐다.
 *  ⚠️ 부모가 노드 캐시로 주소를 푸는 경우는 이 릴레이가 못 덮는다(부모 env 에 없으면 빈 값) —
 *  그때는 부모 env 에 명시로 주고 띄운다. 캐시까지 넘기는 것은 이 자리의 몫이 아니다. */
function childLocalEndpointEnv(provider: string): Record<string, string> {
  if (provider !== 'local') return {};
  const url = process.env.LOCAL_LLM_URL?.trim();
  return url ? { LOCAL_LLM_URL: url } : {};
}

/** The family classifier is model-id based, so preserve local-provider identity
 * across the replace-env child boundary without changing non-local model IDs. */
function childRelayModel(provider: string, model: string): string {
  if (provider !== 'local' || !model || model.toLowerCase().startsWith('local:')) return model;
  return `local:${model}`;
}

/** 자식 spawn(replace env)에 LLM 선택을 명시 릴레이한다. 선택을 주지 않으면 부모 선택을 그대로 상속한다.
 * 명시 선택은 호출 단위로 자식에만 적용하며, 해당 provider의 부모 자격 키(로컬이면 엔드포인트)도 함께 릴레이한다. */
export function childLlmSelectionEnv(selection?: ChildLlmSelection): Record<string, string> {
  if (selection) {
    const provider = normalizeChildLlmProvider(selection.provider);
    return {
      ELANOUS_LLM_PROVIDER: provider,
      ELANOUS_LLM_MODEL: childRelayModel(provider, selection.model),
      ...(selection.codexQuotaPolicy === 'credits' && provider === 'openai-codex'
        ? { ELANOUS_CODEX_QUOTA_POLICY: 'credits' } : {}),
      // ⛔⭐ 새 env 이름을 «짓지 않는다» — `ELANOUS_ESCALATE_EFFORT` 가 «이미» 있고
      //    `user-config.ts` 가 그것으로 `reasoningLevel`(anthropic)과
      //    `codexReasoning.effort`(openai-codex/sol) 를 ***둘 다*** 덮는다.
      //    ⇒ 여기서는 「판마다 주는 길」만 잇는다. 재발명 0.
      ...(selection.effort ? { ELANOUS_ESCALATE_EFFORT: selection.effort } : {}),
      ...childProviderKeyEnv(provider),
      ...childLocalEndpointEnv(provider),
    };
  }
  // ⛔⭐ 상속 갈래도 local 이면 «주소»를 같이 넘긴다(BACKLOG B12 · 2026-09-25).
  //   🩸 부모 env `ELANOUS_LLM_PROVIDER=local` ⊕ `LOCAL_LLM_URL=<node-b 경유 프록시>` 로 띄웠는데 자식엔 provider·model 만 가고
  //     주소가 빠져, 자식이 노드 캐시로 «호스트» LM Studio(127.0.0.1:1234)에 붙었다 — 준 엔드포인트가 조용히 무시됐다.
  const inheritedProvider = process.env.ELANOUS_LLM_PROVIDER?.trim();
  return {
    ...(process.env.ELANOUS_LLM_PROVIDER !== undefined ? { ELANOUS_LLM_PROVIDER: process.env.ELANOUS_LLM_PROVIDER } : {}),
    ...(process.env.ELANOUS_LLM_MODEL !== undefined ? { ELANOUS_LLM_MODEL: process.env.ELANOUS_LLM_MODEL } : {}),
    ...(inheritedProvider ? childLocalEndpointEnv(inheritedProvider) : {}),
  };
}
