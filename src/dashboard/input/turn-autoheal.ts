// TUI-400-AUTOHEAL-FALLBACK — classic TUI(대시보드)의 자동 회복 배선 한 곳.
//
// plain-turn 런타임(`chat-main-plain-turn-runtime`)이 «언제·몇 번» 을 정하고, 여기는 «무엇으로» 만 준다:
//   ① 새 백엔드 세션 = `DashboardSession.renew`(= `/session new` 의 ACP 갱신과 같은 호출)
//   ① 직전 요약 = 이미 있는 압축 요약 `compactConversation` ⊕ 실패 시 `buildCompactTranscript` 꼬리
//   ② 다음 공급자 = 턴 안 폴백과 같은 `llm.fallbackChain` 해석(`nextTurnFallbackProvider`)
// ⛔ 원격 데몬 세션은 ② 를 못 한다(공급자 결정이 데몬 쪽 · 서버 다리는 in-process 만 표지를 읽는다) — ① 만.
// ⭐ 대시보드와 결함 주입 장치(`ux-sim/fault-tui-400-autoheal`)가 «같은» 이 함수를 쓴다(재구현 0).

import { nextTurnFallbackProvider, resolveDefaultProvider, type LLMMessage } from '../../llm.js';
import type { DashboardTurnAutoheal } from './chat-main-plain-turn-runtime.js';
import { summarizeForAutoheal } from '../../self-health/autoheal.js';

export interface DashboardTurnAutohealDeps {
  /** ACP 세션 — `renew(cwd)` 가 새 백엔드 세션 id 를 돌려준다. */
  session: { renew(cwd: string): Promise<string> };
  getCwd(): string;
  /** 새 세션 id 를 대시보드 상태(acpSessionIdRef 등)에 반영. */
  onRenewed?(sessionId: string): void;
  /** 원격 데몬에 붙은 세션이면 true — ② 를 건너뛴다. */
  remote: boolean;
  /** 이 턴 모델(공급자 해석의 힌트) — 다리의 `resolveModel` 과 같은 값. */
  activeModel(): string | undefined;
  /** 시험 seam — 요약 시간 상한(ms). */
  summaryTimeoutMs?: number;
}

export function createDashboardTurnAutoheal(deps: DashboardTurnAutohealDeps): DashboardTurnAutoheal {
  return {
    async renewBackendSession() {
      const renewed = await deps.session.renew(deps.getCwd());
      deps.onRenewed?.(renewed);
      return renewed;
    },
    async summarizeHistory(prior) {
      const { compactConversation, buildCompactTranscript } = await import('../../compact/index.js');
      const history = prior as readonly LLMMessage[];
      const { summary } = await summarizeForAutoheal(history, {
        compact: (h) => compactConversation(h),
        transcript: (h) => buildCompactTranscript(h),
        ...(deps.summaryTimeoutMs !== undefined ? { timeoutMs: deps.summaryTimeoutMs } : {}),
      });
      return summary;
    },
    peekFallbackProvider() {
      if (deps.remote) return null;
      // 다리(core-turn-bridge)가 ② 에서 고를 것과 «같은» 해석 — 화면 한 줄의 이름과 실제 공급자가 어긋나지 않게.
      const failed = resolveDefaultProvider(deps.activeModel()).name;
      return nextTurnFallbackProvider([failed])?.name ?? null;
    },
  };
}
