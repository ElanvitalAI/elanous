// 사용자 자식 모델 선호와 예산 부족 행동을 한 함수로 해석한다.
// 계정 회전은 여기 없다 — 계정이 여럿일 때 기존 회전이 선택된 프로바이더 안에서 한다.

import type {
  BudgetGateMaxUsedPercent,
  BudgetGateOnShortfall,
  ChildLlmChainEntry,
  ChildLlmPreferenceMode,
  UserConfig,
} from '../user-config.js';
import { DEFAULT_BUDGET_GATE } from '../user-config.js';
import { debug } from '../debug/log.js';

export interface ResolvedChildLlmPreference {
  mode: ChildLlmPreferenceMode;
  chain: ChildLlmChainEntry[];
  budgetGate: {
    minHeadroomPercent: number;
    onShortfall: BudgetGateOnShortfall;
    maxUsedPercent?: BudgetGateMaxUsedPercent;
  };
  source: { mode: 'explicit' | 'inferred'; chain: 'config' | 'pinned' | 'fallbackChain' };
}

export type ChildLlmPreferenceInput = Pick<UserConfig, 'tools' | 'llm'> & Partial<Pick<UserConfig, 'harness'>>;

const FALLBACK_NAME_TO_PROVIDER: Readonly<Record<string, string>> = {
  'codex-rotate': 'openai-codex',
  grok: 'grok',
};

function warnPreference(detail: string): void {
  try {
    debug.log('harness.child-llm-preference', 'config-warning', { detail });
  } catch { /* observation must not block resolution */ }
  try {
    process.stderr.write(`[child-llm-preference] ${detail}\n`);
  } catch { /* stderr closed */ }
}

/** `llm.fallbackChain` 이름을 자식 프로바이더 칸으로 옮긴다. 모르는 이름은 경고하고 건너뛴다. */
export function chainFromFallbackNames(names: readonly string[] | undefined): ChildLlmChainEntry[] {
  const chain: ChildLlmChainEntry[] = [];
  for (const name of names ?? []) {
    const provider = FALLBACK_NAME_TO_PROVIDER[name];
    if (!provider) {
      warnPreference(`llm.fallbackChain 의 모르는 이름 '${name}' 을 건너뜀`);
      continue;
    }
    if (!chain.some((entry) => entry.provider === provider)) chain.push({ provider });
  }
  return chain;
}

export function resolveChildLlmPreference(config: ChildLlmPreferenceInput): ResolvedChildLlmPreference {
  const childLlm = config.tools.selfImplement.childLlm;
  const provider = childLlm?.provider?.trim() ? childLlm.provider : undefined;
  // mode 가 없으면 provider 가 있을 때만 pinned. model 만 있어도 provider 가 없으면 auto.
  const explicitMode = childLlm?.mode;
  const mode: ChildLlmPreferenceMode = explicitMode ?? (provider ? 'pinned' : 'auto');
  const modeSource: ResolvedChildLlmPreference['source']['mode'] = explicitMode ? 'explicit' : 'inferred';

  let chain: ChildLlmChainEntry[];
  let chainSource: ResolvedChildLlmPreference['source']['chain'];
  if (mode === 'pinned') {
    // 계정 회전은 여기 없다. provider 없는 model 은 pinned 가 아니다.
    chain = provider
      ? [{ provider, ...(childLlm?.model !== undefined ? { model: childLlm.model } : {}) }]
      : [];
    chainSource = 'pinned';
  } else if (childLlm?.chain && childLlm.chain.length > 0) {
    chain = childLlm.chain.map((entry) => ({
      provider: entry.provider,
      ...(entry.model !== undefined ? { model: entry.model } : {}),
    }));
    chainSource = 'config';
  } else {
    chain = chainFromFallbackNames(config.llm.fallbackChain);
    chainSource = 'fallbackChain';
  }

  const budgetGate = config.harness?.budgetGate ?? { ...DEFAULT_BUDGET_GATE };
  return { mode, chain, budgetGate, source: { mode: modeSource, chain: chainSource } };
}
