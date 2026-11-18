import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GraphEvent } from '../graph-runner/graph-events.js';
import type { GraphProgressObservation } from '../graph-runner/graph-progress-observation.js';
import { graphRunEventLedgerPath } from '../graph-runner/graph-run-event-ledger.js';
import { NODE_HEARTBEAT_EVENT, NODE_HEARTBEAT_QUIET_MS, NODE_PROGRESS_EVENT } from '../graph-runner/node-progress.js';
import { createChildNoticeProducers } from '../tui/core/notice-producers.js';
import { createNextTuiQueue } from '../tui/core/queue.js';
import { createNodeLivenessTui, nodeLivenessFooterLine, nodeLivenessProgressRow, withNodeLivenessToolRow } from './node-liveness-tui.js';
import { NODE_LIVENESS_STALLED_MS } from './node-liveness.js';

const MINUTE = NODE_HEARTBEAT_QUIET_MS;
const T0 = Date.parse('2026-11-17T17:58:00.000Z');
const RUN = { graphId: 'app-build', runId: '891dc068-run' };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function ledgerEvents(): GraphEvent[] {
  const events: GraphEvent[] = [];
  const at = (minute: number) => new Date(T0 + minute * MINUTE).toISOString();
  const push = (minute: number, type: string, nodeId: string, data: Record<string, unknown> = {}) => events.push({
    eventId: `e${events.length + 1}`, sequence: events.length + 1, emittedAt: at(minute), ...RUN, type,
    source: { kind: type === NODE_HEARTBEAT_EVENT ? 'runner' : 'node', nodeId }, data } as GraphEvent);
  push(0, 'node-start', 'grounding'); push(1, 'node-end', 'grounding', { outcome: 'ok' });
  push(1, 'node-start', 'files'); push(10, 'node-end', 'files', { outcome: 'ok' });
  push(10, 'node-start', 'verify-repair');
  for (const [round, start, fail, target] of [[1, 10, 3, 'backend/a.ts'], [2, 25, 2, 'backend/b.ts'],
    [3, 40, 1, 'backend/booking-conflict.test.ts']] as const) {
    push(start, NODE_PROGRESS_EVENT, 'verify-repair', { round, phase: 'verify' });
    push(start + 2, NODE_PROGRESS_EVENT, 'verify-repair', { round, phase: 'test', result: { pass: 9, fail } });
    push(start + 3, NODE_PROGRESS_EVENT, 'verify-repair', { round, phase: 'repair', target, llmCallAt: at(start + 3) });
  }
  return events;
}

function rootWithLedger(events: readonly GraphEvent[] | null): string {
  const root = mkdtempSync(join(tmpdir(), 'node-liveness-tui-'));
  roots.push(root);
  if (events) {
    const path = graphRunEventLedgerPath(root, RUN.graphId, RUN.runId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, events.map(event => JSON.stringify(event) + '\n').join(''));
  }
  return root;
}

const observation: GraphProgressObservation = { version: 1, eventId: 'app-build:891dc068-run:7', sequence: 7, ...RUN,
  nodeId: 'verify-repair', attempt: 1, at: new Date(T0 + 10 * MINUTE).toISOString(), dryRun: false, kind: 'started' };

test('default TUI without a sidetab: the running app_build row becomes the liveness row, the progress row carries the chain', () => {
  const tui = createNodeLivenessTui({ root: rootWithLedger(ledgerEvents()) });
  const now = T0 + 48 * MINUTE;
  expect(tui.view(now)).toBeNull();
  tui.observe(observation, 'app_build');
  const view = tui.view(now);
  // Snapshot of the basic screen's activity: the old `⏺ app_build 2880s` row is replaced, other rows stay.
  expect(withNodeLivenessToolRow(['✓ Read(spec.md)', '⏺ app_build 2880s'], '⏺', view, now)).toEqual([
    '✓ Read(spec.md)',
    '⏺ app_build · verify-repair r3 · 실패 시험 1 · ● 5분 전 수리 호출 · 48m',
    '  ↳ 수리 중 backend/booking-conflict.test.ts',
  ]);
  expect(nodeLivenessProgressRow(view, 100))
    .toBe('⎇ app-build · ✓ grounding ─ ✓ files ─ ◐ verify-repair · r3 · fail 1 · ● 5m');
  // Narrow terminal: one line without the chain.
  expect(nodeLivenessProgressRow(view, 40)).toBe('⎇ app-build · verify-repair r3 · fail 1 · ● 5m');
  // Hint modes keep the runner's footer line and append the liveness part.
  expect(nodeLivenessFooterLine(view, '그래프 app-build/891dc068 · verify-repair 시작 (1회)', 100))
    .toBe('그래프 app-build/891dc068 · verify-repair 시작 (1회) · ✓ grounding ─ ✓ files ─ ◐ verify-repair · r3 · fail 1 · ● 5m');
  // A running row of another tool (a shell call beside the graph) is never rewritten.
  expect(withNodeLivenessToolRow(['⏺ app_build 2880s', '⏺ Bash(bun test) 3s'], '⏺', view, now)[2]).toBe('⏺ Bash(bun test) 3s');
});

test('slow and stalled marks follow the ledger; a stalled node queues exactly one notice, sidetab or not', () => {
  const queue = createNextTuiQueue();
  const notices = createChildNoticeProducers(queue);
  const tui = createNodeLivenessTui({ root: rootWithLedger(ledgerEvents()), onStalled: text => { notices.graphNodeStalled(text); } });
  tui.observe(observation);
  const lastActivity = T0 + 43 * MINUTE;
  expect(nodeLivenessProgressRow(tui.view(lastActivity + 10 * MINUTE), 40)).toBe('⎇ app-build · verify-repair r3 · fail 1 · ◐ 10m');
  expect(queue.items).toHaveLength(0);
  const stalledAt = lastActivity + NODE_LIVENESS_STALLED_MS + MINUTE;
  expect(nodeLivenessProgressRow(tui.view(stalledAt), 40)).toBe('⎇ app-build · verify-repair r3 · fail 1 · ✕ 26m');
  tui.view(stalledAt + MINUTE);
  expect(queue.items.map(item => [item.kind, item.source, item.text])).toEqual([
    ['notice', 'graph-node', '그래프 노드 멎음 ✕ app-build · verify-repair r3 · 26분 무사건'],
  ]);
});

test('no ledger yet: the progress row says «정보 없음» and the tool row keeps its plain form (no fake zeros)', () => {
  const tui = createNodeLivenessTui({ root: rootWithLedger(null) });
  tui.observe(observation, 'app_build');
  const view = tui.view(T0);
  expect(nodeLivenessProgressRow(view, 100)).toBe('⎇ app-build · 정보 없음');
  expect(withNodeLivenessToolRow(['⏺ app_build 12s'], '⏺', view, T0)).toEqual(['⏺ app_build 12s']);
});

test('the ledger is re-read at most every two seconds, an unreadable read keeps the last good one, reset forgets the run', () => {
  let reads = 0;
  let fail = false;
  const events = ledgerEvents();
  const tui = createNodeLivenessTui({ root: '/unused', readEvents: () => { reads++; if (fail) throw new Error('torn'); return events; } });
  tui.observe(observation);
  const now = T0 + 47 * MINUTE;
  tui.view(now); tui.view(now + 1_000);
  expect(reads).toBe(1);
  fail = true;
  expect(nodeLivenessProgressRow(tui.view(now + 2_000), 40)).toBe('⎇ app-build · verify-repair r3 · fail 1 · ● 4m');
  expect(reads).toBe(2);
  tui.reset();
  expect(tui.view(now + 4_000)).toBeNull();
});
