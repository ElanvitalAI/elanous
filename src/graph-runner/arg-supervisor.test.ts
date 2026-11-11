import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { runGraph } from './runner.js';
import { runArgSupervisorTick, type ArgMutationState, type ArgOperation, type ArgSupervisorPorts } from './arg-supervisor.js';
import { claimIncident, createMemoryIncidentClaimStore, type IncidentClaim, type IncidentClaimStore } from '../supervision/incident-claim.js';

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
    { ref: 'loop:rla@1', role: 'primary', scope: 'run', authority: ['reroute', 'add-node', 'repair', 'hitl',
      'skip-node', 'gate-waiver', 'regression-response', 'emergency-release'], requires: ['elanous.dev/arg'] },
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
    const claimDirectory = join(root, 'supervision', 'incident-claims');
    const claim = JSON.parse(readFileSync(join(claimDirectory,
      readdirSync(claimDirectory).find((entry) => entry.endsWith('.json'))!), 'utf8'));
    expect(claim).toMatchObject({ incidentId: `release-loop:${failed.runId}:gate-failed`, ownerLoopRef: 'loop:rla@1' });
    expect(mutable.graphRevision).toBe(1);
    expect(mutable.adaptiveGraphEdges).toEqual([]);
    expect(ledger(root).find(item => item.verb === 'apply').graphRevision).toBe(2);
    expect(ledger(root).find(item => item.verb === 'rollback').beforeRevision).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RLA simulation refuses supervisor effects while another configured owner holds the claim', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-arg-claim-denied-'));
  const store = createMemoryIncidentClaimStore();
  const ownerOrder = ['loop:macrophage@1', 'loop:rla@1'] as const;
  const incidentId = 'release-loop:target:gate-failed';
  const effects: string[] = [];
  try {
    expect((await claimIncident(store, { incidentId, ownerLoopRef: ownerOrder[0], ownerOrder,
      now: () => 10_000, leaseMs: 1_000 })).disposition).toBe('claimed');
    await expect(tick(root, state(), {
      incidentClaim: { store, ownerOrder, now: () => 10_001, leaseMs: 1_000 },
      ports: ports({ observe: () => { effects.push('observe'); return ok(); },
        propose: () => { effects.push('propose'); return { ...ok(), effect: retry }; } }),
    })).rejects.toThrow('RLA incident claim denied: another owner holds the active incident lease');
    expect(effects).toEqual([]);
    expect(existsSync(join(root, 'graph-supervisors', 'actions.jsonl'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RLA rollback snapshot is captured after waiting for the incident claim', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-arg-claim-snapshot-lock-'));
  let markClaimWaitStarted!: () => void;
  let releaseClaimWait!: () => void;
  const claimWaitStarted = new Promise<void>((resolve) => { markClaimWaitStarted = resolve; });
  const claimWait = new Promise<void>((resolve) => { releaseClaimWait = resolve; });
  let storedClaim: IncidentClaim | null = null;
  const store: IncidentClaimStore = {
    async transact(_incidentId, update) {
      markClaimWaitStarted();
      await claimWait;
      const transition = update(storedClaim);
      storedClaim = transition.next;
      return transition.result;
    },
    async withCurrent(input, action) {
      if (!storedClaim || storedClaim.claimToken !== input.claimToken || storedClaim.expiresAtMs <= input.now())
        return { current: false };
      return { current: true, value: await action() };
    },
  };
  const mutable = state();
  try {
    const running = tick(root, mutable, { incidentClaim: { store, now: () => 10_000, leaseMs: 1_000 },
      ports: ports({ verify: () => ({ outcome: 'fail', evidence: 'force rollback if stale snapshot is used' }) }) });
    await claimWaitStarted;
    mutable.graphRevision = 2;
    mutable.adaptiveGraphEdges = [{ from: 'external', to: 'commit', triggerEvent: 'prior.owner.done', rationale: 'successor base',
      eventId: 'prior-event', subscriberId: 'prior-owner' }];
    releaseClaimWait();
    await expect(running).rejects.toThrow('ARG initial revision differs from mutable state');
    expect(mutable.graphRevision).toBe(2);
    expect(mutable.adaptiveGraphEdges).toEqual([expect.objectContaining({ from: 'external', to: 'commit' })]);
  } finally {
    releaseClaimWait();
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent RLA ticks for one incident admit one live execution only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-arg-claim-concurrent-'));
  let markObserveStarted!: () => void;
  let releaseObserve!: () => void;
  const observeStarted = new Promise<void>((resolve) => { markObserveStarted = resolve; });
  const blockedObserve = new Promise<void>((resolve) => { releaseObserve = resolve; });
  let observations = 0;
  let secondSettled = false;
  try {
    const first = tick(root, state(), { ports: ports({ observe: async () => {
      observations += 1;
      markObserveStarted();
      await blockedObserve;
      return ok();
    } }) });
    await observeStarted;
    const second = tick(root, state()).finally(() => { secondSettled = true; });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    releaseObserve();
    await first;
    await expect(second).rejects.toThrow('incident claim denied: incident already completed');
    expect(observations).toBe(1);
  } finally {
    releaseObserve();
    rmSync(root, { recursive: true, force: true });
  }
});

test('RLA serializes a port across lease expiry so a successor cannot overlap the live action', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-arg-claim-expired-'));
  const store = createMemoryIncidentClaimStore();
  const ownerOrder = ['loop:rla@1', 'loop:macrophage@1'] as const;
  let nowMs = 10_000;
  let markObserveStarted!: () => void;
  let releaseObserve!: () => void;
  const observeStarted = new Promise<void>((resolve) => { markObserveStarted = resolve; });
  const blockedObserve = new Promise<void>((resolve) => { releaseObserve = resolve; });
  let proposals = 0;
  let persists = 0;
  const mutable = state();
  try {
    const running = tick(root, mutable, { incidentClaim: { store, ownerOrder, now: () => nowMs, leaseMs: 1_000 },
      ports: ports({ observe: async () => { markObserveStarted(); await blockedObserve; return ok(); },
        propose: () => { proposals += 1; return { ...ok(), effect: retry }; },
        persist: () => { persists += 1; } }) });
    await observeStarted;
    nowMs = 11_000;
    let successorSettled = false;
    const successorPromise = claimIncident(store, { incidentId: 'release-loop:target:gate-failed',
      ownerLoopRef: ownerOrder[1], ownerOrder, now: () => nowMs, leaseMs: 1_000 });
    void successorPromise.then(() => { successorSettled = true; });
    await Promise.resolve();
    expect(successorSettled).toBe(false);
    releaseObserve();
    const completed = await running;
    expect(completed.graphRun.path.at(-1)).toBe('done');
    const successor = await successorPromise;
    expect(successor).toMatchObject({ disposition: 'denied', reason: 'incident already completed' });
    expect(proposals).toBe(1);
    expect(persists).toBe(1);
    expect(mutable.graphRevision).toBe(2);
    expect(mutable.adaptiveGraphEdges).toHaveLength(1);
  } finally {
    releaseObserve();
    rmSync(root, { recursive: true, force: true });
  }
});

test('RLA keeps apply, verification and rollback together when persistence crosses lease expiry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-arg-claim-persist-expired-'));
  const store = createMemoryIncidentClaimStore();
  const ownerOrder = ['loop:rla@1', 'loop:macrophage@1'] as const;
  let nowMs = 10_000;
  let markPersistStarted!: () => void;
  let releasePersist!: () => void;
  const persistStarted = new Promise<void>((resolve) => { markPersistStarted = resolve; });
  const blockedPersist = new Promise<void>((resolve) => { releasePersist = resolve; });
  let persistCalls = 0;
  let verifyCalls = 0;
  const mutable = state();
  try {
    const running = tick(root, mutable, { incidentClaim: { store, ownerOrder, now: () => nowMs, leaseMs: 1_000 },
      ports: ports({ verify: () => { verifyCalls += 1; return { outcome: 'fail', evidence: 'verification failed' }; },
        persist: async () => { persistCalls += 1; if (persistCalls === 1) { markPersistStarted(); await blockedPersist; } } }) });
    await persistStarted;
    nowMs = 11_000;
    let successorSettled = false;
    const successorPromise = claimIncident(store, { incidentId: 'release-loop:target:gate-failed',
      ownerLoopRef: ownerOrder[1], ownerOrder, now: () => nowMs, leaseMs: 1_000 });
    void successorPromise.then(() => { successorSettled = true; });
    await Promise.resolve();
    expect(successorSettled).toBe(false);
    releasePersist();
    const rolledBack = await running;
    expect(rolledBack.graphRun.path).toContain('rollback');
    expect(verifyCalls).toBe(1);
    expect(persistCalls).toBe(2);
    expect(mutable.graphRevision).toBe(1);
    expect(mutable.adaptiveGraphEdges).toEqual([]);
    expect((await successorPromise).disposition).toBe('escalated');
  } finally {
    releasePersist();
    rmSync(root, { recursive: true, force: true });
  }
});

test('RLA serializes durable feedback with an expiring incident claim', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rla-arg-claim-feedback-expired-'));
  const store = createMemoryIncidentClaimStore();
  const ownerOrder = ['loop:rla@1', 'loop:macrophage@1'] as const;
  let nowMs = 10_000;
  let markRecordStarted!: () => void;
  let releaseRecord!: () => void;
  const recordStarted = new Promise<void>((resolve) => { markRecordStarted = resolve; });
  const blockedRecord = new Promise<void>((resolve) => { releaseRecord = resolve; });
  let recordCalls = 0;
  try {
    const running = tick(root, state(), { incidentClaim: { store, ownerOrder, now: () => nowMs, leaseMs: 1_000 },
      feedback: { ledger: { templateCandidates: () => [], activePack: () => [], record: async () => {
        recordCalls += 1; markRecordStarted(); await blockedRecord;
      } }, signature: { nodeId: 'gate', testName: 'smoke', errorSignature: 'gate-failed' },
      readCommitted: () => 'absent' } });
    await recordStarted;
    nowMs = 11_000;
    let successorSettled = false;
    const successorPromise = claimIncident(store, { incidentId: 'release-loop:target:gate-failed',
      ownerLoopRef: ownerOrder[1], ownerOrder, now: () => nowMs, leaseMs: 1_000 });
    void successorPromise.then(() => { successorSettled = true; });
    await Promise.resolve();
    expect(successorSettled).toBe(false);
    releaseRecord();
    const verified = await running;
    expect(verified.graphRun.path.at(-1)).toBe('done');
    expect(recordCalls).toBe(1);
    expect(await successorPromise).toMatchObject({ disposition: 'denied', reason: 'incident already completed' });
  } finally {
    releaseRecord();
    rmSync(root, { recursive: true, force: true });
  }
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
      writeFileSync(targetPath, source.replace('scope: run, authority: [reroute, add-node, repair, hitl, skip-node, gate-waiver, regression-response, emergency-release]', replacement));
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

test.each(['skip-node', 'gate-waiver', 'regression-response', 'emergency-release'] as const)(
  '%s requires both declarations and cannot execute a legacy retry effect', async (operation: ArgOperation) => {
    const root = mkdtempSync(join(tmpdir(), 'rla-full-verb-authority-'));
    const cardPath = join(root, 'loop.yaml');
    const targetPath = join(root, 'release-loop.yaml');
    const supervisorPath = join(root, 'supervisor.yaml');
    const recipesPath = join(root, 'recipes.yaml');
    const legacy = 'reroute, add-node, repair, hitl';
    const expanded = 'reroute, add-node, repair, hitl, skip-node, gate-waiver, regression-response, emergency-release';
    const card = readFileSync(loopPath, 'utf8').replace('../release-loop.yaml', './release-loop.yaml')
      .replace('../release-edge-vocabulary.yaml', resolve(import.meta.dir, '../../graphs/release/release-edge-vocabulary.yaml'))
      .replace('../macrophage-subscriber.yaml', resolve(import.meta.dir, '../../graphs/release/macrophage-subscriber.yaml'))
      .replace(expanded, legacy);
    const graph = readFileSync(releasePath, 'utf8').replace(expanded, legacy);
    try {
      writeFileSync(cardPath, card);
      writeFileSync(targetPath, graph);
      writeFileSync(supervisorPath, readFileSync(resolve(import.meta.dir, '../../graphs/release/rla/supervisor.yaml'), 'utf8'));
      writeFileSync(recipesPath, readFileSync(resolve(import.meta.dir, '../../graphs/release/rla/recipes.yaml'), 'utf8'));
      await expect(tick(root, state(), { loopPath: cardPath, operation })).rejects.toThrow('no matching ARG supervisor declaration');
      writeFileSync(cardPath, card.replace(legacy, expanded));
      await expect(tick(root, state(), { loopPath: cardPath, operation })).rejects.toThrow('no matching ARG supervisor declaration');
      writeFileSync(targetPath, graph.replace(legacy, expanded));
      const mutable = state();
      const result = await tick(root, mutable, { loopPath: cardPath, operation });
      expect(result.graphRun.path).toEqual(['observe', 'propose', 'failed']);
      expect(mutable).toEqual(state());
      expect(ledger(root).at(-1)).toMatchObject({ verb: 'propose', outcome: 'fail',
        evidence: 'proposed effect is outside granted ARG authority' });
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
