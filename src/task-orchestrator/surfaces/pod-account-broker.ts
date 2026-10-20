// Pod 계정 브로커 — 병렬 Pod 런이 codex 계정 «하나»에 몰리지 않게, Job 마다 잔량 많은 계정을 돌려 가며 준다
// (로드맵 09-26 #7 · docker·k8s 로드맵 C3). 잔량 신호는 회전 판정과 «같은 심»(`inspectCodexRotation`)에서 읽는다.
//
// ⛔ 한도에 닿은 계정(`reached === true`)과 사용률이 문턱 이상인 계정은 뺀다. 신호가 없는 계정(`undefined`)은
//    «모른다»라서 뒤로 보내되 빼지 않는다(못 읽었다고 갈 곳을 없애지 않는다 — 회전 규칙과 같다).
// ⛔ `--pod-account` 를 명시하면 브로커를 쓰지 않는다 — 사람의 의도가 이긴다.

import { CODEX_CREDIT_RESERVE_DEFAULT, codexAccountThresholdPercent, creditCandidatesByBalance, type RotationCandidate } from '../../oauth/codex-account-rotation.js';
import { debug } from '../../debug/log.js';

export const POD_ACCOUNT_EXCLUDE_AT_PERCENT = 95;

export interface PodAccountPlan { usable: string[]; excluded: Array<{ name: string; why: string }>; /** 크레딧으로 쓰는 계정(구독 잔량 0 · 대표 허가) — 로그에 «크레딧» 으로 보이게. */ creditAccounts?: string[] }

export type PodProviderPlan =
  | { provider: 'openai-codex'; accounts: string[]; excluded: PodAccountPlan['excluded']; grokSubscriptionEligible: boolean; creditAccounts?: string[]; /** CODEX-CREDITS-STEP — 체인 마지막 칸으로 크레딧에 왔다. */ codexCreditsStep?: true; /** 그 칸에 온 이유(관측). */ skipped?: string[] }
  | { provider: 'grok'; excluded: PodAccountPlan['excluded']; grokSubscriptionEligible: boolean }
  | { provider: null; reasons: string[]; grokSubscriptionEligible: boolean };

/** Effective cap used by the Pod broker; callers carrying an owner-approved selection must carry this same value. */
export function podAccountThresholdPercent(name: string, options: {
  excludeAt?: number;
  thresholdPercentByAccount?: Readonly<Record<string, unknown>>;
} = {}): number {
  return codexAccountThresholdPercent(name, {
    thresholdPercent: options.excludeAt ?? POD_ACCOUNT_EXCLUDE_AT_PERCENT,
    thresholdPercentByAccount: options.thresholdPercentByAccount,
  });
}

/** Pod 의 codex → grok 선택. 자격 종류는 과금 동의와 별도로 판단한다. */
export function planPodProvider(input: {
  codexCandidates: readonly RotationCandidate[];
  grokSubscription: boolean;
  grokApiKey: boolean;
  grokApiKeyOptIn: boolean;
  excludeAt?: number;
  thresholdPercentByAccount?: Readonly<Record<string, unknown>>;
  /** 대표 크레딧 허가(`llm.codexCreditsAllowed`) — 구독 잔량 계정이 없으면 찬 계정을 크레딧으로 쓴다. */
  creditsAllowed?: boolean;
  /** SUBSCRIPTION-EXHAUST-REROUTE — `llm.codexCreditReserve`. 잔액이 «알려져» 이 값 이하인 계정은 크레딧으로 쓰지 않는다. */
  creditReserve?: number;
  /** CODEX-CREDITS-STEP — `llm.fallbackChain` 에 `codex-credits` 칸이 있고 정책이 폴백을 허용한다(호출자가 확정). */
  codexCreditsStep?: boolean;
  /** grok «잔량» — `exhausted` 일 때만 grok 을 건너뛴다(「모른다」는 종전대로 grok · 돈을 쓰는 쪽으로 기울지 않는다). */
  grokQuota?: 'usable' | 'exhausted' | 'unknown';
}): PodProviderPlan {
  const accounts = planPodAccounts(input.codexCandidates, {
    excludeAt: input.excludeAt,
    thresholdPercentByAccount: input.thresholdPercentByAccount,
    creditsAllowed: input.creditsAllowed,
    ...(input.creditReserve !== undefined ? { creditReserve: input.creditReserve } : {}),
  });
  if (accounts.usable.length) return { provider: 'openai-codex', accounts: accounts.usable, excluded: accounts.excluded, grokSubscriptionEligible: input.grokSubscription, ...(accounts.creditAccounts ? { creditAccounts: accounts.creditAccounts } : {}) };
  const grokEligible = input.grokSubscription || (input.grokApiKey && input.grokApiKeyOptIn);
  const grokSkippedAsExhausted = input.codexCreditsStep === true && input.grokQuota === 'exhausted';
  if (grokEligible && !grokSkippedAsExhausted) return { provider: 'grok', excluded: accounts.excluded, grokSubscriptionEligible: input.grokSubscription };
  if (input.codexCreditsStep === true) {
    // 체인 마지막 칸 — 크레딧 잔액이 «확인된» 계정만, 많은 순(모르면 안 쓴다 · 돈이라 fail-closed).
    const credit = creditCandidatesByBalance(input.codexCandidates, input.creditReserve ?? CODEX_CREDIT_RESERVE_DEFAULT).map((c) => c.name);   // 회전 수집기와 같은 자
    if (credit.length > 0) {
      return {
        // 구독 기준 제외 사유는 진단용으로 남긴다(계정 선택은 credit 순서가 정한다).
        provider: 'openai-codex', accounts: credit, excluded: accounts.excluded, creditAccounts: credit, codexCreditsStep: true,
        grokSubscriptionEligible: input.grokSubscription,
        skipped: ['codex-rotate:no-candidate', grokEligible ? 'grok:grok-exhausted' : 'grok:grok-unavailable'],
      };
    }
    // 칸에 «닿았지만» 잔액 확인된 계정이 없다 — 실패한 도달도 남긴다.
    try { debug.log('self-implement.pod', 'codex-credits-step', { outcome: 'skipped', why: 'codex-credits-unavailable', grokEligible }); } catch { /* observation is fail-soft */ }
    // 크레딧도 못 쓰면 종전 그대로 — 소진 신호가 있어도 grok 으로(새로 막지 않는다).
    if (grokEligible) return { provider: 'grok', excluded: accounts.excluded, grokSubscriptionEligible: input.grokSubscription };
  }
  return {
    provider: null,
    grokSubscriptionEligible: false,
    reasons: [
      `codex: ${accounts.excluded.map((e) => `${e.name}(${e.why})`).join(' · ') || '계정 0개'}`,
      `grok: 구독 자격 없음 · ${input.grokApiKey ? 'API 키 opt-in 꺼짐' : 'API 키 없음'}`,
    ],
  };
}

export function planPodAccounts(
  candidates: readonly RotationCandidate[],
  options: number | {
    thresholdPercentByAccount?: Readonly<Record<string, unknown>>;
    excludeAt?: number;
    creditsAllowed?: boolean;
    creditReserve?: number;
  } = {},
): PodAccountPlan {
  const { thresholdPercentByAccount, excludeAt = POD_ACCOUNT_EXCLUDE_AT_PERCENT, creditsAllowed = false, creditReserve } =
    typeof options === 'number' ? { excludeAt: options } as { thresholdPercentByAccount?: undefined; excludeAt: number; creditsAllowed?: boolean; creditReserve?: number } : options;
  const excluded: PodAccountPlan['excluded'] = [];
  const known: RotationCandidate[] = [];
  const unknown: RotationCandidate[] = [];
  for (const c of candidates) {
    const threshold = typeof options === 'number' ? excludeAt : podAccountThresholdPercent(c.name, { excludeAt, thresholdPercentByAccount });
    if (c.reached === true) { excluded.push({ name: c.name, why: 'quota reached' }); continue; }
    if (c.usedPercent !== undefined && c.usedPercent >= threshold) { excluded.push({ name: c.name, why: `used ${c.usedPercent}% ≥ ${threshold}%` }); continue; }
    (c.usedPercent === undefined ? unknown : known).push(c);
  }
  known.sort((a, b) => (a.usedPercent! - b.usedPercent!) || a.name.localeCompare(b.name));
  unknown.sort((a, b) => a.name.localeCompare(b.name));
  const usable = [...known, ...unknown].map((c) => c.name);
  // 대표 크레딧 허가: 구독 잔량이 남은 계정이 «하나도» 없을 때만 찬 계정을 크레딧으로 쓴다(사용률 낮은 순) — 잔량 계정이 있으면 그쪽이 먼저다.
  if (usable.length === 0 && creditsAllowed) {
    // SUBSCRIPTION-EXHAUST-REROUTE — 잔액이 «알려져» 예비분 이하인 계정은 크레딧 후보가 아니다(모르면 종전대로 남긴다).
    const reserve = typeof creditReserve === 'number' && Number.isFinite(creditReserve) && creditReserve >= 0 ? creditReserve : undefined;
    const credit = candidates
      .filter((c) => excluded.some((e) => e.name === c.name))
      .filter((c) => reserve === undefined || typeof c.creditBalance !== 'number' || c.creditBalance > reserve)
      // 크레딧 잔액이 많은 계정부터(09-28 · 한 계정 크레딧만 타던 것) — 잔액을 모르면 사용률 낮은 순.
      .sort((a, b) => ((b.creditBalance ?? -1) - (a.creditBalance ?? -1)) || ((a.usedPercent ?? 100) - (b.usedPercent ?? 100)) || a.name.localeCompare(b.name))
      .map((c) => c.name);
    if (credit.length === 0 && reserve !== undefined && excluded.length > 0) {
      return { usable, excluded: excluded.map((e) => ({ ...e, why: `${e.why} · credits ≤ reserve ${reserve}` })) };
    }
    return { usable: credit, excluded: [], creditAccounts: credit };
  }
  return { usable, excluded };
}

/** HQ selects one owner account before remote-parent launch; keep the configured rotation order. */
export function planOwnerCodexMirrorCandidates(candidates: readonly RotationCandidate[], options: {
  accountOrder: readonly string[];
  thresholdPercentByAccount?: Readonly<Record<string, unknown>>;
}): RotationCandidate[] {
  const usable = new Set(planPodAccounts(candidates, { thresholdPercentByAccount: options.thresholdPercentByAccount }).usable);
  const rank = (name: string): number => {
    const index = options.accountOrder.indexOf(name);
    return index < 0 ? options.accountOrder.length : index;
  };
  return candidates.map((candidate, index) => ({ candidate, index })).filter(({ candidate }) => usable.has(candidate.name))
    .sort((a, b) => rank(a.candidate.name) - rank(b.candidate.name) || a.index - b.index)
    .map(({ candidate }) => candidate);
}

/** Remote owner-mirror runs may plan against exactly the account HQ selected and its measured usage. */
export function ownerCodexMirrorCandidate(candidates: readonly RotationCandidate[], account: string, usedPercent?: number): RotationCandidate[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(account)) return [];
  return candidates.filter((candidate) => candidate.name === account).map((candidate) => {
    const ownerCandidate = { ...candidate };
    delete ownerCandidate.usedPercent;
    ownerCandidate.reached = false;
    const measured = usedPercent !== undefined && Number.isFinite(usedPercent) ? usedPercent : undefined;
    return { ...ownerCandidate, reached: false, ...(measured !== undefined ? { usedPercent: measured } : {}) };
  });
}

/** Job 마다 다음 계정 — 잔량 순으로 돌려 가며. 쓸 계정이 없으면 만들 때 이유를 대고 던진다. */
export function makePodAccountBroker(plan: PodAccountPlan): () => string {
  if (plan.usable.length === 0) {
    throw new Error(`pod: 쓸 codex 계정이 없다 — ${plan.excluded.map((e) => `${e.name}(${e.why})`).join(' · ') || '계정 0개'} · 계정을 명시하려면 --pod-account <이름>`);
  }
  let i = 0;
  return () => plan.usable[i++ % plan.usable.length]!;
}
