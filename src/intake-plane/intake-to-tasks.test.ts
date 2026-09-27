import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestIntakeItems, loadIntakeLedger, markIntakeItem } from './items.js';
import { TASK_DEFAULTS } from '../task-orchestrator/types.js';
import { interpretIntakeInput, interpretIntakeItem, runIntakeToTasks, toIntakeTaskRequest, type IntakeToTasksDeps, type IntakeTaskRequest } from './intake-to-tasks.js';

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

test('Nexus deduplication routes the item without counting an existing task as created', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-deduplicated-'));
  try {
    ingestIntakeItems(root, 'github', [{ url: 'https://github.com/example/existing' }]);
    const id = [...loadIntakeLedger(root).items.keys()][0]!;
    markIntakeItem(root, id, { status: 'queued' });
    const result = await runIntakeToTasks(root, {}, {
      llm: async () => '{"title":"Investigate","description":"Inspect","priority":"low"}',
      post: async () => ({ taskId: 'task:existing', deduplicated: true }),
    });
    expect(result).toEqual({
      processed: 1, created: 0, skipped: 0, failed: 0,
      items: [{ id, status: 'deduplicated', taskId: 'task:existing' }],
    });
    expect(loadIntakeLedger(root).items.get(id)?.status).toBe('routed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runner selects oldest queued up to limit, skips invalid LLM, retries failures and never writes in dry-run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-runner-'));
  try {
    for (const [n, day] of [[3, '03'], [1, '01'], [2, '02'], [4, '04']] as const) {
      ingestIntakeItems(root, 'github', [{ url: `https://github.com/example/repo${n}`, observedAt: `2026-09-${day}T00:00:00Z` }]);
    }
    const items = [...loadIntakeLedger(root).items.values()];
    for (const item of items) markIntakeItem(root, item.id, { status: 'queued' });
    const ordered = items.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    let llmCalls: string[] = [];
    const posts: IntakeTaskRequest[] = [];
    const marks: string[] = [];
    let failFirst = true;
    const deps: IntakeToTasksDeps = {
      llm: async (item) => {
        llmCalls.push(item.id);
        return item.id === ordered[1]!.id ? 'invalid' : '{"title":"Investigate","description":"Inspect","priority":"low"}';
      },
      post: async (request) => {
        posts.push(request);
        if (failFirst && request.external.ref === ordered[0]!.id) throw new Error('Nexus unavailable');
        return { taskId: `task:${request.external.ref}` };
      },
      mark: (instanceRoot, id, patch) => {
        marks.push(id);
        return markIntakeItem(instanceRoot, id, patch);
      },
    };
    const dry = await runIntakeToTasks(root, { limit: 3, dryRun: true }, deps);
    expect(dry.items.map((row) => row.status)).toEqual(['dry-run', 'skipped', 'dry-run']);
    expect(dry).toMatchObject({ processed: 3, created: 0, skipped: 1, failed: 0 });
    expect(posts).toHaveLength(0);
    expect(marks).toHaveLength(0);
    expect([...loadIntakeLedger(root).items.values()].every((item) => item.status === 'queued')).toBe(true);
    llmCalls = [];
    const live = await runIntakeToTasks(root, { limit: 3 }, deps);
    expect(llmCalls).toEqual(ordered.slice(0, 3).map((item) => item.id));
    expect(live.items.map((row) => row.status)).toEqual(['failed', 'skipped', 'created']);
    expect(live).toMatchObject({ processed: 3, created: 1, skipped: 1, failed: 1 });
    expect(posts.map((post) => post.external)).toEqual([ordered[0], ordered[2]].map((item) => ({
      provider: 'intake', ref: item!.id, url: item!.url,
    })));
    expect(loadIntakeLedger(root).items.get(ordered[0]!.id)?.status).toBe('queued');
    expect(loadIntakeLedger(root).items.get(ordered[1]!.id)?.status).toBe('queued');
    expect(loadIntakeLedger(root).items.get(ordered[2]!.id)?.status).toBe('routed');
    expect(loadIntakeLedger(root).items.get(ordered[3]!.id)?.status).toBe('queued');
    expect(marks).toEqual([ordered[2]!.id]);
    failFirst = false;
    const retry = await runIntakeToTasks(root, { limit: 3 }, deps);
    expect(retry.items.map((row) => row.status)).toEqual(['created', 'skipped', 'created']);
    expect(posts.filter((post) => post.external.ref === ordered[2]!.id)).toHaveLength(1);
    expect(posts.filter((post) => post.external.ref === ordered[0]!.id)).toHaveLength(2);
    expect(posts[0]!.external).toEqual(posts[2]!.external);
    expect(retry).toMatchObject({ processed: 3, created: 2, skipped: 1, failed: 0 });
    expect(loadIntakeLedger(root).items.get(ordered[3]!.id)?.status).toBe('routed');
    expect(marks).toEqual([ordered[2]!.id, ordered[0]!.id, ordered[3]!.id]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('limit zero performs no calls; an unsuccessful POST response leaves the item queued', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-post-failure-'));
  try {
    ingestIntakeItems(root, 'github', [{ url: 'https://github.com/example/failure' }]);
    const id = [...loadIntakeLedger(root).items.keys()][0]!;
    markIntakeItem(root, id, { status: 'queued' });
    let calls = 0;
    const deps = {
      llm: async () => { calls++; return '{"title":"Investigate","description":"Inspect","priority":"low"}'; },
      post: async () => { calls++; return { taskId: '' }; },
    };
    expect(await runIntakeToTasks(root, { limit: 0 }, deps)).toEqual({
      processed: 0, created: 0, skipped: 0, failed: 0, items: [],
    });
    expect(calls).toBe(0);
    const failed = await runIntakeToTasks(root, { limit: 1 }, deps);
    expect(failed).toMatchObject({ processed: 1, created: 0, skipped: 0, failed: 1 });
    expect(loadIntakeLedger(root).items.get(id)?.status).toBe('queued');
    expect(calls).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
