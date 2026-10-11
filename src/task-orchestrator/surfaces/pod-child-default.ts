/** SUBSCRIPTION-EXHAUST-REROUTE (0.2.24 · P0) — Pod 구현 자식의 «기본» 모델을 codex 밖으로 뺀다.
 *
 *  🩸 10-11 실측(apiEq 24h): codex 소모의 ~95% 가 node-b Pod 구현 자식이었다($2,633 · 107런). 원인은
 *    자식 모델을 안 준 Pod 발사가 `planPodProvider` 로 codex(gpt-6-sol)에 떨어진 것이다.
 *  ⭐ 결정 지점은 «호스트가 발사 인자를 만드는 곳»(`self orchestrate --substrate pod`) — 여기서 «자식 모델 없음 → 기본값»을
 *    `--child-llm-provider/--child-llm-model` 과 «같은 모양»으로 채운다. 그 뒤 경로(키 확인·passEnv·Job 인자)는 명시 발사와 같다.
 *  ⛔ 명시(`--child-llm-*`)가 있으면 손대지 않는다 · `--bench-arms`(팔마다 모델) · `--pod-account`(codex 계정 고정 = 사람의 선택)도 손대지 않는다.
 *  ⛔ 기본값이 «못 서면»(OpenRouter 키 없음) 종전 codex 경로로 간다 — 기본값 때문에 발사가 죽지 않는다(관측은 남긴다).
 *  config = `tools.selfImplement.podChildDefault`: `{ provider, model? }` · `'off'`(종전 codex 기본). 없으면 아래 상수. */

/** 대표 라우팅 «중» 시작 모델 — OpenRouter 키는 Pod 에 이미 있다(새 자격 0). */
export const POD_CHILD_DEFAULT = { provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3' } as const;

export type PodChildDefaultDecision =
  | { apply: true; provider: string; model?: string; source: 'config' | 'default' }
  | { apply: false; reason: 'flag' | 'bench-arms' | 'pod-account' | 'config-off' | 'no-openrouter-key'; provider?: string; model?: string; source?: 'config' | 'default' };

function parseConfigValue(raw: unknown): { value: { provider: string; model?: string } | 'off'; source: 'config' } | { value: typeof POD_CHILD_DEFAULT; source: 'default'; invalid?: unknown } {
  if (raw === undefined) return { value: POD_CHILD_DEFAULT, source: 'default' };
  if (raw === 'off' || raw === false) return { value: 'off', source: 'config' };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const v = raw as Record<string, unknown>;
    const provider = typeof v.provider === 'string' ? v.provider.trim() : '';
    const model = typeof v.model === 'string' ? v.model.trim() : '';
    if (provider) return { value: { provider, ...(model ? { model } : {}) }, source: 'config' };
  }
  return { value: POD_CHILD_DEFAULT, source: 'default', invalid: raw };
}

/** 순수 판정 — 「무엇을 보고 정했나」가 인자에 다 있다. */
export function resolvePodChildDefault(input: {
  flags: { provider?: string; model?: string; effort?: string };
  benchArms: boolean;
  explicitPodAccount?: string;
  config: unknown;
  /** OpenRouter 키가 호스트에 «있나»(값은 안 본다) — openrouter 기본일 때만 묻는다. */
  openrouterKeyPresent: () => boolean;
}): PodChildDefaultDecision & { invalidConfig?: unknown } {
  if (input.flags.provider?.trim() || input.flags.model?.trim() || input.flags.effort?.trim()) return { apply: false, reason: 'flag' };
  if (input.benchArms) return { apply: false, reason: 'bench-arms' };
  if (input.explicitPodAccount?.trim()) return { apply: false, reason: 'pod-account' };
  const parsed = parseConfigValue(input.config);
  const invalid = 'invalid' in parsed ? { invalidConfig: parsed.invalid } : {};
  if (parsed.value === 'off') return { apply: false, reason: 'config-off', source: 'config' };
  const { provider, model } = parsed.value as { provider: string; model?: string };
  if (provider === 'openrouter' && !input.openrouterKeyPresent()) {
    return { apply: false, reason: 'no-openrouter-key', provider, ...(model ? { model } : {}), source: parsed.source, ...invalid };
  }
  return { apply: true, provider, ...(model ? { model } : {}), source: parsed.source, ...invalid };
}
