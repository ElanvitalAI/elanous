// §15.8(b) — verify workflow-run lifecycle events fan out as
// workflow.run.* SSE kinds via the NexusEventBus bridge.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { NexusEventBus } from '../src/nexus/api/event-bus.js';
import {
  publishWorkflowRunEvent,
  setWorkflowRunEventBus,
} from '../src/nexus/api/workflow-run-event-bridge.js';
import type { NexusEvent } from '../src/nexus/state/state.js';
import type { WorkflowEvent } from '../src/workflow-runtime/types.js';

let bus: NexusEventBus;

beforeEach(() => {
  bus = new NexusEventBus();
  setWorkflowRunEventBus(bus);
});

afterEach(() => {
  setWorkflowRunEventBus(null);
});

function collect(prefix: string): NexusEvent[] {
  const out: NexusEvent[] = [];
  bus.subscribe((ev) => out.push(ev), [prefix]);
  return out;
}

const ctx = { runId: 'wf-test-001', workflowName: 'demo' };

describe('publishWorkflowRunEvent (§15.8(b))', () => {
  it('maps workflow_start → workflow.run.started', () => {
    const events = collect('workflow.run.');
    const evt: WorkflowEvent = {
      type: 'workflow_start',
      workflow: 'demo',
      runId: 'wf-test-001',
    };
    publishWorkflowRunEvent(ctx, evt);
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe('workflow.run.started');
    expect(events[0]!.detail).toMatchObject({
      runId: 'wf-test-001',
      workflowName: 'demo',
    });
    expect(events[0]!.detail).not.toHaveProperty('mode');
  });

  it('publishes the known runtime mode without guessing missing ones', () => {
    const events = collect('workflow.run.');
    publishWorkflowRunEvent(ctx, { type: 'workflow_start', workflow: 'demo', runId: ctx.runId, mode: 'test' });
    expect(events[0]!.detail).toMatchObject({ mode: 'test' });
  });

  it('maps node_start → workflow.run.node-started with nodeId', () => {
    const events = collect('workflow.run.');
    publishWorkflowRunEvent(ctx, {
      type: 'node_start',
      nodeId: 'analyze',
      nodeType: 'prompt',
    });
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe('workflow.run.node-started');
    expect(events[0]!.detail).toMatchObject({
      runId: 'wf-test-001',
      workflowName: 'demo',
      nodeId: 'analyze',
    });
  });

  it('maps node_done → workflow.run.node-done with ok flag', () => {
    const events = collect('workflow.run.');
    publishWorkflowRunEvent(ctx, {
      type: 'node_done',
      nodeId: 'gather-diff',
      result: { output: 'stdout body', ok: true, durationMs: 12 },
    });
    expect(events.length).toBe(1);
    const detail = events[0]!.detail as Record<string, unknown>;
    expect(detail.runId).toBe('wf-test-001');
    expect(detail.nodeId).toBe('gather-diff');
    expect(detail.ok).toBe(true);
    // Body of `result` (output, durationMs) intentionally NOT in detail
    // to keep the SSE frame small — clients refetch via GET /runs/<id>.
    expect('output' in detail).toBe(false);
    expect('result' in detail).toBe(false);
  });

  it('maps node_skipped → workflow.run.node-skipped with reason', () => {
    const events = collect('workflow.run.');
    publishWorkflowRunEvent(ctx, {
      type: 'node_skipped',
      nodeId: 'b-branch',
      reason: 'when clause false',
    });
    expect(events[0]!.kind).toBe('workflow.run.node-skipped');
    expect(events[0]!.detail).toMatchObject({
      nodeId: 'b-branch',
      reason: 'when clause false',
    });
  });

  it('maps workflow_done → workflow.run.completed', () => {
    const events = collect('workflow.run.');
    publishWorkflowRunEvent(ctx, { type: 'workflow_done', outputs: {} });
    expect(events[0]!.kind).toBe('workflow.run.completed');
  });

  it('maps workflow_failed → workflow.run.failed with error', () => {
    const events = collect('workflow.run.');
    publishWorkflowRunEvent(ctx, {
      type: 'workflow_failed',
      error: 'cycle detected',
      partial: {},
    });
    expect(events[0]!.kind).toBe('workflow.run.failed');
    expect(events[0]!.detail).toMatchObject({
      runId: 'wf-test-001',
      error: 'cycle detected',
    });
  });

  it('no-ops cleanly when bus is unwired (e.g. unit tests)', () => {
    setWorkflowRunEventBus(null);
    // Should not throw
    publishWorkflowRunEvent(ctx, {
      type: 'workflow_start',
      workflow: 'demo',
      runId: 'wf-test-001',
    });
  });

  it('topic prefix workflow.run. matches every kind without leaking to workflow.approval.', () => {
    const runEvents = collect('workflow.run.');
    const approvalEvents = collect('workflow.approval.');

    const evts: WorkflowEvent[] = [
      { type: 'workflow_start', workflow: 'demo', runId: 'wf-test-001' },
      { type: 'node_start', nodeId: 'a', nodeType: 'bash' },
      { type: 'node_done', nodeId: 'a', result: { output: '', ok: true, durationMs: 1 } },
      { type: 'workflow_done', outputs: {} },
    ];
    for (const e of evts) publishWorkflowRunEvent(ctx, e);

    expect(runEvents.length).toBe(4);
    expect(approvalEvents.length).toBe(0);
  });
});
