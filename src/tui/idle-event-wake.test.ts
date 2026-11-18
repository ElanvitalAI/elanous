import { expect, test } from 'bun:test';
import type { PendingTaskNotification } from '../agent/task-notification.js';
import type { GraphProgressObservation } from '../graph-runner/graph-progress-observation.js';
import type { GraphRunIdleWake } from '../graph-runner/runner.js';
import { createIdleEventWake, graphNodeEndNotice, graphRunIdleNotice, idleChildLabel } from './idle-event-wake.js';

const wake = { name: 'queue-wake' };

function child(over: Partial<PendingTaskNotification> = {}): PendingTaskNotification {
  return {
    taskId: 't1', agentName: 'agent', state: 'done', output: 'ok', truncated: false,
    durationMs: 1, finishedAt: 1, ...over,
  };
}

function graph(kind: GraphProgressObservation['kind'], dryRun = false): GraphProgressObservation {
  return {
    version: 1, eventId: 'g:r:1', sequence: 1, graphId: 'g', runId: 'run-1234',
    nodeId: 'n1', attempt: 1, at: '2026-11-17T00:00:00.000Z', dryRun, kind,
  };
}

function run(status: GraphRunIdleWake['status'], dryRun = false, nodeId?: string): GraphRunIdleWake {
  return { graphId: 'g', runId: 'run-1234', status, dryRun, ...(nodeId ? { nodeId } : {}) };
}

function seam(busy: boolean) {
  const injectKeys: unknown[] = [];
  const steers: string[] = [];
  const children: { goal: string; outcome: string }[] = [];
  const nodes: string[] = [];
  const runs: string[] = [];
  const door = createIdleEventWake({
    busy: () => busy,
    injectKey: (key) => { injectKeys.push(key); return true; },
    queueWake: wake,
    steer: (text) => { steers.push(text); },
    enqueueChild: (info) => { children.push(info); return { id: 'c' }; },
    enqueueGraphNode: (text) => { nodes.push(text); return { id: 'n' }; },
    enqueueGraphRun: (text) => { runs.push(text); return runs.length > 1 && runs[0] === text ? null : { id: 'r' }; },
    childLabel: idleChildLabel,
    graphNodeText: graphNodeEndNotice,
    graphRunText: graphRunIdleNotice,
  });
  return { door, injectKeys, steers, children, nodes, runs };
}

test('an idle child finish queues the notice and knocks the idle door, never steers', () => {
  const s = seam(false);
  expect(s.door.onChild(child({ label: 'review the diff' }))).toBe(true);
  expect(s.children).toEqual([{ goal: 'review the diff', outcome: 'done' }]);
  expect(s.injectKeys).toEqual([wake]);
  expect(s.steers).toEqual([]);
});

test('a child finish during a turn stays queued and does not knock or steer', () => {
  const s = seam(true);
  expect(s.door.onChild(child())).toBe(false);
  expect(s.children).toEqual([{ goal: 'agent', outcome: 'done' }]);
  expect(s.injectKeys).toEqual([]);
  expect(s.steers).toEqual([]);
});

test('a node end only queues: a dry run and a start queue nothing, and a real end never knocks', () => {
  const s = seam(false);
  expect(s.door.onGraphNode(graph('completed', true))).toBe(false);
  expect(s.door.onGraphNode(graph('started'))).toBe(false);
  expect(s.nodes).toEqual([]);
  expect(s.door.onGraphNode(graph('completed'))).toBe(false);
  expect(s.door.onGraphNode(graph('failed'))).toBe(false);
  expect(s.nodes).toEqual([
    '그래프 노드 끝: g/n1 — 완료',
    '그래프 노드 끝: g/n1 — 실패',
  ]);
  expect(s.injectKeys).toEqual([]);
  expect(s.steers).toEqual([]);
});

test('a finished run knocks once, a dry run and a mid-turn end do not', () => {
  const idle = seam(false);
  expect(idle.door.onGraphRun(run('done', true))).toBe(false);
  expect(idle.runs).toEqual([]);
  expect(idle.door.onGraphRun(run('done'))).toBe(true);
  expect(idle.door.onGraphRun(run('failed'))).toBe(true);
  expect(idle.door.onGraphRun(run('awaiting-approval', false, 'gate'))).toBe(true);
  expect(idle.runs).toEqual([
    '그래프 런 끝: g/run-1234 — 완료',
    '그래프 런 끝: g/run-1234 — 실패',
    '그래프 승인 대기: g/run-1234/gate',
  ]);
  expect(idle.injectKeys).toEqual([wake, wake, wake]);
  expect(idle.steers).toEqual([]);

  const busy = seam(true);
  expect(busy.door.onGraphRun(run('done'))).toBe(false);
  expect(busy.runs).toEqual(['그래프 런 끝: g/run-1234 — 완료']);
  expect(busy.injectKeys).toEqual([]);
});

test('a duplicate run end that the queue refuses does not knock again', () => {
  const s = seam(false);
  s.door.onGraphRun(run('done'));
  expect(s.door.onGraphRun(run('done'))).toBe(false);
  expect(s.injectKeys).toEqual([wake]);
});

test('child label prefers the caller label and falls back to the agent name', () => {
  expect(idleChildLabel(child({ label: '  a   long label  ' }))).toBe('a long label');
  expect(idleChildLabel(child({ label: '   ' }))).toBe('agent');
});
