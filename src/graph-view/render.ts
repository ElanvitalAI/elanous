// GRAPH-LOOP-VIEW renderer (내부 문서 `GRAPH-LOOP-VIEW`). The view model and event schema stay as they are;
// this decides what the default screen shows (개정 1–3 · 대표 11-17):
//   ① one edge line of stage nodes  ② only the current node expanded  ③ one log row  (w · d · l open details)
//   marks on the edge only: ⫴n parallel lanes · ↻n rounds of a small loop inside a node · ◆ needs a decision
//   colors: one meaning per color, applied after layout so widths stay exact; glyphs always carry the state.
import { graphViewChildLoops, graphViewChips, type GraphLoopView, type GraphViewStage, type GraphViewStageStatus, type GraphViewWorker } from './model.js';

const STAGE_GLYPH: Record<GraphViewStageStatus, string> = { queued: '○', running: '◐', done: '✓', failed: '✗', skipped: '–' };
/** Passed edges are double, remaining edges single (개정 1). */
const PASSED_EDGE = '═';
const REMAINING_EDGE = '─';
const CHECKPOINT_MARK = '◆';
const PARALLEL_MARK = '⫴';
const LOOP_MARK = '↻';
// 출처: src/tui/core/render.ts working row — the same braille spinner frames as «⠋ Working».
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// 출처: ASK-GRAPH-LOOP-VIEW-METHOD-1117 개정 example «✓ intent ──── ✓ arch» — full-size edge length.
const FULL_EDGE_LENGTH = 4;
// Progress bar cells inside the expanded node.
const BAR_CELLS = 10;
// 출처: ASK-GRAPH-LOOP-VIEW-METHOD-1117 개정 2 «레인 많으면 상태별 개수 ⊕ 실패 레인만 펼침» — the lane list example shows three.
export const GRAPH_VIEW_LANE_LIST_MAX = 6;
// 출처: ASK-GRAPH-LOOP-VIEW-METHOD-1117 §3 — the full view is the ≥140-column sidetab; below it, the compact rows.
export const GRAPH_VIEW_FULL_MIN_COLUMNS = 140;

export type GraphViewDetail = 'workers' | 'decisions' | 'log';
/** Keys that open one detail list under the default view. */
export const GRAPH_VIEW_DETAIL_KEYS: Readonly<Record<string, GraphViewDetail>> = { w: 'workers', d: 'decisions', l: 'log' };

export interface GraphViewRenderOptions {
  readonly nowMs: number;
  /** Spinner frame counter; the caller ticks it only while the view is visible. */
  readonly tick?: number;
  readonly detail?: GraphViewDetail;
  /** All loop views (an array, read more than once), so a node can show the small loops inside it. */
  readonly views?: readonly GraphLoopView[];
  /** Apply the meaning colors (개정 3). Off for NO_COLOR or a non-color terminal. */
  readonly color?: boolean;
}

// ── 개정 3 color table: one meaning, one color (16-color SGR so every terminal palette maps it) ──
export const GRAPH_VIEW_COLORS = {
  current: '1;96', // bright cyan bold — the running node, ◐, filled bar of a running node
  done: '32', //       green — ✓, passed edges ═
  waiting: '2', //     dim — ○, remaining edges ─, empty bar cells, side info
  failed: '1;91', //   red bold — ✗, failed lane, retry mark
  decision: '33', //   amber — ◆
  loop: '35', //       purple — ↻n, ⫴n
} as const;
export type GraphViewColorMeaning = keyof typeof GRAPH_VIEW_COLORS;
/** Colors that count as emphasis; at most two per line (개정 3 rule). */
export const GRAPH_VIEW_EMPHASIS: readonly GraphViewColorMeaning[] = ['current', 'failed', 'decision'];

const COLOR_RULES: { readonly pattern: RegExp; readonly meaning: GraphViewColorMeaning }[] = [
  { pattern: /◐ [^\s─═│┌├└]+(?: \d+\/\d+)?/gu, meaning: 'current' },
  { pattern: /✗ [^\s─═│┌├└]+(?: \(retry \d+\))?/gu, meaning: 'failed' },
  { pattern: /✓/gu, meaning: 'done' },
  { pattern: /═+/gu, meaning: 'done' },
  { pattern: /○/gu, meaning: 'waiting' },
  { pattern: /(?<=[✓○◐✗–\w)] )─+(?= [✓○◐✗–])/gu, meaning: 'waiting' },
  { pattern: /◆/gu, meaning: 'decision' },
  { pattern: /[⫴↻]\d+/gu, meaning: 'loop' },
  { pattern: /▓+/gu, meaning: 'current' },
  { pattern: /░+/gu, meaning: 'waiting' },
  { pattern: /\(p=\d\.\d+\)|\+\d+(?:m \d+)?s\b|\(\d+(?:m \d+)?s(?: • esc to interrupt)?\)/gu, meaning: 'waiting' },
];

/** Paint one laid-out line by meaning. Earlier rules win where spans overlap; widths are unchanged. */
export function colorGraphViewLine(line: string): string {
  const spans: { start: number; end: number; meaning: GraphViewColorMeaning }[] = [];
  for (const rule of COLOR_RULES) {
    for (const match of line.matchAll(rule.pattern)) {
      const start = match.index!;
      const end = start + match[0].length;
      if (spans.some((span) => start < span.end && end > span.start)) continue;
      spans.push({ start, end, meaning: rule.meaning });
    }
  }
  spans.sort((left, right) => left.start - right.start);
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += line.slice(cursor, span.start) + `\x1b[${GRAPH_VIEW_COLORS[span.meaning]}m${line.slice(span.start, span.end)}\x1b[0m`;
    cursor = span.end;
  }
  return out + line.slice(cursor);
}

function fit(text: string, columns: number): string {
  if (columns <= 0) return '';
  if (Bun.stringWidth(text) <= columns) return text;
  let out = '';
  for (const char of text) {
    if (Bun.stringWidth(out + char + '…') > columns) break;
    out += char;
  }
  return out + '…';
}

function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function currentStageIndex(view: GraphLoopView): number {
  const running = view.stages.findIndex((stage) => stage.status === 'running');
  if (running >= 0) return running;
  const failed = view.stages.findIndex((stage) => stage.status === 'failed');
  if (failed >= 0) return failed;
  let lastDone = -1;
  view.stages.forEach((stage, index) => { if (stage.status === 'done') lastDone = index; });
  return lastDone;
}

/** A checkpoint attaches to the stage it equals or prefixes (`deploy`, `deploy:approval`), else the last stage. */
function checkpointStages(view: GraphLoopView): Set<number> {
  const marked = new Set<number>();
  for (const checkpoint of view.checkpoints) {
    if (checkpoint.status !== 'waiting' && checkpoint.status !== 'active') continue;
    const owner = view.stages.findIndex((stage) => checkpoint.id === stage.id || checkpoint.id.startsWith(`${stage.id}:`));
    marked.add(owner >= 0 ? owner : view.stages.length - 1);
  }
  return marked;
}

const stageWorkers = (view: GraphLoopView, stage: GraphViewStage | undefined): GraphViewWorker[] =>
  view.workers.filter((worker) => worker.stage === undefined || worker.stage === stage?.id);
/** Parallel lanes of a stage: workers that name a lane (one row per lane). */
const stageLanes = (view: GraphLoopView, stage: GraphViewStage): GraphViewWorker[] =>
  view.workers.filter((worker) => worker.stage === stage.id && worker.lane !== undefined);

function nodeMarks(view: GraphLoopView, stage: GraphViewStage, views: readonly GraphLoopView[] | undefined): string {
  const lanes = stageLanes(view, stage).length;
  const rounds = views ? graphViewChildLoops(views, view, stage.id).length : 0;
  return `${lanes > 1 ? ` ${PARALLEL_MARK}${lanes}` : ''}${rounds > 0 ? ` ${LOOP_MARK}${rounds}` : ''}`;
}

/** ① The edge line. Full widens edges and upper-cases the current node; compact shows its worker count. */
export function renderGraphViewEdge(view: GraphLoopView, size: 'full' | 'compact', views?: readonly GraphLoopView[]): string {
  const all = views;
  const current = currentStageIndex(view);
  const marks = checkpointStages(view);
  const edgeLength = size === 'full' ? FULL_EDGE_LENGTH : 1;
  return view.stages.map((stage, index) => {
    const workers = stageWorkers(view, stage);
    const done = workers.filter((worker) => worker.status === 'done').length;
    // Upper case marks «where it is now» — a finished loop has no current node.
    const label = index === current && size === 'full' && view.status === 'running' ? stage.label.toUpperCase() : stage.label;
    const count = index === current && size === 'compact' && workers.length > 0 ? ` ${done}/${workers.length}` : '';
    const node = `${STAGE_GLYPH[stage.status]} ${label}${count}${nodeMarks(view, stage, all)}${marks.has(index) ? ` ${CHECKPOINT_MARK}` : ''}`;
    if (index === 0) return node;
    const passed = index <= current && view.stages[index - 1]!.status === 'done';
    return `${(passed ? PASSED_EDGE : REMAINING_EDGE).repeat(edgeLength)} ${node}`;
  }).join(' ');
}

function bar(progress: number | undefined): string {
  if (progress === undefined) return '';
  const filled = Math.round(Math.min(1, Math.max(0, progress)) * BAR_CELLS);
  return `${'▓'.repeat(filled)}${'░'.repeat(BAR_CELLS - filled)} ${Math.round(progress * 100)}%`;
}

function laneRow(worker: GraphViewWorker, branch: string): string {
  const retry = worker.retries > 0 ? ` (retry ${worker.retries})` : '';
  return `${branch} ${STAGE_GLYPH[worker.status]} ${worker.lane ?? worker.id}${retry}${worker.status === 'running' ? `  ${bar(worker.progress)}` : ''}`;
}

/** ② The current node's box: workers, bar, lanes (branch/join), last round of an inner loop, now, last decision. */
function currentNodeBox(view: GraphLoopView, columns: number, views: readonly GraphLoopView[] | undefined): string[] {
  const current = currentStageIndex(view);
  const stage = view.stages[current];
  if (!stage) return [];
  const workers = stageWorkers(view, stage);
  const done = workers.filter((worker) => worker.status === 'done').length;
  const progress = stage.progress ?? (workers.length > 0 ? done / workers.length : undefined);
  const rows: string[] = [
    `${STAGE_GLYPH[stage.status]} ${stage.label.toUpperCase()}${nodeMarks(view, stage, views)}`,
    [workers.length > 0 ? `workers ${done}/${workers.length}` : '', bar(progress)].filter(Boolean).join('  '),
  ];
  const lanes = stageLanes(view, stage);
  if (lanes.length > 1) {
    const shown = lanes.length <= GRAPH_VIEW_LANE_LIST_MAX ? lanes : lanes.filter((lane) => lane.status === 'failed');
    if (lanes.length > GRAPH_VIEW_LANE_LIST_MAX) {
      const count = (status: GraphViewStageStatus) => lanes.filter((lane) => lane.status === status).length;
      rows.push(`${PARALLEL_MARK}${lanes.length} · ✓${count('done')} ◐${count('running')} ✗${count('failed')}`);
    }
    shown.forEach((lane, index) => rows.push(laneRow(lane, shown.length === 1 ? '└─' : index === 0 ? '┌─' : index === shown.length - 1 ? '└─' : '├─')));
    const joinTo = lanes.find((lane) => lane.joinTo)?.joinTo;
    if (joinTo) rows.push(`↓ join → ${view.stages.find((candidate) => candidate.id === joinTo)?.label ?? joinTo}`);
  }
  // Depth 1: the last round's own edge line; loops inside it stay folded as ↻ marks.
  const rounds = views ? graphViewChildLoops(views, view, stage.id) : [];
  const last = rounds.at(-1);
  if (last) rows.push(`${LOOP_MARK}${rounds.length}  ${renderGraphViewEdge(last, 'compact', views)}`);
  const now = [...view.log].reverse().find((entry) => entry.event.startsWith('worker') || entry.event.startsWith('stage'));
  if (now) rows.push(`now  ${now.actor} ${now.event.replace(/^(worker|stage) /, '')}${now.detail ? ` · ${now.detail}` : ''}`);
  const decision = view.decisions.at(-1);
  if (decision) rows.push(`last decision  ${decision.question} → ${decision.choice}${decision.confidence === undefined ? '' : ` (p=${decision.confidence.toFixed(2)})`} · ${decision.route}`);
  const inner = Math.max(1, columns - 2);
  const width = Math.min(inner, Math.max(...rows.filter(Boolean).map((row) => Bun.stringWidth(row))));
  return [`┌${'─'.repeat(width + 1)}`, ...rows.filter(Boolean).map((row) => `│ ${fit(row, width)}`), `└${'─'.repeat(width + 1)}`];
}

function logRow(view: GraphLoopView, entry = view.log.at(-1)): string {
  return entry ? `+${duration(entry.at - view.startedAt)} ${entry.actor} · ${entry.event} · ${entry.detail}` : '';
}

function detailRows(view: GraphLoopView, detail: GraphViewDetail): string[] {
  if (detail === 'workers') return ['workers', ...view.workers.map((worker) => `  ${STAGE_GLYPH[worker.status]} ${worker.lane ?? worker.id}${worker.model ? ` · ${worker.model}` : ''}${worker.stage ? ` · ${worker.stage}` : ''}`)];
  if (detail === 'decisions') return ['decisions', ...view.decisions.map((decision) => `  ${decision.question} → ${decision.choice} · ${decision.route}`)];
  return ['log', ...view.log.map((entry) => `  ${logRow(view, entry)}`)];
}

const paint = (lines: string[], color: boolean | undefined) => color ? lines.map(colorGraphViewLine) : lines;

/** Progress-row suffix: «· app_build 2/4». */
export function renderGraphViewLine(view: GraphLoopView, options: GraphViewRenderOptions): string {
  const chips = graphViewChips(view, options.nowMs);
  return `· ${view.kind} ${chips.stageIndex}/${chips.stageCount}`;
}

/** Two rows: «⠋ Running app_build(code) (2m 41s • esc to interrupt)» and the compact edge line. */
export function renderGraphViewCompact(view: GraphLoopView, columns: number, options: GraphViewRenderOptions): string[] {
  const chips = graphViewChips(view, options.nowMs);
  const spinner = view.status === 'running' ? SPINNER[(options.tick ?? 0) % SPINNER.length]! : view.status === 'done' ? '✓' : '✗';
  const verb = view.status === 'running' ? 'Running' : view.status === 'done' ? 'Finished' : view.status === 'failed' ? 'Failed' : 'Cancelled';
  const head = `${spinner} ${verb} ${view.kind}${chips.stage ? `(${chips.stage})` : ''} (${duration(chips.elapsedMs)}${view.status === 'running' ? ' • esc to interrupt' : ''})`;
  return paint([fit(head, columns), fit(renderGraphViewEdge(view, 'compact', options.views), columns)], options.color);
}

/** Sidetab view: edge line · current node box · one log row · optional detail list · key hint. */
export function renderGraphViewFull(view: GraphLoopView, columns: number, rows: number, options: GraphViewRenderOptions): string[] {
  const views = options.views;
  const head = renderGraphViewCompact(view, columns, { ...options, color: false })[0]!;
  const top = [head, '', fit(renderGraphViewEdge(view, 'full', views), columns), '', ...currentNodeBox(view, columns, views), '', fit(logRow(view), columns)];
  const hint = fit('w workers · d decisions · l log', columns);
  const room = Math.max(0, rows - top.length - 2);
  const detail = options.detail ? detailRows(view, options.detail).slice(-room).map((row) => fit(row, columns)) : [];
  return paint([...top, ...(detail.length ? ['', ...detail] : []), '', hint].slice(0, Math.max(1, rows)), options.color);
}

/** Full at or above the sidetab width, compact below. */
export function renderGraphView(view: GraphLoopView, columns: number, rows: number, options: GraphViewRenderOptions): string[] {
  return columns >= GRAPH_VIEW_FULL_MIN_COLUMNS ? renderGraphViewFull(view, columns, rows, options) : renderGraphViewCompact(view, columns, options);
}

// 출처: ASK-GRAPH-LOOP-VIEW-METHOD-1117 개정 1 — compact is two rows (working line + edge line).
export const GRAPH_VIEW_COMPACT_ROWS = 2;
// 출처: ASK-GRAPH-LOOP-VIEW-METHOD-1117 개정 3 «한 줄에 강조색 최대 2개».
export const GRAPH_VIEW_EMPHASIS_PER_LINE = 2;

const MEANING_TEXT: Record<GraphViewColorMeaning, RegExp> = {
  current: /^(?:◐ .+|▓+)$/u,
  done: /^(?:✓|═+)$/u,
  waiting: /^(?:○|─+|░+|\(p=\d\.\d+\)|\+\d+(?:m \d+)?s|\(\d+(?:m \d+)?s(?: • esc to interrupt)?\))$/u,
  failed: /^✗ .+$/u,
  decision: /^◆$/u,
  loop: /^[⫴↻]\d+$/u,
};

/**
 * 개정 3 check for one rendered line: every colored span carries the meaning its color stands for, and a line has at
 * most two emphasis colors. Returns human-readable violations (empty = clean).
 */
export function graphViewColorViolations(ansiLine: string): string[] {
  const violations: string[] = [];
  const byCode = new Map<string, GraphViewColorMeaning>(Object.entries(GRAPH_VIEW_COLORS).map(([meaning, code]) => [code, meaning as GraphViewColorMeaning]));
  const emphasis = new Set<GraphViewColorMeaning>();
  for (const match of ansiLine.matchAll(/\x1b\[([\d;]+)m(.*?)\x1b\[0m/gu)) {
    const meaning = byCode.get(match[1]!);
    if (!meaning) { violations.push(`unknown color ${match[1]} on «${match[2]}»`); continue; }
    if (!MEANING_TEXT[meaning].test(match[2]!)) violations.push(`${meaning} color on «${match[2]}»`);
    if (GRAPH_VIEW_EMPHASIS.includes(meaning)) emphasis.add(meaning);
  }
  if (emphasis.size > GRAPH_VIEW_EMPHASIS_PER_LINE) violations.push(`${emphasis.size} emphasis colors on one line`);
  return violations;
}

// ── 개정 4: the default surface is an inline block inside the conversation stream ──
// 출처: ASK-GRAPH-LOOP-VIEW-METHOD-1117 개정 4 «지금 노드 펼침(레인 ≤3줄)».
export const GRAPH_VIEW_INLINE_LANES_MAX = 3;

/** Children of a harness-like loop: inner loops not tied to a node (each child is one lane). */
const childLanes = (views: readonly GraphLoopView[] | undefined, parent: GraphLoopView): GraphLoopView[] => {
  // A retried child is a new round of the same child (same name): only its latest round is a lane.
  const latest = new Map<string, GraphLoopView>();
  for (const view of views ?? []) {
    if (view.parentLoopId !== parent.loopId || view.parentNode !== undefined) continue;
    const key = view.title ?? view.loopId;
    const prior = latest.get(key);
    if (!prior || (view.round ?? 1) >= (prior.round ?? 1)) latest.set(key, view);
  }
  return [...latest.values()].sort((left, right) => left.startedAt - right.startedAt);
};

function stagesDone(view: GraphLoopView): number {
  return view.stages.filter((stage) => stage.status === 'done' || stage.status === 'skipped').length;
}

function loopGlyph(view: GraphLoopView): string {
  return view.status === 'running' ? '◐' : view.status === 'done' ? '✓' : '✗';
}

/** One row per harness child: name · model · its own mini edge; finished children fold, failed ones stay open. */
function childRow(child: GraphLoopView, branch: string, views: readonly GraphLoopView[] | undefined): string {
  const name = child.title ?? child.loopId;
  const retry = (child.round ?? 1) > 1 ? ` (retry ${(child.round ?? 1) - 1})` : '';
  if (child.status === 'done') return `${branch} ✓ ${name} · ${child.lead} · ${stagesDone(child)}/${child.stages.length}`;
  const glyph = child.status === 'running' ? '◐' : '✗';
  return `${branch} ${glyph} ${name}${retry} · ${child.lead} · ${renderGraphViewEdge(child, 'compact', views)}`;
}

/** Lane rows inside the inline block, at most GRAPH_VIEW_INLINE_LANES_MAX: failed first, then running, then the rest. */
function inlineLaneRows(view: GraphLoopView, views: readonly GraphLoopView[] | undefined): string[] {
  const children = childLanes(views, view);
  const stage = view.stages[currentStageIndex(view)];
  const lanes = stage ? stageLanes(view, stage) : [];
  const rank = (status: string) => status === 'failed' ? 0 : status === 'running' ? 1 : 2;
  if (children.length > 0) {
    const ordered = [...children].sort((left, right) => rank(left.status) - rank(right.status));
    const shown = ordered.slice(0, GRAPH_VIEW_INLINE_LANES_MAX);
    const rows = shown.map((child, index) => childRow(child, index === shown.length - 1 && children.length <= shown.length ? '└─' : '├─', views));
    if (children.length > shown.length) rows.push(`└─ +${children.length - shown.length} more`);
    return rows;
  }
  if (lanes.length > 1) {
    const ordered = [...lanes].sort((left, right) => rank(left.status) - rank(right.status));
    const shown = ordered.slice(0, GRAPH_VIEW_INLINE_LANES_MAX);
    const rows = shown.map((lane, index) => laneRow(lane, index === shown.length - 1 && lanes.length <= shown.length ? '└─' : '├─'));
    if (lanes.length > shown.length) rows.push(`└─ +${lanes.length - shown.length} more`);
    return rows;
  }
  return [];
}

/** The folded summary line a finished loop leaves in the transcript. */
export function renderGraphViewFolded(view: GraphLoopView, options: GraphViewRenderOptions, columns = Number.POSITIVE_INFINITY): string {
  const chips = graphViewChips(view, options.nowMs);
  const children = childLanes(options.views, view);
  const passed = [...view.checkpoints].reverse().find((checkpoint) => checkpoint.status === 'passed');
  const rejected = [...view.checkpoints].reverse().find((checkpoint) => checkpoint.status === 'rejected');
  const verdict = rejected ? `${rejected.id} rejected` : passed ? `${passed.summary ?? passed.id} approved` : '';
  const size = children.length > 0
    ? `${children.filter((child) => child.status === 'done').length}/${children.length} children`
    : `${stagesDone(view)}/${view.stages.length} stages`;
  const line = (title: string | undefined) => [`${loopGlyph(view)} ${view.kind}`, title, size, duration(chips.elapsedMs), verdict].filter(Boolean).join(' · ');
  // On a narrow screen the name goes first, so state, size, time and the verdict stay readable.
  return Bun.stringWidth(line(view.title)) <= columns ? line(view.title) : line(undefined);
}

/**
 * Inline block in the conversation stream (개정 4 default). Running: head «⎇ kind · name», the edge line, the current
 * node with up to three lane rows. Done: one folded line. Failed: the folded line plus the failed node kept open.
 */
export function renderGraphViewInline(view: GraphLoopView, columns: number, options: GraphViewRenderOptions): string[] {
  const views = options.views;
  const children = childLanes(views, view);
  const fitted = (lines: string[]) => paint(lines.map((line) => fit(line, columns)), options.color);
  if (view.status === 'done') return fitted([renderGraphViewFolded(view, options, columns)]);
  const head = `⎇ ${view.kind}${view.title ? ` · ${view.title}` : ''}${children.length > 0 ? ` · ${children.length} children` : ''}`;
  const edge = view.stages.length > 0 ? [renderGraphViewEdge(view, 'compact', views)] : [];
  const lanes = inlineLaneRows(view, views);
  if (view.status !== 'running') {
    const failed = view.stages.find((stage) => stage.status === 'failed');
    return fitted([renderGraphViewFolded(view, options, columns), ...edge, ...(failed ? [`  ✗ ${failed.label}`] : []), ...lanes]);
  }
  const stage = view.stages[currentStageIndex(view)];
  const rounds = stage && views ? graphViewChildLoops(views, view, stage.id) : [];
  const loop = rounds.at(-1) ? [`  ${LOOP_MARK}${rounds.length}  ${renderGraphViewEdge(rounds.at(-1)!, 'compact', views)}`] : [];
  return fitted([head, ...edge, ...lanes, ...loop]);
}

/**
 * Several loops at once: each keeps its own block; when the total passes `maxRows`, the oldest running blocks fold
 * to one line first (개정 4 «화면 높이 상한 넘으면 오래된 실행 블록부터 한 줄로 접음»).
 */
export function renderGraphViewInlineBlocks(views: readonly GraphLoopView[], columns: number, maxRows: number, options: GraphViewRenderOptions): string[][] {
  const top = views.filter((view) => view.parentLoopId === undefined).sort((left, right) => left.startedAt - right.startedAt);
  const blocks = top.map((view) => renderGraphViewInline(view, columns, { ...options, views }));
  const total = () => blocks.reduce((sum, block) => sum + block.length, 0);
  for (let index = 0; index < top.length && total() > maxRows; index += 1) {
    if (top[index]!.status !== 'running' || blocks[index]!.length <= 1) continue;
    const chips = graphViewChips(top[index]!, options.nowMs);
    blocks[index] = paint([fit(`◐ ${top[index]!.kind}${top[index]!.title ? ` · ${top[index]!.title}` : ''} · ${chips.stageIndex}/${chips.stageCount} · ${duration(chips.elapsedMs)}`, columns)], options.color);
  }
  return blocks;
}

// Shared with the detail sidetab (detail.ts) so both views draw lanes, rounds and folded lines the same way.
export {
  bar as graphViewBar, checkpointStages as graphViewCheckpointStages, childLanes as graphViewChildLanes,
  childRow as graphViewChildRow, duration as graphViewDuration, fit as graphViewFit, laneRow as graphViewLaneRow,
  loopGlyph as graphViewLoopGlyph, nodeMarks as graphViewNodeMarks, stageLanes as graphViewStageLanes,
  STAGE_GLYPH as GRAPH_VIEW_STAGE_GLYPH,
};
