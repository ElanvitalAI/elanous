import { debug } from '../debug/log.js';
import { canonicalizeBackendId } from '../acp/backend-registry.js';

export type RequestOrigin = 'owner' | 'external-agent';

/** ACP claude and the agent-mission claude backend use the same subscription identity. */
export const CLAUDE_SUBSCRIPTION_BACKENDS: readonly string[] = ['claude'];

export class ClaudeSubscriptionNotAllowedError extends Error {
  constructor() {
    // 대표 결정 V7 B — 사용자에게 보이는 문구엔 내부 표식을 싣지 않는다(공개 내보내기 누출 검사).
    super('바깥 요청은 소유자의 Claude 구독으로 돌지 않는다');
    this.name = 'ClaudeSubscriptionNotAllowedError';
  }
}

export function assertClaudeSubscriptionAllowed({ origin, backendId, surface }: {
  origin: RequestOrigin;
  backendId: string;
  surface: string;
}): void {
  if (origin !== 'external-agent' || !CLAUDE_SUBSCRIPTION_BACKENDS.includes(canonicalizeBackendId(backendId))) return;
  debug.log('policy.claude-subscription', 'refused', { origin, backendId, surface });
  throw new ClaudeSubscriptionNotAllowedError();
}
