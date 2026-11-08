import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createGraphEventBus, type GraphEvent } from '../../src/graph-runner/graph-events.js';
import { createMacrophageRuntime } from '../../src/release-loop/macrophage-heal-node.js';
import type { MacrophageScrap } from '../../src/release-loop/macrophage-heal.js';
import { registerAdaptiveGateHealAdapter, RELEASE_GATE_FAILED_EVENT, type AdaptiveGateHealAppendNodeRequest } from './adaptive-gate-heal-adapter.js';
import type { GateResult } from './gate-types.js';
import { classifyGateShadow } from './gate-triage-node.js';

interface Scenario {
  run: { graphId: string; runId: string; mode: 'simulation' };
  inject: Array<{ event: string; sourceNode: string; data: Record<string, unknown> }>;
  expect: {
    deliveries: Array<{ event: string; subscriber: string; action: string }>;
    append: { afterNodeId: 'gate-triage'; resumeFromPrefix: string; rerunGateAt: 'gate' };
    macrophage: { id: string; action: string; status: string; applied: boolean };
  };
}

test('N22 sim: ARG repair and macrophage healing consume one release graph event bus', async () => {
  const scenario = parseYaml(readFileSync(join(import.meta.dir, '../../scenarios/ux-sim/release-heal-macrophage-bus.yaml'), 'utf8')) as Scenario;
  const bus = createGraphEventBus({ now: () => new Date('2026-11-06T00:00:00.000Z') });
  const deliveries: Array<{ event: string; subscriber: string; action: string }> = [];
  const appendRequests: AdaptiveGateHealAppendNodeRequest[] = [];
  const recorded: GraphEvent[] = [];
  bus.subscribe((event) => { recorded.push(event); });
  const macrophage = createMacrophageRuntime({ graphId: scenario.run.graphId, runId: scenario.run.runId, eventBus: bus,
    mode: scenario.run.mode, inventory: (event) => (event.data?.macrophageScraps ?? []) as MacrophageScrap[] });
  const disposeArg = registerAdaptiveGateHealAdapter(bus, { graphId: scenario.run.graphId, runId: scenario.run.runId }, {
    onPlan: (plan, event) => { deliveries.push({ event: event.type, subscriber: 'adaptive-gate-heal', action: plan.disposition.action }); },
    appendNode: async (request) => {
      appendRequests.push(request);
      return { disposition: 'appended', graphRevision: 2 };
    },
  });
  const disposeMacrophageObserver = bus.subscribe((event) => {
    if (event.type === 'release.macrophage.decision')
      deliveries.push({ event: event.type, subscriber: 'simulation-ledger', action: 'plan-only' });
  });
  try {
    for (const injected of scenario.inject) {
      if (injected.event === RELEASE_GATE_FAILED_EVENT) {
        const gate = { outcome: injected.data.outcome, commit: injected.data.commit, introduced: injected.data.introduced,
          preexisting: 0, fixed: null, knownEnv: 0, knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 1 } as GateResult;
        await bus.publish({ graphId: scenario.run.graphId, runId: scenario.run.runId, type: injected.event,
          source: { kind: 'node', nodeId: injected.sourceNode }, data: { version: injected.data.version, gate,
            triage: classifyGateShadow(gate), visitState: injected.data.visitState } });
      } else {
        await bus.publish({ graphId: scenario.run.graphId, runId: scenario.run.runId, type: injected.event,
          source: { kind: 'node', nodeId: injected.sourceNode }, data: injected.data });
      }
    }
    await bus.publish({ graphId: 'foreign-release-graph', runId: scenario.run.runId, type: 'node-end',
      source: { kind: 'node', nodeId: 'pre-gate-join' }, data: { macrophageScraps: [{ id: 'foreign', kind: 'stale-draft', evidence: { draftAction: 'close' } }] } });
    await bus.publish({ graphId: scenario.run.graphId, runId: 'foreign-release-run', type: RELEASE_GATE_FAILED_EVENT,
      source: { kind: 'node', nodeId: 'gate-triage' } });
    await bus.flush({ graphId: scenario.run.graphId, runId: scenario.run.runId });
    expect(deliveries).toEqual(scenario.expect.deliveries);
    expect(appendRequests).toHaveLength(1);
    const request = appendRequests[0]!;
    expect(request.graphId).toBe(scenario.run.graphId);
    expect(request.runId).toBe(scenario.run.runId);
    expect(request.afterNodeId).toBe(scenario.expect.append.afterNodeId);
    expect(typeof request.resumeFrom).toBe('string');
    expect(request.resumeFrom.startsWith(scenario.expect.append.resumeFromPrefix)).toBe(true);
    expect(request.rerunGateAt).toBe(scenario.expect.append.rerunGateAt);
    expect(request.resumeFrom).toBe(request.node.nodeId);
    expect(macrophage.decisions).toHaveLength(1);
    expect(macrophage.decisions[0]).toMatchObject({ sequence: 2, type: 'release.macrophage.decision',
      data: { id: scenario.expect.macrophage.id, action: scenario.expect.macrophage.action, status: scenario.expect.macrophage.status,
        applied: scenario.expect.macrophage.applied,
        sourceEventId: recorded[0]?.eventId, phaseNodeId: 'pre-gate-join' } });
    expect(recorded.map(({ type }) => type)).toEqual(['node-end', 'release.macrophage.decision', RELEASE_GATE_FAILED_EVENT, 'node-end', RELEASE_GATE_FAILED_EVENT]);
    expect(recorded.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5]);
    const eventIds = recorded.map(({ eventId }) => eventId);
    expect(eventIds.every((eventId) => typeof eventId === 'string' && eventId.length > 0)).toBe(true);
    expect(new Set(eventIds).size).toBe(eventIds.length);
  } finally {
    disposeMacrophageObserver();
    disposeArg();
    macrophage.dispose();
  }
});
