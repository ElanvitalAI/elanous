// OP #127318 · ROSTER-0333-RANKED 31위 MEMBER-FILE-SHARE-LINK — 회원 파일 공유 링크 토큰 원장.
// 설계 근거 내부 문서 `member-file-space` 완성조각 3: 만료/폐기 가능한 불투명 토큰(256비트 CSPRNG),
// 원장에는 sha256 해시만 저장, 토큰은 발급 때의 불변 객체 버전(generation)에 결속, 읽기 전용·개별 폐기·재발급.
// 이 모듈은 저장소(object-store)·전송(proxy)와 독립적이며 주입 가능한 원장(MemberShareLedger)만 다룬다.
// 실패 경로는 전부 throw(fail-closed): 알 수 없는 토큰·만료·폐기·교체(superseded)·원장 파손·경로 조작.
// terra 셀프리뷰 mustFix ②③④ 수리(2026-11-22): 미존재/파손 구분+레코드 전수 검증, 인코딩된 구분자 거부+정규 키
// 일치, 갱신의 원자적 update 경유(독립 프로세스의 동시 발급·폐기가 서로를 덮어쓰지 않는 계약).
// terra 재리뷰 r2(2026-11-22) ②보강·③: records 배열·비정규(인코딩 잔존) objectKey 도 파손으로 거부,
// ttlMs·now 비유한수는 갱신 입력에서 거부, 모든 갱신은 저장 전 레코드 재검증(저장-읽기 계약 모순 제거).
// JUD 보안 HOLD 수리(OP #128536 · 판정 jud-39544-ea7110a91a0e.json): ① reissue 만료 검사 — 만료 토큰만으로
// 갱신 불가(경계는 resolve 와 동일: now > expires). ② 재발급·폐기 소유자 검증 — 인증된 호출자의
// ownerMemberId 가 레코드 소유자와 일치해야 한다(토큰 소지만으로 갱신·폐기 불가).
import { createHash, randomBytes } from 'node:crypto';

export const MEMBER_SHARE_LEDGER_NAME = 'member-share-links.json';

export const MEMBER_SHARE_TOKEN_PREFIX = 'mfs1_';
export const MEMBER_SHARE_TOKEN_BYTES = 32; // 256비트
/** 기본 만료 7일(설계: 만료·개별 폐기·재발급 지원 — 상한은 호출자가 ttlMs 로 조정). */
export const MEMBER_SHARE_DEFAULT_TTL_MS = 7 * 24 * 3600_000;

/** 원장 저장 추상 — 실구현은 파일(configDir) · 시험은 메모리/임시 디렉터리 주입.
 * 계약(terra mustFix ②④):
 *  - load(): 원장 미존재 → null. 파손(해석 불가)은 throw — 미존재와 파손을 구분한다(fail-closed).
 *    읽기 전용 연산(검증)만 load 를 쓴다.
 *  - update(mutate): 유일한 갱신 경로. mutate 는 현재 상태(원장 미존재 → null)를 받아
 *    { newState, result } 를 반환한다. 구현체는 newState 를 원자적으로 저장하되(상호배제 — 독립
 *    프로세스의 동시 발급·폐기가 load-전체-save 덮어쓰기로 서로를 지우지 않는다) mutate 가
 *    throw 하면 아무 것도 쓰지 않는다(원장 불변).
 *  - 갱신을 load/save 직접 호출로 수행하는 것은 계약 밖 — 모듈은 오직 update 를 경유한다. */
export interface MemberShareLedger {
  load(): Record<string, unknown> | null;
  update<T>(mutate: (state: Record<string, unknown> | null) => { newState: Record<string, unknown>; result: T }): T;
}

export interface CreateMemberShareOptions {
  ownerMemberId: string;
  /** 불변 객체 버전(GCS generation 등). 같은 경로를 교체해도 토큰은 이 버전만 가리킨다. */
  generation: string;
  now: number;
  ttlMs?: number;
}

export interface MemberShareRecord {
  token: string;
  objectKey: string;
  ownerMemberId: string;
  generation: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface ResolvedMemberShare {
  objectKey: string;
  ownerMemberId: string;
  generation: string;
  expiresAtMs: number;
}

interface StoredShare {
  tokenHash: string;
  objectKey: string;
  ownerMemberId: string;
  generation: string;
  createdAtMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
  supersededByHash: string | null;
}

interface LedgerState {
  version: 1;
  records: Record<string, StoredShare>;
}

/** 경로 검증(설계 «경로 정규화·디코딩은 한 번만») — 성공 시 저장·반환에 쓰는 정규 키(decoded)를 반환한다
 * (terra mustFix ③: 검증한 키와 저장·반환 키가 어긋나지 않는다). `..`, 인코딩된 구분자, NUL, 절대경로,
 * 타 prefix 접근은 전부 거부(fail-closed). 디코딩으로 구분자(/·\·NUL)가 새로 생기는 원본 키는
 * 디코딩 결과가 유효해도 명시적으로 거부한다 — 인코딩 숨김은 정규 키 체계와 어긋난다. */
export function assertMemberObjectKey(objectKey: string): string {
  let decoded = objectKey;
  if (objectKey.includes('%')) {
    try {
      decoded = decodeURIComponent(objectKey);
    } catch {
      throw new Error('invalid member object key: bad encoding');
    }
    if (decoded !== objectKey) {
      // 세그먼트 수가 늘었거나(인코딩된 '/') 새 백슬래시·NUL 이 생기면 인코딩된 구분자 — 거부.
      if (
        decoded.split('/').length !== objectKey.split('/').length
        || decoded.includes('\\') !== objectKey.includes('\\')
        || decoded.includes('\0') !== objectKey.includes('\0')
      ) {
        throw new Error('invalid member object key: encoded separator');
      }
    }
  }
  if (
    !decoded || decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0')
    || decoded !== decoded.trim() || decoded.includes('//')
  ) {
    throw new Error('invalid member object key');
  }
  const segments = decoded.split('/');
  if (
    segments.length < 4 || segments[0] !== 'members' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segments[1] ?? '')
    || (segments[2] !== 'private' && segments[2] !== 'public')
    || segments.some((part, i) => i >= 3 && (part === '' || part === '.' || part === '..' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)))
  ) {
    throw new Error('invalid member object key');
  }
  return decoded;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 레코드 계약 전수 검증(terra mustFix ② · r2 ②보강) — 필수 필드·타입이 어긋난 레코드(예: expiresAtMs 누락이
 * 만료 비교를 통과하는 것)는 원장 전체를 파손으로 거부한다(fail-closed). objectKey 는 생성 때와 같은
 * 정규화 함수로 재검증해 정규(decoded) 형식과 일치해야 한다 — 인코딩 잔존·비정규 키도 파손이다. */
function isValidStoredShare(rec: unknown, hash: string): boolean {
  if (!rec || typeof rec !== 'object') return false;
  const r = rec as Record<string, unknown>;
  if (!(
    typeof r.tokenHash === 'string' && r.tokenHash === hash && /^[0-9a-f]{64}$/.test(r.tokenHash)
    && typeof r.objectKey === 'string' && r.objectKey !== ''
    && typeof r.ownerMemberId === 'string' && r.ownerMemberId !== ''
    && typeof r.generation === 'string' && r.generation !== ''
    && Number.isFinite(r.createdAtMs) && Number.isFinite(r.expiresAtMs)
    && (r.expiresAtMs as number) > (r.createdAtMs as number)
    && (r.revokedAtMs === null || Number.isFinite(r.revokedAtMs))
    && (r.supersededByHash === null || (typeof r.supersededByHash === 'string' && /^[0-9a-f]{64}$/.test(r.supersededByHash)))
  )) return false;
  try {
    return assertMemberObjectKey(r.objectKey) === r.objectKey; // 정규 형식 아니면 파손(r2 ②보강)
  } catch {
    return false;
  }
}

/** 갱신 저장 전 재검증(terra r2 ③) — 발급·재발급·폐기가 만든 레코드가 읽기 계약(readState 전수 검증)을
 * 어기면 저장 자체를 거부한다. 어떤 갱신 경로도 원장에 readState 가 파손 판정할 상태를 남기지 않는다. */
function assertValidStoredShare(rec: StoredShare, hash: string): void {
  if (!isValidStoredShare(rec, hash)) throw new Error('member share record invalid');
}

/** 원장 해석(terra mustFix ② · r2 ②보강): null = 미존재 → 신규 초기 상태. 빈 객체·version 불일치·
 * records 배열([] 포함)·어긋난 레코드는 전부 파손으로 throw — 미존재와 파손을 절대 한 뭉치로 취급하지 않는다. */
function readState(raw: Record<string, unknown> | null): LedgerState {
  if (raw === null) return { version: 1, records: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('member share ledger corrupt');
  if (raw.version !== 1 || typeof raw.records !== 'object' || raw.records === null || Array.isArray(raw.records)) {
    throw new Error('member share ledger corrupt');
  }
  for (const [hash, rec] of Object.entries(raw.records)) {
    if (!isValidStoredShare(rec, hash)) throw new Error('member share ledger corrupt');
  }
  return raw as unknown as LedgerState;
}

function newToken(): string {
  return MEMBER_SHARE_TOKEN_PREFIX + randomBytes(MEMBER_SHARE_TOKEN_BYTES).toString('base64url');
}

/** 갱신 공통 경로(terra mustFix ④): 모든 원장 변경은 원자적 update 를 경유한다.
 * mutate 내부(=apply)가 throw 하면 구현체는 저장하지 않는다(원장 불변). */
function mutateLedger<T>(ledger: MemberShareLedger, apply: (state: LedgerState) => T): T {
  return ledger.update((raw) => {
    const state = readState(raw);
    const value = apply(state);
    return { newState: state as unknown as Record<string, unknown>, result: value };
  });
}

/** 발급 — 원장에는 토큰 평문을 절대 저장하지 않는다(sha256 만). */
export function createMemberShareLink(
  ledger: MemberShareLedger,
  objectKey: string,
  opts: CreateMemberShareOptions,
): MemberShareRecord {
  const normalizedKey = assertMemberObjectKey(objectKey);
  // ttlMs 는 유한 양수(terra r2 ③): Infinity 를 허용하면 expiresAtMs 가 읽기 전수 검증(유한수)과
  // 모순해 발급 직후 원장 전체가 파손 판정된다 — 저장-읽기 계약이 어긋나는 입력은 애초에 거부한다.
  if (!opts.ownerMemberId || !opts.generation || !Number.isFinite(opts.now)
    || (opts.ttlMs !== undefined && (!Number.isFinite(opts.ttlMs) || !(opts.ttlMs > 0)))) {
    throw new Error('invalid member share options');
  }
  const token = newToken();
  const tokenHash = hashToken(token);
  return mutateLedger(ledger, (state) => {
    const stored: StoredShare = {
      tokenHash,
      objectKey: normalizedKey,
      ownerMemberId: opts.ownerMemberId,
      generation: opts.generation,
      createdAtMs: opts.now,
      expiresAtMs: opts.now + (opts.ttlMs ?? MEMBER_SHARE_DEFAULT_TTL_MS),
      revokedAtMs: null,
      supersededByHash: null,
    };
    assertValidStoredShare(stored, tokenHash); // 저장 전 재검증(terra r2 ③) — 읽기 계약과 모순되는 저장 거부
    state.records[tokenHash] = stored;
    return { token, objectKey: normalizedKey, ownerMemberId: stored.ownerMemberId, generation: stored.generation, createdAtMs: stored.createdAtMs, expiresAtMs: stored.expiresAtMs };
  });
}

function lookupActive(state: LedgerState, token: string, now: number): StoredShare {
  if (!token || !token.startsWith(MEMBER_SHARE_TOKEN_PREFIX)) throw new Error('unknown member share token');
  const rec = state.records[hashToken(token)];
  if (!rec) throw new Error('unknown member share token');
  if (rec.revokedAtMs !== null) throw new Error('member share token revoked');
  if (rec.supersededByHash !== null) throw new Error('member share token superseded');
  if (!Number.isFinite(now) || now > rec.expiresAtMs) throw new Error('member share token expired');
  return rec;
}

/** 검증 — 통과 시에만 객체키·generation 반환. 만료는 경계 포함(now > expires). 읽기 전용: load 경유. */
export function resolveMemberShareLink(
  ledger: MemberShareLedger,
  token: string,
  opts: { now: number },
): ResolvedMemberShare {
  if (!token || typeof token !== 'string') throw new Error('unknown member share token');
  const state = readState(ledger.load());
  const rec = lookupActive(state, token, opts.now);
  return { objectKey: rec.objectKey, ownerMemberId: rec.ownerMemberId, generation: rec.generation, expiresAtMs: rec.expiresAtMs };
}

/** 개별 폐기 — 이미 폐기된 토큰 재폐기도 오류(원장 무결성).
 * JUD 보안 수리(판정 jud-39544-ea7110a91a0e.json): 폐기는 인증된 소유자만 — 호출자가 상위 계층에서
 * 확립한 인증 결과(ownerMemberId)가 레코드의 소유자와 일치해야 한다. 토큰 소지만으로는 폐기 불가(fail-closed). */
export function revokeMemberShareLink(ledger: MemberShareLedger, token: string, opts: { ownerMemberId: string; now: number }): void {
  if (!opts.ownerMemberId || !Number.isFinite(opts.now)) throw new Error('invalid member share options'); // JUD ② + terra r2 ③
  mutateLedger(ledger, (state) => {
    const hash = hashToken(token ?? '');
    const rec = state.records[hash];
    if (!rec) throw new Error('unknown member share token');
    if (rec.ownerMemberId !== opts.ownerMemberId) throw new Error('member share token not owned by caller'); // JUD ②
    if (rec.revokedAtMs !== null) throw new Error('member share token already revoked');
    rec.revokedAtMs = opts.now;
    assertValidStoredShare(rec, hash); // 저장 전 재검증 — 폐기도 원장을 파손시키지 않는다
  });
}

/** 재발급 — 옛 토큰 즉시 무효(superseded)+신규 토큰 반환. 동일 objectKey·generation·소유자를 유지한다.
 * 갱신 전체(옛 토큰 마킹+신규 등록)가 한 번의 원자적 update 안에서 일어난다(mustFix ④).
 * JUD 보안 수리(판정 jud-39544-ea7110a91a0e.json): ① 만료 검사 — 만료된 토큰만으로는 갱신 불가
 * (만료 경계는 resolve 와 동일: now > expires). ② 소유자 검증 — 인증된 호출자의 ownerMemberId 가
 * 레코드 소유자와 일치해야 한다. */
export function reissueMemberShareLink(
  ledger: MemberShareLedger,
  oldToken: string,
  opts: { ownerMemberId: string; now: number; ttlMs?: number },
): MemberShareRecord {
  if (!opts.ownerMemberId || !Number.isFinite(opts.now)) throw new Error('invalid member share options'); // JUD ② + terra r2 ③
  const token = newToken();
  const tokenHash = hashToken(token);
  return mutateLedger(ledger, (state) => {
    const oldHash = hashToken(oldToken ?? '');
    const old = state.records[oldHash];
    if (!old) throw new Error('unknown member share token');
    if (old.ownerMemberId !== opts.ownerMemberId) throw new Error('member share token not owned by caller'); // JUD ②
    if (old.revokedAtMs !== null) throw new Error('member share token already revoked');
    if (old.supersededByHash !== null) throw new Error('member share token already superseded');
    if (opts.now > old.expiresAtMs) throw new Error('member share token expired'); // JUD ① — 만료 토큰으로 갱신 불가
    // ttl 도 유한 양수(terra r2 ③) — Infinity 재발급이 저장-읽기 계약과 모순되지 않게 한다.
    const ttl = opts.ttlMs ?? (old.expiresAtMs - old.createdAtMs);
    if (!Number.isFinite(ttl) || !(ttl > 0)) throw new Error('invalid member share ttl');
    old.supersededByHash = tokenHash;
    old.revokedAtMs = opts.now;
    assertValidStoredShare(old, oldHash); // 마킹된 옛 레코드도 저장 전 재검증
    const fresh: StoredShare = {
      tokenHash,
      objectKey: old.objectKey,
      ownerMemberId: old.ownerMemberId,
      generation: old.generation,
      createdAtMs: opts.now,
      expiresAtMs: opts.now + ttl,
      revokedAtMs: null,
      supersededByHash: null,
    };
    assertValidStoredShare(fresh, tokenHash); // 신규 레코드 저장 전 재검증
    state.records[tokenHash] = fresh;
    return {
      token,
      objectKey: old.objectKey,
      ownerMemberId: old.ownerMemberId,
      generation: old.generation,
      createdAtMs: opts.now,
      expiresAtMs: opts.now + ttl,
    };
  });
}
