// MEMORY-CROSS-SEAT-PROMOTION — 시험(임시 SQLite · 운영 DB 미접촉).
// 임계 출처: ROSTER-0333-60 행 5 완료선 «두 자리 이상에서 같은 교훈» → CROSS_SEAT_MIN_SEATS = 2.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CROSS_SEAT_LESSON_KINDS,
  CROSS_SEAT_MIN_SEATS,
  isPromotionDeniedByTags,
  lessonIdentityKey,
  lessonKeyHash,
  normalizeLessonKey,
  promoteCrossSeatLessons,
  seatOfSurface,
  storedLessonKey,
} from './cross-seat-promotion.js';
import { recordEvent } from './surface-events.js';
import { openSurfaceEventsDb } from './surface-events.js';

const ROOT = join('/tmp', `pool4-cross-seat-${process.pid}`);
const DB = join(ROOT, 'surface_events.db');

function freshDb(): Database {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  return openSurfaceEventsDb(DB);
}

describe('MEMORY-CROSS-SEAT-PROMOTION — 자리 교차 교훈 전역 승격', () => {
  test('두 자리 같은 교훈 → cross-seat-lesson 1건 승격 + 원본 consolidated 마킹', () => {
    const db = freshDb();
    for (const seat of ['seat:TC-H-POOL-4', 'seat:MVP-B']) {
      recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text: '같은 실수: pregate 전 시험 스킵', summary: 'pregate 전 시험 스킵 금지', importance: 4, ts: '2026-11-21T10:00:00Z', refs: JSON.stringify({ origin: 'human', utteranceOrigin: 'human', crossSeatShare: true }) });
    }
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now: () => '2026-11-22T06:00:00Z' });
    expect(result.scanned).toBe(2);
    expect(result.promoted).toBe(1);
    const promoted = db.prepare(`SELECT text, tags, consolidated FROM events WHERE kind='cross-seat-lesson'`).all() as Array<{ text: string; tags: string | null; consolidated: number }>;
    expect(promoted.length).toBe(1);
    expect(promoted[0]!.text).toContain('MVP-B·TC-H-POOL-4');
    const tags = JSON.parse(promoted[0]!.tags ?? '{}') as { seats: string[]; occurrences: number };
    expect(tags.seats).toEqual(['MVP-B', 'TC-H-POOL-4']);
    expect(tags.occurrences).toBe(2);
    const remaining = db.prepare(`SELECT COUNT(*) c FROM events WHERE kind='lesson' AND consolidated=0`).get() as { c: number };
    expect(remaining.c).toBe(0);
  });

  test('단일 자리(2건 같은 자리) = 승격 안 함 — singleSeat 카운트', () => {
    const db = freshDb();
    recordEvent(db, { surface: 'seat:TC-H-POOL-4', direction: 'inbound', kind: 'lesson', text: '로컬 세션 cd 누락', ts: '2026-11-21T10:00:00Z', refs: JSON.stringify({ origin: 'human', utteranceOrigin: 'human', crossSeatShare: true }) });
    recordEvent(db, { surface: 'seat:TC-H-POOL-4', direction: 'inbound', kind: 'lesson', text: '로컬 세션 cd  누락!!', ts: '2026-11-21T11:00:00Z', refs: JSON.stringify({ origin: 'human', utteranceOrigin: 'human', crossSeatShare: true }) });
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now: () => '2026-11-22T06:00:00Z' });
    expect(result.promoted).toBe(0);
    expect(result.singleSeat).toBe(1);
  });

  test('멱등 — 재실행 시 이미 승격된 키 재승격 0', () => {
    const db = freshDb();
    for (const seat of ['seat:A', 'seat:B']) {
      recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text: 'merge 커밋 금지 규칙', ts: '2026-11-21T10:00:00Z', refs: JSON.stringify({ origin: 'human', utteranceOrigin: 'human', crossSeatShare: true }) });
    }
    const first = promoteCrossSeatLessons(db, { callPath: 'authenticated', now: () => '2026-11-22T06:00:00Z' });
    expect(first.promoted).toBe(1);
    const second = promoteCrossSeatLessons(db, { callPath: 'authenticated', now: () => '2026-11-22T07:00:00Z' });
    expect(second.promoted).toBe(0);
    expect(second.alreadyPromoted).toBe(0); // 원본이 마킹돼 scan 대상에서 빠짐
    const count = db.prepare(`SELECT COUNT(*) c FROM events WHERE kind='cross-seat-lesson'`).get() as { c: number };
    expect(count.c).toBe(1);
  });

  test('normalizeLessonKey — 문구 차이(대소문자·구두점·공백) 같은 교훈으로 접힘', () => {
    expect(normalizeLessonKey('Merge 커밋  금지!')).toBe(normalizeLessonKey('merge 커밋 금지'));
    expect(normalizeLessonKey('seat:TC-H-POOL-4')).not.toBe('');
    expect(normalizeLessonKey('')).toBe('');
  });

  test('seatOfSurface — 실제 자리만(접두 제거 · 비자리 null) · 임계 상수(출처: 로스터 «두 자리 이상»)', () => {
    expect(seatOfSurface('seat:TC-H-POOL-4')).toBe('TC-H-POOL-4');
    expect(seatOfSurface('telegram')).toBe(null); // terra r3 mustFix #3: 접두 없는 surface 는 자리 아님
    expect(CROSS_SEAT_MIN_SEATS).toBe(2); // 출처: ROSTER-0333-60 행 5 완료선
  });
});

describe('MEMORY-CROSS-SEAT-PROMOTION — JUD 보안 HOLD #125713 보강', () => {
  const humanRefs = JSON.stringify({ origin: 'human', utteranceOrigin: 'human', crossSeatShare: true });

  test('kind 부분 문자열 오탐 차단 — kind가 lesson/feedback와 다른 행은 스캔 대상 아님(정확 일치)', () => {
    const db = freshDb();
    for (const seat of ['seat:A', 'seat:B']) {
      recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson-archive', text: '같은 교훈처럼 보이는 아카이브 행', ts: '2026-11-21T10:00:00Z', refs: humanRefs });
      recordEvent(db, { surface: seat, direction: 'inbound', kind: 'feedback-noise', text: '같은 교훈처럼 보이는 노이즈 행', ts: '2026-11-21T10:01:00Z', refs: humanRefs });
    }
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now: () => '2026-11-22T06:00:00Z' });
    expect(result.scanned).toBe(0);
    expect(result.promoted).toBe(0);
  });

  test('신뢰 출처 게이트 — 사람(human) 발화가 아니면 두 자리 교차여도 미승격 + untrustedOrigin 카운트', () => {
    const db = freshDb();
    for (const seat of ['seat:A', 'seat:B']) {
      recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text: '에이전트가 만든 같은 문장 교훈', ts: '2026-11-21T10:00:00Z', refs: JSON.stringify({ origin: 'agent', utteranceOrigin: 'agent' }) });
    }
    recordEvent(db, { surface: 'seat:C', direction: 'inbound', kind: 'lesson', text: '표기 없는 미상 발화 교훈', ts: '2026-11-21T10:02:00Z' });
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now: () => '2026-11-22T06:00:00Z' });
    expect(result.promoted).toBe(0);
    expect(result.untrustedOrigin).toBe(3);
    // 미승격 회귀: 제외 행은 consolidated 마킹 없이 그대로 남는다.
    const unmarked = db.query(`SELECT COUNT(*) AS n FROM events WHERE kind='lesson' AND (consolidated IS NULL OR consolidated=0)`).get() as { n: number };
    expect(unmarked.n).toBe(3);
  });

  test('비공개 금지 태그 — private 행은 두 자리 교차여도 전역 복제 금지 + deniedByTags 카운트', () => {
    const db = freshDb();
    for (const seat of ['seat:A', 'seat:B']) {
      recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text: '비공개 취급 교훈', ts: '2026-11-21T10:00:00Z', refs: humanRefs, tags: 'private' });
    }
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now: () => '2026-11-22T06:00:00Z' });
    expect(result.promoted).toBe(0);
    expect(result.deniedByTags).toBe(2);
    const leaked = db.query(`SELECT COUNT(*) AS n FROM events WHERE kind='cross-seat-lesson'`).get() as { n: number };
    expect(leaked.n).toBe(0);
  });
});

describe('MEMORY-CROSS-SEAT-PROMOTION — JUD-C mustFix(#39517) 승격 멱등성·재시도 원자성', () => {
  const humanRefs = JSON.stringify({ origin: 'human', utteranceOrigin: 'human', crossSeatShare: true });
  const crossSeatCount = (db: Database): number =>
    (db.prepare(`SELECT COUNT(*) c FROM events WHERE kind='cross-seat-lesson'`).get() as { c: number }).c;
  const unconsolidatedLessonCount = (db: Database): number =>
    (db.prepare(`SELECT COUNT(*) c FROM events WHERE kind='lesson' AND (consolidated IS NULL OR consolidated=0)`).get() as { c: number }).c;

  // 회귀 (a) — 첫 승격 이후 «다른 두 자리»가 동일 교훈을 새로 생성해도 승격 기록은 1개만.
  test('회귀 (a) — 첫 승격 이후 두 자리가 동일 교훈을 새로 생성해도 승격 기록 1개만 유지', () => {
    const db = freshDb();
    for (const seat of ['seat:A', 'seat:B']) {
      recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text: '같은 교훈: force push 금지', ts: '2026-11-21T10:00:00Z', refs: humanRefs });
    }
    const first = promoteCrossSeatLessons(db, { callPath: 'authenticated', now: () => '2026-11-22T06:00:00Z' });
    expect(first.promoted).toBe(1);
    expect(crossSeatCount(db)).toBe(1);
    // 이후 다른 두 자리가 같은 교훈을 새로 생성(대소문자·공백·구두점 차이 — 정규화 키 동일).
    for (const seat of ['seat:C', 'seat:D']) {
      recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text: '같은  교훈: Force push 금지!!', ts: '2026-11-23T10:00:00Z', refs: humanRefs });
    }
    const second = promoteCrossSeatLessons(db, { callPath: 'authenticated', now: () => '2026-11-24T06:00:00Z' });
    expect(second.promoted).toBe(0);
    expect(second.alreadyPromoted).toBe(1);
    expect(crossSeatCount(db)).toBe(1);
    // 스킵된 새 원본은 전역 기억이 이미 있으므로 소비 마킹 — 이후 검사에서 재출현하지 않는다.
    expect(unconsolidatedLessonCount(db)).toBe(0);
    const third = promoteCrossSeatLessons(db, { callPath: 'authenticated', now: () => '2026-11-25T06:00:00Z' });
    expect(third.scanned).toBe(0);
  });

  // 회귀 (b) — 승격 행 삽입 후 원본 마킹 전 중단(마킹 누락 상태)의 재시도 → 중복 없음.
  test('회귀 (b) — 삽입 후 마킹 전 중단(마킹 누락 상태) 재시도 → 중복 없음 + 마킹 보강', () => {
    const db = freshDb();
    for (const seat of ['seat:A', 'seat:B']) {
      recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text: '같은 교훈: merge 커밋 금지', ts: '2026-11-21T10:00:00Z', refs: humanRefs });
    }
    // 중단 상태 재현: 승격 행만 삽입돼 있고(tags 에 실제 lessonKey 저장) 원본 consolidated 마킹은 누락.
    const key = normalizeLessonKey('같은 교훈: merge 커밋 금지');
    const keyHash = lessonKeyHash('같은 교훈: merge 커밋 금지');
    recordEvent(db, {
      surface: 'memory', direction: 'inbound', kind: 'cross-seat-lesson',
      text: `[자리 교차 교훈 · A·B · 2건]\n- (seat:A) 같은 교훈: merge 커밋 금지\n- (seat:B) 같은 교훈: merge 커밋 금지`,
      summary: `${key.slice(0, 80)} — 자리 2곳 교차`,
      importance: 6,
      tags: JSON.stringify({ seats: ['A', 'B'], occurrences: 2, lessonKey: keyHash }), // terra mustFix r2 — 비가역 해시 저장
      ts: '2026-11-22T06:00:00Z',
    });
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now: () => '2026-11-23T06:00:00Z' });
    expect(result.promoted).toBe(0);
    expect(result.alreadyPromoted).toBe(1);
    expect(crossSeatCount(db)).toBe(1);
    expect(unconsolidatedLessonCount(db)).toBe(0); // 누락됐던 원본 마킹이 재시도에서 보강된다.
  });

  // 원자성 — 승격 삽입과 원본 마킹이 한 트랜잭션이면 마킹 실패 시 삽입도 롤백된다.
  test('원자성 — 마킹 실패(삽입·마킹 사이 중단) 시 승격 삽입도 롤백 → 재시도 정상 승격 1건', () => {
    const db = freshDb();
    for (const seat of ['seat:A', 'seat:B']) {
      recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text: '같은 교훈: 원자성 중단 재현', ts: '2026-11-21T10:00:00Z', refs: humanRefs });
    }
    // 원본 마킹 UPDATE 를 강제 ABORT — «삽입 후 마킹 전 중단»을 결정적으로 재현.
    db.run(`CREATE TRIGGER pool4_39517_abort_mark BEFORE UPDATE ON events WHEN NEW.consolidated = 1 BEGIN SELECT RAISE(ABORT, 'pool4-39517: interrupted between insert and mark'); END`);
    expect(() => promoteCrossSeatLessons(db, { callPath: 'authenticated', now: () => '2026-11-22T06:00:00Z' })).toThrow();
    expect(crossSeatCount(db)).toBe(0); // 삽입도 롤백 — 부분 상태(승격만 존재) 잔존 0
    db.run('DROP TRIGGER pool4_39517_abort_mark');
    const retry = promoteCrossSeatLessons(db, { callPath: 'authenticated', now: () => '2026-11-22T07:00:00Z' });
    expect(retry.promoted).toBe(1);
    expect(crossSeatCount(db)).toBe(1);
  });
});

// terra(gpt-6.1-terra) r2 mustFix 5 — RED 회귀(수리 전 실패 원문 보존 · 실패 우선).
describe('MEMORY-CROSS-SEAT-PROMOTION — terra r2 mustFix 5', () => {
  const humanRefs = JSON.stringify({ origin: 'human', utteranceOrigin: 'human', crossSeatShare: true });
  const now = (): string => '2026-11-22T06:00:00Z';
  const crossSeatCount = (db: Database): number =>
    (db.prepare(`SELECT COUNT(*) c FROM events WHERE kind='cross-seat-lesson'`).get() as { c: number }).c;
  const unconsolidatedCount = (db: Database, kind: string): number =>
    (db.prepare(`SELECT COUNT(*) c FROM events WHERE kind=? AND (consolidated IS NULL OR consolidated=0)`).get(kind) as { c: number }).c;

  // mustFix #1 — kind 계약: 승격 재료는 kind === 'lesson' 정확 일치만. feedback 는 계약 밖 → 거부 회귀.
  test('#1 kind 계약 — CROSS_SEAT_LESSON_KINDS=[lesson] · feedback 행은 스캔·승격·마킹 0', () => {
    expect([...CROSS_SEAT_LESSON_KINDS]).toEqual(['lesson']); // 계약 원문: kind === 'lesson' (terra r2 mustFix #1)
    const db = freshDb();
    for (const seat of ['seat:A', 'seat:B']) {
      recordEvent(db, { surface: seat, direction: 'inbound', kind: 'feedback', text: '피드백 계약 밖 승격 재료', ts: '2026-11-21T10:00:00Z', refs: humanRefs });
    }
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
    expect(result.scanned).toBe(0);
    expect(result.promoted).toBe(0);
    expect(crossSeatCount(db)).toBe(0);
    expect(unconsolidatedCount(db, 'feedback')).toBe(2); // 시드 2행(위 recordEvent 2건) — 거부 행은 그대로
  });

  // mustFix #2 — 실제 태그 저장 형식(낱말·key:value·JSON) 파싱 + 세 금지 태그(secret·key·token).
  test('#2 태그 가드 단위 — key·token 차단 · JSON 따옴표·괄호 파싱 · 정상 태그 통과', () => {
    expect(isPromotionDeniedByTags('key')).toBe(true);
    expect(isPromotionDeniedByTags('token')).toBe(true);
    expect(isPromotionDeniedByTags('"secret"')).toBe(true);           // JSON 스칼라 따옴표
    expect(isPromotionDeniedByTags('["private","ops"]')).toBe(true);  // JSON 배열
    expect(isPromotionDeniedByTags('{"tag":"secret"}')).toBe(true);   // JSON 객체 값
    expect(isPromotionDeniedByTags('{"token":"abc123"}')).toBe(true); // JSON 객체 키·값
    expect(isPromotionDeniedByTags('api-key, ops')).toBe(true);       // 하이픈·쉼표 접힌 낱말
    expect(isPromotionDeniedByTags('private')).toBe(true);            // 기존 금지 태그 유지
    expect(isPromotionDeniedByTags('no-share')).toBe(true);
    expect(isPromotionDeniedByTags('do-not-share')).toBe(true);
    expect(isPromotionDeniedByTags('origin:human')).toBe(false);     // 정상 provenance 낱말 통과
    expect(isPromotionDeniedByTags('keyboard')).toBe(false);         // 부분 낱말(keyboard 등) 오탐 아님
    expect(isPromotionDeniedByTags(null)).toBe(false);
    expect(isPromotionDeniedByTags('')).toBe(false);
  });

  test('#2 세 금지 태그(secret·key·token) 저장 형식별 승격 거부 — 전역 복제 0 + 원본 보존', () => {
    for (const tags of ['["secret"]', 'key', '{"token":"t0"}']) {
      const db = freshDb();
      for (const seat of ['seat:A', 'seat:B']) {
        recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text: `기밀 교훈 ${tags}`, ts: '2026-11-21T10:00:00Z', refs: humanRefs, tags });
      }
      const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
      expect(result.promoted).toBe(0);
      expect(result.deniedByTags).toBe(2);               // 시드 2행(위 recordEvent 2건)
      expect(crossSeatCount(db)).toBe(0);                // 비공개 교훈 전역 복제 0
      expect(unconsolidatedCount(db, 'lesson')).toBe(2); // 제외 행은 마킹 없이 보존
    }
  });

  // mustFix #3 — 전체 내용 키: 앞 64자 절단은 긴 공통 접두 뒤 «서로 다른» 교훈을 같은 키로
  // 오승격하고 원본까지 오마킹한다 — 별개 판정 + 승격 0 + 원본 보존 회귀.
  test('#3 전체 내용 키 — 긴 공통 접두 뒤 서로 다른 교훈은 별개 → 승격 0·원본 보존', () => {
    const prefix = '프리게이트 관문은 반드시 로컬 시험 선행 실측 원문 보존으로 통과한다'.repeat(2);
    expect(normalizeLessonKey(prefix).length).toBeGreaterThan(64); // 64 = 종전 normalizeLessonKey 절단 길이(원문)
    const a = `${prefix} 사례 갑`;
    const b = `${prefix} 사례 을`;
    expect(normalizeLessonKey(a)).not.toBe(normalizeLessonKey(b));
    const db = freshDb();
    recordEvent(db, { surface: 'seat:A', direction: 'inbound', kind: 'lesson', text: a, ts: '2026-11-21T10:00:00Z', refs: humanRefs });
    recordEvent(db, { surface: 'seat:B', direction: 'inbound', kind: 'lesson', text: b, ts: '2026-11-21T11:00:00Z', refs: humanRefs });
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
    expect(result.promoted).toBe(0);
    expect(result.singleSeat).toBe(2);                    // 별개 교훈 2그룹 각 1자리(위 시드 2행)
    expect(crossSeatCount(db)).toBe(0);
    expect(unconsolidatedCount(db, 'lesson')).toBe(2);    // 원본 오마킹 금지 — 그대로
  });

  // mustFix #4 — 판정(스캔·기존 승격 조회)과 삽입이 트랜잭션 밖으로 갈라지면 두 record 실행이
  // 같은 미승격 상태를 읽고 각각 승격 행을 삽입한다 — 판정·삽입·마킹 단일 트랜잭션 + 그룹
  // 판정 직전 기존 승격 재조회로 중복 삽입 0.
  test('#4 동시성 — 삽입 직전 경쟁 record 실행이 같은 미승격 상태에서 먼저 승격해도 승격 행 1개', () => {
    const db = freshDb();
    for (const seat of ['seat:A', 'seat:B']) {
      recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text: '같은 교훈: 동시 record 실행 재현', ts: '2026-11-21T10:00:00Z', refs: humanRefs });
    }
    let injected = false;
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated',
      now,
      // 판정 직후·삽입 직전에 경쟁 record 실행이 끼어드는 interleaving 재현(실제 promoteCrossSeatLessons 재귀 호출).
      summarize: () => {
        if (!injected) { injected = true; promoteCrossSeatLessons(db, { callPath: 'authenticated', now: () => '2026-11-22T05:59:00Z' }); }
        return '요약';
      },
    });
    expect(result.promoted).toBe(0);                      // 이번 실행은 재판정(기존 승격 재조회)해 승격 0
    expect(result.alreadyPromoted).toBe(1);              // 경쟁 실행 승격 관측
    expect(crossSeatCount(db)).toBe(1);                   // 승격 행은 경쟁 실행 1건만 — 중복 삽입 0
    expect(unconsolidatedCount(db, 'lesson')).toBe(0);   // 원본 소비 마킹은 보강
  });
});

// terra(gpt-6.1-terra) r3 mustFix 3 + JUD-C HOLD #39517 mustFix (a) — RED 회귀(수리 전 실패 원문 보존 · 실패 우선).
describe('MEMORY-CROSS-SEAT-PROMOTION — terra r3 mustFix(본문 동일성·전체 보존·실제 자리 집계)', () => {
  const humanRefs = JSON.stringify({ origin: 'human', utteranceOrigin: 'human', crossSeatShare: true });
  const now = (): string => '2026-11-22T06:00:00Z';
  const crossSeatRows = (db: Database): Array<{ text: string; tags: string | null }> =>
    db.prepare(`SELECT text, tags FROM events WHERE kind='cross-seat-lesson'`).all() as Array<{ text: string; tags: string | null }>;
  const unconsolidatedLessonCount = (db: Database): number =>
    (db.prepare(`SELECT COUNT(*) c FROM events WHERE kind='lesson' AND (consolidated IS NULL OR consolidated=0)`).get() as { c: number }).c;

  // terra r3 mustFix #1 = JUD-C mustFix (a) — 그룹 키는 «실제 교훈(본문)» 의 동일성: summary 는
  // 표시용 메타라 동일 요약·상이 본문이 같은 교훈으로 묶이면 오승격 + 두 원본 오마킹이다.
  test('#1 동일 summary·서로 다른 본문 → 같은 교훈으로 묶임 금지 · 승격 0 · 원본 보존', () => {
    const db = freshDb();
    recordEvent(db, { surface: 'seat:A', direction: 'inbound', kind: 'lesson', text: '본문 갑: pregate 영수증은 확정 원격 head 로만 제출', summary: '동일 요약: 관문 영수증 원칙', ts: '2026-11-21T10:00:00Z', refs: humanRefs });
    recordEvent(db, { surface: 'seat:B', direction: 'inbound', kind: 'lesson', text: '본문 을: 병렬 구현 서브는 명령 원문 보존이 의무', summary: '동일 요약: 관문 영수증 원칙', ts: '2026-11-21T11:00:00Z', refs: humanRefs });
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
    expect(result.promoted).toBe(0);            // RED(수리 전): summary 우선 키로 묶여 1 승격
    expect(result.singleSeat).toBe(2);          // RED: 별개 본문 2그룹 각 1자리
    expect(crossSeatRows(db).length).toBe(0);   // RED: 승격 행 1건 삽입
    expect(unconsolidatedLessonCount(db)).toBe(2); // RED: 두 원본 consolidated 오마킹
  });

  // terra r3 mustFix #2 — 승격 본문은 교훈 «전체» 를 보존한다. 절단 지점은 2갈래:
  //   (a) summary 미지정 행 — recordEvent 기본 summary=text.slice(0,200)(surface-events.ts) → 200자 뒤 꼬리 실종,
  //   (b) 빈 summary('') 행 — 승격 본문 90자 절단 분기 → 90자 뒤 꼬리 실종.
  // «긴 본문의 뒷부분» 이 전역 기억(승격 행 text)에 실재하는지 두 경로 모두 검증.
  test('#2 승격 본문은 원문 전문 미저장 — 요약(정규화 키 80자 접두)·출처 포인터만 (OP #129296 사양 3)', () => {
    const tailOf = (n: string): string => `핵심 꼬리(${n}): 이 꼬리가 잘리면 교훈의 본질이 전역 기억에 보존되지 않는다`;
    {
      const db = freshDb(); // (a) summary 미지정 — 저장 summary=text 200자 접두 → 200자 뒤 꼬리
      const head = '서두'.repeat(120); // 240자 — 기본 summary 200자 경계를 넘긴다
      const tail = tailOf('200자 경계');
      const text = `${head} — ${tail}`;
      expect(text.length).toBeGreaterThan(200);
      for (const seat of ['seat:A', 'seat:B']) {
        recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text, ts: '2026-11-21T10:00:00Z', refs: humanRefs }); // summary 미지정
      }
      const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
      expect(result.promoted).toBe(1);
      expect(crossSeatRows(db).length).toBe(1);
      const promotedText = crossSeatRows(db)[0]!.text;
      expect(promotedText).toContain('요약:');           // 결정론 요약(OP #129296 사양 3)
      expect(promotedText).toContain('출처:');           // 출처 포인터
      expect(promotedText).not.toContain(head);           // 원문 전문(240자) 전역 미유출
      expect(promotedText).not.toContain(tail);           // 원문 꼬리 전역 미유출
      expect(unconsolidatedLessonCount(db)).toBe(0);
    }
    {
      const db = freshDb(); // (b) 빈 summary — 종전 승격 본문 90자 절단 분기
      const head = '서두'.repeat(60); // 120자 — 90자 경계를 넘긴다
      const tail = tailOf('90자 경계');
      const text = `${head} — ${tail}`;
      expect(text.length).toBeGreaterThan(90);
      for (const seat of ['seat:A', 'seat:B']) {
        recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text, summary: '', ts: '2026-11-21T10:00:00Z', refs: humanRefs });
      }
      const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
      expect(result.promoted).toBe(1);
      expect(crossSeatRows(db).length).toBe(1);
      const promotedText = crossSeatRows(db)[0]!.text;
      expect(promotedText).toContain('요약:');
      expect(promotedText).toContain('출처:');
      expect(promotedText).not.toContain(head);           // 원문 전문(120자) 전역 미유출
      expect(promotedText).not.toContain(tail);           // 원문 꼬리 전역 미유출
      expect(unconsolidatedLessonCount(db)).toBe(0);
    }
  });

  // terra r3 mustFix #3 — seatOfSurface 는 «실제 자리 식별자» 만 집계: seat: 접두 없는 surface
  // (cli·memory·telegram 등)를 자리로 세면 서로 다른 비자리 surface 둘이 교차 자리 임계를 충족한다.
  test('#3 비자리 surface — 접두 없으면 자리 아님(null) → 2비자리·자리1+비자리1 임계 미충족 · 집계 원문', () => {
    expect(seatOfSurface('seat:A')).toBe('A');
    expect(seatOfSurface('telegram')).toBe(null); // RED(수리 전): 'telegram' 반환 — 비자리를 자리로 인정
    expect(seatOfSurface('memory')).toBe(null);   // RED(수리 전): 'memory' 반환
    {
      const db = freshDb(); // (1) 비자리 surface 2개 — 서로 달라도 교차 «자리» 임계 미충족
      recordEvent(db, { surface: 'telegram', direction: 'inbound', kind: 'lesson', text: '비자리 표면 같은 교훈', ts: '2026-11-21T10:00:00Z', refs: humanRefs });
      recordEvent(db, { surface: 'memory', direction: 'inbound', kind: 'lesson', text: '비자리 표면 같은 교훈', ts: '2026-11-21T11:00:00Z', refs: humanRefs });
      const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
      expect(result.promoted).toBe(0);             // RED: telegram·memory 를 자리로 세어 1 승격
      expect(crossSeatRows(db).length).toBe(0);
      expect(unconsolidatedLessonCount(db)).toBe(2); // 원본 보존
    }
    {
      const db = freshDb(); // (2) 실제 자리 1 + 비자리 1 — 실제 자리는 1개뿐 → 임계 미충족
      recordEvent(db, { surface: 'seat:A', direction: 'inbound', kind: 'lesson', text: '자리 하나와 비자리 하나의 같은 교훈', ts: '2026-11-21T10:00:00Z', refs: humanRefs });
      recordEvent(db, { surface: 'telegram', direction: 'inbound', kind: 'lesson', text: '자리 하나와 비자리 하나의 같은 교훈', ts: '2026-11-21T11:00:00Z', refs: humanRefs });
      const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
      expect(result.promoted).toBe(0);             // RED: A·telegram 2'자리'로 세어 1 승격
      expect(unconsolidatedLessonCount(db)).toBe(2);
    }
    {
      const db = freshDb(); // (3) 실제 자리 2 + 비자리 1 — 승격하되 seats 집계에는 실제 자리만
      for (const surface of ['seat:A', 'seat:B', 'telegram']) {
        recordEvent(db, { surface, direction: 'inbound', kind: 'lesson', text: '실제 자리 2와 비자리 1의 같은 교훈', ts: '2026-11-21T10:00:00Z', refs: humanRefs });
      }
      const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
      expect(result.promoted).toBe(1);
      const tags = JSON.parse(crossSeatRows(db)[0]!.tags ?? '{}') as { seats: string[] };
      expect(tags.seats).toEqual(['A', 'B']);     // RED: ['A','B','telegram'] — 비자리가 자리로 집계
      expect(unconsolidatedLessonCount(db)).toBe(0);
    }
  });
});

// terra r2 shouldFix(b) — 실제 record 노드(graphs/memory record 단계)에서 승격 호출하는 통합 검증
// + shouldFix(a) 승격 중 예외의 실패 상태 명시.
describe('MEMORY-CROSS-SEAT-PROMOTION — terra r2 shouldFix 실제 record 노드 통합', () => {
  const humanRefs = JSON.stringify({ origin: 'human', utteranceOrigin: 'human', crossSeatShare: true });
  const script = join(import.meta.dir, '..', '..', 'scripts', 'memory-lifecycle-graph-node.ts');
  // 출처: scripts/memory-lifecycle-graph-node.ts verifyEffect 필드 — 전부 0(효과 없음 기준 문맥).
  const zeroEffect = { replayStrengthened: 0, decayChanged: 0, hot: 0, warm: 0, cold: 0, consolidated: 0, archived: 0, prunedEvents: 0, promotionCandidates: 0, errors: 0 };

  const nodeRoot = (): string => join('/tmp', `pool4-cross-seat-node-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`);
  const withStateRoot = <T>(root: string, fn: (db: Database) => T): T => {
    const prev = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    try {
      const db = openSurfaceEventsDb();
      try { return fn(db); } finally { db.close(); }
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = prev;
    }
  };
  const runRecordNode = (root: string): { status: number | null; json: Record<string, unknown> } => {
    const ctx = join(root, 'graph-context.json');
    writeFileSync(ctx, JSON.stringify({
      graphId: 'memory-lifecycle', runId: `pool4-39517-r2-${Date.now()}`, nodeId: 'record',
      outputs: { run: zeroEffect, 'phase-guard': { outcome: 'ok', phase: 'dev-normal' }, 'verify-effect': { outcome: 'ok', effect: zeroEffect, warnings: [] } },
    }));
    const run = spawnSync(process.execPath, [script, 'record'], { env: { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_GRAPH_CONTEXT: ctx }, encoding: 'utf8' });
    const line = run.stdout.trim().split('\n').filter(l => l.startsWith('{')).at(-1);
    return { status: run.status, json: line ? JSON.parse(line) as Record<string, unknown> : {} };
  };

  // OP #130184(처분 B 재판정 · r6) — record 노드는 «운영 호출 경로»: 인증 경로 착지 전까지
  // 승격·원본 마킹 0이 코드로 강제된다. 두 자리 교훈 시드로 강제 차단과 관측 출력을 종단 검증.
  test('실제 record 노드 — 운영 호출 강제(OP #130184): 두 자리 교훈도 승격 0 · blockedByCallPath 출력', () => {
    const root = nodeRoot();
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const lessonText = 'pool4 39517 r2 통합: pregate 전 로컬 시험 먼저';
    withStateRoot(root, db => {
      for (const seat of ['seat:TC-H-POOL-4', 'seat:MVP-B']) {
        recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text: lessonText, ts: '2026-11-21T10:00:00Z', refs: humanRefs });
      }
    });
    const run = runRecordNode(root);
    expect(run.status).toBe(0);
    expect((run.json as { outcome?: string }).outcome).toBe('ok');
    const crossSeat = (run.json as { crossSeat?: { promoted?: number; blockedByCallPath?: number } }).crossSeat;
    // 출처: OP #130184 처분 B — 인증 경로 착지 전까지 운영 record 호출 승격 0건 강제.
    expect(crossSeat?.promoted ?? 0).toBe(0);              // 강제 — 두 자리 교훈 시드에도 0
    expect(crossSeat?.blockedByCallPath ?? 0).toBe(1);    // 차단 관측이 record 출력에 보인다
    withStateRoot(root, db => {
      const rows = db.prepare(`SELECT tags FROM events WHERE kind='cross-seat-lesson'`).all() as Array<{ tags: string | null }>;
      expect(rows.length).toBe(0);                        // 승격 행 0 — 삽입 강제 차단
      const unconsolidated = (db.prepare(`SELECT COUNT(*) c FROM events WHERE kind='lesson' AND (consolidated IS NULL OR consolidated=0)`).get() as { c: number }).c;
      expect(unconsolidated).toBe(2);                     // 원본 보존 — 마킹도 강제 차단
    });
    rmSync(root, { recursive: true, force: true });
  });

  // OP #130184(r6) — 운영 경로는 승격 삽입·마킹이 강제 차단되지만 이관(마이그레이션)은 실행된다
  // (JUD-C #129980 mustFix ①: 데이터 정합). 이관 UPDATE 시점 중단을 재현해 record 노드의
  // 실패 상태 명시(shouldFix a)·fail-soft·트랜잭션 롤백을 종단 검증한다.
  test('실제 record 노드 — 이관 중 예외 → crossSeat.failed 명시(전부 0 위장 아님) · 노드 fail-soft · 롤백', () => {
    const root = nodeRoot();
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const lessonText = 'pool4 39517 r2 통합: 승격 중단 재현 교훈';
    withStateRoot(root, db => {
      for (const seat of ['seat:A', 'seat:B']) {
        recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text: lessonText, ts: '2026-11-21T10:00:00Z', refs: humanRefs });
      }
      // 과거 평문 승격 행(형식 표기 없음) — 운영 record 호출에서도 이관 대상이 된다.
      recordEvent(db, {
        surface: 'memory', direction: 'inbound', kind: 'cross-seat-lesson',
        text: '[자리 교차 교훈 · A·B · 2건]\n요약: 이관 중단 재현\n출처: seat:A#legacy@2026-11-21T10:00:00Z, seat:B#legacy2@2026-11-21T10:00:00Z',
        summary: '이관 중단 재현 — 자리 2곳 교차', importance: 6,
        tags: JSON.stringify({ seats: ['A', 'B'], occurrences: 2, lessonKey: 'legacy-plain-migration-abort-key' }),
        ts: '2026-11-21T10:00:00Z',
      });
      // 이관 갱신 시점 중단 재현 — 마이그레이션 UPDATE(newTags 에 lessonKeyFormat 표기 부여)만
      // 잡는 ABORT 트리거(마킹 UPDATE 는 tags 불변이라 발화하지 않고, 어차피 강제 차단 구간).
      db.run(`CREATE TRIGGER pool4_r6_abort_migration BEFORE UPDATE ON events WHEN NEW.tags LIKE '%lessonKeyFormat%' BEGIN SELECT RAISE(ABORT, 'pool4-r6: interrupted during migration'); END`);
    });
    const run = runRecordNode(root);
    expect(run.status).toBe(0); // fail-soft — 이관 실패가 record 노드를 죽이지 않는다(배선 주석 원문)
    expect((run.json as { outcome?: string }).outcome).toBe('ok');
    const crossSeat = (run.json as { crossSeat?: { failed?: boolean } }).crossSeat;
    expect(crossSeat?.failed).toBe(true); // 실패 상태 명시(shouldFix a) — 전부 0 위장이 아님
    // 원자성 회귀 — 트랜잭션 롤백: 이관 갱신 0(과거 평문 행 그대로) · 승격 후보 원본 미마킹.
    withStateRoot(root, db => {
      const legacyRows = db.prepare(`SELECT tags FROM events WHERE kind='cross-seat-lesson'`).all() as Array<{ tags: string | null }>;
      expect(legacyRows.length).toBe(1);
      expect((JSON.parse(legacyRows[0]!.tags ?? '{}') as { lessonKeyFormat?: string }).lessonKeyFormat).toBeUndefined();
      const unconsolidated = (db.prepare(`SELECT COUNT(*) c FROM events WHERE kind='lesson' AND (consolidated IS NULL OR consolidated=0)`).get() as { c: number }).c;
      expect(unconsolidated).toBe(2); // 승격 후보 시드 2행 — 마킹 0(운영 강제 + 롤백)
    });
    rmSync(root, { recursive: true, force: true });
  });
});

// terra(gpt-6.1-terra) r4 잔여 mustFix 3 — RED 회귀(수리 전 실패 원문 보존 · 실패 우선).
// r4 [0]summary 우선 제거·[1]90자 폐지·[2]비자리 surface 제외는 그대로 유지 — 이 3건은 그 잔여의 정밀화다.
describe('MEMORY-CROSS-SEAT-PROMOTION — terra r4 잔여 mustFix 3 (r5)', () => {
  const humanRefs = JSON.stringify({ origin: 'human', utteranceOrigin: 'human', crossSeatShare: true });
  const now = (): string => '2026-11-22T06:00:00Z';
  const crossSeatRows = (db: Database): Array<{ text: string; tags: string | null }> =>
    db.prepare(`SELECT text, tags FROM events WHERE kind='cross-seat-lesson'`).all() as Array<{ text: string; tags: string | null }>;
  const unconsolidatedLessonCount = (db: Database): number =>
    (db.prepare(`SELECT COUNT(*) c FROM events WHERE kind='lesson' AND (consolidated IS NULL OR consolidated=0)`).get() as { c: number }).c;

  // r4 잔여 [3] — 구두점 의미 차이 병합 방지: 정규화(구두점→공백 접기)는 x != y 와 x == y 를
  // 같은 키로 접는다 → 의미상 상이한 본문이 한 교훈으로 승격·원본까지 consolidated 오마킹된다.
  test('[3] 구두점 의미 차이 — x != y 와 x == y 는 별개 교훈 → 승격 0 · 원본 2건 보존', () => {
    const db = freshDb();
    recordEvent(db, { surface: 'seat:A', direction: 'inbound', kind: 'lesson', text: '같은 교훈 표면: x != y 판정', ts: '2026-11-21T10:00:00Z', refs: humanRefs });
    recordEvent(db, { surface: 'seat:B', direction: 'inbound', kind: 'lesson', text: '같은 교훈 표면: x == y 판정', ts: '2026-11-21T11:00:00Z', refs: humanRefs });
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
    expect(result.promoted).toBe(0);                // RED(수리 전): 접힌 키 '같은 교훈 표면 x y 판정'으로 1 승격
    expect(result.singleSeat).toBe(2);             // RED: 별개 교훈 2그룹(각 자리 1)로 안 쪼개짐
    expect(crossSeatRows(db).length).toBe(0);
    expect(unconsolidatedLessonCount(db)).toBe(2);  // RED: 두 원본 consolidated 오마킹
  });

  // r4 잔여 [3] 반대편 가드 — 같은 연산자(같은 의미)의 대소문자·공백·붙은 강조 변형은 여전히 한 교훈 승격.
  test('[3] 동일 의미(같은 연산자) — 대소문자·공백·붙은 강조 변형은 여전히 병합 → 승격 1', () => {
    const db = freshDb();
    recordEvent(db, { surface: 'seat:A', direction: 'inbound', kind: 'lesson', text: 'X != y 판정', ts: '2026-11-21T10:00:00Z', refs: humanRefs });
    recordEvent(db, { surface: 'seat:B', direction: 'inbound', kind: 'lesson', text: 'x != Y  판정!', ts: '2026-11-21T11:00:00Z', refs: humanRefs });
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
    expect(result.promoted).toBe(1);
    expect(unconsolidatedLessonCount(db)).toBe(0);
  });

  // r4 잔여 [4] — 빈 자리 식별자 제외: seatOfSurface('seat:') → '' 를 자리로 세면
  // 빈 자리 + seat:A 만으로 교차 자리 임계(2)를 충족한다.
  test('[4] 빈 자리 식별자 — seat: 는 자리 아님(null) → 빈 자리+seat:A 임계 미충족 · 원본 보존', () => {
    expect(seatOfSurface('seat:')).toBe(null);      // RED(수리 전): '' 반환 — 빈 식별자를 자리로 집계
    expect(seatOfSurface('seat:A')).toBe('A');
    const db = freshDb();
    recordEvent(db, { surface: 'seat:', direction: 'inbound', kind: 'lesson', text: '빈 자리 표면의 같은 교훈', ts: '2026-11-21T10:00:00Z', refs: humanRefs });
    recordEvent(db, { surface: 'seat:A', direction: 'inbound', kind: 'lesson', text: '빈 자리 표면의 같은 교훈', ts: '2026-11-21T11:00:00Z', refs: humanRefs });
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
    expect(result.promoted).toBe(0);                // RED(수리 전): '' + 'A' 2'자리'로 세어 1 승격
    expect(result.singleSeat).toBe(1);              // 실제 자리는 A 하나뿐 — 그룹 1
    expect(crossSeatRows(db).length).toBe(0);
    expect(unconsolidatedLessonCount(db)).toBe(2);  // 원본 보존
  });

  // r4 잔여 [5] — 승격 본문 전체 보존: slice(0, 10) 은 11번째 이후 원본을 승격 본문에서 누락시키면서
  // 모든 원본을 consolidated 처리한다 → 소비하는 원본의 전체 내용(12행 전부)을 실어야 한다.
  test('[5] 승격 본문 원문 미저장 — 12행 전부 출처 포인터로 실림 · 원문 전문 폐지 (OP #129296 사양 3)', () => {
    const words = ['cross', 'seat', 'full', 'source', 'keep'];
    const textOf = (i: number): string => words.map((w, j) => (((i >> j) & 1) === 1 ? w.toUpperCase() : w)).join(' ');
    const db = freshDb();
    for (let i = 0; i < 12; i++) {
      recordEvent(db, {
        surface: i < 6 ? 'seat:A' : 'seat:B', direction: 'inbound', kind: 'lesson',
        text: textOf(i), // 12행 전부 같은 정규화 키(대소문자 차이만) — 원문은 12개 전부 상이
        ts: `2026-11-21T${i < 10 ? 10 : 11}:${String(i % 60).padStart(2, '0')}:00Z`,
        refs: humanRefs,
      });
    }
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
    expect(result.scanned).toBe(12);
    expect(result.promoted).toBe(1);
    const rows = crossSeatRows(db);
    expect(rows.length).toBe(1);
    const body = rows[0]!.text;
    expect(body.split('\n').filter(l => l.startsWith('- ')).length).toBe(0); // 원문 전문 나열(불릿) 폐지
    const pointers = (body.split('\n').find(l => l.startsWith('출처:')) ?? '').split(', ').filter(x => x.includes('#'));
    // 출처: OP #129296 사양 3 — 12행 전부(11·12번째 포함) 출처 포인터로 누락 0
    expect(pointers.length).toBe(12);
    expect(body).toContain('요약:');               // 결정론 요약(정규화 키 80자 접두)
    const tags = JSON.parse(rows[0]!.tags ?? '{}') as { seats: string[]; occurrences: number };
    expect(tags.occurrences).toBe(12);
    expect(tags.seats).toEqual(['A', 'B']);
    expect(unconsolidatedLessonCount(db)).toBe(0);
  });
});

// terra r6 — JUD-C mustFix #39517(붙여 쓴 비교 연산자): x!=y / x==y 는 소프트 키가 같고
// («x y») 연산자가 낱말에 붙어 r4 standalone 지문에도 안 잡히므로 한 그룹 키로 충돌했다.
// 비교 연산자(=== !== == != <= >= < >)는 붙임·공백·대소문자 표기와 무관하게 정규화된
// 안정 토큰(≠ = ≤ ≥ < >)으로 키에 남는다 — 의미상 상이 본문 병합 금지 · 같은 연산자의
// 표기 변형 병합은 유지. RED(수리 전 실패 원문 보존 · 실패 우선).
describe('MEMORY-CROSS-SEAT-PROMOTION — terra r6 붙여 쓴 비교 연산자 키(JUD-C mustFix #39517)', () => {
  const humanRefs = JSON.stringify({ origin: 'human', utteranceOrigin: 'human', crossSeatShare: true });
  const now = (): string => '2026-11-22T06:00:00Z';
  const crossSeatRows = (db: Database): Array<{ text: string; tags: string | null }> =>
    db.prepare(`SELECT text, tags FROM events WHERE kind='cross-seat-lesson'`).all() as Array<{ text: string; tags: string | null }>;
  const unconsolidatedLessonCount = (db: Database): number =>
    (db.prepare(`SELECT COUNT(*) c FROM events WHERE kind='lesson' AND (consolidated IS NULL OR consolidated=0)`).get() as { c: number }).c;

  // (a) 충돌 회귀(종단) — 붙여 쓴 x!=y / x==y 는 별개 교훈: 요약까지 동일하게 시드해(기존
  // 그룹핑 우선 경로도 같은 재료) 승격·원본 consolidated 마킹이 일어나지 않고 두 원본이 보존된다.
  test('(a) 붙여 쓴 x!=y vs x==y — 동일 요약·상이 본문 → 별개 교훈 · 승격 0 · 두 원본 보존', () => {
    const db = freshDb();
    recordEvent(db, { surface: 'seat:A', direction: 'inbound', kind: 'lesson', text: '같은 교훈 표면: x!=y 판정', summary: '동일 요약: 비교 연산자', ts: '2026-11-21T10:00:00Z', refs: humanRefs });
    recordEvent(db, { surface: 'seat:B', direction: 'inbound', kind: 'lesson', text: '같은 교훈 표면: x==y 판정', summary: '동일 요약: 비교 연산자', ts: '2026-11-21T11:00:00Z', refs: humanRefs });
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
    expect(result.promoted).toBe(0);                 // RED(수리 전): '같은 교훈 표면 x y 판정' 같은 키 → 1 승격
    expect(result.singleSeat).toBe(2);
    expect(crossSeatRows(db).length).toBe(0);
    expect(unconsolidatedLessonCount(db)).toBe(2);  // RED: 두 원본 consolidated 오마킹
  });

  // (b) 표기 변형 병합 보호 — 같은 연산자의 공백(붙임)·대소문자·전각 공백(U+3000) 변형은
  // 여전히 한 교훈으로 병합·승격된다(종전 정규화 범위 회귀).
  test('(b) x != y 와 x!=y(공백 차이)·케이스·전각 공백 변형은 여전히 병합 → 승격 1 · 원본 소비', () => {
    {
      const db = freshDb(); // 공백 차이 — 떨어진 x != y vs 붙인 x!=y
      recordEvent(db, { surface: 'seat:A', direction: 'inbound', kind: 'lesson', text: 'x != y 판정', ts: '2026-11-21T10:00:00Z', refs: humanRefs });
      recordEvent(db, { surface: 'seat:B', direction: 'inbound', kind: 'lesson', text: 'x!=y 판정', ts: '2026-11-21T11:00:00Z', refs: humanRefs });
      const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
      expect(result.promoted).toBe(1);               // RED(수리 전): 'x y [op: !=]' vs 'x y' → 다른 키 → 0
      expect(crossSeatRows(db).length).toBe(1);
      expect(unconsolidatedLessonCount(db)).toBe(0);
    }
    {
      const db = freshDb(); // 대소문자 + 전각 공백(U+3000) — 종전 정규화 변형
      recordEvent(db, { surface: 'seat:A', direction: 'inbound', kind: 'lesson', text: 'X != y 판정', ts: '2026-11-21T10:00:00Z', refs: humanRefs });
      recordEvent(db, { surface: 'seat:B', direction: 'inbound', kind: 'lesson', text: 'x\u3000!=\u3000Y 판정', ts: '2026-11-21T11:00:00Z', refs: humanRefs });
      const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
      expect(result.promoted).toBe(1);
      expect(unconsolidatedLessonCount(db)).toBe(0);
    }
  });

  // (c) 다른 비교 연산자 쌍 — a<=b vs a>=b(≤ vs ≥) · p===q vs p!==q(= vs ≠) 는 별개 ·
  // a<=b 의 공백·케이스 변형은 병합.
  test('(c) a<=b vs a>=b · p===q vs p!==q 별개 → 승격 0 · a<=b 공백 변형 → 병합 1', () => {
    {
      const db = freshDb();
      recordEvent(db, { surface: 'seat:A', direction: 'inbound', kind: 'lesson', text: '같은 교훈 표면: a<=b 판정', ts: '2026-11-21T10:00:00Z', refs: humanRefs });
      recordEvent(db, { surface: 'seat:B', direction: 'inbound', kind: 'lesson', text: '같은 교훈 표면: a>=b 판정', ts: '2026-11-21T11:00:00Z', refs: humanRefs });
      const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
      expect(result.promoted).toBe(0);
      expect(result.singleSeat).toBe(2);
      expect(unconsolidatedLessonCount(db)).toBe(2);
    }
    {
      const db = freshDb();
      recordEvent(db, { surface: 'seat:A', direction: 'inbound', kind: 'lesson', text: '같은 교훈 표면: p===q 판정', ts: '2026-11-21T10:00:00Z', refs: humanRefs });
      recordEvent(db, { surface: 'seat:B', direction: 'inbound', kind: 'lesson', text: '같은 교훈 표면: p!==q 판정', ts: '2026-11-21T11:00:00Z', refs: humanRefs });
      const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
      expect(result.promoted).toBe(0);
      expect(result.singleSeat).toBe(2);
      expect(unconsolidatedLessonCount(db)).toBe(2);
    }
    {
      const db = freshDb();
      recordEvent(db, { surface: 'seat:A', direction: 'inbound', kind: 'lesson', text: '같은 교훈 표면: a <= b 판정', ts: '2026-11-21T10:00:00Z', refs: humanRefs });
      recordEvent(db, { surface: 'seat:B', direction: 'inbound', kind: 'lesson', text: '같은 교훈 표면: a<=B 판정', ts: '2026-11-21T11:00:00Z', refs: humanRefs });
      const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
      expect(result.promoted).toBe(1);              // 같은 ≤ 연산자의 공백·케이스 변형 → 병합
      expect(unconsolidatedLessonCount(db)).toBe(0);
    }
  });

  // 단위 — 정체성 키 도출: 비교 연산자는 표기(붙임·공백·엄격 계열)와 무관한 안정 토큰.
  test('단위 — lessonIdentityKey: !=≠ == = · 붙임·공백·케이스 무관 · 비연산자 붙은 변형 병합 유지', () => {
    expect(lessonIdentityKey('x!=y')).not.toBe(lessonIdentityKey('x==y'));       // RED(수리 전): 둘 다 'x y'
    expect(lessonIdentityKey('x!=y')).toBe(lessonIdentityKey('x != y'));         // RED: 'x y' vs 'x y [op: !=]'
    expect(lessonIdentityKey('x!=y')).toBe(lessonIdentityKey('X != Y'));
    expect(lessonIdentityKey('a<=b')).not.toBe(lessonIdentityKey('a>=b'));       // RED: 둘 다 'a b'
    expect(lessonIdentityKey('p===q')).not.toBe(lessonIdentityKey('p!==q'));     // RED: 둘 다 'p q'
    expect(lessonIdentityKey('p===q')).toBe(lessonIdentityKey('p == q'));       // ===/== → 같은 '=' 토큰
    expect(lessonIdentityKey('붙은 강조 금지!')).toBe(lessonIdentityKey('붙은 강조 금지!!')); // 비연산자 붙은 변형 병합 유지
  });
});
