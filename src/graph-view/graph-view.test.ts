import { expect, test } from 'bun:test';
import { graphViewChildLoops, graphViewChips, projectGraphLoopViews, type GraphViewEvent } from './model.js';
import {
  colorGraphViewLine, GRAPH_VIEW_COLORS, GRAPH_VIEW_COMPACT_ROWS, GRAPH_VIEW_LANE_LIST_MAX, graphViewColorViolations,
  GRAPH_VIEW_INLINE_LANES_MAX, renderGraphViewCompact, renderGraphViewEdge, renderGraphViewFull, renderGraphViewInline,
  renderGraphViewInlineBlocks, renderGraphViewLine,
} from './render.js';
import {
  APP_BUILD_SIM_DONE_EVENTS, APP_BUILD_SIM_EVENTS, GRAPH_VIEW_SIM_DONE_NOW, GRAPH_VIEW_SIM_NOW, HARNESS_SIM_DONE_EVENTS,
  HARNESS_SIM_EVENTS, RELEASE_SIM_EVENTS,
} from './sim-scripts.js';

const appViews = projectGraphLoopViews(APP_BUILD_SIM_EVENTS);
const app = appViews.get('ab1')!;
const appAll = [...appViews.values()];
const options = { nowMs: GRAPH_VIEW_SIM_NOW, views: appAll };

test('projection folds events into the six elements; numbers come only from events', () => {
  expect(app.stages.map((stage) => [stage.id, stage.status])).toEqual([
    ['intent', 'done'], ['arch', 'done'], ['code', 'running'], ['mock-data', 'queued'], ['deploy', 'queued']]);
  const api = app.workers.find((worker) => worker.id === 'code-api')!;
  expect([api.status, api.lane, api.joinTo, api.retries]).toEqual(['running', 'api', 'mock-data', 1]);
  expect(graphViewChildLoops(appAll, app, 'arch').map((loop) => loop.round)).toEqual([1, 2]);
  const chips = graphViewChips(app, GRAPH_VIEW_SIM_NOW);
  expect([chips.stage, chips.stageIndex, chips.stageCount]).toEqual(['code', app.stages.findIndex((stage) => stage.id === 'code') + 1, app.stages.length]);
  expect(chips.waitingCheckpoint).toBe('deploy:approval');
  // Events before loop.started are ignored, not invented.
  expect(projectGraphLoopViews([{ type: 'stage.changed', loopId: 'x', at: 0, stage: 's', status: 'done' }]).size).toBe(0);
});

test('edge line: passed ═, remaining ─, current node upper-cased, marks ⫴n ↻n ◆ only on the edge', () => {
  const full = renderGraphViewEdge(app, 'full', appAll);
  expect(full).toContain('✓ intent ════ ✓ arch ↻2 ════ ◐ CODE ⫴3 ──── ○ mock data');
  expect(full.endsWith('○ deploy ◆')).toBe(true);
  expect(renderGraphViewEdge(app, 'compact', appAll)).toContain('◐ code 1/3 ⫴3 ─ ○ mock data');
  expect(renderGraphViewLine(app, options)).toBe(`· app_build ${app.stages.findIndex((stage) => stage.status === 'running') + 1}/${app.stages.length}`);
});

test('compact is two rows; full expands only the current node with lanes, join, retry, now and last decision', () => {
  expect(renderGraphViewCompact(app, 80, options)).toHaveLength(GRAPH_VIEW_COMPACT_ROWS);
  const full = renderGraphViewFull(app, 160, 30, options).join('\n');
  expect(full).toContain('┌─ ✓ ui');
  expect(full).toContain('├─ ◐ api (retry 1)');
  expect(full).toContain('↓ join → mock data');
  expect(full).toContain('last decision  api lane failed → retry · code');
  expect(full).not.toContain('│ ✓ INTENT'); // Only the current node is expanded.
  expect(renderGraphViewFull(app, 160, 30, { ...options, detail: 'decisions' }).join('\n')).toContain('architecture settled? → yes · model');
});

test('many lanes collapse to per-status counts and list only the failed ones', () => {
  const lanes = GRAPH_VIEW_LANE_LIST_MAX + 2;
  const events: GraphViewEvent[] = [
    { type: 'loop.started', loopId: 'm', at: 0, kind: 'gate', lead: 'REL' },
    { type: 'stage.changed', loopId: 'm', at: 0, stage: 'gate', status: 'running' },
    ...Array.from({ length: lanes }, (_, index): GraphViewEvent => ({ type: 'worker.changed', loopId: 'm', at: 1, worker: `s${index}`,
      stage: 'gate', lane: `s${index}`, status: index === 0 ? 'failed' : 'done' })),
  ];
  const view = projectGraphLoopViews(events).get('m')!;
  const full = renderGraphViewFull(view, 160, 30, { nowMs: 2 }).join('\n');
  expect(full).toContain(`⫴${lanes} · ✓${lanes - 1} ◐0 ✗1`);
  expect(full).toContain('└─ ✗ s0');
  expect(full).not.toContain('✓ s1');
});

test('depth 1: a loop inside the inner loop stays a ↻ mark', () => {
  const events: GraphViewEvent[] = [
    { type: 'loop.started', loopId: 'p', at: 0, kind: 'app_build', lead: 'L' },
    { type: 'stage.changed', loopId: 'p', at: 0, stage: 'arch', status: 'running' },
    { type: 'loop.started', loopId: 'c', at: 1, kind: 'arg', lead: 'arg', parentLoopId: 'p', parentNode: 'arch', round: 1 },
    { type: 'stage.changed', loopId: 'c', at: 1, stage: 'review', status: 'running' },
    { type: 'loop.started', loopId: 'g', at: 2, kind: 'retry', lead: 'r', parentLoopId: 'c', parentNode: 'review', round: 1 },
    { type: 'stage.changed', loopId: 'g', at: 2, stage: 'deep-step', status: 'running' },
  ];
  const views = projectGraphLoopViews(events);
  const full = renderGraphViewFull(views.get('p')!, 160, 30, { nowMs: 3, views: [...views.values()] }).join('\n');
  expect(full).toContain('↻1  ◐ review 0/0 ↻1'.replace(' 0/0', ''));
  expect(full).not.toContain('deep-step');
});

test('개정 3 colors: one meaning per color, ≤2 emphasis colors per line, and glyphs alone without color', () => {
  const colored = [...renderGraphViewFull(app, 160, 30, { ...options, color: true }), ...renderGraphViewCompact(app, 80, { ...options, color: true })];
  expect(colored.flatMap(graphViewColorViolations)).toEqual([]);
  expect(colorGraphViewLine('✓ a ═ ◐ B ─ ○ c ◆ ⫴3')).toContain(`\x1b[${GRAPH_VIEW_COLORS.decision}m◆\x1b[0m`);
  expect(colorGraphViewLine('✓ a ═ ◐ B')).toContain(`\x1b[${GRAPH_VIEW_COLORS.current}m◐ B\x1b[0m`);
  // A misused color and a third emphasis color are both reported.
  expect(graphViewColorViolations(`\x1b[${GRAPH_VIEW_COLORS.done}m◆\x1b[0m`)).toHaveLength(1);
  const three = [`\x1b[${GRAPH_VIEW_COLORS.current}m◐ a\x1b[0m`, `\x1b[${GRAPH_VIEW_COLORS.failed}m✗ b\x1b[0m`, `\x1b[${GRAPH_VIEW_COLORS.decision}m◆\x1b[0m`].join(' ');
  expect(graphViewColorViolations(three).some((message) => message.includes('emphasis'))).toBe(true);
  const plain = renderGraphViewFull(app, 160, 30, options).join('\n');
  expect(plain.includes('\x1b[')).toBe(false);
  for (const glyph of ['✓', '◐', '○', '◆', '⫴', '↻']) expect(plain).toContain(glyph);
});

test('release script uses the same grammar', () => {
  const views = projectGraphLoopViews(RELEASE_SIM_EVENTS);
  expect(renderGraphViewEdge(views.get('rel1')!, 'full', [...views.values()])).toBe('✓ cut ════ ◐ GATE ⫴3 ──── ○ rehearsal ──── ○ publish ◆ ──── ○ rail');
});

test('개정 4 inline block: head, edge, at most three lanes while running; one folded line when done', () => {
  const running = renderGraphViewInline(app, 100, options);
  expect(running[0]).toBe('⎇ app_build · concert tickets');
  expect(running[1]).toContain('◐ code 1/3 ⫴3');
  const laneCount = app.workers.filter((worker) => worker.stage === 'code' && worker.lane !== undefined).length;
  expect(running.filter((row) => /^[├└]─ /.test(row)).length).toBe(Math.min(laneCount, GRAPH_VIEW_INLINE_LANES_MAX));
  const doneViews = projectGraphLoopViews(APP_BUILD_SIM_DONE_EVENTS);
  const done = doneViews.get('ab1')!;
  const folded = renderGraphViewInline(done, 100, { nowMs: GRAPH_VIEW_SIM_DONE_NOW, views: [...doneViews.values()] });
  expect(folded).toEqual([`✓ app_build · concert tickets · ${done.stages.length}/${done.stages.length} stages · 6m 12s · deploy approved`]);
  // Narrow: the name drops before the state, size, time and verdict.
  const narrow = renderGraphViewInline(done, Bun.stringWidth(folded[0]!) - 1, { nowMs: GRAPH_VIEW_SIM_DONE_NOW, views: [...doneViews.values()] });
  expect(narrow[0]).toBe(`✓ app_build · ${done.stages.length}/${done.stages.length} stages · 6m 12s · deploy approved`);
});

test('개정 4 harness children: one lane per child (latest round), retry marked, finished children folded', () => {
  const views = projectGraphLoopViews(HARNESS_SIM_EVENTS);
  const block = renderGraphViewInline(views.get('h1')!, 100, { nowMs: GRAPH_VIEW_SIM_NOW, views: [...views.values()] });
  expect(block[0]).toBe('⎇ harness · ELN-QUEUE cells · 3 children');
  expect(block.filter((row) => row.includes('child-notice'))).toEqual(['├─ ◐ child-notice (retry 1) · glm-5 · ✓ plan ═ ✓ impl ═ ◐ test ─ ○ pr']);
  expect(block).toContain('└─ ✓ queue-state · gpt-6-sol · 4/4');
  const doneViews = projectGraphLoopViews(HARNESS_SIM_DONE_EVENTS);
  expect(renderGraphViewInline(doneViews.get('h1')!, 100, { nowMs: GRAPH_VIEW_SIM_DONE_NOW, views: [...doneViews.values()] })[0]).toMatch(/^✓ harness · ELN-QUEUE cells · 3\/3 children/);
});

test('several loops: each keeps its block; past the height cap the oldest running blocks fold first', () => {
  const all = [...projectGraphLoopViews([...APP_BUILD_SIM_EVENTS, ...RELEASE_SIM_EVENTS, ...HARNESS_SIM_EVENTS]).values()];
  const roomy = renderGraphViewInlineBlocks(all, 100, Number.POSITIVE_INFINITY, { nowMs: GRAPH_VIEW_SIM_NOW });
  expect(roomy.map((block) => block[0]!.split(' · ')[0])).toEqual(['⎇ app_build', '⎇ release', '⎇ harness']);
  const harnessRows = roomy[2]!.length;
  const tight = renderGraphViewInlineBlocks(all, 100, harnessRows + 2, { nowMs: GRAPH_VIEW_SIM_NOW });
  expect(tight.map((block) => block.length)).toEqual([1, 1, harnessRows]);
  expect(tight[0]![0]).toMatch(/^◐ app_build · concert tickets · \d+\/\d+ · /);
});
