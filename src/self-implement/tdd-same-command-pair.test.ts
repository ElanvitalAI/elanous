import { expect, test } from 'bun:test';
import { judgeTddEvidence, parseOffDiffEvidence } from './off-diff-evidence.js';

const PLAN = '### 검증 계획(TDD)\n- RED: 시험 먼저\n- GREEN: `bun test src/a.test.ts`\n';

test('a same-command RED→GREEN pair wins over an earlier GREEN of another command (11-27 canary)', () => {
  const transcript = [
    'EVIDENCE: [tdd-red] 구현 전 실패 || bun test src/a.test.ts',
    'RESULT: 0 pass · 4 fail',
    'EVIDENCE: [tdd-green] 이웃 파일 전체 통과 || bun test src/b.test.ts',
    'RESULT: 108 pass, 0 fail',
    'EVIDENCE: [tdd-green] 구현 뒤 통과 || bun test src/a.test.ts',
    'RESULT: 4 pass · 0 fail',
  ].join('\n');
  const judged = judgeTddEvidence(PLAN, parseOffDiffEvidence(transcript));
  expect(judged.sameCommand).toBe(true);
  expect(judged.missing).toEqual([]);
  expect(judged.needsRepair).toBe(false);
  expect(judged.green.verify).toBe('bun test src/a.test.ts');
});

test('without a same-command pair the first records decide, as before', () => {
  const transcript = [
    'EVIDENCE: [tdd-red] 구현 전 실패 || bun test src/a.test.ts',
    'RESULT: 0 pass · 4 fail',
    'EVIDENCE: [tdd-green] 다른 파일 통과 || bun test src/b.test.ts',
    'RESULT: 108 pass, 0 fail',
  ].join('\n');
  const judged = judgeTddEvidence(PLAN, parseOffDiffEvidence(transcript));
  expect(judged.sameCommand).toBe(false);
  expect(judged.missing).toEqual(['tdd-green']);
});

test('a failing GREEN of the same command is not a pair', () => {
  const transcript = [
    'EVIDENCE: [tdd-red] 구현 전 실패 || bun test src/a.test.ts',
    'RESULT: 0 pass · 4 fail',
    'EVIDENCE: [tdd-green] 아직 실패 || bun test src/a.test.ts',
    'RESULT: 3 pass · 1 fail',
  ].join('\n');
  expect(judgeTddEvidence(PLAN, parseOffDiffEvidence(transcript)).missing).toEqual(['tdd-green']);
});

test('several RED candidates: the pair is formed with the RED whose command has a passing GREEN', () => {
  const transcript = [
    'EVIDENCE: [tdd-red] 다른 명령 실패 || bun test src/c.test.ts',
    'RESULT: 0 pass · 1 fail',
    'EVIDENCE: [tdd-red] 구현 전 실패 || bun test src/a.test.ts',
    'RESULT: 0 pass · 4 fail',
    'EVIDENCE: [tdd-green] 구현 뒤 통과 || bun test src/a.test.ts',
    'RESULT: 4 pass · 0 fail',
  ].join('\n');
  const judged = judgeTddEvidence(PLAN, parseOffDiffEvidence(transcript));
  expect(judged.red.verify).toBe('bun test src/a.test.ts');
  expect(judged.green.verify).toBe('bun test src/a.test.ts');
  expect(judged.missing).toEqual([]);
});

test('an E4 evidence cell with only a GREEN still needs nothing (RED exempt) and a pair is not required', () => {
  const transcript = 'EVIDENCE: [tdd-green] 증거 시험 통과 || bun test src/a-e4.test.ts\nRESULT: 3 pass · 0 fail\n';
  const judged = judgeTddEvidence(`- CellKind: evidence\n${PLAN}`, parseOffDiffEvidence(transcript));
  expect(judged.missing).toEqual([]);
  expect(judged.needsRepair).toBe(false);
});
