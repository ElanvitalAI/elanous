// ── CLAUDE-IMPL-LANE — `--child-llm-provider claude-acp` 의 구현 실행 (호스트 레인 · 구독 ACP) ──
//
// claude-acp 는 «LLM provider» 가 아니라 구현 실행기 선택이다. 이 갈래는 implement seam 이 PTY 자식
// (`elanous chat` · getProvider) 대신 부른다 — PTY 자식으로 보내면 getProviderForConfig 가 모델 이름(claude-…)을
// 보고 anthropic(API 키 provider)으로 풀어 «구독» 런이 API 로 과금된다(10-11 #26277 보류 판독).
//
// fail-closed: 구독 확인 실패 · 사용률 미측정 · 상한(기본 85%) 이상 · 프록시 주소 없음이면 거부하고
// 다른 공급자로 조용히 새지 않는다(거부 사유는 관측 `self-implement.claude-acp` `refused`).
import { debug } from '../debug/log.js';
import { makeAcpImplementer, type AcpImplementerOpts, type AcpImplementerResult } from '../agent-substrate/acp-implementer.js';
import { subscriptionReviewerAvailability, type SubscriptionReviewerDeps } from '../self-dev/review-provider-fallback.js';

/** 구현 레인의 구독 사용률 상한(%) — 대표 10-11 «Claude 구독(ACP) = 계정 둘 · 85 까지». 리뷰어 상한(95)과 별개 값. */
export const CLAUDE_ACP_IMPLEMENT_CAP_DEFAULT = 85;
export const CLAUDE_ACP_PROVIDER = 'claude-acp';

export function isClaudeAcpChild(childLlm: { provider?: string } | undefined): boolean {
  return childLlm?.provider?.trim().toLowerCase() === CLAUDE_ACP_PROVIDER;
}

/** 상한은 `ELANOUS_CLAUDE_ACP_CAP`(0~100)로만 바꾼다 — 잘못된 값은 기본 85(올려 잡지 않는다). */
export function claudeAcpImplementCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ELANOUS_CLAUDE_ACP_CAP?.trim();
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : CLAUDE_ACP_IMPLEMENT_CAP_DEFAULT;
}

export type ClaudeAcpImplementOutcome =
  | { kind: 'refused'; reason: string }
  | { kind: 'ran'; result: AcpImplementerResult };

export interface ClaudeAcpImplementInput {
  cwd: string;
  prompt: string;
  model?: string;
  runId?: string;
  env?: NodeJS.ProcessEnv;
  /** 시험 주입 — 구독 확인·상태 읽기. */
  availabilityDeps?: SubscriptionReviewerDeps;
  /** 시험 주입 — ACP 에이전트 생성기(makeAcpImplementer 로 그대로 넘긴다). */
  createAgent?: AcpImplementerOpts['createAgent'];
  timeoutMs?: number;
}

export async function runClaudeAcpImplement(input: ClaudeAcpImplementInput): Promise<ClaudeAcpImplementOutcome> {
  const env = input.env ?? process.env;
  const cap = claudeAcpImplementCap(env);
  const availability = subscriptionReviewerAvailability({ provider: CLAUDE_ACP_PROVIDER }, cap, env, input.availabilityDeps ?? {});
  if (!availability.spawn) {
    const reason = availability.reason ?? 'Claude subscription unavailable';
    debug.log('self-implement.claude-acp', 'refused', { reason, cap, ...(input.runId ? { runId: input.runId } : {}) }, { level: 'warn' });
    return { kind: 'refused', reason };
  }
  const proxyBaseUrl = availability.spawn.env.ANTHROPIC_BASE_URL;
  debug.log('self-implement.claude-acp', 'start', { cap, proxy: proxyBaseUrl !== undefined, model: input.model ?? '(default)', ...(input.runId ? { runId: input.runId } : {}) });
  const implement = makeAcpImplementer({
    worktree: input.cwd,
    env,
    ...(proxyBaseUrl ? { proxyBaseUrl } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.createAgent ? { createAgent: input.createAgent } : {}),
  });
  const result = await implement(input.prompt);
  debug.log('self-implement.claude-acp', 'done', { chars: result.text.length, allowed: result.allowed, denied: result.denied, ...(input.runId ? { runId: input.runId } : {}) });
  return { kind: 'ran', result };
}
