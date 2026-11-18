import { expect, test } from 'bun:test';
import type { GraphProgressObservation } from '../graph-runner/graph-progress-observation.js';
import { projectGraphLoopViews } from './model.js';
import { renderGraphViewInline } from './render.js';
import { createRunnerProgressProjector } from './runner-progress.js';
import { graphViewShowsBlock, graphViewShowsHint, graphViewSurfaceMode, graphViewTurnLines } from './surface.js';

const T0 = Date.parse('2026-11-17T00:00:00.000Z');
let sequence = 0;
const observation = (nodeId: string, kind: GraphProgressObservation['kind'], seconds: number, attempt = 1): GraphProgressObservation => {
  sequence += 1;
  return { version: 1, eventId: `absorb-ingest:run-1:${sequence}`, sequence, graphId: 'absorb-ingest', runId: 'run-1',
    nodeId, attempt, at: new Date(T0 + seconds * 1000).toISOString(), dryRun: false, kind };
};

test('runner observations project to one loop whose stages are the nodes seen; settle ends it', () => {
  const projector = createRunnerProgressProjector();
  projector.observe(observation('docparse', 'started', 0));
  projector.observe(observation('docparse', 'completed', 1));
  projector.observe(observation('save', 'started', 2));
  const running = projectGraphLoopViews(projector.events).get('absorb-ingest:run-1')!;
  expect(running.stages.map((stage) => [stage.id, stage.status])).toEqual([['docparse', 'done'], ['save', 'running']]);
  expect(renderGraphViewInline(running, 100, { nowMs: T0 + 3000 })[0]).toBe('⎇ absorb-ingest · run-1');
  projector.observe(observation('save', 'completed', 3));
  projector.settle(T0 + 4000);
  const done = projectGraphLoopViews(projector.events).get('absorb-ingest:run-1')!;
  expect(done.status).toBe('done');
  expect(renderGraphViewInline(done, 100, { nowMs: T0 + 5000 })).toEqual(['✓ absorb-ingest · run-1 · 2/2 stages · 4s']);
  // Settling twice, or observing after the end, adds nothing.
  const before = projector.events.length;
  expect(projector.settle(T0 + 6000)).toEqual([]);
  projector.observe(observation('late', 'started', 7));
  expect(projector.events.length).toBe(before);
});

test('a failed then retried node is a retried lane; a turn that ends mid-node is cancelled, a failed node is failed', () => {
  const retried = createRunnerProgressProjector();
  retried.observe(observation('save', 'started', 0));
  retried.observe(observation('save', 'failed', 1));
  retried.observe(observation('save', 'retrying', 2, 2));
  const view = projectGraphLoopViews(retried.events).get('absorb-ingest:run-1')!;
  expect(view.workers.find((worker) => worker.id === 'save')?.retries).toBe(1);
  retried.settle(T0 + 3000);
  expect(projectGraphLoopViews(retried.events).get('absorb-ingest:run-1')!.status).toBe('cancelled');
  const failed = createRunnerProgressProjector();
  failed.observe(observation('save', 'started', 0));
  failed.observe(observation('save', 'failed', 1));
  failed.settle(T0 + 2000);
  const failedView = projectGraphLoopViews(failed.events).get('absorb-ingest:run-1')!;
  expect(failedView.status).toBe('failed');
  // A failed loop keeps the failed node open under its folded line.
  expect(renderGraphViewInline(failedView, 100, { nowMs: T0 + 3000 })).toContain('  ✗ save');
});

test('surface mode: inline by default, the hint only for inline+hint and off, no block for off', () => {
  expect([undefined, '', 'auto-sidetab', 'nonsense'].map(graphViewSurfaceMode)).toEqual(['inline', 'inline', 'inline', 'inline']);
  expect(['inline', 'inline+hint', 'off'].map((value) => graphViewSurfaceMode(value))).toEqual(['inline', 'inline+hint', 'off']);
  expect((['inline', 'inline+hint', 'off'] as const).map((mode) => [graphViewShowsBlock(mode), graphViewShowsHint(mode)]))
    .toEqual([[true, false], [true, true], [false, true]]);
  expect(graphViewTurnLines([], 100, Number.POSITIVE_INFINITY, T0)).toEqual([]);
});
