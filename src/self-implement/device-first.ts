import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const DEVICE_FIRST_STEP = 'DEVICE-FIRST-STAGE';

export interface DeviceFirstDecision {
  required: boolean;
  device: string;
  deviceSource: 'goal' | 'planner-stage';
  exists: boolean;
  inventoryMeasured: boolean;
  firstSliceKind: 'device-test' | 'none';
}

/** Board goals carry an executable boundary. Ordinary free-form plans retain their existing decomposition. */
export function inspectDeviceFirstGoal(goal: string, root?: string): DeviceFirstDecision {
  const required = /완료\s*경계\s*증거\s*명령\s*:|검증\s*계획\s*\(TDD\)|DEVICE-FIRST|장치\s*우선/iu.test(goal)
    && /(?:src|test)\/[\w./-]+\.[cm]?[jt]sx?/u.test(goal);
  if (!required) return { required: false, device: '', deviceSource: 'goal', exists: false, inventoryMeasured: root !== undefined, firstSliceKind: 'none' };
  const explicit = /(?:쓸\s*장치|필요한\s*장치|mock\s*장치)\s*:\s*`?([\w./-]+)/iu.exec(goal)?.[1];
  const named = explicit ?? [...goal.matchAll(/src\/ux-sim\/([\w-]+)\.ts/gu)].map((match) => match[1]).find((name) => name !== 'event-monkey');
  // A generic TDD boundary says nothing about which device is needed. Do not
  // invent <feature>-device.ts from a production path.
  if (!named) return { required: false, device: '', deviceSource: 'goal', exists: false,
    inventoryMeasured: root !== undefined, firstSliceKind: 'none' };
  const stem = named.replace(/^src\/ux-sim\//u, '').replace(/\.ts$/u, '');
  const safeStem = stem.replace(/[^a-z0-9-]/giu, '-').replace(/^-+|-+$/gu, '') || 'goal-device';
  const device = `src/ux-sim/${safeStem}.ts`;
  return { required: true, device, deviceSource: 'goal', exists: root !== undefined && existsSync(join(root, device)),
    inventoryMeasured: root !== undefined, firstSliceKind: 'device-test' };
}

export function ensureDeviceFirstSteps(goal: string, steps: readonly string[], root?: string): { steps: string[]; decision: DeviceFirstDecision } {
  let decision = inspectDeviceFirstGoal(goal, root);
  if (steps.length === 0) return { steps: [...steps], decision };
  const existingStage = steps.findIndex((step) => step.includes(`동작: ${DEVICE_FIRST_STEP}`));
  let rejectedStagedPath: string | undefined;
  if (existingStage >= 0) {
    const declaredPaths = steps[existingStage]!.split(/동작:/u)[0]!;
    const stagedAction = steps[existingStage]!.split(/\n완료 경계/u)[0]!;
    const declaredPath = /신설:\s*(src\/ux-sim\/[\w/-]+\.ts)/u.exec(steps[existingStage]!)?.[1]
      ?? /src\/ux-sim\/[\w/-]+(?:\.test)?\.ts(?![\w.])/u.exec(stagedAction)?.[0]
      ?? /(?:src|test)\/[\w./-]+\.[cm]?[jt]sx?(?![\w.])/u.exec(declaredPaths)?.[0];
    const stagedPath = declaredPath?.replace(/\.test\.ts$/u, '.ts');
    if (stagedPath && /^src\/ux-sim\/[\w/-]+\.ts$/u.test(stagedPath)) {
      decision = { ...decision, required: true, device: stagedPath, deviceSource: 'planner-stage',
        exists: root !== undefined && existsSync(join(root, stagedPath)), firstSliceKind: 'device-test' };
    } else if (declaredPath) rejectedStagedPath = declaredPath;
  }
  // Without a repository root we cannot verify an existing device or declare
  // its missing paths. Keep the feature plan and defer device inventory.
  if (root === undefined && decision.required) decision = { ...decision, required: false, firstSliceKind: 'none' };
  if (!decision.required) return { steps: existingStage < 0 ? [...steps]
    : steps.filter((_, index) => index !== existingStage)
      .map(step => step.replace(/\n?선행: DEVICE-FIRST-STAGE 조각 착지 뒤 발사/gu, '')), decision };
  const predecessor = `선행: ${DEVICE_FIRST_STEP} 조각 착지 뒤 발사`;
  const test = decision.device.replace(/\.ts$/u, '.test.ts');
  // The parent goal's feature test is not evidence that the device itself works.
  const deviceBoundary = [
    `완료 경계 코드: ${decision.device}와 ${test}에서 mock 입력을 생산 호출에 주입하고 관측 가능한 결과를 단언한다. 운영 코드 변경 0.`,
    '완료 경계 실물: 대상 저장소에서 mock 입력으로 실제 생산 호출을 통과시켜 입력·출력 또는 사건 원문을 남긴다. RED 실패 뒤 GREEN 통과를 같은 시험으로 확인한다.',
    `완료 경계 증거 명령: bun test ${test}`,
  ].join('\n');
  const completeDeviceStage = (stage: string): string => {
    // A planner may have copied the feature boundary onto this stage. Give the device one unambiguous boundary.
    const body = stage.split('\n')
      .filter((line) => !/^\s*(?:[-*]\s*)?완료 경계 (?:코드|실물|증거 명령):/u.test(line))
      .map((line) => line.replace(/\s*·\s*완료 경계 (?:코드|실물|증거 명령):[^·]*/gu, ''))
      .join('\n');
    return `${body}\n${deviceBoundary}`;
  };
  const evidenceCommand = /완료\s*경계\s*증거\s*명령\s*[:：]\s*([^\r\n]+)/u.exec(goal)?.[1] ?? '';
  const goalFeatureTest = [evidenceCommand, goal].flatMap((text) => [...text.matchAll(/(?:src|test)\/[\w./-]+\.test\.[cm]?[jt]sx?/gu)]
    .map((match) => match[0])).find((path) => path !== test && !path.startsWith('src/ux-sim/'));
  const completeFeatureStage = (stage: string, index: number): string => {
    const withPredecessor = stage.includes(predecessor) ? stage : `${stage}\n${predecessor}`;
    const declaredGoalTest = index === 0 ? goalFeatureTest : undefined;
    const priorPlan = /검증 계획\(TDD\):[^\n]*/u.exec(withPredecessor)?.[0];
    // An explicit goal command replaces the whole inherited plan. Merely
    // containing that command is insufficient when a stale command remains.
    if (priorPlan && !declaredGoalTest) return withPredecessor;
    const withoutWrongPlan = priorPlan ? withPredecessor.replace(priorPlan, '').trimEnd() : withPredecessor;
    const stagePaths = stage.split(/동작:/u)[0]!;
    const stageTest = /(?:src|test)\/[\w./-]+\.test\.[cm]?[jt]sx?/u.exec(stagePaths)?.[0];
    const stageSource = /(?:src|test)\/[\w./-]+\.[cm]?[jt]sx?/u.exec(stagePaths)?.[0];
    const existingSiblingTest = stageSource?.endsWith('.ts') && root !== undefined
      ? stageSource.replace(/\.ts$/u, '.test.ts') : undefined;
    const featureTest = declaredGoalTest ?? stageTest
      ?? (existingSiblingTest && existsSync(join(root!, existingSiblingTest)) ? existingSiblingTest : undefined);
    if (!featureTest) return `${withoutWrongPlan}\n검증 계획(TDD): 시험 경로 미확정(${stageSource ? `${stageSource}의 시험 확장자 미정` : '조각 대상 경로 없음'}) · 이 조각에서 시험 경로를 먼저 정하고 RED 실패 뒤 같은 명령으로 GREEN을 확인한다.`;
    const inventory = root === undefined ? '시험 재고 미측정(대상 루트 미상)'
      : existsSync(join(root, featureTest)) ? '기존 시험' : '신규 시험(이 조각에서 먼저 신설)';
    return `${withoutWrongPlan}\n검증 계획(TDD): ${inventory} ${featureTest} · 피처 시험 bun test ${featureTest}를 구현 전에 RED로 확인하고 생산 경로를 구현한 뒤 같은 명령으로 GREEN을 확인한다.`;
  };
  const targetPaths = [decision.device, test].filter((path) => root !== undefined && existsSync(join(root, path)));
  const newPaths = [decision.device, test].filter((path) => !targetPaths.includes(path));
  const firstTarget = targetPaths[0];
  const first = `${firstTarget ? `대상 경로: ${firstTarget}\n` : ''}${newPaths.length ? `신설: ${newPaths.join(' · ')}\n` : ''}`
    + `· 동작: ${DEVICE_FIRST_STEP} ${!decision.inventoryMeasured ? `${decision.device} 재고를 먼저 확인하고 기존이면 재사용하고 없으면 신설: 경로를 선언해` : decision.exists ? `기존 ${decision.device}를 사용해` : '필요한 mock 장치와 그 시험을 먼저 만들어'} mock 무대 시험 RED를 기록한다. 운영 코드 변경 0.`
    + (!decision.inventoryMeasured ? '\n장치 재고: 미측정(대상 루트 미상).' : '');
  if (existingStage >= 0) {
    const oldStage = steps[existingStage]!;
    // Replace copied completion boundaries, but retain planner instructions
    // about the actual injection and verification of this named device.
    const actionTail = oldStage.split(`동작: ${DEVICE_FIRST_STEP}`)[1]?.split('\n')[0] ?? '';
    const actionClauses = actionTail.split(/\s+·\s+/u).map((clause) => clause.trim());
    const retained = [...actionClauses, ...oldStage.split('\n').slice(1)]
      .map((line) => line.trim())
      .filter((line) => line && !/^(?:대상 경로|신설|[·*-]?\s*동작: DEVICE-FIRST-STAGE|장치 재고:|완료 경계 (?:코드|실물|증거 명령)|선행:)/u.test(line)
        && !/^(?:필요한 mock 장치와 그 시험을 먼저 만들어|기존 src\/ux-sim\/[\w/-]+\.ts를 사용해|src\/ux-sim\/[\w/-]+\.ts 재고를 먼저 확인하고 기존이면 재사용하고 없으면 신설: 경로를 선언해) mock 무대 시험 RED를 기록한다\. 운영 코드 변경 0\.$/u.test(line));
    const stage = `${first}${retained.length ? `\n${retained.join('\n')}` : ''}`
      + (rejectedStagedPath ? `\n플래너 장치 경로 ${rejectedStagedPath}는 src/ux-sim/*.ts 규약 밖 — 골의 장치 후보로 복구.` : '');
    return { decision, steps: [completeDeviceStage(stage), ...steps.filter((_, index) => index !== existingStage).map(completeFeatureStage)] };
  }
  return { decision, steps: [completeDeviceStage(first), ...steps.map(completeFeatureStage)] };
}
