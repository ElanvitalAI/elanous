// M01–M12 run through the real runGraph with D17 behind the GRAPH-MEMORY-SCOPES port (deps.memory). The runner now calls
// the port, so M01–M08, M11 and M12 are green and M09, M10 are xfail with the literal reason the judge observes
// (the first mismatching observation key). Rule 11: every expected value below is an independent literal.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryDevice, judgeMemoryScenario, MEMORY_SCENARIOS, runMemoryScenario, simWorldDevices, simWorldScenarios } from './scenarios.js';
import type { SimWorldRecorder, SimWorldScenarioContext } from '../types.js';

const TITLES = [
  ['M01', '같은 런 쓰기→읽기'], ['M02', '인스턴스→템플릿 promote(승인 관문)'], ['M03', '광역 promote 는 승인 뒤에만'],
  ['M04', '같은 템플릿 다음 런'], ['M05', '그래프·테넌트 격리'], ['M06', '동시 쓰기'], ['M07', '쓰기 중 사망'],
  ['M08', '재개가 기억 보존'], ['M09', '감독자 자기 범위'], ['M10', '⑦remember 단위 쓰기 + 회상'], ['M11', '보존·만료'],
  ['M12', 'TA 노하우 주입'], ['M25', '자리 키 template promote (seat:<SEAT>)'],
] as const;
// id → [expected, red reason literal | '']
const TABLE: Record<string, readonly ['green' | 'red', string]> = {
  M01: ['green', ''], M02: ['green', ''], M03: ['green', ''], M04: ['green', ''], M05: ['green', ''], M06: ['green', ''],
  M07: ['green', ''], M08: ['green', ''], M09: ['red', 'expectation-mismatch: tick2SeesTick1'],
  M10: ['red', 'expectation-mismatch: recalled'], M11: ['green', ''], M12: ['green', ''], M25: ['green', ''],
};

test('the memory world registers exactly M01–M12 with the measured green/red split', () => {
  expect(MEMORY_SCENARIOS.map(s => [s.id, s.title])).toEqual(TITLES.map(([id, title]) => [id, title]));
  expect(MEMORY_SCENARIOS.map(s => `${s.expected} | ${s.reason}`)).toEqual(TITLES.map(([id]) => `${TABLE[id]![0]} | ${TABLE[id]![1]}`));
});

for (const [id] of TITLES) test(`${id} through runGraph: the runner calls the port and the verdict is ${TABLE[id]![0] === 'green' ? 'pass' : 'xfail'}`, async () => {
  const verdict = await runMemoryScenario(MEMORY_SCENARIOS.find(s => s.id === id)!);
  const [expected, reason] = TABLE[id]!;
  expect([verdict.verdict, verdict.reason]).toEqual(expected === 'green' ? ['pass', 'as expected'] : ['xfail', reason]);
  expect(verdict.runnerPortCalls > 0).toBe(true);
}, 30_000);

test('replay: the same scenario twice leaves a byte-identical D17 snapshot', async () => {
  const m04 = MEMORY_SCENARIOS.find(s => s.id === 'M04')!;
  const [first, second] = [await runMemoryScenario(m04), await runMemoryScenario(m04)];
  expect(first.storeSnapshot === second.storeSnapshot).toBe(true);
  expect(JSON.parse(first.storeSnapshot!).rows.map((row: { id: string; text: string; expiresAt: string }) => [row.id, row.text, row.expiresAt]))
    .toEqual([['mem-1', 'm04-promoted', '2026-11-20T00:00:00.000Z'], ['mem-2', 'm04-promoted', '2026-12-19T00:00:00.000Z']]);
}, 30_000);

test('kernel hook: D17 device and M01–M12 rows; a red returns the observed literal reason and the walk is recorded', async () => {
  expect(simWorldDevices.map(d => d.id)).toEqual(['D17']);
  expect(simWorldScenarios.map(s => [s.id, s.devices, s.engines])).toEqual(TITLES.map(([id]) => [id, ['D17'], undefined]));
  const walk: string[] = [];
  const seams: string[] = [];
  const recorder = { event() {}, step() {}, seam: (name: string) => { seams.push(name); },
    onNodeEntry() {}, onProgress() {}, nodeLifecycle: (event: { phase: string; nodeId: string }) => {
      if (event.phase === 'arrival') walk.push(event.nodeId);
    } } as unknown as SimWorldRecorder;
  const device = createMemoryDevice();
  const ctx = { world: 'memory', scenarioId: 'M09', seed: 1, engine: 'legacy', universeRoot: mkdtempSync(join(tmpdir(), 'sim-memory-kernel-')),
    recorder, random: () => 0.5, device: () => device } as unknown as SimWorldScenarioContext;
  try {
    const m01 = { ...ctx, scenarioId: 'M01' } as unknown as SimWorldScenarioContext;
    expect(await simWorldScenarios[0]!.run(m01)).toEqual({ ok: true });
    expect(await simWorldScenarios[8]!.run(ctx)).toEqual({ ok: false, reason: 'expectation-mismatch: tick2SeesTick1',
      diff: 'M09: expected {"tick2SeesTick1":true,"tick3SeesTick2":true,"otherSupervisorSees":0} · observed {"tick2SeesTick1":false,"tick3SeesTick2":false,"otherSupervisorSees":0}' });
    expect(walk.includes('tick')).toBe(true);
    expect(seams.includes('memory.write')).toBe(true);
  } finally { rmSync(ctx.universeRoot, { recursive: true, force: true }); }
}, 30_000);

test('a store write failure makes the verdict infra-error, not a silent pass or xfail', async () => {
  const verdict = await runMemoryScenario(MEMORY_SCENARIOS.find(s => s.id === 'M04')!, { injectStoreFault: true });
  expect([verdict.verdict, verdict.reason]).toEqual(['infra-error', 'store-fault: memory write failed (injected)']);
  expect(verdict.events.map(e => e.type)).toEqual(['memory.fault']);
}, 30_000);

const row = { id: 'MX', expected: 'red' as const, reason: 'runner made no memory port call', expect: { lines: ['a'] } };
const JUDGE_CASES = [
  ['red · no runner call · mismatch → xfail', row, { observed: { lines: [] }, faults: [], runnerPortCalls: 0 },
    ['xfail', 'runner made no memory port call']],
  ['red · runner called · mismatch → wrong-reason fail', row, { observed: { lines: ['b'] }, faults: [], runnerPortCalls: 2 },
    ['wrong-reason-red', 'wrong-reason-red: expectation-mismatch: lines']],
  ['red · matches → promote-required', row, { observed: { lines: ['a'] }, faults: [], runnerPortCalls: 1 },
    ['promote-required', 'expected red is green: flip the expectation row in this PR']],
  ['green · matches → pass', { ...row, expected: 'green' as const }, { observed: { lines: ['a'] }, faults: [], runnerPortCalls: 1 },
    ['pass', 'as expected']],
  ['green · mismatch → fail', { ...row, expected: 'green' as const }, { observed: { lines: [] }, faults: [], runnerPortCalls: 1 },
    ['fail', 'expectation-mismatch: lines']],
  ['crash → infra-error', row, { crash: 'boom', faults: [], runnerPortCalls: 0 }, ['infra-error', 'scenario-crashed: boom']],
  ['store fault beats a matching observation → infra-error', row, { observed: { lines: ['a'] }, faults: ['disk gone'], runnerPortCalls: 1 },
    ['infra-error', 'store-fault: disk gone']],
] as const;
for (const [name, scenario, outcome, expected] of JUDGE_CASES) test(`judge: ${name}`, () => {
  const verdict = judgeMemoryScenario(scenario, { ...outcome, faults: [...outcome.faults] });
  expect([verdict.verdict, verdict.reason]).toEqual([...expected]);
});
