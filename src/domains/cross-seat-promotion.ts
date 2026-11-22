// MEMORY-CROSS-SEAT-PROMOTION (0.3.33 · OP ROSTER-0333-60 행 5 P1) — 자리 교차 교훈 전역 승격.
//
// 완료선(로스터 원문): 두 자리 이상에서 같은 교훈(feedback 기억)이 나오면 전역 기억으로 승격
// (새벽 응축 record 단계) · 턴마다 se…(절단 — 「턴마다 검색 시 전역 기억 우선」으로 해석).
//
// 설계(memory-consolidate.ts M3/M4와 같은 계열 — surface events DB):
//   · 자리(seat) 축 = events.surface(예: 'seat:TC-H-POOL-4'). terra r3 mustFix #3: `seat:` 접두가
//     «실제 자리» 표시다 — 접두 없는 surface(cli·memory·telegram 등)는 자리가 아니므로 집계에서
//     제외한다(null). 접두 없는 값을 그대로 자리로 세면 서로 다른 비자리 surface 둘이 교차 자리
//     임계를 충족한다.
//   · 같은 교훈 판정 = 결정론 정규화(normalizeLessonKey): 소문자·공백·구두점 접기 + «전체 내용»
//     (terra r2 mustFix #3: 앞 64자 절단은 긴 공통 접두 뒤 별개 교훈을 오승격·원본까지 오마킹했다).
//     terra r4 잔여 [3]: 구두점 접기는 x != y / x == y 같은 «의미 변경» 구두점까지 접으므로
//     그룹 키는 소프트 키 + 연산자 지문(lessonIdentityKey) — 의미가 다른 본문은 합치지 않는다.
//     terra r6(JUD-C mustFix #39517): 지문은 «붙여 쓴» 비교 연산자(x!=y)도 표기(공백·엄격 계열)와
//     무관한 정규 토큰(≠ = ≤ ≥ < >)으로 남긴다 — 연산자가 통째로 사라져 x!=y 와 x==y 가 같은 키로
//     충돌하는 일이 없다(붙은 x!=y ↔ 떨어진 x != y 는 여전히 같은 교훈으로 병합).
//     terra r3 mustFix #1(= JUD-C mustFix a): 판정 재료는 «본문» 뿐이다 — summary 는 표시용 메타
//     (기본값조차 본문 접두)라 동일 요약·상이 본문을 같은 교훈으로 오승격한다.
//     ⛔ 임베딩·LLM 없음(새벽 응축은 결정론 우선 — M3 «결정론 우선(무비용)» 원칙 동일).
//   · 승격 재료 kind = «lesson» 정확 일치만(terra r2 mustFix #1: feedback 는 kind === 'lesson'
//     계약 밖 — 스캔 대상에서 제거, 원본은 그대로 둔다).
//   · 승격 = kind='cross-seat-lesson' 이벤트 1건(recordEvent) + 원본 consolidated=1 마킹(M3 표준).
//     승격 행에는 seats 리스트·occurrences·lessonKey 를 남긴다(회상·감사 가능).
//     terra r3 mustFix #2: 승격 본문은 교훈 «전체» 를 보존한다 — 원본 본문 전문(공백 접기만)을
//     실어 넣고 절단(90자)을 폐지한다. 잘린 요약·접두로는 교훈 핵심이 전역 기억에 남지 않는다.
//     terra r4 잔여 [5]: 행수 제한(slice(0,10))도 폐지 — 승격은 원본 «전부» 를 소비(consolidated
//     마킹)하므로 소비하는 원본의 전체 내용을 실어야 한다(11번째 이후 누락 금지).
//   · 멱등: 이미 승격된 lessonKey(활성 cross-seat-lesson 행 tags 의 실제 lessonKey)는 재승격하지 않는다.
//     승격문 «본문» 정규화로는 헤더·불릿 때문에 실제 키와 안 맞는다(JUD-C mustFix #39517).
//   · 원자성·동시성(terra r2 mustFix #4): 판정(스캔·기존 승격 조회)·삽입·마킹 «전부» 를 단일
//     트랜잭션에 묶는다 — 두 record 실행이 같은 미승격 상태를 동시에 읽어도 SQLite 쓰기 직렬화로
//     한 실행만 커밋하고(나머지 전체 롤백 후 다음 record 단계 재시도) 그룹 판정 직전 기존 승격을
//     다시 조회해 경쟁 커밋을 관측한다. 사이 중단 시 둘 다 롤백 — 부분 승격 상태 0(재시도 안전).
//   · 배선: graphs/memory/recipes.yaml record 단계(새벽 응축) — 이 모듈을 record 커맨드에 추가.

import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { recordEvent } from './surface-events.js';
import { classifySurfaceUtteranceOrigin } from './surface-events.js';

export interface CrossSeatLessonRow {
  readonly id: string;
  readonly ts: string;
  readonly surface: string;
  readonly text: string;
  readonly summary: string | null;
}

/** 승격 재료 kind — «lesson» 정확히 일치(부분 문자열 아님 · JUD HOLD #125713 보강 1). terra r2
 *  mustFix #1: feedback 는 kind === 'lesson' 계약 밖이라 제거 — 미사용 공개 타입(동 #5)도 함께 정리. */
export const CROSS_SEAT_LESSON_KINDS = ['lesson'] as const;

/** 신뢰 출처 — 사람(human) 직접 발화만 승격 재료로 인정(시험 fixture·에이전트·미상 제외 · JUD HOLD #125713 보강 2). */
export const TRUSTED_PROMOTION_ORIGINS = ['human'] as const;

/** 승격 금지 태그 — 비공개·기밀(credential) 표시 행은 전역 복제 금지(보강 3 · terra r2 mustFix #2:
 *  key·token 추가 — API 키·토큰류 교훈은 비밀 재료라 전역 승격 금지). */
export const PROMOTION_DENY_TAGS = ['private', 'secret', 'key', 'token', 'no-share', 'do-not-share'] as const;

/** 태그 «실제 저장 형식» 파싱(terra r2 mustFix #2) — ①공백/쉼표 낱말(tags='private, ops')
 *  ②key:value provenance 낱말(origin:human) ③JSON 배열/객체/따옴표 낱말(tags='["secret","ops"]',
 *  '{"tag":"token"}') 모두에서 금지 태그 검증. 낱말 접기는 구조 문자(따옴표·괄호·콜론·하이픈)까지
 *  구분자로 취급한다 — 비공개 누출 방향의 과차단이 안전하다(오탐은 회상·감사에서 확인). */
export function isPromotionDeniedByTags(tags: string | null): boolean {
  if (!tags) return false;
  const denied = (text: string): boolean => {
    const words = new Set(text.toLowerCase().split(/[\s,]+/).filter(Boolean));
    const folded = new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    return PROMOTION_DENY_TAGS.some(deny => words.has(deny) || folded.has(deny));
  };
  if (denied(tags)) return true;
  // JSON 저장 형식 — 객체 키·값, 배열 원소를 순회(문자열 값은 같은 낱말 검증 적용).
  try {
    const parsed: unknown = JSON.parse(tags);
    const walk = (value: unknown): boolean => {
      if (value == null) return false;
      if (typeof value === 'string') return denied(value);
      if (Array.isArray(value)) return value.some(walk);
      if (typeof value === 'object') {
        return Object.entries(value as Record<string, unknown>).some(([k, v]) => denied(k) || walk(v));
      }
      return false;
    };
    return walk(parsed);
  } catch {
    return false;
  }
}

/** 승격 행 tags 에 저장된 «실제» lessonKey 회수(JUD-C mustFix #39517) — 저장 형식:
 *  {"seats":[…],"occurrences":N,"lessonKey":"…"}. tags 가 JSON 객체가 아니거나 lessonKey 가
 *  없으면 null(멱등 비교 재료가 될 수 없는 행). 승격문 «본문» 정규화는 헤더·불릿까지 접히는
 *  탓에 실제 교훈 키와 절대 일치하지 않으므로 마킹 비교에 쓰지 않는다.
 *  terra mustFix r2(OP #129296 · PR #39582): 저장 lessonKey 는 비가역 해시 표현(lessonKeyHash)
 *  이다 — 마킹 비교는 «같은 원문 → 같은 해시» 로 멱등성을 유지한다. */
export function storedLessonKey(tags: string | null): string | null {
  if (!tags) return null;
  try {
    const parsed: unknown = JSON.parse(tags);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const key = (parsed as Record<string, unknown>).lessonKey;
    return typeof key === 'string' && key ? key : null;
  } catch {
    return null;
  }
}

/** terra mustFix r2 #1(OP #129296 · PR #39582) — 전역 메타데이터 비가역 표현: 원문 도출 키를
 *  SHA-256 접두 해시(16자리 hex)로 저장한다. 같은 원문 → 같은 해시(멱등성 유지), 해시 → 원문
 *  복원 불가. 승격 행 전역 메타데이터(tags)에서 원문 키·본문이 평문으로 남는 경로를 제거한다. */
export function lessonKeyHash(text: string): string {
  return createHash('sha256').update(lessonIdentityKey(text)).digest('hex').slice(0, 16);
}

/** terra r3 mustFix 1·2(PR #39582) — 문자열 자체의 SHA-256 16자 접두 해시. 활성 승격 행의
 *  «이미 저장된» 값이 과거 평문 키(r2 이전 형식)일 때 그 도출 해시(= 저장 값을 키로 쓴다면
 *  새 형식에서 저장됐을 값)를 계산해 멱등 비교를 맞춘다. 마이그레이션 갱신값도 이 헬퍼로 통일. */
export function sha256Hex16(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** 저장 lessonKey 의 비가역 해시 표현 형식명 — 마이그레이션·신규 승격 저장 시 tags 에 명시한다. */
export const LESSON_KEY_FORMAT = 'sha256-16';

/** 승격 행 tags 가 «이미 해시 형식» 인지 — 명시적 형식 표기(lessonKeyFormat==='sha256-16')로만
 *  판정한다. terra r5 mustFix 1: 평문 키가 우연히 16자 hex 처럼 보여도(예: 교훈 본문 자체가
 *  hex 낱말) 해시로 «오인»하면 도출 해시를 멱등 집합에 넣지 않아 중복 승격한다 — 외형 정규식
 *  (HASH16_RE) 폐지, 저장 형식의 모호성은 명시 표기로 해소한다(미표기 = 과거 평문). */
export function isHashFormattedLessonKeyTags(tags: string | null): boolean {
  if (!tags) return false;
  try {
    const parsed: unknown = JSON.parse(tags);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return (parsed as Record<string, unknown>).lessonKeyFormat === LESSON_KEY_FORMAT;
  } catch {
    return false;
  }
}

/** 공유 허용 표기 채널 — 인증된 provenance 채널(refs JSON)의 «구조화» 표기만 인정한다.
 *  tags·본문에 적힌 허용 표기는 표시용 메타 채널이라 위조(출처 위장)가 가능하다(OP #129296 위조 회귀 ③).
 *  refs 는 recordInboundTurn/provenance 기록기가 쓰는 신뢰 채널이다 — 승격 허용은 이 채널의
 *  명시적 boolean 표기(refs.crossSeatShare === true)로만 주어진다. 미표기 = 거부(기본값 뒤집기). */
const SHARE_CONSENT_FIELD = 'crossSeatShare';

/** 행의 공유 허용 표기 — refs JSON 에 `crossSeatShare: true`(boolean 정확 일치)가 있을 때만 참.
 *  문자열 'true'·숫자 1·tags 채널 표기는 인정하지 않는다(위조 출처 방어). */
export function hasShareConsent(refs: string | null): boolean {
  if (!refs) return false;
  try {
    const parsed: unknown = JSON.parse(refs);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return (parsed as Record<string, unknown>)[SHARE_CONSENT_FIELD] === true;
  } catch {
    return false;
  }
}

/** 승격 호출 경로(OP #130184 처분 B 재판정 · r6) — 'operational' = 제품 lifecycle record 단계
 *  (운영 호출) · 'authenticated' = 인증 경로(사람 승인 기록 경로 — 착지 전). 승격 허용 재료는
 *  refs 표기(위조 가능 채널 — crossSeatShare·출처 직접 기입과 실제 제품 기록을 구별 불가)를
 *  신뢰하지 않고 이 «호출 경로»만 본다. */
export type PromotionCallPath = 'operational' | 'authenticated';

/** 승격 허용 호출 경로(화이트리스트) — 운영('operational')은 영구 거부(코드 강제): 운영 호출에서는
 *  refs 에 crossSeatShare=true·사람 출처가 직접 기입돼 있어도 승격·원본 마킹이 0이다(회귀 ⑩).
 *  인증 경로가 착지되면 그 경로의 진입점에서만 'authenticated' 를 넘겨 승격이 열린다(«그 경로만
 *  여는 구조») — 현재 이 값을 제품이 넘기는 호출점은 0개, 시험 우주의 승격 로직 검증 주입만 존재. */
export const ALLOWED_PROMOTION_CALL_PATHS: readonly PromotionCallPath[] = ['authenticated'];

export interface CrossSeatPromotionResult {
  /** 검사한 feedback/교훈 행 수. */
  readonly scanned: number;
  /** 승격된 교훈 수. */
  readonly promoted: number;
  /** 이미 승격돼 멱등 스킵된 교훈 수. */
  readonly alreadyPromoted: number;
  /** 두 자리 미만(단일 자리) 교훈 수 — 승격 대상 아님. */
  readonly singleSeat: number;
  /** 신뢰 출처 아님(사람 발화 아님·시험 fixture 등)으로 제외된 행 수(회귀 보고용 · JUD #125713). */
  readonly untrustedOrigin: number;
  /** 비공개 금지 태그로 제외된 행 수(회귀 보고용 · JUD #125713). */
  readonly deniedByTags: number;
  /** 공유 허용 표기 없음(미표기=거부 · OP #129296)으로 제외된 행 수. */
  readonly noShareConsent: number;
  /** 운영 호출 경로(인증 경로 미착지)로 승격·원본 마킹이 강제 차단된 임계 충족 그룹 수(OP #130184). */
  readonly blockedByCallPath: number;
  readonly promotedIds: readonly string[];
}

/** 승격 임계 — 두 자리 이상(출처: 로스터 행 5 완료선 «두 자리 이상에서 같은 교훈»). */
export const CROSS_SEAT_MIN_SEATS = 2;

/** 교훈 정규화 키 — 소문자·구두점·공백 접기 후 «전체 내용»(결정론 · LLM 0). terra r2 mustFix #3:
 *  앞 64자 절단은 긴 공통 접두 뒤 «서로 다른» 교훈을 같은 키로 오승격·원본까지 오마킹했다 — 절단 제거. */
export function normalizeLessonKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”"'`‘’]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** terra r6(JUD-C mustFix #39517) — 비교 연산자 정규 토큰표: !==/!= → ≠ · ===/== → = ·
 *  <= → ≤ · >= → ≥ · < → < · > → >. 붙여 쓰기(x!=y)·떨어져 쓰기(x != y)·엄격 계열(===/!==)
 *  표기 차이는 «같은 교훈의 변형» 이므로 같은 토큰으로 접고, 의미가 다른 연산자끼리(≠ vs =)는
 *  갈라진다 — 비교 연산자는 정규 토큰으로 접히므로 키에서 통째로 사라지지 않는다. */
const COMPARISON_OPERATOR_TOKEN: Readonly<Record<string, string>> = {
  '===': '=', '!==': '≠', '==': '=', '!=': '≠', '<=': '≤', '>=': '≥', '<': '<', '>': '>',
};

/** 본문의 비교 연산자(=== !== == != <= >= < >)를 «본문 순» 정규 토큰(≠ = ≤ ≥ < >)으로.
 *  교대 선택 순서(=== → !== → == → != → <= → >= → < → >)가 최대 일치를 보장한다 — == 이
 *  === 를 먼저 삼키면 나머지 = 이 토큰 없이 실종된다. */
const comparisonOperatorTokens = (text: string): string[] =>
  (text.match(/===|!==|==|!=|<=|>=|<|>/g) ?? []).map(op =>
    op === '===' || op === '==' ? '=' : op === '!==' || op === '!=' ? '≠' : op === '<=' ? '≤' : op === '>=' ? '≥' : op,
  );

/** terra r4 잔여 [3] — 구두점 «의미 지문»: normalizeLessonKey 의 구두점→공백 접기는 x != y 와
 *  x == y 를 같은 키로 접는다. 공백(또는 문두/문말)으로 둘러싸인 «최대» 구두점 연속(+ - 등)은
 *  의미를 바꾸므로 지문에 남기고, 낱말에 «붙은» 구두점 연속(강조 금지! · 접속 교훈: · 누락!!)과
 *  인용부는 «연속 전체» 가 접는다 — 붙은 연속의 잔여 조각이 standalone 로 새면 같은 교훈의
 *  변형(누락/누락!!)이 갈라진다(r2·r3 회귀의 대소문자·공백·붙은 강조 변형 병합은 그대로 유지).
 *  terra r6(JUD-C mustFix #39517): r4 지문은 standalone 연속만 잡으므로 «붙은» 비교 연산자
 *  (x!=y)가 통째로 사라져 x==y 와 같은 키로 충돌했다 — 비교 연산자는 붙음·공백과 무관하게
 *  정규 토큰(comparisonOperatorTokens)으로 지문에 남고, standalone 연속 중 순수 비교
 *  연산자 run 만 원문 중복을 제거한다(x != y 와 x!=y → 같은 '≠' 로 병합). */
export function lessonOperatorFingerprint(text: string): string {
  const ops = comparisonOperatorTokens(text);
  const standalone = (text.match(/(?<!\S)[^\p{L}\p{N}\s]+(?!\S)/gu) ?? [])
    .filter(run => !(run in COMPARISON_OPERATOR_TOKEN)); // 순수 비교 연산자 연속은 정규 토큰으로 이미 포함
  return [...ops, ...standalone].join(' ');
}

/** 그룹 키(terra r4 잔여 [3] + r6) — 소프트 키(normalizeLessonKey) + 의미 지문(비교 연산자
 *  정규 토큰 포함). 지문이 빈 본문(비교 연산자·standalone 구두점 없는 대다수)의 키는 종전과
 *  동일 → 기존 회귀·통합 승격(lessonKey 태그 저장) 호환 유지. 승격 그룹 판정·본문 요약·tags
 *  lessonKey 저장·원본 마킹 전부 이 키 도출 하나로 나온다(promoteCrossSeatLessons 내 단일 출처). */
export function lessonIdentityKey(text: string): string {
  const soft = normalizeLessonKey(text);
  const fingerprint = lessonOperatorFingerprint(text);
  return fingerprint ? `${soft} [op: ${fingerprint}]` : soft;
}

/** surface 값에서 «실제» 자리 id — 'seat:TC-H-POOL-4' → 'TC-H-POOL-4'. terra r3 mustFix #3:
 *  `seat:` 접두가 없는 surface(cli·memory·telegram 등)는 자리가 «아니다» → null 로 집계에서 제외.
 *  접두 없는 값을 그대로 자리로 세면 서로 다른 비자리 surface 둘이 교차 자리 임계를 충족한다. */
export function seatOfSurface(surface: string): string | null {
  if (!surface.startsWith('seat:')) return null;
  // terra r4 잔여 [4]: 'seat:' → '' 빈 식별자도 자리로 집계되면 빈 자리 + seat:A 만으로
  // 교차 자리 임계를 충족한다 — 빈 식별자는 null 로 제외한다.
  const seat = surface.slice(5);
  return seat.length > 0 ? seat : null;
}

export interface CrossSeatPromotionDeps {
  readonly now?: () => string;
  /** 결정론 요약(기본: 정규화 키 앞 bullet). */
  readonly summarize?: (lessonKey: string, seats: readonly string[]) => string;
  /** 호출 경로 — 기본 'operational'(제품 lifecycle record 단계와 같은 운영 진입). 운영 경로는
   *  인증 경로 착지 전까지 승격·원본 마킹 0을 강제한다(OP #130184 처분 B). */
  readonly callPath?: PromotionCallPath;
}

/** ★ 두 자리 이상 같은 교훈 → 전역 기억(kind='cross-seat-lesson') 승격 + 원본 consolidated 마킹.
 *  JUD 보안 HOLD #125713 보강: ① kind 정확 일치(부분 문자열 금지) ② 신뢰 출처(사람 발화)만 승격 재료
 *  ③ 비공개 금지 태그 행 미승격 — 제외된 행은 원본 consolidated 마킹 없이 그대로 둔다(미승격 회귀).
 *  OP #129296(JUD HOLD jud-39517) 프라이버시 기본값 뒤집기: ④ 미표기=거부 — 인증된 출처(human)의
 *  명시적 공유 허용 표기(refs.crossSeatShare===true)가 «있을 때만» 승격 ⑤ 승격 본문은 원문 전문 대신
 *  요약(정규화 키 접두)·출처 포인터만 저장 — 원문 전문은 전역에 안 간다. */

export function promoteCrossSeatLessons(sdb: Database, deps: CrossSeatPromotionDeps = {}): CrossSeatPromotionResult {
  // 동시성(terra r2 mustFix #4): 판정(스캔·기존 승격 조회)·삽입·마킹 «전부» 를 단일 트랜잭션에
  // 묶는다 — 두 record 실행이 같은 미승격 상태를 동시에 읽어도 SQLite 쓰기 직렬화로 한 실행만
  // 커밋한다(나머지는 전체 롤백 후 다음 record 단계에서 재시도 — 부분 승격 상태 0).
  return sdb.transaction(() => {
    const now = deps.now?.() ?? new Date().toISOString();
    const callPath = deps.callPath ?? 'operational';
    // OP #130184(처분 B 재판정) — 승격 허용 재료는 refs 표기를 신뢰하지 않고 «호출 경로»만 본다.
    // 운영 경로는 인증 경로 착지 전까지 허용 목록에 없다 → 승격·원본 마킹 0 강제(회귀 ⑩).
    const promotionPathAllowed = (ALLOWED_PROMOTION_CALL_PATHS as readonly string[]).includes(callPath);
    // 대상: lesson 계열(kind 정확 일치) · 미응축 · 사람(human) 발화 · 비공개 금지 태그 없음.
    const kindPlaceholders = CROSS_SEAT_LESSON_KINDS.map(() => '?').join(',');
    const rows = sdb
      .prepare(
        `SELECT id, ts, surface, direction, kind, text, summary, tags, refs FROM events
         WHERE kind IN (${kindPlaceholders}) AND (consolidated IS NULL OR consolidated = 0)
         ORDER BY ts ASC`,
      )
      .all(...CROSS_SEAT_LESSON_KINDS) as Array<CrossSeatLessonRow & {
        direction: string; kind: string; tags: string | null; refs: string | null;
      }>;

    // 신뢰 출처·비공개 태그·공유 허용 표기 사전 필터 — 제외 행은 총계만 남기고 승격 재료에서 뺀다.
    const trusted: Array<CrossSeatLessonRow & { direction: string; kind: string; tags: string | null; refs: string | null }> = [];
    let untrustedOrigin = 0;
    let deniedByTags = 0;
    let noShareConsent = 0;
    for (const r of rows) {
      if (isPromotionDeniedByTags(r.tags)) { deniedByTags++; continue; }
      const origin = classifySurfaceUtteranceOrigin(r);
      if (!TRUSTED_PROMOTION_ORIGINS.includes(origin as (typeof TRUSTED_PROMOTION_ORIGINS)[number])) { untrustedOrigin++; continue; }
      // OP #129296 기본값 뒤집기: 공유 허용 표기(refs.crossSeatShare===true)가 «있을 때만» 승격.
      // 미표기 = 거부 — 원본이 인간 발화여도 허용 표기 없으면 전역에 복제되지 않는다.
      if (!hasShareConsent(r.refs)) { noShareConsent++; continue; }
      trusted.push(r);
    }

    const byKey = new Map<string, { seats: Set<string>; rows: CrossSeatLessonRow[] }>();
    for (const r of trusted) {
      // terra r3 mustFix #1(= JUD-C mustFix a): 그룹 키는 «실제 교훈(본문)» 의 동일성으로만 판정한다.
      // summary 는 표시용 메타(기본값조차 본문 접두 — surface-events recordEvent)이므로 요약이 같다고
      // 교훈이 같은 게 아니다 — 동일 요약·상이 본문의 오승격 + 두 원본 consolidated 오마킹을 막는다.
      // terra r4 잔여 [3]: 본문 정규화도 구두점을 공백으로 접으므로 lessonIdentityKey(소프트 키 +
      // standalone 연산자 지문)로 판정 — x != y / x == y 같은 의미상 상이 본문의 오승격·오마킹을 막는다.
      const key = lessonIdentityKey(r.text);
      if (!key) continue;
      const entry = byKey.get(key) ?? { seats: new Set<string>(), rows: [] };
      // terra r3 mustFix #3: 실제 자리 식별자만 집계 — 비자리 surface 는 임계 기여 0(행은 그룹에 남는다).
      const seat = seatOfSurface(r.surface);
      if (seat !== null) entry.seats.add(seat);
      entry.rows.push(r);
      byKey.set(key, entry);
    }

    // 기존 승격 키(활성 승격 행) 조회 — «그룹 판정 시점» 에 매번 fresh(terra r2 mustFix #4).
    // 판정(스캔·summarize) 중 경쟁 record 실행이 먼저 승격 행을 넣었으면(이 트랜잭션·커밋 모두
    // 가시) 이번 그룹은 재판정해 스킵 — 중복 삽입 0. JUD-C mustFix(#39517)과 같은 이유로
    // 승격문 «본문» 정규화가 아니라 승격 시 tags 에 저장한 «실제 lessonKey» 를 읽어 비교한다.
    // terra r3 mustFix 2: r2 이전에 저장된 «과거 평문» 키 행도 멱등 대상이다 — 저장값 자신과
    // 그 도출 해시(sha256Hex16(stored)) 를 양쪽 다 집합에 넣어 과거 평문 행 ↔ 새 해시 비교를
    // 맞춘다(같은 원문 → 같은 해시 → 중복 승격 0). 과거 평문 행은 아래 마이그레이션으로
    // 비가역 갱신된다.
    const activePromotedKeys = (): Set<string> => {
      const keys = new Set<string>();
      for (const row of sdb
        .prepare(`SELECT id, tags FROM events WHERE kind = 'cross-seat-lesson' AND (consolidated IS NULL OR consolidated = 0)`)
        .all() as Array<{ id: string; tags: string | null }>) {
        const stored = storedLessonKey(row.tags);
        if (stored === null) continue;
        keys.add(stored);
        // terra r4 mustFix 1: 도출 해시 추가는 «과거 평문» 저장값에만 — 이미 해시 형식인 저장 키를
        // 다시 해시하면 이중 해시가 별도 충돌 도메인이 되어, 우연히 그 값과 같은 새 교훈의
        // keyHash 를 기승격으로 오인해 원본을 consolidated 처리할 수 있다.
        // terra r5 mustFix 1: 해시 형식 판정은 외형 정규식이 아니라 «명시적 형식 표기»
        // (lessonKeyFormat==='sha256-16')로만 — 평문 키가 우연히 16자 hex 여도(⑨) 미표기는
        // 과거 평문이므로 도출 해시를 넣어 멱등을 유지한다. 저장 형식 모호성 해소.
        if (!isHashFormattedLessonKeyTags(row.tags)) {
          const hash = sha256Hex16(stored);
          keys.add(hash);
          const oldTags = JSON.parse(row.tags!) as Record<string, unknown>;
          // 마이그레이션 갱신값에도 형식 표기를 붙인다 — 이후 판정은 표기로 결정된다.
          const newTags = JSON.stringify({ ...oldTags, lessonKey: hash, lessonKeyFormat: LESSON_KEY_FORMAT });
          sdb.prepare(`UPDATE events SET tags = ? WHERE id = ?`).run(newTags, row.id);
          const src = sdb.prepare(`SELECT text, summary, tags FROM events WHERE id = ?`).get(row.id) as { text: string; summary: string | null };
          const ftsText = `${src.summary}\n${src.text}\n${newTags}`;
          sdb.prepare(`UPDATE events_fts SET search_text = ? WHERE id = ?`).run(ftsText, row.id);
        }
      }
      return keys;
    };

    // 내부 누적은 가변 객체로(public 반환형은 readonly 그대로 — 가변 성질은 이 함수 안에서만).
    const out: { scanned: number; promoted: number; alreadyPromoted: number; singleSeat: number; untrustedOrigin: number; deniedByTags: number; noShareConsent: number; blockedByCallPath: number; promotedIds: string[] } = {
      scanned: rows.length, promoted: 0, alreadyPromoted: 0, singleSeat: 0, untrustedOrigin, deniedByTags, noShareConsent, blockedByCallPath: 0, promotedIds: [],
    };
    const markStmt = sdb.prepare(`UPDATE events SET consolidated = 1 WHERE id = ?`);

    // JUD-C #129980 mustFix ① — 과거 평문 lessonKey 이관(마이그레이션)은 승격 그룹 임계와 무관한
    // 데이터 정합(비가역 해시)이다. 이관 실행은 activePromotedKeys() 내부에 있어 그룹 판정 루프에서만
    // 호출되면 적격 두 자리 그룹이 하나도 없는 실행(무적격)에서 영원히 이관되지 않는다 — 승격 강제
    // (0건)와 무관하게 매 실행에서 1회 이관을 실행한다(회귀 ⑫).
    // 초회 집합은 «갱신 전 stored 재료»까지 포함해 보존한다 — 마이그레이션 갱신 후의 재조회는
    // 갱신된 저장값만 보므로, 초회 재료를 남기지 않으면 미표기 해시 저장 행(과거 잔존 상태)이
    // 이관 뒤 멱급에서 유실되어 중복 승격이 된다(회귀 (b)).
    const initialKeys = activePromotedKeys();

    for (const [key, entry] of byKey) {
      if (entry.seats.size < CROSS_SEAT_MIN_SEATS) { out.singleSeat++; continue; }
      // OP #130184(처분 B 재판정) — 임계 충족 그룹도 «호출 경로» 가 아니면 승격 삽입·원본 마킹
      // 없이 차단한다: refs 의 crossSeatShare=true·사람 출처 직접 기입(위조)으로는 이 경로에서
      // 승격이 일어나지 않는다(회귀 ⑩). 인증 경로 착지 전까지 운영 호출 승격은 0건 강제.
      if (!promotionPathAllowed) { out.blockedByCallPath++; continue; }
      const seats = [...entry.seats].sort();
      const first = entry.rows[0]!;
      // OP #129296 사양 3 — 승격 본문은 원문 전문을 실지 않는다: 결정론 요약(정규화 키 접두)과
      // 출처 포인터(surface#이벤트id@시각)만 전역에 저장한다. 다른 자리의 비공개 원문이 전역
      // 기억으로 샐 수 있으므로 원문 본문(r.text)은 승격 행에 실리지 않는다(회상은 포인터로 원본 행 접근).
      // deps.summarize 재정의(시험 주입)는 그대로 존중한다.
      // terra mustFix r2 #2(OP #129296): 포인터의 id 는 8자 절단이 아니라 «전체 id» — 원본 행을
      // 유일하게 조회한다(id 가 events PRIMARY KEY). 절단 접두는 같은 surface·시각의 서로 다른
      // 행을 구별하지 못할 수 있다.
      const pointerOf = (r: CrossSeatLessonRow): string => `${r.surface}#${r.id}@${r.ts}`;
      // terra mustFix r2 #1(OP #129296): 전역 메타데이터(tags)의 lessonKey 는 비가역 해시 —
      // 본문 80자 요약 접두만 남겨도 긴 교훈의 원문 내용이 전역 key 평문으로 남지 않게 한다.
      // terra r3 mustFix 2: activePromotedKeys 는 저장값 자신(새 해시 형식)과 과거 평문 저장값의
      // 도출 해시(sha256Hex16(stored))가 추가되므로 legacy 평문 행과도 같은 비교로 멱등(이미
      // 해시 형식 저장값은 이중 해시 없이 그대로 비교 — terra r4 mustFix 1).
      const keyHash = sha256Hex16(key);
      const body = deps.summarize
        ? deps.summarize(key, seats)
        : `[자리 교차 교훈 · ${seats.join('·')} · ${entry.rows.length}건]\n요약: ${key.slice(0, 80)}\n출처: ${entry.rows.map(pointerOf).join(', ')}`;
      // 판정 종료 시점 재조회(동시성) — 이미 전역 승격된 교훈이면 재승격 없이 소비 마킹만 보강한다.
      // 마킹 비교 재료도 저장 표현(해시)과 동일하게 도출한다 — 같은 원문 → 같은 해시(멱등 유지).
      // 초회 집합(initialKeys)을 합집합으로 유지한다: 이관 갱신 전 stored 재료(미표기 해시 저장 행)는
      // 초회에만 관측되므로 합집합이 멱등을 보존한다(회귀 (b)).
      if (initialKeys.has(keyHash) || activePromotedKeys().has(keyHash)) {
        // 재시도 안전(JUD-C mustFix #39517): 새로 들어온/마킹이 누락된 원본은 다음 record 단계에서
        // 재출현하지 않고 중복 승격도 일어나지 않는다.
        for (const r of entry.rows) markStmt.run(r.id);
        out.alreadyPromoted++;
        continue;
      }
      // 승격 삽입과 원본 마킹 — 이 트랜잭션 안에서 원자(recordEvent 내부 트랜잭션은 세이브포인트로
      // 이 롤백에 함께 되돌림 — 사이 중단 시 둘 다 롤백, 재시도에서 중복 승격 0).
      const promotedId = recordEvent(sdb, {
        surface: 'memory', direction: 'inbound', kind: 'cross-seat-lesson',
        text: body, summary: `${key.slice(0, 80)} — 자리 ${seats.length}곳 교차`,
        // 신규 승격 저장값에도 형식 표기를 붙인다(terra r5 mustFix 1) — 이후 멱등 판정은
        // 외형이 아니라 이 표기로 결정된다.
        importance: 6, tags: JSON.stringify({ seats, occurrences: entry.rows.length, lessonKey: keyHash, lessonKeyFormat: LESSON_KEY_FORMAT }),
        ts: now, ...(first.ts ? { refs: undefined } : {}),
      });
      for (const r of entry.rows) markStmt.run(r.id);
      out.promoted++;
      out.promotedIds.push(promotedId);
    }
    return out;
  })();
}
