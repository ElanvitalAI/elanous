/**
 * WEBCHAT-SESSION-HISTORY-PERSIST — 웹채팅 회원 세션의 소유자 기록·판정.
 *
 * 문제: bare `<handle>.elanous.app` 웹채팅은 회원 자격(wcs_ 파생 세션 쿠키 · emt_)만
 * 들고 오는데 `/v1/sessions/store` 는 소유자(데몬) 자격만 받아 목록이 늘 비었다
 * («아직 대화가 없습니다»). 세션 메타에는 «누구의 대화인가» 가 없었다.
 *
 * 규칙(fail-closed):
 * - 회원 턴이 세션을 처음 만들 때 `ownerMemberId` 를 새긴다(claimSessionForMember).
 * - 회원은 `ownerMemberId === 자기 memberId` 인 세션만 보고 이어 간다.
 * - 소유자 기록이 없는 옛 세션(운영자 CLI·텔레그램·데몬 PWA·이 수리 전 웹채팅)은
 *   어느 회원에게도 보이지 않는다 — 소유를 증명할 수 없으므로.
 * - 소유자(데몬) 자격 경로는 이 판정을 거치지 않는다(전체 목록 불변).
 */
import {
  createOwnedSession,
  deleteOwnedSession,
  listSessions,
  sessionRoot,
  updateSessionMeta,
  type SessionMeta,
} from '../../session/index.js';

/**
 * JUD #39431 필수(경로 탈출) — 회원 요청 sessionId 의 허용 꼴. 원천 = 기존 생성 규칙:
 * PWA `generateSessionId` (crypto.randomUUID · 대체 `s-<ts36>-<rand36>`) · 데몬
 * `buildPromptSessionId` (`http-<ts36>-<rand36>`). 그 밖(경로 구분자 · `..` · 절대경로 · 공백 · 과길이)은 거부.
 */
// OP 결정 #123699 — PWA 수리 폴백 rand 는 crypto.getRandomValues 64bit(hex 16자 ⊆ ≤16자)라
// 기존 정책을 그대로 통과한다(서버 변경 0 · hex32 유니언 폐기).
const MEMBER_SESSION_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:s|http)-[0-9a-z]{1,16}-[0-9a-z]{1,16})$/i;

export function isMemberSessionId(id: unknown): id is string {
  return typeof id === 'string' && MEMBER_SESSION_ID.test(id);
}

/** 회원이 이 세션을 소유하는가. 소유자 기록이 없으면 false(fail-closed). */
export function sessionOwnedByMember(meta: Pick<SessionMeta, 'ownerMemberId'> | undefined, memberId: string): boolean {
  return !!memberId && typeof meta?.ownerMemberId === 'string' && meta.ownerMemberId === memberId;
}

/** 디스크 색인의 세션 메타(없으면 undefined). */
export function findSessionMeta(id: string, root: string = sessionRoot()): SessionMeta | undefined {
  return listSessions({}, root).find((m) => m.id === id);
}

/**
 * 회원 턴 직전 — 세션을 이 회원 것으로 잡는다(JUD #39431 필수 ②: 생성과 최초 소유자 기록은 한 잠금 · 한 쓰기).
 * - 없는 세션: 회원 소유로 새로 만든다 → true.
 * - 이미 이 회원 소유: true.
 * - 남의 세션 · 다른 경로가 만든 무소유 세션(빈 것 포함) · 색인 밖 내용 있는 파일: false(호출자가 403).
 */
export function claimSessionForMember(id: string, memberId: string, root: string = sessionRoot()): boolean {
  if (!isMemberSessionId(id) || !memberId) return false;
  const result = createOwnedSession(id, memberId, { source: 'pwa', origin: 'pwa' }, root);
  return !!result && sessionOwnedByMember(result.meta, memberId);
}

class SessionOwnerMismatch extends Error {}

/** The ownership check and title write share one index lock. */
export function renameMemberSession(id: string, memberId: string, title: string, root: string = sessionRoot()): SessionMeta | null {
  if (!isMemberSessionId(id)) return null;
  try {
    return updateSessionMeta(id, (meta) => {
      if (!sessionOwnedByMember(meta, memberId)) throw new SessionOwnerMismatch();
      meta.title = title;
    }, root);
  } catch (error) {
    if (error instanceof SessionOwnerMismatch) return null;
    throw error;
  }
}

export function deleteMemberSession(
  id: string,
  memberId: string,
  root: string = sessionRoot(),
  beforeDelete?: () => void,
  afterDelete?: () => void,
): boolean {
  if (!isMemberSessionId(id)) return false;
  return deleteOwnedSession(id, memberId, root, beforeDelete, afterDelete);
}
