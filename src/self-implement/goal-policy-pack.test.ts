import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorGoal, wiringCriterionApplies, type GoalAuthorDeps } from './goal-author.js';
import { goalCellKind, renderGoalPolicyPackSection } from './goal-policy-pack.js';
import { judgeTddEvidence, parseOffDiffEvidence } from './off-diff-evidence.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('cell kind: explicit marker wins; E4 cell ids are evidence; everything else is implement', () => {
  expect(goalCellKind('- CellKind: evidence\nTHROUGHPUT-VETO-AWARE')).toBe('evidence');
  expect(goalCellKind('- CellKind: implement\nJUD-BUTLER-E4')).toBe('implement');
  expect(goalCellKind('JUD-BUTLER-E4 — 판정 집사 E4 증거 시험')).toBe('evidence');
  expect(goalCellKind('JUD-BUTLER — E4 sim/test-universe evidence (green signed …)')).toBe('evidence');
  expect(goalCellKind('THROUGHPUT-VETO-AWARE — HOLD 칸 제외')).toBe('implement');
  expect(goalCellKind('E4 라는 말만 있는 문장')).toBe('implement');
});

test('policy pack section carries the cell kind and the literal rules', () => {
  const section = renderGoalPolicyPackSection('evidence').join('\n');
  expect(section.startsWith('### 정책 팩\n')).toBe(true);
  expect(section).toContain('- 칸 종류: evidence (증거 시험만 — TDD RED 면제)');
  expect(section).toContain('같은 변경(head)의 영수 ⊕ 집중 시험 exit 0');
  expect(section).toContain('«범위 밖=FU» 칸으로 쪼갠다');
  expect(section).toContain('옵션·깃발·단계 스위치를 만들지 않는다');
  expect(section).toContain('보안 4종(비밀·자격 / 다른 사용자 데이터 / 원격 노출 / 파괴적 삭제)');
  expect(renderGoalPolicyPackSection('implement')[1]).toBe('- 칸 종류: implement');
});

test('an evidence cell needs only the GREEN record; an implement cell still needs RED', () => {
  const plan = '### 검증 계획(TDD)\n- RED: 시험 먼저\n- GREEN: `bun test src/a.test.ts`\n';
  const greenOnly = parseOffDiffEvidence('EVIDENCE: [tdd-green] 증거 시험 통과 || bun test src/a.test.ts\nRESULT: 3 pass 0 fail\n');
  const evidence = judgeTddEvidence(`- CellKind: evidence\n${plan}`, greenOnly);
  expect(evidence.missing).toEqual([]);
  expect(evidence.needsRepair).toBe(false);
  const implement = judgeTddEvidence(`- CellKind: implement\n${plan}`, greenOnly);
  expect(implement.missing).toEqual(['tdd-red']);
  expect(implement.needsRepair).toBe(true);
});

test('authored goal: CellKind line · policy pack section · no catalog-registration requirement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-policy-pack-'));
  roots.push(root);
  mkdirSync(join(root, 'src', 'judge-butler'), { recursive: true });
  writeFileSync(join(root, 'src', 'judge-butler', 'done-when.ts'), 'export const x = 1;\n');
  const target = 'src/judge-butler/done-when.ts';
  const deps: GoalAuthorDeps = {
    repositoryRoot: root,
    ground: async () => ({ grounded: true, context: '', files: [target], codeFacts: [], skillFacts: [], memoryFacts: [], documentFacts: [], refFacts: [], ptyFacts: [] }),
    enhance: async (original) => ({ original, checklist: ['tests never make a PR security-4'], verbatimPreserved: true }),
    slugFn: async () => 'policy-pack',
  };
  const goal = await authorGoal(`대상 경로: ${target}\n- GoalType: implement\n\nBUTLER-SEC4-SCOPE — 시험 파일은 보안 4종이 아니다`, deps);
  expect(goal.document).not.toContain('- CellKind:');
  expect(goal.document).toContain('### 정책 팩');
  expect(goal.document).not.toContain('형식에 맞춰 요청 대상의 사건·기대를 구체화해 등록한다');
  const evidenceGoal = await authorGoal(`대상 경로: ${target}\n- GoalType: implement\n\nBUTLER-SEC4-SCOPE-E4 — 증거 시험만`, deps);
  expect(evidenceGoal.document).toContain('- CellKind: evidence');
  expect(evidenceGoal.document).toContain('- 칸 종류: evidence (증거 시험만 — TDD RED 면제)');
});

test('an evidence cell never gets the production-wiring criterion', () => {
  const facts = { grounded: true, context: '', files: ['src/loops/a.ts'], codeFacts: [], skillFacts: [], memoryFacts: [], documentFacts: [], refFacts: [], ptyFacts: [] } as unknown as Parameters<typeof wiringCriterionApplies>[1];
  expect(wiringCriterionApplies('대상 경로: src/loops/a.ts\nCELL-X — 구현', facts)).toBe(true);
  expect(wiringCriterionApplies('대상 경로: src/loops/a.ts\nCELL-X-E4 — 증거 시험', facts)).toBe(false);
});
