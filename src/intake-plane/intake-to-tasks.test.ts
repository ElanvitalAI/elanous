import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestIntakeItems, loadIntakeLedger, markIntakeItem } from './items.js';
import { TASK_DEFAULTS } from '../task-orchestrator/types.js';
import { interpretIntakeInput, interpretIntakeItem, runIntakeToTasks, toIntakeTaskRequest } from './intake-to-tasks.js';
import type { ChannelPublishPlan } from './intake-to-tasks.js';

// 채널 게시 대기열 심볼만 동적 import 로 읽는다: 이 파일이 고정 조상 base 에서도 모듈 로드
// 에러 없이 읽혀야 기존 동작 시험의 RED 목격이 `module-load-error` 가 아니라 시험 실패로 남는다.
const channelPublish = () => import('./intake-to-tasks.js');

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

test('승인 단계 범위: MK·crown 몫은 첫 공개·특허·외부 계약만', async () => {
  const { CHANNEL_PUBLISH_APPROVAL_CATEGORIES, CHANNEL_PUBLISH_CROWN_OWNER, isChannelPublishApprovable } = await channelPublish();
  const draft = { channel: 'telegram', cadence: 'weekly', voice: 'open-voice', title: 't', body: 'b' };
  expect([...CHANNEL_PUBLISH_APPROVAL_CATEGORIES]).toEqual(['first-release', 'patent', 'external-contract']);
  for (const owner of ['MK', CHANNEL_PUBLISH_CROWN_OWNER] as const)
    for (const category of CHANNEL_PUBLISH_APPROVAL_CATEGORIES)
      expect(isChannelPublishApprovable({ ...draft, owner, category })).toBe(false);
  for (const category of ['changelog', 'product-update', 'ops-note'])
    expect(isChannelPublishApprovable({ ...draft, owner: CHANNEL_PUBLISH_CROWN_OWNER, category })).toBe(true);
  expect(isChannelPublishApprovable({ ...draft, owner: 'OP', category: 'changelog' })).toBe(true);
});

test('ChannelPublishQueue keeps queue → approval → publish plans resumable across restarts with crash-safe dedup', async () => {
  const { CHANNEL_PUBLISH_CROWN_OWNER, ChannelPublishQueue, approveChannelPublish } = await channelPublish();
  const root = mkdtempSync(join(tmpdir(), 'intake-channel-queue-'));
  try {
    const draft = { channel: 'telegram', cadence: 'weekly', voice: 'open-voice', owner: 'MK', category: 'first-release', title: '10-28 업데이트', body: 'Major update' };
    expect(new ChannelPublishQueue(root).enqueue('goal:a', draft).status).toBe('queued');
    expect(new ChannelPublishQueue(root).enqueue('goal:a', draft).status).toBe('queued');
    const queue = new ChannelPublishQueue(root);
    expect(queue.count()).toBe(1);
    const plan = queue.plan('goal:a')!;
    expect(plan.status).toBe('queued');
    const approved = approveChannelPublish(root, 'goal:a', 'MK')!;
    expect(approved).toMatchObject({ status: 'approved', approvedBy: 'MK' });
    expect(queue.plan('goal:a')!.status).toBe('approved');
    const crowns = queue.enqueue('goal:crown', { ...draft, owner: CHANNEL_PUBLISH_CROWN_OWNER, category: 'changelog' });
    expect(queue.approve('goal:crown', crowns, { kind: 'automatic' }).status).toBe('approved');
    const protectedQueue = queue.enqueue('goal:protected', { ...draft, category: 'patent' });
    expect(queue.approve('goal:protected', protectedQueue, { kind: 'automatic' }).status).toBe('queued');
    expect(queue.count()).toBe(3);
    queue.recordPublished('goal:a', approved, 'channel:telegram:published:1');
    expect([...queue.publishedIds()]).toEqual(['goal:a']);
    expect(queue.count()).toBe(2);
    expect(queue.plan('goal:a')).toBeNull();
    expect(new ChannelPublishQueue(root).enqueue('goal:a', draft).status).toBe('published');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('channel publish lock is exclusive and release removes only its owned lock', async () => {
  const { ChannelPublishQueue } = await channelPublish();
  const root = mkdtempSync(join(tmpdir(), 'intake-channel-lock-'));
  try {
    const queue = new ChannelPublishQueue(root);
    const release = queue.tryAcquirePublish('post:1');
    expect(release).not.toBeNull();
    expect(queue.tryAcquirePublish('post:1')).toBeNull();
    const path = `${queue.entryPath('post:1')}.publishing`;
    writeFileSync(path, 'replacement-owner');
    release!();
    expect(readFileSync(path, 'utf8')).toBe('replacement-owner');
    rmSync(path, { force: true });
    expect(queue.tryAcquirePublish('post:1')).not.toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('10-28 대규모 업데이트 게시물이 대기열·승인·게시로 나간다', async () => {
  const { CHANNEL_PUBLISH_CROWN_OWNER, ChannelPublishQueue, approveChannelPublish } = await channelPublish();
  const root = mkdtempSync(join(tmpdir(), 'intake-channel-publish-'));
  try {
    const dir = join(root, 'intake', 'outbox', 'goals');
    mkdirSync(dir, { recursive: true });
    const lines = [
      { kind: 'channel-post', channel: 'telegram', cadence: 'weekly', voice: 'first-voice', owner: 'MK', category: 'first-release', title: '10-28 대규모 업데이트', body: '대규모 업데이트 전문' },
      { kind: 'channel-post', channel: 'discord', cadence: 'daily', voice: 'open-voice', owner: CHANNEL_PUBLISH_CROWN_OWNER, category: 'changelog', title: '짧은 변경사항', body: '변경 메모' },
    ];
    appendFileSync(join(dir, '2026-10-28.jsonl'), lines.map(line => JSON.stringify(line) + '\n').join(''));
    const seen: Array<ChannelPublishPlan> = [];
    let fail = true;
    const deps = {
      llm: async () => { throw new Error('no llm for channel posts'); },
      post: async () => { throw new Error('no task post for channel posts'); },
      connector: {
        publish: async (plan: ChannelPublishPlan) => {
          if (fail) throw new Error('connector unavailable');
          seen.push(plan);
          return { publishedId: `channel:${plan.channel}:published` };
        },
      },
    };
    const dry = await runIntakeToTasks(root, { dryRun: true }, deps);
    expect(dry.items.map(item => item.status)).toEqual(['dry-run', 'dry-run']);
    expect(new ChannelPublishQueue(root).count()).toBe(0);
    const first = await runIntakeToTasks(root, {}, deps);
    expect(first).toMatchObject({ processed: 2, created: 0, skipped: 0, failed: 1 });
    expect(first.items[0]).toMatchObject({ status: 'queued', channel: 'telegram' });
    expect(first.items[1]).toMatchObject({ status: 'failed' });
    fail = false;
    const run = await runIntakeToTasks(root, {}, deps);
    expect(run).toMatchObject({ processed: 2, created: 0, skipped: 0, failed: 0 });
    expect(run.items[0]).toMatchObject({ status: 'queued', channel: 'telegram' });
    expect(run.items[1]).toMatchObject({ status: 'published', channel: 'discord', publishedId: 'channel:discord:published' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ status: 'approved', channel: 'discord', owner: CHANNEL_PUBLISH_CROWN_OWNER, category: 'changelog', title: '짧은 변경사항' });
    const queue = new ChannelPublishQueue(root);
    expect(queue.count()).toBe(1);
    expect([...queue.publishedIds()]).toHaveLength(1);
    const protectedDraft = queue.entries()[0];
    expect(protectedDraft).toMatchObject({ channel: 'telegram', owner: 'MK', category: 'first-release', status: 'queued' });
    const protectedId = `goal:${createHash('sha256').update('2026-10-28.jsonl:0').digest('hex').slice(0, 16)}`;
    expect(approveChannelPublish(root, 'missing', 'MK')).toBeNull();
    expect(approveChannelPublish(root, protectedId, 'unknown')).toBeNull();
    expect(approveChannelPublish(root, protectedId, 'MK')).toMatchObject({ status: 'approved', approvedBy: 'MK', category: 'first-release' });
    const third = await runIntakeToTasks(root, {}, deps);
    expect(third).toMatchObject({ processed: 1, failed: 0 });
    expect(third.items[0]).toMatchObject({ status: 'published', channel: 'telegram', publishedId: 'channel:telegram:published' });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ status: 'approved', channel: 'telegram', owner: 'MK', category: 'first-release' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('동일 채널 게시의 동시 intake 실행은 외부 발행을 한 번만 호출한다', async () => {
  const { ChannelPublishQueue } = await channelPublish();
  const root = mkdtempSync(join(tmpdir(), 'intake-channel-concurrent-'));
  try {
    const dir = join(root, 'intake', 'outbox', 'goals');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, '2026-10-28.jsonl'), JSON.stringify({
      kind: 'channel-post', channel: 'telegram', cadence: 'weekly', voice: 'update', owner: 'MK',
      category: 'changelog', title: '10-28 update', body: 'Update body',
    }) + '\n');
    let calls = 0;
    const deps = {
      llm: async () => { throw new Error('not used'); },
      post: async () => { throw new Error('not used'); },
      connector: { publish: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { publishedId: 'one-external-post' };
      } },
    };
    const results = await Promise.all([
      runIntakeToTasks(root, {}, deps),
      runIntakeToTasks(root, {}, deps),
    ]);
    expect(calls).toBe(1);
    expect(results.flatMap((result) => result.items.map((item) => item.status)).sort()).toEqual(['approved', 'published']);
    expect(new ChannelPublishQueue(root).publishedIds().size).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
