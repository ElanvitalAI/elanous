import { expect, test } from 'bun:test';
import { graphViewDetailWidth } from '../../graph-view/detail.js';
import { projectGraphLoopViews } from '../../graph-view/model.js';
import { renderGraphViewInline } from '../../graph-view/render.js';
import { APP_BUILD_SIM_EVENTS, GRAPH_VIEW_SIM_NOW, HARNESS_SIM_CHILD_PTY, HARNESS_SIM_EVENTS } from '../../graph-view/sim-scripts.js';
import { createGraphDetailController, GRAPH_DETAIL_STATUS } from './controller.js';

function harness(events = [...APP_BUILD_SIM_EVENTS, ...HARNESS_SIM_EVENTS]) {
  const views = [...projectGraphLoopViews(events).values()];
  const status: string[] = [];
  const reads: string[] = [];
  const controller = createGraphDetailController({ views: () => views, render: () => {}, setStatus: (text) => status.push(text),
    readPty: async (ptyId) => { reads.push(ptyId); return [...HARNESS_SIM_CHILD_PTY]; } });
  return { views, status, reads, controller };
}
const key = (name: string, extra: Record<string, unknown> = {}) => ({ name, ...extra });

test('Ctrl+click on an inline block row opens that loop; a plain click is left to the caller', () => {
  const { views, controller, status } = harness();
  const block = renderGraphViewInline(views.find((view) => view.loopId === 'ab1')!, 100, { nowMs: GRAPH_VIEW_SIM_NOW, views });
  controller.noteChatFrame(['header', ...block], 100, 0);
  expect(controller.handleKey(key('mouse', { mouse: { row: 2, col: 3, type: 'click' } }), true)).toBe(false);
  expect(controller.isOpen).toBe(false);
  expect(controller.handleKey(key('mouse', { ctrl: true, mouse: { row: 2, col: 3, type: 'click' } }), true)).toBe(true);
  expect(controller.isOpen).toBe(true);
  expect(status.at(-1)).toBe(GRAPH_DETAIL_STATUS);
});

test('the panel joins right of the chat when it fits, else the detail covers the screen; Ctrl+G toggles', () => {
  const { controller } = harness();
  expect(controller.compose(['chat'], 120, 10)).toEqual(['chat']);
  expect(controller.handleKey(key('g', { ctrl: true }), true)).toBe(true);
  const panel = graphViewDetailWidth(120);
  const rows = controller.compose(['chat row'], 120, 10);
  expect(rows[0]).toStartWith(`chat row${' '.repeat(120 - panel - 1 - 'chat row'.length)}│`);
  expect(controller.overlay(120, 10, false)).toBeNull();
  expect(controller.overlay(60, 10, false)?.length).toBe(9);
  expect(controller.overlay(120, 10, true)?.length).toBe(9);
  controller.handleKey(key('g', { ctrl: true }), true);
  expect(controller.isOpen).toBe(false);
});

test('↑↓ move the node, Enter opens a harness child and reads its PTY, Esc goes back then closes; typing hands focus back', async () => {
  const { controller, reads } = harness();
  controller.runCommand('/graph h1');
  expect(controller.isOpen).toBe(true);
  for (let step = 0; step < 3; step += 1) controller.handleKey(key('down'), true);
  const before = controller.compose([''], 140, 30).join('\n');
  expect(before).toContain('▸ ◐ child-notice (retry 1)');
  expect(controller.handleKey(key('enter'), true)).toBe(true);
  await Bun.sleep(0);
  expect(reads).toEqual(['pty-h1-c2']);
  const child = controller.compose([''], 140, 30).join('\n');
  expect(child).toContain('── PTY · read-only · pty-h1-c2 ──');
  expect(child).toContain(HARNESS_SIM_CHILD_PTY[0]!);
  controller.handleKey(key('escape'), true);
  expect(controller.compose([''], 140, 30).join('\n')).toContain('▸ ◐ child-notice (retry 1)');
  // A printable key is the composer's; the detail stays open but no longer takes ↑↓.
  expect(controller.handleKey(key('a'), true)).toBe(false);
  expect(controller.handleKey(key('down'), true)).toBe(false);
  controller.dispose();
});

test('/graph with no loops or an unknown loop says so instead of opening', () => {
  const empty = harness([]);
  empty.controller.runCommand('/graph');
  expect(empty.status.at(-1)).toBe('No graph loop in this session yet');
  const { controller, status } = harness();
  controller.runCommand('/graph nothing-here');
  expect(controller.isOpen).toBe(false);
  expect(status.at(-1)).toStartWith('Graph not found · loops: ');
});
