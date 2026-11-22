/**
 * POST-TURN-LESSON-REVIEW · SIGNAL-TRIGGERED-LESSON-CAPTURE (0.3.33 · ROSTER-0333-60 #1)
 * — 원장 신호(사람 교정 · 리뷰 must-fix · 같은 오류 2회)가 도착하는 즉시 교훈 후보가 원장에 잡히는가.
 *
 * 현행 실측(2026-11-22 조사 · origin/main d781cb79433): 신호 발화부 3종(write-gate 교정 ·
 * review-result-capture mustFix · friction 같은 꼴 2회) 어디서도 LessonLedger/FrictionLedger 로
 * 연결되지 않는다 — `grep -rn "memory.signal.batch" src/` = 0건. 포착 게이트 = 사람 CLI + 일일 cron뿐.
 * 이 시험은 그 배선이 «있어야» 통과한다(빨강-먼저: 지금 main 은 실패해야 한다).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LessonLedger } from './lesson-ledger.js';
import { FrictionLedger } from './friction-ledger.js';
import { emitLessonSignal, LESSON_SIGNAL_KINDS, type LessonSignalInput } from './lesson-signal-capture-core.js';
// r16b — 간섭 래칫(body-dynamic-import) 처방대로 시험 본문 동적 import 대신 정적 import.
import { persistReviewedResult } from '../agent-substrate/self-review-cli.js';
// r17 — JUD-C #128647: must-fix 원문 → 값싼 모델 요약자 입력(evidenceText) 배선 단언.
import { emitReviewMustFixSignal, type TurnSignalAsyncOptions } from './lesson-turn-signals.js';

function freshStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'lesson-signal-'));
}

describe('SIGNAL-TRIGGERED-LESSON-CAPTURE — signal wiring', () => {
  test('exports the three ledger-signal kinds (human-correction · review-mustfix · repeat-error-2)', () => {
    expect(LESSON_SIGNAL_KINDS).toEqual(['human-correction', 'review-mustfix', 'repeat-error-2']);
  });

  test('a human-correction signal records a friction row immediately (no CLI · no cron)', () => {
    const stateDir = freshStateDir();
    const out = emitLessonSignal({ stateDir }, { kind: 'human-correction', actor: 'OP', signature: 'mail:request:wrong-branch', ref: '#125570' });
    expect(out.recorded).toBe(1);
    const rows = new FrictionLedger({ stateDir }).candidates(1);
    expect(rows.length).toBeGreaterThan(0); // 출처: #125528 (원장 신호 즉시 포착 완료선)
    expect(rows[0]!.kind).toBe('ceo-correction');
    expect(rows[0]!.refs).toContain('#125570');
  });

  test('a review-mustfix signal records a friction row with review signature (review:rule:pattern)', () => {
    const stateDir = freshStateDir();
    const out = emitLessonSignal({ stateDir }, { kind: 'review-mustfix', actor: 'OP', signature: 'review:missing-source-comment', ref: 'pr-39493-r2' });
    expect(out.recorded).toBe(1);
    expect(new FrictionLedger({ stateDir }).candidates(1).length).toBeGreaterThan(0); // 출처: #125528
  });

  test('same repeat-error signature twice reaches the candidate threshold immediately (2 < default 3)', () => {
    const stateDir = freshStateDir();
    emitLessonSignal({ stateDir }, { kind: 'repeat-error-2', actor: 'person', signature: 'tool:bash:enoent', ref: 'capsule-1' });
    const second = emitLessonSignal({ stateDir }, { kind: 'repeat-error-2', actor: 'person', signature: 'tool:bash:enoent', ref: 'capsule-2' });
    expect(second.recorded).toBe(1);
    const candidates = new FrictionLedger({ stateDir }).candidates(2);
    expect(candidates.length).toBeGreaterThan(0); // 출처: #125528 («같은 오류 2회» 완료선)
    expect(candidates[0]!.count).toBe(2);
  });

  test('a captured candidate with a remedy becomes a lesson candidate row via recur (no CLI)', () => {
    const stateDir = freshStateDir();
    const lessons = new LessonLedger({ stateDir, now: () => new Date('2026-11-22T06:00:00Z') });
    lessons.add({ id: 'L-sig-1', incident: 'usage-row bounds had no provenance comment', cause: 'NUMGUARD sourceComment pattern miss', remedy: 'prepend 출처: #NNNN', owner: 'MVP-B', source: 'docs/conductor/MEMORY-SIGNALS.md' });
    const out = emitLessonSignal({ stateDir, lessonId: 'L-sig-1' }, { kind: 'review-mustfix', actor: 'OP', signature: 'review:numguard:provenance', ref: 'pr-39493-r1' });
    expect(out.recurred).toBe(true); // 출처: #125528
    expect(lessons.get('L-sig-1').status).toBe('candidate');
    expect(lessons.get('L-sig-1').occurrence_count).toBe(2);
  });

  test('fail-soft: a signal with an unknown lessonId must not throw (ledger stays usable)', () => {
    const stateDir = freshStateDir();
    const out = emitLessonSignal({ stateDir, lessonId: 'L-nope' }, { kind: 'review-mustfix', actor: 'OP', signature: 'review:x:y', ref: 'pr-1' });
    expect(out.recurred).toBe(false); // 출처: #125528
    expect(out.recorded).toBe(1);
  });
});

describe('SIGNAL-TRIGGERED-LESSON-CAPTURE r16 — 리뷰 저장 진입점 통합 (Terra r15b ①)', () => {
  test('persistReviewedResult: must-fix ≥1 저장 → fired·friction 원장 행(실제 진입점 → 원장 행)', async () => {
    const stateDir = freshStateDir();
    const resultPath = join(stateDir, 'review-result.json');
    const head = 'a1b2c3d4e5'.repeat(4); // 40자 가짜 헤드
    await persistReviewedResult({
      enriched: { headCommit: head, currentHeadCommit: head, stale: false },
      pinnedHead: head, pr: 39500, canonicalResultPath: resultPath,
      normalized: { result: { pr: 39500, head, mustFix: ['NUMGUARD 출처 주석 형식 미준수'] }, count: 1 },
      lessonOptions: { stateDir },
    });
    const ledger = new FrictionLedger({ stateDir });
    const today = new Date().toISOString().slice(0, 10);
    expect(ledger.countFiredOn(today, 'person')).toBe(1); // 발화 흔적 — 실제 리뷰 저장 경로에서 도달
    const sig = `review:39500:${head.slice(0, 10)}`;
    const promoted = ledger.candidates(1).find(r => r.signature === sig);
    expect(promoted).toBeDefined(); // must-fix 리뷰 1건 = 원장 후보 행 1건(서명 PR+헤드)
    expect(promoted!.refs).toContain('pr-39500');
  });

  test('persistReviewedResult: must-fix 0건 리뷰는 신호를 발화하지 않는다', async () => {
    const stateDir = freshStateDir();
    const resultPath = join(stateDir, 'review-result.json');
    const head = 'f6e5d4c3b2'.repeat(4);
    await persistReviewedResult({
      enriched: { headCommit: head, currentHeadCommit: head, stale: false },
      pinnedHead: head, pr: 39501, canonicalResultPath: resultPath,
      normalized: { result: { pr: 39501, head, mustFix: [] }, count: 0 },
      lessonOptions: { stateDir },
    });
    const ledger = new FrictionLedger({ stateDir });
    const today = new Date().toISOString().slice(0, 10);
    expect(ledger.countFiredOn(today, 'person')).toBe(0); // 클린 리뷰 — 발화 0
  });
});

describe('SIGNAL-TRIGGERED-LESSON-CAPTURE r17 — must-fix 원문 → 값싼 모델 요약 입력 (JUD-C #128647)', () => {
  const head = '1aef2a9b1c'.repeat(4); // 40자 가짜 헤드

  test('persistReviewedResult: 구체적 must-fix 원문이 요약자 evidenceText 로 전달되고 원장 행·서명에는 남지 않는다', async () => {
    const stateDir = freshStateDir();
    const resultPath = join(stateDir, 'review-result.json');
    const captured: Array<LessonSignalInput & { evidenceText?: string }> = [];
    const line = '다음에도 지킬 것: 리뷰 must-fix 항목을 교훈 요약 입력에 그대로 전달한다.';
    const lessonOptions: TurnSignalAsyncOptions = {
      stateDir,
      summarizer: (signal) => { captured.push(signal); return line; },
    };
    await persistReviewedResult({
      enriched: { headCommit: head, currentHeadCommit: head, stale: false },
      pinnedHead: head, pr: 39500, canonicalResultPath: resultPath,
      normalized: { result: { pr: 39500, head, mustFix: ['NUMGUARD 출처 주석 형식 미준수', 'Rows 타일 유실'] }, count: 0 },
      lessonOptions,
    });
    // 종단: 저장 진입점 → collectSignals → 요약자 — 원문이 요약자 입력에 실린다
    expect(captured.length).toBe(1); // 출처: #128647
    expect(captured[0]!.kind).toBe('review-mustfix'); // 출처: #128647
    expect(captured[0]!.evidenceText).toContain('NUMGUARD 출처 주석 형식 미준수'); // 출처: #128647
    expect(captured[0]!.evidenceText).toContain('Rows 타일 유실'); // 출처: #128647
    expect(captured[0]!.signature).toBe(`review:39500:${head.slice(0, 10)}`); // 출처: #128647
    // 원장 후보 행 — note 는 요약 줄이고 must-fix 원문은 원장에 저장되지 않는다
    const row = new FrictionLedger({ stateDir }).candidates(1).find(r => r.signature === captured[0]!.signature);
    expect(row).toBeDefined(); // 출처: #128647
    expect(row!.note).toBe(line); // 출처: #128647
    expect(row!.note).not.toContain('NUMGUARD 출처 주석 형식 미준수'); // 출처: #128647
    // 저장된 리뷰 결과 파일 — 원문은 정본(canonical) 에 보존된다
    const saved = JSON.parse(await Bun.file(resultPath).text());
    expect(Array.isArray(saved.mustFix)).toBe(true); // 출처: #128647
    expect(saved.mustFix).toContain('NUMGUARD 출처 주석 형식 미준수'); // 출처: #128647
  });

  test('emitReviewMustFixSignal: 비문자열 제외·공백 접기·항목 200자·전체 500자 안전 절단', async () => {
    const stateDir = freshStateDir();
    const captured: Array<LessonSignalInput & { evidenceText?: string }> = [];
    const long = '아'.repeat(300);
    await emitReviewMustFixSignal(
      { stateDir, summarizer: (signal) => { captured.push(signal); return '한 줄 교훈'; } },
      39500, head,
      [long, '  whitespace   fold  ', 42, ''],
    );
    expect(captured.length).toBe(1); // 출처: #128647
    const evidence = captured[0]!.evidenceText ?? '';
    expect(evidence.length).toBeLessThanOrEqual(500); // 출처: #128647
    expect(evidence.split('\n')[0]).toBe('아'.repeat(200)); // 출처: #128647 — 항목 200자 절단
    expect(evidence).toContain('whitespace fold'); // 출처: #128647 — 공백 접기
    expect(evidence).not.toContain('42'); // 출처: #128647 — 비문자열·빈 항목 제외
  });
});
