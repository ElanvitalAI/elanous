import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { CoordEvent } from './coord-events.js';
import { runGraph, lastJsonObject } from '../graph-runner/runner.js';
import { listLoops, setLoopEnabled } from '../loops/registry.js';
import { runNightlyStage } from './nightly-condense.js';
import type { MemoryItem } from './long-term-memory.js';

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
      'https://example.test/0': { project: 'alpha', topic: 'release', summary: 'ready', claim: { key: 'release-ready', value: 'on' } },
      'https://example.test/1': { project: 'alpha', topic: 'launch', summary: 'not ready', claim: { key: 'release-ready', value: 'off' } },
      'https://example.test/2': { project: 'beta', topic: 'release', summary: 'ready', claim: { key: 'release-ready', value: 'on' } },
    } };
  return { state, input };
}

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
}, 30_000);

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
  expect(repeat.status).toBe('done');
  expect(memory('alpha', 'UX')).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(state, 'context-memory', 'conflict-candidates.json'), 'utf8'))).toHaveLength(1);
}, 30_000);

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
    'https://example.test/1': { project: 'alpha', topic: 'launch', summary: 'ready', claim: { key: 'release-ready', value: 'on' } },
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
    'https://example.test/1': { project: 'alpha', topic: 'launch', summary: 'ready', claim: { key: 'release-ready', value: 'on' } },
  } };
  expect((await runGraph(graph, { input: newerInput, deps: { root: state } })).status).toBe('done');
  const memoryFile = join(state, 'context-memory', 'alpha', 'TC.json');
  const candidatesFile = join(state, 'context-memory', 'conflict-candidates.json');
  const newestMemory = readFileSync(memoryFile, 'utf8');
  const newestCandidates = readFileSync(candidatesFile, 'utf8');
  expect(JSON.parse(newestCandidates)).toEqual([]);
  await expect(runNightlyStage('record', oldContext, state, false)).rejects.toThrow(`cannot replay ${oldDay}`);
  await expect(runNightlyStage('conflict-candidates', { ...oldContext, outputs: {
    ...oldContext.outputs, record: { items: oldItems },
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
    ...secondOld.outputs, record: { items: oldItems },
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
