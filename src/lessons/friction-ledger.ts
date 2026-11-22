import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import type { LessonLedgerOptions } from './lesson-ledger.js';

export type FrictionActor = 'OP' | 'TC' | 'MK' | 'UX' | 'ceo' | 'person';
export type FrictionKind = 'hand-step' | 'ceo-correction' | 'repeat-question';

export const FRICTION_ACTORS: readonly FrictionActor[] = ['OP', 'TC', 'MK', 'UX', 'ceo', 'person'];
export const FRICTION_KINDS: readonly FrictionKind[] = ['hand-step', 'ceo-correction', 'repeat-question'];
export const FRICTION_CANDIDATE_MIN = 3;

export interface FrictionRecordInput {
  actor: FrictionActor;
  kind: FrictionKind;
  signature: string;
  note?: string;
  ref: string;
}

export interface FrictionRow {
  id: number;
  actor: FrictionActor;
  kind: FrictionKind;
  signature: string;
  note: string;
  ref: string;
  recorded_at: string;
}

export interface FrictionCandidate {
  kind: FrictionKind;
  signature: string;
  count: number;
  firstAt: string;
  lastAt: string;
  /** r17b — 승격 friction 행의 note(요약 줄). 관측 메모리가 아닌 승격 행만 노출하므로 원본 원문은 실리지 않는다. */
  note: string;
  refs: string[];
}

export class FrictionInputError extends Error {
  override name = 'FrictionInputError';
}

/** Secret-shaped note bodies are never persisted: a token or key would be copied into the ledger. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/u,
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/u,
  /AKIA[0-9A-Z]{12,}/u,
  /xox[bapr]-[A-Za-z0-9-]{8,}/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b[0-9a-f]{32,}\b/u,
  /\b[A-Za-z0-9+/=_-]{40,}\b/u,
  /(?:api[_-]?key|access[_-]?key|token|secret|password)\s*[:=]\s*\S{8,}/iu,
];

function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new FrictionInputError(`${field} is required`);
  return value.trim();
}

function checkActor(value: FrictionActor): FrictionActor {
  if (!FRICTION_ACTORS.includes(value)) throw new FrictionInputError(`actor must be one of ${FRICTION_ACTORS.join(', ')}`);
  return value;
}

function checkKind(value: FrictionKind): FrictionKind {
  if (!FRICTION_KINDS.includes(value)) throw new FrictionInputError(`kind must be one of ${FRICTION_KINDS.join(', ')}`);
  return value;
}

/** Same hand step spelled differently is the same hand step: lower case, whitespace runs folded to one space. */
function normalizeSignature(value: unknown): string {
  const signature = required(value, 'signature').replace(/\s+/gu, ' ').toLowerCase();
  if (!signature) throw new FrictionInputError('signature is required');
  return signature;
}

export function frictionActor(name: string): FrictionActor {
  const key = name.trim().toLowerCase();
  return FRICTION_ACTORS.find(actor => actor.toLowerCase() === key) ?? 'person';
}

function secretFreeNote(note: unknown): string {
  const text = note === undefined || note === null ? '' : String(note);
  if (SECRET_PATTERNS.some(pattern => pattern.test(text))) throw new FrictionInputError('note looks like a secret (token or key)');
  return text;
}

export class FrictionLedger {
  readonly path: string;
  private readonly now: () => Date;

  constructor(options: LessonLedgerOptions = {}) {
    this.path = join(options.stateDir ?? elanousStateRoot(), 'lessons', 'friction.sqlite');
    this.now = options.now ?? (() => new Date());
  }

  private open(): Database {
    mkdirSync(dirname(this.path), { recursive: true });
    const db = new Database(this.path, { create: true, strict: true });
    try {
      chmodSync(this.path, 0o600);
      db.exec('PRAGMA busy_timeout = 10000');
      db.exec('PRAGMA journal_mode = WAL');
      db.exec(`CREATE TABLE IF NOT EXISTS friction (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL CHECK(actor IN ('OP','TC','MK','UX','ceo','person')),
        kind TEXT NOT NULL CHECK(kind IN ('hand-step','ceo-correction','repeat-question')),
        signature TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', ref TEXT NOT NULL, recorded_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS friction_group ON friction (kind, signature);
        CREATE TABLE IF NOT EXISTS fired (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          actor TEXT NOT NULL, signal TEXT NOT NULL, signature TEXT NOT NULL, ref TEXT NOT NULL, recorded_at TEXT NOT NULL,
          capped INTEGER NOT NULL DEFAULT 1);
        CREATE INDEX IF NOT EXISTS fired_day ON fired (recorded_at);
        CREATE TABLE IF NOT EXISTS observation (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          actor TEXT NOT NULL, signature TEXT NOT NULL, ref TEXT NOT NULL, recorded_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS observation_sig ON observation (signature);`);
      // 기존 fired 표(신규 칸 없던 판) 마이그레이션 — 이미 있으면 조용히 넘어간다(r7 · Terra mustFix ⑤).
      try { db.exec('ALTER TABLE fired ADD COLUMN capped INTEGER NOT NULL DEFAULT 1'); } catch { /* column already exists */ }
      // r10 — fired_actor_day 인덱스는 capped 열 추가 «뒤» 에 생성(구식 DB에서 열 없는 인덱스 생성 즉사 방지 · Terra mustFix ⑤ 재지적).
      db.exec('CREATE INDEX IF NOT EXISTS fired_actor_day ON fired (actor, capped, recorded_at)');
      return db;
    } catch (error) { db.close(); throw error; }
  }

  private using<T>(work: (db: Database) => T): T {
    const db = this.open();
    try { return work(db); } finally { db.close(); }
  }

  record(input: FrictionRecordInput): FrictionRow {
    const actor = checkActor(input.actor);
    const kind = checkKind(input.kind);
    const signature = normalizeSignature(input.signature);
    const note = secretFreeNote(input.note);
    const ref = required(input.ref, 'ref');
    return this.using(db => {
      const at = this.now().toISOString();
      const inserted = db.query('INSERT INTO friction (actor, kind, signature, note, ref, recorded_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(actor, kind, signature, note, ref, at);
      const row = db.query('SELECT id, actor, kind, signature, note, ref, recorded_at FROM friction WHERE id = ?')
        .get(Number(inserted.lastInsertRowid)) as FrictionRow | null;
      if (!row) throw new FrictionInputError('friction row was not stored');
      debug.log('lessons.friction', 'record', { id: row.id, kind: row.kind, actor: row.actor });
      return row;
    });
  }

  /**
   * Same hand step three times is a proposal candidate (§4⑤ SELF-PROPOSE-BASE), not one-off noise.
   * r16 — Terra r15b ④: 후보 «자격» 은 관측 이력(`observation` 표)의 누적 관측 수가 정한다 —
   * 실제 오류 2회가 `candidates(2)` 에 도달한다(반복 오류 2회 문턱 복원). 노출되는 count·refs 는
   * 승격된 friction 행만 세므로(이중계상 0), 요약 없는 관측이 후보로 새어 나가지 않고 기존
   * repeat-question 행의 횟수·refs 도 유지된다(r11 [2][3]과 양립).
   */
  candidates(min: number = FRICTION_CANDIDATE_MIN): FrictionCandidate[] {
    if (!Number.isInteger(min) || min < 1) throw new FrictionInputError('min must be a positive integer');
    return this.using(db => {
      // r16 — Terra r15b ④: 후보 «자격» 은 friction 행 수와 관측 이력(`observation` 표) 수의
      // max 로 판정 — 실제 오류 관측 2회가 승격 행 1건만 있어도 candidates(2) 에 도달한다(반복
      // 오류 2회 문턱 복원). 노출되는 count·refs 는 승격 friction 행만 세므로 이중계상 0이고,
      // 요약 없는/상한 컷 관측은 friction 행이 없어 그룹 자체가 생기지 않는다(r11 [2][3] 유지).
      // 직접 포착(사람 교정·리뷰 must)은 관측 표 없이 friction 행 수만으로 자격(기존 계약).
      const groups = db.query(`SELECT f.kind AS kind, f.signature AS signature, count(*) AS count, min(f.recorded_at) AS firstAt, max(f.recorded_at) AS lastAt,
          max(count(*), coalesce((SELECT count(*) FROM observation o WHERE o.signature = f.signature), 0)) AS eligibility
        FROM friction f GROUP BY f.kind, f.signature
        HAVING max(count(*), coalesce((SELECT count(*) FROM observation o WHERE o.signature = f.signature), 0)) >= ?
        ORDER BY count DESC, lastAt DESC, kind, signature`).all(min) as (Omit<FrictionCandidate, 'refs' | 'note'> & { eligibility: number })[];
      return groups.map(group => ({
        kind: group.kind,
        signature: group.signature,
        count: group.count,
        firstAt: group.firstAt,
        lastAt: group.lastAt,
        // r17b — 같은 서명의 승격 friction 행이 여럿이면 가장 최근 note(요약 줄)를 노출한다.
        note: (db.query('SELECT note FROM friction WHERE kind = ? AND signature = ? ORDER BY id DESC LIMIT 1')
          .get(group.kind, group.signature) as { note: string }).note,
        refs: (db.query('SELECT ref FROM friction WHERE kind = ? AND signature = ? ORDER BY id')
          .all(group.kind, group.signature) as { ref: string }[]).map(row => row.ref),
      }));
    });
  }

  /**
   * POST-TURN-LESSON-REVIEW r4 — 하루 상한(5) 판정·«후보 없음» 검증용: 같은 날(YYYY-MM-DD)에 기록된 행 수.
   * excludeNotePrefix(예: 'observation:')를 주면 관측 메모리 행을 빼고 «후보 행» 만 센다.
   */
  countOnDate(day: string, excludeNotePrefix = ''): number {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) throw new FrictionInputError('day must be YYYY-MM-DD');
    const next = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
    return this.using(db => {
      const sql = excludeNotePrefix
        ? 'SELECT count(*) AS c FROM friction WHERE recorded_at >= ? AND recorded_at < ? AND note NOT LIKE ?'
        : 'SELECT count(*) AS c FROM friction WHERE recorded_at >= ? AND recorded_at < ?';
      const row = excludeNotePrefix
        ? db.query(sql).get(day, next, `${excludeNotePrefix}%`) as { c: number } | null
        : db.query(sql).get(day, next) as { c: number } | null;
      return row?.c ?? 0;
    });
  }

  /**
   * POST-TURN-LESSON-REVIEW r5 — 발화한 신호 1건을 `fired` 표에 남긴다(하루 상한의 내구 메모리).
   * friction 표의 관측 행(`observation:` 노트)·후보 행과 달리, 이 표는 «언제 몇 번 발화했나» 만 담는다 —
   * 0-줄 후보(요약 줄 없는 발화)도 상한에 정확히 반영되도록 분리했다(r4 는 후보 행 수로 상한을 재려다
   * 0-줄 발화가 흔적을 안 남겨 스캔 간 상한이 유지되지 않았다 — minim5 r5 RED T2).
   */
  recordFired(input: { actor: FrictionActor; signal: string; signature: string; ref: string; capped?: boolean }): string {
    const at = this.now().toISOString();
    const capped = input.capped === false ? 0 : 1;
    this.using(db => {
      db.query('INSERT INTO fired (actor, signal, signature, ref, recorded_at, capped) VALUES (?, ?, ?, ?, ?, ?)')
        .run(input.actor, input.signal, input.signature, input.ref, at, capped);
    });
    return at;
  }

  /** POST-TURN-LESSON-REVIEW r5 — 같은 날 발화 수(하루 상한 5 판정). 날짜 전환 시 자연 리셋. r7: actor별 상한(mustFix ⑤). */
  countFiredOn(day: string, actor?: FrictionActor): number {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) throw new FrictionInputError('day must be YYYY-MM-DD');
    const next = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
    return this.using(db => {
      const sql = actor
        ? 'SELECT count(*) AS c FROM fired WHERE capped = 1 AND actor = ? AND recorded_at >= ? AND recorded_at < ?'
        : 'SELECT count(*) AS c FROM fired WHERE capped = 1 AND recorded_at >= ? AND recorded_at < ?';
      const row = (actor
        ? db.query(sql).get(actor, day, next)
        : db.query(sql).get(day, next)) as { c: number } | null;
      return row?.c ?? 0;
    });
  }

  /**
   * POST-TURN-LESSON-REVIEW r7 — 하루 상한 판정과 예약을 «원자적으로» 묶는다(Terra mustFix ②⑥).
   * BEGIN IMMEDIATE 트랜잭션에서 [오늘 상한 대상 발화 수 조회 → fired 행 INSERT] 를 수행 —
   * 동시 호출이 같은 잔여량을 보고 모두 발화하는 경합을 차단한다. 예외(human:remember 등)는
   * capped=0으로 기록되어 상한 집계에서 제외된다(⑤).
   */
  reserveFiredOrNone(input: { actor: FrictionActor; signal: string; signature: string; ref: string; humanPinned?: boolean; cap?: number }): { reserved: boolean; firedToday: number } {
    const at = this.now().toISOString();
    const day = at.slice(0, 10);
    const next = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
    const cap = input.cap ?? Number.POSITIVE_INFINITY;
    return this.using(db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.query('SELECT count(*) AS c FROM fired WHERE capped = 1 AND actor = ? AND recorded_at >= ? AND recorded_at < ?')
          .get(input.actor, day, next) as { c: number } | null;
        const firedToday = row?.c ?? 0;
        if (!input.humanPinned && firedToday >= cap) {
          db.exec('ROLLBACK');
          return { reserved: false, firedToday };
        }
        db.query('INSERT INTO fired (actor, signal, signature, ref, recorded_at, capped) VALUES (?, ?, ?, ?, ?, ?)')
          .run(input.actor, input.signal, input.signature, input.ref, at, input.humanPinned ? 0 : 1);
        db.exec('COMMIT');
        return { reserved: true, firedToday };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
  }

  /** r7 — 관측 이력(`observation` 표) 기록: 후보 승격 대상과 분리된 «무슨 일이 있었나» (Terra mustFix ④). */
  recordObservation(input: { actor: FrictionActor; signature: string; ref: string }): string {
    const at = this.now().toISOString();
    this.using(db => {
      db.query('INSERT INTO observation (actor, signature, ref, recorded_at) VALUES (?, ?, ?, ?)')
        .run(input.actor, input.signature, input.ref, at);
    });
    return at;
  }

  /** r7 — 같은 서명 누적 관측 수(턴 간 «같은 오류 2회» 검출의 메모리). */
  countObservations(signature: string): number {
    return this.using(db => {
      const row = db.query('SELECT count(*) AS c FROM observation WHERE signature = ?').get(signature) as { c: number } | null;
      return row?.c ?? 0;
    });
  }
}
