// ── Status-line provider/model reader ──
//
// 하단 상태줄은 키 입력마다 다시 그린다. 종전엔 그때마다 `inspectActiveProvider()` 를 불러
//   ① `getUserConfig()` 의 stat ② `decideProviderForConfig()` 의 자격 확인 ③ 상태줄이 «안 쓰는»
//   `authDetail`(codex 면 auth 스토어 readFileSync + JSON.parse) 을 매 렌더 동기로 했다.
//   📏 실측(10-14 mbp · 운영 HOME · 500회 평균): 렌더 1회 98µs.
// ⇒ 상태줄이 쓰는 것은 provider·model 둘뿐이라, 그 둘만 짧게 기억한다.
//   ⛔ 기억이 «낡은 값»으로 굳지 않게: runtimeModel 이 바뀌면 즉시, 설정 파일이 바뀌면 TTL(2s) 안에 다시 읽고,
//   그렇지 않아도 `maxAgeMs` 마다 다시 판정한다(auto 공급자는 자격 유무로 갈리므로). 표시 전용이라 2s 지연은 허용.

import { inspectActiveProvider, type ActiveProviderInfo } from '../provider-summary.js';
import { getUserConfig, type UserConfig } from '../user-config.js';
import { currentRouteDecision, currentRouteExecution } from '../llm/route-decision.js';
import type { ModelExecutionActual } from './bar.js';

export type StatusProviderInfo = Pick<ActiveProviderInfo, 'provider' | 'model'> & {
  /** TUI-MODEL-BADGE-ACTUAL (10-16) — 이번 턴 «실제» 실행. 있으면 배지는 이 값을 «지금» 으로 쓴다. */
  actual?: ModelExecutionActual | null;
};

/** 표면의 이번 턴 «실제» 실행을 배지 입력 꼴로 옮긴다 — 결정(턴 시작에 고른 값)과 다르면
 *  `fallbackFrom` 이 채워져 배지가 `고른 → 실제` 를 보인다. 실행 기록이 없으면 null(꾸미지 않는다).
 *  원천은 완료 배지와 «같은» 맵(`src/llm/route-decision.ts`)이다 — 두 표면이 다른 말을 하지 않게. */
export function statusModelActual(surface = 'dashboard'): ModelExecutionActual | null {
  const execution = currentRouteExecution(surface);
  const model = execution?.model?.trim();
  if (!model) return null;
  const provider = execution?.provider?.trim();
  const planned = currentRouteDecision(surface)?.model?.trim();
  return {
    model,
    ...(provider ? { provider } : {}),
    ...(planned && planned !== model ? { fallbackFrom: planned } : {}),
  };
}

export interface StatusProviderInfoReaderDeps {
  readConfig?: () => UserConfig;
  inspect?: (cfg: UserConfig, runtimeModel?: string) => StatusProviderInfo;
  now?: () => number;
  /** 이 안에서는 설정도 다시 안 읽는다(렌더 경로 0 I/O). */
  ttlMs?: number;
  /** 설정이 그대로여도 이만큼 지나면 다시 판정한다. */
  maxAgeMs?: number;
}

/** 상태줄이 매 렌더 부르는 리더 — `actual`(이번 턴 실제 실행)은 선택이라 종전 호출 그대로도 된다. */
export type StatusProviderInfoReader = (
  runtimeModel?: string,
  actual?: ModelExecutionActual | null,
) => StatusProviderInfo;

export function createStatusProviderInfoReader(
  deps: StatusProviderInfoReaderDeps = {},
): StatusProviderInfoReader {
  const readConfig = deps.readConfig ?? (() => getUserConfig());
  const inspect = deps.inspect ?? ((cfg, runtimeModel) => inspectActiveProvider(cfg, runtimeModel));
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? 2_000;
  const maxAgeMs = deps.maxAgeMs ?? 30_000;
  let memo: {
    info: StatusProviderInfo;
    cfg: UserConfig;
    runtimeModel: string | undefined;
    checkedAt: number;
    inspectedAt: number;
  } | null = null;

  /** `actual` — 이번 턴 실제 실행(있으면). 기억은 설정/런타임 값만 하고, 실행은 «매 렌더»
   *  달라지므로 기억 밖에서 덧씌운다(낡은 실행이 굳지 않게). */
  return (runtimeModel?: string, actual?: ModelExecutionActual | null): StatusProviderInfo => {
    const t = now();
    // ⛔ 조기 반환에도 최대 수명을 건다 — TTL 만 보면 «29초에 설정 확인 → 30.001초 렌더»가 재판정 없이 지나간다.
    const fresh = memo !== null && t - memo.inspectedAt < maxAgeMs;
    if (memo && fresh && memo.runtimeModel === runtimeModel && t - memo.checkedAt < ttlMs) {
      return actual ? { ...memo.info, actual } : memo.info;
    }
    // getUserConfig() 는 파일 mtime 이 같으면 «같은 객체»를, 바뀌면 새 객체를 돌려준다(user-config.ts getUserConfig).
    const cfg = readConfig();
    if (memo && fresh && memo.cfg === cfg && memo.runtimeModel === runtimeModel) {
      memo.checkedAt = t;
      return actual ? { ...memo.info, actual } : memo.info;
    }
    const full = inspect(cfg, runtimeModel);
    const info: StatusProviderInfo = { provider: full.provider, model: full.model };
    memo = { info, cfg, runtimeModel, checkedAt: t, inspectedAt: t };
    return actual ? { ...info, actual } : info;
  };
}
