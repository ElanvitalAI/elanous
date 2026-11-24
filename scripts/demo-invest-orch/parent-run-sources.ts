// The graph runner executes every fan-out branch as a child run with its own runId. The els graph tab (dashboard, #39957)
// watches ONE run, so without help the 23 parallel nodes of the invest demo would open as 23 separate run tabs and the
// parent tab would show no cards. These sources sit between the runner's process-wide listeners and the els producer:
// a branch node's start/end and its `runtime=… model=… · <last line>` progress notes are re-addressed to the parent run
// (the run whose first node is `plan`); each child run's own terminal node and run-end are dropped. Observation only —
// the run ledgers are untouched.
import type { GraphNodeLifecycleEvent, GraphNodeProgressNotice, GraphRunIdleWake } from '../../src/graph-runner/runner.js';

export interface ParentRunSources {
  readonly onLifecycle: (listener: (event: GraphNodeLifecycleEvent) => void) => () => void;
  readonly onProgress: (listener: (notice: GraphNodeProgressNotice) => void) => () => void;
  readonly onRunEnd: (listener: (wake: GraphRunIdleWake) => void) => () => void;
}

export function parentRunSources(graphId: string, entryNode: string, base: ParentRunSources): ParentRunSources {
  let parentRunId: string | undefined;
  const isTerminal = (nodeId: string) => nodeId === 'done' || nodeId === 'failed';
  /** undefined = drop; otherwise the run id the viewer should see. */
  const route = (event: { graphId: string; runId: string; nodeId?: string }): string | undefined => {
    if (event.graphId !== graphId) return event.runId;
    if (!parentRunId && event.nodeId === entryNode) parentRunId = event.runId;
    if (!parentRunId || event.runId === parentRunId) return event.runId;
    return event.nodeId === undefined || isTerminal(event.nodeId) ? undefined : parentRunId;
  };
  return {
    onLifecycle: (listener) => base.onLifecycle((event) => { const runId = route(event); if (runId) listener(runId === event.runId ? event : { ...event, runId }); }),
    onProgress: (listener) => base.onProgress((notice) => { const runId = route(notice); if (runId) listener(runId === notice.runId ? notice : { ...notice, runId }); }),
    onRunEnd: (listener) => base.onRunEnd((wake) => {
      if (wake.graphId === graphId && parentRunId && wake.runId !== parentRunId) return; // a branch child finished — not the run
      listener(wake);
    }),
  };
}
