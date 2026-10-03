// NEXUS · workflow-run lifecycle ↔ NexusEventBus bridge
// (Session §15.8(b) follow-up · 2026-05-08)
//
// Mirrors `workflow-event-bridge.ts` (#1998) but for the run-execution
// lifecycle, not just approval frames. The Nexus REST runner spawns a
// background async generator (see `handleWorkflowRunStart` in
// `workflows.ts`); each event from that generator is forwarded here →
// `bus.publish` so the SSE stream + PWA invalidation can react.
//
// Surfaced kinds (matches `NexusEvent.kind` union):
//
//   workflow.run.started      — runWorkflow yielded `workflow_start`
//   workflow.run.node-started — runWorkflow yielded `node_start`
//   workflow.run.node-done    — runWorkflow yielded `node_done`
//   workflow.run.completed    — runWorkflow yielded `workflow_done`
//   workflow.run.failed       — runWorkflow yielded `workflow_failed`
//
// Once the PWA subscribes (`?topics=workflow.run.`) the existing 1s
// poll on `useWorkflowRun` + `useWorkflowRuns` becomes redundant and
// can be relaxed to a 30s safety net.

import type { NexusEventBus } from './event-bus.js';
import type { WorkflowEvent } from '../../workflow-runtime/types.js';

let runEventBus: NexusEventBus | null = null;

/** Wire a bus that future `publishWorkflowRunEvent` calls fan out to.
 *  Pass `null` to clear. Called once at NEXUS boot, mirroring the
 *  approval bridge wire. */
export function setWorkflowRunEventBus(bus: NexusEventBus | null): void {
  runEventBus = bus;
}

type WorkflowRunKind =
  | 'workflow.run.started'
  | 'workflow.run.node-started'
  | 'workflow.run.node-skipped'
  | 'workflow.run.node-done'
  | 'workflow.run.completed'
  | 'workflow.run.failed';

/** Map a runtime event into the matching `workflow.run.*` kind. Returns
 *  null for events we don't surface (defensive — the runtime may add
 *  new event types in the future without breaking the bridge). */
function kindForEvent(evt: WorkflowEvent): WorkflowRunKind | null {
  switch (evt.type) {
    case 'workflow_start':  return 'workflow.run.started';
    case 'node_start':      return 'workflow.run.node-started';
    case 'node_skipped':    return 'workflow.run.node-skipped';
    case 'node_done':       return 'workflow.run.node-done';
    case 'workflow_done':   return 'workflow.run.completed';
    case 'workflow_failed': return 'workflow.run.failed';
    default:                return null;
  }
}

/** Publish a runtime event to the wired bus. No-op when the bus is
 *  unwired (e.g. unit tests that exercise the runner without booting
 *  NEXUS). The detail payload always includes `runId` + `workflowName`
 *  so PWA subscribers can route invalidations without re-fetching. */
export function publishWorkflowRunEvent(
  ctx: { runId: string; workflowName: string },
  evt: WorkflowEvent,
): void {
  if (!runEventBus) return;
  const kind = kindForEvent(evt);
  if (!kind) return;

  // Per-event detail — keep the shape narrow so PWA can rely on a
  // stable contract. Heavy payloads (full output bodies, partial
  // dumps) stay server-side; clients refetch via the existing GET
  // /v1/workflows/runs/<id> endpoint when they need them.
  const detail: Record<string, unknown> = {
    runId: ctx.runId,
    workflowName: ctx.workflowName,
    ...(evt.mode !== undefined ? { mode: evt.mode } : {}),
  };
  if (evt.type === 'node_start' || evt.type === 'node_skipped' || evt.type === 'node_done') {
    detail.nodeId = evt.nodeId;
  }
  if (evt.type === 'node_done') {
    detail.ok = evt.result.ok;
  }
  if (evt.type === 'node_skipped') {
    detail.reason = evt.reason;
  }
  if (evt.type === 'workflow_failed') {
    detail.error = evt.error;
  }

  try {
    runEventBus.publish({ ts: Date.now(), kind, detail });
  } catch {
    // Bus publish swallows listener throws internally; this catch is
    // belt-and-suspenders for the .publish() call itself.
  }
}
