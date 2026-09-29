import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestIntakeItems, loadIntakeLedger, markIntakeItem } from './items.js';
import { TASK_DEFAULTS } from '../task-orchestrator/types.js';
import { interpretIntakeInput, interpretIntakeItem, runIntakeToTasks, toIntakeTaskRequest } from './intake-to-tasks.js';

test('invalid interpretations are rejected, valid interpretations retain idempotent intake provenance', () => {
  expect(interpretIntakeItem('not json')).toBeNull();
  expect(interpretIntakeItem('{"title":"","description":"x","priority":"low"}')).toBeNull();
  expect(interpretIntakeItem('{"title":"x","description":"y","priority":"urgent"}')).toBeNull();
  const interpreted = interpretIntakeItem('{"title":"Investigate","description":"Inspect","priority":"high"}')!;
  const root = mkdtempSync(join(tmpdir(), 'intake-request-'));
  try {
    ingestIntakeItems(root, 'github', [{ url: 'https://github.com/example/one' }]);
    const item = [...loadIntakeLedger(root).items.values()][0]!;
    expect(toIntakeTaskRequest(item, interpreted)).toEqual({
      title: 'Investigate', description: 'Inspect', priority: 'high',
      external: { provider: 'intake', ref: item.id, url: item.url },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('interpretation accepts complete JSON fences, trims before checking title length and rejects invalid shapes', () => {
  expect(interpretIntakeItem('```json\n{"title":"  Do work  ","description":"Details","priority":"medium"}\n```'))
    .toEqual({ title: 'Do work', description: 'Details', priority: 'medium' });
  const response = (title: string, description: string, priority: string) => JSON.stringify({ title, description, priority });
  for (const invalid of [
    '```json\n{"title":"Do work","description":"Details","priority":"low"}',
    '{"title":"Do work","description":"Details","priority":"low"}\n```',
    '[]', 'null', response('   ', 'Details', 'low'), response('x'.repeat(TASK_DEFAULTS.titleMaxLen + 1), '', 'low'),
    response('Do work', 'x'.repeat(TASK_DEFAULTS.descriptionMaxLen + 1), 'medium'),
    response('Do work', 'Details', 'urgent'), '{"title":"Do work","priority":"low"}',
  ]) expect(interpretIntakeItem(invalid)).toBeNull();
  expect(interpretIntakeItem(response(`  ${'x'.repeat(TASK_DEFAULTS.titleMaxLen)}  `, '', 'low'))?.title)
    .toHaveLength(TASK_DEFAULTS.titleMaxLen);
});

test('interpretIntakeInput retains three valid typed tasks in order and moves missing acceptance criteria to questions', () => {
  const task = (title: string, type: string, acceptanceCriteria: unknown = ['Verify outcome']) => ({
    title, type, description: 'Inspect source', priority: 'medium', acceptanceCriteria,
  });
  const input = {
    tasks: [
      task('  First  ', 'implement', ['  Run focused test  ', '', 2]),
      task('Incomplete', 'research', []),
      task('Unknown type', 'unknown'),
      task('Second', 'research'),
      task('Third', 'document'),
      task('Fourth', 'operate'),
    ],
    questions: ['  Original question?  ', null, ' '],
  };
  expect(interpretIntakeInput('```json\n' + JSON.stringify(input) + '\n````')).toBeNull();
  expect(interpretIntakeInput('```json\n' + JSON.stringify(input) + '\n```')).toEqual({
    tasks: [
      { title: 'First', type: 'implement', description: 'Inspect source', priority: 'medium', acceptanceCriteria: ['Run focused test'] },
      { title: 'Second', type: 'research', description: 'Inspect source', priority: 'medium', acceptanceCriteria: ['Verify outcome'] },
      { title: 'Third', type: 'document', description: 'Inspect source', priority: 'medium', acceptanceCriteria: ['Verify outcome'] },
    ],
    questions: ['Original question?', 'Incomplete'],
  });
  expect(interpretIntakeInput(JSON.stringify({ tasks: [task('Operate', 'operate')], questions: [] }))?.tasks[0]?.type).toBe('operate');
});

test('interpretIntakeInput rejects malformed envelopes and skips invalid tasks without losing valid ones', () => {
  for (const invalid of [
    'not json', '{}', '[]', 'null', '{"tasks":[],"questions":null}',
    '```json\n{"tasks":[],"questions":[]}',
    '{"tasks":[],"questions":[]}\n```',
  ]) expect(interpretIntakeInput(invalid)).toBeNull();
  expect(interpretIntakeInput('{"tasks":[],"questions":[]}')).toEqual({ tasks: [], questions: [] });
  const valid = { type: 'implement', title: 'Work', description: 'Inspect', priority: 'high', acceptanceCriteria: ['Check work'] };
  expect(interpretIntakeInput(JSON.stringify({
    questions: [], tasks: [
      null, [], { ...valid, title: ' ' }, { ...valid, title: 'x'.repeat(TASK_DEFAULTS.titleMaxLen + 1) },
      { ...valid, description: 'x'.repeat(TASK_DEFAULTS.descriptionMaxLen + 1) },
      { ...valid, priority: 'urgent' }, { ...valid, acceptanceCriteria: [null, '  '] },
      valid,
    ],
  }))).toMatchObject({ tasks: [valid], questions: ['Work'] });
});

test('request without a URL keeps a stable intake identity and omits URL', () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-note-request-'));
  try {
    ingestIntakeItems(root, 'memo', [{ text: 'Remember this task' }]);
    const item = [...loadIntakeLedger(root).items.values()][0]!;
    const interpretation = { title: 'Review note', description: 'Follow up', priority: 'medium' as const };
    expect(toIntakeTaskRequest(item, interpretation)).toEqual({
      ...interpretation, external: { provider: 'intake', ref: item.id },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deduplicated goal line is consumed without changing intake item status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-deduplicated-'));
  try {
    const dir = join(root, 'intake', 'outbox', 'goals');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, '2026-09-01.jsonl'), JSON.stringify({ id: 'source', fact: 'Build a feature', current: 'Absent' }) + '\n');
    ingestIntakeItems(root, 'github', [{ url: 'https://github.com/example/existing' }]);
    const id = [...loadIntakeLedger(root).items.keys()][0]!;
    const response = JSON.stringify({ tasks: [{ type: 'implement', title: 'Build feature', description: 'Implement', priority: 'low', acceptanceCriteria: ['Focused test passes'] }], questions: [] });
    const deps = { llm: async () => response, post: async () => ({ taskId: 'task:existing', deduplicated: true }) };
    const result = await runIntakeToTasks(root, {}, deps);
    expect(result).toMatchObject({ processed: 1, created: 0, skipped: 0, failed: 0,
      items: [{ status: 'deduplicated', taskId: 'task:existing', types: ['implement'] }] });
    expect((await runIntakeToTasks(root, {}, deps)).processed).toBe(0);
    expect(loadIntakeLedger(root).items.get(id)?.status).toBe('new');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runner retries a failed POST using the same task reference without consuming the goal line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-runner-'));
  try {
    const dir = join(root, 'intake', 'outbox', 'goals');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-09-01.jsonl'), JSON.stringify({ fact: 'Implement retry', current: 'Missing' }) + '\n');
    const refs: string[] = [];
    let fail = true;
    const deps = {
      llm: async () => JSON.stringify({ tasks: [{ type: 'operate', title: 'Retry', description: 'Inspect', priority: 'medium', acceptanceCriteria: ['Run check'] }], questions: [] }),
      post: async (request: { external: { ref: string } }) => {
        refs.push(request.external.ref);
        if (fail) throw new Error('Nexus unavailable');
        return { taskId: 'task:retry' };
      },
    };
    expect((await runIntakeToTasks(root, { dryRun: true }, deps)).items[0]).toMatchObject({ status: 'dry-run', types: ['operate'] });
    expect(refs).toEqual([]);
    expect(await runIntakeToTasks(root, {}, deps)).toMatchObject({ processed: 1, failed: 1 });
    fail = false;
    expect(await runIntakeToTasks(root, {}, deps)).toMatchObject({ processed: 1, created: 1, failed: 0 });
    expect(refs).toHaveLength(2);
    expect(refs[0]).toBe(refs[1]);
    expect((await runIntakeToTasks(root, {}, deps)).processed).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('limit zero performs no calls; an unsuccessful POST response leaves the goal unconsumed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-post-failure-'));
  try {
    const dir = join(root, 'intake', 'outbox', 'goals');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-09-01.jsonl'), JSON.stringify({ fact: 'Investigate failure', current: 'Missing' }) + '\n');
    let calls = 0;
    const deps = {
      llm: async () => { calls++; return JSON.stringify({ tasks: [{ type: 'research', title: 'Investigate', description: 'Inspect', priority: 'low', acceptanceCriteria: ['Check results'] }], questions: [] }); },
      post: async () => { calls++; return { taskId: '' }; },
    };
    expect(await runIntakeToTasks(root, { limit: 0 }, deps)).toEqual({ processed: 0, created: 0, skipped: 0, failed: 0, items: [] });
    expect(calls).toBe(0);
    const failed = await runIntakeToTasks(root, { limit: 1 }, deps);
    expect(failed).toMatchObject({ processed: 1, created: 0, skipped: 0, failed: 1 });
    expect(calls).toBe(2);
    expect((await runIntakeToTasks(root, { limit: 1 }, deps)).processed).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
