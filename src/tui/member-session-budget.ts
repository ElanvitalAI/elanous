import { debug } from '../debug/log.js';
import type { TuiMemberSessionFileState } from './member-session-contract.js';

// 출처: src/nexus/apps/app-auth.ts DEFAULT_SESSION_TTL_MS — 회원 aps_ 세션은 60분이고, 회원 API 에는
// 갱신 경로가 없다(src/nexus/api/public-routes.ts `/v1/members*` 목록 · members-api.ts 에 refresh/renew 없음).
// 그래서 빌드 중 갱신 대신 «시작 전에 거절»한다. 재연결은 새 토큰이라 app-build-run-authority 봉인
// (sessionHash)을 무효로 만든다 — 빌드 도중 재연결로 이어 붙일 수 없다.
export const MEMBER_APP_SESSION_TTL_MS = 60 * 60_000;
// 출처: src/graph-runner/app-build/cli-publish-approval-provider.ts trustedWindow 4분 ·
// src/graph-runner/capability-providers/app-build-publish-approval.ts pendingExpiresAt ≤ 5분 → 5분 + 소유자 확인 여유 1분.
export const APP_BUILD_APPROVAL_SESSION_MS = 6 * 60_000;
// 출처: OP 11-17 KCB 데모 보고 «잔여 58분 세션이 빌드 중 만료» — 실측 분포는 아직 없다(임시값).
// TTL 60분 − 승인 창 6분 − 사람 검토(review-publish) 여유 9분 = reserve→materialize 기계 시간 예산 45분.
export const APP_BUILD_EXPECTED_MS = 45 * 60_000;
// reserve 는 같은 토큰으로 승인까지 가야 한다(봉인 sessionHash) → 빌드 예산 + 승인 창.
export const APP_BUILD_RESERVE_SESSION_MS = APP_BUILD_EXPECTED_MS + APP_BUILD_APPROVAL_SESSION_MS;
// 출처: app-build-local-bridge.ts OWNER_TIMEOUT_MS 5초 · 승인 폴 간격 1초 — 폴 한 번을 끝낼 1분 여유.
export const APP_BUILD_POLL_SESSION_MS = 60_000;

export type MemberSessionStage = 'reserve' | 'approval-start' | 'approval-poll';
const REQUIRED: Record<MemberSessionStage, number> = {
  reserve: APP_BUILD_RESERVE_SESSION_MS,
  'approval-start': APP_BUILD_APPROVAL_SESSION_MS,
  'approval-poll': APP_BUILD_POLL_SESSION_MS,
};
export const BUILD_MEMBER_SESSION_EXPIRING = 'BUILD_MEMBER_SESSION_EXPIRING';

/** Typed refusal: `message` stays the BUILD_* machine code; `userMessage` carries minutes only, never a token. */
export class MemberSessionExpiringError extends Error {
  readonly code = BUILD_MEMBER_SESSION_EXPIRING;
  readonly userMessage: string;
  constructor(readonly stage: MemberSessionStage, readonly remainingMinutes: number, readonly requiredMinutes: number) {
    super(BUILD_MEMBER_SESSION_EXPIRING);
    this.name = 'MemberSessionExpiringError';
    this.userMessage = stage === 'reserve'
      ? `세션 잔여 ${remainingMinutes}분 < 빌드 예상 ${requiredMinutes}분 · 재연결 필요 (elanous member disconnect → elanous member connect 뒤 빌드를 시작하세요)`
      : `세션 잔여 ${remainingMinutes}분 < 승인 예상 ${requiredMinutes}분 · 재연결 필요 (재연결하면 이 빌드는 다시 시작해야 합니다)`;
  }
}

/** Refuse a stage whose member session cannot outlive it. Missing/unsafe files keep the existing fail-closed path. */
export function assertMemberSessionCovers(stage: MemberSessionStage, file: TuiMemberSessionFileState,
  log: (event: 'expiring', data: Record<string, unknown>) => void = (event, data) =>
    debug.log('member-session', event, data, { level: 'warn' })): void {
  if (file.state !== 'valid' && file.state !== 'expired') return;
  const required = REQUIRED[stage];
  if (file.state === 'valid' && file.remainingMs >= required) return;
  const remainingMinutes = Math.max(0, Math.floor(file.remainingMs / 60_000));
  const requiredMinutes = Math.ceil(required / 60_000);
  // member-session.expiring: stage and minutes only — no token, path or member identity.
  log('expiring', { stage, remainingMinutes, requiredMinutes, expired: file.state === 'expired' });
  throw new MemberSessionExpiringError(stage, remainingMinutes, requiredMinutes);
}
