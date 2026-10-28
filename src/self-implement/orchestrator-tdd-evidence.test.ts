// ⭐ TDD-AS-LOGIC 회귀 시험 — «쪼개기·TDD 가 로직에 박혀 있나»(대표 10-26 20:5x) 에 대한
//   RED(구현 전 실패)→GREEN(구현 뒤 같은 명령 통과) 기록을 로직으로 요구하는 회귀 시험.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { judgeTddEvidence, tddPlanFromGoal, parseOffDiffEvidence } from './off-diff-evidence.js';
import { ensureDeviceFirstSteps } from './device-first.js';

const goalWithTddPlan = [
  '## PROBLEM',
  '',
  '### 검증 계획(TDD)',
  '- ① 증명할 동작: 오케스트레이터가 첫 조각 커밋에 피처 시험·구현 전 실행 RED 기록을 요구한다.',
  '- ② 무대: unit · 카탈로그에 맞는 MS 없음',
  "- ③ 먼저 쓸 시험(RED): `src/self-implement/orchestrator-tdd-evidence.test.ts` › '오케스트레이터가 첫 조각 커밋에 피처 시험·구현 전 실행 RED 기록을 요구한다'",
  '- ④ GREEN 뒤 같은 명령: `bun test src/self-implement/orchestrator-tdd-evidence.test.ts` → 0 fail',
  '- ⑤ 생산 진입점 배선(MS-05): runSelfImplementInner 라운드 루프에서 호출',
  '',
  '## 불변식',
].join('\n');

const goalWithoutTddPlan = [
  '## PROBLEM',
  '완료 경계 증거 명령: bun test src/self-implement/tdd-none.test.ts',
].join('\n');

const tddTestCommand = 'bun test src/self-implement/orchestrator-tdd-evidence.test.ts';
const redRecord = [
  `EVIDENCE: [tdd-red] 구현 전 시험이 실패했다(RED) || ${tddTestCommand}`,
  'RESULT: 1 fail · 0 pass',
].join('\n');
const greenRecord = [
  `EVIDENCE: [tdd-green] 구현 뒤 같은 명령이 통과했다(GREEN) || ${tddTestCommand}`,
  'RESULT: 9 pass · 0 fail',
].join('\n');

test('tddPlanFromGoal — 골 문서의 «검증 계획(TDD)» ③/④ 문면을 읽는다', () => {
  const plan = tddPlanFromGoal(goalWithTddPlan);
  expect(plan.planned).toBe(true);
  expect(plan.redStage).toContain('orchestrator-tdd-evidence.test.ts');
  expect(plan.greenCommand).toBe(`bun test src/self-implement/orchestrator-tdd-evidence.test.ts`);
  const unplanned = tddPlanFromGoal(goalWithoutTddPlan);
  expect(unplanned.planned).toBe(false);
  expect(unplanned.redStage).toBeUndefined();
  expect(unplanned.greenCommand).toBeUndefined();
});

test('tddPlanFromGoal — device-first 조각 계획의 한 줄 TDD 문면도 계획으로 잡는다', () => {
  const plan = tddPlanFromGoal('검증 계획(TDD): 신규 시험 src/x/foo.test.ts · 피처 시험 bun test src/x/foo.test.ts를 구현 전에 RED로 확인한다.');
  expect(plan.planned).toBe(true);
  expect(plan.greenCommand).toBe('bun test src/x/foo.test.ts');
});

test('parseOffDiffEvidence — [tdd-red]/[tdd-green] 기록이 태그·명령·결과로 파싱된다', () => {
  const parsed = parseOffDiffEvidence(`${redRecord}\n${greenRecord}`);
  expect(parsed.items).toHaveLength(2);
  const [red, green] = parsed.items;
  expect(red?.verify).toBe(tddTestCommand);
  expect(red?.result).toBe('1 fail · 0 pass');
  expect(green?.verify).toBe(tddTestCommand);
  expect(green?.result).toBe('9 pass · 0 fail');
});

test('judgeTddEvidence — RED(실패 기록)·GREEN(같은 명령 통과 기록)이 갖춰지면 수리하지 않는다', () => {
  const judgment = judgeTddEvidence(goalWithTddPlan, parseOffDiffEvidence(`${redRecord}\n${greenRecord}`));
  expect(judgment.planned).toBe(true);
  expect(judgment.red.observed).toBe(true);
  expect(judgment.green.observed).toBe(true);
  expect(judgment.sameCommand).toBe(true);
  expect(judgment.missing).toEqual([]);
  expect(judgment.needsRepair).toBe(false);
});

test('judgeTddEvidence — 기록이 없으면 tdd-red/tdd-green 둘 다 결손이고 수리 라운드를 돌린다', () => {
  const judgment = judgeTddEvidence(goalWithTddPlan, parseOffDiffEvidence('작업 완료 · 증거 기록 없음'));
  expect(judgment.planned).toBe(true);
  expect(judgment.red.observed).toBe(false);
  expect(judgment.green.observed).toBe(false);
  expect(judgment.missing).toEqual(['tdd-red', 'tdd-green']);
  expect(judgment.needsRepair).toBe(true);
});

test('judgeTddEvidence — GREEN 이 다른 명령이면 tdd-green 결손이다(같은 명령이어야 한다)', () => {
  const otherGreen = greenRecord.replace(tddTestCommand, 'bun test src/x/other.test.ts');
  const judgment = judgeTddEvidence(goalWithTddPlan, parseOffDiffEvidence(`${redRecord}\n${otherGreen}`));
  expect(judgment.red.observed).toBe(true);
  expect(judgment.green.observed).toBe(true);
  expect(judgment.sameCommand).toBe(false);
  expect(judgment.missing).toEqual(['tdd-green']);
  expect(judgment.needsRepair).toBe(true);
});

test('judgeTddEvidence — RED 기록이 통과 결과면 RED 가 아니다(결손)', () => {
  const passingRed = [
    `EVIDENCE: [tdd-red] 구현 전 시험이 통과했다 || ${tddTestCommand}`,
    'RESULT: 3 pass · 0 fail',
  ].join('\n');
  const judgment = judgeTddEvidence(goalWithTddPlan, parseOffDiffEvidence(`${passingRed}\n${greenRecord}`));
  expect(judgment.red.observed).toBe(false);
  expect(judgment.missing).toContain('tdd-red');
  expect(judgment.needsRepair).toBe(true);
});

test('judgeTddEvidence — TDD 계획이 없는 골은 수리 대상이 아니다(기존 동작 보존)', () => {
  const judgment = judgeTddEvidence(goalWithoutTddPlan, parseOffDiffEvidence('증거 기록 없음'));
  expect(judgment.planned).toBe(false);
  expect(judgment.needsRepair).toBe(false);
});

test('device-first — 조각 계획이 RED→GREEN 기록 필드를 자식에게 실어 넘긴다', () => {
  const goal = [
    '완료 경계 증거 명령: bun test src/self-implement/tdd-demo.test.ts',
    '필요한 장치: src/ux-sim/tdd-demo-device.ts',
  ].join('\n');
  const { steps } = ensureDeviceFirstSteps(goal, ['· 동작: 첫 조각'], '.');
  const featureStage = steps.find((step) => step.includes('검증 계획(TDD):'));
  expect(featureStage).toBeDefined();
  expect(featureStage).toContain('TDD 기록 필드');
  expect(featureStage).toContain('[tdd-red]');
  expect(featureStage).toContain('[tdd-green]');
});

test('오케스트레이터가 첫 조각 커밋에 피처 시험·구현 전 실행 RED 기록을 요구한다', () => {
  const orchestratorSource = readFileSync(new URL('./orchestrator.ts', import.meta.url), 'utf8');
  // ⭐ 라운드 루프(runSelfImplementInner)가 TDD 를 문면이 아니라 로직으로 판정한다.
  expect(orchestratorSource).toContain('judgeTddEvidence(roundGoal,');
  // ⭐ 관측 체계에 tdd-red/tdd-green 이벤트가 박혀 있다.
  expect(orchestratorSource).toContain("observe('tdd-red'");
  expect(orchestratorSource).toContain("observe('tdd-green'");
  // ⭐ RED/GREEN 기록이 없으면 수리 라운드를 돌린다.
  expect(orchestratorSource).toContain('implementation-tdd-rework');
  expect(orchestratorSource).toContain('tdd-evidence-missing');
});