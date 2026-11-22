// ROUTER-QUALITY-GUARD-95 팩 등록 시험 — jud-39614 mustFix ①②③ 착지 등록 반증.
// 팩 yaml(worlds/sim-world-router-cost.yaml) 행 + 기대표(worlds/sim-world-expect.json) green 행을 literal lock 한다.
// RED 우선: 등록 전에는 아래 단언이 실패한다(등록 커밋으로 GREEN). 출처: #39641 — 팩 yaml 4행·greenSince literal lock(jud-39614 e00bc107ef1f).

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseSimWorldExpectTable } from '../expect.js';
import { isReservedSimWorldId } from '../kernel.js';
import { simWorldScenarios } from './quality-scenarios.js';

test('router-cost 팩은 ROUTER-QUALITY-GUARD-95(mustFix ①②③)를 quality-scenarios 모듈로 등록한다', () => {
  const world = join(import.meta.dir, '../../worlds');
  const pack = parseYaml(readFileSync(join(world, 'sim-world-router-cost.yaml'), 'utf8'));
  expect(isReservedSimWorldId('router-cost')).toBe(true);
  expect(pack.world).toBe('router-cost');
  expect(pack.scenarios).toEqual([
    { id: 'ROUTER-COST-LEDGER', module: 'src/ux-sim/sim-world/router-cost/scenarios.ts' },
    { id: 'ROUTER-COST-LOCK-RECOVERY', module: 'src/ux-sim/sim-world/router-cost/scenarios.ts' },
    { id: 'ROUTER-OR-CODEX-MIX-CHOKEPOINT', module: 'src/ux-sim/sim-world/router-cost/mix-scenarios.ts' },
    { id: 'ROUTER-QUALITY-GUARD-95', module: 'src/ux-sim/sim-world/router-cost/quality-scenarios.ts' },
  ]);
  expect(simWorldScenarios.map(row => row.id)).toEqual(['ROUTER-QUALITY-GUARD-95']);
});

test('기대표 — router-cost/ROUTER-QUALITY-GUARD-95 green 행(이 PR로 신규 착지)', () => {
  const world = join(import.meta.dir, '../../worlds');
  const table = parseSimWorldExpectTable(readFileSync(join(world, 'sim-world-expect.json'), 'utf8'));
  expect(table.entries['router-cost/ROUTER-QUALITY-GUARD-95']).toEqual({
    expect: 'green',
    reason: 'lightweight-first guarded routing: per-task premium shadow comparison (exactly one premium evaluation per task, reused as the delivered score on gate failure), per-task-type floors (chat 0.90, unregistered fallback 0.95) and the daily ledger recalc surface land together (jud-39614 mustFix ①②③)',
    greenSince: '2026-11-23 PR #39641 (ROUTER-QUALITY-GUARD-95 mustFix ①②③ — 이 PR로 신규 착지)',
  });
});