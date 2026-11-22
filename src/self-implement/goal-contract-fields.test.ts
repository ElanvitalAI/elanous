import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { goalIntakeRefusal, missingGoalContractFields, parseGoalContract } from './goal-contract-fields.js';
import { writeAuthoredGoal, type GoalAuthorDeps } from './goal-author.js';

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const FULL_CONTRACT = [
  '# 골',
  '',
  '## PROBLEM',
  '무엇이 아프다',
  '',
  '## 골 계약',
  '',
  '### 완료선',
  '- M1: ask 가 거절한다 · 증거: 시험',
  '- M2: say 가 채운다 · 증거: 시험',
  '',
  '### 범위 밖=FU',
  '- 옛 골 이관',
  '',
  '### 검증 예산',
  '- 원격 1 · pregate 1',
  '',
  '### 판정',
  '- 등급: T1 · 판정자: 1 · 보안: 불필요',
  '',
  '### 라운드 상한',
  '- r3/r5',
  '',
].join('\n');

describe('HARNESS-GOAL-INTAKE-LINT five-field contract', () => {
  test('all five present → accepted, done-line ids read structurally', () => {
    expect(goalIntakeRefusal(FULL_CONTRACT)).toBeNull();
    expect(parseGoalContract(FULL_CONTRACT)?.doneLines).toEqual([
      { id: 'M1', text: 'ask 가 거절한다', evidence: '시험' },
      { id: 'M2', text: 'say 가 채운다', evidence: '시험' },
    ]);
  });

  test('missing fields → refused with each missing field and its default', () => {
    const document = FULL_CONTRACT.replace('### 검증 예산\n- 원격 1 · pregate 1\n', '').replace('### 라운드 상한\n- r3/r5\n', '');
    expect(goalIntakeRefusal(document)).toEqual([
      'harness ask: 골 계약 칸이 빠졌다 (2/5) — `## 골 계약` 절에 아래 칸을 채운 뒤 다시 쏜다',
      '  ### 검증 예산',
      '  기본: - 원격 1 · pregate 1',
      '  ### 라운드 상한',
      '  기본: - r3/r5',
    ]);
  });

  test('no contract section → all five missing; done line without id or evidence does not count', () => {
    expect(missingGoalContractFields('# 골\n\n## PROBLEM\n본문\n')).toEqual(['완료선', '범위 밖=FU', '검증 예산', '판정', '라운드 상한']);
    const noEvidence = FULL_CONTRACT.replace('- M1: ask 가 거절한다 · 증거: 시험\n- M2: say 가 채운다 · 증거: 시험', '- ask 가 거절한다');
    expect(missingGoalContractFields(noEvidence)).toEqual(['완료선']);
  });

  test('a heading inside fenced code is not the contract section', () => {
    expect(missingGoalContractFields('# 골\n\n```\n## 골 계약\n### 완료선\n- M1: x · 증거: 시험\n```\n')).toHaveLength(5);
  });

  test('in-flight goal (has 실행 기록) keeps running without the contract', () => {
    expect(goalIntakeRefusal('# 옛 골\n\n## PROBLEM\n본문\n\n## 실행 기록\n- run 1\n')).toBeNull();
  });

  test('say authoring (writeAuthoredGoal) writes the five defaults into the goal file', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-contract-say-'));
    temporary.push(cwd);
    mkdirSync(join(cwd, 'docs', 'goals'), { recursive: true });
    const empty = { grounded: true, context: '', files: [], persistentEvidence: [], codeFacts: [], skillFacts: [], memoryFacts: [], documentFacts: [], refFacts: [], ptyFacts: [] };
    const deps: GoalAuthorDeps = {
      ground: async () => empty,
      enhance: async (raw) => ({ original: raw, checklist: [], verbatimPreserved: true }),
      slugFn: async () => 'goal-contract-say',
    };
    const result = await writeAuthoredGoal('대상 경로: src/example.ts 를 고친다', cwd, deps, { now: () => new Date('2026-11-22T00:00:00Z') });
    const written = readFileSync(result.path, 'utf8');
    const contract = parseGoalContract(written);
    expect(contract?.doneLines).toEqual([{ id: 'M1', text: '대상 경로: src/example.ts 를 고친다', evidence: '시험' }]);
    expect(contract?.fields.get('범위 밖=FU')).toBe('- 없음');
    expect(contract?.fields.get('검증 예산')).toBe('- 원격 1 · pregate 1');
    expect(contract?.fields.get('판정')).toBe('- 등급: T1 · 판정자: 1 · 보안: 불필요');
    expect(contract?.fields.get('라운드 상한')).toBe('- r3/r5');
    expect(goalIntakeRefusal(written)).toBeNull();
  });
});
