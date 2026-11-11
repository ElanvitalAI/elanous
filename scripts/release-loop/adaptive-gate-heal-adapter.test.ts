import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createGraphEventBus, type GraphEventBus } from '../../src/graph-runner/graph-events.js';
import { runGraph, type GraphRunOptions } from '../../src/graph-runner/runner.js';
import { argCandidateDirectory } from '../../src/graph-runner/arg-open-proposal.js';
import type { GateResult } from './gate-types.js';
import { parseOptions } from './gate-node.js';
import { registerAdaptiveGateHealAdapter, RELEASE_GATE_FAILED_EVENT, type AdaptiveGateHealAppendNodeRequest } from './adaptive-gate-heal-adapter.js';
import { classifyGateShadow } from './gate-triage-node.js';
import { readGraphContext } from './node-verdict.js';
import { runGateFileReceiptAuditNode } from './gate-file-receipt-audit-node.js';
import { gateFileReceiptIdentityFromClosure, gateFileReceiptKey, type GateFileReceipt } from './gate-file-receipts.js';
import { runGateImageRepairNode } from './gate-image-repair-node.js';
import { gateImagePinPath } from './gate-image-pin.js';
import { syncPoolImages } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import type { GateRunner } from './gate-node.js';
import { writeReleaseGraphFixture } from '../../test/helpers/release-graph-fixture.js';

const gateFailure = (): GateResult => ({ outcome: 'regression', commit: 'a'.repeat(40),
  introduced: ['src/release.test.ts > introduced failure'], preexisting: 0, fixed: null, knownEnv: 0,
  knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 10 });

function gateFailedEvent(runId: string, gate: GateResult, withVisits = true) {
  return { graphId: 'release-loop', runId, type: RELEASE_GATE_FAILED_EVENT,
    source: { kind: 'node' as const, nodeId: 'gate-triage' },
    data: { version: '0.3.6', gate, triage: classifyGateShadow(gate), gateExecutor: 'pod',
      ...(withVisits ? { visitState: { gate: 1, gateTriage: 1 } } : {}) } };
}

test('RLA-ARG-ADAPTIVE-HEAL sim: gate.failed plan sends dynamic appendNode and resume requests', async () => {
  const world = parseYaml(readFileSync(join(import.meta.dir, '../../scenarios/ux-sim/release-incident-events.yaml'), 'utf8')) as {
    cases: Array<{ id: string; fault: { event: string }; expect: { events: Array<Record<string, string>> } }>;
  };
  const scenario = world.cases.find(({ id }) => id === 'subscription-gate-failure-appends-arg-repair')!;
  const bus = createGraphEventBus();
  const trace: Array<Record<string, string>> = [];
  const requests: AdaptiveGateHealAppendNodeRequest[] = [];
  let planAction = '';
  bus.subscribe((event) => {
    if (event.type === scenario.fault.event) trace.push({ event: 'subscription-delivered', subscriber: 'arg-adaptive-heal', source: event.type });
  });
  const dispose = registerAdaptiveGateHealAdapter(bus, { graphId: 'release-loop', runId: 'sim-arg-append' }, {
    onPlan: (plan) => {
      planAction = plan.disposition.action;
      trace.push({ event: 'arg-plan', action: plan.disposition.action });
    },
    appendNode: async (request) => {
      // This stub is the pending GRAPH-OPS append boundary; it records the request, not a durable append or execution.
      requests.push(request);
      trace.push({ event: 'appendNode-request', nodeId: request.node.nodeId, after: request.afterNodeId });
      trace.push({ event: 'resume-request', from: request.resumeFrom, then: request.rerunGateAt });
      return { disposition: 'appended', graphRevision: 2 };
    },
  });
  try {
    await bus.publish({ ...gateFailedEvent('sim-arg-append', gateFailure()), eventId: 'sim-arg-event-1', sequence: 1,
      emittedAt: '2026-11-06T00:00:00.000Z' });
    expect(planAction).toBe('append-repair-and-resume');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ graphId: 'release-loop', runId: 'sim-arg-append', eventId: 'sim-arg-event-1',
      afterNodeId: 'gate-triage', node: { nodeId: expect.stringMatching(/^gate-repair-[a-f0-9]{12}$/), maxVisits: 1 },
      resumeFrom: expect.stringMatching(/^gate-repair-[a-f0-9]{12}$/), rerunGateAt: 'gate',
      visitState: { gate: 1, gateTriage: 1 }, visitLimits: { gate: 2, gateTriage: 2 }, maxRepairRetries: 1 });
    expect(trace).toEqual(scenario.expect.events);
  } finally { dispose(); }
});

test('RLA-ARG-ADAPTIVE-HEAL normalizes the graph gate fail alias and preserves its source outcome', async () => {
  const bus = createGraphEventBus();
  const gate = { ...gateFailure(), outcome: 'fail' } as unknown as GateResult;
  let planEvents: Array<{ name: string; data: Record<string, unknown> }> = [];
  const dispose = registerAdaptiveGateHealAdapter(bus, { graphId: 'release-loop', runId: 'fail-alias' }, {
    onPlan: (plan) => { planEvents = plan.events; },
    appendNode: async () => ({ disposition: 'appended', graphRevision: 2 }),
  });
  try {
    await bus.publish(gateFailedEvent('fail-alias', gate));
    expect(planEvents[0]).toMatchObject({ name: 'gate.result.received', data: { outcome: 'fail' } });
    expect(planEvents[1]).toMatchObject({ name: 'gate.failures.attributed', data: { failureIds: gate.introduced } });
  } finally { dispose(); }
});

test('RLA-ARG-ADAPTIVE-HEAL sim: unknown visits fail closed and do not append or resume', async () => {
  const bus = createGraphEventBus();
  let appendCalls = 0;
  let action = '';
  const dispose = registerAdaptiveGateHealAdapter(bus, { graphId: 'release-loop', runId: 'unknown-visits' }, {
    onPlan: (plan) => { action = plan.disposition.action; },
    appendNode: async () => { appendCalls++; return { disposition: 'appended', graphRevision: 2 }; },
  });
  try {
    await bus.publish({ ...gateFailedEvent('unknown-visits', gateFailure(), false) });
    expect(action).toBe('decision-required');
    expect(appendCalls).toBe(0);
  } finally { dispose(); }
});

test('RLA-ALL-LIVE: rejected macrophage ladder remains decision-required in the event adapter', async () => {
  const bus = createGraphEventBus();
  const actions: string[] = [];
  let appendCalls = 0;
  const dispose = registerAdaptiveGateHealAdapter(bus, { graphId: 'release-loop', runId: 'macro-rejected' }, {
    onPlan: (plan) => { actions.push(plan.disposition.action); },
    appendNode: async () => { appendCalls++; return { disposition: 'appended', graphRevision: 2 }; },
  });
  const failure = gateFailure();
  try {
    for (const macrophageRepairLadder of [null, { runId: 'other-run', failureIds: failure.introduced, evidence: 'introduced' }]) {
      const event = gateFailedEvent('macro-rejected', failure);
      await bus.publish({ ...event, data: { ...event.data, macrophageRepairLadder } });
    }
    expect(actions).toEqual(['decision-required', 'decision-required']);
    expect(appendCalls).toBe(0);
  } finally { dispose(); }
});

test('RLA-ARG-ADAPTIVE-HEAL sim: append persistence failure rejects the bus delivery and cannot schedule a retry', async () => {
  const bus = createGraphEventBus();
  let appendCalls = 0;
  const dispose = registerAdaptiveGateHealAdapter(bus, { graphId: 'release-loop', runId: 'append-error' }, {
    appendNode: async () => { appendCalls++; throw new Error('append persistence unavailable'); },
  });
  try {
    await expect(bus.publish(gateFailedEvent('append-error', gateFailure()))).rejects.toThrow('delivery failed');
    expect(appendCalls).toBe(1);
  } finally { dispose(); }
});

test('RLA-ARG-ADAPTIVE-HEAL sim: adapter ignores foreign-run and dry-run gate.failed events', async () => {
  const bus = createGraphEventBus();
  let appendCalls = 0;
  const dispose = registerAdaptiveGateHealAdapter(bus, { graphId: 'release-loop', runId: 'scoped' }, {
    appendNode: async () => { appendCalls++; return { disposition: 'appended', graphRevision: 2 }; },
  });
  try {
    await bus.publish(gateFailedEvent('foreign', gateFailure()));
    const dryRun = gateFailedEvent('scoped', gateFailure());
    await bus.publish({ ...dryRun, data: { ...dryRun.data, dryRun: true } });
    await bus.publish({ ...gateFailedEvent('scoped', gateFailure()), source: { kind: 'runner' as const } });
    expect(appendCalls).toBe(0);
  } finally { dispose(); }
});

test('RLA-ARG-ADAPTIVE-HEAL runner: real release event appends, runs once, and resumes gate', async () => {
  const root = mkdtempSync(join('/tmp', 'arg-runner-integration-'));
  const commit = 'b'.repeat(40);
  let gateVisits = 0;
  let triageCompleted = false;
  const commands: string[] = [];
  try {
    const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
    const runBash: NonNullable<GraphRunOptions['deps']>['runBash'] = async (body, opts) => {
      commands.push(body);
      if (body.includes('gate-node.ts --json')) {
        gateVisits++;
        return gateVisits === 1
          ? { exitCode: 1, stdout: JSON.stringify({ outcome: 'fail', commit, introduced: ['src/example.test.ts > introduced regression'] }), stderr: '' }
          : { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', commit, introduced: [] }), stderr: '' };
      }
      if (body.includes('gate-triage-node.ts')) {
        const triage = classifyGateShadow({ ...gateFailure(), commit });
        triageCompleted = true;
        const context = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { input: Record<string, unknown> };
        return { exitCode: 0, stdout: JSON.stringify({ ...triage, gateExecutionId: context.input.adaptiveGateExecutionId }), stderr: '' };
      }
      if (body.includes('gate-repair-node.ts')) return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok' }), stderr: '' };
      return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok' }), stderr: '' };
    };
    const deps = { root, runBash };
    await expect(runGraph(graphPath, {
      runId: 'arg-runner-integration',
      input: { version: '0.3.6', previousVersion: '0.3.5', gateExecutor: 'pod' },
      deps: { ...deps, beforeNode: () => { if (triageCompleted) { triageCompleted = false; throw new Error('simulated interruption before appended node'); } } },
    })).rejects.toThrow('simulated interruption before appended node');
    expect(commands.some((body) => body.includes('gate-repair-node.ts'))).toBe(false);
    const state = await runGraph(graphPath, { resumeRunId: 'arg-runner-integration', deps });
    expect(state.path.some((nodeId) => /^gate-repair-[a-f0-9]{12}$/.test(nodeId))).toBe(true);
    expect(state.path.filter((nodeId) => nodeId === 'gate')).toHaveLength(2);
    expect(gateVisits).toBe(2);
    expect(commands.filter((body) => body.includes('gate-repair-node.ts'))).toHaveLength(1);
    expect(state.adaptiveGateNodeAppends).toHaveLength(1);
    expect(state.adaptiveGateNodeAppends?.[0]).toMatchObject({ graphRevision: 2,
      request: { runId: 'arg-runner-integration', visitState: { gate: 1, gateTriage: 1 }, maxRepairRetries: 1 } });
    expect(state.path.indexOf(state.adaptiveGateNodeAppends![0]!.request.node.nodeId)).toBe(state.path.indexOf('gate') + 3);
    expect(state.path[state.path.indexOf(state.adaptiveGateNodeAppends![0]!.request.node.nodeId) + 1]).toBe('gate');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RLA-ALL-LIVE sim: production prescription is consumed and failed repair waits at HITL in the same run', async () => {
  const root = mkdtempSync(join('/tmp', 'rla-all-live-hitl-'));
  const commit = 'd'.repeat(40);
  let gateVisits = 0;
  let triageFailure = '';
  let liveTriage: Record<string, unknown> | undefined;
  const commands: string[] = [];
  try {
    const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
    const cwd = join(import.meta.dir, '../..');
    const runBash: NonNullable<GraphRunOptions['deps']>['runBash'] = async (body, opts) => {
      commands.push(body);
      if (body.includes('gate-node.ts --json')) {
        gateVisits++;
        return { exitCode: 1, stdout: JSON.stringify({ outcome: 'fail', commit,
          introduced: ['src/example.test.ts > injected regression'], stalledEnv: [] }), stderr: '' };
      }
      if (body.includes('gate-triage-node.ts')) {
        const child = spawnSync('bun', ['scripts/release-loop/gate-triage-node.ts'], { cwd, encoding: 'utf8', env: {
          ...process.env, ...opts.env, ELANOUS_STATE_DIR: root,
        } });
        if (child.status !== 0) { triageFailure = `exit=${child.status} stdout=${child.stdout} stderr=${child.stderr}`;
          return { exitCode: child.status ?? 1, stdout: child.stdout, stderr: child.stderr }; }
        liveTriage = JSON.parse(child.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
        return { exitCode: 0, stdout: child.stdout, stderr: '' };
      }
      if (body.includes('gate-repair-node.ts')) return { exitCode: 1,
        stdout: JSON.stringify({ outcome: 'fail', error: 'simulated repair failure' }), stderr: '' };
      return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok' }), stderr: '' };
    };
    const state = await runGraph(graphPath, { runId: 'rla-all-live-hitl', input: {
      version: '0.3.7', previousVersion: '0.3.6', gateExecutor: 'pod' }, deps: { root, runBash } });
    expect(liveTriage, triageFailure).toBeDefined();
    expect(liveTriage?.prescription).toEqual((liveTriage?.adaptiveHeal as { disposition?: unknown } | undefined)?.disposition);
    expect(liveTriage?.prescription).toMatchObject({ action: 'append-repair-and-resume' });
    expect(gateVisits).toBe(1);
    expect(commands.some((body) => body.includes('gate-repair-node.ts'))).toBe(true);
    expect(state.path).toContain('gate-heal-decision');
    expect(state.pending?.nodeId).toBe('gate-heal-decision');
    expect(state.status).toBe('awaiting-approval');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RLA-ALL-LIVE runner: malformed macrophage ladder fails closed at the HITL node', async () => {
  const root = mkdtempSync(join('/tmp', 'rla-all-live-macro-invalid-'));
  const commit = 'f'.repeat(40);
  const commands: string[] = [];
  let liveTriage: Record<string, unknown> | undefined;
  try {
    const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
    const cwd = join(import.meta.dir, '../..');
    const runBash: NonNullable<GraphRunOptions['deps']>['runBash'] = async (body, opts) => {
      commands.push(body);
      if (body.includes('gate-node.ts --json')) return { exitCode: 1, stdout: JSON.stringify({ outcome: 'fail', commit,
        introduced: ['src/example.test.ts > injected regression'], stalledEnv: [] }), stderr: '' };
      if (body.includes('gate-triage-node.ts')) {
        const child = spawnSync('bun', ['scripts/release-loop/gate-triage-node.ts'], { cwd, encoding: 'utf8', env: {
          ...process.env, ...opts.env, ELANOUS_STATE_DIR: root,
        } });
        if (child.status !== 0) return { exitCode: child.status ?? 1, stdout: child.stdout, stderr: child.stderr };
        liveTriage = JSON.parse(child.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
        return { exitCode: 0, stdout: child.stdout, stderr: child.stderr };
      }
      return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok' }), stderr: '' };
    };
    const state = await runGraph(graphPath, { runId: 'rla-all-live-macro-invalid', input: {
      version: '0.3.7', previousVersion: '0.3.6', gateExecutor: 'pod', macrophageRepairLadder: null,
    }, deps: { root, runBash } });
    expect(liveTriage?.prescription).toMatchObject({ action: 'decision-required' });
    expect(state.path).toContain('gate-heal-decision');
    expect(state.pending?.nodeId).toBe('gate-heal-decision');
    expect(state.status).toBe('awaiting-approval');
    expect(commands.some((body) => body.includes('gate-repair-node.ts'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RLA-ALL-LIVE sim: receipt audit rejects host attribution gaps and residual run retries on Pod in the same run', async () => {
  const root = mkdtempSync(join('/tmp', 'rla-all-live-pod-retry-'));
  const commit = 'e'.repeat(40);
  const imageDigest = 'sha256:' + 'a'.repeat(64);
  const testFile = 'src/release/receipt-audit-pod.test.ts';
  const testSource = 'test("pod receipt", () => expect(true).toBe(true));\n';
  const closureTree = { files: [testFile], preload: [], read: (path: string) => path === testFile ? testSource : undefined };
  const identity = gateFileReceiptIdentityFromClosure(closureTree, testFile, imageDigest)!;
  const closureDigest = createHash('sha256').update(JSON.stringify(identity.closureFiles.map((path) => [path, identity.contentHashes[path]]))).digest('hex');
  let podReceipt: (GateFileReceipt & { recordSha256: string }) | undefined;
  const gateExecutors: unknown[] = [];
  const auditOutcomes: string[] = [];
  const auditCoverage: number[] = [];
  let gateVisits = 0;
  const graphDir = join(root, 'graphs', 'release');
  const graphPath = join(graphDir, 'release-loop.yaml');
  try {
    const productionGraph = readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8');
    // Isolate receipt-audit recovery in a declared fixture; an undeclared YAML sibling under
    // graphs/release is correctly denied by the production graph asset manifest.
    const productionErrorEdge = 'error: gate-triage }';
    expect(productionGraph).toContain(productionErrorEdge);
    const receiptAuditGraph = productionGraph.replace(productionErrorEdge, 'error: receipt-audit }');
    expect(receiptAuditGraph).not.toBe(productionGraph);
    writeReleaseGraphFixture(graphPath, receiptAuditGraph);
    copyFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), join(graphDir, 'recipes.yaml'));
    const cwd = join(import.meta.dir, '../..');
    const runBash: NonNullable<GraphRunOptions['deps']>['runBash'] = async (body, opts) => {
      if (body.includes('version-node.ts release --json'))
        return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', commit }), stderr: '' };
      if (body.includes('gate-node.ts --json')) {
        gateVisits++;
        const context = readGraphContext(opts.env!);
        gateExecutors.push(context.input.gateExecutor);
        if (gateVisits === 1) return { exitCode: 2, stdout: JSON.stringify({ outcome: 'error', commit, introduced: [], stalledEnv: [], error: 'failure attribution incomplete' }), stderr: '' };
        expect(context.input.gateExecutor).toBe('pod');
        podReceipt = { file: testFile, closureFiles: [...identity.closureFiles], closureDigest, imageDigest,
          key: gateFileReceiptKey(identity)!, sourceHead40: commit, outcome: 'pass',
          evidence: { producer: 'simulated-pod-gate', runId: context.runId }, recordSha256: 'b'.repeat(64) };
        return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', commit, introduced: [], stalledEnv: [] }), stderr: '' };
      }
      if (body.includes('gate-file-receipt-audit-node.ts')) {
        const context = readGraphContext(opts.env!);
        const { result, exitCode } = runGateFileReceiptAuditNode(context, {
          repo: cwd, roots: { instance: root, ledger: root }, testsAtCommit: () => [testFile],
          closureTree: () => closureTree, pinnedImage: () => imageDigest,
          readReceipt: (_receiptRoot, key) => key === podReceipt?.key ? podReceipt : null,
          finish: (_node, _version, value) => value.outcome === 'ok' ? 0 : value.outcome === 'fail' ? 1 : 2,
        });
        auditOutcomes.push(result.outcome);
        auditCoverage.push(result.measurement.coveredFiles);
        return { exitCode, stdout: JSON.stringify(result), stderr: '' };
      }
      if (body.includes('gate-triage-node.ts')) {
        const child = spawnSync('bun', ['scripts/release-loop/gate-triage-node.ts'], { cwd, encoding: 'utf8', env: {
          ...process.env, ...opts.env, ELANOUS_STATE_DIR: root,
        } });
        if (child.status !== 0) return { exitCode: child.status ?? 1, stdout: child.stdout, stderr: child.stderr };
        return { exitCode: 0, stdout: child.stdout, stderr: child.stderr };
      }
      return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok' }), stderr: '' };
    };
    const state = await runGraph(graphPath, { runId: 'rla-all-live-pod-retry', input: {
      version: '0.3.7', previousVersion: '0.3.6', gateExecutor: 'host', gatePodPool: 'pool-aws2@aws2:1', gateImagePin: 'cut-commit',
    }, deps: { root, runBash } });
    expect(gateVisits).toBe(2);
    expect(gateExecutors).toEqual(['host', 'pod']);
    expect(auditOutcomes).toEqual(['fail', 'ok']);
    expect(auditCoverage).toEqual([0, 1]);
    expect(state.path.filter((nodeId) => nodeId === 'gate' || nodeId === 'residual-run')).toHaveLength(2);
    expect(state.path).toContain('receipt-audit');
    expect(state.path).toContain('residual-run');
    expect(state.path).toContain('receipt-audit-recheck');
    expect(state.status).toBe('done');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RLA-ALL-LIVE sim: host attribution prescription reruns pod once in the same run then waits at HITL', async () => {
  const root = mkdtempSync(join('/tmp', 'rla-all-live-pod-retry-'));
  const previousLive = process.env.ELANOUS_RLA_ARG_LIVE;
  process.env.ELANOUS_RLA_ARG_LIVE = '1';
  const commit = 'e'.repeat(40);
  const gateExecutors: unknown[] = [];
  let gateVisits = 0;
  let proposalCalls = 0;
  let liveTriage: Record<string, unknown> | undefined;
  try {
    const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
    const cwd = join(import.meta.dir, '../..');
    const runBash: NonNullable<GraphRunOptions['deps']>['runBash'] = async (body, opts) => {
      const rawContext = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { graphId?: string };
      if (rawContext.graphId === 'pod-reuse-prep')
        return { exitCode: 0, stdout: JSON.stringify({ outcome: 'legacy', verdict: 'legacy',
          reason: 'prep-body-pending', receiptPath: '' }), stderr: '' };
      if (body.includes('gate-node.ts --json')) {
        gateVisits++;
        const context = readGraphContext(opts.env!);
        gateExecutors.push(context.input.gateExecutor);
        return gateVisits === 1
          ? { exitCode: 2, stdout: JSON.stringify({ outcome: 'error', commit, introduced: [], stalledEnv: [],
            error: 'failure attribution incomplete' }), stderr: '' }
          : { exitCode: 2, stdout: JSON.stringify({ outcome: 'error', commit, introduced: [], stalledEnv: [],
            error: 'pod gate execution remained unmeasured' }), stderr: '' };
      }
      if (body.includes('gate-triage-node.ts')) {
        const child = spawnSync('bun', ['scripts/release-loop/gate-triage-node.ts'], { cwd, encoding: 'utf8', env: {
          ...process.env, ...opts.env, ELANOUS_STATE_DIR: root,
        } });
        if (child.status !== 0) return { exitCode: child.status ?? 1, stdout: child.stdout, stderr: child.stderr };
        liveTriage = JSON.parse(child.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
        return { exitCode: 0, stdout: child.stdout, stderr: child.stderr };
      }
      return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok' }), stderr: '' };
    };
    const state = await runGraph(graphPath, { runId: 'rla-all-live-pod-retry', input: {
      version: '0.3.7', previousVersion: '0.3.6', gateExecutor: 'host', gatePodPool: 'pool-aws2@aws2:1',
      cutSha: commit, candidatePath: 'fixture:legacy',
      graphCutover: 'audit', graphCutoverEvidenceId: 'RLA-ARG-LIVE-sim',
    }, deps: { root, runBash, callLLM: async prompt => {
      expect(prompt).toContain('attemptsPolicy');
      expect(prompt).not.toContain('release.gate.failure.attribution-gap');
      proposalCalls++;
      if (proposalCalls > 1) return JSON.stringify({ // Source: RLA-ARG-FULL-VERBS high-risk MRTR simulation.
        apiVersion: 'elanous.dev/arg-proposal/v1', verb: 'propose-new-gate-node',
        rationale: 'Pod failure needs a new diagnostic node',
        changes: [{ kind: 'node', node: { node_id: 'diagnostic-gate', kind: 'gate', recipe: 'none' } }],
        rollbackWhen: ['verification fails'],
      });
      return JSON.stringify({
      apiVersion: 'elanous.dev/arg-proposal/v1', verb: 'register-attribution-gap',
      rationale: 'Previously unseen host attribution gap',
      changes: [{ kind: 'vocabulary', term: 'release.gate.failure.attribution-gap' }],
      rollbackWhen: ['verification fails'],
      });
    } } });
    expect(gateVisits).toBe(2);
    expect(gateExecutors).toEqual(['host', 'pod']);
    expect(liveTriage?.prescription).toMatchObject({ action: 'decision-required' });
    expect(state.path.filter((nodeId) => nodeId === 'gate')).toHaveLength(2);
    expect(state.path).not.toContain('emergency-switch');
    expect(state.path).toContain('gate-heal-decision');
    expect(state.pending?.nodeId).toBe('gate-heal-decision');
    expect(state.adaptiveGraphEdges).toEqual([expect.objectContaining({ from: 'gate-triage', to: 'gate', triggerEvent: 'release.gate.failed' })]);
    expect(state.adaptiveGraphVocabulary).toContain('release.gate.failure.attribution-gap');
    expect(state.graphRevision).toBe(3); // Source: RLA-SUPERVISOR-ARG-GRAPH edge and vocabulary apply contracts.
    expect(proposalCalls).toBe(2); // Source: RLA-ARG-FULL-VERBS one proposal per unmeasured gate event.
    expect(state.argInputRequests?.[0]?.resultType).toBe('input_required');
    expect(state.argInputRequests?.[0]?.requestState.proposal).toContain('diagnostic-gate');
    const vocabulary = parseYaml(readFileSync(join(`${state.statePath}.graph`, 'release-edge-vocabulary.yaml'), 'utf8'));
    expect(vocabulary.failureTypes['release.gate.failure.attribution-gap']).toMatchObject({
      source: 'rla-open-proposal', graphRevision: 3, // Source: RLA-SUPERVISOR-ARG-GRAPH edge and vocabulary apply contracts.
    });
    expect(readFileSync(join(root, 'graph-supervisors/actions.jsonl'), 'utf8')).toContain('"verb":"verify"');
    const candidateDirectory = argCandidateDirectory(root, state.runId);
    expect(JSON.parse(readFileSync(join(candidateDirectory, readdirSync(candidateDirectory)[0]!), 'utf8')).status).toBe('candidate');
    expect(existsSync(join(root, 'graph-supervisors/template-memory.json'))).toBe(false);
  } finally {
    if (previousLive === undefined) delete process.env.ELANOUS_RLA_ARG_LIVE;
    else process.env.ELANOUS_RLA_ARG_LIVE = previousLive;
    rmSync(root, { recursive: true, force: true });
  }
});


test('RELEASE-RUN-HEAL-IMAGE-MISSING sim: same run builds and pins cut image, then reruns gate', async () => {
  const root = mkdtempSync(join('/tmp', 'release-image-missing-heal-'));
  const runId = 'release-image-missing-same-run';
  const version = '0.3.6';
  const cut = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8' }).stdout.trim();
  expect(cut).toMatch(/^[0-9a-f]{40}$/);
  const pool = 'pool-node-b@node-b:1';
  const digest = `sha256:${'9'.repeat(64)}`;
  const imageBuildCommits: string[] = [];
  const imageSourceGitCommands: Array<{ args: string[]; cwd: string }> = [];
  const commands: string[] = [];
  let gateVisits = 0;
  let imageReady = false;
  const gateRunner = {
    async localCommand(cmd: string, args: string[], cwd: string) {
      if (cmd === 'git' && (args[0] === 'clone' || args[0] === 'checkout')) {
        imageSourceGitCommands.push({ args, cwd });
        return { rc: 0, output: '' };
      }
      const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
      return { rc: result.status ?? 2, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
    },
  } as unknown as GateRunner;
  const runBash: NonNullable<GraphRunOptions['deps']>['runBash'] = async (body, opts) => {
    commands.push(body);
    const env = opts.env!;
    if (body.includes('version-node.ts release'))
      return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', commit: cut }), stderr: '' };
    if (body.includes('gate-node.ts --json')) {
      gateVisits++;
      const context = readGraphContext(env);
      if (gateVisits === 1) return { exitCode: 2, stdout: JSON.stringify({ outcome: 'error', commit: cut, introduced: [],
        preexisting: 0, fixed: null, knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 1,
        error: 'gate pod refused to start without a scoped cut image pin (pod-gate-missing-cut-image-pin)' }), stderr: '' };
      const parsed = parseOptions(['--json'], env);
      expect(parsed).not.toBe('help');
      if (parsed !== 'help') expect(parsed.imagePin).toBe('cut-commit');
      expect(Object.entries(context.outputs).some(([nodeId, output]) => /^gate-image-repair-[a-f0-9]{12}$/.test(nodeId)
        && output.imagePinRunId === runId && output.imagePinDigest === digest)).toBe(true);
      return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', commit: cut, introduced: [] }), stderr: '' };
    }
    if (body.includes('gate-triage-node.ts')) {
      const context = readGraphContext(env);
      const gate = context.outputs.gate as unknown as GateResult;
      return { exitCode: 0, stdout: JSON.stringify({ ...classifyGateShadow(gate),
        gateExecutionId: context.input.adaptiveGateExecutionId }), stderr: '' };
    }
    if (body.includes('gate-image-repair-node.ts')) {
      const context = readGraphContext(env);
      const result = await runGateImageRepairNode(context, {
        instanceRoot: root,
        runner: gateRunner,
        imageProbe: (_pool, commit) => commit === cut && imageReady ? digest : null,
        syncImages: async (members, _image, commit, options) => {
          imageBuildCommits.push(commit ?? '');
          expect(commit).toBe(cut);
          expect(members.map((member) => member.context)).toEqual(['pool-node-b']);
          expect(options?.buildScript).toContain('/docker/harness/build.sh');
          imageReady = true;
          return new Map(members.map((member) => [member.context, { ok: true, action: 'built', detail: 'simulated registry build', ms: 1 }])) as Awaited<ReturnType<typeof syncPoolImages>>;
        },
      });
      return { exitCode: 0, stdout: JSON.stringify(result), stderr: '' };
    }
    return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok' }), stderr: '' };
  };
  try {
    const state = await runGraph(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), {
      runId,
      input: { version, previousVersion: '0.3.5', gateExecutor: 'pod', gatePodPool: pool },
      deps: { root, runBash },
    });
    expect(state.status).toBe('done');
    expect(gateVisits).toBe(2);
    expect(imageBuildCommits).toEqual([cut]);
    expect(state.path.filter((nodeId) => nodeId === 'gate')).toHaveLength(2);
    const repairNode = state.path.find((nodeId) => /^gate-image-repair-[a-f0-9]{12}$/.test(nodeId));
    expect(repairNode).toBeTruthy();
    expect(state.path.indexOf(repairNode!)).toBe(state.path.indexOf('gate') + 2);
    expect(state.path[state.path.indexOf(repairNode!) + 1]).toBe('gate');
    expect(imageSourceGitCommands).toHaveLength(2);
    expect(imageSourceGitCommands[0]).toMatchObject({
      args: ['clone', '--quiet', '--shared', '--no-checkout', imageSourceGitCommands[0]!.cwd, expect.any(String)],
    });
    expect(imageSourceGitCommands[1]).toEqual({
      args: ['checkout', '--quiet', '--detach', cut], cwd: imageSourceGitCommands[0]!.args[5],
    });
    const pin = JSON.parse(readFileSync(gateImagePinPath(root, version, runId), 'utf8')) as { version: number; commit: string; digest: string; runId: string; image: string };
    expect(pin).toEqual({ version: 2, runId, digest, image: expect.any(String), commit: cut });
    expect(commands.some((body) => body.includes('gate-image-repair-node.ts'))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RLA-ARG-ADAPTIVE-HEAL runner: failed repair routes to HITL without rerunning gate', async () => {
  const root = mkdtempSync(join('/tmp', 'arg-runner-fail-closed-'));
  let gateVisits = 0;
  try {
    const state = await runGraph(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), {
      runId: 'arg-runner-fail-closed',
      input: { version: '0.3.6', previousVersion: '0.3.5', gateExecutor: 'pod' },
      deps: { root, runBash: async (body: string, opts) => {
        if (body.includes('gate-node.ts --json')) {
          gateVisits++;
          return { exitCode: 1, stdout: JSON.stringify({ outcome: 'fail', commit: 'c'.repeat(40), introduced: ['src/example.test.ts > introduced regression'] }), stderr: '' };
        }
        if (body.includes('gate-triage-node.ts')) {
          const context = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { input: Record<string, unknown> };
          return { exitCode: 0, stdout: JSON.stringify({ ...classifyGateShadow({ ...gateFailure(), commit: 'c'.repeat(40) }),
            gateExecutionId: context.input.adaptiveGateExecutionId }), stderr: '' };
        }
        if (body.includes('gate-repair-node.ts')) return { exitCode: 1, stdout: JSON.stringify({ outcome: 'fail' }), stderr: 'repair failed' };
        return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok' }), stderr: '' };
      } },
    });
    const repairIndex = state.path.findIndex((nodeId) => /^gate-repair-[a-f0-9]{12}$/.test(nodeId));
    expect(state.status).toBe('awaiting-approval');
    expect(gateVisits).toBe(1);
    expect(repairIndex).toBeGreaterThan(-1);
    expect(state.path[repairIndex + 1]).toBe('gate-heal-decision');
    expect(state.pending?.nodeId).toBe('gate-heal-decision');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RLA-ARG-ADAPTIVE-HEAL runner: gate-triage outbox replays after dispatch interruption', async () => {
  const root = mkdtempSync(join('/tmp', 'arg-runner-outbox-replay-'));
  let interruptDispatch = true;
  let gateVisits = 0;
  const backingBus = createGraphEventBus();
  const eventBus: GraphEventBus = {
    registerType: (type) => backingBus.registerType(type),
    hasType: (type) => backingBus.hasType(type),
    publish: (input) => {
      if (input.type === RELEASE_GATE_FAILED_EVENT && interruptDispatch) {
        interruptDispatch = false;
        return Promise.reject(new Error('simulated event dispatch interruption'));
      }
      return backingBus.publish(input);
    },
    flush: (scope) => backingBus.flush(scope),
    subscribe: (handler, filter) => backingBus.subscribe(handler, filter),
  };
  const runBash: NonNullable<GraphRunOptions['deps']>['runBash'] = async (body, opts) => {
    if (body.includes('gate-node.ts --json')) {
      gateVisits++;
      return gateVisits === 1
        ? { exitCode: 1, stdout: JSON.stringify({ outcome: 'fail', commit: 'd'.repeat(40), introduced: ['src/example.test.ts > introduced regression'] }), stderr: '' }
        : { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', commit: 'd'.repeat(40), introduced: [] }), stderr: '' };
    }
    if (body.includes('gate-triage-node.ts')) {
      const context = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { input: Record<string, unknown> };
      return { exitCode: 0, stdout: JSON.stringify({ ...classifyGateShadow({ ...gateFailure(), commit: 'd'.repeat(40) }),
        gateExecutionId: context.input.adaptiveGateExecutionId }), stderr: '' };
    }
    return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok' }), stderr: '' };
  };
  try {
    const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
    await expect(runGraph(graphPath, { runId: 'arg-runner-outbox-replay', eventBus,
      input: { version: '0.3.6', previousVersion: '0.3.5', gateExecutor: 'pod' }, deps: { root, runBash } }))
      .rejects.toThrow('simulated event dispatch interruption');
    const savedPath = join(root, 'graph-runs', 'release-loop', 'arg-runner-outbox-replay.json');
    const saved = JSON.parse(readFileSync(savedPath, 'utf8')) as { pendingGraphEvents?: Array<{ type: string }> };
    expect(saved.pendingGraphEvents?.map(({ type }) => type)).toContain(RELEASE_GATE_FAILED_EVENT);
    const resumed = await runGraph(graphPath, { resumeRunId: 'arg-runner-outbox-replay', deps: { root, runBash } });
    expect(resumed.status).toBe('done');
    expect(resumed.path.filter((nodeId) => nodeId === 'gate')).toHaveLength(2);
    expect(resumed.adaptiveGateNodeAppends).toHaveLength(1);
    expect(gateVisits).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
