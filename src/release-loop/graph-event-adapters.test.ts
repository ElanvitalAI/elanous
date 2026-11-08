import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSurfaceEventsDb } from '../domains/surface-events.js';
import { readFileSync } from 'node:fs';
import { openMsgStore } from '../msg/msg-store.js';
import { listCoordEvents } from '../context-bus/coord-events.js';
import { recordExternalEvent } from '../context-bus/external-events.js';
import { createGraphEventBus } from '../graph-runner/graph-events.js';
import { registerGraphSubscriptions, type GraphSubgraphAppendProposal } from '../graph-runner/graph-subscriptions.js';
import { registerReleaseGraphEventAdapters } from './graph-event-adapters.js';
import { decideGraphApproval, runGraph, type GraphRunOptions } from '../graph-runner/runner.js';
import { classifyGateShadow } from '../../scripts/release-loop/gate-triage-node.js';

test('release graph events reach OP inbox, context journal and TC stage mail once per scoped event', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-event-adapters-'));
  const contextDb = openSurfaceEventsDb(':memory:');
  let dispose: () => void = () => undefined;
  try {
    const bus = createGraphEventBus({ createEventId: (sequence) => sequence <= 2 ? 'same-lifecycle'
      : sequence <= 4 ? 'same-stage' : `event-${sequence}` });
    bus.registerType('release-stage');
    bus.registerType('release.gate.failed');
    dispose = registerReleaseGraphEventAdapters(bus, { graphId: 'release-loop', runId: 'r1' }, {
      root,
      contextEvent: (input) => recordExternalEvent(input, { db: contextDb }),
    });
    await bus.publish({ graphId: 'release-loop', runId: 'r1', type: 'node-start', source: { kind: 'node', nodeId: 'gate' } });
    await bus.publish({ graphId: 'release-loop', runId: 'r1', type: 'node-start', source: { kind: 'node', nodeId: 'gate' } });
    await bus.publish({ graphId: 'release-loop', runId: 'r1', type: 'release-stage', source: { kind: 'runner', nodeId: 'gate' },
      data: { state: 'start', dryRun: false } });
    await bus.publish({ graphId: 'release-loop', runId: 'r1', type: 'release-stage', source: { kind: 'runner', nodeId: 'gate' },
      data: { state: 'start', dryRun: false } });
    await bus.publish({ graphId: 'release-loop', runId: 'other-run', type: 'node-start', source: { kind: 'node', nodeId: 'gate' } });
    await bus.publish({ graphId: 'release-loop', runId: 'r1', type: 'node-start', source: { kind: 'node', nodeId: 'dry' }, data: { dryRun: true } });
    await bus.publish({ graphId: 'release-loop', runId: 'r1', type: 'node-end', source: { kind: 'node', nodeId: 'gate' },
      data: { outcome: 'fail', ok: false, reason: 'introduced regression\nsecond line' } });
    await bus.publish({ graphId: 'release-loop', runId: 'r1', type: 'release.gate.failed', source: { kind: 'node', nodeId: 'gate-triage' },
      data: { gate: { introduced: ['src/release.test.ts > regression'] } } });
    await bus.publish({ graphId: 'release-loop', runId: 'r1', type: 'node-start', source: { kind: 'node', nodeId: 'gate-repair-0123456789ab' } });
    await bus.publish({ graphId: 'release-loop', runId: 'r1', type: 'node-end', source: { kind: 'node', nodeId: 'gate-repair-0123456789ab' },
      data: { outcome: 'ok', ok: true } });
    await bus.flush();
    dispose();
    dispose = () => undefined;

    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      const rlaMessages = store.listByRecipient('OP').filter((message) => message.from === 'RLA');
      expect(rlaMessages).toHaveLength(5);
      expect(rlaMessages.map(({ body }) => body)).toEqual([
        '✅ RLA started · run=r1 · node=gate · event=same-lifecycle',
        '🚨 RLA failed · run=r1 · node=gate · reason=introduced regression second line · event=event-7',
        '🚨 RLA gate failure attributed · run=r1 · node=gate-triage · failures=1 · event=event-8',
        '✅ RLA repair started · run=r1 · node=gate-repair-0123456789ab · event=event-9',
        '✅ RLA repair completed · run=r1 · node=gate-repair-0123456789ab · event=event-10',
      ]);
      expect(store.listByRecipient('OP').filter((message) => message.from === 'TC')).toHaveLength(1);
    } finally { store.close(); }
    expect(listCoordEvents({ since: '2000-01-01T00:00:00.000Z', seat: 'release-graph' }, { db: contextDb })).toHaveLength(6);
  } finally {
    dispose();
    contextDb.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('subscription adapter exposes the N21 vocabulary and adaptive edge extension points', async () => {
  const bus = createGraphEventBus();
  bus.registerType('release.tip.moved');
  const seen: string[] = [];
  const dispose = registerGraphSubscriptions(bus, [{ nodeId: 'heal', subscribes: [
    { event: 'release.tip.moved', action: 'wake' },
  ] }], async ({ eventVocabulary, proposeEdge }) => {
    eventVocabulary.registerType('release.edge.suggested');
    seen.push(String(eventVocabulary.hasType('release.edge.suggested')));
    if (proposeEdge) seen.push((await proposeEdge({ from: 'heal', to: 'gate-bisect', triggerEvent: 'release.tip.moved',
      rationale: 'adaptive edge proposal' })).disposition);
  }, { scope: { graphId: 'release-loop', runId: 'n21' }, proposeEdge: async () => ({ disposition: 'added', reason: 'live default' }) });
  try {
    await bus.publish({ graphId: 'release-loop', runId: 'n21', type: 'release.tip.moved', source: { kind: 'runner' } });
    expect(seen).toEqual(['true', 'added']);
  } finally { dispose(); }
});

test('release adapters skip run-scoped dry runs and report stage delivery failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-event-adapters-dry-'));
  const bus = createGraphEventBus();
  bus.registerType('release-stage');
  const dispose = registerReleaseGraphEventAdapters(bus, { graphId: 'release-loop', runId: 'dry', dryRun: true }, {
    root,
    stageMail: () => { throw new Error('mail unavailable'); },
    contextEvent: () => { throw new Error('must not write in dry run'); },
  });
  try {
    await bus.publish({ graphId: 'release-loop', runId: 'dry', type: 'node-start', source: { kind: 'node', nodeId: 'gate' } });
    await bus.publish({ graphId: 'release-loop', runId: 'dry', type: 'release-stage', source: { kind: 'runner', nodeId: 'gate' },
      data: { state: 'wait' } });
    // The run-level dry-run scope skips both adapters and operational journals.
    await bus.flush();
  } finally { dispose(); rmSync(root, { recursive: true, force: true }); }

  const liveRoot = mkdtempSync(join(tmpdir(), 'release-event-adapters-error-'));
  const liveBus = createGraphEventBus();
  liveBus.registerType('release-stage');
  const disposeLive = registerReleaseGraphEventAdapters(liveBus, { graphId: 'release-loop', runId: 'live' }, {
    root: liveRoot, stageMail: () => { throw new Error('mail unavailable'); },
  });
  try {
    await expect(liveBus.publish({ graphId: 'release-loop', runId: 'live', type: 'release-stage',
      source: { kind: 'runner', nodeId: 'gate' }, data: { state: 'wait' } })).rejects.toThrow('delivery failed');
  } finally { disposeLive(); rmSync(liveRoot, { recursive: true, force: true }); }
});

test('release run attaches live subscriber adapters to its actual graph event trace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-event-runner-adapters-'));
  const priorStateRoot = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  try {
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    const graph = join(root, 'release-loop.yaml');
    writeFileSync(graph, [
      'graph_id: release-loop', 'version: 1', 'entry_node: done', 'terminal_nodes: [done, failed]', 'nodes:',
      '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
      '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }', '',
    ].join('\n'));
    const state = await runGraph(graph, { runId: 'adapter-wired-run', deps: { root, releaseGraphEventAdapters: true } });
    expect(state.status).toBe('done');

    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      const rlaMessages = store.listByRecipient('OP').filter((message) => message.from === 'RLA');
      expect(rlaMessages).toHaveLength(2);
      expect(rlaMessages.every(({ body }) => body.startsWith('✅ RLA') && body.includes('node=done') && body.includes('event='))).toBe(true);
      expect(store.listByRecipient('OP').filter((message) => message.from === 'TC')).toHaveLength(2);
    } finally { store.close(); }
    const contextDb = openSurfaceEventsDb(join(root, 'surface_events.db'));
    try {
      expect(listCoordEvents({ since: '2000-01-01T00:00:00.000Z', seat: 'release-graph' }, { db: contextDb })
        .map((event) => event.summary)).toEqual([
        'release graph node-arrival · run=adapter-wired-run · node=done',
        'release graph node-start · run=adapter-wired-run · node=done',
        'release graph release-stage · run=adapter-wired-run · node=done · state=start',
        'release graph release-stage · run=adapter-wired-run · node=done · state=ok',
        'release graph node-end · run=adapter-wired-run · node=done',
        'release graph node-leave · run=adapter-wired-run · node=done',
      ]);
    } finally { contextDb.close(); }
  } finally {
    if (priorStateRoot === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = priorStateRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('live OP inbox receives production gate failure and ARG repair lifecycle events', async () => {
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const gateData = (commit: string) => ({ outcome: 'regression' as const, commit,
    introduced: ['src/release.test.ts > injected regression'], preexisting: 0, fixed: null, knownEnv: 0,
    knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 1 });
  const runAndReadMessages = async (repairFails: boolean) => {
    const root = mkdtempSync(join(tmpdir(), 'release-op-live-events-'));
    const previousStateRoot = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    const commit = repairFails ? 'd'.repeat(40) : 'c'.repeat(40);
    let gateVisits = 0;
    try {
      const state = await runGraph(graphPath, { runId: repairFails ? 'op-mail-repair-fail' : 'op-mail-repair-ok',
        input: { version: '0.3.6', previousVersion: '0.3.5', gateExecutor: 'pod' }, deps: {
          root, releaseGraphEventAdapters: true,
          runBash: async (command: string, opts) => {
            if (command.includes('gate-node.ts --json')) {
              gateVisits++;
              return gateVisits === 1
                ? { exitCode: 1, stdout: JSON.stringify({ ...gateData(commit), outcome: 'fail' }), stderr: '' }
                : { exitCode: 0, stdout: JSON.stringify({ ...gateData(commit), outcome: 'ok', introduced: [] }), stderr: '' };
            }
            if (command.includes('gate-triage-node.ts')) {
              const context = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { input: Record<string, unknown> };
              return { exitCode: 0, stdout: JSON.stringify({ ...classifyGateShadow(gateData(commit)),
                gateExecutionId: context.input.adaptiveGateExecutionId }), stderr: '' };
            }
            if (command.includes('gate-repair-node.ts'))
              return repairFails ? { exitCode: 1, stdout: JSON.stringify({ outcome: 'fail' }), stderr: 'repair command failed\nsecond line' }
                : { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok' }), stderr: '' };
            return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok' }), stderr: '' };
          },
        } });
      const store = openMsgStore(join(root, 'msg', 'messages.db'));
      try { return { state, bodies: store.listByRecipient('OP').filter((message) => message.from === 'RLA').map(({ body }) => body) }; }
      finally { store.close(); }
    } finally {
      if (previousStateRoot === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateRoot;
      rmSync(root, { recursive: true, force: true });
    }
  };

  const success = await runAndReadMessages(false);
  expect(success.state.status).toBe('done');
  expect(success.state.adaptiveGateNodeAppends).toHaveLength(1);
  expect(success.bodies.some((body) => body.startsWith('🚨 RLA failed · run=op-mail-repair-ok · node=gate '))).toBe(true);
  expect(success.bodies.some((body) => body.startsWith('🚨 RLA gate failure attributed · run=op-mail-repair-ok · node=gate-triage '))).toBe(true);
  expect(success.bodies.some((body) => body.startsWith('✅ RLA repair started · run=op-mail-repair-ok · node=gate-repair-'))).toBe(true);
  expect(success.bodies.some((body) => body.startsWith('✅ RLA repair completed · run=op-mail-repair-ok · node=gate-repair-'))).toBe(true);

  const failedRepair = await runAndReadMessages(true);
  expect(failedRepair.state.status).toBe('awaiting-approval');
  expect(failedRepair.state.pending?.nodeId).toBe('gate-heal-decision');
  expect(failedRepair.state.adaptiveGateNodeAppends).toHaveLength(1);
  const repairFailure = failedRepair.bodies.find((body) => body.startsWith('🚨 RLA repair failed · run=op-mail-repair-fail · node=gate-repair-'));
  expect(repairFailure).toBeDefined();
  expect(repairFailure?.includes('\n')).toBe(false);
  expect(repairFailure).toContain('reason=');
}, 30_000); // full release graph runs twice — main 4066b368 baseline also timed out at the 5s default on aws1·aws2 train gates

test('release event ids continue across approval resume and remain subscriber-deduplicable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-event-resume-'));
  const priorStateRoot = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  try {
    writeFileSync(join(root, 'recipes.yaml'), 'publish:\n  approval: "Publish now?"\n');
    const graph = join(root, 'release-loop.yaml');
    writeFileSync(graph, [
      'graph_id: release-loop', 'version: 1', 'entry_node: approve-publish', 'terminal_nodes: [done, failed]', 'nodes:',
      '  - { node_id: approve-publish, kind: judge, recipe: approval:publish, max_visits: 1 }',
      '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
      '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }', 'edges:',
      '  - from: approve-publish', '    on: outcome', '    map: { ok: done, fail: failed }', '',
    ].join('\n'));
    const first = await runGraph(graph, { runId: 'resume-event-ids', deps: { root, releaseGraphEventAdapters: true } });
    expect(first.status).toBe('awaiting-approval');
    const firstSequence = first.graphEventSequence ?? 0;
    expect(firstSequence).toBeGreaterThan(0);
    decideGraphApproval(first.graphId, first.runId, 'approved', 'operator', root);
    const resumed = await runGraph(graph, { resumeRunId: first.runId, deps: { root, releaseGraphEventAdapters: true } });
    expect(resumed.status).toBe('done');
    expect(resumed.graphEventSequence).toBeGreaterThan(firstSequence);
    const stateOnDisk = JSON.parse(readFileSync(resumed.statePath, 'utf8')) as { graphEventSequence?: number };
    expect(stateOnDisk.graphEventSequence).toBe(resumed.graphEventSequence);
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      const lifecycle = store.listByRecipient('OP').filter((message) => message.from === 'RLA');
      const eventIds = lifecycle.map((message) => message.body.match(/event=([^\s]+)/)?.[1]);
      expect(eventIds.every(Boolean)).toBe(true);
      expect(new Set(eventIds).size).toBe(eventIds.length);
    } finally { store.close(); }
  } finally {
    if (priorStateRoot === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = priorStateRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('runGraph gives wake, invalidate, and reroute subscriptions scheduler effects without an injected dispatcher', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-subscription-actions-'));
  try {
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    const run = async (name: string, lines: string[], handlers: NonNullable<GraphRunOptions['deps']>['inProcessHandlers'] = {}) => {
      const graph = join(root, `${name}.yaml`);
      writeFileSync(graph, [...lines, ''].join('\n'));
      return runGraph(graph, { runId: name, deps: { root, inProcessHandlers: handlers } });
    };
    const common = ['version: 1', 'terminal_nodes: [done, failed]'];
    const wake = await run('wake', [
      'graph_id: subscription-actions', 'entry_node: source', ...common, 'nodes:',
      '  - { node_id: source, kind: agent, recipe: handler:emit-wake, max_visits: 1, emits: [wake.signal] }',
      '  - node_id: waker\n    kind: agent\n    recipe: handler:emit-followup\n    max_visits: 1\n    emits: [wake.followup]\n    subscribes:\n      - { event: wake.signal, action: wake }',
      '  - { node_id: waker2, kind: gate, recipe: none, max_visits: 1, subscribes: [{ event: wake.signal, action: wake }] }',
      '  - { node_id: waker3, kind: gate, recipe: none, max_visits: 1, subscribes: [{ event: wake.followup, action: wake }] }',
      '  - { node_id: normal, kind: gate, recipe: none, max_visits: 1 }',
      '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }', '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }',
      'edges:', '  - { from: source, to: normal }', '  - { from: waker, to: done }', '  - { from: waker2, to: done }',
      '  - { from: waker3, to: done }', '  - { from: normal, to: done }',
    ], {
      'emit-wake': async ({ emitEvent }) => { await emitEvent?.('wake.signal'); return { ok: true, outcome: 'ok' }; },
      'emit-followup': async ({ emitEvent }) => { await emitEvent?.('wake.followup'); return { ok: true, outcome: 'ok' }; },
    });
    expect(wake.path).toEqual(['source', 'waker', 'waker2', 'waker3', 'normal', 'done']);
    expect(wake.subscriptionActions?.filter((item) => item.outcome === 'handled')).toHaveLength(3);

    const invalidate = await run('invalidate', [
      'graph_id: subscription-actions', 'entry_node: prior', ...common, 'nodes:',
      '  - { node_id: prior, kind: gate, recipe: none, max_visits: 2, subscribes: [{ event: receipt.changed, action: invalidate }] }',
      '  - { node_id: source, kind: agent, recipe: handler:emit-invalidate, max_visits: 1, emits: [receipt.changed] }',
      '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }', '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }',
      'edges:', '  - { from: prior, to: source }', '  - { from: source, to: done }',
    ], { 'emit-invalidate': async ({ emitEvent }) => { await emitEvent?.('receipt.changed'); return { ok: true, outcome: 'ok' }; } });
    expect(invalidate.path).toEqual(['prior', 'source', 'prior', 'done']);
    expect(invalidate.nodes[0]).toMatchObject({ nodeId: 'prior', invalidatedByEvent: expect.any(String) });
    expect(invalidate.subscriptionActions?.some((item) => item.action === 'invalidate' && item.outcome === 'queued')).toBe(true);

    const reroute = await run('reroute', [
      'graph_id: subscription-actions', 'entry_node: source', ...common, 'nodes:',
      '  - { node_id: source, kind: agent, recipe: handler:emit-reroute, max_visits: 1, emits: [route.signal] }',
      '  - { node_id: redirect, kind: gate, recipe: none, max_visits: 1, subscribes: [{ event: route.signal, action: reroute }] }',
      '  - { node_id: normal, kind: gate, recipe: none, max_visits: 1 }',
      '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }', '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }',
      'edges:', '  - { from: source, to: normal }', '  - { from: source, to: redirect }', '  - { from: redirect, to: done }', '  - { from: normal, to: done }',
    ], { 'emit-reroute': async ({ emitEvent }) => { await emitEvent?.('route.signal'); return { ok: true, outcome: 'ok' }; } });
    expect(reroute.path).toEqual(['source', 'redirect', 'done']);
    expect(reroute.subscriptionActions?.some((item) => item.action === 'reroute' && item.outcome === 'queued')).toBe(true);

    const delayedReroute = await run('delayed-reroute', [
      'graph_id: subscription-actions', 'entry_node: source', ...common, 'nodes:',
      '  - { node_id: source, kind: agent, recipe: handler:emit-delayed-reroute, max_visits: 1, emits: [route.delayed] }',
      '  - { node_id: wake-first, kind: gate, recipe: none, max_visits: 1, subscribes: [{ event: route.delayed, action: wake }] }',
      '  - { node_id: redirect, kind: gate, recipe: none, max_visits: 1, subscribes: [{ event: route.delayed, action: reroute }] }',
      '  - { node_id: normal, kind: gate, recipe: none, max_visits: 1 }',
      '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }', '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }',
      'edges:', '  - { from: source, to: normal }', '  - { from: source, to: wake-first }', '  - { from: source, to: redirect }',
      '  - { from: wake-first, to: done }', '  - { from: redirect, to: done }', '  - { from: normal, to: done }',
    ], { 'emit-delayed-reroute': async ({ emitEvent }) => { await emitEvent?.('route.delayed'); return { ok: true, outcome: 'ok' }; } });
    expect(delayedReroute.path).toEqual(['source', 'wake-first', 'normal', 'done']);
    expect(delayedReroute.subscriptionActions?.some((item) => item.action === 'reroute' && item.outcome === 'rejected'))
      .toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runGraph restores queued subscriber actions across approval resume and registers child event types on shared bus', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-subscription-resume-'));
  const bus = createGraphEventBus();
  const seen: string[] = [];
  bus.subscribe((event) => { seen.push(`${event.graphId}:${event.type}`); });
  try {
    writeFileSync(join(root, 'recipes.yaml'), 'publish:\n  approval: "Continue?"\n');
    const approvalGraph = join(root, 'approval.yaml');
    writeFileSync(approvalGraph, [
      'graph_id: release-loop', 'version: 1', 'entry_node: approve-publish', 'terminal_nodes: [done, failed]', 'nodes:',
      '  - { node_id: approve-publish, kind: judge, recipe: approval:publish, max_visits: 1 }',
      '  - { node_id: done, kind: gate, recipe: none, max_visits: 1, subscribes: [{ event: release-stage, match: { nodeId: approve-publish, state: wait }, action: wake }] }',
      '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }',
      'edges:', '  - from: approve-publish', '    on: outcome', '    map: { ok: done, fail: failed }', '',
    ].join('\n'));
    const first = await runGraph(approvalGraph, { runId: 'queued-resume', eventBus: bus, deps: { root, releaseGraphEventAdapters: true } });
    expect(first.status).toBe('awaiting-approval');
    expect(first.pendingSubscriptionActions).toHaveLength(1);
    decideGraphApproval(first.graphId, first.runId, 'approved', 'operator', root);
    const resumed = await runGraph(approvalGraph, { resumeRunId: first.runId, eventBus: bus, deps: { root, releaseGraphEventAdapters: true } });
    expect(resumed.status).toBe('done');
    expect(resumed.path).toEqual(['approve-publish', 'done']);
    expect(resumed.pendingSubscriptionActions).toEqual([]);
    expect(resumed.subscriptionActions?.filter((item) => item.outcome === 'handled')).toHaveLength(1);

    const unitsDir = join(root, 'units');
    mkdirSync(unitsDir);
    writeFileSync(join(unitsDir, 'recipes.yaml'), '{}\n');
    writeFileSync(join(unitsDir, 'worker.yaml'), [
      'graph_id: worker', 'version: 1', 'unit: { inputs: [request], outputs: [], exits: [done, failed] }',
      'entry_node: emit', 'terminal_nodes: [done, failed]', 'nodes:',
      '  - { node_id: emit, kind: agent, recipe: handler:emit-child, max_visits: 1, emits: [child.signal] }',
      '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }', '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }',
      'edges:', '  - { from: emit, to: done }', '',
    ].join('\n'));
    const parentGraph = join(root, 'parent.yaml');
    writeFileSync(parentGraph, [
      'graph_id: parent-contract', 'version: 1', 'entry_node: invoke', 'terminal_nodes: [done, failed]', 'nodes:',
      '  - { node_id: invoke, kind: subgraph, recipe: none, max_visits: 1, call: worker@1, budget: { inner_steps: 4 }, contract: { inputs: [request], tools: read-only, outputs: [] } }',
      '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }', '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }',
      'edges:', '  - { from: invoke, on: outcome, map: { done: done, failed: failed } }', '',
    ].join('\n'));
    const parent = await runGraph(parentGraph, { runId: 'parent-event-contract', input: { request: 'hello' }, eventBus: bus, deps: {
      root, inProcessHandlers: { 'emit-child': async ({ emitEvent }) => {
        await emitEvent?.('child.signal'); return { ok: true, outcome: 'done' };
      } },
    } });
    expect(parent.status).toBe('done');
    expect(seen).toContain('worker:child.signal');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('replayed event does not enqueue the same subscriber action twice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-subscription-replay-dedupe-'));
  const priorStateRoot = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  let failOnce = true;
  const bus = createGraphEventBus();
  bus.subscribe((event) => {
    if (event.type === 'release-stage' && event.data?.state === 'wait' && failOnce) {
      failOnce = false;
      throw new Error('later subscriber unavailable');
    }
  }, { type: 'release-stage' });
  try {
    writeFileSync(join(root, 'recipes.yaml'), 'publish:\n  approval: "Continue repair"\n');
    const graph = join(root, 'release-loop.yaml');
    writeFileSync(graph, [
      'graph_id: release-loop', 'version: 1', 'entry_node: approve-publish', 'terminal_nodes: [done, failed]', 'nodes:',
      '  - { node_id: approve-publish, kind: judge, recipe: approval:publish, max_visits: 1 }',
      '  - node_id: pre-gate-join\n    kind: gate\n    recipe: none\n    max_visits: 2\n    subscribes:\n      - event: release-stage\n        match: { state: wait }\n        action: wake',
      '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
      '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }',
      'edges:', '  - { from: approve-publish, on: outcome, map: { ok: done, fail: failed } }',
      '  - { from: pre-gate-join, to: done }', '',
    ].join('\n'));
    const deps: GraphRunOptions['deps'] = { root, releaseGraphEventAdapters: true, releaseStageMail: () => undefined };
    const first = await runGraph(graph, { runId: 'replayed-signal', eventBus: bus, deps });
    expect(first.status).toBe('awaiting-approval');
    expect(first.pendingSubscriptionActions).toHaveLength(1);
    expect(first.pendingGraphEvents?.some((event) => event.type === 'release-stage' && event.data?.state === 'wait')).toBe(true);
    // Recreate a crash after the pending action write but before its dedupe log write.
    const interrupted = JSON.parse(readFileSync(first.statePath, 'utf8')) as {
      subscriptionActions?: Array<{ action: string; outcome: string }>;
    };
    interrupted.subscriptionActions = [];
    writeFileSync(first.statePath, `${JSON.stringify(interrupted, null, 2)}\n`);

    decideGraphApproval(first.graphId, first.runId, 'approved', 'operator', root);
    const resumed = await runGraph(graph, { resumeRunId: first.runId, eventBus: bus, deps });
    expect(resumed.status).toBe('done');
    expect(resumed.path).toEqual(['approve-publish', 'pre-gate-join', 'done']);
    expect(resumed.subscriptionActions?.filter((action) => action.action === 'wake' && action.outcome === 'handled'))
      .toHaveLength(1);
    expect(resumed.pendingSubscriptionActions).toEqual([]);
  } finally {
    if (priorStateRoot === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = priorStateRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('subscriber appends a durable repair subgraph that runs before its resume gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-subscription-append-'));
  const priorStateRoot = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  let repairRuns = 0;
  let subscriptionDispatches = 0;
  let appendResult: unknown;
  let repairInput: unknown;
  const bus = createGraphEventBus();
  try {
    writeFileSync(join(root, 'recipes.yaml'), 'repair-approval:\n  approval: "Resume repair"\n');
    const graph = join(root, 'append-actions.yaml');
    writeFileSync(graph, [
      'graph_id: append-actions', 'version: 1', 'entry_node: source', 'terminal_nodes: [done, failed]', 'nodes:',
      '  - { node_id: source, kind: gate, recipe: none, max_visits: 1 }',
      '  - { node_id: planner, kind: gate, recipe: none, max_visits: 1, subscribes: [{ event: node-start, match: { nodeId: source }, action: wake }] }',
      '  - { node_id: retry-gate, kind: gate, recipe: none, max_visits: 2 }',
      '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
      '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }',
      'edges:', '  - { from: source, to: retry-gate }',
      '  - { from: planner, to: done }', '  - { from: retry-gate, on: outcome, map: { ok: done, fail: failed } }', '',
    ].join('\n'));
    const deps: GraphRunOptions['deps'] = {
      root,
      inProcessHandlers: { 'gate-repair': async ({ nodeInput, emitEvent }) => {
        repairRuns++;
        repairInput = nodeInput;
        await emitEvent?.('repair.done');
        return { ok: true, outcome: 'ok' };
      } },
      dispatchGraphSubscription: async (dispatch) => {
        subscriptionDispatches++;
        if (dispatch.nodeId !== 'planner') return;
        const proposal: GraphSubgraphAppendProposal = {
          nodes: [
            { nodeId: 'repair-approval', kind: 'judge', recipe: 'approval:repair-approval', maxVisits: 1 },
            { nodeId: 'repair-verify', kind: 'gate', recipe: 'none', maxVisits: 1,
              subscribes: [{ event: 'repair.done', action: 'wake' }] },
            { nodeId: 'repair-node', kind: 'agent', recipe: 'handler:gate-repair', maxVisits: 1,
              emits: ['repair.done'], input: { runId: 'append-resume', commit: 'abc1234', failureIds: ['src/a.test.ts > regression'] } },
          ],
          edges: [{ from: 'repair-node', to: 'repair-verify' }, { from: 'repair-verify', to: 'repair-approval' },
            { from: 'repair-approval', to: 'retry-gate' }],
          entryNodeId: 'repair-node', returnTo: 'retry-gate',
          reason: 'repair the attributed gate failures before retrying the gate',
        };
        const appended = await dispatch.appendGraph?.(proposal);
        appendResult = appended;
        expect(appended?.disposition).toBe('appended');
        expect((await dispatch.appendGraph?.(proposal))?.disposition).toBe('duplicate');
      },
    };
    const first = await runGraph(graph, { runId: 'append-resume', eventBus: bus, deps });
    expect(first.status).toBe('awaiting-approval');
    expect(subscriptionDispatches).toBeGreaterThan(0);
    expect(appendResult).toMatchObject({ disposition: 'appended' });
    expect(first.subscriptionGraphAppends).toHaveLength(1);
    expect(first.pendingSubscriptionActions).toEqual([]);
    expect(first.path).toEqual(['source', 'planner', 'repair-node', 'repair-verify', 'repair-approval']);
    expect(repairRuns).toBe(1);
    expect(repairInput).toEqual({ runId: 'append-resume', commit: 'abc1234', failureIds: ['src/a.test.ts > regression'] });

    decideGraphApproval(first.graphId, first.runId, 'approved', 'operator', root);
    const resumed = await runGraph(graph, { resumeRunId: first.runId, eventBus: bus, deps });
    expect(resumed.status).toBe('done');
    expect(resumed.path).toEqual(['source', 'planner', 'repair-node', 'repair-verify', 'repair-approval', 'retry-gate', 'done']);
    expect(repairRuns).toBe(1);
    expect(resumed.pendingSubscriptionActions).toEqual([]);
  } finally {
    if (priorStateRoot === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = priorStateRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed release-stage delivery replays the same event envelope before approval resumes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-event-outbox-'));
  const previousStateRoot = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  let failWait = true;
  const waitAttempts: string[] = [];
  try {
    writeFileSync(join(root, 'recipes.yaml'), 'publish:\n  approval: "Continue?"\n');
    const graph = join(root, 'release-loop.yaml');
    writeFileSync(graph, [
      'graph_id: release-loop', 'version: 1', 'entry_node: approve-publish', 'terminal_nodes: [done, failed]', 'nodes:',
      '  - { node_id: approve-publish, kind: judge, recipe: approval:publish, max_visits: 1 }',
      '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }', '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }',
      'edges:', '  - from: approve-publish', '    on: outcome', '    map: { ok: done, fail: failed }', '',
    ].join('\n'));
    const releaseStageMail = (input: { runId: string; nodeId: string; state: string; eventId?: string }) => {
      if (input.state !== 'wait') return;
      waitAttempts.push(input.eventId ?? 'missing-event-id');
      if (failWait) { failWait = false; throw new Error('TC inbox unavailable'); }
    };
    const first = await runGraph(graph, { runId: 'stage-outbox-retry', deps: {
      root, releaseGraphEventAdapters: true, releaseStageMail,
    } });
    expect(first.status).toBe('awaiting-approval');
    expect(first.pendingGraphEvents?.filter((event) => event.type === 'release-stage' && event.data?.state === 'wait')).toHaveLength(1);
    const waitingEventId = first.pendingGraphEvents!.find((event) => event.data?.state === 'wait')!.eventId;

    const resumed = await runGraph(graph, { resumeRunId: first.runId, deps: {
      root, releaseGraphEventAdapters: true, releaseStageMail,
    } });
    expect(resumed.status).toBe('awaiting-approval');
    expect(waitAttempts).toEqual([`release-loop:${waitingEventId}`, `release-loop:${waitingEventId}`]);
    expect(resumed.pendingGraphEvents).toEqual([]);
    expect(resumed.pending?.notifiedAt).toBeString();
    const contextDb = openSurfaceEventsDb(join(root, 'surface_events.db'));
    try {
      const waits = listCoordEvents({ since: '2000-01-01T00:00:00.000Z', seat: 'release-graph' }, { db: contextDb })
        .filter((event) => event.summary.includes('state=wait'));
      expect(waits).toHaveLength(1);
    } finally { contextDb.close(); }
  } finally {
    if (previousStateRoot === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousStateRoot;
    rmSync(root, { recursive: true, force: true });
  }
});
