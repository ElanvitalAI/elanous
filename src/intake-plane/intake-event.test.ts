import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { TaskGraph } from '../task-orchestrator/graph.js';
import { resetToxRuntimeDepsForTest, setToxRuntimeDeps } from '../task-orchestrator/runtime-deps.js';
import { createTask } from '../task-orchestrator/types.js';
import { classifyFrontInput, telegramAbsorbUrls } from './front-classifier.js';
import { ingestIntakeItems, intakeItemId, loadIntakeLedger, markIntakeItem, pickAbsorbQueue } from './items.js';
import { INTAKE_EVENT_DEFERRED_REPLY, scheduleIntakeEvent } from './route.js';
import type { UrlRoutingConfig } from '../skills/url-router.js';

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), 'intake-event-')); roots.push(path); return path; };
afterEach(() => { resetToxRuntimeDepsForTest(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const config: UrlRoutingConfig = {
  enabled: true, twoStage: true, defaultTargets: ['obsidian'], guardKeywords: ['구현', '참고'],
  absorbKeywords: ['흡수'], map: { youtube: 'youtube-master', x: 'omni-digest', github: 'omni-digest', web: 'omni-digest' }, absorbSkill: 'yt-vault',
};
const now = '2026-10-04T22:15:00.000Z'; // KST 07:15, after the daily 07:00 run.

test('Telegram saved link schedules one immediate absorption; same canonical URL is posted once and daily queue skips it', async () => {
  const dir = root();
  const text = 'https://example.org/post?b=2&a=1 저장';
  const input = { text, surface: 'telegram' as const };
  const decision = classifyFrontInput(input, { urlRouting: config });
  expect(decision.track).toBe('absorb');
  expect(telegramAbsorbUrls(input, decision)).toEqual(['https://example.org/post?b=2&a=1']);
  const posted: string[] = [];
  const post = async ({ url }: { url: string }) => { posted.push(url); return { taskId: 'task-1' }; };
  const url = telegramAbsorbUrls(input, decision)[0]!;
  const first = await scheduleIntakeEvent(dir, url, { now, post });
  const second = await scheduleIntakeEvent(dir, 'https://example.org/post?a=1&b=2', { now, post });
  expect(first.status).toBe('scheduled');
  expect(second.status).toBe('duplicate');
  expect(posted).toEqual(['https://example.org/post?a=1&b=2']);
  expect(loadIntakeLedger(dir).items.size).toBe(1);
  ingestIntakeItems(dir, 'telegram-saved', [{ url }], now, () => {});
  const later = '2026-10-05T22:00:00.000Z';
  expect(pickAbsorbQueue(dir, { max: 10, dryRun: true }, later, () => ({ status: 'running', updatedAt: Date.parse(later) - 60_000 }))).toEqual([]);
});

test('KST daily eventMax defers excess URL, preserves daily eligibility and informs the reply', async () => {
  const dir = root();
  const events: unknown[] = [];
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    if (category === 'intake.event') events.push({ event, data });
  }) as typeof debug.log);
  try {
    const posted: string[] = [];
    const post = async ({ url }: { url: string }) => { posted.push(url); return { taskId: url }; };
    const first = await scheduleIntakeEvent(dir, 'https://example.org/one', { now, eventMax: 1, post });
    const excess = await scheduleIntakeEvent(dir, 'https://example.org/two', { now, eventMax: 1, post });
    expect(first.status).toBe('scheduled');
    expect(excess).toMatchObject({ status: 'deferred', reply: INTAKE_EVENT_DEFERRED_REPLY });
    expect(await scheduleIntakeEvent(dir, 'https://example.org/two', { now, eventMax: 1, post })).toMatchObject({ status: 'deferred', reply: INTAKE_EVENT_DEFERRED_REPLY });
    expect(posted).toEqual(['https://example.org/one']);
    expect(loadIntakeLedger(dir).items.size).toBe(2);
    expect(events).toEqual([
      { event: 'scheduled', data: { url: 'https://example.org/one', reason: 'telegram-absorb' } },
      { event: 'deferred', data: { url: 'https://example.org/two', reason: 'event-max' } },
      { event: 'deferred', data: { url: 'https://example.org/two', reason: 'event-max' } },
    ]);
    ingestIntakeItems(dir, 'telegram-saved', [{ url: 'https://example.org/one' }, { url: 'https://example.org/two' }], now, () => {});
    const later = '2026-10-05T22:00:00.000Z';
    expect(pickAbsorbQueue(dir, { max: 10, dryRun: true }, later, () => ({ status: 'running', updatedAt: Date.parse(later) - 60_000 })).map((item) => item.url)).toEqual(['https://example.org/two']);
  } finally { spy.mockRestore(); }
});

test('default intake event limit schedules 10 links per KST day and defers the eleventh', async () => {
  const dir = root();
  let posts = 0;
  const post = async () => ({ taskId: `task-${++posts}` });
  for (let n = 0; n < 10; n++) {
    expect((await scheduleIntakeEvent(dir, `https://example.org/default-${n}`, { now, post })).status).toBe('scheduled');
  }
  expect(await scheduleIntakeEvent(dir, 'https://example.org/default-10', { now, post })).toMatchObject({
    status: 'deferred', reply: INTAKE_EVENT_DEFERRED_REPLY,
  });
  expect(posts).toBe(10);
});

test('non-Telegram or implementation URL never schedules an intake event', () => {
  for (const input of [
    { text: 'https://example.org/save 저장', surface: 'pwa' as const },
    { text: 'https://example.org/save 구현', surface: 'telegram' as const },
  ]) expect(telegramAbsorbUrls(input, classifyFrontInput(input, { urlRouting: config }))).toEqual([]);
});

test('already absorbed Telegram link is not scheduled again', async () => {
  const dir = root();
  const url = 'https://example.org/already';
  ingestIntakeItems(dir, 'telegram-bot', [{ url }], now, () => {});
  markIntakeItem(dir, intakeItemId('telegram-bot', { url }), { status: 'absorbed' }, now);
  let posted = 0;
  expect((await scheduleIntakeEvent(dir, url, { now, post: async () => { posted++; return { taskId: 'task' }; } })).status).toBe('duplicate');
  expect(posted).toBe(0);
});

test('failed task post releases the claim so the same URL can be retried or picked by the daily run', async () => {
  const dir = root();
  const url = 'https://example.org/retry';
  await expect(scheduleIntakeEvent(dir, url, { now, post: async () => { throw new Error('unavailable'); } })).rejects.toThrow('unavailable');
  expect(pickAbsorbQueue(dir, { max: 10, dryRun: true }, '2026-10-05T22:00:00.000Z').map((item) => item.url)).toEqual([url]);
  expect((await scheduleIntakeEvent(dir, url, { now, post: async () => ({ taskId: 'retry' }) })).status).toBe('scheduled');
});

test('crashed pending post expires into the daily queue without excluding the URL forever', async () => {
  const dir = root();
  const url = 'https://example.org/crashed';
  await scheduleIntakeEvent(dir, url, { now, post: async () => ({ taskId: 'old' }) });
  const db = new Database(join(dir, 'intake', 'events.sqlite'));
  try { db.query("UPDATE intake_events SET status = 'pending', task_id = NULL WHERE url = ?").run(url); }
  finally { db.close(); }
  expect(pickAbsorbQueue(dir, { max: 10, dryRun: true }, '2026-10-04T22:16:00.000Z')).toEqual([]);
  expect(pickAbsorbQueue(dir, { max: 10, dryRun: true }, '2026-10-05T22:00:00.000Z').map((item) => item.url)).toEqual([url]);
});

test('failed or cancelled scheduled task returns to daily queue; a live task still excludes its URL', async () => {
  const dir = root();
  const urls = ['https://example.org/failed', 'https://example.org/cancelled', 'https://example.org/live'];
  for (const url of urls) await scheduleIntakeEvent(dir, url, { now, post: async () => ({ taskId: url }) });
  const taskStatus = (id: string) => id === urls[0] ? 'failed' : id === urls[1] ? 'cancelled' : 'running';
  expect(pickAbsorbQueue(dir, { max: 10, dryRun: true }, '2026-10-04T23:00:00.000Z', taskStatus).map((item) => item.url)).toEqual(urls.slice(0, 2));
});

test('failed task may be scheduled again on a later Telegram save', async () => {
  const dir = root();
  const url = 'https://example.org/retry-later';
  const later = '2026-10-05T23:00:00.000Z';
  let posts = 0;
  const post = async () => ({ taskId: `task-${++posts}` });
  expect((await scheduleIntakeEvent(dir, url, { now, post })).status).toBe('scheduled');
  expect(pickAbsorbQueue(dir, { max: 10, dryRun: true }, later, () => 'failed').map((item) => item.url)).toEqual([url]);
  expect((await scheduleIntakeEvent(dir, url, { now: later, post })).status).toBe('scheduled');
  expect(posts).toBe(2);
});

test('expired pending claim can be replaced by a later Telegram save', async () => {
  const dir = root();
  const url = 'https://example.org/crash-then-save';
  const later = '2026-10-05T22:00:00.000Z';
  await scheduleIntakeEvent(dir, url, { now, post: async () => ({ taskId: 'old' }) });
  const db = new Database(join(dir, 'intake', 'events.sqlite'));
  try { db.query("UPDATE intake_events SET status = 'pending', task_id = NULL WHERE url = ?").run(url); }
  finally { db.close(); }
  expect((await scheduleIntakeEvent(dir, url, { now: later, post: async () => ({ taskId: 'replacement' }) })).status).toBe('scheduled');
  expect(pickAbsorbQueue(dir, { max: 10, dryRun: true }, later, () => 'running')).toEqual([]);
});

test('daily queue observes the actual task status through wired TOX runtime', async () => {
  const dir = root();
  const url = 'https://example.org/tox-status';
  const graph = new TaskGraph();
  const task = createTask({ title: 'absorb', surface: { kind: 'llm-direct', prompt: url }, status: 'running' });
  graph.addTask(task);
  setToxRuntimeDeps({ getGraph: () => graph, getDispatcher: () => null, getGenerator: () => null });
  await scheduleIntakeEvent(dir, url, { now, post: async () => ({ taskId: task.id }) });
  const later = new Date(task.updatedAt + 60_000).toISOString(); // the live task was touched a minute ago
  expect(pickAbsorbQueue(dir, { max: 10, dryRun: true }, later)).toEqual([]);
  graph.updateTask(task.id, { status: 'failed' });
  expect(pickAbsorbQueue(dir, { max: 10, dryRun: true }, later).map((item) => item.url)).toEqual([url]);
});

test('completed absorption stays out of the daily queue even after its claim lease', async () => {
  const dir = root();
  const url = 'https://example.org/complete';
  const graph = new TaskGraph();
  const task = createTask({ title: 'absorb', surface: { kind: 'llm-direct', prompt: url }, status: 'done' });
  graph.addTask(task);
  setToxRuntimeDeps({ getGraph: () => graph, getDispatcher: () => null, getGenerator: () => null });
  await scheduleIntakeEvent(dir, url, { now, post: async () => ({ taskId: task.id }) });
  expect(pickAbsorbQueue(dir, { max: 10, dryRun: true }, '2026-10-07T22:00:00.000Z')).toEqual([]);
});

test('orphaned scheduled task returns to the daily queue after its lease expires', async () => {
  const dir = root();
  const url = 'https://example.org/orphan';
  await scheduleIntakeEvent(dir, url, { now, post: async () => ({ taskId: 'lost-task' }) });
  expect(pickAbsorbQueue(dir, { max: 10, dryRun: true }, '2026-10-04T23:00:00.000Z', () => undefined)).toEqual([]);
  expect(pickAbsorbQueue(dir, { max: 10, dryRun: true }, '2026-10-05T22:00:00.000Z', () => undefined).map((item) => item.url)).toEqual([url]);
});

test('a task left «running» by a dead worker no longer holds the URL out of the daily queue', async () => {
  const dir = root();
  const url = 'https://example.org/stuck';
  await scheduleIntakeEvent(dir, url, { now, post: async () => ({ taskId: 'task-stuck' }) });
  ingestIntakeItems(dir, 'telegram-saved', [{ url }], now, () => {});
  const later = '2026-10-05T01:15:00.000Z'; // 3h after the claim — inside the 23h claim lease
  const live = () => ({ status: 'running' as const, updatedAt: Date.parse(later) - 60_000 });
  const dead = () => ({ status: 'running' as const, updatedAt: Date.parse(now) });
  expect(pickAbsorbQueue(dir, { max: 10, dryRun: true }, later, live)).toEqual([]);
  expect(pickAbsorbQueue(dir, { max: 10, dryRun: true }, later, dead).map(item => item.url)).toEqual([url]);
});

test('the KST-day quota counts claims made that day even after their rows change status or are reused', async () => {
  const dir = root();
  const post = async ({ url }: { url: string }) => ({ taskId: url });
  expect((await scheduleIntakeEvent(dir, 'https://example.org/a', { now, eventMax: 2, post })).status).toBe('scheduled');
  expect((await scheduleIntakeEvent(dir, 'https://example.org/b', { now, eventMax: 2, post })).status).toBe('scheduled');
  const db = new Database(join(dir, 'intake', 'events.sqlite'));
  try { db.query("UPDATE intake_events SET status = 'completed'").run(); } finally { db.close(); }
  expect((await scheduleIntakeEvent(dir, 'https://example.org/c', { now, eventMax: 2, post })).status).toBe('deferred');
  const nextDay = '2026-10-05T22:15:00.000Z';
  expect((await scheduleIntakeEvent(dir, 'https://example.org/d', { now: nextDay, eventMax: 2, post })).status).toBe('scheduled');
});
