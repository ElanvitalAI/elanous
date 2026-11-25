// 조용한 모델 폴백을 화면에 — 요청한 공급자/모델과 실제로 부른 것이 다르면(폴백 사다리) 세션별로 기억한다.
//
// 관측(11-25 5497ec9 재측정 A-latest r1): terra 과부하 뒤 OpenRouter GLM-5.3 로 넘어갔는데 상태줄은 계속
//   gpt-6.1-terra 를 보였다 — `llm.call mismatch` warn 만 남고 화면엔 아무 표시가 없었다.
// 처방: 시도 관측 경계(llm-call-gateway)가 요청 ≠ 실제를 보면 여기에 적고, 상태줄은 «⚠ fallback: <모델>» 로 실제 모델을 보인다.
//   폴백 정책 자체(사다리·순서)는 바꾸지 않는다(주인 결정). 요청한 공급자로 다시 돌면 표시는 지워진다.
// 세 얼굴: 관측 = llm.fallback-active(전환마다 한 번) · llm.fallback-cleared · 인지 = 세션별 활성 폴백 · 수복 = 사람에게 보인다(정책 판단은 주인).
import { debug } from '../debug/log.js';

export interface ActiveFallback {
  readonly requestedProvider: string;
  readonly requestedModel: string | null;
  readonly provider: string;
  readonly model: string | null;
  readonly since: number;
}

const active = new Map<string, ActiveFallback>();

/** 한 시도의 요청 ↔ 실제. `fallback` 이 참이면 활성 폴백으로 적고(바뀔 때만 로그 한 줄), 거짓이면 지운다. */
export function noteLlmRoute(sessionId: string | null | undefined, route: {
  fallback: boolean; requestedProvider: string; requestedModel: string | null; provider: string; model: string | null;
}, now: number = Date.now()): void {
  if (!sessionId) return;
  const previous = active.get(sessionId);
  if (!route.fallback) {
    if (previous) {
      active.delete(sessionId);
      debug.log('llm', 'fallback-cleared', { sessionId, provider: route.provider, model: route.model, wasProvider: previous.provider, wasModel: previous.model }, { level: 'info' });
    }
    return;
  }
  if (previous && previous.provider === route.provider && previous.model === route.model) return;
  active.set(sessionId, {
    requestedProvider: route.requestedProvider, requestedModel: route.requestedModel,
    provider: route.provider, model: route.model, since: now,
  });
  debug.log('llm', 'fallback-active', {
    sessionId, requestedProvider: route.requestedProvider, requestedModel: route.requestedModel,
    provider: route.provider, model: route.model,
  }, { level: 'warn' });
}

export function activeLlmFallback(sessionId: string | null | undefined): ActiveFallback | undefined {
  return sessionId ? active.get(sessionId) : undefined;
}

/** 상태줄 모델 칸 — 폴백이 활성이면 «⚠ fallback: <모델>»(공급자 접두 없이 · 상태줄의 짧은 형태가 `/` 뒤만 남기므로). */
export function statusModelWithFallback(sessionId: string | null | undefined, statusModel: string): string {
  const fallback = activeLlmFallback(sessionId);
  if (!fallback) return statusModel;
  const raw = fallback.model || fallback.provider;
  const short = raw.slice(raw.lastIndexOf('/') + 1) || raw;
  return `⚠ fallback: ${short}`;
}

/** 시험 심. */
export function resetLlmFallbacksForTest(): void {
  active.clear();
}
