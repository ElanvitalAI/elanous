import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Command } from 'commander';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { registerTasksCommands, spawnDetachedConfirmed, type DetachedSpawn } from '../cli/tasks-cli.js';
import { debug } from '../debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { abandonedDraftReleaseNote, closeTaskCard, draftTaskOwner, handTask, launchArgs, nextMoveFor, parseChildLlm, resolveHandText, readTaskAgentState, readTaskCard, selectTaskComposition, TASK_CARD_LABEL, RUN_TAG_CHANGE_EVENT, runTagChange, taskCardLabelContext, TaskAgentStateError, type TaskCard, type TaskLaunchContext } from './task-hand.js';
import { addItem, checklistDevVersion } from '../release-loop/checklist.js';
import { listHarnessQueue, queueHeadBefore, type HarnessQueueDeps } from '../harness/harness-queue.js';
import { installHarnessCliCommand } from '../harness/harness-cli-command.js';
import { setUserConfigOverlay } from '../user-config.js';
import { deriveBirthIdentity, parseRunIdentityTag, runPriorityClass, validateRunIdentity, type RunIdentity } from './run-identity.js';
import { parseWorkOrder } from './work-order.js';

test('only a unique launched code-PR card owns the PR or its opening run', () => {
  const base: TaskCard = { id: 'ta-one', text: 'draft', createdAt: '2026-10-10T00:00:00Z',
    status: 'launched', history: [], seat: 'UX', runId: 'parent', runChildId: 'child', pr: { number: 19 } };
  expect(draftTaskOwner([base], { number: 19 })).toBe(base);
  expect(draftTaskOwner([base], { number: 20, runId: 'child' })).toBe(base);
  expect(draftTaskOwner([base], { number: 20, runId: 'parent' })).toBe(base);
  expect(draftTaskOwner([{ ...base, runId: undefined }], { number: 19 })?.seat).toBe('UX');
  expect(draftTaskOwner([base, { ...base, id: 'ta-two' }], { number: 19 })).toBeUndefined();
  expect(draftTaskOwner([{ ...base, status: 'failed' }], { number: 19 })).toBeUndefined();
  expect(draftTaskOwner([{ ...base, completion: 'research-report' }], { number: 19 })).toBeUndefined();
  expect(draftTaskOwner([{ ...base, seat: undefined }], { number: 19 })).toBeUndefined();
});

function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'task-hand-')), 'task-agent-actions.json');
}

function compositionFixture(kind: string): string {
  const root = mkdtempSync(join(tmpdir(), 'task-composition-'));
  const work = join(root, 'graphs', 'work');
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, `${kind}.yaml`), `graph_id: work-${kind}\nversion: 1\nlauncher: harness-say\nentry_node: done\nterminal_nodes: [done]\nnodes:\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges: []\n`);
  return root;
}

test('1판 조합: code-pr의 해석 결과를 기록하고 기존 harness say 인자로 발사한다', async () => {
  const config = mkdtempSync(join(tmpdir(), 'task-graph-config-'));
  setElanousConfigDir(config);
  try {
  const selected = selectTaskComposition('code-pr');
  expect(selected).toMatchObject({ composition: { file: 'graphs/work/code-pr.yaml', version: 1 }, launcher: 'harness-say' });
  const path = statePath();
  const calls: string[][] = [];
  const events: Array<{ category: string; event: string; data?: unknown }> = [];
  const off = debug.registerSink({ name: 'graph-select-code-test', emit: (rec) => { if (rec.category === 'task-agent.graph-select') events.push(rec); } });
  let result: Awaited<ReturnType<typeof handTask>>;
  try {
    result = await handTask({ text: 'ship code', seat: 'MK', statePath: path, live: true,
      launcher: (args) => { calls.push(args); } });
  } finally { off(); }
  expect(calls).toEqual([['harness', 'say', '--seat', 'MK', '--substrate', 'pod', '--merge-by-host', 'ship code']]);
  expect(readTaskCard(result.card.id, path)).toMatchObject({ composition: selected.composition,
    graphSelectedBy: 'completion', unitsResolved: selected.unitsResolved, missingUnits: selected.missingUnits });
  expect(events).toContainEqual(expect.objectContaining({ event: 'composition-selected', data: expect.objectContaining({
    completion: 'code-pr', file: 'graphs/work/code-pr.yaml', unitsResolved: selected.unitsResolved, missingUnits: selected.missingUnits,
  }) }));
  } finally { resetElanousConfigDir(); }
});

test('단위 해석은 러너 resolveUnit 규칙으로 id·판을 확인하고 실제 단위가 생기면 true가 된다', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-composition-units-'));
  const work = join(root, 'graphs', 'work');
  const units = join(work, 'units');
  mkdirSync(units, { recursive: true });
  const graph = `graph_id: work-artifact\nversion: 2\nentry_node: make\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: make, kind: subgraph, recipe: none, max_visits: 1, call: worker@2, budget: { inner_steps: 3 }, contract: { inputs: [ask], outputs: [result] } }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: make, on: outcome, map: { done: done, failed: failed } }\n`;
  writeFileSync(join(work, 'artifact.yaml'), graph);
  writeFileSync(join(units, 'worker.yaml'), 'graph_id: worker\nversion: 1\nunit: { inputs: [ask], outputs: [result], exits: [done, failed] }\nentry_node: done\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges: []\n');
  expect(selectTaskComposition('artifact', root)).toMatchObject({ composition: { file: 'graphs/work/artifact.yaml', version: 2 }, unitsResolved: false, missingUnits: ['worker@2'] });
  writeFileSync(join(units, 'worker.yaml'), 'graph_id: worker\nversion: 2\nunit: { inputs: [ask], outputs: [result], exits: [done, failed] }\nentry_node: done\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges: []\n');
  expect(selectTaskComposition('artifact', root)).toMatchObject({ unitsResolved: true, missingUnits: [] });
  writeFileSync(join(units, 'worker.yaml'), 'graph_id: worker\nversion: 2\nunit: { inputs: [ask], outputs: [result], exits: [done, failed] }\nentry_node: nested\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: nested, kind: subgraph, recipe: none, max_visits: 1, call: nested@1, budget: { inner_steps: 3 }, contract: { inputs: [], outputs: [] } }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: nested, on: outcome, map: { done: done, failed: failed } }\n');
  expect(selectTaskComposition('artifact', root)).toMatchObject({ unitsResolved: false, missingUnits: ['nested@1'] });
  writeFileSync(join(units, 'nested.yaml'), 'graph_id: nested\nversion: 1\nunit: { inputs: [], outputs: [], exits: [done, failed] }\nentry_node: done\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges: []\n');
  expect(selectTaskComposition('artifact', root)).toMatchObject({ unitsResolved: true, missingUnits: [] });
  writeFileSync(join(units, 'nested.yaml'), 'graph_id: nested\nversion: 1\nunit: { inputs: [extra], outputs: [], exits: [done, failed] }\nentry_node: done\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges: []\n');
  expect(selectTaskComposition('artifact', root)).toMatchObject({ unitsResolved: false, missingUnits: [],
    error: expect.stringContaining('unit contract mismatch') });
  writeFileSync(join(units, 'worker.yaml'), 'graph_id: worker\nversion: 2\nunit: { inputs: [ask], outputs: [result], exits: [done, failed] }\nentry_node: absent\nterminal_nodes: [done, failed]\nnodes: []\nedges: []\n');
  expect(selectTaskComposition('artifact', root)).toMatchObject({ unitsResolved: false, missingUnits: [],
    error: expect.stringContaining('조합 단위 해석 오류') });
});

test('cardFields의 런타임 추가 필드는 선택된 조합과 종결 종류를 덮어쓰지 못한다', async () => {
  const root = compositionFixture('code-pr');
  const injectedFields = { goalId: 'goal-1', completion: 'artifact' as const,
    composition: { file: 'graphs/work/artifact.yaml', version: 99 }, graphSelectedBy: 'completion' as const,
    unitsResolved: false, missingUnits: ['fake@1'], status: 'failed' as const };
  const result = await handTask({ text: 'ship code', compositionRoot: root, statePath: statePath(),
    cardFields: injectedFields });
  expect(result.card).toMatchObject({ goalId: 'goal-1', status: 'handed',
    composition: { file: 'graphs/work/code-pr.yaml', version: 1 }, unitsResolved: true, missingUnits: [] });
  expect(result.card.completion).toBeUndefined();
});

test('깨진 조합 YAML과 단위 해석 오류는 실패 카드·선택 관측에 남고 발사하지 않는다', async () => {
  const root = compositionFixture('artifact');
  const file = join(root, 'graphs', 'work', 'artifact.yaml');
  const path = statePath();
  writeFileSync(file, 'graph_id: [broken\n');
  let launched = 0;
  const events: Array<{ category: string; event: string; data?: unknown }> = [];
  const off = debug.registerSink({ name: 'graph-select-invalid-test', emit: (rec) => { if (rec.category === 'task-agent.graph-select') events.push(rec); } });
  try {
    await expect(handTask({ id: 'ta-bad-composition', text: 'artifact', completion: 'artifact',
      compositionRoot: root, statePath: path, live: true, launcher: () => { launched++; } })).rejects.toThrow('조합 오류');
  } finally { off(); }
  expect(launched).toBe(0);
  expect(readTaskCard('ta-bad-composition', path)).toMatchObject({ status: 'failed',
    composition: { file: 'graphs/work/artifact.yaml', version: null }, graphSelectedBy: 'completion',
    unitsResolved: false, missingUnits: [], history: [{ event: 'composition-invalid', detail: expect.stringContaining('조합 오류') }] });
  expect(events).toContainEqual(expect.objectContaining({ event: 'composition-invalid', data: expect.objectContaining({ error: expect.stringContaining('조합 오류') }) }));

  writeFileSync(file, 'graph_id: work-artifact\nversion: 1\nlauncher: harness-say\nentry_node: invoke\nterminal_nodes: [done]\nnodes:\n  - { node_id: invoke, kind: subgraph, recipe: none, max_visits: 1, call: worker@1, budget: { inner_steps: 1 }, contract: { inputs: [], outputs: [] } }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: invoke, on: outcome, map: { done: done } }\n');
  const units = join(root, 'graphs', 'work', 'units');
  mkdirSync(units);
  writeFileSync(join(units, 'worker.yaml'), 'graph_id: worker\nversion: 1\nentry_node: absent\nterminal_nodes: []\nnodes: []\nedges: []\nunit: { inputs: [], outputs: [], exits: [done] }\n');
  await expect(handTask({ id: 'ta-bad-unit', text: 'artifact', completion: 'artifact',
    compositionRoot: root, statePath: path, live: true, launcher: () => { launched++; } })).rejects.toThrow('조합 단위 해석 오류');
  expect(launched).toBe(0);
  expect(readTaskCard('ta-bad-unit', path)).toMatchObject({ status: 'failed',
    composition: { file: 'graphs/work/artifact.yaml', version: 1 }, unitsResolved: false, missingUnits: [],
    history: [{ event: 'composition-invalid', detail: expect.stringContaining('조합 단위 해석 오류') }] });
});

test('조합 읽기 오류와 code-pr launcher 누락도 실패 카드와 오류 관측에 남긴다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-composition-read-error-'));
  mkdirSync(join(root, 'graphs', 'work', 'artifact.yaml'), { recursive: true });
  const path = statePath();
  const events: string[] = [];
  const off = debug.registerSink({ name: 'graph-select-read-error-test', emit: rec => {
    if (rec.category === 'task-agent.graph-select') events.push(rec.event);
  } });
  try {
    await expect(handTask({ id: 'ta-read-error', text: 'artifact', completion: 'artifact',
      compositionRoot: root, statePath: path })).rejects.toThrow('조합 읽기 오류');
    expect(readTaskCard('ta-read-error', path)).toMatchObject({ status: 'failed',
      composition: { file: 'graphs/work/artifact.yaml', version: null },
      history: [{ event: 'composition-invalid', detail: expect.stringContaining('조합 읽기 오류') }] });

    const codeRoot = compositionFixture('code-pr');
    const codeFile = join(codeRoot, 'graphs', 'work', 'code-pr.yaml');
    writeFileSync(codeFile, readFileSync(codeFile, 'utf8').replace('launcher: harness-say\n', ''));
    await expect(handTask({ id: 'ta-no-launcher', text: 'code', compositionRoot: codeRoot,
      statePath: path })).rejects.toThrow('launcher 없음');
    expect(readTaskCard('ta-no-launcher', path)).toMatchObject({ status: 'failed',
      history: [{ event: 'composition-invalid', detail: expect.stringContaining('launcher 없음') }] });
  } finally { off(); }
  expect(events).toEqual(['composition-invalid', 'composition-invalid']);
});

test('없는 조합은 발사 전 거부하고 카드·관측에 이유를 남긴다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-composition-missing-'));
  const path = statePath();
  let launched = 0;
  const events: Array<{ category: string; event: string; data?: unknown }> = [];
  const off = debug.registerSink({ name: 'graph-select-missing-test', emit: (rec) => { if (rec.category === 'task-agent.graph-select') events.push(rec); } });
  try {
    await expect(handTask({ id: 'ta-missing-composition', text: 'watch', completion: 'watch-brief',
      statePath: path, compositionRoot: root, live: true, launcher: () => { launched++; } })).rejects.toThrow('조합 없음');
  } finally { off(); }
  expect(launched).toBe(0);
  expect(readTaskCard('ta-missing-composition', path)).toMatchObject({ status: 'failed', completion: 'watch-brief',
    history: [{ event: 'composition-missing', detail: '조합 없음: graphs/work/watch-brief.yaml' }] });
  expect(events).toContainEqual(expect.objectContaining({ event: 'composition-missing', data: expect.objectContaining({
    completion: 'watch-brief', file: 'graphs/work/watch-brief.yaml', unitsResolved: false, missingUnits: [],
  }) }));
  for (const kind of ['artifact', 'research-report', 'ops-action', 'content', 'decision-support', 'deliverable'] as const) {
    await expect(handTask({ text: 'task', completion: kind, statePath: path, compositionRoot: root })).rejects.toThrow(`조합 없음: graphs/work/${kind}.yaml`);
  }
});

test('2판 graph-run 조합은 1판에서 잘못 harness say로 발사하지 않고 선택 근거를 남긴다', async () => {
  const root = compositionFixture('research-report');
  const file = join(root, 'graphs', 'work', 'research-report.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace('launcher: harness-say', 'launcher: graph-run'));
  const path = statePath();
  let launched = 0;
  await expect(handTask({ id: 'ta-graph-run-future', text: 'report', completion: 'research-report',
    compositionRoot: root, statePath: path, live: true, launcher: () => { launched++; } })).rejects.toThrow('조합 실행기 없음');
  expect(launched).toBe(0);
  expect(readTaskCard('ta-graph-run-future', path)).toMatchObject({ status: 'failed',
    composition: { file: 'graphs/work/research-report.yaml', version: 1 }, graphSelectedBy: 'completion',
    unitsResolved: true, missingUnits: [], history: [{ event: 'composition-launcher-unavailable' }] });
});

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

test('launched 카드 nextMove는 종료 run-status 원장을 반영하되 live 재판정 CLI를 제안하지 않는다', async () => {
  const runId = 'run-0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
  const dir = mkdtempSync(join(tmpdir(), 'task-hand-ledger-'));
  const ledgerPath = join(dir, `${runId}.jsonl`);
  const card: TaskCard = { id: 'ta-ended', text: 'done', createdAt: '2026-10-12T00:00:00Z', status: 'launched', history: [], runId,
    pr: { number: 19, url: 'https://github.com/o/r/pull/19' }, reviewRequests: [{ pr: 19, head: 'a'.repeat(40), at: '2026-10-12T00:01:00Z' }] };
  mkdirSync(dir, { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify({ runId, event: 'run-status', data: { runStatus: 'succeeded' } }) + String.fromCharCode(10));
  const move = nextMoveFor(card, undefined, { ledgerDir: dir });
  expect(move).toEqual({ kind: 'wait', reason: '런 원장 종료 — succeeded · 그림자 재판정은 완료 훅이 기록' });
  expect(nextMoveFor({ ...card, pr: undefined }, undefined, { ledgerDir: dir })).toEqual({
    kind: 'wait', reason: '런 원장 종료 — succeeded · PR 없음',
  });
  expect(move.command).toBeUndefined();
});

test('closeTaskCard — failed 로 닫고 history 한 줄을 더한다 · 빈 사유는 던진다 · 이미 닫은 카드는 그대로(멱등)', () => {
  const card: TaskCard = { id: 'ta-c', text: 't', createdAt: '2026-10-11T00:00:00.000Z', status: 'launched', history: [{ at: '2026-10-11T00:00:00.000Z', event: 'launch' }] };
  const closed = closeTaskCard(card, { reason: ' 대체됨 ', by: 'OP', at: '2026-10-11T01:00:00.000Z' });
  expect(closed.status).toBe('failed');
  expect(closed.history).toEqual([card.history[0]!, { at: '2026-10-11T01:00:00.000Z', event: 'closed-by-hand', kind: 'closed-by-hand', detail: '대체됨', reason: '대체됨', by: 'OP' }]);
  expect(card.status).toBe('launched');
  expect(() => closeTaskCard(card, { reason: '  ', by: 'OP', at: 'x' })).toThrow();
  expect(closeTaskCard(closed, { reason: '또', by: 'TC', at: '2026-10-11T02:00:00.000Z' })).toBe(closed);
});

test('resolveHandText classifies paths with injected IO, trims only for metadata and rejects invalid files', () => {
  const cwd = '/some/working/directory';
  const carried = '대상 경로: a\n현재 계약: b';
  const seen: string[] = [];
  const deps = {
    cwd,
    stat: (path: string) => {
      seen.push(path);
      if (path.endsWith('/folder')) return { isFile: () => false, isDirectory: () => true };
      if (path.endsWith('/other.bin') || path.endsWith('/GOAL.MARKDOWN') || path.endsWith('/empty.txt') || path.endsWith('/unreadable.md') || path.endsWith('/vanished.md') || path.endsWith('/moved.md')) return { isFile: () => true, isDirectory: () => false };
      if (path.includes('/other.bin/')) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
      if (path.endsWith('/locked.md')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    readFile: (path: string, encoding: 'utf8') => {
      expect(encoding).toBe('utf8');
      if (path.endsWith('/unreadable.md')) throw new Error('EACCES');
      if (path.endsWith('/vanished.md')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      if (path.endsWith('/moved.md')) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
      return path.endsWith('/empty.txt') ? ' \n  ' : `${carried}\n`;
    },
  };
  const inlined = resolveHandText('GOAL.MARKDOWN', deps);
  expect(inlined).toEqual({ kind: 'inlined', path: resolve(cwd, 'GOAL.MARKDOWN'), text: `${carried}\n`, chars: carried.length, sha256: createHash('sha256').update(carried).digest('hex') });
  expect(resolveHandText('other.bin', deps)).toMatchObject({ kind: 'inlined', path: resolve(cwd, 'other.bin') });
  expect(resolveHandText('missing.md', deps)).toEqual({ kind: 'rejected', path: resolve(cwd, 'missing.md'), reason: '없다' });
  expect(resolveHandText('other.bin/goal.md', deps)).toEqual({ kind: 'rejected', path: resolve(cwd, 'other.bin/goal.md'), reason: '없다' });
  expect(resolveHandText('vanished.md', deps)).toEqual({ kind: 'rejected', path: resolve(cwd, 'vanished.md'), reason: '없다' });
  expect(resolveHandText('moved.md', deps)).toEqual({ kind: 'rejected', path: resolve(cwd, 'moved.md'), reason: '없다' });
  expect(resolveHandText('locked.md', deps)).toEqual({ kind: 'rejected', path: resolve(cwd, 'locked.md'), reason: '읽기 실패' });
  expect(resolveHandText('folder', deps)).toEqual({ kind: 'rejected', path: resolve(cwd, 'folder'), reason: '디렉터리' });
  expect(resolveHandText('unreadable.md', deps)).toEqual({ kind: 'rejected', path: resolve(cwd, 'unreadable.md'), reason: '읽기 실패' });
  expect(resolveHandText('empty.txt', deps)).toEqual({ kind: 'rejected', path: resolve(cwd, 'empty.txt'), reason: '비었다' });
  expect(resolveHandText('fix-login', deps)).toEqual({ kind: 'unchanged', text: 'fix-login' });
  expect(resolveHandText('보고서 정리해 줘', deps)).toEqual({ kind: 'unchanged', text: '보고서 정리해 줘' });
  expect(resolveHandText('first\nsecond.md', deps)).toEqual({ kind: 'unchanged', text: 'first\nsecond.md' });
  expect(seen).not.toContain(resolve(cwd, 'first\nsecond.md'));
});

test('Pod 카드 라벨 맥락은 원장 id 그대로이며 카드·원장·발사 명령은 변경하지 않는다', async () => {
  const path = statePath();
  const { card, move } = await handTask({ id: 'ta-20261009-abc123', text: 'ship it', statePath: path });
  const before = readFileSync(path, 'utf8');
  const snapshot = structuredClone(card);
  expect(TASK_CARD_LABEL).toBe('elanous.task-card');
  expect(taskCardLabelContext(card)).toEqual({ cardId: card.id, labels: { 'elanous.task-card': card.id } });
  expect(card).toEqual(snapshot);
  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(JSON.parse(before).tasks[card.id]).toEqual(snapshot);
  expect(move.command).toEqual(['harness', 'say', '--substrate', 'pod', '--merge-by-host', 'ship it']);
});

test('live handTask 는 카드 라벨 맥락을 기존 launcher 호출에 싣고 명령·cwd·런 연결을 보존한다', async () => {
  const path = statePath();
  const target = mkdtempSync(join(tmpdir(), 'task-hand-label-target-'));
  execFileSync('git', ['init', '-q', target]);
  const calls: Array<{ args: string[]; cwd?: string; context?: TaskLaunchContext }> = [];
  const result = await handTask({
    id: 'ta-20261009-label01', text: '  write report  ', completion: 'code-pr',
    project: { id: 'p1', target }, seat: 'TC', checklistId: 'CELL-1', live: true, statePath: path,
    launcher: (args, cwd, context) => { calls.push({ args, cwd, context }); return { runId: context!.runId }; },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.args).toEqual(['harness', 'say', '--seat', 'TC', '--substrate', 'pod', '--merge-by-host', 'write report']);
  expect(calls[0]!.cwd).toBe(target);
  expect(calls[0]!.context).toMatchObject({
    cardLabelContext: { cardId: result.card.id, labels: { [TASK_CARD_LABEL]: result.card.id } },
    env: { ELANOUS_RUN_ID: calls[0]!.context!.runId, ELANOUS_TASK_CARD_ID: result.card.id, ELANOUS_POD_SLOT_ID: 'CELL-1', ELANOUS_POD_OWNER_KIND: 'seat', ELANOUS_POD_OWNER_ID: 'TC' },
  });
  expect(calls[0]!.context!.launchId).toStartWith('tl-');
  expect(result).toMatchObject({ mode: 'live', launched: true, cwd: target, move: { kind: 'launch', command: calls[0]!.args }, card: { status: 'launched', runId: calls[0]!.context!.runId, launchId: calls[0]!.context!.launchId } });
  expect(readTaskCard(result.card.id, path)).toEqual(result.card);
  expect(Object.hasOwn(result.card, 'cardLabelContext')).toBe(false);
});

test('Pod 카드 라벨 맥락은 유효하지 않은 id 를 변형·충돌시키지 않고 거부한다', () => {
  for (const id of ['other-1', 'ta-a b', 'ta-a/b', 'ta-a.', `ta-${'x'.repeat(61)}`]) {
    expect(() => taskCardLabelContext({ id })).toThrow('Pod 라벨에 쓸 수 없는 과제 카드 id');
  }
  expect(taskCardLabelContext({ id: `ta-${'x'.repeat(60)}` }).labels[TASK_CARD_LABEL]).toHaveLength(63);
});

test('shadow hand → 카드 1장 · 명령에 --merge-by-host · launcher 안 불림 · 기존 칸 보존', async () => {
  const path = statePath();
  writeFileSync(path, JSON.stringify({ landingDay: '2026-10-06', landingsToday: 2, failureCounts: { k: 1 } }));
  let launched = 0;
  const text = '대상 경로: src/task-agent/task-hand.ts\nfix the widget';
  const { lines, code } = await cli(['task', 'hand', text, '--seat', 'TC', '--checklist', 'CELL-1'], {
    taskStatePath: path,
    taskLauncher: () => { launched++; },
    releaseBoard: () => [{ level: 'task', id: 'CELL-1', title: 'fix the widget', status: 'open' }],
  });
  expect(code).toBeFalsy();
  expect(launched).toBe(0);
  expect(lines.join('\n')).toContain('--merge-by-host');
  expect(lines.join('\n')).toContain('--seat TC --substrate pod');
  const disk = JSON.parse(readFileSync(path, 'utf8'));
  expect(disk).toMatchObject({ landingDay: '2026-10-06', landingsToday: 2, failureCounts: { k: 1 } });
  const cards = Object.values(disk.tasks) as Array<Record<string, unknown>>;
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ text, seat: 'TC', checklistId: 'CELL-1', status: 'handed', history: [] });
  expect(String(cards[0]!.id)).toStartWith('ta-');
  expect(typeof cards[0]!.createdAt).toBe('string');
});

test('--live 는 주입한 launcher 를 한 번 부르고 카드를 launched 로', async () => {
  const path = statePath();
  const calls: string[][] = [];
  const { lines } = await cli(['task', 'hand', 'ship it', '--live', '--json'], { taskStatePath: path, taskLauncher: (args) => { calls.push(args); } });
  expect(calls).toEqual([['harness', 'say', '--substrate', 'pod', '--merge-by-host', 'ship it']]);
  const out = JSON.parse(lines[0]!);
  expect(Object.hasOwn(out, 'cwd')).toBe(false);
  expect(Object.hasOwn(out.card, 'project')).toBe(false);
  expect(Object.hasOwn(out.card, 'completion')).toBe(false);
  expect(out).toMatchObject({ mode: 'live', launched: true });
  expect(readTaskCard(out.card.id, path)?.status).toBe('launched');
});

test('task show <ta-id> 는 카드와 다음 수를 보이고 넥서스를 부르지 않는다', async () => {
  const path = statePath();
  const { card } = await handTask({ text: 'write the report', seat: 'MK', statePath: path });
  let fetched = 0;
  const { lines, code } = await cli(['task', 'show', card.id], {
    taskStatePath: path,
    baseUrl: 'http://127.0.0.1:1',
    fetch: (async () => { fetched++; return Response.json({}); }) as unknown as typeof fetch,
  });
  expect(code).toBeFalsy();
  expect(fetched).toBe(0);
  expect(lines[0]).toContain(card.id);
  expect(lines[0]).toContain('write the report');
  expect(lines[1]).toContain('신분 미기록 — 원장에 identity 없음 · 승인·선점은 기본 class=normal 로 읽는다'); // 기록 없는 카드에 기본값을 사실처럼 쓰지 않는다
  expect(lines[2]).toContain('Pod 라벨 elanous.task-card=');
  expect(lines[3]).toContain('다음 수: launch');
  expect(lines[3]).toContain(launchArgs(card).slice(0, 4).join(' '));
  const missing = await cli(['task', 'show', 'ta-nope'], { taskStatePath: path });
  expect(missing.code).toBe(1);
});

test('비git 보고서 대상은 절대 경로로 카드에 남지만 1판에서 발사하지 않는다', async () => {
  const target = mkdtempSync(join(tmpdir(), 'task-hand-project-'));
  const path = statePath();
  const taskCompositionRoot = compositionFixture('research-report');
  const args = ['task', 'hand', '보고서', '--project', 'p1', '--target', target, '--completion', 'research-report', '--json'];
  const shadow = await cli(args, { taskStatePath: path, taskCompositionRoot });
  expect(shadow.code).toBe(1);
  expect(shadow.lines[0]).toContain('조합 실행기 없음');
  const card = Object.values(readTaskAgentState<{ tasks: Record<string, TaskCard> }>(path).tasks)[0]!;
  expect(card).toMatchObject({ completion: 'research-report', project: { id: 'p1', target },
    composition: { file: 'graphs/work/research-report.yaml', version: 1 }, status: 'failed' });
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const live = await cli([...args, '--live'], { taskStatePath: path, taskCompositionRoot, taskLauncher: (command, cwd) => { calls.push({ args: command, cwd }); } });
  expect(live.code).toBe(1);
  expect(calls).toEqual([]);
  const relativeTarget = relative(process.cwd(), target);
  const normalized = await cli(['task', 'hand', '보고서', '--project', 'p1', '--target', relativeTarget, '--completion', 'research-report', '--json'], { taskStatePath: path, taskCompositionRoot });
  expect(normalized.code).toBe(1);
  expect(Object.values(readTaskAgentState<{ tasks: Record<string, TaskCard> }>(path).tasks).at(-1)?.project?.target).toBe(target);
});

test('비git code-pr 및 없는 디렉터리는 카드 기록 전에 거부한다', async () => {
  const target = mkdtempSync(join(tmpdir(), 'task-hand-project-'));
  const path = statePath();
  const denied = await cli(['task', 'hand', '보고서', '--project', 'p1', '--target', target, '--completion', 'code-pr', '--json'], { taskStatePath: path });
  expect(denied.code).toBe(1);
  expect(denied.lines).toEqual([`코드 종결은 git 대상이 필요 — --completion 을 고르거나 git init: ${target}`]);
  // completion 생략 = code-pr — 비git 대상이면 같은 거부(PR 병합을 영영 기다리는 카드를 만들지 않는다).
  const implicit = await cli(['task', 'hand', '보고서', '--project', 'p1', '--target', target], { taskStatePath: path });
  expect(implicit.code).toBe(1);
  expect(implicit.lines.join('\n')).toContain('git');
  const missing = await cli(['task', 'hand', '보고서', '--project', 'p1', '--target', join(target, 'absent'), '--completion', 'research-report', '--json'], { taskStatePath: path });
  expect(missing.code).toBe(1);
  expect(missing.lines.join('\n')).toContain('대상 디렉터리가 없습니다');
  expect(readTaskAgentState(path)).toEqual({});
});

test('프로젝트 handed 관측은 id 와 git 여부를 남긴다', async () => {
  const target = mkdtempSync(join(tmpdir(), 'task-hand-project-'));
  execFileSync('git', ['init', '-q', target]);
  const events: Array<{ category: string; event: string; data?: unknown }> = [];
  const off = debug.registerSink({ name: 'task-project-capture', emit: (rec) => { if (rec.category === 'task-agent') events.push(rec); } });
  try {
    await handTask({ text: '보고서', project: { id: 'p1', target }, completion: 'code-pr', statePath: statePath() });
    expect(events.find((entry) => entry.event === 'handed')?.data).toMatchObject({ projectId: 'p1', targetIsGit: true });
  } finally { off(); }
});

test('빈 과제는 거부한다', async () => {
  await expect(handTask({ text: '  ', statePath: statePath() })).rejects.toThrow();
});

test('손상된 상태 파일 → task hand 는 실패하고 파일을 덮어쓰지 않는다 (ENOENT 만 빈 상태)', async () => {
  for (const corrupted of ['{"failureCounts": {"k": 3}, "tasks": {', '[1,2]', 'null']) {
    const path = statePath();
    writeFileSync(path, corrupted);
    let launched = 0;
    const { lines, code } = await cli(['task', 'hand', 'fix it', '--live'], { taskStatePath: path, taskLauncher: () => { launched++; } });
    expect(code).toBe(1);
    expect(launched).toBe(0);
    expect(lines.join('\n')).toContain('덮어쓰지 않고 멈춘다');
    expect(readFileSync(path, 'utf8')).toBe(corrupted);
    expect(() => readTaskAgentState(path)).toThrow(TaskAgentStateError);
    const show = await cli(['task', 'show', 'ta-x'], { taskStatePath: path });
    expect(show.code).toBe(1);
  }
  expect(readTaskAgentState(join(mkdtempSync(join(tmpdir(), 'task-hand-')), 'missing.json'))).toEqual({});
});

function fakeSpawn(behavior: 'spawn' | 'error' | 'silent', pid?: number): DetachedSpawn & { unrefs: number } {
  const fake = Object.assign(((_command: string, _args: string[]) => {
    const child = Object.assign(new EventEmitter(), { pid, unref: () => { fake.unrefs++; } });
    queueMicrotask(() => {
      if (behavior === 'spawn') child.emit('spawn');
      if (behavior === 'error') child.emit('error', Object.assign(new Error('spawn /nope ENOENT'), { code: 'ENOENT' }));
    });
    return child;
  }) as unknown as DetachedSpawn, { unrefs: 0 });
  return fake;
}

test('발사기: spawn 이벤트면 성공 · error 면 던진다 · 둘 다 없고 pid 없으면 시간 초과', async () => {
  const ok = fakeSpawn('spawn', 42);
  await spawnDetachedConfirmed(ok, 'node', ['x']);
  expect(ok.unrefs).toBe(1);
  await expect(spawnDetachedConfirmed(fakeSpawn('error'), 'node', ['x'])).rejects.toThrow('ENOENT');
  await expect(spawnDetachedConfirmed(fakeSpawn('silent'), 'node', ['x'], 20)).rejects.toThrow('시간 초과');
  await spawnDetachedConfirmed(fakeSpawn('silent', 7), 'node', ['x'], 20);
});

test('--live 발사 error → 카드 launch-failed(사유) · exit 1 · launched 아님', async () => {
  const path = statePath();
  const { lines, code } = await cli(['task', 'hand', 'ship it', '--live'], {
    taskStatePath: path,
    taskLauncher: (args) => spawnDetachedConfirmed(fakeSpawn('error'), 'node', args),
  });
  expect(code).toBe(1);
  expect(lines.join('\n')).toContain('launch-failed');
  const cards = Object.values(JSON.parse(readFileSync(path, 'utf8')).tasks) as Array<{ status: string; history: Array<{ event: string; detail?: string }> }>;
  expect(cards).toHaveLength(1);
  expect(cards[0]!.status).toBe('launch-failed');
  expect(cards[0]!.history[0]).toMatchObject({ event: 'launch-failed' });
  expect(cards[0]!.history[0]!.detail).toContain('ENOENT');
});

test('TASK-AGENT 관측 — hand·show 는 task-agent 싱크를 등록하고 그 싱크가 handed 를 받는다', async () => {
  const path = statePath();
  const surfaces: string[] = [];
  const events: Array<{ category: string; event: string; data?: unknown }> = [];
  const offs: Array<() => void> = [];
  // 실 logs.db 대신 같은 자리(debug.registerSink)에 붙는 포획 싱크를 주입한다.
  const registerSink = async (surface: string) => {
    surfaces.push(surface);
    offs.push(debug.registerSink({ name: 'task-agent-capture', emit: (rec) => { if (rec.category === 'task-agent') events.push(rec); } }));
    return true;
  };
  try {
    const { lines } = await cli(['task', 'hand', 'observe me', '--seat', 'OP', '--json'], { taskStatePath: path, registerSink });
    const id = JSON.parse(lines[0]!).card.id as string;
    expect(surfaces).toEqual(['task-agent']);
    expect(events.map((e) => e.event)).toEqual(['handed']);
    expect(events[0]!.data).toMatchObject({ taskId: id, seat: 'OP', mode: 'shadow', projectId: null, targetIsGit: null });
    await cli(['task', 'show', id], { taskStatePath: path, registerSink });
    expect(surfaces).toEqual(['task-agent', 'task-agent']);
  } finally { for (const off of offs) off(); }
});

test('TASK-AGENT 관측 — 싱크 등록이 실패해도 과제 넘기기는 돈다(fail-open)', async () => {
  const path = statePath();
  const { lines, code } = await cli(['task', 'hand', 'still works', '--json'], { taskStatePath: path, registerSink: async () => { throw new Error('sink down'); } });
  expect(code).toBeFalsy();
  expect(readTaskCard(JSON.parse(lines[0]!).card.id, path)?.status).toBe('handed');
});

test('--completion <kind> 는 카드에 종결 종류를 싣고 모르는 값은 exit 1 · 안 주면 카드에 칸이 없다 (§A4b③)', async () => {
  const path = statePath();
  const { lines, code } = await cli(['task', 'hand', 'x', '--completion', 'artifact', '--json'], { taskStatePath: path, taskCompositionRoot: compositionFixture('artifact') });
  expect(code).toBe(1);
  expect(lines[0]).toContain('조합 실행기 없음');
  expect(Object.values(readTaskAgentState<{ tasks: Record<string, TaskCard> }>(path).tasks)[0]?.completion).toBe('artifact');
  const plain = await cli(['task', 'hand', 'y', '--json'], { taskStatePath: path });
  expect('completion' in JSON.parse(plain.lines[0]!).card).toBe(false);
  const previous = process.exitCode;
  let thrown: unknown;
  try { await cli(['task', 'hand', 'z', '--completion', 'bogus'], { taskStatePath: path }); } catch (error) { thrown = error; } finally { process.exitCode = previous ?? 0; }
  expect((thrown as { exitCode?: number })?.exitCode).toBe(1);
  expect(Object.keys(readTaskAgentState<{ tasks: Record<string, unknown> }>(path).tasks)).toHaveLength(2);
  await expect(handTask({ text: 'w', completion: 'bogus' as never, statePath: path })).rejects.toThrow('종결 종류');
  const mission = await cli(['task', 'hand', '--mission', '- a\n- b', '--completion', 'artifact'], { taskStatePath: path });
  expect(mission.code).toBe(1);
});

test('TA-LIVE-LAND-2: task hand --ta-land --live writes card taLand and launches with ELANOUS_TA_LAND=1 (command unchanged)', async () => {
  const path = statePath();
  const calls: Array<{ args: string[]; context?: TaskLaunchContext }> = [];
  const { lines, code } = await cli(['task', 'hand', 'ship it', '--ta-land', '--live'], {
    taskStatePath: path,
    taskLauncher: (args, _cwd, context) => { calls.push({ args, context }); return { runId: context!.runId }; },
  });
  expect(code).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.args).toEqual(['harness', 'say', '--substrate', 'pod', '--merge-by-host', 'ship it']);
  const cards = Object.values(readTaskAgentState<{ tasks: Record<string, { id: string; taLand?: boolean; runId?: string }> }>(path).tasks);
  expect(calls[0]!.context!.env).toEqual({ ELANOUS_RUN_ID: calls[0]!.context!.runId, ELANOUS_TASK_CARD_ID: cards[0]!.id, ELANOUS_TA_LAND: '1' });
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ taLand: true, runId: calls[0]!.context!.runId });
  expect(lines.join('\n')).toContain('ELANOUS_TA_LAND=1');
});

test('TA-LIVE-LAND-2: without --ta-land the card has no taLand and the launch env carries only the run id', async () => {
  const path = statePath();
  const calls: Array<{ context?: TaskLaunchContext }> = [];
  const { code } = await cli(['task', 'hand', 'ship it', '--live'], {
    taskStatePath: path,
    taskLauncher: (_args, _cwd, context) => { calls.push({ context }); return { runId: context!.runId }; },
  });
  expect(code).toBe(0);
  const cards = Object.values(readTaskAgentState<{ tasks: Record<string, { id: string; taLand?: boolean }> }>(path).tasks);
  expect(calls[0]!.context!.env).toEqual({ ELANOUS_RUN_ID: calls[0]!.context!.runId, ELANOUS_TASK_CARD_ID: cards[0]!.id });
  expect(Object.hasOwn(cards[0]!, 'taLand')).toBe(false);
});

test('TA-LIVE-LAND-2: --ta-land is refused with --mission (pieces keep today\'s launch)', async () => {
  const { lines, code } = await cli(['task', 'hand', '--mission', '- a\n- b', '--ta-land'], { taskStatePath: statePath() });
  expect(code).toBe(1);
  expect(lines.join('\n')).toContain('--ta-land');
});

test('TASKS-HAND-CHILD-LLM: without --child-llm the command line and card are byte-identical to today', async () => {
  const path = statePath();
  const calls: string[][] = [];
  const { lines, code } = await cli(['task', 'hand', 'ship it', '--seat', 'UX', '--live', '--json'], {
    taskStatePath: path,
    taskLauncher: (args, _cwd, context) => { calls.push(args); return { runId: context!.runId }; },
  });
  expect(code).toBe(0);
  expect(calls).toEqual([['harness', 'say', '--seat', 'UX', '--substrate', 'pod', '--merge-by-host', 'ship it']]);
  const card = JSON.parse(lines[0]!).card as TaskCard;
  expect(Object.hasOwn(card, 'childLlm')).toBe(false);
  // 저장된 카드 직렬화 전체를 기능 도입 전 모양과 비교한다(동적 id·시각·런 id 만 정규화 · 키 순서까지).
  const stored = JSON.parse(readFileSync(path, 'utf8')).tasks[card.id] as TaskCard;
  const normalized = JSON.stringify(stored)
    .replaceAll(card.id, '<ID>').replaceAll(stored.runId!, '<RUN>').replaceAll(stored.launchId!, '<LAUNCH>')
    .replaceAll(stored.createdAt, '<T>').replaceAll(stored.history[0]!.at, '<T>');
  expect(normalized).toBe(JSON.stringify({
    id: '<ID>', text: 'ship it', seat: 'UX', composition: { file: 'graphs/work/code-pr.yaml', version: 1 }, graphSelectedBy: 'completion', unitsResolved: false, missingUnits: ['make-code@1'], createdAt: '<T>', status: 'launched', history: [
      { at: '<T>', event: 'launch', detail: 'harness say --seat UX --substrate pod --merge-by-host ship it' },
      { at: '<T>', event: 'run-bound', detail: '<RUN>', runId: '<RUN>' },
    ], runId: '<RUN>', launchId: '<LAUNCH>',
  }));
  expect(launchArgs({ text: 'x' })).toEqual(['harness', 'say', '--substrate', 'pod', '--merge-by-host', 'x']);
});

test('TASKS-HAND-CHILD-LLM: --child-llm grok/grok-4.7 passes --child-llm-provider/--child-llm-model, records card ⊕ observation', async () => {
  const path = statePath();
  const calls: string[][] = [];
  const events: Array<{ event: string; data?: unknown }> = [];
  const off = debug.registerSink({ name: 'child-llm-capture', emit: (rec) => { if (rec.category === 'task-agent') events.push(rec); } });
  try {
    const { lines, code } = await cli(['task', 'hand', 'ship it', '--child-llm', 'grok/grok-4.7', '--child-llm-effort', 'high', '--live', '--json'], {
      taskStatePath: path,
      taskLauncher: (args, _cwd, context) => { calls.push(args); return { runId: context!.runId }; },
    });
    expect(code).toBe(0);
    expect(calls).toEqual([['harness', 'say', '--substrate', 'pod', '--merge-by-host', '--child-llm-provider', 'grok', '--child-llm-model', 'grok-4.7', '--child-llm-effort', 'high', 'ship it']]);
    const id = JSON.parse(lines[0]!).card.id as string;
    expect(readTaskCard(id, path)?.childLlm).toEqual({ provider: 'grok', model: 'grok-4.7', effort: 'high' });
    expect(events.find((e) => e.event === 'child-llm')?.data).toMatchObject({ taskId: id, input: 'grok/grok-4.7', provider: 'grok', model: 'grok-4.7', effort: 'high', mode: 'live' });
  } finally { off(); }
});

test('tasks hand --tier persists dispatch difficulty without changing the launch model', async () => {
  const path = statePath();
  const { lines, code } = await cli(['task', 'hand', 'ship it', '--tier', '특', '--json'], { taskStatePath: path });
  expect(code).toBe(0);
  const card = JSON.parse(lines[0]!).card as TaskCard;
  expect(card.tier).toBe('특');
  expect(readTaskCard(card.id, path)?.tier).toBe('특');
  await expect(cli(['task', 'hand', 'ship it', '--tier', '최상', '--json'], { taskStatePath: path })).rejects.toThrow('invalid');
  const missionEffort = await cli(['task', 'hand', '--mission', '- a\n- b', '--child-llm-effort', 'high'], { taskStatePath: path });
  expect(missionEffort.code).toBe(1);
  expect(missionEffort.lines.join('\n')).toContain('과제 한 줄에만 준다');
});

test('TASKS-HAND-CHILD-LLM: split on the first / only · openrouter keeps the full id as model', () => {
  expect(parseChildLlm('grok/grok-4.7')).toEqual({ provider: 'grok', model: 'grok-4.7' });
  expect(parseChildLlm('local/qwen/qwen3-coder')).toEqual({ provider: 'local', model: 'qwen/qwen3-coder' });
  expect(parseChildLlm('openrouter/z-ai/glm-5.3')).toEqual({ provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3' });
  expect(parseChildLlm('openrouter/openrouter/z-ai/glm-5.3')).toEqual({ provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3' });
  expect(launchArgs({ text: 'x', childLlm: parseChildLlm('openrouter/z-ai/glm-5.3') }))
    .toEqual(['harness', 'say', '--substrate', 'pod', '--merge-by-host', '--child-llm-provider', 'openrouter', '--child-llm-model', 'openrouter/z-ai/glm-5.3', 'x']);
});

test('TASKS-HAND-CHILD-LLM: bad values are rejected and nothing is launched or written', async () => {
  for (const bad of ['grok', '/grok-4.7', 'grok/', '/', '', 'grok/ grok-4.7', ' grok/grok-4.7 ', 'grok/grok-4.7\n', 'grok/grok\u00074.7']) expect(() => parseChildLlm(bad)).toThrow('--child-llm');
  for (const bad of ['', ' high', 'high\n']) expect(() => parseChildLlm('grok/grok-4.7', bad)).toThrow('--child-llm-effort');
  const path = statePath();
  const calls: string[][] = [];
  const launcher = (args: string[]) => { calls.push(args); };
  for (const args of [['--child-llm', 'grok'], ['--child-llm', 'grok/'], ['--child-llm-effort', 'high'], ['--child-llm', 'grok/grok-4.7', '--child-llm-effort', ' ']]) {
    const { lines, code } = await cli(['task', 'hand', 'ship it', ...args, '--live'], { taskStatePath: path, taskLauncher: launcher });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('--child-llm');
  }
  expect(calls).toHaveLength(0);
  expect(readTaskAgentState<{ tasks?: Record<string, unknown> }>(path).tasks ?? {}).toEqual({});
  for (const extra of [['--child-llm', 'grok/grok-4.7'], ['--child-llm-effort', 'high']]) {
    const mission = await cli(['task', 'hand', '--mission', '- a\n- b', ...extra, '--live'], { taskStatePath: path, taskLauncher: launcher });
    expect(mission.code).toBe(1);
    expect(mission.lines.join('\n')).toContain('--child-llm');
  }
  expect(calls).toHaveLength(0);
  expect(readTaskAgentState<{ tasks?: Record<string, unknown> }>(path).tasks ?? {}).toEqual({});
});

test('TASKS-HAND-CHILD-LLM: --goal-file style path text ⊕ --child-llm coexist — file body inlined, card childLlm, flags before the body', async () => {
  const path = statePath();
  const goal = join(mkdtempSync(join(tmpdir(), 'task-hand-goal-')), 'GOAL-x.md');
  writeFileSync(goal, '# 골\n본문 한 줄\n');
  const calls: string[][] = [];
  const { lines, code } = await cli(['task', 'hand', goal, '--child-llm', 'openrouter/z-ai/glm-5.3', '--live', '--json'], {
    taskStatePath: path,
    taskLauncher: (args, _cwd, context) => { calls.push(args); return { runId: context!.runId }; },
  });
  expect(code).toBe(0);
  expect(calls).toEqual([['harness', 'say', '--substrate', 'pod', '--merge-by-host', '--child-llm-provider', 'openrouter', '--child-llm-model', 'openrouter/z-ai/glm-5.3', readFileSync(goal, 'utf8').trim()]]);
  const card = readTaskCard(JSON.parse(lines[0]!).card.id, path)!;
  expect(card.text).toContain('본문 한 줄');
  expect(card.childLlm).toEqual({ provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3' });
});

test('run identity: P0 칸 손 발사가 identity class=critical·care=special·protect 로 태어난다', async () => {
  const path = statePath();
  const { card } = await handTask({ id: 'ta-run-id-p0', text: 'P0 칸 손 발사', checklistId: 'RUN-IDENTITY-TAGS',
    checklistCell: () => ({ title: '런 신분 태그 칸', priority: 'P0', version: '0.2.32' }), statePath: path });
  expect(card.identity?.class).toBe('critical');
  expect(card.identity?.care).toBe('special');
  expect(card.identity?.rights).toBe('s'); // 출생은 권한을 올리지 않는다(올림은 --tag rights=… 명시만)
  expect(card.identity?.protect).toBe(true);
  expect(card.identity?.origin).toEqual({ checklistId: 'RUN-IDENTITY-TAGS', version: '0.2.32', launcher: 'hand' });
  expect(readTaskCard('ta-run-id-p0', path)?.identity).toEqual(card.identity); // 카드 상태 파일 = 원장 정본
  expect(runPriorityClass(card.identity)).toBe('critical'); // GATE-PRIORITY «run priority» 흡수
});

test('run identity: --tag class=gate 가 출생 신분을 덮는다', async () => {
  const path = statePath();
  const { card } = await handTask({ id: 'ta-run-id-tag', text: '태그 덮기', checklistId: 'CELL-TAG-1',
    checklistCell: () => ({ title: '칸', priority: 'P0' }), tags: ['class=gate'], statePath: path });
  expect(card.identity?.class).toBe('gate');
  expect(card.identity?.care).toBe('special'); // 덮지 않은 칸은 출생값 그대로다.
  expect(card.identity?.protect).toBe(true);
  expect(readTaskCard('ta-run-id-tag', path)?.identity?.class).toBe('gate');
});

test('run identity: 목록 밖 값·모르는 칸은 카드를 적기 전에 거부한다', async () => {
  expect(() => parseRunIdentityTag('class=bogus')).toThrow('gate|landing|critical|normal|idle');
  expect(() => parseRunIdentityTag('priority=P0')).toThrow('class|care|rights|protect');
  expect(() => parseRunIdentityTag('protect=yes')).toThrow('true|false');
  const path = statePath();
  await expect(handTask({ text: '거부', checklistId: 'CELL-TAG-2', tags: ['class=bogus'], statePath: path }))
    .rejects.toThrow('gate|landing|critical|normal|idle');
});

test('run identity: 칸을 못 찾으면 신분을 «모른다»로 비운다 — 기본 normal 을 사실처럼 적지 않는다', async () => {
  const path = statePath();
  const { card } = await handTask({ id: 'ta-run-id-plain', text: '기본 신분', checklistId: 'UNKNOWN-CELL-ID', checklistCell: () => undefined, statePath: path });
  expect(card.identity).toBeUndefined();
  expect(readTaskCard('ta-run-id-plain', path)?.identity).toBeUndefined();
  expect(launchArgs(card).includes('--run-priority')).toBe(false);
  // 명시 태그가 있으면 그 태그가 신분의 근거다.
  const tagged = await handTask({ id: 'ta-run-id-plain-tag', text: '태그만', checklistId: 'UNKNOWN-CELL-ID', checklistCell: () => undefined, tags: ['class=landing'], statePath: path });
  expect(tagged.card.identity?.class).toBe('landing');
});

test('RUN-IDENTITY-TAGS: 판 지정 출생 카드가 신분이 없어도 판을 보존하고 실제 tasks tag 가 그 판에서 재조회한다', async () => {
  const config = mkdtempSync(join(tmpdir(), 'task-run-identity-version-'));
  setElanousConfigDir(config);
  try {
    const version = checklistDevVersion();
    const checklistId = 'RUN-ID-VERSIONED-BIRTH';
    addItem(version, { id: checklistId, title: '판 지정 출생 칸', priority: 'P0' });
    const path = statePath();
    const { card } = await handTask({ id: 'ta-versioned-birth', text: '판 지정 카드', checklistId,
      checklistVersion: version, checklistCell: () => undefined, statePath: path });
    expect(card.identity).toBeUndefined();
    expect(readTaskCard(card.id, path)?.checklistVersion).toBe(version);

    const tag = await cli(['task', 'tag', card.id, 'rights=m', '--by', 'OP'], { taskStatePath: path });
    expect(tag.code ?? 0).toBe(0);
    expect(readTaskCard(card.id, path)?.identity).toEqual({ class: 'critical', care: 'special', rights: 'm', protect: true,
      origin: { checklistId, version } });
  } finally { resetElanousConfigDir(); }
});

test('RUN-IDENTITY-TAGS CLI: tasks hand --tag · tasks tag · tasks show 실명령 — 신분·감사 줄·Pod 라벨이 원장과 화면에 남는다', async () => {
  const path = statePath();
  // ① tasks hand --tag — 출생 신분을 덮는다(registerTasksCommands 실명령 경로).
  const hand = await cli(['task', 'hand', '게이트 승격 손', '--tag', 'class=landing', '--tag', 'protect=true', '--json'], { taskStatePath: path });
  expect(hand.code).toBe(0);
  const handed = JSON.parse(hand.lines[0]!).card as TaskCard;
  expect(handed.identity?.class).toBe('landing');
  expect(readTaskCard(handed.id, path)?.identity?.class).toBe('landing'); // 카드 상태 파일 = 원장 정본
  // ② tasks tag — history 에 감사 줄 run-tag-change {from, to, by, reason} 가 남는다(실명령 경로).
  const tag = await cli(['task', 'tag', handed.id, 'class=gate', '--by', 'OP', '--reason', '게이트 칸으로 승격'], { taskStatePath: path });
  expect(tag.code).toBe(0);
  expect(tag.lines.some((line) => line === `${handed.id}\tclass=gate`)).toBe(true);
  // 칸 없는 손 — 확인된 칸은 명시 태그뿐이다(덮지 않은 칸은 «미기록»).
  expect(tag.lines.some((line) => line === '신분 class=gate · care=미기록 · rights=미기록 · protect=true — 출생 hand')).toBe(true);
  const stored = readTaskCard(handed.id, path)!; // 카드 상태 파일 = 원장 정본 — 같이 바뀐다.
  expect(stored.identity?.class).toBe('gate');
  expect(stored.identity?.protect).toBe(true);
  const audits = stored.history.filter((item) => item.event === RUN_TAG_CHANGE_EVENT);
  expect(audits.length).toBe(1);
  expect(audits[0]?.from).toBe('landing');
  expect(audits[0]?.to).toBe('gate');
  expect(audits[0]?.by).toBe('OP');
  expect(audits[0]?.reason).toBe('게이트 칸으로 승격');
  expect(audits[0]?.detail).toBe('class landing→gate');
  // ③ tasks show — 신분 한 줄 · Pod 라벨 렌더(원장 정본 2줄 · 화면 출력).
  const show = await cli(['task', 'show', handed.id], { taskStatePath: path });
  expect(show.code).toBe(0);
  expect(show.lines).toContain('신분 class=gate · care=미기록 · rights=미기록 · protect=true — 출생 hand');
  expect(show.lines).toContain(`Pod 라벨 ${TASK_CARD_LABEL}=${handed.id} (신분 값은 Pod 라벨 미탑재 — RUN-IDENTITY-ADMIT)`); // 경계를 화면이 밝힌다
});

test('RUN-IDENTITY 승인·선점: 신분 계급이 발사 인자 --run-priority 로 흘러 대기열 줄 우선순위가 된다', async () => {
  const path = statePath();
  const { card } = await handTask({ id: 'ta-run-id-prio', text: '비상 칸 손', checklistId: 'CELL-TAG-7', checklistCell: () => ({ title: '칸', priority: 'P0' }), statePath: path });
  expect(card.identity?.class).toBe('critical');
  expect(launchArgs(card)).toEqual(expect.arrayContaining(['--run-priority', '150'])); // 비상 신분 → 칸 러브릭보다 위
  const gate = await handTask({ id: 'ta-run-id-gate', text: '게이트 손', tags: ['class=gate'], statePath: path });
  expect(launchArgs(gate.card)).toEqual(expect.arrayContaining(['--run-priority', '200'])); // 게이트 직진
  const plain = await handTask({ id: 'ta-run-id-plain', text: '보통 손', statePath: path });
  expect(plain.card.identity).toBeUndefined(); // 보통은 신분 줄을 안 남긴다(종전 그대로)
  expect(launchArgs(plain.card).includes('--run-priority')).toBe(false); // 칸 러브릭 그대로 — 값 없음
});

test('run identity 정본: parse/validate — 목록 밖 값은 거부한다', () => {
  expect(parseRunIdentityTag('class=landing')).toEqual({ key: 'class', value: 'landing' });
  expect(parseRunIdentityTag('care=icu')).toEqual({ key: 'care', value: 'icu' });
  expect(parseRunIdentityTag('rights=m')).toEqual({ key: 'rights', value: 'm' });
  expect(parseRunIdentityTag('protect=false')).toEqual({ key: 'protect', value: false });
  expect(() => parseRunIdentityTag('care=bogus')).toThrow('standard|special|icu');
  expect(() => parseRunIdentityTag('rights=x')).toThrow('s|m|l');
  const valid: RunIdentity = { class: 'idle', care: 'icu', rights: 's', protect: false, origin: { checklistId: 'C-1', version: '0.2.32', seat: 'OP', launcher: 'queue' } };
  expect(validateRunIdentity(valid)).toBe(valid);
  expect(() => validateRunIdentity({ class: 'bogus', care: 'standard', rights: 's', origin: { launcher: 'hand' } } as unknown as RunIdentity)).toThrow('gate|landing|critical|normal|idle');
  expect(() => validateRunIdentity({ class: 'normal', care: 'standard', rights: 's', origin: { launcher: 'bogus' } } as unknown as RunIdentity)).toThrow('dispatcher|hand|queue|doctor');
});

test('run identity 출생: 칸 우선순위·대표 표시 규칙', () => {
  expect(deriveBirthIdentity({ priority: 'P0' }, { launcher: 'hand' }))
    .toEqual({ class: 'critical', care: 'special', rights: 's', protect: true, origin: { launcher: 'hand' } });
  expect(deriveBirthIdentity({ priority: 'P1', title: '칸' }, { launcher: 'dispatcher' }))
    .toEqual({ class: 'normal', care: 'standard', rights: 's', protect: false, origin: { launcher: 'dispatcher' } });
  expect(deriveBirthIdentity({ priority: 'P2', title: '\u{1F451} 지시 칸' }, { launcher: 'hand' })) // 대표 표시는 care·protect 만 올린다.
    .toEqual({ class: 'normal', care: 'special', rights: 's', protect: true, origin: { launcher: 'hand' } });
  expect(runPriorityClass(null)).toBe('normal'); // GATE-PRIORITY «run priority» 흡수 — 없으면 normal
  expect(runPriorityClass({ class: 'landing' })).toBe('landing');
});

test('run identity 통합: 실제 P0 칸보드 픽스처에서 tasks hand → 카드 원장 신분 ⊕ 그 카드 발사 인자로 만든 대기열 줄 우선순위', async () => {
  const config = mkdtempSync(join(tmpdir(), 'task-run-identity-board-'));
  setElanousConfigDir(config);
  try {
    // 주입 seam 없이 실제 칸보드(체크리스트 원장)에 P0 칸을 적는다.
    const version = checklistDevVersion();
    addItem(version, { id: 'RUN-ID-P0-FIXTURE', title: '런 신분 P0 픽스처 칸', priority: 'P0' });
    addItem(version, { id: 'RUN-ID-P1-FIXTURE', title: '런 신분 P1 픽스처 칸', priority: 'P1' });
    const path = statePath();
    const hand = await cli(['task', 'hand', '--checklist', 'RUN-ID-P0-FIXTURE', '--seat', 'OP', '--json'], { taskStatePath: path, releaseVersions: () => [] });
    expect(hand.code ?? 0).toBe(0);
    const handed = JSON.parse(hand.lines[0]!) as { card: TaskCard; move: { command: string[] } };
    const stored = readTaskCard(handed.card.id, path)!; // 카드 상태 파일 = 원장 정본
    expect(stored.identity).toEqual({ class: 'critical', care: 'special', rights: 's', protect: true,
      origin: { checklistId: 'RUN-ID-P0-FIXTURE', version, seat: 'OP', launcher: 'hand' } });
    const plainHand = await cli(['task', 'hand', '--checklist', 'RUN-ID-P1-FIXTURE', '--seat', 'OP', '--json'], { taskStatePath: path, releaseVersions: () => [] });
    expect(plainHand.code ?? 0).toBe(0);
    const plain = JSON.parse(plainHand.lines[0]!) as { card: TaskCard; move: { command: string[] } };
    expect(readTaskCard(plain.card.id, path)?.identity?.class).toBe('normal');
    // 그 카드가 만든 발사 명령을 «실제 harness CLI» 로 돌린다 — 대기열 줄 우선순위는 harness 가 --run-priority 를 읽어 정한다.
    expect(handed.move.command).toEqual(expect.arrayContaining(['--run-priority', '150']));
    expect(plain.move.command.includes('--run-priority')).toBe(false);
    const queueRoot = mkdtempSync(join(tmpdir(), 'task-run-identity-queue-'));
    const launches: string[][] = [];
    const queue: HarnessQueueDeps = { root: queueRoot, authorShadow: () => {}, idleRequest: () => {}, processes: () => [], cap: () => 0,
      pool: () => ({ running: 0, pending: 0, reserved: 0, limit: 8 }), launch: async (_item, args) => { launches.push(args); return 901; }, log: () => {} };
    const harness = new Command().exitOverride();
    installHarnessCliCommand(harness, { registerSink: async () => {}, resolveSurface: async () => 'harness',
      say: async () => { throw Error('queue path must not dispatch directly'); }, ask: async () => { throw Error('queue path must not dispatch directly'); }, queue });
    const oldFlag = process.env.ELANOUS_HARNESS_QUEUE_DIRECT_SAY;
    const oldLaunch = process.env.ELANOUS_HARNESS_QUEUE_LAUNCH;
    const oldExit = process.exitCode;
    const oldPool = process.env.ELANOUS_POD_POOL;
    try {
      process.env.ELANOUS_POD_POOL = 'pool-test:1'; // 카드 명령은 --substrate pod — 풀은 명시(쿠버 컨텍스트에 안 닿는다 · 발사는 주입 launch)
      process.env.ELANOUS_HARNESS_QUEUE_DIRECT_SAY = '1';
      delete process.env.ELANOUS_HARNESS_QUEUE_LAUNCH;
      setUserConfigOverlay((config) => ({ ...config, harness: { ...config.harness, queue: { ...config.harness?.queue, directSay: true } } }));
      await harness.parseAsync(['node', 'elanous', ...plain.move.command]);
      await harness.parseAsync(['node', 'elanous', ...handed.move.command]);
      const rows = listHarnessQueue(queue);
      expect(rows).toHaveLength(2);
      const plainRow = rows.find((row) => row.input === plain.card.text)!;
      const row = rows.find((row) => row.input === handed.card.text)!;
      expect(row.priority).toBe(150); // critical 신분 → harness 가 읽은 줄 우선순위
      expect(plainRow.priority).not.toBe(150);
      expect(queueHeadBefore(row, plainRow)).toBe(true); // 늦게 와도 P0 신분 줄이 줄 머리를 잡는다
    } finally {
      setUserConfigOverlay(null); process.exitCode = oldExit ?? 0;
      if (oldFlag === undefined) delete process.env.ELANOUS_HARNESS_QUEUE_DIRECT_SAY; else process.env.ELANOUS_HARNESS_QUEUE_DIRECT_SAY = oldFlag;
      if (oldLaunch === undefined) delete process.env.ELANOUS_HARNESS_QUEUE_LAUNCH; else process.env.ELANOUS_HARNESS_QUEUE_LAUNCH = oldLaunch;
      if (oldPool === undefined) delete process.env.ELANOUS_POD_POOL; else process.env.ELANOUS_POD_POOL = oldPool;
      rmSync(queueRoot, { recursive: true, force: true });
    }
  } finally { resetElanousConfigDir(); }
});

test('run identity: tasks tag <card> k=v 칸 꼴 그대로 성공 — --by 없으면 ELANOUS_TRACK, 없으면 unknown', async () => {
  const path = statePath();
  const { card } = await handTask({ id: 'ta-run-id-noby', text: '태그 by 기본', tags: ['class=normal'], statePath: path });
  const oldTrack = process.env.ELANOUS_TRACK;
  try {
    delete process.env.ELANOUS_TRACK;
    const plain = await cli(['task', 'tag', card.id, 'class=gate'], { taskStatePath: path });
    expect(plain.code ?? 0).toBe(0);
    process.env.ELANOUS_TRACK = 'MK';
    const tracked = await cli(['task', 'tag', card.id, 'care=icu'], { taskStatePath: path });
    expect(tracked.code ?? 0).toBe(0);
  } finally { if (oldTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = oldTrack; }
  const audits = readTaskCard(card.id, path)!.history.filter((item) => item.event === RUN_TAG_CHANGE_EVENT);
  expect(audits.map((item) => [item.from, item.to, item.by])).toEqual([['normal', 'gate', 'unknown'], ['미기록', 'icu', 'MK']]); // care 는 확인된 적 없다
});

test('run identity: 주입한 칸 조회의 «칸 없음»이 최종 — 기본 칸보드에 같은 id 의 P0 칸이 있어도 재조회하지 않는다', async () => {
  const config = mkdtempSync(join(tmpdir(), 'task-run-identity-injected-'));
  setElanousConfigDir(config);
  try {
    addItem(checklistDevVersion(), { id: 'RUN-ID-SHADOW-P0', title: '기본 칸보드의 P0 칸', priority: 'P0' });
    const path = statePath();
    // 반증: 조회기 없이 판을 넘기면 그 칸보드가 P0 를 읽어 critical 로 태어난다.
    const fromBoard = await handTask({ id: 'ta-run-id-board', text: '기본 보드', checklistId: 'RUN-ID-SHADOW-P0', checklistVersion: checklistDevVersion(), statePath: path });
    expect(fromBoard.card.identity?.class).toBe('critical');
    const injected = await handTask({ id: 'ta-run-id-injected', text: '주입 없음', checklistId: 'RUN-ID-SHADOW-P0', checklistCell: () => undefined, statePath: path });
    expect(injected.card.identity).toBeUndefined();
    expect(launchArgs(injected.card).includes('--run-priority')).toBe(false);
  } finally { resetElanousConfigDir(); }
});

test('run identity: tasks hand --tag class=gate "할 일" — 옵션을 앞에 써도 본문은 태그가 아니다(반복 수집)', async () => {
  const path = statePath();
  const res = await cli(['task', 'hand', '--tag', 'class=gate', '--tag', 'protect=true', '할 일', '--json'], { taskStatePath: path });
  expect(res.code ?? 0).toBe(0);
  const { card } = JSON.parse(res.lines[0]!) as { card: TaskCard };
  expect(card.text).toBe('할 일');
  expect(card.identity?.class).toBe('gate');
  expect(card.identity?.protect).toBe(true);
});

test('run identity ②: 칸 조회 실패 ⊕ --tag class=… 하나 — 명시 태그만 신분에 담고 나머지는 원장·tasks show 모두 «미기록»', async () => {
  const path = statePath();
  const { card } = await handTask({ id: 'ta-run-id-partial', text: '칸 못 읽음 ⊕ 태그 하나', checklistId: 'UNKNOWN-CELL-ID', seat: 'OP',
    checklistCell: () => undefined, tags: ['class=gate'], statePath: path });
  // 반증: 수리 전엔 deriveBirthIdentity({}) 가 care=standard·rights=s·protect=false 를 사실처럼 채웠다.
  expect(card.identity).toEqual({ class: 'gate', origin: { checklistId: 'UNKNOWN-CELL-ID', seat: 'OP', launcher: 'hand' } });
  const stored = readTaskCard('ta-run-id-partial', path)!;
  expect(stored.identity?.care).toBeUndefined();
  expect(stored.identity?.rights).toBeUndefined();
  expect(stored.identity?.protect).toBeUndefined();
  const show = await cli(['task', 'show', 'ta-run-id-partial'], { taskStatePath: path });
  expect(show.code ?? 0).toBe(0);
  expect(show.lines).toContain('신분 class=gate · care=미기록 · rights=미기록 · protect=미기록 — 출생 UNKNOWN-CELL-ID · OP · hand');
  expect(show.lines.join('\n')).not.toContain('care=standard');
});

test('run identity ③: 신분 없는 옛 카드 tasks tag — 칸을 다시 조회해 출생값을 세우고 출생 자리는 지어내지 않는다', async () => {
  const path = statePath();
  const lookups: string[] = [];
  const { card } = await handTask({ id: 'ta-run-id-old-ok', text: '옛 카드', checklistId: 'OLD-P0-CELL', seat: 'MK', checklistCell: () => undefined, statePath: path });
  {
    expect(card.identity).toBeUndefined();
    const changed = runTagChange(card.id, { tag: 'care=icu', by: 'OP', checklistCell: (id) => { lookups.push(id); return { title: '칸', priority: 'P0', version: '0.2.31' }; } }, path)!;
    expect(lookups).toEqual(['OLD-P0-CELL']); // 재조회했다
    // 반증: 수리 전엔 재조회 없이 class=normal·protect=false ⊕ launcher='hand' 로 확정했다.
    expect(changed.identity).toEqual({ class: 'critical', care: 'icu', rights: 's', protect: true, origin: { checklistId: 'OLD-P0-CELL', version: '0.2.31', seat: 'MK' } });
    expect(changed.identity?.origin.launcher).toBeUndefined();
    const audit = changed.history.filter((item) => item.event === RUN_TAG_CHANGE_EVENT)[0]!;
    expect([audit.from, audit.to]).toEqual(['special', 'icu']);
  }
});

test('run identity ③: 신분 없는 옛 카드 tasks tag — 재조회도 실패하면 명시 태그만 담고 나머지·출생 자리는 «미기록»', async () => {
  const path = statePath();
  const { card } = await handTask({ id: 'ta-run-id-old-miss', text: '옛 카드', checklistId: 'GONE-CELL', checklistCell: () => undefined, statePath: path });
  const changed = runTagChange(card.id, { tag: 'class=landing', by: 'OP', checklistCell: () => undefined }, path)!;
  expect(changed.identity).toEqual({ class: 'landing', origin: { checklistId: 'GONE-CELL' } });
  const audit = changed.history.filter((item) => item.event === RUN_TAG_CHANGE_EVENT)[0]!;
  expect([audit.from, audit.to]).toEqual(['미기록', 'landing']);
  const show = await cli(['task', 'show', card.id], { taskStatePath: path });
  expect(show.lines).toContain('신분 class=landing · care=미기록 · rights=미기록 · protect=미기록 — 출생 GONE-CELL');
});

test('run identity ③ CLI: tasks tag 기본 조회가 실제 칸보드에서 옛 카드의 칸을 다시 읽는다', async () => {
  const config = mkdtempSync(join(tmpdir(), 'task-run-identity-relookup-'));
  setElanousConfigDir(config);
  try {
    const version = checklistDevVersion();
    addItem(version, { id: 'RUN-ID-RELOOKUP-P0', title: '옛 카드 P0 칸', priority: 'P0' });
    const path = statePath();
    const { card } = await handTask({ id: 'ta-run-id-relookup', text: '옛 카드', checklistId: 'RUN-ID-RELOOKUP-P0', checklistCell: () => undefined, statePath: path });
    expect(card.identity).toBeUndefined();
    setCardChecklistVersion(path, card.id, version); // 판을 아는 옛 카드(입양 카드처럼)
    const tag = await cli(['task', 'tag', card.id, 'rights=m', '--by', 'OP'], { taskStatePath: path });
    expect(tag.code ?? 0).toBe(0);
    expect(readTaskCard(card.id, path)?.identity).toEqual({ class: 'critical', care: 'special', rights: 'm', protect: true,
      origin: { checklistId: 'RUN-ID-RELOOKUP-P0', version } });
  } finally { resetElanousConfigDir(); }
});

test('run identity 정본: 칸마다 optional — 있는 칸만 검증하고 없는 칸은 «미기록»', () => {
  const partial: RunIdentity = { class: 'gate', origin: {} };
  expect(validateRunIdentity(partial)).toBe(partial);
  expect(() => validateRunIdentity({ care: 'bogus', origin: {} } as unknown as RunIdentity)).toThrow('standard|special|icu');
  // 출생 기록이 없으면 «미기록»(빈 출생 기록) — 거부하지도 지어내지도 않는다(RUN-IDENTITY-TAGS-2).
  expect(validateRunIdentity({ class: 'gate' } as unknown as RunIdentity)).toEqual({ class: 'gate', origin: {} });
  expect(runPriorityClass(partial)).toBe('gate');
  expect(runPriorityClass({ origin: {} } as RunIdentity)).toBe('normal'); // 승인·선점은 normal 로 «읽을» 뿐
});

test('run identity 출생: 읽은 칸이라도 priority·title 이 비면 그 값에서 파생되는 칸은 «미기록»', async () => {
  // 반증: 수리 전엔 빈 priority/title 이 class=normal·care=standard·protect=false 로 확정됐다.
  expect(deriveBirthIdentity({}, { launcher: 'hand' })).toEqual({ rights: 's', origin: { launcher: 'hand' } });
  expect(deriveBirthIdentity({ priority: '  ', title: '' }, { launcher: 'hand' })).toEqual({ rights: 's', origin: { launcher: 'hand' } });
  expect(deriveBirthIdentity({ priority: 'P1' }, { launcher: 'hand' })).toEqual({ class: 'normal', rights: 's', origin: { launcher: 'hand' } }); // 대표 여부 모름
  expect(deriveBirthIdentity({ title: '칸' }, { launcher: 'hand' })).toEqual({ rights: 's', origin: { launcher: 'hand' } }); // P0 여부 모름
  expect(deriveBirthIdentity({ title: '\u{1F451} 칸' }, { launcher: 'hand' })).toEqual({ care: 'special', rights: 's', protect: true, origin: { launcher: 'hand' } }); // 대표 는 보이면 올린다 · class 는 모름
  const path = statePath();
  const { card } = await handTask({ id: 'ta-run-id-blank-cell', text: '빈 칸 값', checklistId: 'BLANK-CELL', checklistCell: () => ({ version: '0.2.31' }), statePath: path });
  expect(card.identity).toEqual({ rights: 's', origin: { checklistId: 'BLANK-CELL', version: '0.2.31', launcher: 'hand' } });
  const show = await cli(['task', 'show', card.id], { taskStatePath: path });
  expect(show.lines).toContain('신분 class=미기록 · care=미기록 · rights=s · protect=미기록 — 출생 BLANK-CELL · 0.2.31 · hand');
  expect(launchArgs(card).includes('--run-priority')).toBe(false);
});

test('RUN-IDENTITY-TAGS-2 ①: 원장 신분의 출생 기록 형태·타입이 틀리면 거부한다(배열 · 문자열 아닌 checklistId/version/seat)', () => {
  const ok: RunIdentity = { class: 'normal', origin: { checklistId: 'CELL', version: '0.2.31', seat: 'OP', launcher: 'hand' } };
  expect(validateRunIdentity(ok)).toBe(ok);
  expect(() => validateRunIdentity({ class: 'gate', origin: [] } as unknown as RunIdentity)).toThrow('origin 은 객체다');
  expect(() => validateRunIdentity({ class: 'gate', origin: ['CELL'] } as unknown as RunIdentity)).toThrow('origin 은 객체다');
  expect(() => validateRunIdentity({ class: 'gate', origin: null } as unknown as RunIdentity)).toThrow('origin 은 객체다');
  expect(() => validateRunIdentity({ class: 'gate', origin: 'CELL' } as unknown as RunIdentity)).toThrow('origin 은 객체다');
  expect(() => validateRunIdentity({ origin: { checklistId: 7 } } as unknown as RunIdentity)).toThrow('origin.checklistId 는 문자열이다');
  expect(() => validateRunIdentity({ origin: { version: 0.231 } } as unknown as RunIdentity)).toThrow('origin.version 는 문자열이다');
  expect(() => validateRunIdentity({ origin: { seat: { id: 'OP' } } } as unknown as RunIdentity)).toThrow('origin.seat 는 문자열이다');
  expect(() => validateRunIdentity([] as unknown as RunIdentity)).toThrow('run identity 는 객체다');
});

test('RUN-IDENTITY-TAGS-2 ①: tasks tag 가 출생 기록이 틀린 원장 카드를 적기 전에 거부한다(카드 불변)', () => {
  const path = statePath();
  const card: TaskCard = { id: 'ta-run-id-bad-origin', text: '틀린 출생', createdAt: '2026-10-16T00:00:00.000Z', status: 'handed', history: [],
    identity: { class: 'normal', origin: [] } as unknown as RunIdentity };
  writeFileSync(path, JSON.stringify({ tasks: { [card.id]: card } }));
  expect(() => runTagChange(card.id, { tag: 'class=gate', by: 'OP' }, path)).toThrow('origin 은 객체다');
  expect(readTaskCard(card.id, path)?.identity?.class).toBe('normal');
  expect(readTaskCard(card.id, path)?.history.length).toBe(0);
});

test('RUN-IDENTITY-TAGS-2 ②: 판이 다른 같은 id(우선순위 다름) — handTask 는 받은 판에서 읽고, 판을 모르면 확정하지 않는다', async () => {
  const config = mkdtempSync(join(tmpdir(), 'task-run-identity-version-'));
  setElanousConfigDir(config);
  try {
    const dev = checklistDevVersion();
    const other = '9.9.9';
    addItem(dev, { id: 'RUN-ID-TWO-BOARDS', title: '개발 판 칸', priority: 'P1' });
    addItem(other, { id: 'RUN-ID-TWO-BOARDS', title: '다른 판 칸', priority: 'P0' }, { allowDuplicateId: true });
    const path = statePath();
    // 반증: 수리 전엔 판을 넘길 길이 없어 늘 개발 판(P1 → normal)을 읽었다.
    const onOther = await handTask({ id: 'ta-run-id-other-board', text: '다른 판', checklistId: 'RUN-ID-TWO-BOARDS', checklistVersion: other, statePath: path });
    expect(onOther.card.identity).toEqual({ class: 'critical', care: 'special', rights: 's', protect: true,
      origin: { checklistId: 'RUN-ID-TWO-BOARDS', version: other, launcher: 'hand' } });
    expect(launchArgs(onOther.card)).toContain('--run-priority');
    const onDev = await handTask({ id: 'ta-run-id-dev-board', text: '개발 판', checklistId: 'RUN-ID-TWO-BOARDS', checklistVersion: dev, statePath: path });
    expect(onDev.card.identity?.class).toBe('normal');
    expect(onDev.card.identity?.origin.version).toBe(dev);
    expect(launchArgs(onDev.card).includes('--run-priority')).toBe(false);
    // 판 모름 — 개발 판의 같은 id 를 그 칸이라 짐작하지 않는다(«미기록»): 태그가 없으면 신분 없음 · 있으면 태그만.
    const unknown = await handTask({ id: 'ta-run-id-no-board', text: '판 모름', checklistId: 'RUN-ID-TWO-BOARDS', statePath: path });
    expect(unknown.card.identity).toBeUndefined();
    const unknownTagged = await handTask({ id: 'ta-run-id-no-board-tag', text: '판 모름 ⊕ 태그', checklistId: 'RUN-ID-TWO-BOARDS', seat: 'OP', tags: ['rights=m'], statePath: path });
    expect(unknownTagged.card.identity).toEqual({ rights: 'm', origin: { checklistId: 'RUN-ID-TWO-BOARDS', seat: 'OP', launcher: 'hand' } });
    // 통합: tasks hand --checklist … --version <다른 판> — CLI 가 칸을 찾은 판을 handTask 에 넘긴다(개발 판 밖 칸).
    const res = await cli(['task', 'hand', '--checklist', 'RUN-ID-TWO-BOARDS', '--version', other, '--json'], { taskStatePath: path, releaseBoard: () => [{ level: 'task', id: 'RUN-ID-TWO-BOARDS', title: '대상 경로: src/x.ts' }] as never });
    expect(res.code ?? 0).toBe(0);
    const viaCli = (JSON.parse(res.lines[0]!) as { card: TaskCard }).card;
    expect(viaCli.identity?.class).toBe('critical');
    expect(viaCli.identity?.origin.version).toBe(other);
  } finally { resetElanousConfigDir(); }
});

function setCardChecklistVersion(path: string, id: string, version: string | undefined): void {
  const state = JSON.parse(readFileSync(path, 'utf8')) as { tasks: Record<string, TaskCard> };
  if (version === undefined) delete state.tasks[id]!.checklistVersion; else state.tasks[id]!.checklistVersion = version;
  writeFileSync(path, JSON.stringify(state));
}

test('RUN-IDENTITY-TAGS-2 ②: 옛 카드 tasks tag — 판을 아는 카드는 그 판에서 다시 읽고, 판을 모르면 개발 판을 짐작하지 않는다', async () => {
  const config = mkdtempSync(join(tmpdir(), 'task-run-identity-tag-version-'));
  setElanousConfigDir(config);
  try {
    const dev = checklistDevVersion();
    const other = '9.9.8';
    addItem(dev, { id: 'RUN-ID-OLD-TWO', title: '개발 판 칸', priority: 'P1' });
    addItem(other, { id: 'RUN-ID-OLD-TWO', title: '다른 판 칸', priority: 'P0' }, { allowDuplicateId: true });
    const path = statePath();
    const known = await handTask({ id: 'ta-run-id-old-known', text: '옛 카드 · 판 앎', checklistId: 'RUN-ID-OLD-TWO', checklistCell: () => undefined, statePath: path });
    setCardChecklistVersion(path, known.card.id, other);
    const tagKnown = await cli(['task', 'tag', known.card.id, 'rights=m', '--by', 'OP'], { taskStatePath: path });
    expect(tagKnown.code ?? 0).toBe(0);
    expect(readTaskCard(known.card.id, path)?.identity).toEqual({ class: 'critical', care: 'special', rights: 'm', protect: true,
      origin: { checklistId: 'RUN-ID-OLD-TWO', version: other } });
    // 반증: 수리 전엔 판 없는 카드도 개발 판(P1)을 읽어 class=normal·origin.version=<개발 판> 을 확정했다.
    const unknown = await handTask({ id: 'ta-run-id-old-unknown', text: '옛 카드 · 판 모름', checklistId: 'RUN-ID-OLD-TWO', checklistCell: () => undefined, statePath: path });
    const tagUnknown = await cli(['task', 'tag', unknown.card.id, 'rights=m', '--by', 'OP'], { taskStatePath: path });
    expect(tagUnknown.code ?? 0).toBe(0);
    expect(readTaskCard(unknown.card.id, path)?.identity).toEqual({ rights: 'm', origin: { checklistId: 'RUN-ID-OLD-TWO' } });
    const show = await cli(['task', 'show', unknown.card.id], { taskStatePath: path });
    expect(show.lines).toContain('신분 class=미기록 · care=미기록 · rights=m · protect=미기록 — 출생 RUN-ID-OLD-TWO');
  } finally { resetElanousConfigDir(); }
});

test('RUN-IDENTITY-TAGS-2 ②: tasks tag 재조회 사이 카드 판이 바뀌면 옛 판의 신분을 적지 않는다', async () => {
  const path = statePath();
  const { card } = await handTask({ id: 'ta-run-id-old-race', text: '옛 카드', checklistId: 'RACE-CELL', checklistCell: () => undefined, statePath: path });
  setCardChecklistVersion(path, card.id, '0.2.31');
  const changed = runTagChange(card.id, { tag: 'rights=m', by: 'OP', checklistCell: () => {
    setCardChecklistVersion(path, card.id, '0.2.32'); // 잠금 밖 재조회 동안 판이 바뀐다
    return { title: '칸', priority: 'P0', version: '0.2.31' };
  } }, path)!;
  // 반증: 수리 전엔 checklistId 만 대조해 0.2.31 의 P0 신분(critical)을 0.2.32 카드에 적었다.
  expect(changed.identity).toEqual({ rights: 'm', origin: { checklistId: 'RACE-CELL' } });
  expect(changed.checklistVersion).toBe('0.2.32');
});

test('RUN-IDENTITY-TAGS-2 (a): 출생 기록은 plain object 만 — Date·배열·클래스 인스턴스는 거부, 원형 null 객체는 받는다', () => {
  class Origin { checklistId = 'CELL'; }
  expect(() => validateRunIdentity({ class: 'gate', origin: new Date(0) } as unknown as RunIdentity)).toThrow('origin 은 객체다');
  expect(() => validateRunIdentity({ class: 'gate', origin: new Origin() } as unknown as RunIdentity)).toThrow('origin 은 객체다');
  expect(() => validateRunIdentity({ class: 'gate', origin: ['CELL'] } as unknown as RunIdentity)).toThrow('origin 은 객체다');
  const bare = Object.assign(Object.create(null) as object, { checklistId: 'CELL' });
  const ok = { class: 'gate', origin: bare } as unknown as RunIdentity;
  expect(validateRunIdentity(ok)).toBe(ok);
});

test('RUN-IDENTITY-TAGS-2 (b): 주입 조회 결과의 판 ≠ 기대 판(카드 checklistVersion·넘긴 판)이면 칸 파생 신분을 확정하지 않는다', async () => {
  const path = statePath();
  const otherBoardP0 = () => ({ title: '칸', priority: 'P0', version: '0.2.32' });
  // handTask: 넘긴 판 0.2.31 인데 조회기가 0.2.32 의 P0 칸을 돌려준다 → 명시 태그만.
  const handed = await handTask({ id: 'ta-run-id-mismatch-hand', text: '판 불일치', checklistId: 'MISMATCH-CELL', checklistVersion: '0.2.31',
    checklistCell: otherBoardP0, tags: ['rights=m'], statePath: path });
  // 반증: 수리 전엔 v2 출생 기록 ⊕ critical 을 적었다.
  expect(handed.card.identity).toEqual({ rights: 'm', origin: { checklistId: 'MISMATCH-CELL', launcher: 'hand' } });
  expect(launchArgs(handed.card).includes('--run-priority')).toBe(false);
  // 같은 판이면 확정한다(대조군).
  const same = await handTask({ id: 'ta-run-id-match-hand', text: '판 일치', checklistId: 'MISMATCH-CELL', checklistVersion: '0.2.32', checklistCell: otherBoardP0, statePath: path });
  expect(same.card.identity?.class).toBe('critical');
  // runTagChange: 카드 판 0.2.31 · 조회기가 0.2.32 칸 → 명시 태그만.
  const old = await handTask({ id: 'ta-run-id-mismatch-tag', text: '옛 카드', checklistId: 'MISMATCH-CELL', checklistCell: () => undefined, statePath: path });
  setCardChecklistVersion(path, old.card.id, '0.2.31');
  const changed = runTagChange(old.card.id, { tag: 'rights=m', by: 'OP', checklistCell: otherBoardP0 }, path)!;
  expect(changed.identity).toEqual({ rights: 'm', origin: { checklistId: 'MISMATCH-CELL' } });
});

// ── TA-WORK-ORDER — 작업 지시서(work order) 스키마와 `tasks hand` 받기 첫 조각 ──

function workOrderFile(body: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'task-work-order-')), 'cell.work-order.json');
  writeFileSync(file, body);
  return file;
}

const fullWorkOrder = {
  lifeId: 'life-9f21', cellId: 'TA-WORK-ORDER', version: '0.2.33', landBy: '2026-10-15T00:00:00+09:00',
  identityTags: 'class=feat · care=normal · rights=rw · origin=op · rework=0',
  priority: '신호 order 1 · 승수 S · 판정자 대표',
  verdictSignal: '관측: focused 테스트 통과 · 기대: bun test src/task-agent/task-hand.test.ts 0 fail',
  contract: 'bun test src/task-agent/task-hand.test.ts → 26 pass / 0 fail',
  boundary: 'src/task-agent/task-hand.ts · src/task-agent/task-hand.test.ts · 신설 src/task-agent/work-order.ts',
  budget: '시간 4h · 모델 tier=best · Pod 자리 1 · 재작업 상한 2',
  peers: '선행 CARD-TARGET-PATHS · 짝 없음',
  precedents: '같은 칸 앞 생애 없음 — must-fix 서명 0',
  escalation: '판정선 밖이면 조율자(OP)에게 · 돈·보안은 대표 결정',
};

test('TA-WORK-ORDER ① 칸 아홉이 찬 지시서는 work-order 로 펼쳐지고 unknownFields 가 0이다', () => {
  const events: Array<{ category: string; event: string; data?: unknown }> = [];
  const off = debug.registerSink({ name: 'work-order-full-capture', emit: (rec) => { if (rec.category === 'task-agent.work-order') events.push(rec); } });
  let resolved: ReturnType<typeof resolveHandText>;
  try { resolved = resolveHandText(workOrderFile(JSON.stringify(fullWorkOrder))); } finally { off(); }
  expect(resolved.kind).toBe('work-order');
  expect(resolved).toMatchObject({ kind: 'work-order', path: expect.any(String), order: { cellId: 'TA-WORK-ORDER', unknownFields: [] } });
  if (resolved.kind !== 'work-order') return;
  const lines = resolved.text.split('\n');
  expect(lines[0]).toBe(`대상 경로: ${fullWorkOrder.boundary}`);
  expect(lines[1]).toBe(`현재 계약: ${fullWorkOrder.contract}`);
  expect(resolved.text).toContain(`칸 ${fullWorkOrder.cellId}`);
  expect(resolved.text).not.toContain('모름');
  expect(events).toContainEqual(expect.objectContaining({ event: 'parsed', data: expect.objectContaining({ cellId: 'TA-WORK-ORDER', unknownFields: [] }) }));
});

test('TA-WORK-ORDER ② 칸 셋이 빠진 지시서는 거부하지 않고 «모름»으로 채워 unknownFields 3 에 적는다', () => {
  const { budget: _budget, peers: _peers, precedents: _precedents, ...partial } = fullWorkOrder;
  const resolved = resolveHandText(workOrderFile(JSON.stringify(partial)));
  expect(resolved.kind).toBe('work-order');
  if (resolved.kind !== 'work-order') return;
  expect(resolved.order.unknownFields).toEqual(['budget', 'peers', 'precedents']);
  expect(resolved.order.budget).toBe('모름');
  const lines = resolved.text.split('\n');
  expect(lines[0]).toBe(`대상 경로: ${partial.boundary}`);
  expect(lines[1]).toBe(`현재 계약: ${partial.contract}`);
  expect(lines.filter((line) => line.includes('모름'))).toHaveLength(3);
});

test('TA-WORK-ORDER ③ 깨진 JSON 과 칸 id 없음은 kind rejected 와 사유를 돌려준다', () => {
  const events: Array<{ category: string; event: string; data?: unknown }> = [];
  const off = debug.registerSink({ name: 'work-order-reject-capture', emit: (rec) => { if (rec.category === 'task-agent.work-order') events.push(rec); } });
  let broken: ReturnType<typeof resolveHandText>;
  let noCellId: ReturnType<typeof resolveHandText>;
  try {
    broken = resolveHandText(workOrderFile('{ "cellId": "TA-1" '));
    noCellId = resolveHandText(workOrderFile(JSON.stringify({ boundary: 'src/a.ts' })));
  } finally { off(); }
  expect(broken).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('JSON 이 깨졌다') });
  expect(noCellId).toMatchObject({ kind: 'rejected', reason: '칸 id 가 없다' });
  expect(events).toContainEqual(expect.objectContaining({ event: 'rejected', data: expect.objectContaining({ cellId: null, unknownFields: [] }) }));
});

test('TA-WORK-ORDER ④ md/txt 골 파일과 일반 json 은 종전대로 inlined — 지시서 검증은 .work-order.json 만', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-work-order-preserve-'));
  const goal = join(dir, 'GOAL.md');
  writeFileSync(goal, '대상 경로: a\n현재 계약: b\n');
  expect(resolveHandText(goal)).toMatchObject({ kind: 'inlined', text: '대상 경로: a\n현재 계약: b\n' });
  const plain = join(dir, 'plain.json');
  writeFileSync(plain, '{"cellId": "TA-1"}');
  expect(resolveHandText(plain)).toMatchObject({ kind: 'inlined' });
  // 없는 .work-order.json 은 다른 확장자와 같이 글자 그대로의 과제 한 줄로 둔다(종전 규칙).
  expect(resolveHandText(join(dir, 'absent.work-order.json'))).toEqual({ kind: 'unchanged', text: join(dir, 'absent.work-order.json') });
});

test('TA-WORK-ORDER parseWorkOrder — 배열·스칼라 JSON 은 칸 id 없음, 비문자열 칸은 읽을 수 있는 문자열로 채운다', () => {
  expect(parseWorkOrder('[1,2]')).toEqual({ ok: false, reason: '칸 id 가 없다' });
  expect(parseWorkOrder('42')).toEqual({ ok: false, reason: '칸 id 가 없다' });
  expect(parseWorkOrder('{}')).toEqual({ ok: false, reason: '칸 id 가 없다' });
  const parsed = parseWorkOrder(JSON.stringify({ cellId: ' C1 ', budget: 2, peers: ['a', 'b'], verdictSignal: '   ' }));
  expect(parsed).toMatchObject({ ok: true, order: { cellId: 'C1', budget: '2', peers: '["a","b"]', verdictSignal: '모름',
    unknownFields: ['lifeId', 'version', 'landBy', 'identityTags', 'priority', 'verdictSignal', 'contract', 'boundary', 'precedents', 'escalation'] } });
});

test('TA-WORK-ORDER — task hand <지시서 파일> 은 펼친 골 문면을 카드 text 로 싣는다', async () => {
  const path = statePath();
  const { lines, code } = await cli(['task', 'hand', workOrderFile(JSON.stringify(fullWorkOrder)), '--json'], { taskStatePath: path });
  expect(code).toBeFalsy();
  const card = JSON.parse(lines[0]!).card as TaskCard;
  expect(card.text.split('\n')[0]).toBe(`대상 경로: ${fullWorkOrder.boundary}`);
  expect(card.text.split('\n')[1]).toBe(`현재 계약: ${fullWorkOrder.contract}`);
  expect(readTaskCard(card.id, path)?.text).toBe(card.text);
});

test('abandonedDraftReleaseNote — failed 카드 ⊕ PR 있으면 그 PR 의 처리 끝 문면', () => {
  const at = new Date('2026-10-17T03:00:00Z');
  const card: TaskCard = { id: 'ta-one', text: 'draft', createdAt: '2026-10-10T00:00:00Z',
    status: 'failed', history: [], pr: { number: 19 } };
  expect(abandonedDraftReleaseNote(card, at)).toEqual({ pr: 19, body: `🔧 처리 끝 — 2026-10-17T03:00:00.000Z · ta-one 포기 경로 — 자동` });
});

test('abandonedDraftReleaseNote — launch-failed 카드 ⊕ PR 있으면 그 PR 의 처리 끝 문면', () => {
  const at = new Date('2026-10-17T03:00:00Z');
  const card: TaskCard = { id: 'ta-two', text: 'draft', createdAt: '2026-10-10T00:00:00Z',
    status: 'launch-failed', history: [], pr: 42 };
  expect(abandonedDraftReleaseNote(card, at)).toEqual({ pr: 42, body: `🔧 처리 끝 — 2026-10-17T03:00:00.000Z · ta-two 포기 경로 — 자동` });
});

test('abandonedDraftReleaseNote — launched · handed 는 null', () => {
  const at = new Date('2026-10-17T03:00:00Z');
  for (const status of ['launched', 'handed'] as const) {
    const card: TaskCard = { id: 'ta-three', text: 'draft', createdAt: '2026-10-10T00:00:00Z',
      status, history: [], pr: { number: 19 } };
    expect(abandonedDraftReleaseNote(card, at)).toBeNull();
  }
});

test('abandonedDraftReleaseNote — PR 없는 포기 카드는 null', () => {
  const at = new Date('2026-10-17T03:00:00Z');
  for (const status of ['failed', 'launch-failed'] as const) {
    const card: TaskCard = { id: 'ta-four', text: 'draft', createdAt: '2026-10-10T00:00:00Z',
      status, history: [] };
    expect(abandonedDraftReleaseNote(card, at)).toBeNull();
  }
});
