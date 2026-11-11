import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from '../graph-runner/runner.js';
import { createPlacementJsonlRecorder, createPlacementShadowGraphHandlers, runPlacementShadowGraph, type PlacementSnapshot } from './placement-shadow.js';

const placementGraph = join(import.meta.dir, '../../graphs/ops/placement.yaml');
function expectGraphDone(state: Awaited<ReturnType<typeof runGraph>>): void {
  if (state.status !== 'done') throw new Error(`placement graph ended ${state.status}: ${JSON.stringify(state.nodes.map(node => ({ nodeId: node.nodeId, error: node.error, output: node.output })))}`);
}

const host = (name: string, overrides: Partial<PlacementSnapshot['hosts'][number]> = {}): PlacementSnapshot['hosts'][number] => ({
  host: name, load1Pct: 12, load15Pct: 15, memoryAvailablePct: 55, diskUsedPct: 40, // Source: synthetic green-host fixture values for deterministic graph simulations.
  tools: ['repo', 'bun', 'node_modules', 'codex'], ssh: true, maintenance: false,
  runningKinds: [], tabCount: 0, trainRows: 0, warmPoolPods: 0, cloudRunning: true, cloudIdleMinutes: 0,
  runningByKind: { review: { running: 0, max: 2 }, test: { running: 0, max: 2 }, tsc: { running: 0, max: 2 }, tab: { running: 0, max: 3 }, train: { running: 0, max: 2 } }, // Source: R-TST36; synthetic capacity fixture mirrors seat-state/OP/BRIEF-LOCAL-FIRST-PLACEMENT-1111.md.
  ...overrides,
});
const scenarios: Array<{ name: string; snapshot: PlacementSnapshot; llm: unknown; cio: string; expectedHost: string; expectedAction: 'none' | 'start' | 'stop' }> = [
  {
    name: 'local available',
    snapshot: { workKind: 'test', hosts: [host('node-b'), host('minim5'), host('node-c'), host('aws1', { gateProtected: true }), host('unregistered-host')] },
    llm: { host: 'node-b', workKind: 'test', reason: 'first eligible green local', confidence: 0.94, cloudAction: 'none' },
    cio: 'node-b', expectedHost: 'node-b', expectedAction: 'none',
  },
  {
    name: 'local full; cloud starts only as a shadow recommendation',
    snapshot: { workKind: 'test', hosts: [host('node-b', { load1Pct: 91, load15Pct: 92 }), host('minim5', { load1Pct: 88, load15Pct: 85 }), host('mshq', { load1Pct: 89, load15Pct: 90 }), host('aws2', { cloudRunning: false })] },
    llm: { host: 'aws2', workKind: 'test', reason: 'no eligible local host; green cloud candidate', confidence: 0.81, cloudAction: 'start' },
    cio: 'wait', expectedHost: 'aws2', expectedAction: 'start',
  },
  {
    name: 'local available; idle cloud stop remains shadow-only',
    snapshot: { workKind: 'test', hosts: [
      host('node-b'), host('minim5'), host('mshq', { load1Pct: 75, load15Pct: 82 }),
      host('aws2', { load15Pct: 5, cloudIdleMinutes: 10, cloudRunning: true }),
    ] },
    llm: { host: 'node-b', workKind: 'test', reason: 'local capacity replaces idle cloud', confidence: 0.88, cloudAction: 'stop' },
    cio: 'node-b', expectedHost: 'node-b', expectedAction: 'stop',
  },
];

test.each(scenarios)('placement shadow simulation: $name', async ({ snapshot, llm, cio, expectedHost, expectedAction }) => {
  const root = mkdtempSync(join(tmpdir(), 'guardian-placement-shadow-'));
  try {
    const pickHostCalls: string[] = [];
    const shadowRows: unknown[] = [];
    const state = await runGraph(placementGraph, { runId: `placement-${expectedHost}`, input: { snapshot, cioHost: cio }, deps: {
      inProcessHandlers: createPlacementShadowGraphHandlers({
        pickHostFallback: async kind => { pickHostCalls.push(kind); return undefined; },
        recordShadow: async row => { shadowRows.push(row); },
      }),
      root, callLLM: async prompt => {
        expect(prompt).toContain('"workKind"');
        expect(prompt).toContain('"candidates":[');
        expect(prompt).not.toContain('"host":"aws1"');
        expect(prompt).not.toContain('"host":"mbp"');
        return JSON.stringify(llm);
      },
    } });
    expectGraphDone(state);
    const filtered = JSON.parse(String(state.nodes.find(node => node.nodeId === 'placement-filter')?.output));
    const validated = JSON.parse(String(state.nodes.find(node => node.nodeId === 'placement-validate')?.output));
    const compared = JSON.parse(String(state.nodes.find(node => node.nodeId === 'placement-compare')?.output));
    expect(filtered.result.candidates.map((candidate: { host: string }) => candidate.host)).not.toContain('aws1');
    expect(filtered.result.candidates.map((candidate: { host: string }) => candidate.host)).not.toContain('mbp');
    expect(filtered.result.candidates.map((candidate: { host: string }) => candidate.host)).not.toContain('node-c');
    expect(validated.result).toMatchObject({ host: expectedHost, workKind: snapshot.workKind, cloudAction: expectedAction });
    expect(compared.result).toMatchObject({ mode: 'shadow', proposedHost: expectedHost, cioHost: cio,
      agrees: expectedHost === cio, cloudAction: expectedAction });
    expect(state.nodes.map(node => node.nodeId)).toEqual(['placement-collect', 'placement-filter', 'placement-judge', 'placement-validate', 'placement-compare', 'done']);
    expect(pickHostCalls).toEqual([]);
    expect(shadowRows).toHaveLength(1);
    expect(shadowRows[0]).toMatchObject({ mode: 'shadow', kind: snapshot.workKind, host: expectedHost,
      cioHost: cio, cloudAction: expectedAction });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a model cannot select cloud ahead of an eligible green local host', async () => {
  const snapshot: PlacementSnapshot = { workKind: 'test', hosts: [host('node-b'), host('aws2')] };
  const root = mkdtempSync(join(tmpdir(), 'guardian-placement-cloud-priority-'));
  try {
    const state = await runGraph(placementGraph, { runId: 'placement-cloud-priority', input: { snapshot, cioHost: 'node-b' }, deps: {
      root, inProcessHandlers: createPlacementShadowGraphHandlers({ pickHostFallback: async () => 'node-b', recordShadow: async () => {} }),
      callLLM: async () => JSON.stringify({ host: 'aws2', workKind: 'test', reason: 'cloud seems convenient', confidence: 0.99, cloudAction: 'none' }),
    } });
    expectGraphDone(state);
    expect(JSON.parse(String(state.nodes.find(node => node.nodeId === 'placement-validate')?.output))).toMatchObject({
      result: { host: 'node-b', cloudAction: 'none' }, evidence: { fallbackUsed: true },
    });
    expect(JSON.parse(String(state.nodes.find(node => node.nodeId === 'placement-compare')?.output))).toMatchObject({
      result: { proposedHost: 'node-b', agrees: true, cloudAction: 'none' },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an invalid LLM JSON proposal uses pick-host fallback, then exposes the comparison from graph output', async () => {
  const snapshot: PlacementSnapshot = { workKind: 'test', hosts: [
    host('node-b', { maintenance: true }), host('minim5'), host('aws1', { gateProtected: true }), host('mbp'),
  ] };
  const root = mkdtempSync(join(tmpdir(), 'guardian-placement-shadow-invalid-'));
  const pickHostCalls: string[] = [];
  const shadowRows: unknown[] = [];
  try {
    const state = await runGraph(placementGraph, { runId: 'placement-invalid-json', input: { snapshot, cioHost: 'wait' }, deps: {
      root, inProcessHandlers: createPlacementShadowGraphHandlers({
        pickHostFallback: async kind => { pickHostCalls.push(kind); return 'minim5'; },
        recordShadow: async row => { shadowRows.push(row); },
      }),
      callLLM: async () => '{not-json',
    } });
    expectGraphDone(state);
    expect(pickHostCalls).toEqual(['test']);
    expect(shadowRows).toHaveLength(1);
    expect(JSON.parse(String(state.nodes.find(node => node.nodeId === 'placement-validate')?.output))).toMatchObject({
      result: { host: 'minim5', cloudAction: 'none', reason: 'invalid-model-decision; deterministic pick-host fallback' },
      evidence: { modelJsonValid: false, fallbackUsed: true },
    });
    expect(JSON.parse(String(state.nodes.find(node => node.nodeId === 'placement-compare')?.output))).toMatchObject({
      result: { proposedHost: 'minim5', cioHost: 'wait', agrees: false, cloudAction: 'none' },
      evidence: { phase: 'shadow-only', assignmentExecuted: false, cloudActionExecuted: false },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cloud stop proposal is rejected unless local count and every idle-cloud condition pass', async () => {
  const snapshot: PlacementSnapshot = { workKind: 'test', hosts: [
    host('node-b'), host('minim5'), host('aws2', { load15Pct: 5, cloudIdleMinutes: 10, tabCount: 1 }),
  ] };
  const root = mkdtempSync(join(tmpdir(), 'guardian-placement-cloud-stop-'));
  try {
    const state = await runGraph(placementGraph, { runId: 'placement-cloud-stop-invalid', input: { snapshot, cioHost: 'node-b' }, deps: {
      root, inProcessHandlers: createPlacementShadowGraphHandlers({ pickHostFallback: async () => undefined, recordShadow: async () => {} }),
      callLLM: async () => JSON.stringify({ host: 'node-b', workKind: 'test', reason: 'local first', confidence: 0.9, cloudAction: 'stop' }),
    } });
    expectGraphDone(state);
    expect(JSON.parse(String(state.nodes.find(node => node.nodeId === 'placement-validate')?.output))).toMatchObject({
      result: { host: 'node-b', cloudAction: 'none', reason: 'invalid-model-decision; deterministic pick-host fallback' },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('model provider failure follows the graph fallback and still records CIO comparison', async () => {
  const snapshot: PlacementSnapshot = { workKind: 'test', hosts: [host('node-b'), host('aws2')] };
  const root = mkdtempSync(join(tmpdir(), 'guardian-placement-provider-failure-'));
  const rows: unknown[] = [];
  try {
    const state = await runPlacementShadowGraph({ snapshot, cioHost: 'node-b' }, {
      graphPath: placementGraph, runId: 'placement-provider-failure', root,
      pickHost: async () => undefined, recordShadow: async row => { rows.push(row); },
      callLLM: async () => { throw new Error('simulated provider offline'); },
    });
    expectGraphDone(state);
    expect(state.nodes.map(node => node.nodeId)).toContain('placement-validate');
    expect(JSON.parse(String(state.nodes.find(node => node.nodeId === 'placement-validate')?.output))).toMatchObject({
      result: { host: 'node-b', cloudAction: 'none' }, evidence: { fallbackUsed: true },
    });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(state.nodes.find(node => node.nodeId === 'placement-compare')?.output))).toMatchObject({
      result: { proposedHost: 'node-b', cioHost: 'node-b', agrees: true },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a stopped cloud candidate cannot be recorded without start action', async () => {
  const snapshot: PlacementSnapshot = { workKind: 'test', hosts: [
    host('node-b', { load1Pct: 91, load15Pct: 92 }), host('minim5', { load1Pct: 91, load15Pct: 92 }),
    host('mshq', { load1Pct: 91, load15Pct: 92 }), host('aws2', { cloudRunning: false }),
  ] };
  const root = mkdtempSync(join(tmpdir(), 'guardian-placement-stopped-cloud-'));
  try {
    const state = await runGraph(placementGraph, { runId: 'placement-stopped-cloud', input: { snapshot, cioHost: 'wait' }, deps: {
      root, inProcessHandlers: createPlacementShadowGraphHandlers({ pickHostFallback: async () => 'aws2', recordShadow: async () => {} }),
      callLLM: async () => JSON.stringify({ host: 'aws2', workKind: 'test', reason: 'cloud available', confidence: 0.9, cloudAction: 'none' }),
    } });
    expectGraphDone(state);
    expect(JSON.parse(String(state.nodes.find(node => node.nodeId === 'placement-validate')?.output))).toMatchObject({
      result: { host: 'aws2', cloudAction: 'start' }, evidence: { fallbackUsed: true },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cloud host with unknown running state is excluded before model and fallback', async () => {
  const snapshot: PlacementSnapshot = { workKind: 'test', hosts: [
    host('node-b', { load1Pct: 91, load15Pct: 92 }), host('minim5', { load1Pct: 91, load15Pct: 92 }),
    host('mshq', { load1Pct: 91, load15Pct: 92 }), host('aws2', { cloudRunning: undefined }),
  ] };
  const root = mkdtempSync(join(tmpdir(), 'guardian-placement-cloud-state-unknown-'));
  try {
    const state = await runGraph(placementGraph, { runId: 'placement-cloud-state-unknown', input: { snapshot, cioHost: 'wait' }, deps: {
      root, inProcessHandlers: createPlacementShadowGraphHandlers({ pickHostFallback: async () => 'aws2', recordShadow: async () => {} }),
      callLLM: async prompt => {
        expect(prompt).not.toContain('"host":"aws2"');
        // Source: R-TST36; invalid model choice proves fallback output is revalidated.
        return JSON.stringify({ host: 'aws2', workKind: 'test', reason: 'cloud state unavailable', confidence: 0.9, cloudAction: 'none' });
      },
    } });
    expectGraphDone(state);
    expect(JSON.parse(String(state.nodes.find(node => node.nodeId === 'placement-filter')?.output))).toMatchObject({ result: { candidates: [] } });
    expect(JSON.parse(String(state.nodes.find(node => node.nodeId === 'placement-validate')?.output))).toMatchObject({ result: { host: 'wait', cloudAction: 'none' }, evidence: { fallbackUsed: true } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('yellow local candidate at its kind capacity is not eligible for one-more placement', async () => {
  const snapshot: PlacementSnapshot = { workKind: 'test', hosts: [
    host('node-b', { load1Pct: 50, load15Pct: 55, runningKinds: ['test'], runningByKind: { test: { running: 2, max: 2 } } }), // Source: R-TST36; saturated test fixture validates seat-state/OP/BRIEF-LOCAL-FIRST-PLACEMENT-1111.md.
    host('minim5', { load1Pct: 91, load15Pct: 92 }), host('mshq', { load1Pct: 91, load15Pct: 92 }),
  ] };
  const root = mkdtempSync(join(tmpdir(), 'guardian-placement-yellow-capacity-'));
  try {
    const state = await runGraph(placementGraph, { runId: 'placement-yellow-capacity', input: { snapshot, cioHost: 'wait' }, deps: {
      root, inProcessHandlers: createPlacementShadowGraphHandlers({ pickHostFallback: async () => 'node-b', recordShadow: async () => {} }),
      callLLM: async prompt => {
        expect(prompt).not.toContain('"host":"node-b"');
        return JSON.stringify({ host: 'node-b', workKind: 'test', reason: 'reuse', confidence: 0.9, cloudAction: 'none' });
      },
    } });
    expectGraphDone(state);
    expect(JSON.parse(String(state.nodes.find(node => node.nodeId === 'placement-filter')?.output))).toMatchObject({ result: { candidates: [] } });
    expect(JSON.parse(String(state.nodes.find(node => node.nodeId === 'placement-validate')?.output))).toMatchObject({ result: { host: 'wait' } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hosts with missing or wrongly typed required facts are excluded before model invocation', async () => {
  const rawSnapshot = { workKind: 'test', hosts: [
    { ...host('node-b', { load1Pct: 91, load15Pct: 92 }), maintenance: undefined }, // Source: R-TST36; malformed JSON simulation omits a required maintenance fact.
    { ...host('minim5', { load1Pct: 91, load15Pct: 92 }), ssh: 'false' }, // Source: R-TST36; malformed JSON simulation uses a string instead of an SSH boolean.
    host('mshq', { load1Pct: 91, load15Pct: 92 }),
  ] };
  const snapshot = JSON.parse(JSON.stringify(rawSnapshot)) as PlacementSnapshot;
  const root = mkdtempSync(join(tmpdir(), 'guardian-placement-invalid-host-facts-'));
  try {
    const state = await runGraph(placementGraph, { runId: 'placement-invalid-host-facts', input: { snapshot, cioHost: 'wait' }, deps: {
      root, inProcessHandlers: createPlacementShadowGraphHandlers({ pickHostFallback: async () => undefined, recordShadow: async () => {} }),
      callLLM: async prompt => {
        expect(prompt).not.toContain('"host":"node-b"');
        expect(prompt).not.toContain('"host":"minim5"');
        return JSON.stringify({ host: 'wait', workKind: 'test', reason: 'no host facts verified', confidence: 0.9, cloudAction: 'none' });
      },
    } });
    expectGraphDone(state);
    expect(JSON.parse(String(state.nodes.find(node => node.nodeId === 'placement-filter')?.output))).toMatchObject({ result: { candidates: [] } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cloud stop requires verified idle cloud facts and two distinct eligible local hosts', async () => {
  const snapshot = JSON.parse(JSON.stringify({ workKind: 'test', hosts: [
    host('node-b'), host('node-b'), host('minim5'), host('aws2', { load15Pct: 5, cloudIdleMinutes: 10, cloudRunning: true }), null, // Source: R-TST36; synthetic duplicate local rows and idle cloud facts test distinct-host stop requirements.
  ] })) as PlacementSnapshot;
  const root = mkdtempSync(join(tmpdir(), 'guardian-placement-cloud-stop-duplicates-'));
  try {
    const state = await runGraph(placementGraph, { runId: 'placement-cloud-stop-duplicates', input: { snapshot, cioHost: 'minim5' }, deps: {
      root, inProcessHandlers: createPlacementShadowGraphHandlers({ pickHostFallback: async () => 'minim5', recordShadow: async () => {} }),
      callLLM: async () => JSON.stringify({ host: 'minim5', workKind: 'test', reason: 'one verified local host', confidence: 0.9, cloudAction: 'stop' }),
    } });
    expectGraphDone(state);
    expect(JSON.parse(String(state.nodes.find(node => node.nodeId === 'placement-validate')?.output))).toMatchObject({
      result: { host: 'minim5', cloudAction: 'none' }, evidence: { fallbackUsed: true },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('JSONL recorder appends one row and surfaces write failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guardian-placement-ledger-'));
  const path = join(root, 'nested', 'placement.jsonl');
  const row = { at: '2026-11-11T00:00:00.000Z', kind: 'test' as const, host: 'minim5', reason: 'green local', confidence: 1, // Source: fixed deterministic timestamp and probability for isolated JSONL recorder verification.
    mode: 'shadow' as const, cioHost: 'minim5', agrees: true, cloudAction: 'none' as const };
  try {
    await createPlacementJsonlRecorder(path)(row);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(row);
    await expect(createPlacementJsonlRecorder(root)(row)).rejects.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
