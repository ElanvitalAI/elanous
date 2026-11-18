// Fake event scripts for GRAPH-LOOP-VIEW (UX pack «graph-live» and tests). Not production data: they exercise the
// grammar — three parallel lanes with a failed lane retried, a two-round ARG loop inside a node, and a waiting
// checkpoint — for app_build and a release run. Times are offsets from a fixed fake clock, never the wall clock.
import type { GraphViewEvent } from './model.js';

const T0 = Date.parse('2026-11-17T00:00:00Z');
const at = (seconds: number) => T0 + seconds * 1000;

export const GRAPH_VIEW_SIM_NOW = at(161);

export const APP_BUILD_SIM_EVENTS: readonly GraphViewEvent[] = [
  { type: 'loop.started', loopId: 'ab1', at: at(0), kind: 'app_build', lead: 'openai-codex/gpt-6-sol', title: 'concert tickets' },
  ...(['intent', 'arch', 'code', 'mock data', 'deploy'] as const).map((label) => ({
    type: 'stage.changed' as const, loopId: 'ab1', at: at(1), stage: label.replace(' ', '-'), label, status: 'queued' as const })),
  { type: 'stage.changed', loopId: 'ab1', at: at(2), stage: 'intent', status: 'running' },
  { type: 'stage.changed', loopId: 'ab1', at: at(8), stage: 'intent', status: 'done' },
  { type: 'stage.changed', loopId: 'ab1', at: at(9), stage: 'arch', status: 'running' },
  // ARG inside «arch»: two rounds of draft → critique → revise.
  ...[1, 2].flatMap((round): GraphViewEvent[] => {
    const id = `ab1-arch-r${round}`;
    const base = 10 + (round - 1) * 20;
    return [
      { type: 'loop.started', loopId: id, at: at(base), kind: 'arg', lead: 'arg', parentLoopId: 'ab1', parentNode: 'arch', round },
      { type: 'stage.changed', loopId: id, at: at(base + 1), stage: 'draft', status: 'done' },
      { type: 'stage.changed', loopId: id, at: at(base + 5), stage: 'critique', status: 'done' },
      { type: 'stage.changed', loopId: id, at: at(base + 9), stage: 'revise', status: round === 1 ? 'done' : 'done' },
      { type: 'loop.ended', loopId: id, at: at(base + 12), status: 'done' },
    ];
  }),
  { type: 'decision.made', loopId: 'ab1', at: at(41), question: 'architecture settled?', choice: 'yes', confidence: 0.92, route: 'model' },
  { type: 'stage.changed', loopId: 'ab1', at: at(42), stage: 'arch', status: 'done' },
  { type: 'stage.changed', loopId: 'ab1', at: at(43), stage: 'code', status: 'running' },
  // Three parallel lanes joining into «mock data»; the api lane fails once and is retried.
  ...(['ui', 'api', 'tests'] as const).map((lane) => ({ type: 'worker.changed' as const, loopId: 'ab1', at: at(44), worker: `code-${lane}`,
    model: 'gpt-6-sol', stage: 'code', lane, joinTo: 'mock-data', status: 'running' as const, progress: 0 })),
  { type: 'worker.changed', loopId: 'ab1', at: at(90), worker: 'code-ui', status: 'done', progress: 1 },
  { type: 'worker.changed', loopId: 'ab1', at: at(95), worker: 'code-api', status: 'failed' },
  { type: 'decision.made', loopId: 'ab1', at: at(96), question: 'api lane failed', choice: 'retry', route: 'code' },
  { type: 'worker.changed', loopId: 'ab1', at: at(97), worker: 'code-api', status: 'running', progress: 0.4 },
  { type: 'worker.changed', loopId: 'ab1', at: at(150), worker: 'code-tests', status: 'running', progress: 0.7 },
  { type: 'checkpoint.changed', loopId: 'ab1', at: at(155), checkpoint: 'deploy:approval', status: 'waiting', actor: 'owner', summary: 'publish approval' },
];

export const RELEASE_SIM_EVENTS: readonly GraphViewEvent[] = [
  { type: 'loop.started', loopId: 'rel1', at: at(0), kind: 'release', lead: 'REL', title: '0.3.28' },
  ...(['cut', 'gate', 'rehearsal', 'publish', 'rail'] as const).map((stage) => ({
    type: 'stage.changed' as const, loopId: 'rel1', at: at(1), stage, status: 'queued' as const })),
  { type: 'stage.changed', loopId: 'rel1', at: at(2), stage: 'cut', status: 'done' },
  { type: 'stage.changed', loopId: 'rel1', at: at(3), stage: 'gate', status: 'running' },
  // Gate shards as three parallel lanes; shard-2 fails and is retried.
  ...([1, 2, 3] as const).map((shard) => ({ type: 'worker.changed' as const, loopId: 'rel1', at: at(4), worker: `shard-${shard}`,
    stage: 'gate', lane: `shard-${shard}`, joinTo: 'rehearsal', status: 'running' as const, progress: 0 })),
  { type: 'worker.changed', loopId: 'rel1', at: at(60), worker: 'shard-1', status: 'done' },
  { type: 'worker.changed', loopId: 'rel1', at: at(61), worker: 'shard-2', status: 'failed' },
  { type: 'decision.made', loopId: 'rel1', at: at(62), question: 'new failure names vs base', choice: 'retry shard', route: 'code' },
  { type: 'worker.changed', loopId: 'rel1', at: at(63), worker: 'shard-2', status: 'running', progress: 0.5 },
  { type: 'worker.changed', loopId: 'rel1', at: at(70), worker: 'shard-3', status: 'done' },
  { type: 'checkpoint.changed', loopId: 'rel1', at: at(80), checkpoint: 'publish', status: 'waiting', actor: 'JUD', summary: 'signature' },
];

/** app_build carried to the end: lanes join, data and deploy pass, the owner approves, the loop ends (개정 4 fold). */
export const APP_BUILD_SIM_DONE_EVENTS: readonly GraphViewEvent[] = [
  ...APP_BUILD_SIM_EVENTS,
  { type: 'worker.changed', loopId: 'ab1', at: at(200), worker: 'code-api', status: 'done', progress: 1 },
  { type: 'worker.changed', loopId: 'ab1', at: at(210), worker: 'code-tests', status: 'done', progress: 1 },
  { type: 'stage.changed', loopId: 'ab1', at: at(211), stage: 'code', status: 'done' },
  { type: 'stage.changed', loopId: 'ab1', at: at(212), stage: 'mock-data', status: 'done' },
  { type: 'stage.changed', loopId: 'ab1', at: at(300), stage: 'deploy', status: 'running' },
  { type: 'checkpoint.changed', loopId: 'ab1', at: at(360), checkpoint: 'deploy:approval', status: 'passed', actor: 'owner', summary: 'deploy' },
  { type: 'stage.changed', loopId: 'ab1', at: at(370), stage: 'deploy', status: 'done' },
  { type: 'loop.ended', loopId: 'ab1', at: at(372), status: 'done' },
];
export const GRAPH_VIEW_SIM_DONE_NOW = at(380);

const HARNESS_STAGES = ['plan', 'impl', 'test', 'pr'] as const;
const child = (loopId: string, title: string, lead: string, start: number, statuses: readonly ('done' | 'running' | 'failed' | 'queued')[], round = 1): GraphViewEvent[] => [
  // 개정 5: each child names its PTY (fake ids; the detail sidetab reads that PTY's snapshot read-only).
  { type: 'loop.started', loopId, at: at(start), kind: 'harness-child', lead, title, parentLoopId: 'h1', round, ptyId: `pty-${loopId}` },
  ...HARNESS_STAGES.map((stage, index) => ({ type: 'stage.changed' as const, loopId, at: at(start + index + 1), stage, status: statuses[index] ?? 'queued' })),
];

/** Harness with three children: one done, one running, one that failed its tests and is retried as round 2 (개정 4). */
export const HARNESS_SIM_EVENTS: readonly GraphViewEvent[] = [
  { type: 'loop.started', loopId: 'h1', at: at(0), kind: 'harness', lead: 'OP', title: 'ELN-QUEUE cells' },
  ...child('h1-a', 'queue-state', 'gpt-6-sol', 1, ['done', 'done', 'done', 'done']),
  { type: 'loop.ended', loopId: 'h1-a', at: at(60), status: 'done' },
  ...child('h1-b', 'queue-controls', 'claude-opus', 2, ['done', 'running']),
  ...child('h1-c', 'child-notice', 'glm-5', 3, ['done', 'done', 'failed']),
  { type: 'loop.ended', loopId: 'h1-c', at: at(40), status: 'failed' },
  ...child('h1-c2', 'child-notice', 'glm-5', 41, ['done', 'done', 'running'], 2),
];

/** The harness after every child finished (개정 4: a finished block folds to one line). */
export const HARNESS_SIM_DONE_EVENTS: readonly GraphViewEvent[] = [
  ...HARNESS_SIM_EVENTS,
  ...(['test', 'pr'] as const).map((stage, index) => ({ type: 'stage.changed' as const, loopId: 'h1-b', at: at(200 + index), stage, status: 'done' as const })),
  { type: 'stage.changed', loopId: 'h1-b', at: at(199), stage: 'impl', status: 'done' },
  { type: 'loop.ended', loopId: 'h1-b', at: at(205), status: 'done' },
  { type: 'stage.changed', loopId: 'h1-c2', at: at(210), stage: 'test', status: 'done' },
  { type: 'stage.changed', loopId: 'h1-c2', at: at(211), stage: 'pr', status: 'done' },
  { type: 'loop.ended', loopId: 'h1-c2', at: at(212), status: 'done' },
  { type: 'loop.ended', loopId: 'h1', at: at(213), status: 'done' },
];

/** The retried child's PTY screen as a fake snapshot (개정 5 child detail: shown read-only, never written to). */
export const HARNESS_SIM_CHILD_PTY: readonly string[] = [
  '$ bun test src/tui/child-notice.test.ts',
  '(pass) notice keeps arrival order',
  '(fail) notice survives a resize',
  ' 1 pass',
  ' 1 fail',
];
