// 발사 전 «이번 판을 누구로 · 돌릴까 말까» — 순수 판정과 읽기를 가른다.
// 회전·사용량 저장소·선호 해석은 기존 함수를 부른다. 여기선 다시 만들지 않는다.

import type { RotationCandidate } from '../oauth/codex-account-rotation.js';
import { inspectCodexRotation } from '../oauth/codex-account-store.js';
import { codexPolicyAllowsCredits } from '../oauth/codex-quota-policy.js';
import { getUsageStore } from '../budget/usage-store.js';
import type { UsageSnapshot } from '../budget/types.js';
import { debug } from '../debug/log.js';
import {
  DEFAULT_BUDGET_GATE_MAX_USED_PERCENT,
  LAUNCH_GROK_USED_PERCENT_CAP,
  type BudgetGateMaxUsedPercent,
  type BudgetGateOnShortfall,
} from '../user-config.js';
import {
  resolveChildLlmPreference,
  type ChildLlmPreferenceInput,
  type ResolvedChildLlmPreference,
} from './child-llm-preference.js';

export const CODEX_PROVIDER = 'openai-codex';
export const GROK_PROVIDER = 'grok';

export type BudgetAction = 'proceed' | 'next-provider' | 'wait-reset' | 'stop';

export interface BudgetCodexCandidate {
  readonly name: string;
  readonly reached?: boolean;
  readonly usedPercent?: number;
  /** 선불 크레딧 잔액(계정에 귀속된 신호만). 모르면 비운다. */
  readonly creditBalance?: number;
  readonly hasCredits?: boolean;
}

export interface DecideBudgetInput {
  readonly preference: {
    readonly chain: readonly { readonly provider: string; readonly model?: string }[];
    readonly budgetGate: { readonly onShortfall: BudgetGateOnShortfall };
  };
  readonly codexCandidates: readonly BudgetCodexCandidate[];
  /** 주간 사용률. `undefined` 는 «모름» — 쓸 수 있다고 보지 않는다. */
  readonly grokUsedPercent: number | undefined;
  readonly maxUsedPercent: BudgetGateMaxUsedPercent;
  /** codex 한도 정책이 credits 인가(`codexPolicyAllowsCredits` · 회전·Pod 배분과 같은 해석). 없으면 false. */
  readonly codexCreditsAllowed?: boolean;
}

export interface BudgetDecision {
  readonly action: BudgetAction;
  readonly provider?: string;
  readonly model?: string;
  readonly reasons: readonly string[];
}

export interface BudgetInputs {
  readonly preference: ResolvedChildLlmPreference;
  readonly codexCandidates: readonly BudgetCodexCandidate[];
  readonly grokUsedPercent: number | undefined;
  readonly maxUsedPercent: BudgetGateMaxUsedPercent;
  readonly codexCreditsAllowed?: boolean;
}

const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

function capFor(maxUsedPercent: BudgetGateMaxUsedPercent, provider: string): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(maxUsedPercent, provider)) {
    const fallback = DEFAULT_BUDGET_GATE_MAX_USED_PERCENT[provider];
    return typeof fallback === 'number' ? fallback : undefined;
  }
  const configured = maxUsedPercent[provider];
  // 칸을 비우거나 지운 값(undefined)은 상한 없음. 숫자만 상한이다.
  return typeof configured === 'number' && Number.isFinite(configured) ? configured : undefined;
}

function formatPercent(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? '모름' : `${value}%`;
}

/** codex 칸 한 줄. 예: «codex: default 100%·team 95%·third 96% ≥ 95» */
export function formatCodexReason(candidates: readonly BudgetCodexCandidate[], cap: number | undefined): string {
  const capLabel = cap === undefined ? '상한없음' : String(cap);
  if (candidates.length === 0) return `codex: 후보 없음 ≥ ${capLabel}`;
  const parts = candidates.map((candidate) => {
    if (candidate.reached === true && candidate.usedPercent === undefined) {
      return `${candidate.name} 한도도달`;
    }
    return `${candidate.name} ${formatPercent(candidate.usedPercent)}`;
  });
  const anyUsable = cap !== undefined && candidates.some((candidate) => codexCandidateUsable(candidate, cap));
  const relation = anyUsable ? '<' : '≥';
  return `codex: ${parts.join('·')} ${relation} ${capLabel}`;
}

/** grok 칸 한 줄. 모르면 «grok: 모름». 예: «grok: 7% < 48» */
export function formatGrokReason(usedPercent: number | undefined, cap: number | undefined): string {
  if (usedPercent === undefined || !Number.isFinite(usedPercent)) return 'grok: 모름';
  if (cap === undefined) return `grok: ${usedPercent}% (상한 없음)`;
  const relation = usedPercent < cap ? '<' : '≥';
  return `grok: ${usedPercent}% ${relation} ${cap}`;
}

function codexCandidateUsable(candidate: BudgetCodexCandidate, cap: number | undefined): boolean {
  if (cap === undefined) return false;
  if (candidate.reached === true) return false;
  if (typeof candidate.usedPercent !== 'number' || !Number.isFinite(candidate.usedPercent)) return false;
  return candidate.usedPercent < cap;
}

/** BUDGET-GATE(10-05) — 정책이 credits 면 구독 % 가 차도 크레딧 잔액이 «확인된» 계정으로 계속 간다(Pod 배분과 같은 결론).
 *  잔액을 모르면 쓰지 않는다 — 크레딧은 돈이라 fail-closed. 잔액이 가장 큰 계정 하나를 돌려준다. */
function codexCreditCandidate(input: DecideBudgetInput): BudgetCodexCandidate | undefined {
  if (input.codexCreditsAllowed !== true) return undefined;
  return input.codexCandidates
    .filter((candidate) => candidate.hasCredits !== false
      && typeof candidate.creditBalance === 'number' && Number.isFinite(candidate.creditBalance) && candidate.creditBalance > 0)
    .sort((a, b) => (b.creditBalance! - a.creditBalance!) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0];
}

function slotUsable(
  provider: string,
  input: DecideBudgetInput,
  allowUnmeasured = false,
): { usable: boolean; reason: string; unmeasured?: boolean } {
  if (provider === CODEX_PROVIDER) {
    const cap = capFor(input.maxUsedPercent, CODEX_PROVIDER);
    const measuredUsable = input.codexCandidates.some((candidate) => codexCandidateUsable(candidate, cap));
    const credit = measuredUsable ? undefined : codexCreditCandidate(input);
    if (credit) {
      try {
        debug.log('budget.gate', 'credits-allowed', { used: credit.usedPercent ?? null, balance: credit.creditBalance, policy: 'credits' });
      } catch { /* observation is fail-soft */ }
      return { usable: true, reason: `${formatCodexReason(input.codexCandidates, cap)} · credits allowed (balance ${credit.creditBalance})` };
    }
    const unmeasured = allowUnmeasured && !measuredUsable && (input.codexCandidates.length === 0
      || input.codexCandidates.some((candidate) => candidate.reached !== true
        && (typeof candidate.usedPercent !== 'number' || !Number.isFinite(candidate.usedPercent))));
    return { usable: measuredUsable || unmeasured, reason: formatCodexReason(input.codexCandidates, cap), ...(unmeasured ? { unmeasured: true } : {}) };
  }
  if (provider === GROK_PROVIDER) {
    const configured = capFor(input.maxUsedPercent, GROK_PROVIDER);
    // 발사 관문은 `elanous usage` 와 같은 주간 사용률에 80% 상한을 실제로 적용한다.
    // «못 쟀다»(undefined)는 통과가 아니다. decideBudget 은 설정 상한을 그대로 쓴다.
    const cap = allowUnmeasured ? LAUNCH_GROK_USED_PERCENT_CAP : configured;
    const known = typeof input.grokUsedPercent === 'number' && Number.isFinite(input.grokUsedPercent);
    const usable = cap === undefined
      ? known
      : known && (input.grokUsedPercent as number) < cap;
    return {
      usable,
      reason: formatGrokReason(input.grokUsedPercent, cap),
    };
  }
  return { usable: false, reason: `${provider}: 예산 판정 없음` };
}

/**
 * 선호 chain 을 차례로 본다.
 * 첫 칸이 쓸 수 있으면 proceed, 첫 칸은 못 쓰고 뒤 칸이 되면 next-provider,
 * 아무것도 못 쓰면 onShortfall 이 wait-reset 일 때만 wait-reset, 아니면 stop.
 */
export function decideBudget(input: DecideBudgetInput): BudgetDecision {
  return decideBudgetWithPolicy(input, false).decision;
}

/** Only the harness launch gate treats an unmeasured provider as launchable. */
export function decideLaunchBudget(input: DecideBudgetInput): { decision: BudgetDecision; unmeasuredProvider?: string } {
  return decideBudgetWithPolicy(input, true);
}

function decideBudgetWithPolicy(input: DecideBudgetInput, allowUnmeasured: boolean): { decision: BudgetDecision; unmeasuredProvider?: string } {
  const reasons: string[] = [];
  if (input.preference.chain.length === 0) {
    reasons.push('chain: 비었음 — tools.selfImplement.childLlm.chain 도 llm.fallbackChain 도 없다');
  }
  let firstUnusable = false;
  for (let index = 0; index < input.preference.chain.length; index++) {
    const slot = input.preference.chain[index]!;
    const judged = slotUsable(slot.provider, input, allowUnmeasured);
    reasons.push(judged.reason);
    if (!judged.usable) {
      if (index === 0) firstUnusable = true;
      continue;
    }
    const action: BudgetAction = index === 0 || !firstUnusable ? 'proceed' : 'next-provider';
    return {
      decision: {
        action,
        provider: slot.provider,
        ...(slot.model !== undefined ? { model: slot.model } : {}),
        reasons,
      },
      ...(judged.unmeasured ? { unmeasuredProvider: slot.provider } : {}),
    };
  }
  const onShortfall = input.preference.budgetGate.onShortfall;
  return {
    decision: { action: onShortfall === 'wait-reset' ? 'wait-reset' : 'stop', reasons },
  };
}

/** grok 스냅숏의 주간 창 `used`. 창이 없으면 «모름». */
export function grokWeeklyUsedPercent(snapshot: UsageSnapshot | undefined): number | undefined {
  if (!snapshot) return undefined;
  const weekly = snapshot.windows.find((window) => window.kind === 'weekly')
    ?? snapshot.windows.find((window) => window.windowMinutes >= WEEKLY_WINDOW_MINUTES);
  if (!weekly) return undefined;
  return Number.isFinite(weekly.used) ? weekly.used : undefined;
}

export function codexCandidatesFromRotation(
  candidates: readonly RotationCandidate[],
): BudgetCodexCandidate[] {
  return candidates.map((candidate) => ({
    name: candidate.name,
    ...(candidate.reached !== undefined ? { reached: candidate.reached } : {}),
    ...(candidate.usedPercent !== undefined ? { usedPercent: candidate.usedPercent } : {}),
    ...(candidate.creditBalance !== undefined ? { creditBalance: candidate.creditBalance } : {}),
    ...(candidate.hasCredits !== undefined ? { hasCredits: candidate.hasCredits } : {}),
  }));
}

export interface ReadBudgetInputsDeps {
  readonly config?: ChildLlmPreferenceInput;
  readonly loadConfig?: () => ChildLlmPreferenceInput;
  readonly inspectCodex?: typeof inspectCodexRotation;
  readonly grokSnapshot?: () => UsageSnapshot | undefined;
}

/** 설정·codex 회전·grok 스냅숏을 읽어 판정 입력을 만든다. 판정 자체는 하지 않는다. */
export function readBudgetInputs(deps: ReadBudgetInputsDeps = {}): BudgetInputs {
  const config = deps.config ?? deps.loadConfig?.() ?? loadLiveConfig();
  const preference = resolveChildLlmPreference(config);
  const rotation = (deps.inspectCodex ?? inspectCodexRotation)();
  const snapshot = deps.grokSnapshot
    ? deps.grokSnapshot()
    : getUsageStore().getSnapshot('grok');
  const maxUsedPercent = preference.budgetGate.maxUsedPercent ?? { ...DEFAULT_BUDGET_GATE_MAX_USED_PERCENT };
  return {
    preference,
    codexCandidates: codexCandidatesFromRotation(rotation.candidates),
    grokUsedPercent: grokWeeklyUsedPercent(snapshot),
    maxUsedPercent,
    // 회전·Pod 배분과 같은 해석(`resolveCodexQuotaPolicy` → `codexPolicyAllowsCredits`)을 읽는다 — 다시 짓지 않는다.
    ...(rotation.policy && codexPolicyAllowsCredits(rotation.policy.policy) ? { codexCreditsAllowed: true } : {}),
  };
}

/** `elanous usage` 와 같은 조회(`collectUnifiedUsage`)로 grok 주간 사용률을 읽는다.
 *  ⭐ 메모리 스냅숏(`getUsageStore`)은 데몬 «안»에서만 채워진다 — CLI 프로세스에선 비어 «모름»이 된다(2026-09-27 실측: grok 7% 인데 `grok: 모름 → stop`). 못 읽으면 undefined(«모름»). */
export async function readLiveGrokUsedPercent(
  collect: () => Promise<{ rows: ReadonlyArray<{ provider: string; credits: unknown }> }> = async () => {
    const { collectUnifiedUsage } = await import('../budget/unified-usage.js');
    return collectUnifiedUsage();
  },
): Promise<number | undefined> {
  try {
    const report = await collect();
    const row = report.rows.find((r) => r.provider === 'grok');
    const credits = row?.credits;
    const used = credits && typeof credits === 'object' && 'usedPercent' in credits
      ? (credits as { usedPercent: unknown }).usedPercent
      : undefined;
    return typeof used === 'number' && Number.isFinite(used) ? used : undefined;
  } catch {
    return undefined;
  }
}

/** CLI 용 — 스냅숏이 «모름»이면 실제 조회로 채운다(판정 입력 모양은 같다). */
export async function readBudgetInputsLive(
  deps: ReadBudgetInputsDeps & { readLiveGrok?: () => Promise<number | undefined> } = {},
): Promise<BudgetInputs> {
  const inputs = readBudgetInputs(deps);
  if (inputs.grokUsedPercent !== undefined) return inputs;
  const live = await (deps.readLiveGrok ?? (() => readLiveGrokUsedPercent()))();
  return live === undefined ? inputs : { ...inputs, grokUsedPercent: live };
}

function loadLiveConfig(): ChildLlmPreferenceInput {
  // 지연 로드 — 판정 단위 테스트가 user-config 캐시·디스크를 건드리지 않게.
  const { getUserConfig } = require('../user-config.js') as typeof import('../user-config.js');
  return getUserConfig();
}
