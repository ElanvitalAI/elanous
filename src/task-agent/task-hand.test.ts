import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Command } from 'commander';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { registerTasksCommands, spawnDetachedConfirmed, type DetachedSpawn } from '../cli/tasks-cli.js';
import { debug } from '../debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { closeTaskCard, draftTaskOwner, handTask, launchArgs, nextMoveFor, parseChildLlm, resolveHandText, readTaskAgentState, readTaskCard, selectTaskComposition, TASK_CARD_LABEL, taskCardLabelContext, TaskAgentStateError, type TaskCard, type TaskLaunchContext } from './task-hand.js';

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
  expect(lines[1]).toContain('다음 수: launch');
  expect(lines[1]).toContain(launchArgs(card).slice(0, 4).join(' '));
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
