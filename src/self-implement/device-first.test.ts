import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEVICE_FIRST_STEP, ensureDeviceFirstSteps, inspectDeviceFirstGoal } from './device-first.js';
import { parseAskTargetPathHintsResult } from '../self-dev/launch-preflight-text.js';
import { declaredNewFilePaths } from './goal-new-paths.js';

test('missing device becomes a test-only first slice and feature work waits for landing', () => {
  const root = mkdtempSync(join(tmpdir(), 'device-first-'));
  try {
    const goal = '대상 경로: src/feature.ts · 완료 경계 증거 명령: bun test src/feature.test.ts\n필요한 장치: fault-synthetic';
    const { steps, decision } = ensureDeviceFirstSteps(goal, ['대상 경로: src/feature.ts · 동작: 구현'], root);
    expect(decision).toMatchObject({ required: true, exists: false, device: 'src/ux-sim/fault-synthetic.ts' });
    expect(steps[0]).toContain(DEVICE_FIRST_STEP);
    expect(steps[0]).toContain('신설: src/ux-sim/fault-synthetic.ts · src/ux-sim/fault-synthetic.test.ts');
    expect(steps[0]!.split('\n')[0]).toBe('신설: src/ux-sim/fault-synthetic.ts · src/ux-sim/fault-synthetic.test.ts');
    expect(steps[0]).not.toContain('대상 경로: src/feature.ts');
    expect(declaredNewFilePaths(steps[0]!)).toEqual(['src/ux-sim/fault-synthetic.ts', 'src/ux-sim/fault-synthetic.test.ts']);
    expect(steps[0]).toContain('운영 코드 변경 0');
    expect(steps[1]).toContain(`선행: ${DEVICE_FIRST_STEP} 조각 착지 뒤 발사`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('existing named device is reused by the first test slice', () => {
  const root = mkdtempSync(join(tmpdir(), 'device-first-'));
  try {
    mkdirSync(join(root, 'src/ux-sim'), { recursive: true });
    writeFileSync(join(root, 'src/ux-sim/fake-llm.ts'), 'export const fake = true;\n');
    const goal = '대상 경로: src/feature.ts · 완료 경계 증거 명령: bun test src/feature.test.ts\n쓸 장치: fake-llm';
    expect(inspectDeviceFirstGoal(goal, root)).toMatchObject({ required: true, exists: true });
    const steps = ensureDeviceFirstSteps(goal, ['대상 경로: src/feature.ts · 동작: 구현'], root).steps;
    expect(steps[0]!.split('\n')[0]).toBe('대상 경로: src/ux-sim/fake-llm.ts');
    expect(steps[0]).toContain('신설: src/ux-sim/fake-llm.test.ts');
    expect(declaredNewFilePaths(steps[0]!)).toEqual(['src/ux-sim/fake-llm.test.ts']);
    expect(steps[0]).toContain('기존 src/ux-sim/fake-llm.ts');
    expect(steps[0]).not.toContain('필요한 mock 장치');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ordinary decomposition and an already staged plan are stable', () => {
  const goal = '대상 경로: src/feature.ts · 동작: 구현';
  expect(ensureDeviceFirstSteps(goal, ['기존 단계'], '/tmp').steps).toEqual(['기존 단계']);
  const staged = `대상 경로: src/ux-sim/fake-llm.test.ts · 동작: ${DEVICE_FIRST_STEP}`;
  const stagedPlan = ensureDeviceFirstSteps(`${goal}\n완료 경계 증거 명령: bun test src/feature.test.ts`, [staged, '피처'], '/tmp').steps;
  expect(stagedPlan[0]).toContain('완료 경계 증거 명령: bun test src/ux-sim/fake-llm.test.ts');
  expect(stagedPlan[1]).toContain('검증 계획(TDD):');
  const predecessor = `선행: ${DEVICE_FIRST_STEP} 조각 착지 뒤 발사`;
  const reordered = ensureDeviceFirstSteps(`${goal}\n장치 우선`, [`피처\n${predecessor}`], '/tmp').steps;
  expect(reordered).toEqual([`피처\n${predecessor}`]);
  const moved = ensureDeviceFirstSteps(`${goal}\n장치 우선`, ['피처', staged], '/tmp').steps;
  expect(moved).toHaveLength(2);
  expect(moved[0]).toContain('신설: src/ux-sim/fake-llm.ts · src/ux-sim/fake-llm.test.ts');
  expect(moved[0]).toContain('완료 경계 증거 명령: bun test src/ux-sim/fake-llm.test.ts');
  expect(moved[1]).toContain(predecessor);
});

test('a generic TDD goal without a named device goes straight to the feature slice', () => {
  const goal = '대상 경로: src/release-loop/resume.ts\n검증 계획(TDD): RED → GREEN';
  expect(inspectDeviceFirstGoal(goal, '/tmp').required).toBe(false);
  expect(ensureDeviceFirstSteps(goal, ['대상 경로: src/release-loop/resume.ts · 동작: 구현'], '/tmp').steps)
    .toEqual(['대상 경로: src/release-loop/resume.ts · 동작: 구현']);
});

test('an invalid planner device leaves no stranded device predecessor', () => {
  const goal = '대상 경로: src/index.ts · 검증 계획(TDD): RED → GREEN';
  const steps = ensureDeviceFirstSteps(goal, [
    `대상 경로: src/ux-sim/index-device.tsx · 동작: ${DEVICE_FIRST_STEP}`,
    `대상 경로: src/index.ts · 동작: 기능 구현\n선행: ${DEVICE_FIRST_STEP} 조각 착지 뒤 발사`,
  ], '/tmp').steps;
  expect(steps).toEqual(['대상 경로: src/index.ts · 동작: 기능 구현']);
});

test('TDD-DEVICE-SLICE-TARGET-LINE unknown root omits an unverified device slice', () => {
  const goal = '대상 경로: src/feature.ts · 완료 경계 증거 명령: bun test src/feature.test.ts\n필요한 장치: fake-llm';
  const { steps } = ensureDeviceFirstSteps(goal, ['대상 경로: src/feature.ts · 동작: 구현']);
  expect(steps).toEqual(['대상 경로: src/feature.ts · 동작: 구현']);
  const parsed = parseAskTargetPathHintsResult(steps[0]!);
  expect(parsed.paths).toEqual(['src/feature.ts']);
  expect(parsed.labelMissing).toBe(false);
});

test('unknown repository root leaves device inventory unmeasured and does not create a device slice', () => {
  const goal = '대상 경로: src/feature.ts · 완료 경계 증거 명령: bun test src/feature.test.ts\n필요한 장치: fake-llm';
  const { decision, steps } = ensureDeviceFirstSteps(goal, ['대상 경로: src/feature.ts · 동작: 구현']);
  expect(decision).toMatchObject({ required: false, device: 'src/ux-sim/fake-llm.ts', inventoryMeasured: false });
  expect(steps).toEqual(['대상 경로: src/feature.ts · 동작: 구현']);
});

test('TDD-DEVICE-SLICE-CONTRACT gives the device slice its own runnable boundary and keeps feature RED to GREEN', () => {
  const root = mkdtempSync(join(tmpdir(), 'device-first-contract-'));
  try {
    const goal = '대상 경로: src/feature.ts · 완료 경계 증거 명령: bun test src/feature.test.ts\n필요한 장치: fake-llm';
    const { steps } = ensureDeviceFirstSteps(goal, ['대상 경로: src/feature.ts · 동작: 기능 구현'], root);
    const [device, feature] = steps;
    expect(device).toContain('완료 경계 코드:');
    expect(device).toContain('완료 경계 실물:');
    expect(device).toContain('완료 경계 증거 명령: bun test src/ux-sim/fake-llm.test.ts');
    expect(device).not.toContain('완료 경계 증거 명령: bun test src/feature.test.ts');
    expect(device).toContain('RED');
    expect(device).toContain('GREEN');
    expect(feature).toContain('검증 계획(TDD):');
    expect(feature).toContain('RED');
    expect(feature).toContain('GREEN');
    expect(feature).toContain('bun test src/feature.test.ts');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('TDD-DEVICE-SLICE-CONTRACT repairs a planner-provided first device stage without duplicating its boundary', () => {
  const goal = '대상 경로: src/feature.ts · 장치 우선 · 완료 경계 증거 명령: bun test src/feature.test.ts\n쓸 장치: fake-llm';
  const staged = `대상 경로: src/ux-sim/fake-llm.test.ts · 동작: ${DEVICE_FIRST_STEP}`;
  const once = ensureDeviceFirstSteps(goal, [staged, '대상 경로: src/feature.ts · 동작: 구현'], '/tmp').steps;
  const twice = ensureDeviceFirstSteps(goal, once, '/tmp').steps;
  expect(once[0]).toContain('완료 경계 증거 명령: bun test src/ux-sim/fake-llm.test.ts');
  expect(once[1]).toContain('검증 계획(TDD):');
  expect(twice).toEqual(once);
});

test('TDD-DEVICE-SLICE-CONTRACT keeps device and feature evidence separate across named paths', () => {
  const goal = '대상 경로: src/ux-sim/fake-llm.test.ts · src/feature.ts · src/feature.test.ts\n장치 우선\n필요한 장치: fake-llm';
  const steps = ensureDeviceFirstSteps(goal, [
    `대상 경로: test/fixtures/llm-device.test.ts · 동작: ${DEVICE_FIRST_STEP} · 완료 경계 증거 명령: bun test src/feature.test.ts`,
    '대상 경로: src/feature.ts · 동작: 첫 기능',
    '대상 경로: src/other.ts · 동작: 다른 기능',
  ], '/tmp').steps;
  expect(steps[0]).toContain('완료 경계 증거 명령: bun test src/ux-sim/fake-llm.test.ts');
  expect(steps[0]).toContain('규약 밖');
  expect(steps[0]).not.toContain('대상 경로: test/fixtures/llm-device.test.ts');
  expect(steps[0]).not.toContain('완료 경계 증거 명령: bun test src/feature.test.ts');
  expect(steps[1]).toContain('bun test src/feature.test.ts');
  expect(steps[1]).not.toContain('bun test src/ux-sim/fake-llm.test.ts');
  expect(steps[2]).toContain('시험 경로 미확정');
  expect(steps[2]).not.toContain('src/other.test.ts');
  expect(steps[2]).not.toContain('bun test src/feature.test.ts');
});

test('TDD-DEVICE-SLICE-CONTRACT prefers the declared evidence test to a guessed sibling', () => {
  const goal = '대상 경로: src/feature.ts · src/feature.test.ts\n완료 경계 증거 명령: bun test test/integration.test.ts\n필요한 장치: fake-llm';
  const feature = ensureDeviceFirstSteps(goal, ['대상 경로: src/feature.ts · src/feature.test.ts · 동작: 구현\n검증 계획(TDD): bun test src/feature.test.ts 또는 bun test test/integration.test.ts'], '/tmp').steps[1]!;
  expect(feature).toContain('bun test test/integration.test.ts');
  expect(/검증 계획\(TDD\):[^\n]*/u.exec(feature)?.[0]).not.toContain('bun test src/feature.test.ts');
});

test('TDD-DEVICE-SLICE-CONTRACT rejects a partial .ts match from planner .tsx stage', () => {
  const goal = '대상 경로: src/feature.ts · 장치 우선\n쓸 장치: fake-llm';
  const staged = `대상 경로: src/ux-sim/other.test.tsx · 동작: ${DEVICE_FIRST_STEP}`;
  const { decision, steps } = ensureDeviceFirstSteps(goal, [staged, '대상 경로: src/feature.ts · 동작: 구현'], '/tmp');
  expect(decision).toMatchObject({ device: 'src/ux-sim/fake-llm.ts', deviceSource: 'goal' });
  expect(steps[0]).toContain('완료 경계 증거 명령: bun test src/ux-sim/fake-llm.test.ts');
  expect(steps[0]).not.toContain('완료 경계 증거 명령: bun test src/ux-sim/other.test.ts');
});

test('TDD-DEVICE-SLICE-CONTRACT leaves tsx and mts feature test paths unguessed', () => {
  const goal = '대상 경로: src/feature.ts · 장치 우선\n필요한 장치: fake-llm';
  const steps = ensureDeviceFirstSteps(goal, [
    '대상 경로: src/screen.tsx · 동작: 화면 구현',
    '대상 경로: src/worker.mts · 동작: 워커 구현',
  ], '/tmp').steps;
  expect(steps[1]).toContain('시험 경로 미확정');
  expect(steps[1]).not.toContain('src/screen.test.ts');
  expect(steps[2]).toContain('시험 경로 미확정');
  expect(steps[2]).not.toContain('src/worker.test.ts');
});

test('TDD-DEVICE-SLICE-CONTRACT reports planner-stage source only for valid ux-sim ts paths', () => {
  const goal = '대상 경로: src/feature.ts · 장치 우선\n필요한 장치: fake-llm';
  const staged = `대상 경로: src/ux-sim/other.test.ts · 동작: ${DEVICE_FIRST_STEP}`;
  const { decision, steps } = ensureDeviceFirstSteps(goal, [staged, '대상 경로: src/feature.ts · 동작: 구현'], '/tmp');
  expect(decision).toMatchObject({ device: 'src/ux-sim/other.ts', deviceSource: 'planner-stage' });
  expect(steps[0]).toContain('완료 경계 증거 명령: bun test src/ux-sim/other.test.ts');
});

test('TDD-DEVICE-SLICE-CONTRACT does not declare unmeasured device paths as new', () => {
  const goal = '대상 경로: src/feature.ts · 장치 우선\n필요한 장치: fake-llm';
  const { steps } = ensureDeviceFirstSteps(goal, ['대상 경로: src/feature.ts · 동작: 구현']);
  expect(steps).toEqual(['대상 경로: src/feature.ts · 동작: 구현']);
  expect(ensureDeviceFirstSteps(goal, steps).steps).toEqual(steps);
});

test('TDD-DEVICE-SLICE-CONTRACT preserves clauses following an inline inherited boundary', () => {
  const goal = '대상 경로: src/feature.ts · 장치 우선\n필요한 장치: fake-llm';
  const staged = `대상 경로: src/ux-sim/fake-llm.test.ts · 동작: ${DEVICE_FIRST_STEP} · 완료 경계 증거 명령: bun test src/feature.test.ts · 경계: 주입 사건은 유지`;
  const { steps } = ensureDeviceFirstSteps(goal, [staged, '대상 경로: src/feature.ts · 동작: 구현'], '/tmp');
  expect(steps[0]).toContain('경계: 주입 사건은 유지');
  expect(steps[0]).not.toContain('완료 경계 증거 명령: bun test src/feature.test.ts');
});

test('TDD-DEVICE-SLICE-CONTRACT retains named planner injection and verification instructions', () => {
  const goal = '대상 경로: src/feature.ts · 장치 우선\n필요한 장치: fake-llm';
  const staged = `대상 경로: src/ux-sim/fake-llm.test.ts · 동작: ${DEVICE_FIRST_STEP} 실패 응답을 생산 호출에 주입 · 완료 경계 증거 명령: bun test src/feature.test.ts · 검증: 호출 횟수 1회를 단언\n관측: 실패 사건 이름을 기록`;
  const { steps } = ensureDeviceFirstSteps(goal, [staged, '대상 경로: src/feature.ts · 동작: 구현'], '/tmp');
  expect(steps[0]).toContain('실패 응답을 생산 호출에 주입');
  expect(steps[0]).toContain('검증: 호출 횟수 1회를 단언');
  expect(steps[0]).toContain('관측: 실패 사건 이름을 기록');
  expect(steps[0]).not.toContain('완료 경계 증거 명령: bun test src/feature.test.ts');
});

test('TDD-DEVICE-SLICE-CONTRACT marks a later pathless feature slice as unmeasured', () => {
  const goal = '대상 경로: src/feature.ts · 장치 우선\n필요한 장치: fake-llm';
  const steps = ensureDeviceFirstSteps(goal, [
    '대상 경로: src/feature.ts · 동작: 첫 기능',
    '동작: 다음 기능',
  ], '/tmp').steps;
  expect(steps[2]).toContain('시험 경로 미확정');
  expect(steps[2]).toContain('RED');
  expect(steps[2]).toContain('GREEN');
});

test('TDD-DEVICE-SLICE-CONTRACT reports known and unmeasured feature test inventory separately', () => {
  const root = mkdtempSync(join(tmpdir(), 'device-feature-inventory-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/feature.test.ts'), "test('feature', () => {});\n");
    const goal = '대상 경로: src/feature.ts · 장치 우선\n필요한 장치: fake-llm';
    const feature = '대상 경로: src/feature.ts · 동작: 구현';
    expect(ensureDeviceFirstSteps(goal, [feature], root).steps[1]).toContain('기존 시험');
    expect(ensureDeviceFirstSteps(goal, [feature]).steps).toEqual([feature]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
