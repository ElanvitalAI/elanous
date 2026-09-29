import { expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestIntakeItems, loadIntakeLedger, markIntakeItem } from './items.js';
import { runIntakeToTasks, type IntakeTaskInput, type IntakeTaskRequest } from './intake-to-tasks.js';

const valid = JSON.stringify({ tasks: [
  { type: 'implement', title: 'Implement', description: 'Do work', priority: 'medium', acceptanceCriteria: ['Run focused test'] },
  { type: 'document', title: 'Document', description: 'Write docs', priority: 'low', acceptanceCriteria: ['Read docs'] },
], questions: [] });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'intake-input-runner-'));
  const goals = join(root, 'intake', 'outbox', 'goals');
  mkdirSync(goals, { recursive: true });
  const addGoal = (day: string, fact: string) => appendFileSync(join(goals, `${day}.jsonl`), JSON.stringify({ fact, current: 'Gap', url: 'https://example.org/source', text: 'SECRET' }) + '\n');
  return { root, addGoal, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('goal lines precede eligible notes, limit counts inputs; safe LLM inputs never include ledger text', async () => {
  const { root, addGoal, cleanup } = fixture();
  try {
    addGoal('2026-09-02', 'Second goal');
    addGoal('2026-09-01', 'First goal');
    const note = join(root, 'idea.md');
    writeFileSync(note, '# Public idea\nConcrete request');
    ingestIntakeItems(root, 'github', [{ url: 'https://github.com/example/idea', text: 'LEDGER SECRET' }]);
    const id = [...loadIntakeLedger(root).items.keys()][0]!;
    markIntakeItem(root, id, { status: 'absorbed', output: { kind: 'note', ref: note } });
    ingestIntakeItems(root, 'memo', [{ text: 'PRIVATE SECRET' }]);
    const privateId = [...loadIntakeLedger(root).items.keys()].find((key) => key !== id)!;
    markIntakeItem(root, privateId, { status: 'absorbed', output: { kind: 'note', ref: note } });
    ingestIntakeItems(root, 'github', [{ url: 'https://github.com/example/queued' }]);
    const queuedId = [...loadIntakeLedger(root).items.keys()].find((key) => key !== id && key !== privateId)!;
    markIntakeItem(root, queuedId, { status: 'queued', output: { kind: 'note', ref: note } });
    const llmInputs: IntakeTaskInput[] = [];
    const posts: IntakeTaskRequest[] = [];
    const deps = { llm: async (input: IntakeTaskInput) => { llmInputs.push(input); return valid; },
      post: async (request: IntakeTaskRequest) => { posts.push(request); return { taskId: `task:${posts.length}` }; } };
    const dry = await runIntakeToTasks(root, { limit: 2, dryRun: true }, deps);
    expect(dry).toMatchObject({ processed: 2, created: 0, failed: 0 });
    expect(dry.items.map((row) => row.status)).toEqual(['dry-run', 'dry-run']);
    expect(llmInputs.map((input) => input.kind === 'goal-line' ? input.fact : input.content)).toEqual(['First goal', 'Second goal']);
    expect(JSON.stringify(llmInputs)).not.toContain('SECRET');
    expect(posts).toHaveLength(0);
    const live = await runIntakeToTasks(root, { limit: 3 }, deps);
    expect(live).toMatchObject({ processed: 3, created: 6, failed: 0 });
    expect(live.items.map((row) => row.types)).toEqual(Array.from({ length: 3 }, () => ['implement', 'document']));
    expect(llmInputs.at(-1)).toEqual({ kind: 'idea-note', id: `note:${id}`, content: '# Public idea\nConcrete request', url: 'https://github.com/example/idea' });
    expect(JSON.stringify(llmInputs)).not.toContain('SECRET');
    expect(posts.map((post) => post.external.ref)).toEqual(live.items.flatMap((row) => [`${row.id}:0`, `${row.id}:1`]));
    expect(posts[0]).toMatchObject({ type: 'implement', acceptance: { criteria: ['Run focused test'] } });
    expect(posts[1]).toMatchObject({ type: 'document', acceptance: { criteria: ['Read docs'] } });
    expect(dry.items.map((row) => row.types)).toEqual([['implement', 'document'], ['implement', 'document']]);
    expect((await runIntakeToTasks(root, { limit: 3 }, deps)).processed).toBe(0);
    expect(loadIntakeLedger(root).items.get(id)?.status).toBe('absorbed');
  } finally { cleanup(); }
});

test('a queued absorption input becomes a task input after a public note is produced', async () => {
  const { root, cleanup } = fixture();
  try {
    ingestIntakeItems(root, 'github', [{ url: 'https://github.com/example/to-absorb', text: 'UNSAFE LEDGER TEXT' }]);
    const id = [...loadIntakeLedger(root).items.keys()][0]!;
    markIntakeItem(root, id, { status: 'queued' });
    const note = join(root, 'absorbed.md');
    writeFileSync(note, 'Reviewed public idea');
    const inputs: IntakeTaskInput[] = [];
    const posts: IntakeTaskRequest[] = [];
    const deps = {
      llm: async (input: IntakeTaskInput) => { inputs.push(input); return valid; },
      post: async (request: IntakeTaskRequest) => { posts.push(request); return { taskId: `task:${posts.length}` }; },
    };
    markIntakeItem(root, id, { status: 'absorbed', output: { kind: 'note', ref: note } });
    expect(await runIntakeToTasks(root, {}, deps)).toMatchObject({
      processed: 1, created: 2, items: [{ id: `note:${id}`, status: 'created', types: ['implement', 'document'] }],
    });
    expect(posts.map((request) => request.external.ref)).toEqual([`note:${id}:0`, `note:${id}:1`]);
    expect(loadIntakeLedger(root).items.get(id)?.status).toBe('absorbed');
    expect((await runIntakeToTasks(root, {}, deps)).processed).toBe(0);
    expect(posts).toHaveLength(2);
    expect(inputs).toEqual([{ kind: 'idea-note', id: `note:${id}`, content: 'Reviewed public idea', url: 'https://github.com/example/to-absorb' }]);
    expect(JSON.stringify(inputs)).not.toContain('UNSAFE LEDGER TEXT');
  } finally { cleanup(); }
});

test('legacy routed items with public notes are not re-posted under a new reference', async () => {
  const { root, cleanup } = fixture();
  try {
    const note = join(root, 'legacy.md');
    writeFileSync(note, 'Public legacy note');
    ingestIntakeItems(root, 'github', [{ url: 'https://github.com/example/legacy' }]);
    const id = [...loadIntakeLedger(root).items.keys()][0]!;
    markIntakeItem(root, id, { status: 'queued' });
    markIntakeItem(root, id, { status: 'routed' });
    markIntakeItem(root, id, { output: { kind: 'note', ref: note } });
    const result = await runIntakeToTasks(root, {}, {
      llm: async () => { throw new Error('legacy routed item selected'); },
      post: async () => { throw new Error('legacy routed item posted'); },
    });
    expect(result).toEqual({ processed: 0, created: 0, skipped: 0, failed: 0, items: [] });
  } finally { cleanup(); }
});

test('a legacy queued-to-routed POST remains excluded after a later absorbed-to-routed cycle', async () => {
  const { root, cleanup } = fixture();
  try {
    const note = join(root, 'legacy-cycle.md');
    writeFileSync(note, 'Legacy public note');
    ingestIntakeItems(root, 'github', [{ url: 'https://github.com/example/legacy-cycle' }]);
    const id = [...loadIntakeLedger(root).items.keys()][0]!;
    markIntakeItem(root, id, { status: 'queued', output: { kind: 'note', ref: note } });
    markIntakeItem(root, id, { status: 'routed' });
    markIntakeItem(root, id, { status: 'absorbed' });
    markIntakeItem(root, id, { status: 'routed' });
    const result = await runIntakeToTasks(root, {}, {
      llm: async () => { throw new Error('legacy item selected again'); },
      post: async () => { throw new Error('legacy item reposted'); },
    });
    expect(result).toEqual({ processed: 0, created: 0, skipped: 0, failed: 0, items: [] });
  } finally { cleanup(); }
});

test('a legacy POST still excludes a public note if its item is subsequently absorbed', async () => {
  const { root, cleanup } = fixture();
  try {
    const note = join(root, 'absorbed-after-post.md');
    writeFileSync(note, 'Previously posted note');
    ingestIntakeItems(root, 'github', [{ url: 'https://github.com/example/absorbed-after-post' }]);
    const id = [...loadIntakeLedger(root).items.keys()][0]!;
    markIntakeItem(root, id, { status: 'queued', output: { kind: 'note', ref: note } });
    markIntakeItem(root, id, { status: 'routed' });
    markIntakeItem(root, id, { status: 'absorbed' });
    const result = await runIntakeToTasks(root, {}, {
      llm: async () => { throw new Error('previously posted item selected'); },
      post: async () => { throw new Error('previously posted item reposted'); },
    });
    expect(result).toEqual({ processed: 0, created: 0, skipped: 0, failed: 0, items: [] });
  } finally { cleanup(); }
});

test('route-produced notes remain eligible after an absorbed-to-routed transition', async () => {
  const { root, cleanup } = fixture();
  try {
    const note = join(root, 'route.md');
    writeFileSync(note, 'Public route-produced note');
    ingestIntakeItems(root, 'github', [{ url: 'https://github.com/example/route' }]);
    const id = [...loadIntakeLedger(root).items.keys()][0]!;
    markIntakeItem(root, id, { status: 'absorbed', output: { kind: 'note', ref: note } });
    markIntakeItem(root, id, { status: 'routed' });
    const inputs: IntakeTaskInput[] = [];
    const result = await runIntakeToTasks(root, { dryRun: true }, {
      llm: async (input) => { inputs.push(input); return valid; },
      post: async () => { throw new Error('dry run must not POST'); },
    });
    expect(result).toMatchObject({ processed: 1, items: [{ id: `note:${id}`, status: 'dry-run' }] });
    expect(inputs).toEqual([{ kind: 'idea-note', id: `note:${id}`, content: 'Public route-produced note', url: 'https://github.com/example/route' }]);
  } finally { cleanup(); }
});

test('checked-to-routed idea notes remain eligible while legacy routed tasks do not', async () => {
  const { root, cleanup } = fixture();
  try {
    const note = join(root, 'checked.md');
    writeFileSync(note, 'Public checked note');
    ingestIntakeItems(root, 'github', [{ url: 'https://github.com/example/checked' }]);
    const id = [...loadIntakeLedger(root).items.keys()][0]!;
    markIntakeItem(root, id, { status: 'checked', output: { kind: 'note', ref: note } });
    markIntakeItem(root, id, { status: 'routed' });
    const result = await runIntakeToTasks(root, { dryRun: true }, {
      llm: async (input) => { expect(input).toMatchObject({ kind: 'idea-note', content: 'Public checked note' }); return valid; },
      post: async () => { throw new Error('dry run must not POST'); },
    });
    expect(result).toMatchObject({ processed: 1, items: [{ id: `note:${id}`, status: 'dry-run' }] });
  } finally { cleanup(); }
});

test('partial POST retries the persisted original plan without reinterpreting or reusing a reference for a different task', async () => {
  const { root, addGoal, cleanup } = fixture();
  try {
    addGoal('2026-09-01', 'Two ordered tasks');
    const first: IntakeTaskRequest[] = [];
    let call = 0;
    const initial = await runIntakeToTasks(root, {}, {
      llm: async () => valid,
      post: async (request) => {
        first.push(request);
        if (++call === 2) throw new Error('offline after first POST');
        return { taskId: 'task:first' };
      },
    });
    expect(initial).toMatchObject({ processed: 1, created: 1, failed: 1 });
    expect(first.map((request) => request.title)).toEqual(['Implement', 'Document']);
    const planDir = join(root, 'intake', 'to-tasks-plans');
    const saved = JSON.parse(readFileSync(join(planDir, readdirSync(planDir)[0]!), 'utf8'));
    expect(saved).toMatchObject({ tasks: [{ title: 'Implement' }, { title: 'Document' }],
      completed: [{ taskId: 'task:first', deduplicated: false }, null] });
    const resumed: IntakeTaskRequest[] = [];
    const retry = await runIntakeToTasks(root, {}, {
      llm: async () => { throw new Error('LLM must not be called during retry'); },
      post: async (request) => { resumed.push(request); return { taskId: 'task:second' }; },
    });
    expect(retry).toMatchObject({ processed: 1, created: 1, failed: 0, items: [{ status: 'created', taskId: 'task:second' }] });
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ title: 'Document', type: 'document', acceptance: { criteria: ['Read docs'] },
      external: { ref: first[1]!.external.ref } });
    expect((await runIntakeToTasks(root, {}, {
      llm: async () => { throw new Error('consumed'); }, post: async () => { throw new Error('consumed'); },
    })).processed).toBe(0);
  } finally { cleanup(); }
});

test('unreadable notes are skipped without LLM or POST; invalid responses and failed POST remain retryable', async () => {
  const { root, addGoal, cleanup } = fixture();
  try {
    addGoal('2026-09-01', 'Retryable goal');
    ingestIntakeItems(root, 'github', [{ url: 'https://github.com/example/missing' }]);
    const id = [...loadIntakeLedger(root).items.keys()][0]!;
    markIntakeItem(root, id, { status: 'absorbed', output: { kind: 'note', ref: join(root, 'missing.md') } });
    let llmCalls = 0;
    let posts = 0;
    let answer = 'not json';
    const deps = { llm: async () => { llmCalls++; return answer; }, post: async () => { posts++; throw new Error('offline'); } };
    expect(await runIntakeToTasks(root, { limit: 2 }, deps)).toMatchObject({
      processed: 2, skipped: 2, failed: 0, items: [{ status: 'skipped', reason: 'invalid-llm-response' }, { status: 'skipped', reason: 'note-read-failed' }],
    });
    expect(llmCalls).toBe(1);
    expect(posts).toBe(0);
    answer = JSON.stringify({ tasks: [], questions: ['Which behavior should change?'] });
    const clarification = await runIntakeToTasks(root, { limit: 2 }, deps);
    expect(clarification.items[0]).toMatchObject({ status: 'skipped', reason: 'needs-clarification' });
    expect(posts).toBe(0);
    answer = valid;
    const failed = await runIntakeToTasks(root, { limit: 2 }, deps);
    expect(failed).toMatchObject({ processed: 2, failed: 1, skipped: 1 });
    expect(posts).toBe(1);
    expect(await runIntakeToTasks(root, { limit: 0 }, deps)).toEqual({ processed: 0, created: 0, skipped: 0, failed: 0, items: [] });
    expect(readFileSync(join(root, 'intake', 'outbox', 'goals', '2026-09-01.jsonl'), 'utf8')).toContain('Retryable goal');
  } finally { cleanup(); }
});
