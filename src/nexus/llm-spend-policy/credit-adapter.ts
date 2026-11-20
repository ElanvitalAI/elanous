// CC-1 잔액 어댑터 — readOpenRouterCredit(src/budget/provider-credit-read.ts · #39148) 의 «관측» 을
// 정책 조회 현황(LlmSpendRowState: 크레딧 잔액·자동 충전)으로 옮기는 «읽기 전용» 연결부 (ONE-SHOT · CREDIT-PROVIDER-TOPUP-READ).
//
// ⛔ 비밀 0: 이 모듈은 관측 객체(값 아님)만 만진다. 임대 문자열은 readOpenRouterCredit 에만 건네고 반환·상태 어디에도 싣지 않는다.
//   ⛔ 쓰기 0: 공급자 API GET 한 번(readOpenRouterCredit 내부) 외 네트워크·파일·금고 접근이 없다.
//   ⛔ «모름» 은 «모름»: 관측이 unmeasured 면 그대로 unmeasured 로 옮긴다(0 으로 접지 않는다 · OBS-T188).

import { readOpenRouterCredit } from '../../budget/provider-credit-read.js';
import type { AutoTopUpState, CreditBalanceState, LlmSpendPolicyDoc, LlmSpendRowState } from './types.js';

/** readOpenRouterCredit 반환의 «구조적 부분집합» — autoTopUp 이 measured{enabled,amountUsd,observedAt} 로 넓어져도 받는다. */
export interface CreditObservationLike {
  readonly provider: string;
  readonly balance:
    | { readonly status: 'measured'; readonly usd: number; readonly totalCreditsUsd: number; readonly totalUsageUsd: number; readonly source: string; readonly observedAt: string }
    | { readonly status: 'unmeasured'; readonly reason: string };
  readonly autoTopUp:
    | { readonly status: 'measured'; readonly enabled: boolean; readonly amountUsd?: number; readonly source?: string; readonly observedAt: string }
    | { readonly status: 'unmeasured'; readonly reason: string };
}

function toBalance(b: CreditObservationLike['balance']): CreditBalanceState {
  if (b.status !== 'measured') return { status: 'unmeasured', reason: String(b.reason) };
  return { status: 'measured', usd: b.usd, totalCreditsUsd: b.totalCreditsUsd, totalUsageUsd: b.totalUsageUsd, source: b.source, observedAt: b.observedAt };
}

function toAutoTopUp(a: CreditObservationLike['autoTopUp']): AutoTopUpState {
  if (a.status !== 'measured') return { status: 'unmeasured', reason: String(a.reason) };
  return {
    status: 'measured', enabled: a.enabled,
    ...(a.amountUsd !== undefined ? { amountUsd: a.amountUsd } : {}),
    ...(a.source !== undefined ? { source: a.source } : {}),
    observedAt: a.observedAt,
  };
}

/** 관측 → 행 상태(잔액·자동 충전만 채운다 · 지출·임대는 다른 칸 몫). */
export function creditObservationToRowState(row: string, obs: CreditObservationLike): LlmSpendRowState {
  return { row, provider: obs.provider, balance: toBalance(obs.balance), autoTopUp: toAutoTopUp(obs.autoTopUp) };
}

export interface CreditAdapterDeps {
  /** 공급자별 «관리 임대»(메모리 문자열 · 금고 임대 칸이 넘긴다). 없으면 missing-management-lease 로 unmeasured. */
  readonly leases?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

/**
 * 정책의 credit 행 중 어댑터가 읽을 수 있는 공급자(지금은 openrouter)를 읽어 행 상태로 돌려준다.
 * 읽을 수 없는 공급자는 unmeasured(unsupported-provider) — 행이 «조회 현황» 에서 빠지지 않게 한다.
 */
export async function readCreditRowStates(policy: LlmSpendPolicyDoc, deps: CreditAdapterDeps = {}): Promise<LlmSpendRowState[]> {
  const out: LlmSpendRowState[] = [];
  for (const [rowKey, row] of Object.entries(policy.providers)) {
    if (row.kind !== 'credit') continue;
    if (row.provider !== 'openrouter') {
      out.push({ row: rowKey, provider: row.provider, balance: { status: 'unmeasured', reason: 'unsupported-provider' }, autoTopUp: { status: 'unmeasured', reason: 'unsupported-provider' } });
      continue;
    }
    const obs = await readOpenRouterCredit(deps.leases?.[rowKey] ?? deps.leases?.[row.provider], { fetchImpl: deps.fetchImpl, now: deps.now });
    const state = creditObservationToRowState(rowKey, obs);
    // OR 공식 /credits 에는 topup 필드가 없다 → 공급자가 못 알려 주면 정책 행의 «선언» 스냅샷(source declared)을 쓴다. 선언도 없으면 unmeasured 그대로.
    const declared = row.autoTopUp;
    out.push(state.autoTopUp?.status !== 'measured' && declared?.status === 'measured'
      ? { ...state, autoTopUp: { status: 'measured', enabled: declared.enabled, ...(declared.amountUsd !== undefined ? { amountUsd: declared.amountUsd } : {}), source: 'declared', observedAt: declared.observedAt } }
      : state);
  }
  return out;
}

/** 직접 주입된 상태가 어댑터 값을 «덮는다»(행 단위 · 칸 단위 병합) — 시험·후속 칸(지출 원장·임대)이 같은 행에 칸을 더한다. */
export function mergeRowStates(base: readonly LlmSpendRowState[], injected: readonly LlmSpendRowState[]): LlmSpendRowState[] {
  const merged = new Map<string, LlmSpendRowState>();
  for (const state of [...base, ...injected]) {
    const prev = merged.get(state.row);
    merged.set(state.row, prev ? { ...prev, ...state } : state);
  }
  return [...merged.values()];
}
