/**
 * POD-ANTHROPIC-PROVIDER (0.2.24) — Pod 자식이 받을 수 있는 provider 의 «한 목록».
 *
 * 🩸 10-10 17:36: 발사 관문은 `anthropic` 을 «예산 판정 밖 — launched as requested» 로 통과시켰고,
 *   Pod 단계(`podNamedChildProvider`)가 «openai-codex|grok|openrouter 만» 으로 rc=2 를 냈다 — 관문과 Pod 가 서로 다른 목록을 봤다.
 * ⭐ 이제 발사 관문(`harness ask/say --substrate pod`)과 Pod(`self-implement-pod.ts`)가 이 상수 하나를 본다.
 *   목록 밖 provider 는 발사 «전»에 같은 문면으로 거부된다.
 * ⛔ 이 모듈은 가볍게 둔다(무거운 import 0) — 하니스 CLI 가 Pod 표면 전체를 끌어오지 않게.
 */
// BEDROCK-PROVIDER ② (0.2.24) — bedrock 은 «이름 있는 AWS Secret» 이 클러스터에 있을 때만 뜬다(pod-bedrock-child.ts · 발사 전 거부).
// ZAI-POD-CHILD (0.2.24) — glm 은 Z.ai GLM Coding Plan(정액 구독) · «이름 있는 ZAI Secret» 이 클러스터에 있을 때만 뜬다(pod-zai-child.ts · 발사 전 거부 · 동시 상한 넘치면 정책대로).
export const POD_CHILD_PROVIDERS = ['openai-codex', 'grok', 'openrouter', 'opengateway', 'anthropic', 'bedrock', 'glm'] as const;
export type PodChildProvider = typeof POD_CHILD_PROVIDERS[number];

/** 사람이 쓰는 별칭 → 정식 이름. */
const POD_CHILD_PROVIDER_ALIASES: Readonly<Record<string, PodChildProvider>> = { codex: 'openai-codex' };

/** 이름을 Pod 자식 provider 로 — 목록 밖이면 undefined. */
export function podChildProviderOf(named: string | undefined): PodChildProvider | undefined {
  const id = named?.trim();
  if (!id) return undefined;
  if ((POD_CHILD_PROVIDERS as readonly string[]).includes(id)) return id as PodChildProvider;
  return POD_CHILD_PROVIDER_ALIASES[id];
}

/** 목록 밖이면 거부 문면(관문과 Pod 가 «같은» 문면을 낸다), 안이면 undefined. 이름이 비면 판정하지 않는다. */
export function podChildProviderRefusal(named: string | undefined): string | undefined {
  const id = named?.trim();
  if (!id || podChildProviderOf(id)) return undefined;
  return `pod: Pod 자식 provider 는 ${POD_CHILD_PROVIDERS.join('|')} 만 — 받음 ${id}`;
}

/**
 * BEDROCK-POD-PROVIDER-DROP (0.2.24) — 발사(`index.ts`)가 고른 Pod provider 를 Pod 옵션(`provider` · `account`)으로 옮기는 «한 곳».
 * 🩸 10-11: podBase 가 grok·openrouter·anthropic 만 손으로 나열해 `bedrock` 이 떨어졌다 — Pod 자식은 codex(team) 로 돌았다.
 * ⭐ codex 가 아닌 provider 는 «그 이름»이 곧 account 다(Pod 표면 `plannedAccount` 와 같은 규칙) · codex 만 명시 계정 ?? team.
 */
export function podLaunchProviderOptions(podProvider: PodChildProvider, o: { explicitPodAccount?: string; grokApiKeyOptIn: boolean }): { account: string; provider: PodChildProvider; grokApiKeyOptIn?: boolean } {
  // provider 는 여섯 전부 싣는다 — Pod 의 podChildLlmArgs 는 명시 발사에 provider 가 비면 거부한다(조용한 codex 금지).
  if (podProvider === 'openai-codex') return { account: o.explicitPodAccount ?? 'team', provider: 'openai-codex' };
  return { account: podProvider, provider: podProvider, ...(podProvider === 'grok' ? { grokApiKeyOptIn: o.grokApiKeyOptIn } : {}) };
}
