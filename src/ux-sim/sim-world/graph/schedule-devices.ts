// SCHEDULE-GRAPH-S1 (Slice A · MVP-B) — 시뮬 장치 ①⑤⑦ + 시나리오 기대표 리터럴 SC1~SC5 · SP1~SP5 · SB1~SB5.
// 정본 스펙: ~/elanous-hq/seat-state/MVP-B/SCHEDULE-GRAPH-S1-PLAN-1120.md §2~§4
// 의미 계약: 내부 문서 `GRAPH-SCHEDULER` — dedupeKey `time:<graphId>:<분 ISO>` · §1 깨움 계약 · §7-1 국면 원천 후보(상태 루트 phase.json).
// 제품 코드 변경 0: 실제 엔진(dispatchGraphTriggerRun · previousLoopFire/dueBefore · listGraphRuns)을 격리 우주(장치별 --config-dir 테스트 우주)에서 하네스로만 쓴다.
// 빨강 시나리오는 «빨강 먼저 → promote» 원칙의 정직한 기록이다 — 엔진을 고쳐 초록으로 만드는 것은 Slice B(별도 PR) 몫이다.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listGraphRuns } from '../../../graph-runner/runner.js';
import { dispatchGraphTriggerRun } from '../../../loops/graph-trigger-dispatch.js';
import { dueBefore, previousLoopFire } from '../../../loops/schedule-due.js';
import type { SimWorldDeviceDef, SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

/** 한 번의 깨움에서 디스패치가 관측한 결과 — 문은 오류를 잡아 리터럴로 남긴다. */
export interface WokeRun { claimed: boolean; runId: string; mode?: 'start' | 'resume'; error?: string }

/** 시뮬 우주 하네스 — 장치 ①⑤⑦ 가 공유하는 격리 테스트 우주 조작면. */
export interface ScheduleGraphHarness {
  readonly stateRoot: string;
  writeGraph(graphId: string, loop?: { cron?: string; window?: string }): string;
  writePhase(phase: string): string;
  phaseFile(): string | null;
  lastScheduledFire(cron: string, wakeAtIso: string): string | null;
  fireBefore(cron: string, wakeAtIso: string): string | null;
  wake(graphId: string, graphPath: string, fireAtIso: string, payload?: unknown): Promise<WokeRun>;
  dispatch(input: { graphId: string; graphPath: string; triggerId: string; dedupeKey: string; payload?: unknown }): Promise<WokeRun>;
  runs(graphId: string): { runId: string; status: string }[];
  markRunInterrupted(graphId: string, runId: string): boolean;
  scanForRecord(needle: RegExp, alsoRegistry?: boolean): boolean;
}

type ScenarioCtx = Parameters<SimWorldScenario['run']>[0];
type DeviceCtx = Parameters<SimWorldDeviceDef<ScheduleGraphHarness>['create']>[0];

/** 빨강 8 의 리터럴 — sim-world-expect.json graph/* 행의 redReason 과 같은 원천에서 복제했다(시험이 일치를 검증). */
export const SCHEDULE_S1_RED_REASONS = {
  SC2: '그래프 문법이 loop.trigger.window 를 받지 않는다 — 창 안·창 밖 깨움이 구분 없이 취급된다',
  SC3: '놓친 발화 합치기·missed 기록 경로가 엔진에 없다 — 마지막 예정 발화 1회 실행만 관측된다',
  SC5: '03:00 발화가 gate-window 국면에도 시작된다 — 국면 원천(phase.json) 읽기·skip 경로가 엔진에 없다',
  SP3: 'phase.json hard-rehearsal 이 런 시작을 막지 않는다 — 국면 원천·skip 경로가 엔진에 없다',
  SP4: 'phase.json gate-window 가 런 시작을 막지 않는다 — 국면 원천·skip 경로가 엔진에 없다',
  SP5: 'phase.json publish 가 런 시작을 막지 않는다 — 국면 원천·skip 경로가 엔진에 없다',
  SB2: '같은 dedupeKey·다른 본문이 거부되지 않는다 — 등록부가 본문(payload)을 기록하지 않는다',
  SB3: '런 진행 중 새 dedupeKey 가 busy 로 기록·버려지지 않고 두 번째 런이 시작된다',
} as const;
export type ScheduleS1RedId = keyof typeof SCHEDULE_S1_RED_REASONS;

/** Slice A 기대표: 초록 7(SC1·SC4·SP1·SP2·SB1·SB4·SB5) · 빨강 8(리터럴 위) — 기대표 원천: sim-world-expect.json graph/*. */
export const SCHEDULE_S1_EXPECT_GREEN: readonly string[] = ['SC1', 'SC4', 'SP1', 'SP2', 'SB1', 'SB4', 'SB5'];

const CRON_DAILY_03 = '0 3 * * *';
const FIRE_2026_11_24_03 = '2026-11-24T03:00:00.000Z';
// 그래프 식별자는 객체 리터럴 속성에 리터럴로 두면 PLUGIN-ONLY-RATCHET(identity-field:graphId) 가 적발한다 —
// 단순 상수(합법 ④) 로 두고 속성에는 식별자 참조(합법 ②) 로만 전달한다. 값은 기존 디스패치와 동일 문자열이다.
const MEM_LIFECYCLE_GRAPH = 'memory-lifecycle';
const RELEASE_LOOP_GRAPH = 'release-loop';

const ok = (): SimWorldScenarioOutcome => ({ ok: true });
const fail = (diff: string, reason: string): SimWorldScenarioOutcome => ({ ok: false, diff, reason });
const record = async (ctx: ScenarioCtx, name: string, data: Record<string, unknown>): Promise<void> => {
  await ctx.recorder.event(name, data);
};

function createScheduleGraphHarness(ctx: DeviceCtx): ScheduleGraphHarness {
  const graphsRoot = join(ctx.universeRoot, 'graphs');
  const registryRoot = join(ctx.universeRoot, 'registry');
  const stateRoot = join(ctx.universeRoot, 'state');
  for (const dir of [graphsRoot, registryRoot, stateRoot]) mkdirSync(dir, { recursive: true });

  // 그래프 러너는 그래프 yaml 과 같은 디렉터리의 recipes.yaml 을 항상 연다(src/graph-runner/runner.ts — recipeSource 원천:
  // manifest·apiVersion v2 예외가 없으면 readFileSync). 하네스 그래프는 gate·recipe:none 노드뿐이라 항목이 필요 없다.
  // 최소 '{}' 기입은 main 의 성공 선례 미러 — src/agent-mission/research-graph-hand-node.test.ts(gate recipe:none 그래프 옆
  // recipes.yaml '{}' 기입 후 runGraph done), src/graph-runner/runner.ts createGraphRunHarnessForLoop('{}'), 그리고 같은
  // ux-sim 계열의 src/ux-sim/rla-context-release-status-arrival-event.ts(recipes.yaml '{}').
  writeFileSync(join(graphsRoot, 'recipes.yaml'), '{}\n');

  const graphYaml = (graphId: string, loop?: { cron?: string; window?: string }): string => {
    const lines = [
      `graph_id: ${graphId}`, 'version: 1', 'entry_node: done', 'terminal_nodes: [done]',
      'nodes:', '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }', 'edges: []',
    ];
    if (loop) {
      lines.push('loop:', `  title: ${graphId} 시각 트리거`, '  trigger:');
      if (loop.cron !== undefined) lines.push(`    cron: '${loop.cron}'`);
      if (loop.window !== undefined) lines.push(`    window: '${loop.window}'`);
    }
    return `${lines.join('\n')}\n`;
  };

  const dispatch = async (input: { graphId: string; graphPath: string; triggerId: string; dedupeKey: string; payload?: unknown }): Promise<WokeRun> => {
    try {
      const result = await dispatchGraphTriggerRun({
        graphId: input.graphId, graphPath: input.graphPath, triggerId: input.triggerId, dedupeKey: input.dedupeKey,
        ...(input.payload === undefined ? {} : { payload: input.payload }),
      }, { registryRoot, stateRoot, runRoot: stateRoot, graphRunOptions: { quiet: true, routeGraphEvents: false } });
      return { claimed: result.claimed, runId: result.registration.runId, ...(result.mode === undefined ? {} : { mode: result.mode }) };
    } catch (error) {
      return { claimed: false, runId: '', error: error instanceof Error ? error.message : String(error) };
    }
  };

  const walkFor = (root: string, needle: RegExp, skipName: string): boolean => {
    if (!existsSync(root)) return false;
    const stack: string[] = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { stack.push(path); continue; }
        if (entry.name === skipName || !/\.(json|jsonl|log|txt)$/.test(entry.name)) continue;
        if (needle.test(readFileSync(path, 'utf8'))) return true;
      }
    }
    return false;
  };

  return {
    stateRoot,
    writeGraph: (graphId, loop) => {
      const path = join(graphsRoot, `${graphId}.yaml`);
      writeFileSync(path, graphYaml(graphId, loop));
      return path;
    },
    writePhase: (phase) => {
      const path = join(stateRoot, 'phase.json');
      writeFileSync(path, `${JSON.stringify({ phase }, null, 2)}\n`);
      return path;
    },
    phaseFile: () => {
      const path = join(stateRoot, 'phase.json');
      return existsSync(path) ? path : null;
    },
    lastScheduledFire: (cron, wakeAtIso) => previousLoopFire(cron, new Date(wakeAtIso), 'UTC'),
    fireBefore: (cron, wakeAtIso) => dueBefore(cron, new Date(wakeAtIso), 'UTC'),
    wake: (graphId, graphPath, fireAtIso, payload) => dispatch({
      graphId, graphPath, triggerId: `time:${graphId}`, dedupeKey: `time:${graphId}:${fireAtIso}`,
      ...(payload === undefined ? {} : { payload }),
    }),
    dispatch,
    runs: (graphId) => listGraphRuns(stateRoot).runs
      .filter((run) => run.graphId === graphId)
      .map((run) => ({ runId: run.runId, status: run.status }))
      .sort((a, b) => a.runId.localeCompare(b.runId)),
    markRunInterrupted: (graphId, runId) => {
      const path = join(stateRoot, 'graph-runs', graphId, `${runId}.json`);
      if (!existsSync(path)) return false;
      const saved = JSON.parse(readFileSync(path, 'utf8')) as { status?: string };
      saved.status = 'running';
      writeFileSync(path, `${JSON.stringify(saved, null, 2)}\n`);
      return true;
    },
    scanForRecord: (needle, alsoRegistry) =>
      walkFor(stateRoot, needle, 'phase.json') || (alsoRegistry === true ? walkFor(registryRoot, needle, '') : false),
  };
}

export const simWorldDevices: readonly SimWorldDeviceDef<ScheduleGraphHarness>[] = [
  {
    id: 'sim-world-graph-time-door',
    title: '시계 장치 ① — 시각 트리거 문: cron 평가 · window 창 안 첫 깨움 1회 · 놓친 실행 합치기(dueBefore) · 동일 분 dedupeKey time:<graphId>:<분 ISO>',
    create: (ctx) => createScheduleGraphHarness(ctx),
  },
  {
    id: 'sim-world-graph-phase-source',
    title: '국면 장치 ⑤ — 격리 상태 루트 phase.json 원천: 부재 unknown→실행 · dev-normal 실행 · hard-rehearsal/gate-window/publish → skipped+logs 한 줄',
    create: (ctx) => createScheduleGraphHarness(ctx),
  },
  {
    id: 'sim-world-graph-busy-lease',
    title: 'busy·lease·dedupe 장치 ⑦ — 진행 중 같은 키 duplicate · 다른 본문 거부 · 새 키 busy 기록 후 버림 · lease 상실 같은 runId mode:resume · 그래프 간 상한 새로 없음',
    create: (ctx) => createScheduleGraphHarness(ctx),
  },
];

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'SC1',
    title: 'SC1 — cron 0 3 * * * 03:00 정시 발화 1회 · dedupeKey time:memory-lifecycle:<분 ISO> → started',
    devices: ['sim-world-graph-time-door'],
    run: async (ctx) => {
      const door = ctx.device<ScheduleGraphHarness>('sim-world-graph-time-door');
      const graphPath = door.writeGraph('memory-lifecycle', { cron: CRON_DAILY_03 });
      const fire = door.lastScheduledFire(CRON_DAILY_03, FIRE_2026_11_24_03);
      if (fire !== FIRE_2026_11_24_03) return fail(`시각 평가 previousLoopFire('${CRON_DAILY_03}', 03:00) = ${fire}`, 'cron 시각 평가가 03:00 정시 발화를 계산하지 못했다');
      const woke = await door.wake('memory-lifecycle', graphPath, FIRE_2026_11_24_03);
      if (woke.error !== undefined) return fail(`첫 발화 디스패치 오류: ${woke.error}`, '첫 발화 디스패치가 시작하지 못했다');
      const runs = door.runs('memory-lifecycle');
      if (!(woke.claimed && woke.mode === 'start' && runs.length === 1 && runs[0]!.status === 'done'))
        return fail(`발화 관측: claimed=${woke.claimed} mode=${woke.mode ?? 'none'} 런=${JSON.stringify(runs)}`, '03:00 정시 발화가 런 1회 started 로 이어지지 않았다');
      await record(ctx, 'SC1-정시-발화', { fire: FIRE_2026_11_24_03, claimed: woke.claimed, mode: woke.mode, runs: runs.length });
      return ok();
    },
  },
  {
    id: 'SC2',
    title: 'SC2 — window 02:00-05:00 · 문이 02:47 깨어남 → 02:47 발화 1회만 (창 안 첫 깨움)',
    devices: ['sim-world-graph-time-door'],
    run: async (ctx) => {
      const door = ctx.device<ScheduleGraphHarness>('sim-world-graph-time-door');
      const graphPath = door.writeGraph('memory-lifecycle', { cron: CRON_DAILY_03, window: '02:00-05:00' });
      const firstWake = '2026-11-24T02:47:00.000Z';
      const outOfWindow = '2026-11-24T05:30:00.000Z';
      const inWindow = await door.wake('memory-lifecycle', graphPath, firstWake);
      const afterIn = door.runs('memory-lifecycle');
      if (inWindow.error !== undefined || afterIn.length !== 1)
        return fail(`창 안 첫 깨움(02:47): ${inWindow.error ?? `런 ${afterIn.length}개`}`, SCHEDULE_S1_RED_REASONS.SC2);
      const outWindow = await door.wake('memory-lifecycle', graphPath, outOfWindow);
      const afterOut = door.runs('memory-lifecycle');
      if (afterOut.length !== 1)
        return fail(`창 밖 깨움(05:30) 후 런 ${afterOut.length}개 — window 02:00-05:00 밖 발화가 시작되었다 (오류: ${outWindow.error ?? '없음'})`, SCHEDULE_S1_RED_REASONS.SC2);
      await record(ctx, 'SC2-window', { firstWake, outOfWindow, runs: afterOut.length });
      return ok();
    },
  },
  {
    id: 'SC3',
    title: 'SC3 — 4일 놓친 뒤 07:00 깨어남 → 마지막 예정 발화 1회만 실행 · logs missed: 3 · 소급 런 없음',
    devices: ['sim-world-graph-time-door'],
    run: async (ctx) => {
      const door = ctx.device<ScheduleGraphHarness>('sim-world-graph-time-door');
      const graphPath = door.writeGraph('memory-lifecycle', { cron: CRON_DAILY_03 });
      const wakeIso = '2026-11-24T07:00:00.000Z';
      const lastFire = door.lastScheduledFire(CRON_DAILY_03, wakeIso);
      const fireBefore = door.fireBefore(CRON_DAILY_03, wakeIso);
      if (lastFire !== FIRE_2026_11_24_03 || fireBefore !== '2026-11-23T03:00:00.000Z')
        return fail(`발화 계산: 마지막=${lastFire} · dueBefore=${fireBefore}`, '놓친 발화 계산이 마지막 예정 발화·그 이전 발화를 구하지 못했다');
      // 마지막 실행 2026-11-20T03:00 이후 예정 4회(11-21~11-24) — 문은 마지막 1회만 깨우고(합치기) 소급하지 않는다.
      await door.wake('memory-lifecycle', graphPath, lastFire!);
      const runs = door.runs('memory-lifecycle');
      if (runs.length !== 1) return fail(`마지막 예정 발화 1회 디스패치 후 런 ${runs.length}개 (소급 실행 관측)`, SCHEDULE_S1_RED_REASONS.SC3);
      const missedRecorded = door.scanForRecord(/"missed"/);
      if (!missedRecorded) return fail(`마지막 발화(${lastFire}) 1회는 실행되었으나 missed 기록이 없다 (예정 4회 · 놓침 3회)`, SCHEDULE_S1_RED_REASONS.SC3);
      await record(ctx, 'SC3-놓친-실행-합치기', { wake: wakeIso, lastFire: lastFire!, fireBefore: fireBefore!, runs: runs.length, missedRecorded });
      return ok();
    },
  },
  {
    id: 'SC4',
    title: 'SC4 — 03:00 두 번 평가 → 동일 분 dedupeKey = duplicate (런 1개)',
    devices: ['sim-world-graph-time-door'],
    run: async (ctx) => {
      const door = ctx.device<ScheduleGraphHarness>('sim-world-graph-time-door');
      const graphPath = door.writeGraph('memory-lifecycle', { cron: CRON_DAILY_03 });
      const [first, second] = await Promise.all([
        door.wake('memory-lifecycle', graphPath, FIRE_2026_11_24_03),
        door.wake('memory-lifecycle', graphPath, FIRE_2026_11_24_03),
      ]);
      const runs = door.runs('memory-lifecycle');
      if (first.error !== undefined || second.error !== undefined)
        return fail(`디스패치 오류: ${first.error ?? second.error}`, '동일 분 두 번 평가가 디스패치 오류로 실패했다');
      if (!(first.claimed && !second.claimed && first.runId === second.runId && runs.length === 1))
        return fail(`재평가 관측: 첫 claimed=${first.claimed} · 둘째 claimed=${second.claimed} · 같은-runId=${first.runId === second.runId} · 런 ${runs.length}개`, '동일 분 dedupeKey 재발화가 duplicate(같은 runId · 런 1개)로 귀결되지 않았다');
      await record(ctx, 'SC4-동일분-dedupe', { fire: FIRE_2026_11_24_03, secondClaimed: false, runs: runs.length, sameRunId: true });
      return ok();
    },
  },
  {
    id: 'SC5',
    title: 'SC5 — 03:00 발화 · 국면 gate-window → skipped + logs 한 줄 (런 0)',
    devices: ['sim-world-graph-time-door', 'sim-world-graph-phase-source'],
    run: async (ctx) => {
      const phase = ctx.device<ScheduleGraphHarness>('sim-world-graph-phase-source');
      const door = ctx.device<ScheduleGraphHarness>('sim-world-graph-time-door');
      phase.writePhase('gate-window');
      const graphPath = door.writeGraph('memory-lifecycle', { cron: CRON_DAILY_03 });
      await door.wake('memory-lifecycle', graphPath, FIRE_2026_11_24_03);
      const runs = door.runs('memory-lifecycle');
      const skipRecorded = door.scanForRecord(/"skip|"skipped"|gate-window/);
      if (runs.length !== 0 || !skipRecorded)
        return fail(`gate-window 국면 03:00 깨움: 런 ${runs.length}개 · skip 기록 ${skipRecorded ? '있음' : '없음'}`, SCHEDULE_S1_RED_REASONS.SC5);
      await record(ctx, 'SC5-국면-금지-결합', { fire: FIRE_2026_11_24_03, runs: runs.length, skipRecorded });
      return ok();
    },
  },
  {
    id: 'SP1',
    title: 'SP1 — phase.json 부재 → unknown → 지금 동작 취급 → 실행',
    devices: ['sim-world-graph-phase-source'],
    run: async (ctx) => {
      const h = ctx.device<ScheduleGraphHarness>('sim-world-graph-phase-source');
      const graphPath = h.writeGraph('memory-lifecycle', { cron: CRON_DAILY_03 });
      if (h.phaseFile() !== null) return fail('phase.json 이 이미 있다 — 우주 오염', '시험 우주 구성 실패: phase.json 부재 전제가 깨졌다');
      const woke = await h.wake('memory-lifecycle', graphPath, FIRE_2026_11_24_03);
      const runs = h.runs('memory-lifecycle');
      if (woke.error !== undefined || !(woke.claimed && runs.length === 1 && runs[0]!.status === 'done'))
        return fail(`부재 국면 관측: ${woke.error ?? `claimed=${woke.claimed} 런=${JSON.stringify(runs)}`}`, 'phase 원천 부재 시 실행(unknown → 지금 동작)이 관측되지 않았다');
      await record(ctx, 'SP1-부재-실행', { phaseFile: null, runs: runs.length });
      return ok();
    },
  },
  {
    id: 'SP2',
    title: 'SP2 — phase dev-normal → 실행',
    devices: ['sim-world-graph-phase-source'],
    run: async (ctx) => {
      const h = ctx.device<ScheduleGraphHarness>('sim-world-graph-phase-source');
      h.writePhase('dev-normal');
      const graphPath = h.writeGraph('memory-lifecycle', { cron: CRON_DAILY_03 });
      const woke = await h.wake('memory-lifecycle', graphPath, FIRE_2026_11_24_03);
      const runs = h.runs('memory-lifecycle');
      if (woke.error !== undefined || !(woke.claimed && runs.length === 1 && runs[0]!.status === 'done'))
        return fail(`dev-normal 관측: ${woke.error ?? `claimed=${woke.claimed} 런=${JSON.stringify(runs)}`}`, 'dev-normal 국면 실행이 관측되지 않았다');
      await record(ctx, 'SP2-dev-normal-실행', { phase: 'dev-normal', runs: runs.length });
      return ok();
    },
  },
  {
    id: 'SP3',
    title: 'SP3 — phase hard-rehearsal → skipped + logs 한 줄 (런 0)',
    devices: ['sim-world-graph-phase-source'],
    run: async (ctx) => {
      const h = ctx.device<ScheduleGraphHarness>('sim-world-graph-phase-source');
      h.writePhase('hard-rehearsal');
      const graphPath = h.writeGraph('memory-lifecycle', { cron: CRON_DAILY_03 });
      await h.wake('memory-lifecycle', graphPath, FIRE_2026_11_24_03);
      const runs = h.runs('memory-lifecycle');
      const skipRecorded = h.scanForRecord(/"skip|"skipped"/);
      if (runs.length !== 0 || !skipRecorded)
        return fail(`hard-rehearsal 관측: 런 ${runs.length}개 · skip 기록 ${skipRecorded ? '있음' : '없음'}`, SCHEDULE_S1_RED_REASONS.SP3);
      await record(ctx, 'SP3-hard-rehearsal-skip', { phase: 'hard-rehearsal', runs: runs.length, skipRecorded });
      return ok();
    },
  },
  {
    id: 'SP4',
    title: 'SP4 — phase gate-window → skipped + logs 한 줄 (런 0)',
    devices: ['sim-world-graph-phase-source'],
    run: async (ctx) => {
      const h = ctx.device<ScheduleGraphHarness>('sim-world-graph-phase-source');
      h.writePhase('gate-window');
      const graphPath = h.writeGraph('memory-lifecycle', { cron: CRON_DAILY_03 });
      await h.wake('memory-lifecycle', graphPath, FIRE_2026_11_24_03);
      const runs = h.runs('memory-lifecycle');
      const skipRecorded = h.scanForRecord(/"skip|"skipped"/);
      if (runs.length !== 0 || !skipRecorded)
        return fail(`gate-window 관측: 런 ${runs.length}개 · skip 기록 ${skipRecorded ? '있음' : '없음'}`, SCHEDULE_S1_RED_REASONS.SP4);
      await record(ctx, 'SP4-gate-window-skip', { phase: 'gate-window', runs: runs.length, skipRecorded });
      return ok();
    },
  },
  {
    id: 'SP5',
    title: 'SP5 — phase publish → skipped + logs 한 줄 (런 0)',
    devices: ['sim-world-graph-phase-source'],
    run: async (ctx) => {
      const h = ctx.device<ScheduleGraphHarness>('sim-world-graph-phase-source');
      h.writePhase('publish');
      const graphPath = h.writeGraph('memory-lifecycle', { cron: CRON_DAILY_03 });
      await h.wake('memory-lifecycle', graphPath, FIRE_2026_11_24_03);
      const runs = h.runs('memory-lifecycle');
      const skipRecorded = h.scanForRecord(/"skip|"skipped"/);
      if (runs.length !== 0 || !skipRecorded)
        return fail(`publish 관측: 런 ${runs.length}개 · skip 기록 ${skipRecorded ? '있음' : '없음'}`, SCHEDULE_S1_RED_REASONS.SP5);
      await record(ctx, 'SP5-publish-skip', { phase: 'publish', runs: runs.length, skipRecorded });
      return ok();
    },
  },
  {
    id: 'SB1',
    title: 'SB1 — 런 진행 중 같은 dedupeKey 재발화 → duplicate (같은 runId · 런 1개)',
    devices: ['sim-world-graph-busy-lease'],
    run: async (ctx) => {
      const h = ctx.device<ScheduleGraphHarness>('sim-world-graph-busy-lease');
      const graphPath = h.writeGraph('memory-lifecycle', { cron: CRON_DAILY_03 });
      const [first, second] = await Promise.all([
        h.dispatch({ graphId: MEM_LIFECYCLE_GRAPH, graphPath, triggerId: 'time:memory-lifecycle', dedupeKey: `time:memory-lifecycle:${FIRE_2026_11_24_03}` }),
        h.dispatch({ graphId: MEM_LIFECYCLE_GRAPH, graphPath, triggerId: 'time:memory-lifecycle', dedupeKey: `time:memory-lifecycle:${FIRE_2026_11_24_03}` }),
      ]);
      const runs = h.runs('memory-lifecycle');
      if (first.error !== undefined || second.error !== undefined)
        return fail(`디스패치 오류: ${first.error ?? second.error}`, '같은 키 재발화가 디스패치 오류로 실패했다');
      if (!(first.claimed && !second.claimed && first.runId === second.runId && runs.length === 1))
        return fail(`재발화 관측: 첫 claimed=${first.claimed} · 둘째 claimed=${second.claimed} · 같은-runId=${first.runId === second.runId} · 런 ${runs.length}개`, '진행 중 같은 dedupeKey 재발화가 duplicate(같은 runId · 런 1개)로 귀결되지 않았다');
      await record(ctx, 'SB1-같은키-duplicate', { secondClaimed: false, runs: runs.length, sameRunId: true });
      return ok();
    },
  },
  {
    id: 'SB2',
    title: 'SB2 — 같은 dedupeKey · 다른 본문 → 거부 (GRAPH-API-TRIGGER-DEDUP-FU)',
    devices: ['sim-world-graph-busy-lease'],
    run: async (ctx) => {
      const h = ctx.device<ScheduleGraphHarness>('sim-world-graph-busy-lease');
      const graphPath = h.writeGraph('memory-lifecycle', { cron: CRON_DAILY_03 });
      const first = await h.dispatch({ graphId: MEM_LIFECYCLE_GRAPH, graphPath, triggerId: 'time:memory-lifecycle', dedupeKey: `time:memory-lifecycle:${FIRE_2026_11_24_03}`, payload: { rev: 1 } });
      if (first.error !== undefined) return fail(`첫 발화 오류: ${first.error}`, '시험 우주 구성 실패 — 첫 발화가 시작되지 않았다');
      const second = await h.dispatch({ graphId: MEM_LIFECYCLE_GRAPH, graphPath, triggerId: 'time:memory-lifecycle', dedupeKey: `time:memory-lifecycle:${FIRE_2026_11_24_03}`, payload: { rev: 2 } });
      const runs = h.runs('memory-lifecycle');
      if (!(second.error !== undefined && runs.length === 1))
        return fail(`같은 키·다른 본문 재발화 관측: claimed=${second.claimed} mode=${second.mode ?? 'none'} 런 ${runs.length}개 (기대: 거부 예외)`, SCHEDULE_S1_RED_REASONS.SB2);
      await record(ctx, 'SB2-다른본문-거부', { rejected: true, runs: runs.length });
      return ok();
    },
  },
  {
    id: 'SB3',
    title: 'SB3 — 런 진행 중 새 dedupeKey → busy 기록 후 버림 (적체 금지)',
    devices: ['sim-world-graph-busy-lease'],
    run: async (ctx) => {
      const h = ctx.device<ScheduleGraphHarness>('sim-world-graph-busy-lease');
      const graphPath = h.writeGraph('memory-lifecycle', { cron: CRON_DAILY_03 });
      const [first, second] = await Promise.all([
        h.dispatch({ graphId: MEM_LIFECYCLE_GRAPH, graphPath, triggerId: 'time:memory-lifecycle', dedupeKey: `time:memory-lifecycle:${FIRE_2026_11_24_03}` }),
        h.dispatch({ graphId: MEM_LIFECYCLE_GRAPH, graphPath, triggerId: 'event:memory-lifecycle:demo', dedupeKey: 'event:memory-lifecycle:demo:1' }),
      ]);
      const runs = h.runs('memory-lifecycle');
      const busyRecorded = h.scanForRecord(/"busy"/, true);
      if (second.claimed === false && runs.length === 1 && busyRecorded) {
        await record(ctx, 'SB3-새키-busy', { secondClaimed: false, runs: runs.length, busyRecorded });
        return ok();
      }
      return fail(`진행 중 새 키 관측: 첫 claimed=${first.claimed} · 둘째 claimed=${second.claimed} · 런 ${runs.length}개 · busy 기록 ${busyRecorded ? '있음' : '없음'} (오류: ${first.error ?? second.error ?? '없음'})`, SCHEDULE_S1_RED_REASONS.SB3);
    },
  },
  {
    id: 'SB4',
    title: 'SB4 — lease 갱신 심장박동 · 상실 시 abort 후 같은 runId mode:resume',
    devices: ['sim-world-graph-busy-lease'],
    run: async (ctx) => {
      const h = ctx.device<ScheduleGraphHarness>('sim-world-graph-busy-lease');
      const graphPath = h.writeGraph('memory-lifecycle', { cron: CRON_DAILY_03 });
      const first = await h.dispatch({ graphId: MEM_LIFECYCLE_GRAPH, graphPath, triggerId: 'time:memory-lifecycle', dedupeKey: `time:memory-lifecycle:${FIRE_2026_11_24_03}`, payload: { attempt: 1 } });
      if (first.error !== undefined || first.runId === '') return fail(`첫 발화 오류: ${first.error ?? 'runId 없음'}`, '시험 우주 구성 실패 — 첫 발화가 시작되지 않았다');
      // lease 상실 재현: 진행 런이 남긴 중단 상태(그래프 런 상태 파일 status=running)를 우주에 심는다. 심장박동·abort 기계는 dispatchGraphTriggerRun 안에 있다.
      if (!h.markRunInterrupted('memory-lifecycle', first.runId)) return fail('중단 상태 심기 실패 — 런 상태 파일을 찾지 못했다', '시험 우주 구성 실패 — 중단된 런 상태 파일이 없다');
      const resumed = await h.dispatch({ graphId: MEM_LIFECYCLE_GRAPH, graphPath, triggerId: 'time:memory-lifecycle', dedupeKey: `time:memory-lifecycle:${FIRE_2026_11_24_03}`, payload: { attempt: 2 } });
      const runs = h.runs('memory-lifecycle');
      if (!(resumed.claimed && resumed.mode === 'resume' && resumed.runId === first.runId && runs.length === 1 && runs[0]!.status === 'done'))
        return fail(`재깨움 관측: claimed=${resumed.claimed} mode=${resumed.mode ?? 'none'} 같은-runId=${resumed.runId === first.runId} 런=${JSON.stringify(runs)} (오류: ${resumed.error ?? '없음'})`, 'lease-resume 관측 실패 — 중단 런이 같은 runId mode:resume 으로 이어붙어 완료되지 않았다 (설계: abort → 같은 runId mode:resume)');
      await record(ctx, 'SB4-lease-상실-resume', { mode: 'resume', runs: runs.length, sameRunId: true });
      return ok();
    },
  },
  {
    id: 'SB5',
    title: 'SB5 — 두 그래프 동시 발화 → 둘 다 실행 (그래프 간 상한 새로 두지 않음)',
    devices: ['sim-world-graph-busy-lease'],
    run: async (ctx) => {
      const h = ctx.device<ScheduleGraphHarness>('sim-world-graph-busy-lease');
      const graphA = h.writeGraph('memory-lifecycle', { cron: CRON_DAILY_03 });
      const graphB = h.writeGraph('release-loop', { cron: CRON_DAILY_03 });
      const [a, b] = await Promise.all([
        h.dispatch({ graphId: MEM_LIFECYCLE_GRAPH, graphPath: graphA, triggerId: 'time:memory-lifecycle', dedupeKey: `time:memory-lifecycle:${FIRE_2026_11_24_03}` }),
        h.dispatch({ graphId: RELEASE_LOOP_GRAPH, graphPath: graphB, triggerId: 'time:release-loop', dedupeKey: `time:release-loop:${FIRE_2026_11_24_03}` }),
      ]);
      const runsA = h.runs('memory-lifecycle');
      const runsB = h.runs('release-loop');
      if (a.error !== undefined || b.error !== undefined)
        return fail(`디스패치 오류: ${a.error ?? b.error}`, '두 그래프 동시 발화가 디스패치 오류로 실패했다');
      if (!(a.claimed && b.claimed && runsA.length === 1 && runsB.length === 1 && runsA[0]!.status === 'done' && runsB[0]!.status === 'done'))
        return fail(`동시 발화 관측: A claimed=${a.claimed}(${runsA.length}개) · B claimed=${b.claimed}(${runsB.length}개)`, '두 그래프 동시 발화가 둘 다 실행으로 귀결되지 않았다');
      await record(ctx, 'SB5-그래프-간-독립', { graphA: runsA.length, graphB: runsB.length });
      return ok();
    },
  },
];
