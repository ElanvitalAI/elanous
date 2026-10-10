import { afterEach, expect, spyOn, test } from 'bun:test';
import * as llm from '../llm.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { openSurfaceEventsDb, recordEvent, surfaceEventsDbPath } from '../domains/surface-events.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { CoordEvent } from './coord-events.js';
import { runGraph, lastJsonObject } from '../graph-runner/runner.js';
import { listLoops, setLoopEnabled } from '../loops/registry.js';
import { runNightlyStage, summarize, summaryInstruction } from './nightly-condense.js';
import { condenseContextWindowWithReport, type MemoryItem } from './long-term-memory.js';

const root = resolve(import.meta.dir, '../..');
const graph = join(root, 'graphs/context/nightly-condense.yaml');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('installed nightly YAML wires each node to a real recipe and declares a human-disabled 03:30 loop', () => {
  const document = parseYaml(readFileSync(graph, 'utf8')) as {
    graph_id: string; loop: { trigger: { cron: string } }; entry_node: string;
    nodes: Array<{ node_id: string; recipe?: string }>;
    edges: Array<{ from: string; map: Record<string, string> }>;
  };
  const recipes = parseYaml(readFileSync(join(root, 'graphs/context/recipes.yaml'), 'utf8')) as
    Record<string, { command: string; dry_run_command: string }>;
  const stages = ['collect', 'condense', 'record', 'conflict-candidates'];
  expect(document.graph_id).toBe('nightly-condense');
  expect(document.entry_node).toBe(stages[0]);
  expect(document.loop.trigger.cron).toBe('30 3 * * *');
  for (const [index, stage] of stages.entries()) {
    expect(document.nodes[index]).toMatchObject({ node_id: stage, recipe: `cmd:${stage}` });
    expect(recipes[stage]?.command).toContain(`nightly-condense.ts\" ${stage}`);
    expect(recipes[stage]?.dry_run_command).toBe(recipes[stage]?.command);
    expect(document.edges[index]).toMatchObject({ from: stage, map: { ok: stages[index + 1] ?? 'done', fail: 'failed' } });
  }
  const { state } = fixture();
  expect(listLoops({ root, stateRoot: state, schedules: [] }).find(loop => loop.id === document.graph_id))
    .toMatchObject({ enabled: false, trigger: { cron: document.loop.trigger.cron }, jobs: [], nextRun: null });
});

function fixture() {
  const state = mkdtempSync(join(tmpdir(), 'nightly-condense-'));
  dirs.push(state);
  const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const event = (n: number, seat: string, value: string, project = 'alpha'): CoordEvent => ({
    id: `fake-${n}`, at: `${day}T09:0${n}:00.000Z`, text: 'not persisted',
    summary: `${project} release ${value}`, kind: '보고',
    refs: { seat, recipients: [], all: false, kind: '보고', slot: null, deadline: null, url: `https://example.test/${n}` },
  });
  const input = { day, events: [event(0, 'TC', 'on'), event(1, 'UX', 'off'), event(2, 'MK', 'on', 'beta')], decisions: [],
    summaries: {
      'https://example.test/0': { project: 'alpha', topic: 'release', summary: 'ready', promote: true, claim: { key: 'release-ready', value: 'on' } },
      'https://example.test/1': { project: 'alpha', topic: 'launch', summary: 'not ready', promote: true, claim: { key: 'release-ready', value: 'off' } },
      'https://example.test/2': { project: 'beta', topic: 'release', summary: 'ready', promote: true, claim: { key: 'release-ready', value: 'on' } },
    } };
  return { state, input };
}

test('nightly librarian recipe separates coordinator promotion from guardian hygiene without changing the ordinary command', () => {
  const standard = summaryInstruction();
  const sleepReview = summaryInstruction('sleep-review');
  expect(summaryInstruction('standard')).toBe(standard);
  expect(standard).toBe('Summarize this one-line context event as a compact project/seat memory item. Return ONLY JSON: {"project":"...","topic":"...","summary":"...","claim":{"key":"...","value":"..."}}. Omit claim when the event makes no comparable factual assertion. Never invent a project, topic or claim.');
  expect(standard).not.toContain('Sleep review');
  expect(sleepReview).toContain('"promote":false');
  expect(sleepReview).toContain('coordinator promotion policy');
  expect(sleepReview).toContain('librarian contract');
  expect(sleepReview).toContain('guardian hygiene (retention, compression, size, backup, integrity or rollback)');
  expect(sleepReview).toContain('OP conflict candidates');
});

test('ordinary summary still uses the original streamLLM recipe', async () => {
  const calls: string[] = [];
  const stream = spyOn(llm, 'streamLLM').mockImplementation(async messages => {
    calls.push(String(messages[0]?.content));
    return JSON.stringify({ project: 'alpha', topic: 'release', summary: 'reviewed' });
  });
  try {
    expect(await summarize({ kind: 'event', at: new Date().toISOString(), seat: 'TC', text: 'release', source: 'https://example.test/0' }))
      .toMatchObject({ summary: 'reviewed' });
    expect(calls).toEqual([summaryInstruction()]);
  } finally { stream.mockRestore(); }
});

test('nightly sleep-review policy requires an explicit promotion in the in-process summarizer', async () => {
  const { state, input } = fixture();
  const calls: Array<{ system: string; user: string }> = [];
  const stream = spyOn(llm, 'streamLLM').mockImplementation(async messages => {
    calls.push({ system: String(messages[0]?.content), user: String(messages[1]?.content) });
    const source = JSON.parse(String(messages[1]?.content)) as { seat: string };
    return JSON.stringify({ project: 'alpha', topic: source.seat, summary: 'reviewed',
      promote: source.seat === 'TC', claim: { key: 'readiness', value: 'on' } });
  });
  try {
    const collected = { day: input.day, events: input.events, decisions: [] };
    const result = await runNightlyStage('condense', { input: { day: input.day }, outputs: { collect: collected } }, state, false,
      new Date(), source => summarize(source, undefined, 'sleep-review'));
    expect(calls).toHaveLength(3);
    expect(calls.every(call => call.system.includes('nightly task agent (librarian)')
      && call.system.includes('coordinator promotion policy') && call.system.includes('"promote"'))).toBe(true);
    expect(calls.map(call => JSON.parse(call.user).seat)).toEqual(['TC', 'UX', 'MK']);
    expect((result.items as MemoryItem[]).map(item => item.seat)).toEqual(['TC']);
  } finally { stream.mockRestore(); }
});

test('a bare {"promote":false} from the real sleep-review summarizer counts as not-promoted, not summarize-failed', async () => {
  const { input } = fixture();
  const stream = spyOn(llm, 'streamLLM').mockImplementation(async messages => {
    const source = JSON.parse(String(messages[1]?.content)) as { seat: string };
    return source.seat === 'TC'
      ? JSON.stringify({ promote: true, project: 'alpha', topic: 'release', summary: 'ready' })
      : JSON.stringify({ promote: false });
  });
  try {
    const since = `${input.day}T00:00:00.000Z`;
    const until = new Date(Date.parse(since) + 86_400_000).toISOString();
    const report = await condenseContextWindowWithReport(since, until, [], {
      events: () => input.events, decisions: () => [], summarize: source => summarize(source, undefined, 'sleep-review'),
    }, new Date(), { promotion: 'sleep-review', retention: 'guardian' });
    expect(report.skipped['not-promoted']).toBe(2);
    expect(report.skipped['summarize-failed']).toBeUndefined();
  } finally { stream.mockRestore(); }
});

test('record is all-or-nothing: a later group over the size budget restores the snapshot already written', async () => {
  const { state, input } = fixture();
  const before = [{ project: 'alpha', seat: 'TC', topic: 'old', summary: 'kept', source: 'https://example.test/kept',
    updatedAt: new Date(Date.parse(`${input.day}T00:00:00.000Z`) - 86_400_000).toISOString(), status: 'active' as const }];
  mkdirSync(join(state, 'context-memory', 'alpha'), { recursive: true });
  writeFileSync(join(state, 'context-memory', 'alpha', 'TC.json'), JSON.stringify(before));
  const olderBackup = gzipSync(Buffer.from('[{"older":"backup"}]'));
  writeFileSync(join(state, 'context-memory', 'alpha', 'TC.json.gz'), olderBackup);
  const now = new Date();
  const small: MemoryItem = { project: 'alpha', seat: 'TC', topic: 'new', summary: 'small', source: 'https://example.test/s',
    updatedAt: now.toISOString(), status: 'active' };
  const huge: MemoryItem = { project: 'beta', seat: 'MK', topic: 'big', summary: 'x'.repeat(17 * 1024 * 1024),
    source: 'https://example.test/h', updatedAt: now.toISOString(), status: 'active' };
  const collected = { day: input.day, events: input.events, decisions: [] };
  await expect(runNightlyStage('record', { input: { day: input.day }, outputs: { collect: collected, condense: { items: [small, huge] } } },
    state, false, now, undefined, items => [...items])).rejects.toThrow('size budget');
  expect(JSON.parse(readFileSync(join(state, 'context-memory', 'alpha', 'TC.json'), 'utf8'))).toEqual(before);
  expect(existsSync(join(state, 'context-memory', 'beta', 'MK.json'))).toBe(false);
  expect(readFileSync(join(state, 'context-memory', 'alpha', 'TC.json.gz')).equals(olderBackup)).toBe(true);
  expect(existsSync(join(state, 'context-memory', 'beta', 'MK.json.gz'))).toBe(false);
  expect(readdirSync(join(state, 'context-memory', 'alpha')).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

test('the live nightly graph assigns librarian sleep-review workers and guardian retirement workers', async () => {
  const { state, input } = fixture();
  const old = { project: 'alpha', seat: 'OP', topic: 'old', summary: 'archived',
    source: 'https://example.test/old', updatedAt: '2020-01-01T00:00:00.000Z', status: 'active' };
  mkdirSync(join(state, 'context-memory', 'alpha'), { recursive: true });
  writeFileSync(join(state, 'context-memory', 'alpha', 'OP.json'), JSON.stringify([old]));
  const result = await runGraph(graph, { input, deps: { root: state } });
  expect(result.status).toBe('done');
  const assigned = lastJsonObject(result.nodes[1]?.output) as { assignments: Array<Record<string, unknown>> };
  expect(assigned.assignments).toHaveLength(3);
  expect(assigned.assignments.every(task => task.owner === 'coordinator' && task.assignee === 'nightly-task-agent'
    && task.contract === 'librarian' && task.recipe === 'sleep-review'
    && Number.isSafeInteger(task.workerPid) && task.workerPid !== process.pid)).toBe(true);
  expect(new Set(assigned.assignments.map(task => task.workerPid)).size).toBe(3);
  const recorded = lastJsonObject(result.nodes[2]?.output) as { guardian: Record<string, unknown> };
  expect(recorded.guardian).toMatchObject({ assignee: 'guardian', recipe: 'retire-aged', retired: 1 });
  expect(Number.isSafeInteger(recorded.guardian.workerPid)).toBe(true);
  expect(recorded.guardian.workerPid).not.toBe(process.pid);
  expect(JSON.parse(gunzipSync(readFileSync(join(state, 'context-memory', 'alpha', 'OP.json.gz'))).toString()))
    .toEqual([old]);
  expect(JSON.parse(readFileSync(join(state, 'context-memory', 'alpha', 'OP.json'), 'utf8')))
    .toMatchObject([{ status: 'retired', source: old.source }]);
}, 90_000);

test('live sleep-review workers honor coordinator promotion while preserving conflict candidates', async () => {
  const { state, input } = fixture();
  const result = await runGraph(graph, { input: { ...input, summaries: { ...input.summaries,
    'https://example.test/2': { ...input.summaries['https://example.test/2']!, promote: false },
  } }, deps: { root: state } });
  expect(result.status).toBe('done');
  expect((lastJsonObject(result.nodes[1]?.output) as { assignments: unknown[] }).assignments).toHaveLength(3);
  expect(existsSync(join(state, 'context-memory', 'beta', 'MK.json'))).toBe(false);
  expect(JSON.parse(readFileSync(join(state, 'context-memory', 'conflict-candidates.json'), 'utf8')))
    .toMatchObject([{ owner: 'OP', sources: ['https://example.test/0', 'https://example.test/1'] }]);
}, 90_000);

test('live sleep review stores promoted sourced events without comparable claims; corrections still choose the latest timestamp', async () => {
  const { state, input } = fixture();
  const correction = { ...input.events[0]!, id: 'fake-correction', at: `${input.day}T09:04:00.000Z`,
    refs: { ...input.events[0]!.refs, url: 'https://example.test/correction' } };
  const summaries = { ...input.summaries,
    'https://example.test/0': { project: 'alpha', topic: 'release', summary: 'initial note', promote: true },
    'https://example.test/correction': { project: 'alpha', topic: 'release', summary: 'corrected note', promote: true },
  };
  const result = await runGraph(graph, { input: { ...input, events: [...input.events, correction], summaries }, deps: { root: state } });
  expect(result.status).toBe('done');
  const saved = JSON.parse(readFileSync(join(state, 'context-memory', 'alpha', 'TC.json'), 'utf8')) as MemoryItem[];
  expect(saved).toMatchObject([{ summary: 'corrected note', source: 'https://example.test/correction',
    updatedAt: correction.at, status: 'active' }]);
  expect(saved).toHaveLength(1);
  expect(Object.keys(saved[0]!).sort()).toEqual(['project', 'seat', 'source', 'status', 'summary', 'topic', 'updatedAt']);
  expect(JSON.parse(readFileSync(join(state, 'context-memory', 'conflict-candidates.json'), 'utf8'))).toEqual([]);
}, 90_000);

test('nightly task receives the sleep-review recipe and guardian retires only at record boundary', async () => {
  const { state, input } = fixture();
  const old = { project: 'alpha', seat: 'OP', topic: 'old', summary: 'former',
    source: 'https://example.test/old', updatedAt: '2020-01-01T00:00:00.000Z', status: 'active' as const,
    claim: { key: 'release-ready', value: 'off' } };
  const file = join(state, 'context-memory', 'alpha', 'OP.json');
  mkdirSync(join(state, 'context-memory', 'alpha'), { recursive: true });
  writeFileSync(file, JSON.stringify([old]));
  const calls: Array<{ assignee: string; recipe: string; source: string }> = [];
  const collected = await runNightlyStage('collect', { input: { day: input.day, events: input.events, decisions: [] }, outputs: {} }, state, false);
  const context = { input: { day: input.day, events: input.events, decisions: [] },
    outputs: { collect: { day: input.day, events: input.events, decisions: [] } } };
  const condensed = await runNightlyStage('condense', context, state, false, new Date(), async (source, assignee, recipe) => {
    calls.push({ source: source.source, assignee, recipe });
    return { ...input.summaries[source.source as keyof typeof input.summaries]!, promote: source.seat !== 'MK' };
  });
  expect(collected.outcome).toBe('ok');
  expect(calls).toEqual(input.events.map(event => ({ source: event.refs.url!, assignee: 'nightly-task-agent', recipe: 'sleep-review' })));
  const items = condensed.items as MemoryItem[];
  expect(items).toHaveLength(3);
  expect(items.find(item => item.topic === 'old')?.status).toBe('active');
  expect(items.some(item => item.seat === 'MK')).toBe(false);
  expect(items.find(item => item.seat === 'UX')?.conflict?.owner).toBe('OP');
  expect(items.find(item => item.seat === 'TC')?.conflict).toBeUndefined();
  const guardianCalls: Array<{ assignee: string; before: string[]; after: string[] }> = [];
  const guardian = (memory: readonly MemoryItem[], assignee: 'guardian', now: Date) => {
    const after = memory.map(item => ({ ...item, status: Date.parse(item.updatedAt) < now.getTime() - 30 * 86_400_000
      ? 'retired' as const : item.status }));
    guardianCalls.push({ assignee, before: memory.map(item => item.status), after: after.map(item => item.status) });
    return after;
  };
  await runNightlyStage('record', { ...context, outputs: { ...context.outputs, condense: { items } } }, state, false,
    new Date(), async () => { throw new Error('librarian must not run during record'); }, guardian);
  expect(guardianCalls).toEqual([{ assignee: 'guardian', before: ['active', 'active', 'active'], after: ['retired', 'active', 'active'] }]);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject([{ topic: 'old', status: 'retired', source: old.source }]);
  const saved = JSON.parse(readFileSync(join(state, 'context-memory', 'alpha', 'TC.json'), 'utf8')) as Array<Record<string, unknown>>;
  expect(Object.keys(saved[0]!).sort()).toEqual(['claim', 'project', 'seat', 'source', 'status', 'summary', 'topic', 'updatedAt']);
  expect(existsSync(join(state, 'context-memory', 'beta', 'MK.json'))).toBe(false);
});

test('guardian rejects an oversized snapshot and restores the previous ledger from its compressed backup', async () => {
  const { state, input } = fixture();
  const old = { project: 'alpha', seat: 'TC', topic: 'old', summary: 'untouched',
    source: 'https://example.test/old', updatedAt: '2020-01-01T00:00:00.000Z', status: 'active' as const };
  const file = join(state, 'context-memory', 'alpha', 'TC.json');
  mkdirSync(join(state, 'context-memory', 'alpha'), { recursive: true });
  writeFileSync(file, JSON.stringify([old]));
  const oversized: MemoryItem = { ...old, topic: 'large', summary: 'x'.repeat(17 * 1024 * 1024) };
  const context = { input, outputs: { collect: { day: input.day, events: input.events, decisions: input.decisions },
    condense: { items: [oversized] } } };
  await expect(runNightlyStage('record', context, state, false)).rejects.toThrow('guardian memory size budget exceeded');
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([old]);
  // The guardian restored the ledger from its backup; the failed record then leaves the backup as it found it (none).
  expect(existsSync(`${file}.gz`)).toBe(false);
}, 90_000);

test('nightly graph dry-run condenses fake day into memory items and conflict candidates without publishing or writing', async () => {
  const { state, input } = fixture();
  const result = await runGraph(graph, { input, dryRun: true, deps: { root: state } });
  expect(result.status).toBe('done');
  expect(result.path).toEqual(['collect', 'condense', 'record', 'conflict-candidates', 'done']);
  expect(lastJsonObject(result.nodes[2]?.output)).toMatchObject({ items: 3, dryRun: true,
    memoryItems: [{ project: 'alpha', seat: 'TC' }, { project: 'alpha', seat: 'UX' }, { project: 'beta', seat: 'MK' }] });
  expect(lastJsonObject(result.nodes[3]?.output)).toMatchObject({ published: 0, candidates: [
    { project: 'alpha', topic: 'launch', owner: 'OP', status: 'candidate', sources: ['https://example.test/0', 'https://example.test/1'] },
  ] });
  expect(readdirSync(state)).toEqual(['graph-runs']);
}, 90_000);

test('live graph stores project/seat memories and conflict candidate file without a decision card', async () => {
  const { state, input } = fixture();
  const result = await runGraph(graph, { input, deps: { root: state } });
  expect(result.status).toBe('done');
  expect(lastJsonObject(result.nodes[3]?.output)).toMatchObject({ published: 0 });
  const memory = (project: string, seat: string) => JSON.parse(readFileSync(join(state, 'context-memory', project, `${seat}.json`), 'utf8'));
  expect(memory('alpha', 'TC')).toMatchObject([{ project: 'alpha', seat: 'TC', summary: 'ready' }]);
  expect(memory('alpha', 'UX')).toMatchObject([{ project: 'alpha', seat: 'UX', summary: 'not ready' }]);
  expect(memory('beta', 'MK')).toMatchObject([{ project: 'beta', seat: 'MK', summary: 'ready' }]);
  expect(JSON.parse(readFileSync(join(state, 'context-memory', 'conflict-candidates.json'), 'utf8'))).toMatchObject([
    { status: 'candidate', owner: 'OP', sources: ['https://example.test/0', 'https://example.test/1'] },
  ]);
  expect(readdirSync(state).sort()).toEqual(['context-memory', 'graph-runs']);
  const repeat = await runGraph(graph, { input, deps: { root: state } });
  expect(gunzipSync(readFileSync(join(state, 'context-memory', 'alpha', 'TC.json.gz'))).toString())
    .toContain('"summary": "ready"');
  expect(gunzipSync(readFileSync(join(state, 'context-memory', 'conflict-candidates.json.gz'))).toString())
    .toContain('"owner": "OP"');
  expect(repeat.status).toBe('done');
  expect(memory('alpha', 'UX')).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(state, 'context-memory', 'conflict-candidates.json'), 'utf8'))).toHaveLength(1);
}, 120_000); // two live runs spawn ~16 short task workers (librarian · guardian); 30s overflows a loaded host

test('nightly graph collects the isolated bus, channel and decision ledger before recording librarian candidates', async () => {
  const { state, input } = fixture();
  const previousState = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = state;
  try {
    const db = openSurfaceEventsDb();
    try {
      const rows = [
        { surface: 'coord:channel', seat: 'TC', source: 'https://example.test/0', summary: 'alpha release on', at: `${input.day}T09:00:00.000Z` },
        { surface: 'context:external', seat: 'UX', source: 'https://example.test/1', summary: 'alpha launch off', at: `${input.day}T09:01:00.000Z` },
        { surface: 'context:session', seat: 'MK', source: 'https://example.test/2', summary: 'beta release on', at: `${input.day}T09:02:00.000Z` },
      ];
      for (const row of rows) recordEvent(db, { surface: row.surface, direction: 'outbound', kind: '보고',
        text: row.summary, summary: row.summary, ts: row.at,
        refs: JSON.stringify({ seat: row.seat, url: row.source, recipients: [], all: false, kind: '보고', slot: null, deadline: null }) });
    } finally { db.close(); }
    expect(surfaceEventsDbPath().startsWith(state)).toBe(true);
    const ledger = new DecisionLedger({ stateDir: state, now: () => new Date(`${input.day}T09:03:00.000Z`),
      resolveVersion: () => ({ development: '0.2.21', release: '0.2.21' }) as never });
    const decision = ledger.raise({ title: 'beta launch route', category: 'scope',
      scqa: { s: 'beta launch', c: 'choose route' },
      options: [{ key: 'a', label: 'go', consequence: 'ship' }, { key: 'b', label: 'wait', consequence: 'hold' }],
      recommendation: { skipped: true, reason: 'requires OP' }, raisedBy: { agent: 'OP', track: 'OP' },
    });
    const summaries = { ...input.summaries,
      [`elanous://decisions/${decision.id}`]: { project: 'beta', topic: 'launch', summary: 'route selected', promote: true },
    };
    const result = await runGraph(graph, { input: { day: input.day, summaries }, deps: { root: state } });
    expect(result.status).toBe('done');
    expect(lastJsonObject(result.nodes[0]?.output)).toMatchObject({ events: [
      { surface: 'coord:channel', refs: { seat: 'TC' } },
      { surface: 'context:external', refs: { seat: 'UX' } },
      { surface: 'context:session', refs: { seat: 'MK' } },
    ], decisions: [{ id: decision.id, title: 'beta launch route' }] });
    expect(lastJsonObject(result.nodes[2]?.output)).toMatchObject({ items: 4, dryRun: false });
    expect(JSON.parse(readFileSync(join(state, 'context-memory', 'beta', 'OP.json'), 'utf8')))
      .toMatchObject([{ source: `elanous://decisions/${decision.id}`, summary: 'route selected' }]);
    expect(JSON.parse(readFileSync(join(state, 'context-memory', 'alpha', 'UX.json'), 'utf8')))
      .toMatchObject([{ source: 'https://example.test/1', updatedAt: `${input.day}T09:01:00.000Z`, status: 'active' }]);
    expect(JSON.parse(readFileSync(join(state, 'context-memory', 'conflict-candidates.json'), 'utf8')))
      .toMatchObject([{ owner: 'OP', status: 'candidate', sources: ['https://example.test/0', 'https://example.test/1'] }]);
    expect(ledger.list({ status: 'all' }).map(entry => entry.id)).toEqual([decision.id]);
  } finally {
    if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousState;
  }
}, 90_000);

test('nightly replay carries old memory and retires it after 30 days without a new hygiene writer', async () => {
  const { state, input } = fixture();
  const old = { project: 'alpha', seat: 'TC', topic: 'old release', summary: 'archived',
    source: 'https://example.test/old', updatedAt: '2020-01-01T00:00:00.000Z', status: 'active' };
  const file = join(state, 'context-memory', 'alpha', 'TC.json');
  mkdirSync(join(state, 'context-memory', 'alpha'), { recursive: true });
  writeFileSync(file, JSON.stringify([old]));
  const result = await runGraph(graph, { input, deps: { root: state } });
  expect(result.status).toBe('done');
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject([
    { topic: 'old release', updatedAt: old.updatedAt, status: 'retired' },
    { topic: 'release', updatedAt: input.events[0]!.at, status: 'active' },
  ]);
}, 90_000);

test('replaying an older day never overwrites later project/seat memory or candidate files', async () => {
  const { state, input } = fixture();
  const firstDay = new Date(Date.parse(`${input.day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const firstInput = { ...input, day: firstDay, events: input.events.map(event => ({
    ...event, at: event.at.replace(input.day, firstDay),
  })) };
  const memoryFile = join(state, 'context-memory', 'alpha', 'TC.json');
  const candidatesFile = join(state, 'context-memory', 'conflict-candidates.json');
  expect((await runGraph(graph, { input: firstInput, deps: { root: state } })).status).toBe('done');
  expect(JSON.parse(readFileSync(candidatesFile, 'utf8'))).toHaveLength(1);
  const secondInput = { ...input, summaries: { ...input.summaries,
    'https://example.test/1': { project: 'alpha', topic: 'launch', summary: 'ready', promote: true, claim: { key: 'release-ready', value: 'on' } },
  } };
  expect((await runGraph(graph, { input: secondInput, deps: { root: state } })).status).toBe('done');
  const laterMemory = readFileSync(memoryFile, 'utf8');
  const laterCandidates = readFileSync(candidatesFile, 'utf8');
  expect(JSON.parse(laterCandidates)).toEqual([]);
  expect(JSON.parse(laterMemory)).toMatchObject([{ updatedAt: expect.stringContaining(input.day) }]);
  const replay = await runGraph(graph, { input: firstInput, deps: { root: state } });
  expect(replay.status).toBe('failed');
  expect(readFileSync(memoryFile, 'utf8')).toBe(laterMemory);
  expect(readFileSync(candidatesFile, 'utf8')).toBe(laterCandidates);
}, 60_000);

test('interleaved older stages cannot replace newer project/seat memory or conflict candidates', async () => {
  const { state, input } = fixture();
  const oldDay = new Date(Date.parse(`${input.day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const oldInput = { ...input, day: oldDay, events: input.events.map(event => ({
    ...event, at: event.at.replace(input.day, oldDay),
  })) };
  const older = { input: oldInput, outputs: {} };
  const collected = await runNightlyStage('collect', older, state, false);
  const oldCollected = { day: oldDay, events: oldInput.events, decisions: oldInput.decisions };
  const condensed = await runNightlyStage('condense', { input: oldInput, outputs: { collect: oldCollected } }, state, false);
  const oldItems = condensed.items as MemoryItem[];
  const oldContext = { input: oldInput, outputs: { collect: oldCollected, condense: { items: oldItems } } };
  expect(collected.day).toBe(oldDay);
  expect(oldItems).toHaveLength(3);

  const newerInput = { ...input, summaries: { ...input.summaries,
    'https://example.test/1': { project: 'alpha', topic: 'launch', summary: 'ready', promote: true, claim: { key: 'release-ready', value: 'on' } },
  } };
  expect((await runGraph(graph, { input: newerInput, deps: { root: state } })).status).toBe('done');
  const memoryFile = join(state, 'context-memory', 'alpha', 'TC.json');
  const candidatesFile = join(state, 'context-memory', 'conflict-candidates.json');
  const newestMemory = readFileSync(memoryFile, 'utf8');
  const newestCandidates = readFileSync(candidatesFile, 'utf8');
  expect(JSON.parse(newestCandidates)).toEqual([]);
  await expect(runNightlyStage('record', oldContext, state, false)).rejects.toThrow(`cannot replay ${oldDay}`);
  await expect(runNightlyStage('conflict-candidates', { ...oldContext, outputs: {
    ...oldContext.outputs, record: { memoryItems: oldItems },
  } }, state, false)).rejects.toThrow(`cannot replay ${oldDay}`);
  expect(readFileSync(memoryFile, 'utf8')).toBe(newestMemory);
  expect(readFileSync(candidatesFile, 'utf8')).toBe(newestCandidates);

  const second = fixture();
  const secondOld = { ...oldContext, input: { ...oldInput } };
  await runNightlyStage('record', secondOld, second.state, false);
  expect((await runGraph(graph, { input: newerInput, deps: { root: second.state } })).status).toBe('done');
  const secondMemory = readFileSync(join(second.state, 'context-memory', 'alpha', 'TC.json'), 'utf8');
  const secondCandidates = readFileSync(join(second.state, 'context-memory', 'conflict-candidates.json'), 'utf8');
  await expect(runNightlyStage('conflict-candidates', { ...secondOld, outputs: {
    ...secondOld.outputs, record: { memoryItems: oldItems },
  } }, second.state, false)).rejects.toThrow(`cannot replay ${oldDay}`);
  expect(readFileSync(join(second.state, 'context-memory', 'alpha', 'TC.json'), 'utf8')).toBe(secondMemory);
  expect(readFileSync(join(second.state, 'context-memory', 'conflict-candidates.json'), 'utf8')).toBe(secondCandidates);
}, 60_000);

test('other graphs still skip command recipes on dry-run', async () => {
  const { state } = fixture();
  const result = await runGraph(join(root, 'graphs/steward/steward.yaml'), { dryRun: true, deps: { root: state,
    runBash: async () => { throw new Error('ordinary dry-run must not execute a command'); },
  } });
  expect(result.status).toBe('done');
  expect(result.executed).toBe(0);
  expect(result.nodes.every(node => !node.executed && node.output === undefined)).toBe(true);
});

test('loop list declares 03:30 while leaving cron disabled until a person starts it', async () => {
  const { state } = fixture();
  const opts = { root, stateRoot: state, schedules: [] };
  const entry = listLoops(opts).find(loop => loop.id === 'nightly-condense');
  expect(entry).toMatchObject({ file: 'graphs/context/nightly-condense.yaml', enabled: false,
    trigger: { cron: '30 3 * * *' }, jobs: [], nextRun: null });
  expect(await setLoopEnabled('nightly-condense', true, false, opts)).toMatchObject({ dryRun: true,
    changes: [{ action: 'create', cron: '30 3 * * *' }] });
});

test('CLI loop list in the isolated instance shows nightly condensation disabled', () => {
  const { state } = fixture();
  const output = spawnSync(process.execPath, ['bin/elanous.mjs', '--test', 'loop', 'list', '--json'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, ELANOUS_INSTALL_PREFIX: state } });
  expect(output.status).toBe(0);
  const loops = JSON.parse(output.stdout) as Array<{ id: string; file: string; enabled: boolean; trigger: { cron: string }; jobs: unknown[] }>;
  expect(loops.find(loop => loop.id === 'nightly-condense')).toMatchObject({
    file: 'graphs/context/nightly-condense.yaml', enabled: false, trigger: { cron: '30 3 * * *' }, jobs: [],
  });
});
