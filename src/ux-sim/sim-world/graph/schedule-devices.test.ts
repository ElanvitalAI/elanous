// SCHEDULE-GRAPH-S1 Slice A — 커널 없이(kernel-free) 장치 모듈을 직접 시험한다.
// 15 시나리오를 실제 엔진(dispatchGraphTriggerRun · previousLoopFire/dueBefore · listGraphRuns) 위에서 돌려
// 초록 7(SC1·SC4·SP1·SP2·SB1·SB4·SB5)은 ok:true, 빨강 8은 기대표 리터럴(SCHEDULE_S1_RED_REASONS)과 reason 이 정확히 일치하는지 검증한다.
// 이 시험이 통과하면 커널 경로(sim world run)에서도 같은 코드로 pass/xfail 로 귀결된다(기대표 redReason 일치가 보장된다).

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SCHEDULE_S1_EXPECT_GREEN, SCHEDULE_S1_RED_REASONS, ScheduleGraphHarness,
  simWorldDevices, simWorldScenarios,
} from './schedule-devices.js';
import expectTable from '../../worlds/sim-world-expect.json';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const fakeRecorder = { event: async () => undefined };

async function makeCtx(scenarioId: string) {
  const universeRoot = mkdtempSync(join(tmpdir(), `sched-s1-${scenarioId}-`));
  roots.push(universeRoot);
  const instances = new Map<string, ScheduleGraphHarness>();
  const deviceCtx = { world: 'graph', scenarioId, seed: 1, engine: 'legacy', universeRoot, recorder: fakeRecorder };
  for (const def of simWorldDevices) instances.set(def.id, await def.create(deviceCtx as never));
  return {
    world: 'graph', scenarioId, seed: 1, engine: 'legacy', universeRoot, recorder: fakeRecorder,
    device: (id: string): ScheduleGraphHarness => {
      const instance = instances.get(id);
      if (instance === undefined) throw new Error(`unlisted device: ${id}`);
      return instance;
    },
  };
}

test('장치 3종 · 시나리오 15개 리터럴 (① 시계 · ⑤ 국면 · ⑦ busy-lease-dedupe)', () => {
  expect(simWorldDevices.map((def) => def.id)).toEqual([
    'sim-world-graph-time-door', 'sim-world-graph-phase-source', 'sim-world-graph-busy-lease',
  ]);
  expect(simWorldScenarios.map((scenario) => scenario.id)).toEqual([
    'SC1', 'SC2', 'SC3', 'SC4', 'SC5', 'SP1', 'SP2', 'SP3', 'SP4', 'SP5', 'SB1', 'SB2', 'SB3', 'SB4', 'SB5',
  ]);
  for (const scenario of simWorldScenarios) {
    for (const deviceId of scenario.devices ?? []) {
      expect(simWorldDevices.some((def) => def.id === deviceId)).toBe(true);
    }
  }
});

test('기대표 리터럴 — sim-world-expect.json graph/* 15행이 모듈 원천과 일치', () => {
  const entries = (expectTable as { entries: Record<string, { expect: string; reason?: string; redReason?: string }> }).entries;
  const graphKeys = Object.keys(entries).filter((key) => key.startsWith('graph/')).sort();
  expect(graphKeys).toEqual(simWorldScenarios.map((scenario) => `graph/${scenario.id}`).sort());
  for (const [id, reason] of Object.entries(SCHEDULE_S1_RED_REASONS)) {
    expect(entries[`graph/${id}`]!.expect).toBe('red');
    expect(entries[`graph/${id}`]!.redReason).toBe(reason);
  }
  for (const id of SCHEDULE_S1_EXPECT_GREEN) expect(entries[`graph/${id}`]!.expect).toBe('green');
});

for (const scenario of simWorldScenarios) {
  const green = SCHEDULE_S1_EXPECT_GREEN.includes(scenario.id);
  test(`${scenario.id} — ${green ? '초록 (엔진 실측 ok:true)' : '빨강 (기대표 리터럴 일치)'}`, async () => {
    const outcome = await scenario.run((await makeCtx(scenario.id)) as never);
    if (green) expect(outcome).toEqual({ ok: true });
    else {
      expect(outcome.ok).toBe(false);
      expect((outcome as { reason?: string }).reason).toBe(SCHEDULE_S1_RED_REASONS[scenario.id as keyof typeof SCHEDULE_S1_RED_REASONS]);
    }
  });
}
