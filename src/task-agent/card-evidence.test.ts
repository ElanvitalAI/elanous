import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTasksCommands } from '../cli/tasks-cli.js';
import { debug } from '../debug/log.js';
import { appendRunLedgerEntry, loadRunLedger, type RunLedgerEntry } from '../self-implement/run-ledger.js';
import { bindCardEvidence, ledgerLoader, refreshCardRunBinding, type CardRunEvidenceDeps } from './card-evidence.js';
import { advanceMission, handMission, type PieceEvidenceReader } from './mission.js';
import { handTask, readTaskCard, type TaskLaunchContext } from './task-hand.js';

const RUN = 'run-0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const CHILD = 'run-0199ffff-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const GOAL = '0123456789abcdef';
const URL_77 = 'https://github.com/o/r/pull/77';

function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'task-card-evidence-')), 'task-agent-actions.json');
}

function entry(runId: string, event: string, data: Record<string, unknown> = {}, goalId?: string): RunLedgerEntry {
  return { runId, event, data, timestamp: '2026-10-07T01:00:00.000Z', ...(goalId ? { goalId } : {}) };
}

function ledgers(map: Record<string, RunLedgerEntry[]>, finishes: Array<{ childRunId: string; prUrl: string }> = []): CardRunEvidenceDeps & { loads: string[] } {
  const loads: string[] = [];
  return { loads, loadLedger: (runId) => { loads.push(runId); return map[runId] ?? null; }, podFinishes: (ids) => finishes.filter((row) => ids.includes(row.childRunId)) };
}

/** 가짜 발사기 — 받은 런 id 를 영수증으로 돌려준다(실 발사기와 같은 계약). */
function fakeLauncher(): { launcher: (args: string[], cwd?: string, context?: TaskLaunchContext) => { runId?: string }; contexts: TaskLaunchContext[] } {
  const contexts: TaskLaunchContext[] = [];
  return { contexts, launcher: (_args, _cwd, context) => { contexts.push(context!); return { runId: context!.runId }; } };
}

async function cli(args: string[], deps: Parameters<typeof registerTasksCommands>[1]): Promise<{ lines: string[]; code: number | string | undefined }> {
  const lines: string[] = [];
  const program = new Command().name('elanous').exitOverride();
  registerTasksCommands(program, { registerSink: async () => true, ...deps, output: (line) => lines.push(line) });
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'elanous', ...args]);
    return { lines, code: process.exitCode };
  } finally { process.exitCode = previous ?? 0; }
}

test('live hand: 발사기가 받은 런 id 를 카드에 한 번 적고 env 로 넘긴다 · run-bound 관측', async () => {
  const path = statePath();
  const { launcher, contexts } = fakeLauncher();
  const logged: Array<[string, Record<string, unknown>]> = [];
  const original = debug.log;
  (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => { if (category === 'task-agent') logged.push([event, data ?? {}]); }) as typeof debug.log;
  try {
    const { card } = await handTask({ text: 'ship it', live: true, statePath: path, launcher });
    expect(contexts).toHaveLength(1);
    const ctx = contexts[0]!;
    expect(ctx.runId).toMatch(/^run-[0-9a-f-]{36}$/);
    expect(ctx.env).toEqual({ ELANOUS_RUN_ID: ctx.runId });
    expect(ctx.launchId).toMatch(/^tl-[0-9a-f]{12}$/);
    const disk = readTaskCard(card.id, path)!;
    expect(disk).toMatchObject({ status: 'launched', runId: ctx.runId, launchId: ctx.launchId });
    expect(disk.history.map((event) => event.event)).toEqual(['launch', 'run-bound']);
    expect(disk.history[1]).toMatchObject({ runId: ctx.runId });
    expect(logged.find(([event]) => event === 'card-run-bound')?.[1]).toEqual({ card: card.id, runId: ctx.runId, launchId: ctx.launchId });
  } finally { (debug as { log: typeof debug.log }).log = original; }
});

test('발사기가 영수증을 안 주면 런 id 를 적지 않는다 · shadow 는 아무것도 묶지 않는다', async () => {
  const path = statePath();
  const silent = await handTask({ text: 'ship it', live: true, statePath: path, launcher: () => {} });
  expect(readTaskCard(silent.card.id, path)?.runId).toBeUndefined();
  expect(readTaskCard(silent.card.id, path)?.history.map((event) => event.event)).toEqual(['launch']);
  const { launcher, contexts } = fakeLauncher();
  const shadow = await handTask({ text: 'just look', statePath: path, launcher });
  expect(contexts).toHaveLength(0);
  const card = readTaskCard(shadow.card.id, path)!;
  expect(card.runId).toBeUndefined();
  expect(card.launchId).toBeUndefined();
  expect(card.history).toEqual([]);
});

test('bindCardEvidence: 호스트 원장 pr-opened · 골 id', () => {
  const evidence = bindCardEvidence({ runId: RUN }, { host: [entry(RUN, 'start', { feature: 'x' }, GOAL), entry(RUN, 'pr-opened', { number: 77, url: URL_77 })], children: {} });
  expect(evidence).toEqual({ ledgerFound: true, goalId: GOAL, pr: { number: 77, url: URL_77 } });
});

test('bindCardEvidence: Pod — 자식 원장 · 없으면 job-finished(childRunId) · 원장 없으면 비움', () => {
  const host = [entry(RUN, 'start'), entry(RUN, 'pod-child-run', { childRunId: CHILD })];
  expect(bindCardEvidence({ runId: RUN }, { host, children: { [CHILD]: [entry(CHILD, 'pr-opened', { number: 77, url: URL_77, goalId: GOAL })] } }))
    .toEqual({ ledgerFound: true, goalId: GOAL, pr: { number: 77, url: URL_77 }, childRunId: CHILD });
  expect(bindCardEvidence({ runId: RUN }, { host, children: { [CHILD]: null }, podFinishes: [{ childRunId: CHILD, prUrl: URL_77 }] }))
    .toEqual({ ledgerFound: true, pr: { number: 77, url: URL_77 }, childRunId: CHILD });
  // Pod 런인데 PR 이 아직 없으면 호스트 골도 묶지 않는다.
  expect(bindCardEvidence({ runId: RUN }, { host: [entry(RUN, 'start', {}, GOAL), ...host.slice(1)], children: { [CHILD]: null } })).toEqual({ ledgerFound: true });
  // 다른 런의 job-finished 는 안 읽는다.
  expect(bindCardEvidence({ runId: RUN }, { host, children: {}, podFinishes: [{ childRunId: 'run-other-1234', prUrl: URL_77 }] })).toEqual({ ledgerFound: true });
  expect(bindCardEvidence({ runId: RUN }, { host: null, children: {} })).toEqual({ ledgerFound: false });
  expect(bindCardEvidence({}, { host, children: {} })).toEqual({ ledgerFound: false });
});

test('refresh: 원장의 PR 을 카드에 한 번 적고 card-pr-bound · 원장 없으면 그대로', async () => {
  const path = statePath();
  const { launcher } = fakeLauncher();
  const { card } = await handTask({ text: 'ship it', live: true, statePath: path, launcher });
  const runId = readTaskCard(card.id, path)!.runId!;
  const none = await refreshCardRunBinding(card.id, path, ledgers({}));
  expect(none.evidence).toEqual({ ledgerFound: false });
  expect(readTaskCard(card.id, path)?.pr).toBeUndefined();
  const logged: Array<[string, Record<string, unknown>]> = [];
  const original = debug.log;
  (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => { if (category === 'task-agent') logged.push([event, data ?? {}]); }) as typeof debug.log;
  try {
    const deps = ledgers({ [runId]: [entry(runId, 'start', {}, GOAL), entry(runId, 'pr-opened', { number: 77, url: URL_77 })] });
    await refreshCardRunBinding(card.id, path, deps);
    const bound = readTaskCard(card.id, path)!;
    expect(bound).toMatchObject({ goalId: GOAL, pr: { number: 77, url: URL_77 } });
    expect(bound.history.map((event) => event.event)).toEqual(['launch', 'run-bound', 'goal-bound', 'pr-bound']);
    expect(logged.find(([event]) => event === 'card-pr-bound')?.[1]).toMatchObject({ card: card.id, runId, pr: 77 });
    // 이미 묶였으면 원장을 다시 읽지 않는다(한 번만).
    const again = ledgers({ [runId]: [entry(runId, 'pr-opened', { number: 99 })] });
    await refreshCardRunBinding(card.id, path, again);
    expect(again.loads).toEqual([]);
    expect(readTaskCard(card.id, path)?.pr).toEqual({ number: 77, url: URL_77 });
  } finally { (debug as { log: typeof debug.log }).log = original; }
});

test('tasks show 는 런 · 골 · PR 을 보인다(Pod 자식 경로) · 옛 카드는 줄이 없다', async () => {
  const path = statePath();
  const { launcher } = fakeLauncher();
  const { card } = await handTask({ text: 'ship it', live: true, statePath: path, launcher });
  const runId = readTaskCard(card.id, path)!.runId!;
  const deps = ledgers({ [runId]: [entry(runId, 'start', {}, GOAL), entry(runId, 'pod-child-run', { childRunId: CHILD })] }, [{ childRunId: CHILD, prUrl: URL_77 }]);
  const shown = await cli(['tasks', 'show', card.id], { taskStatePath: path, cardRunEvidence: deps });
  expect(shown.code ?? 0).toBe(0);
  // 자식 PR 은 job-finished 로만 알았다 — 자식 원장의 골이 없으니 골은 비운다(호스트 골을 섞지 않는다).
  expect(shown.lines).toContain(`런: ${runId} · 골: - · PR: #77 ${URL_77} · 자식 런: ${CHILD}`);
  const old = await handTask({ text: 'old card', statePath: path });
  const plain = await cli(['tasks', 'show', old.card.id], { taskStatePath: path, cardRunEvidence: deps });
  expect(plain.lines.some((line) => line.startsWith('런:'))).toBe(false);
});

test('미션 ②: 묶인 PR 이 병합이면 --pr 없이 다음 조각을 넘긴다 · 수동 --pr 이 덮는다', async () => {
  const path = statePath();
  const { launcher } = fakeLauncher();
  const { mission } = await handMission({ text: '- one\n- two (after: 1)', live: true, statePath: path, launcher });
  const first = `${mission.id}-1`;
  const runId = readTaskCard(first, path)!.runId!;
  expect(runId).toBeTruthy();
  const reads: Array<number | string> = [];
  const prs: PieceEvidenceReader = async (ref) => { reads.push(ref); return ref === 77 ? 'merged' : 'waiting'; };
  const runEvidence = ledgers({ [runId]: [entry(runId, 'pr-opened', { number: 77, url: URL_77 })] });
  const shown = await cli(['tasks', 'advance', mission.id, '--live', '--json'], { taskStatePath: path, taskLauncher: launcher, pieceEvidence: prs, cardRunEvidence: runEvidence });
  expect(shown.code ?? 0).toBe(0);
  const result = JSON.parse(shown.lines[0]!);
  expect(result.landed).toEqual([first]);
  expect(result.handed.map((piece: { pieceId: string }) => piece.pieceId)).toEqual([`${mission.id}-2`]);
  expect(reads).toContain(77);
  // 수동 근거가 런 근거를 덮는다.
  const path2 = statePath();
  const two = await handMission({ text: '- a\n- b (after: 1)', live: true, statePath: path2, launcher });
  const runA = readTaskCard(`${two.mission.id}-1`, path2)!.runId!;
  const reads2: Array<number | string> = [];
  const manual = await cli(['tasks', 'advance', two.mission.id, '--pr', `${two.mission.id}-1=5`, '--json'], {
    taskStatePath: path2, pieceEvidence: async (ref) => { reads2.push(ref); return 'waiting'; },
    cardRunEvidence: ledgers({ [runA]: [entry(runA, 'pr-opened', { number: 77 })] }),
  });
  expect(manual.code ?? 0).toBe(0);
  expect(reads2).toEqual([5]);
});

test('미션 ②: 원장이 없으면 근거 없음 — 넘기지 않는다', async () => {
  const path = statePath();
  const { launcher } = fakeLauncher();
  const { mission } = await handMission({ text: '- one\n- two (after: 1)', live: true, statePath: path, launcher });
  const result = await advanceMission(mission.id, { statePath: path, live: true, launcher, readEvidence: async () => 'merged', runEvidence: ledgers({}) });
  expect(result.evidence[`${mission.id}-1`]).toBe('no-ref');
  expect(result.handed).toEqual([]);
  expect(readTaskCard(`${mission.id}-1`, path)?.pr).toBeUndefined();
});

test('수동 --pr 이 Pod 묶음을 교체하면 자식 런 연결도 지운다 · show 는 수동 PR 만 보인다', async () => {
  const path = statePath();
  const { launcher } = fakeLauncher();
  const { mission } = await handMission({ text: '- one\n- two (after: 1)', live: true, statePath: path, launcher });
  const first = `${mission.id}-1`;
  const runId = readTaskCard(first, path)!.runId!;
  const deps = ledgers({ [runId]: [entry(runId, 'start', {}, GOAL), entry(runId, 'pod-child-run', { childRunId: CHILD })] }, [{ childRunId: CHILD, prUrl: URL_77 }]);
  await refreshCardRunBinding(first, path, deps);
  expect(readTaskCard(first, path)).toMatchObject({ pr: { number: 77, url: URL_77 }, runChildId: CHILD });
  const manual = await cli(['tasks', 'advance', mission.id, '--pr', `${first}=5`, '--json'], { taskStatePath: path, pieceEvidence: async () => 'waiting', cardRunEvidence: deps });
  expect(manual.code ?? 0).toBe(0);
  const card = readTaskCard(first, path)!;
  expect(card).toMatchObject({ pr: 5, refSource: 'manual' });
  expect(card.runChildId).toBeUndefined();
  const shown = await cli(['tasks', 'show', first], { taskStatePath: path, cardRunEvidence: deps });
  expect(shown.lines).toContain(`런: ${runId} · 골: - · PR: #5`);
});

test('영수증 런 id 가 넘긴 id 와 다르면 묶지 않는다', async () => {
  const path = statePath();
  const { card } = await handTask({ text: 'ship it', live: true, statePath: path, launcher: () => ({ runId: 'run-someone-else-1234' }) });
  expect(readTaskCard(card.id, path)?.runId).toBeUndefined();
});

test('미션 ②: PR 이 먼저 묶이고 골 id 가 나중에 생기면 advance 가 골 id 도 묶는다', async () => {
  const path = statePath();
  const { launcher } = fakeLauncher();
  const { mission } = await handMission({ text: '- one\n- two (after: 1)', live: true, statePath: path, launcher });
  const first = `${mission.id}-1`;
  const runId = readTaskCard(first, path)!.runId!;
  const prOnly = [entry(runId, 'pr-opened', { url: URL_77, number: 77, branch: 'b', draft: true })];
  await advanceMission(mission.id, { statePath: path, readEvidence: async () => 'waiting', runEvidence: ledgers({ [runId]: prOnly }) });
  expect(readTaskCard(first, path)).toMatchObject({ pr: { number: 77, url: URL_77 } });
  expect(readTaskCard(first, path)?.goalId).toBeUndefined();
  await advanceMission(mission.id, { statePath: path, readEvidence: async () => 'waiting', runEvidence: ledgers({ [runId]: [...prOnly, entry(runId, 'merged', { merged: true }, GOAL)] }) });
  expect(readTaskCard(first, path)).toMatchObject({ pr: { number: 77, url: URL_77 }, goalId: GOAL });
});

test('실제 원장 쓰기·읽기(appendRunLedgerEntry · loadRunLedger) 형식으로 Pod 자식 PR 을 묶는다', async () => {
  const path = statePath();
  const dir = mkdtempSync(join(tmpdir(), 'task-card-ledger-'));
  const { launcher } = fakeLauncher();
  const { card } = await handTask({ text: 'ship it', live: true, statePath: path, launcher });
  const runId = readTaskCard(card.id, path)!.runId!;
  appendRunLedgerEntry({ runId, event: 'pod-child-run', data: { childRunId: CHILD, job: 'job-1', attempt: 1 } }, dir);
  appendRunLedgerEntry({ runId: CHILD, event: 'start', goalId: GOAL, data: { feature: 'ship it' } }, dir);
  appendRunLedgerEntry({ runId: CHILD, event: 'pr-opened', goalId: GOAL, data: { url: URL_77, number: 77, branch: 'elanous/x', draft: true } }, dir);
  await refreshCardRunBinding(card.id, path, { loadLedger: (id) => loadRunLedger(id, dir), podFinishes: () => [] });
  expect(readTaskCard(card.id, path)).toMatchObject({ goalId: GOAL, pr: { number: 77, url: URL_77 }, runChildId: CHILD });
});

test('bindCardEvidence: 골 id 는 PR 을 낸 런의 것 — 다른 자식의 골과 섞지 않는다', () => {
  const CHILD_B = 'run-0199eeee-bbbb-7ccc-8ddd-eeeeeeeeeeee';
  const OTHER_GOAL = 'fedcba9876543210';
  const host = [entry(RUN, 'start'), entry(RUN, 'pod-child-run', { childRunId: CHILD }), entry(RUN, 'pod-child-run', { childRunId: CHILD_B })];
  // 이전 자식(CHILD)이 PR #77 · 골 GOAL, 최신 자식(CHILD_B)은 골 OTHER_GOAL 만.
  const evidence = bindCardEvidence({ runId: RUN }, { host, children: {
    [CHILD]: [entry(CHILD, 'pr-opened', { number: 77, url: URL_77 }, GOAL)],
    [CHILD_B]: [entry(CHILD_B, 'start', {}, OTHER_GOAL)],
  } });
  expect(evidence).toEqual({ ledgerFound: true, goalId: GOAL, pr: { number: 77, url: URL_77 }, childRunId: CHILD });
  // job-finished 로만 PR 을 안 자식 — 그 자식 원장이 없으면 호스트 골(없으면 비움).
  expect(bindCardEvidence({ runId: RUN }, { host, children: { [CHILD_B]: [entry(CHILD_B, 'start', {}, OTHER_GOAL)] }, podFinishes: [{ childRunId: CHILD, prUrl: URL_77 }] }))
    .toEqual({ ledgerFound: true, pr: { number: 77, url: URL_77 }, childRunId: CHILD });
});

test('Pod: 첫 조회(PR 전)는 골을 적지 않고, 두 번째 조회에서 PR 을 낸 자식의 골과 PR 을 함께 적는다', async () => {
  const path = statePath();
  const { launcher } = fakeLauncher();
  const { card } = await handTask({ text: 'ship it', live: true, statePath: path, launcher });
  const runId = readTaskCard(card.id, path)!.runId!;
  const CHILD_GOAL = 'fedcba9876543210';
  const host = [entry(runId, 'start', {}, GOAL), entry(runId, 'pod-child-run', { childRunId: CHILD })];
  await refreshCardRunBinding(card.id, path, ledgers({ [runId]: host }));
  expect(readTaskCard(card.id, path)?.goalId).toBeUndefined();
  await refreshCardRunBinding(card.id, path, ledgers({ [runId]: host, [CHILD]: [entry(CHILD, 'pr-opened', { number: 77, url: URL_77 }, CHILD_GOAL)] }));
  expect(readTaskCard(card.id, path)).toMatchObject({ goalId: CHILD_GOAL, pr: { number: 77, url: URL_77 }, runChildId: CHILD });
});

test('원장 읽기 실패는 부재와 갈려 card-bind-failed 로 남고 카드는 그대로', async () => {
  const path = statePath();
  const { launcher } = fakeLauncher();
  const { card } = await handTask({ text: 'ship it', live: true, statePath: path, launcher });
  const logged: Array<[string, Record<string, unknown>]> = [];
  const original = debug.log;
  (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => { if (category === 'task-agent') logged.push([event, data ?? {}]); }) as typeof debug.log;
  try {
    const result = await refreshCardRunBinding(card.id, path, { loadLedger: () => { throw new Error('EACCES'); }, podFinishes: () => [] });
    expect(result.evidence).toEqual({ ledgerFound: false });
    expect(logged.find(([event]) => event === 'card-bind-failed')?.[1]).toMatchObject({ card: card.id, errors: [expect.stringContaining('EACCES')] });
    logged.length = 0;
    await refreshCardRunBinding(card.id, path, ledgers({}));
    expect(logged.some(([event]) => event === 'card-bind-failed')).toBe(false);
  } finally { (debug as { log: typeof debug.log }).log = original; }
});

test('Pod: 자식이 PR 을 냈는데 자식 원장에 골이 아직 없으면 호스트 골을 쓰지 않고 비운다 · 뒤늦은 자식 골을 채운다', async () => {
  const path = statePath();
  const { launcher } = fakeLauncher();
  const { card } = await handTask({ text: 'ship it', live: true, statePath: path, launcher });
  const runId = readTaskCard(card.id, path)!.runId!;
  const CHILD_GOAL = 'fedcba9876543210';
  const host = [entry(runId, 'start', {}, GOAL), entry(runId, 'pod-child-run', { childRunId: CHILD })];
  await refreshCardRunBinding(card.id, path, ledgers({ [runId]: host }, [{ childRunId: CHILD, prUrl: URL_77 }]));
  expect(readTaskCard(card.id, path)).toMatchObject({ pr: { number: 77, url: URL_77 }, runChildId: CHILD });
  expect(readTaskCard(card.id, path)?.goalId).toBeUndefined();
  await refreshCardRunBinding(card.id, path, ledgers({ [runId]: host, [CHILD]: [entry(CHILD, 'pr-opened', { number: 77, url: URL_77 }, CHILD_GOAL)] }));
  expect(readTaskCard(card.id, path)).toMatchObject({ goalId: CHILD_GOAL, pr: { number: 77, url: URL_77 } });
});

test('PR 전에는 호스트 골도 묶지 않는다 · 묶인 PR 과 다른 자식의 골은 채우지 않는다', async () => {
  const path = statePath();
  const { launcher } = fakeLauncher();
  const { card } = await handTask({ text: 'ship it', live: true, statePath: path, launcher });
  const runId = readTaskCard(card.id, path)!.runId!;
  await refreshCardRunBinding(card.id, path, ledgers({ [runId]: [entry(runId, 'start', {}, GOAL)] }));
  expect(readTaskCard(card.id, path)?.goalId).toBeUndefined();
  const CHILD_B = 'run-0199eeee-bbbb-7ccc-8ddd-eeeeeeeeeeee';
  const host = [entry(runId, 'start', {}, GOAL), entry(runId, 'pod-child-run', { childRunId: CHILD }), entry(runId, 'pod-child-run', { childRunId: CHILD_B })];
  await refreshCardRunBinding(card.id, path, ledgers({ [runId]: host }, [{ childRunId: CHILD, prUrl: URL_77 }]));
  expect(readTaskCard(card.id, path)).toMatchObject({ pr: { number: 77 }, runChildId: CHILD });
  // 다음 조회에선 최신 자식 B 가 다른 PR(#88) · 다른 골을 냈다 — 묶인 #77/CHILD 와 다르니 골을 채우지 않는다.
  await refreshCardRunBinding(card.id, path, ledgers({ [runId]: host, [CHILD_B]: [entry(CHILD_B, 'pr-opened', { number: 88, url: 'https://github.com/o/r/pull/88' }, 'fedcba9876543210')] }));
  expect(readTaskCard(card.id, path)?.goalId).toBeUndefined();
  expect(readTaskCard(card.id, path)?.pr).toEqual({ number: 77, url: URL_77 });
});

test('bindCardEvidence: 한 런에 골이 여럿이면 그 PR 의 pr-opened 줄 골을 쓴다', () => {
  const OTHER_GOAL = 'fedcba9876543210';
  expect(bindCardEvidence({ runId: RUN }, { host: [entry(RUN, 'start', {}, OTHER_GOAL), entry(RUN, 'pr-opened', { number: 77, url: URL_77 }, GOAL)], children: {} }))
    .toEqual({ ledgerFound: true, goalId: GOAL, pr: { number: 77, url: URL_77 } });
});

test('bindCardEvidence: PR 줄에 골이 없고 다른 PR 줄이 골을 실었으면(모호) 골을 비운다', () => {
  const URL_88 = 'https://github.com/o/r/pull/88';
  expect(bindCardEvidence({ runId: RUN }, { host: [entry(RUN, 'pr-opened', { number: 77, url: URL_77 }, GOAL), entry(RUN, 'pr-opened', { number: 88, url: URL_88 })], children: {} }))
    .toEqual({ ledgerFound: true, pr: { number: 88, url: URL_88 } });
  // 골이 둘인 원장도 모호 — 비운다.
  expect(bindCardEvidence({ runId: RUN }, { host: [entry(RUN, 'start', {}, GOAL), entry(RUN, 'note', {}, 'fedcba9876543210'), entry(RUN, 'pr-opened', { number: 88, url: URL_88 })], children: {} }))
    .toEqual({ ledgerFound: true, pr: { number: 88, url: URL_88 } });
});

test('bindCardEvidence: job-finished 의 PR 번호가 양의 안전 정수가 아니면 묶지 않는다', () => {
  const host = [entry(RUN, 'pod-child-run', { childRunId: CHILD })];
  expect(bindCardEvidence({ runId: RUN }, { host, children: {}, podFinishes: [{ childRunId: CHILD, prUrl: 'https://github.com/o/r/pull/0' }] })).toEqual({ ledgerFound: true });
  expect(bindCardEvidence({ runId: RUN }, { host, children: {}, podFinishes: [{ childRunId: CHILD, prUrl: 'https://github.com/o/r/pull/99999999999999999999' }] })).toEqual({ ledgerFound: true });
});

test('ledgerLoader: 연합 목록 실패·읽기 실패는 못 찾았을 때 던지고(부재와 구분), 찾으면 그대로 돌려준다', () => {
  const found = [entry(RUN, 'start')];
  const federation = new Error('federated run-ledger lookup failed: boom');
  expect(() => ledgerLoader(['local'], () => null, federation)(RUN)).toThrow('federated');
  expect(ledgerLoader(['local'], () => found, federation)(RUN)).toBe(found);
  expect(() => ledgerLoader(['a', 'b'], (_id, dir) => { if (dir === 'a') throw new Error('EACCES'); return null; })(RUN)).toThrow('EACCES');
  expect(ledgerLoader(['a', 'b'], (_id, dir) => { if (dir === 'a') throw new Error('EACCES'); return found; })(RUN)).toBe(found);
  expect(ledgerLoader(['a'], () => null)(RUN)).toBeNull();
});
