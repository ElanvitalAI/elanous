import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { runGraph } from './runner.js';
import { runArgSupervisorTick, type ArgMutationState, type ArgSupervisorPorts } from './arg-supervisor.js';

const releasePath = resolve(import.meta.dir, '../../graphs/release/release-loop.yaml');
const loopPath = resolve(import.meta.dir, '../../graphs/release/rla/loop.yaml');
const retry = { kind: 'retry-edge' as const, from: 'gate-triage', to: 'gate',
  triggerEvent: 'release.gate.failed', rationale: 'same-run Pod retry' };
const ok = () => ({ outcome: 'ok' as const, evidence: 'simulated' });
const state = (): ArgMutationState => ({ graphRevision: 1, adaptiveGraphEdges: [], adaptiveGraphVocabulary: [] }); // Source: RLA-SUPERVISOR-ARG-GRAPH initial revision contract.
const ports = (override: Partial<ArgSupervisorPorts> = {}): ArgSupervisorPorts => ({
  observe: ok, propose: () => ({ ...ok(), effect: retry }), validate: ok, verify: ok, ...override,
});
const tick = (root: string, mutableState: ArgMutationState, overrides: Partial<Parameters<typeof runArgSupervisorTick>[0]> = {}) =>
  runArgSupervisorTick({ loopPath, root, targetGraphId: 'release-loop', targetRunId: 'target',
    gateEventId: 'gate-failed', graphRevision: 1, operation: 'reroute', mutableState, ports: ports(), ...overrides }); // Source: RLA-SUPERVISOR-ARG-GRAPH initial revision contract.
const ledger = (root: string) => readFileSync(join(root, 'graph-supervisors/actions.jsonl'), 'utf8')
  .trim().split('\n').map(line => JSON.parse(line));

 test('release supervisors parse and reject duplicate primary or undeclared authority', () => {
  const source = readFileSync(releasePath, 'utf8');
  const parsed = parseGraphTemplateYaml(source, releasePath);
  expect(parsed.errors).toEqual([]);
  expect(parsed.template?.supervisors).toEqual([
    { ref: 'loop:rla@1', role: 'primary', scope: 'run', authority: ['reroute', 'add-node', 'repair', 'hitl'], requires: ['elanous.dev/arg'] },
    { ref: 'loop:macrophage@1', role: 'healer', scope: 'run', authority: ['cleanup'], requires: [] },
  ]);
  expect(parseGraphTemplateYaml(source.replace('role: healer', 'role: primary')).errors.some(issue => issue.path.endsWith('/supervisors'))).toBe(true);
  expect(parseGraphTemplateYaml(source.replace('authority: [cleanup]', 'authority: [publish]')).errors.some(issue => issue.path.endsWith('/authority'))).toBe(true);
});

test('a failed gate triggers an ARG retry edge and failed verification restores the prior graph', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-arg-sim-'));
  const path = join(root, 'release.yaml');
  const source = `graph_id: release-sim\nversion: 1\nentry_node: gate\nterminal_nodes: [done, failed]\nnodes:\n` +
    `  - { node_id: gate, kind: gate, recipe: 'cmd:gate', max_visits: 1 }\n` +
    `  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n` +
    `  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\n` +
    `edges:\n  - { from: gate, on: outcome, map: { ok: done, fail: failed } }\n`;
  try {
    writeFileSync(path, source);
    writeFileSync(join(root, 'recipes.yaml'), 'gate: { command: "sim:gate" }\n');
    const failed = await runGraph(path, { deps: { root, runBash: async () =>
      ({ exitCode: 0, stdout: '{"outcome":"fail"}', stderr: '' }) }, quiet: true });
    expect(failed.path).toEqual(['gate', 'failed']);
    const mutable = state();
    const result = await tick(root, mutable, { targetRunId: failed.runId,
      ports: ports({ observe: () => ({ outcome: failed.status === 'failed' ? 'ok' : 'fail', evidence: 'gate failed' }),
        verify: () => ({ outcome: 'fail', evidence: 'retry gate still red' }) }) });
    expect(result.graphRun.path).toEqual(['observe', 'propose', 'validate', 'apply', 'verify', 'rollback', 'failed']);
    expect(mutable.graphRevision).toBe(1);
    expect(mutable.adaptiveGraphEdges).toEqual([]);
    expect(ledger(root).find(item => item.verb === 'apply').graphRevision).toBe(2);
    expect(ledger(root).find(item => item.verb === 'rollback').beforeRevision).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('supervisor itself applies the exact retry effect without an injected apply callback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-arg-direct-'));
  try {
    const mutable = state();
    const result = await tick(root, mutable);
    expect(result.graphRun.path).toEqual(['observe', 'propose', 'validate', 'apply', 'verify', 'done']);
    expect(mutable.graphRevision).toBe(2);
    expect(mutable.adaptiveGraphEdges).toEqual([expect.objectContaining({ from: retry.from, to: retry.to,
      triggerEvent: retry.triggerEvent, eventId: 'gate-failed', subscriberId: 'loop:rla@1' })]);
    expect(mutable.adaptiveGraphVocabulary).toContain(retry.triggerEvent);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('MRTR approval stops before any high-risk effect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-arg-hitl-'));
  try {
    const mutable = state();
    const result = await tick(root, mutable, { operation: 'hitl', ports: ports({
      propose: () => ({ ...ok(), effect: { kind: 'hitl', decisionId: 'owner-approval' } }),
      validate: () => ({ outcome: 'input_required', evidence: 'owner approval needed' }) }) });
    expect(result.resultType).toBe('input_required');
    expect(result.inputRequests?.[0]?.kind).toBe('approval');
    expect(mutable.graphRevision).toBe(1);
    expect(mutable.adaptiveGraphEdges).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('validated high-risk apply preserves its MRTR approval request without mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-arg-apply-hitl-'));
  try {
    const mutable = state();
    const result = await tick(root, mutable, { operation: 'add-node', ports: ports({
      propose: () => ({ ...ok(), effect: { kind: 'node', nodeId: 'new-check' } }),
    }) });
    expect(result.resultType).toBe('input_required');
    expect(result.graphRun.path.at(-1)).toBe('needs-human');
    expect(mutable.graphRevision).toBe(1);
    expect(ledger(root).find(item => item.verb === 'apply').outcome).toBe('input_required');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scope and authority in the target graph deny an unauthorized operation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-arg-authority-'));
  const cardPath = join(root, 'loop.yaml');
  const targetPath = join(root, 'release-loop.yaml');
  const card = readFileSync(loopPath, 'utf8').replace('../release-loop.yaml', './release-loop.yaml')
    .replace('../release-edge-vocabulary.yaml', resolve(import.meta.dir, '../../graphs/release/release-edge-vocabulary.yaml'))
    .replace('../macrophage-subscriber.yaml', resolve(import.meta.dir, '../../graphs/release/macrophage-subscriber.yaml'));
  try {
    writeFileSync(cardPath, card);
    const source = readFileSync(releasePath, 'utf8');
    for (const replacement of ['scope: template, authority: [hitl]', 'scope: run, authority: [hitl]']) {
      writeFileSync(targetPath, source.replace('scope: run, authority: [reroute, add-node, repair, hitl]', replacement));
      await expect(tick(root, state(), { loopPath: cardPath })).rejects.toThrow('no matching ARG supervisor declaration');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a hitl grant cannot apply a retry edge by mislabeling the requested operation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-arg-effect-'));
  try {
    const mutable = state();
    const result = await tick(root, mutable, { operation: 'hitl' });
    expect(result.graphRun.path).toEqual(['observe', 'propose', 'failed']);
    expect(mutable.adaptiveGraphEdges).toEqual([]);
    expect(mutable.graphRevision).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each(['observe', 'propose', 'validate'] as const)('%s failure without mutation never rolls back', async failedVerb => {
  const root = mkdtempSync(join(tmpdir(), 'rla-arg-preapply-'));
  try {
    const mutable = state();
    const result = await tick(root, mutable, { ports: ports({ [failedVerb]: () => ({ outcome: 'fail', evidence: 'no mutation' }) }) });
    expect(result.graphRun.path.at(-1)).toBe('failed');
    expect(result.graphRun.path).not.toContain('rollback');
    expect(mutable.graphRevision).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each(['observe', 'propose', 'validate', 'verify'] as const)('%s mutation is detected and rolled back', async changedVerb => {
  const root = mkdtempSync(join(tmpdir(), 'rla-arg-partial-'));
  try {
    const mutable = state();
    const result = await tick(root, mutable, { ports: ports({ [changedVerb]: () => {
      mutable.graphRevision = changedVerb === 'verify' ? 3 : 2; // Source: RLA-SUPERVISOR-ARG-GRAPH partial mutation simulation.
      return { outcome: 'fail', evidence: 'partial mutation' };
    } }) });
    expect(result.graphRun.path.at(-2)).toBe('rollback');
    expect(mutable.graphRevision).toBe(1);
    expect(ledger(root).find(item => item.verb === 'rollback').beforeRevision).toBe(changedVerb === 'verify' ? 3 : 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('apply persistence failure after mutation records actual revision and rolls back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-arg-persist-'));
  try {
    const mutable = state();
    let writes = 0;
    const result = await tick(root, mutable, { ports: ports({ persist: () => {
      writes++;
      if (writes === 1) throw new Error('commit recorded before response'); // Source: RLA-SUPERVISOR-ARG-GRAPH first persist simulation.
    } }) });
    expect(result.graphRun.path).toEqual(['observe', 'propose', 'validate', 'apply', 'rollback', 'failed']);
    expect(ledger(root).find(item => item.verb === 'apply').graphRevision).toBe(2);
    expect(ledger(root).find(item => item.verb === 'rollback').beforeRevision).toBe(2);
    expect(mutable.graphRevision).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed rollback persistence never reports the in-memory revision as durable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-arg-rollback-persist-'));
  try {
    const mutable = state();
    let writes = 0;
    await expect(tick(root, mutable, { ports: ports({
      verify: () => ({ outcome: 'fail', evidence: 'retry still red' }),
      persist: () => { if (++writes === 2) throw new Error('disk unavailable'); },
    }) })).rejects.toThrow('durable graphRevision is unknown');
    const rollback = ledger(root).find(item => item.verb === 'rollback');
    expect(rollback.beforeRevision).toBe(2);
    expect(rollback.graphRevision).toBeNull();
    expect(rollback.durability).toBe('unknown');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ledger failure after apply restores the effect before failing the tick', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-arg-ledger-fail-'));
  try {
    const mutable = state();
    const file = join(root, 'graph-supervisors/actions.jsonl');
    let writes = 0;
    await expect(tick(root, mutable, { ports: ports({ persist: () => {
      if (++writes === 1) { rmSync(file); mkdirSync(file); }
    } }) })).rejects.toThrow('ARG ledger write failed; graph restored');
    expect(mutable.graphRevision).toBe(1);
    expect(mutable.adaptiveGraphEdges).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('duplicate retry effect fails without mutation or rollback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-arg-duplicate-'));
  try {
    const mutable = state();
    mutable.adaptiveGraphEdges = [{ from: retry.from, to: retry.to, triggerEvent: retry.triggerEvent,
      rationale: retry.rationale, eventId: 'gate-failed', subscriberId: 'loop:rla@1' }];
    const result = await tick(root, mutable);
    expect(result.graphRun.path).toEqual(['observe', 'propose', 'validate', 'apply', 'failed']);
    expect(mutable.graphRevision).toBe(1);
    expect(result.graphRun.path).not.toContain('rollback');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
