// COST-OPTIMIZER-WINDOW-AWARE — 계정·창 스냅숏 제공자(이미 있는 데이터만 · 네트워크 0).
//
// 오늘 구조화돼 «디스크에» 있는 것만 읽는다:
//   · openai-codex — 계정별 쿼터 신호 파일(`inspectCodexRotation`): 사용률·「찼다」·관측 시각·신선함(1시간)·명시 계정·건강.
// 없는 것은 «모름»으로 둔다(지어 넣지 않는다):
//   · 옛 Codex 신호의 창 리셋 시각 · 버텨야 할 시각 · API 결과당 비용 순위 · 다른 provider 의 계정 목록.
//   · codex 크레딧 잔액은 신호에 있지만 이 판은 싣지 않는다 — 크레딧 정책은 회전 판정(`codex-account-rotation`)의 몫이고 가격 숫자는 결정 칸에 넣지 않는다.
// ⛔ Claude 창(OAuth 조회)·teamclaude 할당량은 «호출»이라 판정 경로에서 읽지 않는다(src/budget/codex-reset-credit-state.ts «판정 경로에서 네트워크를 치지 않는다»).

import { debug } from '../debug/log.js';
import { inspectCodexRotation } from '../oauth/codex-account-store.js';
import { getUserConfig } from '../user-config.js';
import type { UserConfig } from '../user-config/schema.js';
import type { AccountCandidate, AccountState } from './orchestration-core.js';
import { WINDOW_ACCOUNT_EVENT } from './window-account-selector.js';

/** 생략·무효값 = shadow. `on` 만 계정을 바꾼다. */
export function resolveWindowAccountsMode(config: Pick<UserConfig, 'harness'> | undefined): 'shadow' | 'on' {
  return config?.harness?.windowAccounts === 'on' ? 'on' : 'shadow';
}

type CodexInspect = Pick<ReturnType<typeof inspectCodexRotation>, 'current' | 'explicit' | 'candidates' | 'observedAtByHome' | 'freshByHome' | 'resetsAtByHome' | 'reason' | 'to'>;

export interface AccountWindowSnapshotDeps {
  readonly now?: () => number;
  readonly config?: () => Pick<UserConfig, 'harness'>;
  readonly inspectCodex?: (nowMs: number) => CodexInspect;
  readonly emit?: (category: string, event: string, data: Record<string, unknown>) => void;
  /** 모드를 강제한다(발사가 계정을 바꿀 수 없는 자리 — 명시 자식 LLM·ADVISOR — 는 shadow 로 고정). */
  readonly forceShadow?: boolean;
}

const CODEX_PROVIDERS = new Set(['openai-codex', 'codex']);

/** 결정 한 번에 한 번 읽는다. 읽기 실패 = undefined(선택기가 `no-snapshot` 이벤트와 함께 활성 계정을 지킨다). */
export function readAccountWindowSnapshot(provider: string, deps: AccountWindowSnapshotDeps = {}): AccountState | undefined {
  const emit = deps.emit ?? ((category, event, data) => debug.log(category, event, data));
  const observe = (event: string, data: Record<string, unknown>): void => { try { emit(WINDOW_ACCOUNT_EVENT, event, data); } catch { /* fail-soft */ } };
  const readAtMs = (deps.now ?? Date.now)();
  let selection: 'shadow' | 'on' = 'shadow';
  if (!deps.forceShadow) {
    try { selection = resolveWindowAccountsMode((deps.config ?? getUserConfig)()); } catch (error) {
      observe('snapshot-skip', { provider, reason: 'config-unreadable', error: error instanceof Error ? error.name : 'unknown' });
    }
  }
  if (!CODEX_PROVIDERS.has(provider)) {
    // 이 provider 는 계정별 창 데이터가 아직 없다 — 활성 계정 «모름»으로 내고 선택기가 거절 이벤트를 낸다.
    return { candidates: [], active: { provider, account: null }, selection, readAtMs };
  }
  let state: CodexInspect;
  try { state = (deps.inspectCodex ?? ((now) => inspectCodexRotation(process.env, { now })))(readAtMs); } catch (error) {
    observe('snapshot-skip', { provider, reason: 'read-failed', error: error instanceof Error ? error.name : 'unknown' });
    return undefined;
  }
  const candidates: AccountCandidate[] = [];
  let unhealthy = 0;
  let oldestFresh: number | undefined;
  for (const c of state.candidates) {
    if (c.unhealthy === true) { unhealthy += 1; continue; }
    const fresh = state.freshByHome[c.home] === true;
    const observedAt = state.observedAtByHome[c.home];
    if (fresh && typeof observedAt === 'number') oldestFresh = oldestFresh === undefined ? observedAt : Math.min(oldestFresh, observedAt);
    const remaining = !fresh ? undefined
      : c.reached === true ? 0
      : typeof c.usedPercent === 'number' && Number.isFinite(c.usedPercent) ? (100 - c.usedPercent) / 100 : undefined;
    const resetsAtMs = fresh ? state.resetsAtByHome[c.home] : undefined;
    candidates.push({
      provider, account: c.name, billing: 'subscription',
      ...(remaining === undefined ? {} : { window: { remaining, ...(resetsAtMs === undefined ? {} : { resetsAtMs }) } }),
    });
  }
  if (unhealthy > 0) observe('snapshot-skip', { provider, reason: 'unhealthy-excluded', count: unhealthy });
  // 활성 = 자식이 실제로 쓸 계정의 최선 추정: 회전 판정이 넘긴다면(`rotated`) 그 대상, 아니면 현재 해석(리뷰 sf4).
  const active = state.reason === 'rotated' && typeof state.to === 'string' && state.to ? state.to : state.current.name;
  return {
    candidates,
    active: { provider, account: active },
    selection, readAtMs,
    ...(state.explicit ? { explicit: true } : {}),
    ...(oldestFresh === undefined ? {} : { observedAtMs: oldestFresh }),
  };
}
