import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { debug } from '../debug/log.js';
import { LogStore, StoreSink } from '../mss/logging/log-store.js';
import { runSelfImplement } from '../self-implement/orchestrator.js';
import type { GraphOverlaySpec } from '../self-implement/graph-overlay-yaml.js';
import { parseGraphOverlayYaml } from '../self-implement/graph-overlay-yaml.js';
import { seams } from '../self-implement/test-seams.js';
import { buildRunTraversal } from '../nexus/api/harness-traversal.js';
import { appendRunLedgerEntry, loadRunLedger } from '../self-implement/run-ledger.js';

const [stateRoot, runId, instance, goalId] = process.argv.slice(2);
if (!stateRoot || !runId || !instance) throw new Error('state root, runId, and log instance are required');
if (process.env.ELANOUS_STATE_DIR !== stateRoot) throw new Error('worker state root must be pinned in its process environment');
const scenarioId = instance.split(':')[1] ?? '';

const isDemoResearchArg = scenarioId === 'demo1104-research-arg-graph';
const overlayPath = isDemoResearchArg
  ? 'graphs/overlays/examples/demo1104-research-arg-runtime.yaml'
  : undefined;
const overlayId = isDemoResearchArg ? 'demo1104-research-arg-runtime' : 'ux-sim-event-stream-runtime-overlay';
const dropRuntimeEventForTest = process.env.ELANOUS_UX_SIM_TEST_FAULT === 'drop-runtime-graph-event';
const overlay: GraphOverlaySpec = overlayPath
  ? (() => {
    const parsed = parseGraphOverlayYaml(readFileSync(overlayPath, 'utf8'), overlayPath);
    if (parsed.errors.length || parsed.overlays.length !== 1) throw new Error(`invalid demo ARG overlay: ${JSON.stringify(parsed.errors)}`);
    return parsed.overlays[0]!;
  })()
  : {
  overlayId,
  target: 'self-implement',
  stage: 'runtime',
  // Generic event-stream fixture only. Both scenarios use an explicit isolated goal input.
  appliesWhen: 'goal_id == event_stream_probe',
  patch: [
    { op: 'add', path: '/nodes/-', value: {
      nodeId: 'event-stream-probe', kind: 'judge', recipe: 'observe-only', maxVisits: 1,
      contract: { inputs: ['worktree'], tools: 'read-only', outputs: ['findings'] },
    } },
    { op: 'add', path: '/edges/-', value: { from: 'review', on: 'outcome', map: { source_missing: 'event-stream-probe' } } },
    { op: 'add', path: '/edges/-', value: { from: 'event-stream-probe', to: 'merge' } },
  ],
  };
const store = new LogStore(join(stateRoot, 'logs', 'logs.db'), { instance });
const storeSink = new StoreSink(store, instance, { installExitHandlers: false });
const removeSink = debug.registerSink({
  name: 'mockdev-production-graph-observer',
  emit(record) {
    if (dropRuntimeEventForTest) return;
    if (record.category !== 'self-implement' || record.event !== 'graph-overlay-decision') return;
    const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : {};
    if (data.stage === 'runtime') storeSink.emit(record);
  },
});
try {
  const result = await runSelfImplement({
    runId,
    ...(goalId ? { goalId } : {}),
    feature: 'UX simulation runtime overlay event stream',
    memory: false,
    completion: 'worktree-only',
    graphOverlays: [overlay],
    ...(isDemoResearchArg ? { seams: seams({
      injectedReviewOutcomeForTesting: () => 'source_missing',
      writeRunLedger: (entry) => appendRunLedgerEntry(entry),
    }) } : { seams: seams({ writeRunLedger: (entry) => appendRunLedgerEntry(entry) }) }),
  });
  storeSink.flush();
  const ledger = loadRunLedger(runId) ?? [];
  const graphEvents = buildRunTraversal(runId, ledger).graphEvents ?? [];
  const ledgerRoute = ledger.filter((entry) => entry.event === 'graph.path' && entry.data.event === 'edge-taken')
    .map((entry) => ({ from: entry.data.from, outcome: entry.data.label, to: entry.data.taken, source: entry.data.source,
      injected: entry.data.injected === true, mockOutcome: entry.data.mockOutcome }));
  console.log(`MOCKDEV_GRAPH_EVENT_RESULT=${JSON.stringify({ ok: result.ok, graphEvents, ledgerRoute })}`);
} finally {
  removeSink();
  storeSink.flush();
  store.close();
}
