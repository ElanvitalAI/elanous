// COST-OPTIMIZER-WINDOW-AWARE — 창 인지 계정 선택기(코어 `AccountSelector` 칸 · 순수).
//
// S: 코어(#38175)는 계정 칸을 비워 두었다 — 기본 선택기는 활성 계정을 그대로 둔다.
// C: 곧 리셋될 구독 창의 남은 몫은 리셋과 함께 버려지는데, 버텨야 할 창은 바닥까지 쓰면 다음 일감이 막힌다.
// Q: 같은 등급·같은 provider 안에서 어느 계정으로 낼지, 데이터가 없거나 낡았을 때 무엇을 하나?
// A: 순서 고정 — ① 남은 몫이 예비 몫보다 큰 구독(리셋 이른 순 · 리셋 모름은 뒤) ② 선불·크레딧 ③ API(costRank 순).
//    스냅숏이 없거나 낡았거나 명시 계정이면 활성 계정 그대로 + 이벤트(조용한 전환 0).
//    shadow(기본)는 고를 계정을 원장 이유에 «종류·해시»로만 남기고 계정은 바꾸지 않는다. 가격·잔액 숫자는 어디에도 싣지 않는다.
// 출처: seat-state/ELN-DOGFOOD/ASK-RIFLE-NOT-TANK-HARNESS-1117.md §소구점 · 칸 COST-OPTIMIZER-WINDOW-AWARE(0.3.28).

import { createHash } from 'node:crypto';
import { debug } from '../debug/log.js';
import { QUOTA_SIGNAL_MAX_AGE_MS } from '../budget/codex-reset-credit-state.js';
import { DEFAULT_ROTATION_THRESHOLD_PERCENT } from '../oauth/codex-account-rotation.js';
import type { AccountCandidate, AccountSelector, AccountState, CoreDecisionInput, WindowSignalField, WorkTierClass } from './orchestration-core.js';
import type { ModelTier } from './types.js';

// ── 숫자 상수 — 근원 상수를 직접 쓴다(숫자를 다시 적지 않는다 · 리뷰 #38337 sf3) ─────────────
/** 스냅숏 나이 상한 = 쿼터 신호를 «판정에» 쓰는 같은 상한(`src/budget/codex-reset-credit-state.ts`). */
export const WINDOW_SNAPSHOT_TTL_MS = QUOTA_SIGNAL_MAX_AGE_MS;
/** «버텨야 할» 창의 예비 몫(0..1) = 회전 판정이 계정을 떠나는 사용률의 나머지(`src/oauth/codex-account-rotation.ts`). */
export const MUST_LAST_RESERVE_SHARE = (100 - DEFAULT_ROTATION_THRESHOLD_PERCENT) / 100;

/** 관측 이벤트 범주 — `elanous logs --category harness.window-account`. */
export const WINDOW_ACCOUNT_EVENT = 'harness.window-account';

export type WindowAccountRefusal =
  | 'no-snapshot' | 'stale-snapshot' | 'no-active-account' | 'explicit-account' | 'no-candidates' | 'all-exhausted';
export type WindowAccountRule = 'subscription-resets-soonest' | 'subscription-remaining' | 'prepaid' | 'api-cost-rank';

export type WindowAccountPick =
  | { readonly status: 'picked'; readonly candidate: AccountCandidate; readonly rule: WindowAccountRule }
  | { readonly status: 'refused'; readonly reason: WindowAccountRefusal };

/** 원장·이벤트에 싣는 계정 신원 — 원 계정 이름 대신 해시 12자리. */
export function accountIdHash(provider: string, account: string): string {
  return `acct:${createHash('sha256').update(`${provider}\u0000${account}`).digest('hex').slice(0, 12)}`;
}

function usable(candidate: AccountCandidate, provider: string, cell: ModelTier): boolean {
  return candidate.provider === provider && (candidate.tiers === undefined || candidate.tiers.includes(cell));
}

/** 이 창이 아래로 쓰면 안 되는 몫. 버틸 시각 전에 리셋이 «확실히» 오면 0(쓰지 않으면 버려진다) · 그 밖(모름 포함)은 예비 몫. */
function windowFloor(candidate: AccountCandidate): number {
  const reset = candidate.window?.resetsAtMs;
  const mustLast = candidate.mustLastUntilMs;
  return reset !== undefined && mustLast !== undefined && reset <= mustLast ? 0 : MUST_LAST_RESERVE_SHARE;
}

const byName = (a: AccountCandidate, b: AccountCandidate): number => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0);
const rankOf = (c: AccountCandidate): number => (typeof c.costRank === 'number' && Number.isFinite(c.costRank) ? c.costRank : Number.POSITIVE_INFINITY);

/** 순수 선택 — 시계·I/O 없음. 같은 입력이면 같은 답(동률은 계정 이름 오름차순). */
export function pickWindowAccount(state: AccountState | undefined, provider: string, cell: ModelTier): WindowAccountPick {
  if (!state) return { status: 'refused', reason: 'no-snapshot' };
  const { observedAtMs, readAtMs } = state;
  if (observedAtMs === undefined || readAtMs === undefined || observedAtMs > readAtMs || readAtMs - observedAtMs > WINDOW_SNAPSHOT_TTL_MS) {
    return { status: 'refused', reason: 'stale-snapshot' };
  }
  if (!state.active || state.active.account === null) return { status: 'refused', reason: 'no-active-account' };
  if (state.explicit === true) return { status: 'refused', reason: 'explicit-account' };
  const pool = state.candidates.filter((c) => usable(c, provider, cell));
  if (pool.length === 0) return { status: 'refused', reason: 'no-candidates' };

  const subscriptions = pool
    .filter((c) => c.billing === 'subscription' && c.window !== undefined && Number.isFinite(c.window.remaining) && c.window.remaining > windowFloor(c))
    .sort((a, b) => (a.window!.resetsAtMs ?? Number.POSITIVE_INFINITY) - (b.window!.resetsAtMs ?? Number.POSITIVE_INFINITY)
      || b.window!.remaining - a.window!.remaining || byName(a, b));
  const sub = subscriptions[0];
  if (sub) return { status: 'picked', candidate: sub, rule: sub.window!.resetsAtMs !== undefined ? 'subscription-resets-soonest' : 'subscription-remaining' };

  const prepaid = pool.filter((c) => c.billing === 'prepaid' || c.billing === 'credit').sort((a, b) => rankOf(a) - rankOf(b) || byName(a, b))[0];
  if (prepaid) return { status: 'picked', candidate: prepaid, rule: 'prepaid' };

  const api = pool.filter((c) => c.billing === 'api').sort((a, b) => rankOf(a) - rankOf(b) || byName(a, b))[0];
  if (api) return { status: 'picked', candidate: api, rule: 'api-cost-rank' };
  return { status: 'refused', reason: 'all-exhausted' };
}

const WINDOW_SIGNAL_FIELDS: readonly WindowSignalField[] = ['resetsAtMs', 'costRank', 'mustLastUntilMs'];

/** 이 provider 의 후보 «어느 하나도» 값을 갖지 않은 신호 칸 — 스냅숏이 없으면 셋 다. 값을 지어 넣지 않고 «측정 안 됨»으로 표시한다. */
export function unmeasuredWindowSignals(state: AccountState | undefined, provider: string): WindowSignalField[] {
  const pool = (state?.candidates ?? []).filter((c) => c.provider === provider);
  const has: Record<WindowSignalField, boolean> = {
    resetsAtMs: pool.some((c) => typeof c.window?.resetsAtMs === 'number'),
    costRank: pool.some((c) => typeof c.costRank === 'number'),
    mustLastUntilMs: pool.some((c) => typeof c.mustLastUntilMs === 'number'),
  };
  return WINDOW_SIGNAL_FIELDS.filter((field) => !has[field]);
}

export interface WindowAccountSelectorOptions {
  /** 관측 출구(기본 = debug.log). 원 계정 이름·토큰은 넘기지 않는다. */
  readonly emit?: (category: string, event: string, data: Record<string, unknown>) => void;
}

function keepActive(input: CoreDecisionInput, reason: string): ReturnType<AccountSelector['select']> {
  const active = input.accounts?.active;
  return active ? { provider: active.provider, account: active.account, reason } : { provider: input.provider, account: null, reason };
}

/** 코어 모듈 칸에 끼우는 선택기. provider 는 바꾸지 않는다(같은 provider 안의 계정만 — 사다리·발사 provider 불변). */
export function createWindowAwareAccountSelector(options: WindowAccountSelectorOptions = {}): AccountSelector {
  const emit = options.emit ?? ((category, event, data) => debug.log(category, event, data));
  const observe = (event: string, data: Record<string, unknown>): void => { try { emit(WINDOW_ACCOUNT_EVENT, event, data); } catch { /* 관측은 결정을 막지 않는다 */ } };
  return {
    name: 'window-aware',
    select: ({ input, tier, cell }: { input: CoreDecisionInput; tier: WorkTierClass; cell: ModelTier }) => {
      const state = input.accounts;
      const mode = state?.selection === 'on' ? 'on' : 'shadow';
      const provider = state?.active?.provider ?? input.provider;
      const pick = pickWindowAccount(state, provider, cell);
      const unmeasured = unmeasuredWindowSignals(state, provider);
      const base = { runId: input.runId || null, moment: input.moment, tier, cell, provider, mode, unmeasured };
      const withUnmeasured = (result: ReturnType<AccountSelector['select']>): ReturnType<AccountSelector['select']> =>
        unmeasured.length ? { ...result, unmeasured } : result;
      if (pick.status === 'refused') {
        observe('refused', { ...base, reason: pick.reason });
        return withUnmeasured(keepActive(input, `refused:${pick.reason}`));
      }
      const chosen = accountIdHash(pick.candidate.provider, pick.candidate.account);
      const tag = `${pick.candidate.billing}:${chosen}:${pick.rule}`;
      const same = pick.candidate.account === state!.active!.account;
      if (mode !== 'on') {
        observe('shadow', { ...base, chosenKind: pick.candidate.billing, chosenAccount: chosen, rule: pick.rule, same });
        return withUnmeasured(keepActive(input, `shadow:${tag}`));
      }
      observe('picked', { ...base, chosenKind: pick.candidate.billing, chosenAccount: chosen, rule: pick.rule, same });
      return withUnmeasured({ provider: pick.candidate.provider, account: pick.candidate.account, reason: `${same ? 'kept' : 'switched'}:${tag}` });
    },
  };
}

/** 프로세스 기본 선택기 — `DEFAULT_CORE_MODULES` 가 끼운다. */
export const WINDOW_AWARE_ACCOUNT_SELECTOR: AccountSelector = createWindowAwareAccountSelector();
