// MEMORY-CROSS-SEAT-PROMOTION 프라이버시(OP #129296 · JUD HOLD jud-39517-fe6e101f1888) —
// RED 회귀: 미표기·비공개·위조 출처는 전역 승격 0. 임시 SQLite · 운영 DB 미접촉.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promoteCrossSeatLessons, lessonIdentityKey } from './cross-seat-promotion.js';
import { recordEvent, openSurfaceEventsDb } from './surface-events.js';

const ROOT = join('/tmp', `pool4-cross-seat-privacy-${process.pid}`);
const DB = join(ROOT, 'surface_events.db');

function freshDb(): Database {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  return openSurfaceEventsDb(DB);
}

/** 전역 승격 행의 text 원문 — 원문 전문이 전역에 실렸는지 검사 재료. */
const globalRows = (db: Database): Array<{ text: string; tags: string | null }> =>
  db.prepare(`SELECT text, tags FROM events WHERE kind='cross-seat-lesson'`).all() as Array<{ text: string; tags: string | null }>;
const unconsolidatedLessonCount = (db: Database): number =>
  (db.prepare(`SELECT COUNT(*) c FROM events WHERE kind='lesson' AND (consolidated IS NULL OR consolidated=0)`).get() as { c: number }).c;

describe('MEMORY-CROSS-SEAT-PROMOTION 프라이버시 — OP #129296 · 미표기=거부 기본값', () => {
  const now = (): string => '2026-11-22T06:00:00Z';
  const humanRefs = JSON.stringify({ origin: 'human', utteranceOrigin: 'human' });

  test('① 미표기 출처 — 인증·공유 허용 표기 없는 두 자리 교차 교훈은 전역 승격 0', () => {
    const db = freshDb();
    for (const seat of ['seat:A', 'seat:B']) {
      recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text: '미표기 출처의 같은 교훈: 시크릿 세부', ts: '2026-11-21T10:00:00Z', refs: humanRefs });
    }
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
    // 출처: OP #129296 사양 ① — 미표기 출처 → 전역 승격 0
    expect(result.promoted).toBe(0);
    expect(globalRows(db).length).toBe(0);
    // 미승격 행은 원본 그대로 보존(consolidated 오마킹 금지)
    expect(unconsolidatedLessonCount(db)).toBe(2);
  });

  test('② 비공개 표기 — 원문 비공개 표시 교훈은 전역 승격 0 · 원문 미유출', () => {
    const db = freshDb();
    for (const seat of ['seat:A', 'seat:B']) {
      recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text: '비공개 표기 원문: 절대 전역에 가면 안 되는 내용', ts: '2026-11-21T10:00:00Z', refs: humanRefs, tags: 'private' });
    }
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
    // 출처: OP #129296 사양 ② — 비공개 표기 → 전역 0
    expect(result.promoted).toBe(0);
    const rows = globalRows(db);
    expect(rows.length).toBe(0);
    for (const r of rows) expect(r.text).not.toContain('절대 전역에 가면 안 되는 내용');
    expect(unconsolidatedLessonCount(db)).toBe(2);
  });

  test('③ 위조 출처 — 출처 위장(공유 허용 표기를 인증 불가 채널(tags)에 위조)은 전역 승격 0', () => {
    const db = freshDb();
    // 위조 출처 재현: 사람(human) 출처 표기 + «공유 허용» 표기를 tags(표시용 메타 채널)에 위조해 심은 행.
    // 공유 허용 표기는 인증된 provenance 채널(refs)의 구조화 표기만 인정한다 — tags·본문에 적은 허용 표기는 위장이다.
    recordEvent(db, { surface: 'seat:A', direction: 'inbound', kind: 'lesson', text: '위조 출처의 같은 교훈: 시크릿 원문', ts: '2026-11-21T10:00:00Z', refs: humanRefs, tags: 'cross-seat-share ok' });
    recordEvent(db, { surface: 'seat:B', direction: 'inbound', kind: 'lesson', text: '위조 출처의 같은 교훈: 시크릿 원문', ts: '2026-11-21T10:30:00Z', refs: humanRefs, tags: 'share:yes allow-cross-seat' });
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
    // 출처: OP #129296 사양 ③ — 위조 출처(출처 위장) → 전역 0
    expect(result.promoted).toBe(0);
    expect(globalRows(db).length).toBe(0);
    for (const r of globalRows(db)) expect(r.text).not.toContain('시크릿 원문');
    expect(unconsolidatedLessonCount(db)).toBe(2);
  });
});

// terra mustFix r2(OP #129296 · PR #39582) — ① 승격 행 전역 메타데이터(tags.lessonKey 등)에
// 원문 전체 키가 평문으로 남는 경로 제거 ② pointerOf 8자 절단 충돌 — 유일 조회 포인터.
describe('MEMORY-CROSS-SEAT-PROMOTION 프라이버시 r2 — terra mustFix(전역 메타데이터 비가역 · 포인터 유일 조회)', () => {
  const now = (): string => '2026-11-22T06:00:00Z';
  const humanRefs = JSON.stringify({ origin: 'human', utteranceOrigin: 'human', crossSeatShare: true });
  /** 승격 행 전체 저장 열 직렬화 — 원문 부분문자열이 어느 필드에도 남는지 검사 재료. */
  const promotedRowFull = (db: Database): { text: string; summary: string | null; tags: string | null } =>
    db.prepare(`SELECT text, summary, tags FROM events WHERE kind='cross-seat-lesson'`).get() as { text: string; summary: string | null; tags: string | null };

  test('④ 전역 메타데이터 비가역 — 저장 행 전체(text·summary·tags)에 원문 부분문자열 0개 (terraform mustFix #1 · OP #129296)', () => {
    const db = freshDb();
    // 긴 교훈 — 80자 요약 접두 너머에 «전역에 남으면 안 되는» 고유 꼬리 심장문.
    const head = '출처 요약 접두로만 전역에 남아도 되는 서두'.repeat(6); // 204자 — 80자 요약 경계 넘김
    const secretTail = '시크릿심장문 r2 mustFix1 꼬리 이 부분은 전역 어디에도 남으면 안 된다';
    const text = `${head} — ${secretTail}`;
    expect(text.length).toBeGreaterThan(80);
    for (const seat of ['seat:A', 'seat:B']) {
      recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text, ts: '2026-11-21T10:00:00Z', refs: humanRefs });
    }
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
    expect(result.promoted).toBe(1);
    const row = promotedRowFull(db);
    const serialized = JSON.stringify(row);
    // 출처: terra mustFix #1(OP #129296) — 80자 접두 요약 외 어떤 원문 유출도 0이어야 한다.
    // 꼬리 심장문은 원문 어디에도(본문·요약·tags 포함) 등장하지 않는다.
    expect(serialized.includes(secretTail)).toBe(false);
    // 전역 메타데이터(tags.lessonKey)는 멱등성을 유지하는 비가역 표현(SHA-256 접두 해시)이어야 한다.
    const tags = JSON.parse(row.tags ?? '{}') as { lessonKey?: string };
    expect(tags.lessonKey).toBe(createHash('sha256').update(lessonIdentityKey(text)).digest('hex').slice(0, 16));
    expect(typeof tags.lessonKey).toBe('string');
    expect(tags.lessonKey!.length).toBeLessThanOrEqual(16); // 해시 접두 — 원문 복원 불가 비가역 표현
  });

  test('⑤ 포인터 유일 조회 — 같은 surface·같은 ts 의 서로 다른 2행을 포인터로 각각 정확히 구별 (terraform mustFix #2 · OP #129296)', () => {
    const db = freshDb();
    // 충돌 재현: 같은 자리·같은 시각에 서로 다른 교훈 2건(원본 id 앞 8자가 달라도 구별 가능해야 하고,
    // 더 엄격한 회귀 — 포인터가 8자 절단이면 서로 다른 행을 구별 못 할 수 있다).
    const lessons = ['포인터 충돌 회귀 교훈 알파: 유일 조회 검증', '포인터 충돌 회귀 교훈 베타: 유일 조회 검증'];
    for (const seat of ['seat:A', 'seat:B']) {
      for (const text of lessons) {
        recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text, ts: '2026-11-21T10:00:00Z', refs: humanRefs });
      }
    }
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
    expect(result.promoted).toBe(2);
    const originals = db.prepare(`SELECT id, text FROM events WHERE kind='lesson' ORDER BY id`).all() as Array<{ id: string; text: string }>;
    expect(originals.length).toBe(4);
    const rows = db.prepare(`SELECT text FROM events WHERE kind='cross-seat-lesson'`).all() as Array<{ text: string }>;
    // 출처: terra mustFix #2(OP #129296) — 포인터는 원본을 유일하게 조회할 수 있어야 한다.
    // 승격 행의 포인터로 원본 행을 실제 조회(id 일치)해 서로 다른 2행을 정확히 구별함을 단언.
    const pointerRe = /seat:[A-Za-z0-9_-]+#([^@\s]+)@(\S+)/g;
    const lookupById = (id: string): { id: string; text: string } | undefined =>
      db.prepare(`SELECT id, text FROM events WHERE id = ?`).get(id) as { id: string; text: string } | undefined;
    for (const r of rows) {
      const found = [...r.text.matchAll(pointerRe)];
      expect(found.length).toBe(2); // 각 승격 행은 자기 교훈의 원본 2건(자리 A·B)을 가리킨다
      const lookedUp = found.map(m => lookupById(m[1]!));
      expect(lookedUp.every(x => x !== undefined)).toBe(true); // 전체 id 로 원본 행 유일 조회 성공
      const lookedUpTexts = lookedUp.map(x => x!.text);
      // 포인터가 가리키는 원본은 전부 같은 교훈(알파 or 베타)이어야 한다 — 8자 절단 충돌로
      // 다른 교훈 원본을 가리키면 이 단언이 깨진다.
      const distinct = new Set(lookedUpTexts);
      expect(distinct.size).toBe(1);
    }
    // 알파·베타 승격 행이 가리키는 원본 집합은 서로 다르다(각자 자기 원본만).
    const [alpha, beta] = rows;
    const alphaTexts = [...alpha!.text.matchAll(pointerRe)].map(m => lookupById(m[1]!)!.text);
    const betaTexts = [...beta!.text.matchAll(pointerRe)].map(m => lookupById(m[1]!)!.text);
    expect(new Set(alphaTexts).size).toBe(1);
    expect(new Set(betaTexts).size).toBe(1);
    expect(alphaTexts[0]).not.toBe(betaTexts[0]); // 두 승격 행은 서로 다른 원본을 가리킨다
  });
});

// terra r3 mustFix 1(DELTA-FINDING 1 OPEN · PR #39582) — 신규 시험이 text·summary·tags 세 열만
// 조회해 검증한다: 저장 행 «전체» (events 모든 열 + events_fts.search_text)을 덤프해 원문·평문
// 키·장문 내용 잔존 0을 단언한다. 잔존 열이 있으면 그 열도 비가역 처리한다(수리).
describe('MEMORY-CROSS-SEAT-PROMOTION 프라이버시 r3 — terra mustFix 1: 저장 행 전체 열 잔존 0', () => {
  const now = (): string => '2026-11-22T06:00:00Z';
  const humanRefs = JSON.stringify({ origin: 'human', utteranceOrigin: 'human', crossSeatShare: true });

  test('⑥ 저장 행 전체 덤프 — events 모든 열 + FTS search_text 어디에도 원문 키·시크릿 꼬리 잔존 0 (terra r3 mustFix 1)', () => {
    const db = freshDb();
    const head = '출처 요약 접두로만 전역에 남아도 되는 서두'.repeat(6); // 204자 — 80자 요약 경계 넘김
    const secretTail = '시크릿심장문 r3 mustFix1 전체열덤프 꼬리 이 부분은 전역 어디에도 남으면 안 된다';
    const text = `${head} — ${secretTail}`;
    for (const seat of ['seat:A', 'seat:B']) {
      recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text, ts: '2026-11-21T10:00:00Z', refs: humanRefs });
    }
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
    expect(result.promoted).toBe(1);
    // 저장 행 전체 — SELECT * (모든 열) 로 덤프한다(세 열만 조회하는 종전 검증의 맹점).
    const rows = db.prepare(`SELECT * FROM events WHERE kind='cross-seat-lesson'`).all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    const fullDump = JSON.stringify(rows);
    // 전체 원문 키(lessonIdentityKey 전문)는 어느 열에도 평문으로 남지 않는다.
    expect(fullDump.includes(lessonIdentityKey(text))).toBe(false);
    // 80자 요약 접두 너머의 시크릿 꼬리는 어느 열에도 남지 않는다.
    expect(fullDump.includes(secretTail)).toBe(false);
    // FTS 인덱스(events_fts.search_text = summary+text+tags)도 저장 행의 일부 — 잔존 0.
    const fts = db.prepare(`SELECT search_text FROM events_fts WHERE id IN (SELECT id FROM events WHERE kind='cross-seat-lesson')`).all() as Array<{ search_text: string }>;
    const ftsDump = JSON.stringify(fts);
    expect(ftsDump.includes(lessonIdentityKey(text))).toBe(false);
    expect(ftsDump.includes(secretTail)).toBe(false);
    // 정상 출처 포인터(surface#id@ts)는 회상을 위해 여전히 조회 가능해야 한다(과차단 아님).
    expect(rows[0]!.text).toContain('seat:A#');
  });

  test('⑦ 과거 평문 lessonKey 승격 행과의 멱등 — 동일 교훈 재유입 시 중복 승격 0 (terra r3 mustFix 2)', () => {
    const db = freshDb();
    const lessonText = 'r3 mustFix2 과거 평문 키 멱등 회귀: 동일 교훈 재유입 중복 승격 금지';
    // r2 수리 이전 형식의 기존 승격 행 — tags.lessonKey 에 «평문» 전체 키 저장(구 저장 형식).
    const legacyKey = lessonIdentityKey(lessonText);
    recordEvent(db, {
      surface: 'memory', direction: 'inbound', kind: 'cross-seat-lesson',
      text: `[자리 교차 교훈 · A·B · 2건]\n요약: ${legacyKey.slice(0, 80)}\n출처: seat:A#legacy-a@2026-11-21T10:00:00Z, seat:B#legacy-b@2026-11-21T10:00:00Z`,
      summary: `${legacyKey.slice(0, 80)} — 자리 2곳 교차`,
      importance: 6, tags: JSON.stringify({ seats: ['A', 'B'], occurrences: 2, lessonKey: legacyKey }),
      ts: '2026-11-22T06:00:00Z',
    });
    // 동일 교훈이 두 «새» 자리에서 재유입 — 새 형식(해시) 판정이 과거 평문 행과 멱등해야 한다.
    for (const seat of ['seat:C', 'seat:D']) {
      recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text: lessonText, ts: '2026-11-23T10:00:00Z', refs: humanRefs });
    }
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now: () => '2026-11-24T06:00:00Z' });
    // 출처: terra r3 mustFix 2 — 기존 평문 lessonKey 행과도 동일 멱등 판정 → 중복 승격 0.
    expect(result.promoted).toBe(0);
    expect(result.alreadyPromoted).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) c FROM events WHERE kind='cross-seat-lesson'`).get() as { c: number }).c).toBe(1);
  });

  test('⑧ 마이그레이션 — 과거 평문 lessonKey 승격 행이 구 형식에서 해시 형식으로 비가역 갱신된다 (terra r3 mustFix 1·2)', () => {
    const db = freshDb();
    // 80자 초과 키 — «전체 키» 와 설계상 허용된 80자 요약 접두를 구별할 수 있어야 한다.
    const lessonText = 'r3 마이그레이션 회귀 과거 평문 키는 파이프라인 실행 후 비가역 해시 표현으로 갱신되고 저장 행 전체 열 덤프에서 평문 잔존이 사라진다 시크릿 꼬리 포함 검증';
    const legacyKey = lessonIdentityKey(lessonText);
    expect(legacyKey.length).toBeGreaterThan(80); // 전체 키는 요약 접두(80자) 너머에도 있다
    const legacyRowId = recordEvent(db, {
      surface: 'memory', direction: 'inbound', kind: 'cross-seat-lesson',
      text: `[자리 교차 교훈 · A·B · 2건]\n요약: ${legacyKey.slice(0, 80)}\n출처: seat:A#legacy-a@2026-11-21T10:00:00Z, seat:B#legacy-b@2026-11-21T10:00:00Z`,
      summary: `${legacyKey.slice(0, 80)} — 자리 2곳 교차`,
      importance: 6, tags: JSON.stringify({ seats: ['A', 'B'], occurrences: 2, lessonKey: legacyKey }),
      ts: '2026-11-22T06:00:00Z',
    });
    // 동일 교훈 재유입 → 멱등 스킵 + 과거 평문 행의 tags.lessonKey 가 해시로 비가역 갱신된다.
    for (const seat of ['seat:C', 'seat:D']) {
      recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text: lessonText, ts: '2026-11-23T10:00:00Z', refs: humanRefs });
    }
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now: () => '2026-11-24T06:00:00Z' });
    expect(result.promoted).toBe(0);
    expect(result.alreadyPromoted).toBe(1);
    const migrated = db.prepare(`SELECT tags FROM events WHERE id = ?`).get(legacyRowId) as { tags: string | null };
    const tags = JSON.parse(migrated.tags ?? '{}') as { lessonKey?: string; seats?: string[]; occurrences?: number };
    expect(tags.lessonKey).toBe(createHash('sha256').update(legacyKey).digest('hex').slice(0, 16)); // 비가역 해시로 갱신
    expect(tags.lessonKey).not.toBe(legacyKey); // 평문 키 잔존 아님
    expect(tags.seats).toEqual(['A', 'B']);   // 나머지 메타데이터는 보존
    expect(tags.occurrences).toBe(2);
    // 갱신 후에도 평문 «전체» 키는 events 전체(모든 열)에서 잔존 0 — 80자 접두는 설계상 허용 표현.
    const fullDump = JSON.stringify(db.prepare(`SELECT * FROM events WHERE kind='cross-seat-lesson'`).all());
    expect(fullDump.includes(legacyKey)).toBe(false);
    // FTS 인덱스(search_text = summary+text+tags 조립)에도 평문 전체 키 잔존 0.
    const ftsDump = JSON.stringify(db.prepare(`SELECT search_text FROM events_fts WHERE id = ?`).all(legacyRowId));
    expect(ftsDump.includes(legacyKey)).toBe(false);
  });
});

// terra r5 mustFix 1(PR #39582) — 과거 평문 lessonKey 가 «우연히» 16자 hex 형태면 해시로
// 오인해 도출 해시를 멱등 집합에 넣지 않는다 → 같은 교훈 재유입 시 중복 승격. 저장 형식의
// 모호성은 명시적 형식 표기(lessonKeyFormat)로 해소한다 — 미표기 = 과거 평문(hex처럼 보여도).
describe('MEMORY-CROSS-SEAT-PROMOTION 프라이버시 r5 — terra mustFix 1: 저장 형식 모호성(hex-평문 멱등)', () => {
  const humanRefs = JSON.stringify({ origin: 'human', utteranceOrigin: 'human', crossSeatShare: true });

  test('⑨ hex-평문 lessonKey — 과거 평문 키가 우연히 16자 hex여도 멱등(중복 승격 0)·형식 표기로 갱신 (terra r5 mustFix 1)', () => {
    const db = freshDb();
    const lessonText = 'abcdef0123456789'; // lessonIdentityKey 결과가 정확히 16자 hex — 평문인데 해시처럼 보인다
    const legacyKey = lessonIdentityKey(lessonText);
    expect(legacyKey).toMatch(/^[0-9a-f]{16}$/); // 모호성 재현: 평문 키가 해시 정규식에 걸린다
    const legacyRowId = recordEvent(db, {
      surface: 'memory', direction: 'inbound', kind: 'cross-seat-lesson',
      text: `[자리 교차 교훈 · A·B · 2건]\n요약: ${legacyKey}\n출처: seat:A#legacy-hex-a@2026-11-21T10:00:00Z, seat:B#legacy-hex-b@2026-11-21T10:00:00Z`,
      summary: `${legacyKey} — 자리 2곳 교차`, importance: 6,
      tags: JSON.stringify({ seats: ['A', 'B'], occurrences: 2, lessonKey: legacyKey }), // 형식 표기 없음 = 과거 평문
      ts: '2026-11-22T06:00:00Z',
    });
    for (const seat of ['seat:C', 'seat:D']) {
      recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text: lessonText, ts: '2026-11-23T10:00:00Z', refs: humanRefs });
    }
    const result = promoteCrossSeatLessons(db, { callPath: 'authenticated', now: () => '2026-11-24T06:00:00Z' });
    // 출처: terra r5 mustFix 1 — hex-평문 과거 행도 멱등 인식 → 중복 승격 0.
    expect(result.promoted).toBe(0);
    expect(result.alreadyPromoted).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) c FROM events WHERE kind='cross-seat-lesson'`).get() as { c: number }).c).toBe(1);
    // 마이그레이션 — 평문 hex 키는 진짜 해시 표현으로 갱신되고 형식 표기(lessonKeyFormat)가 붙는다.
    const migrated = db.prepare(`SELECT tags FROM events WHERE id = ?`).get(legacyRowId) as { tags: string | null };
    const tags = JSON.parse(migrated.tags ?? '{}') as { lessonKey?: string; lessonKeyFormat?: string };
    expect(tags.lessonKey).toBe(createHash('sha256').update(legacyKey).digest('hex').slice(0, 16));
    expect(tags.lessonKeyFormat).toBe('sha256-16'); // 저장 형식 모호성 해소 — 명시 표기
    expect(tags.lessonKey).not.toBe(legacyKey); // 평문 hex 잔존 아님
  });
});

// OP #130184(JUD 보안 HOLD 처분 B 재판정 · r6) — 승격 허용은 refs 표기를 신뢰하지 않고 «호출 경로»만
// 본다: 운영 호출 경로(제품 lifecycle record 단계 = promoteCrossSeatLessons 기본 callPath)에서는
// refs 에 crossSeatShare=true·사람 출처가 «직접 기입»돼 있어도 승격·원본 마킹이 0으로 코드 강제된다.
// 인증 경로가 착지되면 그 경로만 허용 목록으로 열리는 구조다(현재 인증 진입점은 제품에 없다).
// JUD-C #129980 mustFix ① — 과거 평문 lessonKey 이관(마이그레이션)은 승격 그룹 임계와 무관한
// 데이터 정합(비가역 해시)이라 적격 두 자리 그룹이 없는 실행에서도 이관된다.
describe('MEMORY-CROSS-SEAT-PROMOTION 프라이버시 r6 — OP #130184 처분 B: 운영 호출 승격 0 강제', () => {
  const now = (): string => '2026-11-22T06:00:00Z';
  // 공유 허용·사람 출처가 refs 에 «직접 기입»된 행 — 위조 기입과 실제 제품 기록을 승격 함수가
  // 구별할 수 없다(그래서 refs 표기를 신뢰하지 않는다 · OP #130184).
  const forgedRefs = JSON.stringify({ origin: 'human', utteranceOrigin: 'human', crossSeatShare: true });
  const crossSeatCount = (db: Database): number =>
    (db.prepare(`SELECT COUNT(*) c FROM events WHERE kind='cross-seat-lesson'`).get() as { c: number }).c;
  const unconsolidatedLessonCount = (db: Database): number =>
    (db.prepare(`SELECT COUNT(*) c FROM events WHERE kind='lesson' AND (consolidated IS NULL OR consolidated=0)`).get() as { c: number }).c;

  test('⑩ 운영 호출 강제 — refs에 crossSeatShare=true·사람 출처를 직접 기입해도 운영 호출 경로는 승격·원본 마킹 0 (OP #130184)', () => {
    const db = freshDb();
    for (const seat of ['seat:A', 'seat:B']) {
      recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text: '운영 강제 회귀: 같은 교훈', ts: '2026-11-21T10:00:00Z', refs: forgedRefs });
    }
    // callPath 미지정 = 기본 'operational' — 제품 record 단계와 같은 운영 진입.
    const result = promoteCrossSeatLessons(db, { now });
    // 출처: OP #130184 처분 B — 인증 경로 착지 전까지 운영 호출 승격 0건 강제.
    expect(result.promoted).toBe(0);                 // RED(수리 전): refs 표기를 신뢰해 1 승격
    expect(result.blockedByCallPath).toBe(1);        // RED(수리 전): 차단 관측 필드가 없음
    expect(crossSeatCount(db)).toBe(0);             // 승격 행 0
    expect(unconsolidatedLessonCount(db)).toBe(2);  // 원본 마킹 0 — 강제는 마킹까지 0
  });

  test('⑪ 인증 경로만 개방 — callPath:"authenticated" 주입(시험 우주·인증 경로 재현)에만 동일 재료가 승격 로직을 통과 (OP #130184 «그 경로만 여는 구조»)', () => {
    const db = freshDb();
    for (const seat of ['seat:A', 'seat:B']) {
      recordEvent(db, { surface: seat, direction: 'inbound', kind: 'lesson', text: '인증 경로 대조: 같은 교훈', ts: '2026-11-21T10:00:00Z', refs: forgedRefs });
    }
    // 운영 진입(기본 callPath) — 강제 차단: 승격 0·차단 관측 1.
    const operational = promoteCrossSeatLessons(db, { now });
    expect(operational.promoted).toBe(0);
    expect(operational.blockedByCallPath).toBe(1);
    // 인증 경로 재현 주입 — «그 경로만» 승격 로직이 작동한다(인증 진입점은 착지 전까지 제품에 없음).
    const authenticated = promoteCrossSeatLessons(db, { callPath: 'authenticated', now });
    expect(authenticated.promoted).toBe(1);
    expect(crossSeatCount(db)).toBe(1);
    expect(unconsolidatedLessonCount(db)).toBe(0); // 원본 소비 마킹은 인증 경로에서만
  });

  test('⑫ 무적격 그룹 이관 — 적격 두 자리 그룹이 없어도 과거 평문 lessonKey 승격 행은 비가역 해시로 갱신 (JUD-C #129980 mustFix ①)', () => {
    const db = freshDb();
    const lessonText = 'r6 무적격 이관 회귀: 단일 자리만 재유입돼도 과거 평문 키 승격 행이 비가역 해시로 갱신된다';
    const legacyKey = lessonIdentityKey(lessonText);
    const legacyRowId = recordEvent(db, {
      surface: 'memory', direction: 'inbound', kind: 'cross-seat-lesson',
      // 시드 본문에는 평문 키를 넣지 않는다 — FTS 검색 인덱스는 본문 기반이라 키가 본문에 박히면
      // 이관과 무관하게 검색에 남는다(fts 이관 검증은 ⑨가 담당).
      text: `[자리 교차 교훈 · A·B · 2건]\n요약: r6 무적격 이관 — 과거 평문 키 승격 행\n출처: seat:A#legacy-r6-a@2026-11-21T10:00:00Z, seat:B#legacy-r6-b@2026-11-21T10:00:00Z`,
      summary: 'r6 무적격 이관 — 과거 평문 키 승격 행 — 자리 2곳 교차', importance: 6,
      tags: JSON.stringify({ seats: ['A', 'B'], occurrences: 2, lessonKey: legacyKey }), // 형식 표기 없음 = 과거 평문
      ts: '2026-11-22T06:00:00Z',
    });
    // 무적격 재료 — 같은 교훈이 «한 자리»에만 재유입(두 자리 그룹 없음 → 승격 후보 0).
    recordEvent(db, { surface: 'seat:C', direction: 'inbound', kind: 'lesson', text: lessonText, ts: '2026-11-23T10:00:00Z', refs: forgedRefs });
    const result = promoteCrossSeatLessons(db, { now: () => '2026-11-24T06:00:00Z' });
    expect(result.promoted).toBe(0);
    expect(result.singleSeat).toBe(1); // 두 자리 그룹 없음 — 승격 후보 0
    // 출처: JUD-C #129980 mustFix ① — 이관은 그룹 임계와 무관한 데이터 정합, 무적격 실행에서도 갱신.
    const migrated = db.prepare(`SELECT tags FROM events WHERE id = ?`).get(legacyRowId) as { tags: string | null };
    const tags = JSON.parse(migrated.tags ?? '{}') as { lessonKey?: string; lessonKeyFormat?: string };
    expect(tags.lessonKey).toBe(createHash('sha256').update(legacyKey).digest('hex').slice(0, 16)); // RED(수리 전): 평문 그대로
    expect(tags.lessonKeyFormat).toBe('sha256-16');
    expect(tags.lessonKey).not.toBe(legacyKey);
    // FTS 인덱스도 이관 트랙에 있다 — 평문 전체 키 잔존 0.
    const ftsDump = JSON.stringify(db.prepare(`SELECT search_text FROM events_fts WHERE id = ?`).all(legacyRowId));
    expect(ftsDump.includes(legacyKey)).toBe(false);
  });
});
