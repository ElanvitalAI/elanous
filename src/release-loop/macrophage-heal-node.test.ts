import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from '../graph-runner/runner.js';
import { createGraphEventBus } from '../graph-runner/graph-events.js';
import { debug } from '../debug/log.js';
import { createMacrophageRuntime } from './macrophage-heal-node.js';

test('release phase node-end reaches the macrophage subscriber and records the actual bus trace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'macrophage-bus-'));
  const runId = 'macrophage-bus-test';
  const graphId = 'macrophage-bus-test-graph';
  const now = new Date('2026-11-06T00:00:00Z');
  const graphDir = join(root, 'graphs');
  mkdirSync(graphDir, { recursive: true });
  writeFileSync(join(graphDir, 'recipes.yaml'), 'noop:\n  command: "noop"\n');
  const graphPath = join(graphDir, 'release-loop.yaml');
  writeFileSync(graphPath, `graph_id: ${graphId}\nversion: 1\nentry_node: pre-gate-join\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: pre-gate-join, kind: gate, recipe: 'cmd:noop', max_visits: 1 }\n  - { node_id: done, kind: gate, max_visits: 1 }\n  - { node_id: failed, kind: gate, max_visits: 1 }\nedges:\n  - { from: pre-gate-join, on: outcome, map: { ok: done, fail: failed, error: failed } }\n`);
  const runtime = createMacrophageRuntime({ runId, graphId, root, now: () => now, inventory: () => [
    { id: 'live-worktree', kind: 'orphan-worktree', owner: 'seat-live', evidence: { ownerRunStatus: 'running', ownershipVerified: true } },
  ] });
  const phaseEventIds = new Map<string, string>();
  const unsubscribe = runtime.eventBus.subscribe((event) => {
    if (event.type === 'node-end' && event.source.nodeId) phaseEventIds.set(event.source.nodeId, event.eventId);
  }, { type: 'node-end' });
  try {
    const state = await runGraph(graphPath, { runId, eventBus: runtime.eventBus, deps: {
      root, runBash: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } });
    expect(state.status).toBe('done');
    const phaseEventId = phaseEventIds.get('pre-gate-join');
    expect(phaseEventId).toBeDefined();
    expect(runtime.decisions.map((event) => event.data)).toEqual([{
      sourceEventId: phaseEventId, phaseNodeId: 'pre-gate-join', status: 'planned', id: 'live-worktree',
      kind: 'orphan-worktree', evidence: 'kind=orphan-worktree; owner run=running; owner=seat-live',
      result: 'planned retain; no cleanup applied', action: 'retain', applied: false,
    }]);
    expect(runtime.decisions[0]?.data?.sourceEventId).toBe(phaseEventId);
    const receiptPath = join(root, 'graph-runs', 'release-loop', `${runId}.json.contexts`, 'macrophage.jsonl');
    const receipts = readFileSync(receiptPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      schema: 'elanous.release.macrophage-receipt.v1', graphId, runId, source: { kind: 'runner' },
      data: { sourceEventId: phaseEventId, phaseNodeId: 'pre-gate-join', id: 'live-worktree', action: 'retain' },
    });
    expect(receipts[0].eventId).toBe(runtime.decisions[0]?.eventId);
  } finally {
    unsubscribe();
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('live node invokes the cleanup adapter only for a verified merged queue row', async () => {
  const root = mkdtempSync(join(tmpdir(), 'macrophage-cleanup-'));
  let cleanupCalls = 0;
  const runtime = createMacrophageRuntime({ runId: 'safe-cleanup-test', root, liveCleanup: (scrap) => {
    cleanupCalls += 1;
    expect(scrap.kind).toBe('merged-land-queue-row');
    return 'removed exact stale queue row';
  }, inventory: () => [{ id: 'queue-row', kind: 'merged-land-queue-row',
    evidence: { mergedMainline: true, queueRow: `123\t${'a'.repeat(40)}\t/tree\t/evidence` } }] });
  try {
    await runtime.eventBus.publish({ graphId: 'release-loop', runId: 'safe-cleanup-test', type: 'node-end',
      source: { kind: 'node', nodeId: 'pre-gate-join' }, data: { ok: true } });
    expect(cleanupCalls).toBe(1);
    expect(runtime.decisions[0]?.data).toMatchObject({ action: 'remove-queue-row', applied: true, result: 'removed exact stale queue row' });
  } finally { runtime.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('receipt write failure fails the observer dispatch closed', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'macrophage-receipt-failure-'));
  const rootFile = join(parent, 'not-a-directory');
  writeFileSync(rootFile, '');
  const runtime = createMacrophageRuntime({ runId: 'receipt-failure-test', root: rootFile, inventory: () => [] });
  try {
    await expect(runtime.eventBus.publish({ graphId: 'release-loop', runId: 'receipt-failure-test', type: 'node-end',
      source: { kind: 'node', nodeId: 'pre-gate-join' }, data: { ok: true } })).rejects.toThrow();
  } finally { runtime.dispose(); rmSync(parent, { recursive: true, force: true }); }
});

test('simulation routes a real failed release node-end into one shadow decision per failure signature', async () => {
  const root = mkdtempSync(join(tmpdir(), 'macrophage-failure-sim-'));
  const runId = 'macrophage-failure-sim';
  const graphId = 'macrophage-failure-sim-graph';
  const graphDir = join(root, 'graphs');
  mkdirSync(graphDir, { recursive: true });
  writeFileSync(join(graphDir, 'recipes.yaml'), 'fail-ledger:\n  command: "fail-ledger"\n');
  const graphPath = join(graphDir, 'release-loop.yaml');
  writeFileSync(graphPath, `graph_id: ${graphId}\nversion: 1\nentry_node: gate\nterminal_nodes: [failed]\nnodes:\n  - { node_id: gate, kind: gate, recipe: 'cmd:fail-ledger', max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: gate, on: outcome, map: { ok: failed, fail: failed, error: failed } }\n`);
  const unknownNotices: Array<{ runId: string; nodeId: string; detail: string }> = [];
  const macrophageLogs: Array<{ category: string; event: string; data?: unknown }> = [];
  const previousFileEnabled = debug.isFileEnabled();
  const previousMirrorEnabled = debug.isMirrorEnabled();
  debug.setFileEnabled(false);
  debug.setMirror(true);
  const unregisterDebugSink = debug.registerSink({ name: 'macrophage-live-promote-test', emit: (record) => {
    if (record.category === 'release-loop.macrophage' && record.event === 'decision') macrophageLogs.push(record);
  } });
  let unknownNoticeAttempts = 0;
  const runtime = createMacrophageRuntime({ runId, graphId, mode: 'simulation',
    reportUnknownFailure: (notice) => {
      unknownNoticeAttempts++;
      if (unknownNoticeAttempts === 1) throw new Error('mail store temporarily unavailable');
      unknownNotices.push(notice);
    } });
  try {
    const state = await runGraph(graphPath, { runId, eventBus: runtime.eventBus, quiet: true, deps: {
      root, runBash: async () => ({ exitCode: 1, stdout: '', stderr: 'release gate ledger is not configured' }),
    } });
    expect(state.status).toBe('failed');
    expect(runtime.decisions).toHaveLength(1);
    expect(runtime.decisions[0]?.data).toMatchObject({
      sourceNodeId: 'gate', failureSignature: 'ledger-unconfigured', kind: 'release-node-failure',
      action: 'open-cell', applied: false, status: 'simulated',
    });
    await runtime.eventBus.publish({ graphId, runId, type: 'node-end',
      source: { kind: 'node', nodeId: 'gate' }, data: { ok: false, reason: 'release gate ledger is not configured' } });
    await runtime.eventBus.publish({ graphId, runId, type: 'node-end',
      source: { kind: 'node', nodeId: 'unrelated-node' }, data: { ok: false, reason: 'unknown failure' } });
    await runtime.eventBus.publish({ graphId, runId, type: 'node-end',
      source: { kind: 'node', nodeId: 'verify' }, data: { ok: false, failure: { message: 'TypeScript error TS2339' } } });
    await runtime.eventBus.publish({ graphId, runId, type: 'node-end',
      source: { kind: 'node', nodeId: 'export-check' }, data: { ok: false, reason: 'required release.loop configuration missing' } });
    const unknownFailure = { graphId, runId, type: 'node-end',
      source: { kind: 'node' as const, nodeId: 'pwa' }, data: { ok: false, reason: 'unrecognized failure detail' } };
    await expect(runtime.eventBus.publish(unknownFailure)).rejects.toThrow('delivery failed');
    await runtime.eventBus.publish({ graphId, runId, type: 'node-end',
      source: { kind: 'node', nodeId: 'pwa' }, data: { ok: false, reason: 'unrecognized failure detail' } });
    expect(runtime.decisions).toHaveLength(4);
    expect(runtime.decisions.map((event) => [event.data?.failureSignature, event.data?.action, event.data?.applied])).toEqual([
      ['ledger-unconfigured', 'open-cell', false], ['type-error', 'attempt-repair', false],
      ['configuration-missing', 'open-cell', false], ['unknown', 'notify-owner', false],
    ]);
    expect(runtime.decisions[1]?.data).toMatchObject({ promotionMode: 'shadow',
      promotionReason: 'live-mode-not-explicit', rollbackReason: 'simulation-only',
      promotionOverlayId: 'stop-heal-ladder-release-type-error' });
    const typeErrorLog = macrophageLogs.find((record) => (record.data as { failureSignature?: string } | undefined)?.failureSignature === 'type-error');
    expect(typeErrorLog?.data).toMatchObject({ promotionMode: 'shadow',
      promotionReason: 'live-mode-not-explicit', rollbackReason: 'simulation-only',
      promotionOverlayId: 'stop-heal-ladder-release-type-error' });
    expect(unknownNotices).toEqual([{ runId, nodeId: 'pwa', detail: 'unrecognized failure detail' }]);
    expect(unknownNoticeAttempts).toBe(2);
  } finally {
    unregisterDebugSink();
    debug.setMirror(previousMirrorEnabled);
    debug.setFileEnabled(previousFileEnabled);
    runtime.dispose(); rmSync(root, { recursive: true, force: true });
  }
});

test('runtime requires explicit live mode for the type-error promotion and logs the final verdict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'macrophage-promotion-mode-'));
  const captured: Array<{ runId?: string; data?: unknown }> = [];
  const previousFileEnabled = debug.isFileEnabled();
  const previousMirrorEnabled = debug.isMirrorEnabled();
  debug.setFileEnabled(false);
  debug.setMirror(true);
  const unregister = debug.registerSink({ name: 'macrophage-promotion-mode-test', emit: (record) => {
    if (record.category === 'release-loop.macrophage' && record.event === 'decision')
      captured.push({ runId: (record.data as { runId?: string } | undefined)?.runId, data: record.data });
  } });
  const explicitLive = createMacrophageRuntime({ runId: 'macro-explicit-live', root, mode: 'live' });
  const defaultMode = createMacrophageRuntime({ runId: 'macro-default-mode', root });
  const typeErrorEvent = (runId: string) => ({ graphId: 'release-loop', runId, type: 'node-end',
    source: { kind: 'node' as const, nodeId: 'verify' }, data: { ok: false, reason: 'TypeScript error TS2339' } });
  try {
    await explicitLive.eventBus.publish(typeErrorEvent('macro-explicit-live'));
    await defaultMode.eventBus.publish(typeErrorEvent('macro-default-mode'));
    expect(explicitLive.decisions[0]?.data).toMatchObject({ promotionMode: 'live', promotionReason: 'type-error-policy-and-overlay-agree',
      rollbackReason: 'none', promotionOverlayId: 'stop-heal-ladder-release-type-error' });
    expect(defaultMode.decisions[0]?.data).toMatchObject({ promotionMode: 'shadow', rollbackReason: 'unknown-mode-setting' });
    expect(captured.find((record) => record.runId === 'macro-explicit-live')?.data).toMatchObject({ promotionMode: 'live',
      promotionReason: 'type-error-policy-and-overlay-agree', rollbackReason: 'none' });
    expect(captured.find((record) => record.runId === 'macro-default-mode')?.data).toMatchObject({ promotionMode: 'shadow',
      rollbackReason: 'unknown-mode-setting' });
  } finally {
    unregister();
    debug.setMirror(previousMirrorEnabled);
    debug.setFileEnabled(previousFileEnabled);
    explicitLive.dispose();
    defaultMode.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown owner notice failure stays in the runner outbox and succeeds on same-run event replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'macrophage-notice-outbox-'));
  const runId = 'macrophage-notice-outbox';
  const graphId = 'macrophage-notice-outbox-graph';
  const graphDir = join(root, 'graphs');
  mkdirSync(graphDir, { recursive: true });
  writeFileSync(join(graphDir, 'recipes.yaml'), 'fail-unknown:\n  command: "fail-unknown"\n');
  const graphPath = join(graphDir, 'release-loop.yaml');
  writeFileSync(graphPath, `graph_id: ${graphId}\nversion: 1\nentry_node: gate\nterminal_nodes: [done]\nnodes:\n  - { node_id: gate, kind: gate, recipe: 'cmd:fail-unknown', max_visits: 1 }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: gate, on: outcome, map: { ok: done, fail: done, error: done } }\n`);
  const bus = createGraphEventBus();
  let attempts = 0;
  const deliveredNotices: Array<{ runId: string; nodeId: string; detail: string }> = [];
  const runtime = createMacrophageRuntime({ runId, graphId, eventBus: bus, mode: 'simulation',
    reportUnknownFailure: (notice) => {
      attempts++;
      if (attempts === 1) throw new Error('temporary notice sink outage');
      deliveredNotices.push(notice);
    } });
  let gateFailed = false;
  let interruptBeforeDone = true;
  const deps = { root, runBash: async () => {
    gateFailed = true;
    return { exitCode: 1, stdout: '', stderr: 'unknown injected failure' };
  },
    beforeNode: () => {
      if (gateFailed && interruptBeforeDone) { interruptBeforeDone = false; throw new Error('simulated interruption with pending notice'); }
    } };
  try {
    await expect(runGraph(graphPath, { runId, eventBus: bus, quiet: true, deps })).rejects.toThrow('simulated interruption with pending notice');
    expect(attempts).toBe(1);
    const resumed = await runGraph(graphPath, { resumeRunId: runId, eventBus: bus, quiet: true, deps });
    expect(attempts).toBe(2);
    expect(deliveredNotices).toEqual([{ runId, nodeId: 'gate', detail: 'unknown injected failure' }]);
    expect(resumed.pendingGraphEvents ?? []).toEqual([]);
    expect(runtime.decisions).toHaveLength(1);
    expect(runtime.decisions[0]?.data).toMatchObject({ failureSignature: 'unknown', action: 'notify-owner', applied: false });
  } finally { runtime.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('a failed phase join matching both subscriptions produces only one inventory decision', async () => {
  const runtime = createMacrophageRuntime({ runId: 'failed-phase-dedupe', mode: 'simulation', inventory: () => [
    { id: 'phase-scrap', kind: 'orphan-worktree', owner: 'seat-owner', evidence: { ownerRunStatus: 'running', ownershipVerified: true } },
  ] });
  try {
    await runtime.eventBus.publish({ graphId: 'release-loop', runId: 'failed-phase-dedupe', type: 'node-end',
      eventId: 'failed-phase-event', source: { kind: 'node', nodeId: 'pre-gate-join' }, data: { ok: false, reason: 'join failed' } });
    expect(runtime.decisions).toHaveLength(1);
    expect(runtime.decisions[0]?.data).toMatchObject({ sourceEventId: 'failed-phase-event', id: 'phase-scrap' });
  } finally { runtime.dispose(); }
});

test('phase event dedupe is recorded only after inventory and decision processing succeeds', async () => {
  let inventoryAttempts = 0;
  const runtime = createMacrophageRuntime({ runId: 'phase-retry', mode: 'simulation', inventory: () => {
    inventoryAttempts++;
    if (inventoryAttempts === 1) throw new Error('inventory temporarily unavailable');
    return [{ id: 'phase-scrap', kind: 'orphan-worktree', owner: 'seat-owner',
      evidence: { ownerRunStatus: 'running', ownershipVerified: true } }];
  } });
  const event = { graphId: 'release-loop', runId: 'phase-retry', eventId: 'phase-retry-event', type: 'node-end',
    source: { kind: 'node' as const, nodeId: 'pre-gate-join' }, data: { ok: true } };
  try {
    await expect(runtime.eventBus.publish(event)).rejects.toThrow('delivery failed');
    await runtime.eventBus.publish(event);
    expect(inventoryAttempts).toBe(2);
    expect(runtime.decisions).toHaveLength(1);
    expect(runtime.decisions[0]?.data).toMatchObject({ sourceEventId: 'phase-retry-event', id: 'phase-scrap' });
  } finally { runtime.dispose(); }
});

test('concurrent duplicate phase delivery does not repeat an in-flight cleanup decision', async () => {
  let releaseCleanup!: () => void;
  let cleanupStarted!: () => void;
  const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  const started = new Promise<void>((resolve) => { cleanupStarted = resolve; });
  let cleanupAttempts = 0;
  const runId = 'phase-concurrent-dedupe';
  const runtime = createMacrophageRuntime({ runId, mode: 'live', inventory: () => [
    { id: 'merged-worktree', kind: 'orphan-worktree', owner: 'seat-owner',
      evidence: { ownerRunStatus: 'done', ownershipVerified: true, mergedMainline: true, worktreePath: '/fake/worktree' } },
  ], liveCleanup: async () => {
    cleanupAttempts++;
    cleanupStarted();
    await cleanupGate;
    return 'simulated removal';
  } });
  const event = { graphId: 'release-loop', runId, type: 'node-end', eventId: 'phase-concurrent-event',
    source: { kind: 'node' as const, nodeId: 'pre-gate-join' }, data: { ok: true } };
  try {
    const first = runtime.eventBus.publish(event);
    await started;
    const duplicate = runtime.eventBus.publish(event);
    releaseCleanup();
    await Promise.all([first, duplicate]);
    expect(cleanupAttempts).toBe(1);
    expect(runtime.decisions).toHaveLength(1);
    expect(runtime.decisions[0]?.data).toMatchObject({ sourceEventId: event.eventId, id: 'merged-worktree', applied: true });
  } finally {
    releaseCleanup();
    runtime.dispose();
  }
});

test('same-run runtime restart restores completed phase-event dedupe from durable state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'macrophage-restart-dedupe-'));
  const runId = 'phase-restart-dedupe';
  const event = { graphId: 'release-loop', runId, eventId: 'phase-restart-event', type: 'node-end',
    source: { kind: 'node' as const, nodeId: 'pre-gate-join' }, data: { ok: true } };
  const inventory = () => [{ id: 'phase-scrap', kind: 'orphan-worktree' as const, owner: 'seat-owner',
    evidence: { ownerRunStatus: 'running' as const, ownershipVerified: true } }];
  const first = createMacrophageRuntime({ runId, root, mode: 'simulation', inventory });
  try {
    await first.eventBus.publish(event);
  } finally { first.dispose(); }
  const resumed = createMacrophageRuntime({ runId, root, mode: 'simulation', inventory });
  try {
    await resumed.eventBus.publish(event);
    expect(resumed.decisions).toHaveLength(0);
  } finally { resumed.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('receipt retry reuses its prepared decision and does not repeat cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'macrophage-receipt-retry-'));
  const runId = 'phase-receipt-retry';
  let cleanupCalls = 0;
  let receiptAttempts = 0;
  const event = { graphId: 'release-loop', runId, eventId: 'phase-receipt-retry-event', type: 'node-end',
    source: { kind: 'node' as const, nodeId: 'pre-gate-join' }, data: { ok: true } };
  const runtime = createMacrophageRuntime({ runId, root, mode: 'live', inventory: () => [
    { id: 'merged-worktree', kind: 'orphan-worktree', owner: 'seat-owner',
      evidence: { ownerRunStatus: 'done', ownershipVerified: true, mergedMainline: true, worktreePath: '/fake/worktree' } },
  ], liveCleanup: () => { cleanupCalls++; return 'removed'; }, writeReceipt: () => {
    receiptAttempts++;
    if (receiptAttempts === 1) throw new Error('receipt disk temporarily unavailable');
  } });
  try {
    await expect(runtime.eventBus.publish(event)).rejects.toThrow('delivery failed');
    await runtime.eventBus.publish(event);
    expect(cleanupCalls).toBe(1);
    expect(receiptAttempts).toBe(2);
    expect(runtime.decisions).toHaveLength(1);
  } finally { runtime.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('simulation observes a dynamically appended gate-repair failure from the real release graph runner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'macrophage-dynamic-repair-sim-'));
  const runId = 'macrophage-dynamic-repair-sim';
  const graphId = 'release-loop';
  const bus = createGraphEventBus();
  const runtime = createMacrophageRuntime({ runId, graphId, eventBus: bus, mode: 'simulation' });
  let gateVisits = 0;
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  try {
    const state = await runGraph(graphPath, { runId, eventBus: bus, quiet: true, input: {
      version: '0.3.6', previousVersion: '0.3.5', gateExecutor: 'pod',
    }, deps: { root, runBash: async (body, options) => {
      if (body.includes('gate-node.ts --json')) {
        gateVisits++;
        return gateVisits === 1
          ? { exitCode: 1, stdout: JSON.stringify({ outcome: 'fail', commit: 'a'.repeat(40), introduced: ['src/example.test.ts > regression'] }), stderr: '' }
          : { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', commit: 'a'.repeat(40), introduced: [] }), stderr: '' };
      }
      if (body.includes('gate-triage-node.ts')) {
        const context = JSON.parse(readFileSync(options.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { input: Record<string, unknown> };
        return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', classification: 'regression', commit: 'a'.repeat(40),
          introduced: ['src/example.test.ts > regression'], gateExecutionId: context.input.adaptiveGateExecutionId }), stderr: '' };
      }
      if (body.includes('gate-repair-node.ts'))
        return { exitCode: 1, stdout: '', stderr: 'TypeScript error TS2339 in repaired file' };
      return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok' }), stderr: '' };
    } } });
    expect(state.path.some((nodeId) => /^gate-repair-[a-f0-9]{12}$/.test(nodeId))).toBe(true);
    expect(runtime.decisions.some((event) => typeof event.data?.sourceNodeId === 'string'
      && event.data.sourceNodeId.startsWith('gate-repair-')
      && event.data?.failureSignature === 'type-error' && event.data?.action === 'attempt-repair'
      && event.data?.applied === false)).toBe(true);
  } finally { runtime.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('subscriber simulation covers six release failure nodes, duplicate delivery, unknown notice, and shadow receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'macrophage-six-node-matrix-'));
  const runId = 'macrophage-six-node-matrix';
  const graphId = 'release-loop';
  const notices: Array<{ runId: string; nodeId: string; detail: string }> = [];
  const runtime = createMacrophageRuntime({ runId, graphId, root, mode: 'simulation',
    reportUnknownFailure: (notice) => { notices.push(notice); } });
  const failures = [
    ['export-check', 'required release-loop configuration missing'],
    ['gate', 'release gate ledger is not configured'],
    ['gate-triage', 'TypeScript error TS2339 in gate-triage'],
    ['gate-repair-0123456789ab', 'TypeScript error TS2345 in gate-repair'],
    ['pwa', 'unrecognized injected release failure'],
    ['verify', 'TypeScript error TS2304 in verification'],
  ] as const;
  try {
    for (const [index, [nodeId, reason]] of failures.entries()) {
      await runtime.eventBus.publish({ graphId, runId, eventId: `failure-${index}`, type: 'node-end',
        source: { kind: 'node', nodeId }, data: { ok: false, reason } });
    }
    await runtime.eventBus.publish({ graphId, runId, eventId: 'failure-triage-distinct-signature', type: 'node-end',
      source: { kind: 'node', nodeId: 'gate-triage' }, data: { ok: false, reason: 'required release.loop configuration missing' } });
    // A second event with the same node/signature must not create a second decision.
    await runtime.eventBus.publish({ graphId, runId, eventId: 'failure-triage-duplicate', type: 'node-end',
      source: { kind: 'node', nodeId: 'gate-triage' }, data: { ok: false, reason: 'TypeScript error TS2339 in gate-triage' } });

    expect(runtime.decisions).toHaveLength(7);
    expect(runtime.decisions.map((event) => [event.data?.sourceNodeId, event.data?.failureSignature,
      event.data?.kind, event.data?.applied])).toEqual([
      ['export-check', 'configuration-missing', 'release-node-failure', false],
      ['gate', 'ledger-unconfigured', 'release-node-failure', false],
      ['gate-triage', 'type-error', 'release-node-failure', false],
      ['gate-repair-0123456789ab', 'type-error', 'release-node-failure', false],
      ['pwa', 'unknown', 'release-node-failure', false],
      ['verify', 'type-error', 'release-node-failure', false],
      ['gate-triage', 'configuration-missing', 'release-node-failure', false],
    ]);
    expect(notices).toEqual([{ runId, nodeId: 'pwa', detail: 'unrecognized injected release failure' }]);

    const receiptPath = join(root, 'graph-runs', 'release-loop', `${runId}.json.contexts`, 'macrophage.jsonl');
    const receipts = readFileSync(receiptPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(receipts.map((receipt) => [receipt.data.sourceEventId, receipt.data.sourceNodeId,
      receipt.data.failureSignature, receipt.data.kind, receipt.data.applied])).toEqual([
      ['failure-0', 'export-check', 'configuration-missing', 'release-node-failure', false],
      ['failure-1', 'gate', 'ledger-unconfigured', 'release-node-failure', false],
      ['failure-2', 'gate-triage', 'type-error', 'release-node-failure', false],
      ['failure-3', 'gate-repair-0123456789ab', 'type-error', 'release-node-failure', false],
      ['failure-4', 'pwa', 'unknown', 'release-node-failure', false],
      ['failure-5', 'verify', 'type-error', 'release-node-failure', false],
      ['failure-triage-distinct-signature', 'gate-triage', 'configuration-missing', 'release-node-failure', false],
    ]);
  } finally { runtime.dispose(); rmSync(root, { recursive: true, force: true }); }
});
