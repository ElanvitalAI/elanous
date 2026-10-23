import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { readJourneyEdge, recordJourneyEdge } from './graph-journey-route.js';
import { runRepairCycle, type RepairLaunchRequest } from '../task-agent/repair-cycle.js';
import { repairNextMove } from '../task-agent/repair-next-move.js';
import { repairHarnessArgs } from '../task-agent/repair-worker.js';
import { readTaskCard, writeTaskCards, type TaskCard } from '../task-agent/task-hand.js';
import { renderFaultNextmoveDispatch, renderFaultNextmoveGeneralRelaunch, simFaultNextmoveDispatch, simFaultNextmoveGeneralRelaunch } from '../ux-sim/fault-nextmove-dispatch.js';
import { recordTaskAgentShadowMove } from '../task-agent/shadow.js';
import { executeNextAction, retryText } from '../task-agent/actions.js';
import { installHarnessCliCommand } from '../harness/harness-cli-command.js';
import { collectTaRepairCompleted, parseTaRepairCompleted } from '../steward/ta-repair-event-collect.js';
import type { SupervisorJobResult } from './run-supervisor.js';

// HARNESS-FULL-GRAPH-NEXTMOVE 첫 조각 — next-move 의 TA repair same-branch 선택 «한 건»은
// 결정(next-move 노드 출구) · graph-edge-taken(next-move→dispatch) · 실제 dispatch(수리 발사 요청)
// 세 원문에서 «같은 move id» 를 공유한다. move id 는 결정 순간 한 번 만들어지고 다시 계산하지 않는다.

const HEAD = 'a'.repeat(40);
const PR = 30;
const now = new Date('2026-10-22T08:00:00.000Z');

function capture() {
  const rows: { event: string; data: Record<string, unknown> }[] = [];
  const off = debug.registerSink({
    name: `nextmove-moveid-${Math.random().toString(16).slice(2)}`,
    emit: (record) => {
      if (record.category === 'self-implement') rows.push({ event: record.event, data: record.data as Record<string, unknown> });
    },
  });
  return { rows, off };
}

test('repairNextMove mints one move id at the dispatch decision and none on stop', () => {
  const minted: string[] = [];
  const mint = () => { const id = `mv-test-${minted.length}`; minted.push(id); return id; };
  const base = { pr: PR, head: HEAD, branch: 'feature', mustFix: ['fix it'], priorAlternativeAttempts: 0 };
  const dispatch = repairNextMove({ ...base, priorNarrowAttempts: 0 }, { mintMoveId: mint });
  expect(dispatch).toMatchObject({ kind: 'dispatch', moveId: 'mv-test-0' });
  const stop = repairNextMove({ ...base, priorNarrowAttempts: 2 }, { mintMoveId: mint });
  expect(stop.kind).toBe('stop');
  expect('moveId' in stop).toBe(false);
  expect(minted).toEqual(['mv-test-0']);
  // 기본 발급기 — 결정마다 다른 id.
  const a = repairNextMove({ ...base, priorNarrowAttempts: 0 });
  const b = repairNextMove({ ...base, priorNarrowAttempts: 0 });
  expect(a.kind === 'dispatch' && a.moveId).toMatch(/^mv-[0-9a-f]{12}$/);
  expect(a.kind === 'dispatch' && b.kind === 'dispatch' && a.moveId !== b.moveId).toBe(true);
});

test('recordJourneyEdge carries a passed move id and stays unchanged without one', () => {
  const { rows, off } = capture();
  try {
    const route = readJourneyEdge('next-move', 'narrow-relaunch', { move: 'narrow-relaunch' });
    recordJourneyEdge(route, 'dispatch', undefined, { moveId: 'mv-fixed' });
    recordJourneyEdge(route, 'dispatch');
  } finally { off(); }
  const edges = rows.filter((row) => row.event === 'graph-edge-taken').map((row) => row.data);
  expect(edges).toHaveLength(2);
  expect(edges[0]).toMatchObject({ from: 'next-move', to: 'dispatch', taken: 'dispatch', moveId: 'mv-fixed' });
  expect('moveId' in edges[1]!).toBe(false);
});

test('one same-branch repair choice shares one move id across decision · graph-edge-taken · dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nextmove-moveid-'));
  const statePath = join(dir, 'task-agent-actions.json');
  const card: TaskCard = { id: 'ta-moveid-1', text: 'fix code', seat: 'TC', createdAt: now.toISOString(), status: 'launched', history: [],
    pr: { number: PR, url: `https://github.com/o/r/pull/${PR}` }, childLlm: { provider: 'openai-codex', model: 'gpt-6-sol' } };
  writeTaskCards(statePath, [card]);
  let mints = 0;
  const launches: RepairLaunchRequest[] = [];
  const { rows, off } = capture();
  try {
    const outcome = await runRepairCycle({ card: readTaskCard(card.id, statePath)!, statePath, repo: dir, pr: PR, head: HEAD,
      branch: 'feature', mustFix: ['fix the broken assertion'], liveMoves: new Set(['narrow-relaunch']), now,
      modelAvailability: { codexSubscription: false, grokSubscription: false },
      mintMoveId: () => { mints++; return 'mv-0123456789ab'; },
      request: async (request) => { launches.push(request); } });
    expect(outcome.decision).toBe('repair-requested');
  } finally { off(); }
  try {
    expect(mints).toBe(1);
    // ③ 실제 dispatch — 수리 발사 요청 한 건 · 같은 PR · 같은 리뷰 머리.
    expect(launches).toHaveLength(1);
    const launch = launches[0]!;
    expect(launch).toMatchObject({ pr: PR, head: HEAD, moveId: 'mv-0123456789ab' });
    // 자식 하니스는 새 PR 을 열지 않는다(commit-only · 같은 가지). move id 는 HQ 쪽 관측 조인 칸이라
    // `harness say` 인자로는 넘기지 않는다(없는 플래그를 넣지 않는다 · 이 조각의 결정).
    const harness = repairHarnessArgs({ card: card.id, pr: PR, head: HEAD, repo: dir, resultPath: launch.resultPath,
      entry: 'elanous', configDir: dir, runId: launch.runId, model: launch.model, goal: 'g', moveId: launch.moveId });
    expect(harness).toContain('--repair-commit-only');
    expect(harness).toContain('--no-auto-merge');
    expect(harness).toContain(`pr:${PR}`);
    expect(harness.some((arg) => arg.includes(launch.moveId))).toBe(false);
    // ① 결정 — next-move 노드 출구.
    const decisions = rows.filter((row) => row.event === 'pipeline-node-exit' && row.data.node === 'next-move').map((row) => row.data);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ outcome: 'narrow-relaunch', runId: launch.runId, moveId: launch.moveId });
    // ② graph-edge-taken next-move→dispatch 한 줄.
    const edges = rows.filter((row) => row.event === 'graph-edge-taken' && row.data.from === 'next-move').map((row) => row.data);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ to: 'dispatch', taken: 'dispatch', honored: true, moveId: launch.moveId });
    // 카드 원장도 같은 id.
    const stored = readTaskCard(card.id, statePath)!;
    expect(stored.repairs?.[0]).toMatchObject({ runId: launch.runId, moveId: launch.moveId, move: 'narrow-relaunch', pr: PR });
    expect(stored.history.find((entry) => entry.event === 'repair-launched')).toMatchObject({ moveId: launch.moveId });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fault-nextmove-dispatch device shows the same move id in the three raw records', async () => {
  const observation = await simFaultNextmoveDispatch();
  expect(observation.moveId.decision).toMatch(/^mv-[0-9a-f]{12}$/);
  expect(observation.moveId.edge).toBe(observation.moveId.decision);
  expect(observation.moveId.dispatch).toBe(observation.moveId.decision);
  // NEXTMOVE-GENERAL-RELAUNCH-MOVEID — 결과 회수 틱(소비)도 같은 값으로 짝지었다.
  expect(observation.moveId.consumed).toBe(observation.moveId.decision);
  console.log(renderFaultNextmoveDispatch(observation).join('\n'));
}, 120_000);

// ── NEXTMOVE-GENERAL-RELAUNCH-MOVEID — 일반 재발사(actions.ts `harness say` 문자열 경로 · shadow.ts) ⊕ 소비 쪽 짝짓기 ──
// 같은 가지 수리(위 시험)는 #30226 으로 결정·간선·발사가 같은 move id 를 쓴다. 이 조각은
// ① 일반 재발사 한 건이 결정·graph-edge-taken·발사 argv(`--move-id`)·카드 history 네 곳에서 같은 move id 를 쓰고
// ② 결과 파일·`ta.repair.completed` 를 읽는 소비 쪽이 카드의 move id 와 짝짓는다(못 짝지으면 관측 줄 · fail-soft).

function generalFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nextmove-general-'));
  const statePath = join(dir, 'task-agent-actions.json');
  const card: TaskCard = { id: 'ta-general-1', text: 'feature ask', seat: 'TC', createdAt: now.toISOString(), status: 'launched',
    history: [], runId: 'run-general-1' };
  writeTaskCards(statePath, [card]);
  return { dir, statePath, card };
}

const job = (): SupervisorJobResult => ({ taskId: 't', feature: 'feature ask', status: 'done' }) as SupervisorJobResult;

test('one general relaunch shares one move id across decision · graph-edge-taken · launch argv · card history', async () => {
  const f = generalFixture();
  const commands: string[][] = [];
  let mints = 0;
  const { rows, off } = capture();
  let out;
  try {
    out = await recordTaskAgentShadowMove({ runId: 'run-general-1', stopReason: 'no-progress', results: [job()] }, {
      env: {}, statePath: f.statePath, log: () => {}, liveMoves: new Set(['narrow-relaunch']),
      loadGate: { loadMax: 2, load1: () => 0.5 },
      command: async (args) => { commands.push(args); return { status: 0, stdout: '' }; },
      mintMoveId: () => { mints++; return 'mv-feedc0ffee00'; },
    });
  } finally { off(); }
  try {
    expect(out).toMatchObject({ move: 'narrow-relaunch', executorResult: 'done', moveId: 'mv-feedc0ffee00' });
    expect(mints).toBe(1);
    // ③ 발사 argv — 같은 값을 `--move-id` 로.
    expect(commands).toHaveLength(1);
    expect(commands[0]!.slice(0, 2)).toEqual(['harness', 'say']);
    const at = commands[0]!.indexOf('--move-id');
    expect(at).toBeGreaterThan(2);
    expect(commands[0]![at + 1]).toBe('mv-feedc0ffee00');
    // ① 결정 — next-move 노드 출구.
    const decisions = rows.filter((row) => row.event === 'pipeline-node-exit' && row.data.node === 'next-move').map((row) => row.data);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ outcome: 'narrow-relaunch', runId: 'run-general-1', moveId: 'mv-feedc0ffee00' });
    // ② graph-edge-taken next-move→dispatch.
    const edges = rows.filter((row) => row.event === 'graph-edge-taken' && row.data.from === 'next-move').map((row) => row.data);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ to: 'dispatch', taken: 'dispatch', honored: true, moveId: 'mv-feedc0ffee00' });
    // ④ 카드 history — 발사 결과(완료) 한 줄이 같은 값.
    const stored = readTaskCard(f.card.id, f.statePath)!;
    expect(stored.history.filter((entry) => entry.event === 'relaunch-launched')).toEqual([
      expect.objectContaining({ runId: 'run-general-1', effect: 'narrow-relaunch', moveId: 'mv-feedc0ffee00' })]);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('a shadow (not launched) general relaunch mints no move id and adds no --move-id', async () => {
  let mints = 0;
  const commands: string[][] = [];
  const out = await recordTaskAgentShadowMove({ runId: 'run-general-shadow', stopReason: 'no-progress', results: [job()] }, {
    env: {}, readCard: () => undefined, log: () => {}, liveMoves: new Set(),
    loadGate: { loadMax: 2, load1: () => 0.5 },
    command: async (args) => { commands.push(args); return { status: 0, stdout: '' }; },
    mintMoveId: () => { mints++; return 'mv-000000000000'; },
  });
  expect(out.executorResult).toBe('shadow');
  expect(mints).toBe(0);
  expect(commands).toHaveLength(0);
  expect('moveId' in out).toBe(false);
});

test('executeNextAction passes a given move id to harness say argv and keeps the old argv without one', async () => {
  const calls: string[][] = [];
  const deps = { mode: 'live', command: async (args: string[]) => { calls.push(args); return { status: 0, stdout: '' }; }, observe: () => {} };
  const action = { kind: 'retry' as const, variant: 'narrow' as const, taskId: 'run-x', rationale: 'r', pr: 0, runId: 'run-x', original: 'goal', checklistId: '' };
  await executeNextAction({ ...action, moveId: 'mv-0123456789ab' }, deps);
  await executeNextAction(action, deps);
  expect(calls[0]!.slice(-2)).toEqual(['--move-id', 'mv-0123456789ab']);
  expect(calls[1]).toEqual(['harness', 'say', retryText(action)]);
});

test('harness say accepts --move-id and records it as the launch receipt (observation only)', async () => {
  const received: string[][] = [];
  const program = new Command();
  program.exitOverride();
  installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness',
    say: async (words: string[]) => { received.push(words); } } as never);
  const logs: Record<string, unknown>[] = [];
  const off = debug.registerSink({ name: `nextmove-say-${Math.random().toString(16).slice(2)}`, emit: (record) => {
    if (record.category === 'harness' && record.event === 'move-id-received') logs.push(record.data as Record<string, unknown>);
  } });
  try {
    await program.parseAsync(['node', 'elanous', 'harness', 'say', 'write', 'goal', '--move-id', 'mv-0123456789ab']);
  } finally { off(); }
  expect(received).toEqual([['write', 'goal']]);
  expect(logs).toEqual([expect.objectContaining({ entrance: 'cli-harness-say', moveId: 'mv-0123456789ab' })]);
});

function repairResultFixture(resultMoveId: string | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'nextmove-consume-'));
  const statePath = join(dir, 'task-agent-actions.json');
  const resultPath = join(dir, 'repair.json');
  const card: TaskCard = { id: 'ta-consume-1', text: 'fix code', seat: 'TC', createdAt: now.toISOString(), status: 'launched', history: [],
    pr: { number: PR, url: `https://github.com/o/r/pull/${PR}` }, childLlm: { provider: 'openai-codex', model: 'gpt-6-sol' },
    repairs: [{ pr: PR, head: HEAD, branch: 'feature', at: now.toISOString(), move: 'narrow-relaunch', moveId: 'mv-aaaaaaaaaaaa',
      runId: 'run-r1', resultPath, fromModel: 'a', toModel: 'glm/glm-5.3', status: 'requested' }] };
  writeTaskCards(statePath, [card]);
  writeFileSync(resultPath, JSON.stringify({ pr: PR, head: HEAD, runId: 'run-r1', ok: false, reason: 'worker failed',
    ...(resultMoveId ? { moveId: resultMoveId } : {}) }));
  return { dir, statePath, resultPath, card };
}

function captureTaskAgent() {
  const rows: { event: string; data: Record<string, unknown> }[] = [];
  const off = debug.registerSink({ name: `nextmove-ta-${Math.random().toString(16).slice(2)}`, emit: (record) => {
    if (record.category === 'task-agent') rows.push({ event: record.event, data: record.data as Record<string, unknown> });
  } });
  return { rows, off };
}

async function consumeOnce(f: ReturnType<typeof repairResultFixture>) {
  return runRepairCycle({ card: readTaskCard(f.card.id, f.statePath)!, statePath: f.statePath, repo: f.dir, pr: PR, head: HEAD,
    branch: 'feature', mustFix: ['x'], liveMoves: new Set(['narrow-relaunch']), now,
    modelAvailability: { codexSubscription: false, grokSubscription: false }, request: async () => { throw new Error('no relaunch'); } });
}

test('repair result consumption pairs the result file move id with the card move id', async () => {
  const f = repairResultFixture('mv-aaaaaaaaaaaa');
  const { rows, off } = captureTaskAgent();
  try {
    expect((await consumeOnce(f)).decision).toBe('repair-failed');
    const stored = readTaskCard(f.card.id, f.statePath)!;
    expect(stored.history.find((entry) => entry.event === 'repair-result')).toMatchObject({ runId: 'run-r1', moveId: 'mv-aaaaaaaaaaaa' });
    expect(rows.filter((row) => row.event === 'move-id-unpaired')).toHaveLength(0);
  } finally { off(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('repair result consumption with a differing move id still consumes (fail-soft) and leaves an unpaired observation', async () => {
  const f = repairResultFixture('mv-bbbbbbbbbbbb');
  const { rows, off } = captureTaskAgent();
  try {
    expect((await consumeOnce(f)).decision).toBe('repair-failed');
    const result = readTaskCard(f.card.id, f.statePath)!.history.find((entry) => entry.event === 'repair-result')!;
    expect('moveId' in result).toBe(false);
    expect(rows.filter((row) => row.event === 'move-id-unpaired').map((row) => row.data)).toEqual([
      expect.objectContaining({ card: f.card.id, runId: 'run-r1', source: 'result-file', expected: 'mv-aaaaaaaaaaaa', observed: 'mv-bbbbbbbbbbbb' })]);
  } finally { off(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('ta.repair.completed collection pairs the event move id with the card and stays fail-soft when it differs', async () => {
  const f = repairResultFixture('mv-aaaaaaaaaaaa');
  try {
    const event = { kind: 'ta.repair.completed', schema: 1, card: f.card.id, pr: PR, head: HEAD, runId: 'run-r1',
      resultPath: f.resultPath, completedAt: now.toISOString() };
    expect(parseTaRepairCompleted({ ...event, moveId: 'mv-aaaaaaaaaaaa' })).toMatchObject({ moveId: 'mv-aaaaaaaaaaaa' });
    const observations: Record<string, unknown>[] = [];
    let runs = 0;
    const deps = { statePath: f.statePath, log: (row: Record<string, unknown>) => observations.push(row),
      run: async () => { runs++; return { code: 0, output: '' }; } };
    await collectTaRepairCompleted({ ...event, moveId: 'mv-aaaaaaaaaaaa' }, deps);
    await collectTaRepairCompleted({ ...event, moveId: 'mv-cccccccccccc' }, deps);
    expect(runs).toBe(2);
    expect(observations.map((row) => ({ moveId: row.moveId, moveIdPaired: row.moveIdPaired }))).toEqual([
      { moveId: 'mv-aaaaaaaaaaaa', moveIdPaired: true }, { moveId: 'mv-cccccccccccc', moveIdPaired: false }]);
    // 카드 귀속이 안 맞는 사건(invalid)엔 짝짓기 칸이 없다.
    expect(await collectTaRepairCompleted({ ...event, pr: PR + 1, moveId: 'mv-aaaaaaaaaaaa' }, deps)).toBe('invalid');
    expect(observations.at(-1)).toMatchObject({ outcome: 'invalid' });
    expect('moveIdPaired' in observations.at(-1)!).toBe(false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('fault-nextmove-dispatch general relaunch device shows one move id at decision · edge · argv · card history', async () => {
  const observation = await simFaultNextmoveGeneralRelaunch();
  expect(observation.moveId.decision).toMatch(/^mv-[0-9a-f]{12}$/);
  expect(observation.moveId.edge).toBe(observation.moveId.decision);
  expect(observation.moveId.dispatch).toBe(observation.moveId.decision);
  expect(observation.moveId.consumed).toBe(observation.moveId.decision);
  console.log(renderFaultNextmoveGeneralRelaunch(observation).join('\n'));
}, 120_000);
