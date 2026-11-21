import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LessonLedger } from '../lessons/lesson-ledger.js';
import { sweepLessonPromotions } from './promotion-sweep.js';
import { appendClause, clauseCount, clausesPath, determineClauseId, readClauses } from './clauses.js';
import { buildKnowhowPack, fragmentFromClause } from './pack.js';

// ── MEM-LESSON-TO-KNOWHOW-PROMOTION (ROSTER-0332) ────────────────────────────────
// 완료 경계: 모의 실패 3회 → 조항 1건 생성 · 중복 0. 신호 POST-TURN-LESSON-REVIEW 는
// graphs/memory/recipes.yaml(post-turn-lesson-review)이 이 스윕 노드를 부른다.

const stateDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'knowhow-promotion-')));
const NOW = () => new Date('2026-11-21T00:00:00Z');

function recurringLedger(dir: string, recurrenceCount: number): LessonLedger {
  const ledger = new LessonLedger({ stateDir: dir, now: NOW });
  ledger.add({ id: 'same-failure', incident: 'gate hang', cause: 'timeout term', remedy: 'wall-clock kill', owner: 'TC', source: 'failure-1' });
  for (let i = 2; i <= recurrenceCount; i += 1) {
    ledger.recur('same-failure', { source: `failure-${i}`, by: 'fixture' });
  }
  return ledger;
}

describe('MEM-LESSON-TO-KNOWHOW-PROMOTION — 같은 꼴 실패 3회 → 조항 1건 · 중복 0', () => {
  test('모의 실패 3회 → 스윕이 조항 1건 생성 · 원장 승격 · 재스윕 중복 0', () => {
    const dir = stateDir();
    try {
      const ledger = recurringLedger(dir, 3);
      expect(ledger.get('same-failure').occurrence_count).toBe(3);

      const first = sweepLessonPromotions({ stateDir: dir, now: NOW });
      expect(first.scanned).toBe(1);
      expect(first.promoted).toBe(1);
      expect(first.clauses).toHaveLength(1);
      const clauseId = first.clauses[0]!.clauseId;
      expect(clauseId).toBe(determineClauseId({
        lessonId: 'same-failure', owner: 'TC', incident: 'gate hang', cause: 'timeout term', remedy: 'wall-clock kill',
      }));

      // 조항 원문 — 파일에 정확히 1건
      const file = JSON.parse(readFileSync(clausesPath(dir), 'utf8')) as { schema: number; clauses: unknown[] };
      expect(file.schema).toBe(1);
      expect(file.clauses).toHaveLength(1);
      expect(readClauses(dir)[0]).toMatchObject({
        id: clauseId, lessonId: 'same-failure', owner: 'TC', occurrences: 3, status: 'promoted',
      });
      expect(clauseCount(dir)).toBe(1);

      // 교훈 원장 행 — promoted · history 가 조항 id 를 가리킨다(팩 조항 id 결정 원장)
      const row = ledger.get('same-failure');
      expect(row.status).toBe('promoted');
      expect(row.history.map((h) => h.event)).toEqual(['add', 'recur', 'recur', 'promote']);
      expect(row.history.at(-1)).toMatchObject({ event: 'promote', detail: `knowhow:${clauseId}` });

      // 재스윕 — 이미 승격돼 후보가 아니므로 새 조항 0 · 중복 0
      const second = sweepLessonPromotions({ stateDir: dir, now: NOW });
      expect(second.scanned).toBe(0);
      expect(second.promoted).toBe(0);
      expect(second.clauses).toEqual([]);
      expect(clauseCount(dir)).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('promoteToKnowhow 재호출 — 같은 조항 id 로 중복 판정(쓰기 생략) · 조항 1건 유지', () => {
    const dir = stateDir();
    try {
      const ledger = recurringLedger(dir, 3);
      const first = ledger.promoteToKnowhow('same-failure', { by: 'fixture' });
      expect(first.duplicate).toBe(false);
      // 후보가 아니게 됐으므로 candidates 0 — 재호출은 직접 경로로
      const second = ledger.promoteToKnowhow('same-failure', { by: 'fixture' });
      expect(second.duplicate).toBe(true);
      expect(second.clause.id).toBe(first.clause.id);
      expect(clauseCount(dir)).toBe(1);
      expect(ledger.get('same-failure').status).toBe('promoted');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('3회 미달 → 스윕 승격 0 · 직접 승화는 threshold 오류', () => {
    const dir = stateDir();
    try {
      const ledger = recurringLedger(dir, 2); // add(1) + recur(1) = 2회
      const sweep = sweepLessonPromotions({ stateDir: dir, now: NOW });
      expect(sweep.scanned).toBe(1);
      expect(sweep.promoted).toBe(0);
      expect(sweep.clauses).toEqual([]);
      expect(() => ledger.promoteToKnowhow('same-failure', { by: 'fixture' }))
        .toThrow('recurrence threshold not reached: 2 < 3');
      expect(clauseCount(dir)).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('appendClause — 같은 내용 재추가 중복 0 · 승화 조항이 팩 회상에 도달', () => {
    const dir = stateDir();
    try {
      const input = { lessonId: 'same-failure', owner: 'TC', incident: 'gate hang', cause: 'timeout term', remedy: 'wall-clock kill', occurrences: 3 };
      const a = appendClause(dir, input, NOW);
      const b = appendClause(dir, { ...input, occurrences: 5 }, NOW); // 횟수만 달라도 내용 해시는 같은 id
      expect(a.duplicate).toBe(false);
      expect(b.duplicate).toBe(true);
      expect(b.clause.id).toBe(a.clause.id);
      expect(clauseCount(dir)).toBe(1);

      // 팩 연결 — 조항 → 단편 → buildKnowhowPack 정확 대상·서명 매치로 회상
      const fragment = fragmentFromClause(a.clause, { sourcePath: clausesPath(dir) });
      const pack = buildKnowhowPack([fragment], {
        target: fragment.target, signature: fragment.signature, now: Date.parse('2026-11-21T00:00:00Z'),
      });
      expect(pack.snippets.map((s) => s.id)).toEqual([a.clause.id]);
      expect(pack.omittedCount).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('원장 오류는 부재와 분리 — 파손·스키마 불일치는 전파(던짐) + 기존 원장 바이트 보존 (JUD-B HOLD 1121)', () => {
    const dir = stateDir();
    try {
      // 부재 → 빈 원장(신규 시작 허용) — 첫 승화는 파일을 새로 만든다
      expect(readClauses(dir)).toEqual([]);
      const input = { lessonId: 'l1', owner: 'TC', incident: 'i', cause: 'c', remedy: 'r', occurrences: 3 };
      expect(appendClause(dir, input, NOW).duplicate).toBe(false);
      expect(clauseCount(dir)).toBe(1);

      // JSON 파손 → appendClause·readClauses 전파 + 기존 원장 바이트 보존(덮어쓰기 없음)
      const broken = '{not json';
      writeFileSync(clausesPath(dir), broken);
      expect(() => appendClause(dir, { ...input, lessonId: 'l2' }, NOW)).toThrow();
      expect(() => readClauses(dir)).toThrow();
      expect(() => clauseCount(dir)).toThrow();
      expect(readFileSync(clausesPath(dir), 'utf8')).toBe(broken);

      // 스키마 불일치(valid JSON · clauses 없음) → 전파 + 보존
      const wrongShape = '{"schema":1,"notClauses":[]}';
      writeFileSync(clausesPath(dir), wrongShape);
      expect(() => appendClause(dir, { ...input, lessonId: 'l3' }, NOW)).toThrow();
      expect(readFileSync(clausesPath(dir), 'utf8')).toBe(wrongShape);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});