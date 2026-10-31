// ⭐ TDD-AS-LOGIC 회귀 시험 — «쪼개기·TDD 가 로직에 박혀 있나»(대표 10-26 20:5x) 에 대한
//   RED(구현 전 실패)→GREEN(구현 뒤 같은 명령 통과) 기록을 로직으로 요구하는 회귀 시험.
import { test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessTddBaseHeadTest, judgeTddEvidence, tddPlanFromGoal, parseOffDiffEvidence, receiveObservedTddRed, receiveObservedTddGreen, runTddBaseHeadTest } from './off-diff-evidence.js';
import { classifyAbandonedRun } from './abandoned-classification.js';
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

test('실제 child tool output은 계획된 같은 시험의 PASS만 tdd-green 원장 기록으로 받아 적는다', () => {
  const transcript = readFileSync(new URL('./fixtures/tdd-green-missing-passing-child-transcript.txt', import.meta.url), 'utf8');
  const redOnly = parseOffDiffEvidence(`${redRecord}\n`);
  const greenMissing = judgeTddEvidence(goalWithTddPlan, redOnly);
  expect(greenMissing.missing).toEqual(['tdd-green']);
  expect(receiveObservedTddGreen({ goal: goalWithTddPlan, judgment: greenMissing, transcript, resultParsed: true }))
    .toMatchObject({ accepted: false, reason: 'passing-test-command-mismatch' });
  expect(receiveObservedTddGreen({ goal: goalWithTddPlan, judgment: greenMissing, transcript, resultParsed: false }))
    .toMatchObject({ accepted: false, reason: 'child-result-unparsed' });

  const matchingOutput = `⏺ Bash({"command":"bun test -- 'src/self-implement/orchestrator-tdd-evidence.test.ts'"})\\n ↳ 9 pass 0 fail`;
  const accepted = receiveObservedTddGreen({ goal: goalWithTddPlan, judgment: greenMissing, transcript: `${redRecord}\n${matchingOutput}`, resultParsed: true });
  expect(accepted).toMatchObject({ accepted: true, reason: 'matching-test-output-recorded', result: '9 pass · 0 fail' });
  expect(judgeTddEvidence(goalWithTddPlan, parseOffDiffEvidence(accepted.transcript)).missing).toEqual([]);

  const failedAfterPass = `${redRecord}\n${matchingOutput}\\n⏺ Bash({"command":"bun test src/self-implement/orchestrator-tdd-evidence.test.ts"})\\n ↳ 1 pass 1 fail`;
  expect(receiveObservedTddGreen({ goal: goalWithTddPlan, judgment: greenMissing, transcript: failedAfterPass, resultParsed: true }))
    .toMatchObject({ accepted: false, reason: 'latest-matching-test-failed' });

  const noGreen = receiveObservedTddGreen({ goal: goalWithTddPlan, judgment: greenMissing, transcript: 'bun test completed successfully', resultParsed: true });
  expect(noGreen).toMatchObject({ accepted: false, reason: 'no-adjacent-passing-bun-test' });

  expect(classifyAbandonedRun({
    worktreePorcelain: '', stage: 'aborted', terminationReason: 'tdd-evidence-missing',
    reviewResultObserved: true, citedEvidenceExists: false,
    completionDisposition: 'completed-without-changes', mustFixReported: false,
  })).toMatchObject({
    classification: 'implementation-deficit',
    classificationBasis: 'tdd-evidence-missing',
    terminationReason: 'tdd-evidence-missing',
  });
});

test('실패·통과 도구 출력이 같은 계획 시험 순서로 있을 때만 tdd-red를 수확한다', () => {
  const judgment = judgeTddEvidence(goalWithTddPlan, parseOffDiffEvidence('구조화 TDD 기록 없음'));
  const run = (result: string) => `[child-test-output] command=${tddTestCommand}\n[child-test-result] ${result}`;
  const transcript = `${run('0 pass · 1 fail')}\n${run('9 pass · 0 fail')}`;
  const red = receiveObservedTddRed({ goal: goalWithTddPlan, judgment, transcript, resultParsed: true });
  expect(red).toMatchObject({ accepted: true, reason: 'matching-test-failure-recorded', result: '0 pass · 1 fail' });
  const withGreen = receiveObservedTddGreen({
    goal: goalWithTddPlan, judgment: judgeTddEvidence(goalWithTddPlan, parseOffDiffEvidence(red.transcript)),
    transcript: red.transcript, resultParsed: true,
  });
  expect(withGreen.accepted).toBe(true);
  expect(judgeTddEvidence(goalWithTddPlan, parseOffDiffEvidence(withGreen.transcript)).missing).toEqual([]);

  const absent = receiveObservedTddRed({ goal: goalWithTddPlan, judgment, transcript: run('9 pass · 0 fail'), resultParsed: true });
  expect(absent).toMatchObject({ accepted: false, reason: 'no-matching-failing-test-output' });
  const redWithoutGreen = receiveObservedTddRed({ goal: goalWithTddPlan, judgment, transcript: run('0 pass · 1 fail'), resultParsed: true });
  expect(redWithoutGreen).toMatchObject({ accepted: false, reason: 'no-later-matching-passing-test-output' });
  const wrongCommand = receiveObservedTddRed({
    goal: goalWithTddPlan, judgment,
    transcript: `${run('0 pass · 1 fail').replace(tddTestCommand, 'bun test src/other.test.ts')}\n${run('9 pass · 0 fail')}`,
    resultParsed: true,
  });
  expect(wrongCommand.accepted).toBe(false);
  expect(receiveObservedTddRed({ goal: goalWithTddPlan, judgment, transcript, resultParsed: false }).reason)
    .toBe('child-result-unparsed');
});

test('하니스는 변경 시험의 base 실패·head 통과만 RED/GREEN으로 기록하고 base 통과는 계속 거부한다', () => {
  const judgment = judgeTddEvidence(goalWithTddPlan, parseOffDiffEvidence('자식이 남긴 시험 원문 없음'));
  const verified = assessTddBaseHeadTest({
    command: tddTestCommand,
    baseExitCode: 1,
    baseOutput: '8 pass · 1 fail',
    headExitCode: 0,
    headOutput: '9 pass · 0 fail',
  });
  expect(verified).toMatchObject({ accepted: true, reason: 'base-red-head-green', baseResult: '8 pass · 1 fail', headResult: '9 pass · 0 fail' });
  const red = receiveObservedTddRed({ goal: goalWithTddPlan, judgment, transcript: verified.transcript!, resultParsed: true });
  expect(red).toMatchObject({ accepted: true, source: 'harness-base', result: '8 pass · 1 fail' });
  const green = receiveObservedTddGreen({
    goal: goalWithTddPlan,
    judgment: judgeTddEvidence(goalWithTddPlan, parseOffDiffEvidence(red.transcript)),
    transcript: red.transcript,
    resultParsed: true,
  });
  expect(green).toMatchObject({ accepted: true, source: 'harness-head', result: '9 pass · 0 fail' });
  expect(judgeTddEvidence(goalWithTddPlan, parseOffDiffEvidence(green.transcript)).missing).toEqual([]);

  const baseAlsoPasses = assessTddBaseHeadTest({
    command: tddTestCommand,
    baseExitCode: 0,
    baseOutput: '9 pass · 0 fail',
    headExitCode: 0,
    headOutput: '9 pass · 0 fail',
  });
  expect(baseAlsoPasses).toMatchObject({ accepted: false, reason: 'base-test-did-not-prove-red' });
  const headStillFails = assessTddBaseHeadTest({
    command: tddTestCommand,
    baseExitCode: 1,
    baseOutput: '8 pass · 1 fail',
    headExitCode: 1,
    headOutput: '8 pass · 1 fail',
  });
  expect(headStillFails).toMatchObject({ accepted: false, reason: 'head-test-did-not-pass' });
});

test('실제 base worktree에는 head의 변경 시험만 덮고, base RED·head GREEN을 수확한다', () => {
  const repo = mkdtempSync(join(tmpdir(), 'tdd-base-head-fixture-'));
  try {
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'node_modules'));
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'tdd-base-head-fixture', type: 'module' }));
    writeFileSync(join(repo, 'bun.lock'), 'fixture-lock\n');
    writeFileSync(join(repo, 'src', 'value.ts'), "export const value = 'old';\n");
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'TDD fixture'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['add', 'package.json', 'bun.lock', 'src/value.ts'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repo, stdio: 'ignore' });
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    writeFileSync(join(repo, 'src', 'value.ts'), "export const value = 'fixed';\n");
    writeFileSync(join(repo, 'src', 'value.test.ts'), [
      "import { expect, test } from 'bun:test';",
      "import { value } from './value';",
      "test('implemented behavior', () => expect(value).toBe('fixed'));",
    ].join('\n'));

    const result = runTddBaseHeadTest({
      cwd: repo,
      baseSha,
      goal: [
        '## 검증 계획 (TDD)',
        '- ③ 먼저 쓸 시험(RED): bun test src/value.test.ts',
        '- ④ GREEN 뒤 같은 명령: bun test src/value.test.ts',
      ].join('\n'),
    });
    expect(result).toMatchObject({ accepted: true, reason: 'base-red-head-green', baseResult: '0 pass · 1 fail', headResult: '1 pass · 0 fail' });
    expect(result.transcript).toContain('[harness-base-test-output] command=bun test src/value.test.ts');
    expect(result.transcript).toContain('[harness-head-test-result] 1 pass · 0 fail');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
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
  expect(orchestratorSource).toContain('runHarnessBaseTddWhenRedMissing');
  expect(orchestratorSource).toContain('runTddBaseHeadTest');
});
