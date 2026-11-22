// 공유 링크 해석·읽기 진입점(링크 해석 핸들러) — JUD jud-39564-225ca0a55d12 · OP #132035.
// 판정: 버전 고정 get(jud-39564-e5edf3206d3b)만으론 부족 — 인증된 호출자와 객체 소유자의
// 결속이 없었다. 이 계층이 공유 링크로 객체 바이트를 내주는 유일한 경로이며, 두 계약을
// 한 곳에서 강제한다(fail-closed).
//  1. 소유자 결속: 상위 계층이 확립한 인증 결과(authenticatedMemberId)가 레코드 소유자와
//     일치해야 한다 — 폐기·재발급(jud-39544-ea7110a91a0e)과 같은 오류로 통일. 라우트(WIRE ②)는
//     이 오류를 403 으로 매핑한다. 빈 인증 결과(미인증)는 바이트 접근 전에 즉시 거부한다.
//  2. 고정 get: 발급 때의 generation 만으로 store.get 을 부른다 — 세대 없는 읽기 경로는
//     이 핸들러에 존재하지 않는다. 교체·이동·읽기 중 변경은 저장소 계층(GetOptions.generation
//     계약, jud-39564-e5edf3206d3b)이 거부한다 — «최신» 객체는 절대 내주지 않는다.
// 원장만 조회하는 resolveMemberShareLink 는 바이트를 내주지 않는다(검증 계층·member-share-link).
import { resolveMemberShareLink, type MemberShareLedger } from './member-share-link.js';
import type { ObjectStore } from './object-store.js';

export interface ReadMemberShareOptions {
  /** 발급 원장(member-share-link) — 만료·폐기·superseded·파손 검증은 resolve 계약을 경유한다. */
  ledger: MemberShareLedger;
  /** 객체 저장소 — get 은 발급 때 generation 으로 고정해 이 핸들러 안에서만 부른다. */
  store: ObjectStore;
  /** 공유 링크 토큰(mfs1_…). */
  token: string;
  /** 상위 계층이 확립한 인증 결과 — 이 읽기의 호출자. 빈 값(미인증)은 즉시 거부한다. */
  authenticatedMemberId: string;
  /** Unix epoch ms — 만료 경계는 resolve 계약(now > expires). */
  now: number;
  /** 고정 바이트를 내려받을 로컬 경로. */
  localPath: string;
}

export interface MemberShareReadResult {
  objectKey: string;
  ownerMemberId: string;
  generation: string;
  expiresAtMs: number;
  localPath: string;
}

export function readMemberShareObject(opts: ReadMemberShareOptions): MemberShareReadResult {
  if (!opts || typeof opts !== 'object') throw new Error('invalid member share read options');
  if (!opts.authenticatedMemberId || !opts.localPath || !Number.isFinite(opts.now)) {
    // 미인증·내려받을 경로 결손·시각 파손 = 계약 밖 입력 — 바이트 접근 전에 거부한다(fail-closed).
    throw new Error('invalid member share read options');
  }
  // 1. 원장 해석 — 알 수 없는 토큰·만료·폐기·superseded·원장 파손은 resolve 계약이 전부 throw 한다.
  const resolved = resolveMemberShareLink(opts.ledger, opts.token, { now: opts.now });
  // 2. 소유자 결속(403 상당) — 바이트를 내주기 전에. 폐기·재발급과 같은 실패 경로 오류로 통일한다.
  if (resolved.ownerMemberId !== opts.authenticatedMemberId) {
    throw new Error('member share token not owned by caller');
  }
  // 3. 고정 get — 세대 결속 읽기는 이 한 곳뿐. generation 은 원장 레코드 계약상 비지 않는다
  //    (빈 세대 결속 시도는 저장소가 거부한다 — GetOptions.generation 계약).
  opts.store.get(resolved.objectKey, opts.localPath, { generation: resolved.generation });
  return {
    objectKey: resolved.objectKey,
    ownerMemberId: resolved.ownerMemberId,
    generation: resolved.generation,
    expiresAtMs: resolved.expiresAtMs,
    localPath: opts.localPath,
  };
}
