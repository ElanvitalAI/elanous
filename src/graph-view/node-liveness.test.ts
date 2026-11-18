import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphEvent } from '../graph-runner/graph-events.js';
import { graphRunEventLedgerPath, readGraphRunEvents } from '../graph-runner/graph-run-event-ledger.js';
import { emptyGraphCapabilityRegistry, registerGraphCapabilityContract,
  registerGraphCapabilityProviderDeclaration } from '../graph-runner/capabilities.js';
import { runGraph } from '../graph-runner/runner.js';
import { bunTestCounts, createNodeProgressReporter, NODE_HEARTBEAT_EVENT, NODE_HEARTBEAT_QUIET_MS,
  NODE_PROGRESS_EVENT, NODE_PROGRESS_NOTE_CHARS, normalizeNodeProgress } from '../graph-runner/node-progress.js';
import { NODE_LIVENESS_ACTIVE_MS, NODE_LIVENESS_STALLED_MS, NO_LEDGER_TEXT, nodeLiveness, renderNodeLivenessNarrow,
  renderNodeLivenessToolRow, renderNodeLivenessWide, summarizeNodeLiveness } from './node-liveness.js';

// The ledger fixture ticks in whole minutes; the heartbeat quiet period is that minute.
const MINUTE = NODE_HEARTBEAT_QUIET_MS;
const T0 = Date.parse('2026-11-17T17:58:00.000Z');
const STAGES = ['grounding', 'architecture', 'files', 'verify-repair', 'materialize', 'publish'];

function ledger(): GraphEvent[] {
  const events: GraphEvent[] = [];
  const push = (minute: number, type: string, nodeId: string, data: Record<string, unknown> = {}) => events.push({
    eventId: `e${events.length + 1}`, sequence: events.length + 1, emittedAt: new Date(T0 + minute * MINUTE).toISOString(),
    graphId: 'app-build', runId: '891dc068-run', type, source: { kind: type === NODE_HEARTBEAT_EVENT ? 'runner' : 'node', nodeId }, data });
  const at = (minute: number) => new Date(T0 + minute * MINUTE).toISOString();
  push(0, 'node-start', 'grounding'); push(1, 'node-end', 'grounding', { outcome: 'ok' });
  push(1, 'node-start', 'architecture'); push(2, 'node-end', 'architecture', { outcome: 'ok' });
  push(2, 'node-start', 'files'); push(10, 'node-end', 'files', { outcome: 'ok' });
  push(10, 'node-start', 'verify-repair');
  // Three rounds: 10 → 25 → 40, failed tests 3 → 2 → 1.
  for (const [round, start, fail, target] of [[1, 10, 3, 'backend/a.ts'], [2, 25, 2, 'backend/b.ts'],
    [3, 40, 1, 'backend/booking-conflict.test.ts']] as const) {
    push(start, NODE_PROGRESS_EVENT, 'verify-repair', { nodeId: 'verify-repair', round, phase: 'verify' });
    push(start + 2, NODE_PROGRESS_EVENT, 'verify-repair', { nodeId: 'verify-repair', round, phase: 'test', result: { pass: 9, fail } });
    push(start + 3, NODE_PROGRESS_EVENT, 'verify-repair', { nodeId: 'verify-repair', round, phase: 'repair', target, llmCallAt: at(start + 3) });
  }
  return events;
}

test('fake ledger with three rounds renders the wide sidetab frame, the narrow line and the default tool row', () => {
  const events = ledger();
  const now = T0 + 48 * MINUTE;
  const summary = summarizeNodeLiveness(events, now, STAGES);
  expect(renderNodeLivenessWide(summary, 'app-build', now)).toEqual([
    '⎇ app-build · 891dc068 · 48m           ● 살아 있음 (마지막 수리 호출 5분 전)',
    '  ✓ grounding ─ ✓ architecture ─ ✓ files ─ ◐ verify-repair ─ ○ materialize ─ ○ publish',
    '  verify-repair · 라운드 3 · 실패 시험 2 → 1',
    '    ↳ 수리 중  backend/booking-conflict.test.ts',
    '    ↳ 라운드 평균 15분 · 이번 라운드 8분째',
  ]);
  expect(renderNodeLivenessNarrow(summary, 'app-build')).toBe('⎇ app-build · verify-repair r3 · fail 1 · ● 5m');
  expect(renderNodeLivenessToolRow(summary, 'app_build', now)).toEqual([
    '⏺ app_build · verify-repair r3 · 실패 시험 1 · ● 5분 전 수리 호출 · 48m',
    '  ↳ 수리 중 backend/booking-conflict.test.ts',
  ]);
});

test('a stalled node stays stalled even while the runner keeps beating for it', () => {
  const events = ledger();
  const lastActivityMinute = 43;
  const quietMinutes = NODE_LIVENESS_STALLED_MS / MINUTE + 1;
  for (let minute = lastActivityMinute + 1; minute < lastActivityMinute + quietMinutes; minute++)
    events.push({ eventId: `hb${minute}`, sequence: events.length + 1, emittedAt: new Date(T0 + minute * MINUTE).toISOString(),
      graphId: 'app-build', runId: '891dc068-run', type: NODE_HEARTBEAT_EVENT, source: { kind: 'runner', nodeId: 'verify-repair' },
      data: { nodeId: 'verify-repair', lastActivityAt: new Date(T0 + lastActivityMinute * MINUTE).toISOString(), quietMs: (minute - lastActivityMinute) * MINUTE } });
  const now = T0 + (lastActivityMinute + quietMinutes) * MINUTE;
  const summary = summarizeNodeLiveness(events, now, STAGES);
  expect(summary?.liveness).toBe('stalled');
  expect(renderNodeLivenessWide(summary, 'app-build', now)[0]).toBe(`⎇ app-build · 891dc068 · 1h09m           ✕ 멎음 (${quietMinutes}분 무사건)`);
  expect(renderNodeLivenessNarrow(summary, 'app-build')).toBe(`⎇ app-build · verify-repair r3 · fail 1 · ✕ ${quietMinutes}m`);
});

test('parallel nodes each keep their own liveness; one ending does not hide the other, the quietest leads', () => {
  const events = ledger();
  const push = (minute: number, type: string, nodeId: string, data: Record<string, unknown> = {}) => events.push({
    eventId: `p${events.length + 1}`, sequence: events.length + 1, emittedAt: new Date(T0 + minute * MINUTE).toISOString(),
    graphId: 'app-build', runId: '891dc068-run', type, source: { kind: 'node', nodeId }, data });
  push(41, 'node-start', 'materialize');
  push(41, 'node-start', 'publish');
  push(42, 'node-end', 'publish', { outcome: 'ok' });
  events.sort((a, b) => Date.parse(a.emittedAt) - Date.parse(b.emittedAt));
  // verify-repair last spoke at 43m, materialize at 41m: at 60m both are slow, materialize the quieter.
  const now = T0 + 60 * MINUTE;
  const summary = summarizeNodeLiveness(events, now, STAGES)!;
  expect(summary.activeNodes.map((node) => `${node.nodeId}:${node.liveness}`)).toEqual(['materialize:slow', 'verify-repair:slow']);
  expect(summary.activeNodeId).toBe('materialize');
  expect(summary.activeNodes.map((node) => node.round)).toEqual([undefined, 3]);
  expect(renderNodeLivenessNarrow(summary, 'app-build')).toContain('materialize +1');
  const wide = renderNodeLivenessWide(summary, 'app-build', now).join('\n');
  expect(wide).toContain('  verify-repair · 라운드 3 · 실패 시험 2 → 1 · ◐ 느림');
  expect(wide).toContain('  materialize · ◐ 느림');
  expect(summary.chain.filter((node) => node.status === 'running').map((node) => node.nodeId)).toEqual(['verify-repair', 'materialize']);
});

test('liveness has three levels with inclusive upper bounds', () => {
  expect([nodeLiveness(0), nodeLiveness(NODE_LIVENESS_ACTIVE_MS), nodeLiveness(NODE_LIVENESS_ACTIVE_MS + 1),
    nodeLiveness(NODE_LIVENESS_STALLED_MS), nodeLiveness(NODE_LIVENESS_STALLED_MS + 1)])
    .toEqual(['active', 'active', 'slow', 'slow', 'stalled']);
});

test('no ledger shows «정보 없음» and never a made-up state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'node-liveness-empty-'));
  try {
    const events = readGraphRunEvents(graphRunEventLedgerPath(directory, 'app-build', 'missing'));
    const summary = summarizeNodeLiveness(events, T0, STAGES);
    expect(summary).toBeUndefined();
    expect(renderNodeLivenessWide(summary, 'app-build', T0)).toEqual([`⎇ app-build · ${NO_LEDGER_TEXT}`]);
    expect(renderNodeLivenessNarrow(summary, 'app-build')).toBe(`⎇ app-build · ${NO_LEDGER_TEXT}`);
    expect(renderNodeLivenessToolRow(summary, 'app_build', T0)).toEqual([`⏺ app_build · ${NO_LEDGER_TEXT}`]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('node progress keeps only declared fields, a single path and an 80-char note', () => {
  const long = 'x'.repeat(NODE_PROGRESS_NOTE_CHARS + 1);
  expect(normalizeNodeProgress('n', { phase: 'repair', round: 2, target: 'a.ts\nrm -rf', note: long,
    result: { pass: 1, fail: 2 }, secret: 'no' } as never)).toEqual({ nodeId: 'n', phase: 'repair', round: 2, target: 'a.ts',
    result: { pass: 1, fail: 2 }, note: 'x'.repeat(NODE_PROGRESS_NOTE_CHARS) });
  expect(normalizeNodeProgress('n', { phase: 'shell' } as never)).toBeUndefined();
  expect(bunTestCounts(' 3 pass\n 1 fail\n...\n 2 pass\n 0 fail\n')).toEqual({ pass: 5, fail: 1 });
  expect(bunTestCounts('sandbox error')).toBeUndefined();
});

test('reporter beats once per quiet period, not on activity, and never after stop', async () => {
  let now = T0;
  let tick: () => void = () => undefined;
  const published: string[] = [];
  const reporter = createNodeProgressReporter({ nodeId: 'n', now: () => now,
    publish: async type => { published.push(type); }, setInterval: callback => { tick = callback; return 1; }, clearInterval: () => undefined });
  now += NODE_HEARTBEAT_QUIET_MS - 1; tick();
  now += 1; tick(); tick();
  await reporter.report({ phase: 'verify', round: 1 });
  now += NODE_HEARTBEAT_QUIET_MS - 1; tick();
  now += NODE_HEARTBEAT_QUIET_MS; tick();
  reporter.stop();
  now += NODE_HEARTBEAT_QUIET_MS; tick();
  expect(published).toEqual([NODE_HEARTBEAT_EVENT, NODE_PROGRESS_EVENT, NODE_HEARTBEAT_EVENT]);
  const failing = createNodeProgressReporter({ nodeId: 'n', publish: async () => { throw new Error('ledger down'); },
    setInterval: () => 1, clearInterval: () => undefined });
  await expect(failing.report({ phase: 'verify' })).resolves.toBeUndefined();
  failing.stop();
});

test('runner writes provider-reported node-progress to the run ledger', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'node-progress-runner-'));
  const graph = join(directory, 'graph.yaml');
  const stateRoot = join(directory, 'state');
  writeFileSync(join(directory, 'recipes.yaml'), '{}\n');
  writeFileSync(graph, 'graph_id: node-progress\nversion: 1\nentry_node: verify-repair\nterminal_nodes: [done]\nnodes:\n  - { node_id: verify-repair, kind: capability, recipe: none, requires: demo.progress@1, max_visits: 1, input: {} }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: verify-repair, to: done }\n');
  const registry = registerGraphCapabilityProviderDeclaration(registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'demo.progress@1', input: { type: 'object' }, output: { type: 'object' },
  }), { id: 'progress-provider', provides: ['demo.progress@1'], tier: 'free',
    invoke: async context => {
      await context.reportProgress?.({ round: 1, phase: 'verify' });
      await context.reportProgress?.({ round: 1, phase: 'repair', target: 'backend/a.ts', llmCallAt: new Date(T0).toISOString() });
      return { ok: true, outcome: 'done', result: {} };
    } });
  try {
    const run = await runGraph(graph, { runId: 'progress', quiet: true, deps: { root: stateRoot, capabilityProviders: registry } });
    expect(run.status).toBe('done');
    const progress = readGraphRunEvents(graphRunEventLedgerPath(stateRoot, run.graphId, run.runId), 0, NODE_PROGRESS_EVENT);
    expect(progress.map(event => [event.source, event.data])).toEqual([
      [{ kind: 'node', nodeId: 'verify-repair' }, { nodeId: 'verify-repair', phase: 'verify', round: 1 }],
      [{ kind: 'node', nodeId: 'verify-repair' }, { nodeId: 'verify-repair', phase: 'repair', round: 1, target: 'backend/a.ts',
        llmCallAt: new Date(T0).toISOString() }],
    ]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('any node event but the heartbeat is activity: a node that keeps emitting is never judged stalled (r1 mf1)', () => {
  const events: GraphEvent[] = [];
  const push = (minute: number, type: string, kind: 'node' | 'runner' = 'node') => events.push({
    eventId: `e${events.length + 1}`, sequence: events.length + 1, emittedAt: new Date(T0 + minute * MINUTE).toISOString(),
    graphId: 'g', runId: 'run-emits', type, source: { kind, nodeId: 'busy' }, data: {} });
  push(0, 'node-start');
  [4, 8, 12, 16, 20, 24, 28, 32, 36, 40].forEach(minute => { push(minute, 'build.artifact'); push(minute + 2, NODE_HEARTBEAT_EVENT, 'runner'); });
  const summary = summarizeNodeLiveness(events, T0 + 42 * MINUTE)!;
  expect(summary.activeNodes.map(node => [node.nodeId, node.liveness])).toEqual([['busy', 'active']]);
  expect(summary.quietMs).toBe(2 * MINUTE);
});

test('node-end outcome failed (not only fail) shows ✕, never ✓ (r1 mf2)', () => {
  const events: GraphEvent[] = ['fail', 'failed', 'error', 'ok', 'done'].flatMap((outcome, index) => [
    { eventId: `s${index}`, sequence: index * 2 + 1, emittedAt: new Date(T0 + index * MINUTE).toISOString(), graphId: 'g',
      runId: 'run-outcome', type: 'node-start', source: { kind: 'node', nodeId: outcome }, data: {} },
    { eventId: `e${index}`, sequence: index * 2 + 2, emittedAt: new Date(T0 + index * MINUTE).toISOString(), graphId: 'g',
      runId: 'run-outcome', type: 'node-end', source: { kind: 'node', nodeId: outcome }, data: { outcome } }] as GraphEvent[]);
  expect(summarizeNodeLiveness(events, T0 + 5 * MINUTE)!.chain).toEqual([
    { nodeId: 'fail', status: 'failed' }, { nodeId: 'failed', status: 'failed' }, { nodeId: 'error', status: 'failed' },
    { nodeId: 'ok', status: 'done' }, { nodeId: 'done', status: 'done' }]);
});

test('reporter touch is activity: no heartbeat while the node keeps emitting other events (r1 mf1)', () => {
  let now = T0;
  let tick: () => void = () => undefined;
  const published: string[] = [];
  const reporter = createNodeProgressReporter({ nodeId: 'n', now: () => now,
    publish: async type => { published.push(type); }, setInterval: callback => { tick = callback; return 1; }, clearInterval: () => undefined });
  for (let step = 0; step < 5; step++) { now += NODE_HEARTBEAT_QUIET_MS - 1; reporter.touch(); tick(); }
  expect(published).toEqual([]);
  now += NODE_HEARTBEAT_QUIET_MS; tick();
  expect(published).toEqual([NODE_HEARTBEAT_EVENT]);
  reporter.stop();
});
