import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { LogStore, StoreSink } from '../mss/logging/log-store.js';
import type { GraphOverlaySpec } from '../self-implement/graph-overlay-yaml.js';
import { runSelfImplement } from '../self-implement/orchestrator.js';
import { seams } from '../self-implement/test-seams.js';

const [stateRoot, runId, instance] = process.argv.slice(2);
if (!stateRoot || !runId || !instance) throw new Error('state root, runId, and log instance are required');
if (process.env.ELANOUS_STATE_DIR !== stateRoot) throw new Error('worker state root must be pinned in its process environment');

const overlayId = 'ux-sim-event-stream-runtime-overlay';
const dropRuntimeEventForTest = process.env.ELANOUS_UX_SIM_TEST_FAULT === 'drop-runtime-graph-event';
const overlay: GraphOverlaySpec = {
  overlayId,
  target: 'self-implement',
  stage: 'runtime',
  appliesWhen: 'attempts >= 0',
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
    feature: 'UX simulation runtime overlay event stream',
    memory: false,
    completion: 'worktree-only',
    graphOverlays: [overlay],
    seams: seams({}),
  });
  storeSink.flush();
  console.log(`MOCKDEV_GRAPH_EVENT_RESULT=${JSON.stringify({ ok: result.ok })}`);
} finally {
  removeSink();
  storeSink.flush();
  store.close();
}
