import { debug } from '../debug/log.js';
import { jevDecide, jevSite, jevSiteQuestion, maskJevState, type JevDecideDeps } from '../kit/jev-decide/index.js';
import type { JevRequest, JevResponse } from './jev.js';

export interface BoundaryShadowConfig {
  enabled?: boolean;
  sampleRate?: number;
  endpoint?: string;
  keyFile?: string;
  model?: string;
  /** «되돌릴 수 없다»로 볼 Jev 확률 하한 — 기본 0.7. */
  threshold?: number;
}

export interface BoundaryShadowDeps {
  random?: () => number;
  callJev?: (request: JevRequest, key: string | undefined, fetchImpl: typeof fetch, endpoint: string) => Promise<JevResponse>;
  fetch?: typeof fetch;
  log?: (category: string, event: string, data: Record<string, unknown>, level?: 'info' | 'warn') => void;
  /** 사용량 원장(`llm.usage`) 기록 — 기본은 llm.ts 의 logAgentTurnUsage(역할 classify · site jev-boundary-shadow). */
  logUsage?: (model: string, usage: { inputTokens?: number; outputTokens?: number }) => void;
  now?: () => number;
}

// Redaction · egress · timeout + abort · usage row · 402 breaker = the kit (src/kit/jev-decide) · question text = jev-sites.yaml `boundary-shadow`.
const maskBoundaryValue = (value: unknown): unknown => maskJevState(value);

/** Advisory only: never changes the code boundary verdict or the response sent to the caller. */
export async function shadowBoundaryDecision<T extends { requestId?: string; requestKind?: string }>(
  request: T,
  verdict: { wouldApprove?: boolean; approve?: boolean; requestKind?: string; evidenceWhy?: string },
  config?: BoundaryShadowConfig,
  deps: BoundaryShadowDeps = {},
): Promise<void> {
  if (config?.enabled !== true || request.requestKind !== 'rejected' || verdict.requestKind !== 'rejected') return;
  const rate = config.sampleRate ?? 1;
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1 || (rate < 1 && (deps.random ?? Math.random)() >= rate)) return;

  const log = deps.log ?? ((category: string, event: string, data: Record<string, unknown>, level?: 'info' | 'warn') => debug.log(category, event, data, level ? { level } : undefined));
  const safeRequestId = maskBoundaryValue(request.requestId) as string | undefined;
  const emit = (event: string, data: Record<string, unknown>, level?: 'info' | 'warn') => {
    try { log('decide.boundary-shadow', event, maskBoundaryValue({ ...data, requestId: safeRequestId }) as Record<string, unknown>, level); } catch { /* observation must not affect the boundary */ }
  };
  const site = jevSite('boundary-shadow');
  const question = jevSiteQuestion(site, 'irreversible');
  if (!question) { emit('failed', { reason: 'no-question' }); return; }
  try {
    const state = maskBoundaryValue({ request, verdict: {
      requestKind: verdict.requestKind, evidenceWhy: verdict.evidenceWhy,
    } });
    const kitDeps: JevDecideDeps = {
      ...(deps.callJev ? { callJev: deps.callJev } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.logUsage ? { logUsage: (model, usage) => deps.logUsage!(model, usage) } : {}),
    };
    const decided = await jevDecide({ site, state, questions: { irreversible: question }, accessConfig: config }, kitDeps);
    if (!decided.ok) {
      emit('failed', { reason: decided.reason === 'no-key' ? 'credentials-unavailable' : decided.reason === 'timeout' ? 'timeout' : 'request-failed' });
      return;
    }
    const response = decided.response;
    const jevYes = response.answers.irreversible?.noul;
    if (typeof jevYes !== 'number' || !Number.isFinite(jevYes)) { emit('failed', { reason: 'no-answer' }); return; }
    const threshold = typeof config.threshold === 'number' && config.threshold > 0 && config.threshold < 1 ? config.threshold : site.threshold;
    const allowlistApprove = verdict.wouldApprove === true;
    const irreversible = jevYes >= threshold;
    const judged = {
      requestKind: verdict.requestKind, decidingToken: (request as { decidingToken?: string }).decidingToken, evidenceWhy: verdict.evidenceWhy,
      allowlistApprove, jevYes, irreversible, agree: allowlistApprove === !irreversible, threshold,
      confidence: response.answers.irreversible?.confidence, latencyMs: decided.ms, model: response.model,
    };
    emit('judged', judged);
    // 핵심 지표: 허용목록이 막았는데 되돌릴 수 있는 명령(오탐 차단) · 반대로 통과시켰는데 되돌릴 수 없는 명령(경고).
    if (!allowlistApprove && !irreversible) emit('safe-but-blocked', judged);
    if (allowlistApprove && irreversible) emit('warn-disagree', judged, 'warn');
  } catch {
    emit('failed', { reason: 'request-failed' });
  }
}
