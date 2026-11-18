import { expect, test } from 'bun:test';
import {
  graphViewDetailIndex, graphViewDetailNodes, graphViewDetailWidth, graphViewTargetAtRow, latestGraphViewLoop, parseGraphCommand,
  renderGraphViewDetail,
} from './detail.js';
import { projectGraphLoopViews } from './model.js';
import { renderGraphViewInline } from './render.js';
import { APP_BUILD_SIM_EVENTS, GRAPH_VIEW_SIM_NOW, HARNESS_SIM_EVENTS } from './sim-scripts.js';

const app = projectGraphLoopViews(APP_BUILD_SIM_EVENTS);
const appViews = [...app.values()];
const harness = projectGraphLoopViews(HARNESS_SIM_EVENTS);
const harnessViews = [...harness.values()];
const now = GRAPH_VIEW_SIM_NOW;

test('graph detail expands every node — lanes, every inner-loop round, ◆ details, decisions with confidence — over the log', () => {
  const rows = renderGraphViewDetail(app.get('ab1')!, 60, 40, { nowMs: now, views: appViews });
  const text = rows.join('\n');
  expect(rows[0]).toBe('⎇ app_build · concert tickets · 2m 41s');
  // Every round of the ARG loop (the inline block shows only the last).
  expect(rows.filter((row) => /^ {4}↻\d {2}✓ draft/.test(row)).map((row) => row.trim().slice(0, 2))).toEqual(['↻1', '↻2']);
  expect(text).toContain('├─ ◐ api (retry 1)');
  expect(text).toContain('↓ join → mock data');
  expect(text).toContain('◆ deploy:approval · waiting · owner · publish approval');
  expect(text).toContain('◇ architecture settled? → yes · 92% · model');
  expect(text).toContain('── log · all nodes ──');
  expect(rows.every((row) => Bun.stringWidth(row) <= 60)).toBe(true);
});

test('selecting a node marks it ▸ and the log follows it (inner-loop rounds included)', () => {
  const view = app.get('ab1')!;
  const arch = graphViewDetailIndex(view, appViews, 'arch')!;
  const rows = renderGraphViewDetail(view, 60, 30, { nowMs: now, views: appViews, selected: arch });
  expect(rows).toContain('▸ ✓ arch ↻2');
  const log = rows.slice(rows.indexOf('── log · arch ──') + 1, -1);
  expect(log).not.toEqual([]);
  expect(log.some((row) => row.startsWith('↻2 '))).toBe(true);
  expect(log.some((row) => row.includes('code-api'))).toBe(false);
  const code = renderGraphViewDetail(view, 60, 30, { nowMs: now, views: appViews, selected: graphViewDetailIndex(view, appViews, 'code')! });
  expect(code.slice(code.indexOf('── log · code ──')).some((row) => row.includes('code-api · worker failed'))).toBe(true);
});

test('harness detail lists one row per child (latest round); the log follows the selected child; a child detail shows its PTY read-only', () => {
  const parent = harness.get('h1')!;
  const nodes = graphViewDetailNodes(parent, harnessViews);
  expect(nodes.map((node) => node.label)).toEqual(['queue-state', 'queue-controls', 'child-notice']);
  const notice = nodes.findIndex((node) => node.label === 'child-notice');
  const rows = renderGraphViewDetail(parent, 60, 20, { nowMs: now, views: harnessViews, selected: notice });
  expect(rows.some((row) => row.startsWith('▸ ◐ child-notice (retry 1) · glm-5'))).toBe(true);
  // The log carries both rounds of the retried child.
  expect(rows.some((row) => row.startsWith('↻1 '))).toBe(true);
  expect(rows.some((row) => row.startsWith('↻2 '))).toBe(true);
  const child = harness.get(nodes[notice]!.childLoopId!)!;
  const pty = ['$ bun test src/queue.test.ts', ' 3 pass', ' 1 fail'];
  const detail = renderGraphViewDetail(child, 60, 16, { nowMs: now, views: harnessViews, ptyScreen: pty });
  expect(detail[0]).toMatch(/^◐ child-notice \(retry 1\) · glm-5 · \d+\/\d+ · /);
  expect(detail).toContain(`── PTY · read-only · ${child.ptyId} ──`);
  expect(detail.slice(detail.indexOf(`── PTY · read-only · ${child.ptyId} ──`) + 1, detail.indexOf('── activity ──'))).toEqual(pty);
  expect(renderGraphViewDetail(child, 60, 16, { nowMs: now, views: harnessViews, ptyScreen: null }))
    .toContain(`PTY ${child.ptyId} · snapshot unavailable`);
});

test('a click on any inline block row resolves to its loop, a lane row to its node, a child lane to that child', () => {
  const appBlock = renderGraphViewInline(app.get('ab1')!, 100, { nowMs: now, views: appViews });
  expect(appBlock.map((row) => graphViewTargetAtRow(row, appViews, 100, now))).toEqual([
    { loopId: 'ab1' }, { loopId: 'ab1' }, ...appBlock.slice(2).map(() => ({ loopId: 'ab1', node: 'code' }))]);
  const harnessBlock = renderGraphViewInline(harness.get('h1')!, 100, { nowMs: now, views: harnessViews });
  const children = harnessBlock.slice(1).map((row) => graphViewTargetAtRow(`\x1b[2m${row}\x1b[22m   `, harnessViews, 100, now)?.loopId);
  expect(children.every((loopId) => loopId !== undefined && harness.get(loopId!)?.parentLoopId === 'h1')).toBe(true);
  expect(graphViewTargetAtRow('ordinary answer text', appViews, 100, now)).toBeNull();
});

test('/graph forms, the latest loop, and when the detail fits beside the chat', () => {
  expect(parseGraphCommand('/graph', appViews)).toBe('latest');
  expect(parseGraphCommand('/graph ab1', appViews)).toEqual({ loopId: 'ab1' });
  expect(parseGraphCommand('/graph ab1:code', appViews)).toEqual({ loopId: 'ab1', node: 'code' });
  expect(parseGraphCommand('/graph nothing-here', appViews)).toBeNull();
  expect(parseGraphCommand('hello', appViews)).toBeNull();
  expect(latestGraphViewLoop(appViews)?.loopId).toBe('ab1');
  // Half the screen when both halves stay readable; otherwise 0 = the detail covers the screen.
  const wide = graphViewDetailWidth(120);
  expect(wide).toBe(60);
  expect(graphViewDetailWidth(wide)).toBe(0);
});
