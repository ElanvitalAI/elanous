// GRAPH-VIEW-DETAIL-SIDETAB (ASK-GRAPH-LOOP-VIEW-METHOD-1117 개정 5): the detail opened on request from an inline block
// (Ctrl/Alt+click, Enter, or /graph <loopId>[:<node>]). The inline block stays the simple view; everything expanded
// lives here.
//   graph detail   — every node expanded (lanes, every inner-loop round, decisions with confidence, ◆ details) above,
//                    the selected node's activity log below (all nodes when none is selected).
//   harness detail — one row per child; the log follows the selected child; Enter opens that child.
//   child detail   — head «name · model · mini edge · elapsed», the child's real PTY screen read-only above,
//                    its activity log below.
import { graphViewChildLoops, type GraphLoopView, type GraphViewLogEntry } from './model.js';
import {
  GRAPH_VIEW_STAGE_GLYPH, graphViewBar, graphViewCheckpointStages, graphViewChildLanes, graphViewChildRow, graphViewDuration,
  graphViewFit, graphViewLaneRow, graphViewLoopGlyph, graphViewNodeMarks, graphViewStageLanes, renderGraphViewEdge,
  renderGraphViewFolded, renderGraphViewInline,
} from './render.js';

export interface GraphViewDetailTarget { readonly loopId: string; readonly node?: string }

export interface GraphViewDetailOptions {
  readonly nowMs: number;
  readonly views: readonly GraphLoopView[];
  /** Index into graphViewDetailNodes(); undefined = nothing selected (the log shows every node). */
  readonly selected?: number;
  /** The child's PTY screen (plain rows) for child detail; null when the snapshot is unavailable. */
  readonly ptyScreen?: readonly string[] | null;
}

/** A selectable row of the detail: a stage of a graph, or a child of a harness. */
export interface GraphViewDetailNode { readonly id: string; readonly label: string; readonly childLoopId?: string }

// 출처: 개정 5 «위 = 상세 · 아래 = 활동 로그» — the log keeps at least a third of the panel.
const LOG_SHARE = 3;
// 출처: 개정 5 하니스 자식 상세 «위 = 실제 PTY 화면» — the PTY gets three fifths of the rows under the head.
const PTY_SHARE_NUMERATOR = 3;
const PTY_SHARE_DENOMINATOR = 5;
// 출처: sidetab-core/model.ts sidetabWidthForTerminal caps the list at 28 columns; the detail needs a readable edge.
const DETAIL_MIN_COLUMNS = 40;
// 출처: the chat keeps at least this many columns beside the detail, like the narrow-panel pack scenario's 60-column floor.
const DETAIL_CHAT_MIN_COLUMNS = 40;
const DETAIL_MAX_COLUMNS = 90;

export const isHarnessChild = (view: GraphLoopView) => view.parentLoopId !== undefined && view.parentNode === undefined;

/**
 * Columns for the detail panel to the right of the chat, or 0 when the terminal is too narrow and the detail
 * covers the whole screen instead.
 */
export function graphViewDetailWidth(columns: number): number {
  const half = Math.floor(columns / 2);
  if (columns - half - 1 < DETAIL_CHAT_MIN_COLUMNS || half < DETAIL_MIN_COLUMNS) return 0;
  return Math.min(DETAIL_MAX_COLUMNS, half);
}

/** `/graph`, `/graph <loopId>`, `/graph <loopId>:<node>` — loop ids carry ':' (graphId:runId), so the node is after the last one only when it names a known node. */
export function parseGraphCommand(text: string, views: readonly GraphLoopView[]): GraphViewDetailTarget | 'latest' | null {
  const match = /^\/graph(?:\s+(\S+))?\s*$/u.exec(text.trim());
  if (!match) return null;
  const arg = match[1];
  if (!arg) return 'latest';
  const exact = views.find((view) => view.loopId === arg);
  if (exact) return { loopId: exact.loopId };
  const cut = arg.lastIndexOf(':');
  if (cut <= 0) {
    // A short run prefix or a title is accepted when it names exactly one loop.
    const matches = views.filter((view) => view.loopId.endsWith(`:${arg}`) || view.loopId.includes(arg) || view.title === arg);
    return matches.length === 1 ? { loopId: matches[0]!.loopId } : null;
  }
  const loop = views.find((view) => view.loopId === arg.slice(0, cut))
    ?? (() => { const found = views.filter((view) => view.loopId.includes(arg.slice(0, cut)) || view.title === arg.slice(0, cut)); return found.length === 1 ? found[0] : undefined; })();
  return loop ? { loopId: loop.loopId, node: arg.slice(cut + 1) } : null;
}

/** The latest top-level loop: running ones first, then the most recently started. */
export function latestGraphViewLoop(views: readonly GraphLoopView[]): GraphLoopView | undefined {
  const top = views.filter((view) => view.parentLoopId === undefined);
  return [...top].sort((left, right) => Number(right.status === 'running') - Number(left.status === 'running') || right.startedAt - left.startedAt)[0];
}

export function graphViewDetailNodes(view: GraphLoopView, views: readonly GraphLoopView[]): GraphViewDetailNode[] {
  const children = graphViewChildLanes(views, view);
  if (children.length > 0) return children.map((child) => ({ id: child.loopId, label: child.title ?? child.loopId, childLoopId: child.loopId }));
  return view.stages.map((stage) => ({ id: stage.id, label: stage.label }));
}

/** Which row a target selects: a node id, a stage label, or a child loop id; undefined when it names none. */
export function graphViewDetailIndex(view: GraphLoopView, views: readonly GraphLoopView[], node: string | undefined): number | undefined {
  if (node === undefined) return undefined;
  const index = graphViewDetailNodes(view, views).findIndex((candidate) => candidate.id === node || candidate.label === node);
  return index < 0 ? undefined : index;
}

/** The full edge when it fits, else the compact one (the detail is narrower than the full-size sidetab). */
function edgeFor(view: GraphLoopView, width: number, views: readonly GraphLoopView[]): string {
  const full = renderGraphViewEdge(view, 'full', views);
  return Bun.stringWidth(full) <= width ? full : renderGraphViewEdge(view, 'compact', views);
}

const logRow = (view: GraphLoopView, entry: GraphViewLogEntry, prefix = '') =>
  `${prefix}+${graphViewDuration(entry.at - view.startedAt)} ${entry.actor} · ${entry.event}${entry.detail ? ` · ${entry.detail}` : ''}`;

/** Log rows for one stage: events naming it, its workers' events, and its inner-loop rounds. */
function stageLog(view: GraphLoopView, views: readonly GraphLoopView[], stageId: string): string[] {
  const stage = view.stages.find((candidate) => candidate.id === stageId);
  const workers = new Set(view.workers.filter((worker) => worker.stage === stageId).map((worker) => worker.id));
  const own = view.log.filter((entry) => entry.detail === stageId || entry.detail === stage?.label || workers.has(entry.actor)
    || (entry.event.startsWith('checkpoint') && (entry.actor === stageId || entry.detail.startsWith(`${stageId}:`))))
    .map((entry) => ({ at: entry.at, row: logRow(view, entry) }));
  const rounds = graphViewChildLoops(views, view, stageId).flatMap((round) => round.log
    .map((entry) => ({ at: entry.at, row: logRow(view, entry, `↻${round.round ?? 1} `) })));
  return [...own, ...rounds].sort((left, right) => left.at - right.at).map((entry) => entry.row);
}

function tail(rows: readonly string[], count: number): string[] {
  return count <= 0 ? [] : rows.slice(Math.max(0, rows.length - count));
}

/** Every node expanded, the selected one marked ▸. Returns rows and the index of the selected node's first row. */
function graphNodeRows(view: GraphLoopView, views: readonly GraphLoopView[], selected: number | undefined): { rows: string[]; anchor: number } {
  const rows: string[] = [];
  let anchor = 0;
  const checkpointAt = graphViewCheckpointStages(view);
  view.stages.forEach((stage, index) => {
    if (index === selected) anchor = rows.length;
    rows.push(`${index === selected ? '▸' : ' '} ${GRAPH_VIEW_STAGE_GLYPH[stage.status]} ${stage.label}${graphViewNodeMarks(view, stage, views)}`);
    const lanes = graphViewStageLanes(view, stage);
    lanes.forEach((lane, at) => rows.push(`    ${graphViewLaneRow(lane, at === lanes.length - 1 ? '└─' : '├─')}${lane.model ? ` · ${lane.model}` : ''}`));
    const joinTo = lanes.find((lane) => lane.joinTo)?.joinTo;
    if (joinTo) rows.push(`    ↓ join → ${view.stages.find((candidate) => candidate.id === joinTo)?.label ?? joinTo}`);
    if (lanes.length === 0 && stage.status === 'running' && stage.progress !== undefined) rows.push(`    ${graphViewBar(stage.progress)}`);
    // Every round of an inner loop (the inline block shows only the last one).
    for (const round of graphViewChildLoops(views, view, stage.id))
      rows.push(`    ↻${round.round ?? 1}  ${renderGraphViewEdge(round, 'compact', views)}`);
    if (checkpointAt.has(index)) {
      for (const checkpoint of view.checkpoints.filter((candidate) => candidate.id === stage.id || candidate.id.startsWith(`${stage.id}:`)
        || (index === view.stages.length - 1 && !view.stages.some((other) => candidate.id === other.id || candidate.id.startsWith(`${other.id}:`)))))
        rows.push(`    ◆ ${checkpoint.id} · ${checkpoint.status}${checkpoint.actor ? ` · ${checkpoint.actor}` : ''}${checkpoint.summary ? ` · ${checkpoint.summary}` : ''}`);
    }
  });
  if (view.decisions.length > 0) {
    rows.push('decisions');
    for (const decision of view.decisions)
      rows.push(`  ◇ ${decision.question} → ${decision.choice}${decision.confidence === undefined ? '' : ` · ${Math.round(decision.confidence * 100)}%`} · ${decision.route}`);
  }
  return { rows, anchor };
}

/** A window of `count` rows that keeps `anchor` visible, starting from the top when everything fits. */
function windowAround(rows: readonly string[], anchor: number, count: number): string[] {
  if (rows.length <= count) return [...rows];
  const start = Math.max(0, Math.min(anchor - 1, rows.length - count));
  return rows.slice(start, start + count);
}

function childDetail(view: GraphLoopView, width: number, height: number, options: GraphViewDetailOptions): string[] {
  const retry = (view.round ?? 1) > 1 ? ` (retry ${(view.round ?? 1) - 1})` : '';
  const done = view.stages.filter((stage) => stage.status === 'done' || stage.status === 'skipped').length;
  const elapsed = graphViewDuration(Math.max(0, (view.endedAt ?? options.nowMs) - view.startedAt));
  const head = `${graphViewLoopGlyph(view)} ${view.title ?? view.loopId}${retry} · ${view.lead} · ${done}/${view.stages.length} · ${elapsed}`;
  const fixed = [head, edgeFor(view, width, options.views)];
  const body = Math.max(0, height - fixed.length - 2);
  const ptyRows = Math.floor((body * PTY_SHARE_NUMERATOR) / PTY_SHARE_DENOMINATOR);
  const screen = options.ptyScreen ?? null;
  const pty = screen === null
    ? [view.ptyId ? `PTY ${view.ptyId} · snapshot unavailable` : 'no PTY for this child']
    : tail(screen.filter((row, index, all) => row.trim() !== '' || all.slice(index).some((next) => next.trim() !== '')), ptyRows);
  const log = view.log.map((entry) => logRow(view, entry));
  return [...fixed, `── PTY · read-only${view.ptyId ? ` · ${view.ptyId}` : ''} ──`, ...pty.slice(0, ptyRows),
    '── activity ──', ...tail(log, body - Math.min(pty.length, ptyRows))].map((row) => graphViewFit(row, width)).slice(0, height);
}

/** The detail panel for `view` at `width` × `height` (plain text; the panel is opened only on request). */
export function renderGraphViewDetail(view: GraphLoopView, width: number, height: number, options: GraphViewDetailOptions): string[] {
  if (isHarnessChild(view)) return childDetail(view, width, height, options);
  const views = options.views;
  const elapsed = graphViewDuration(Math.max(0, (view.endedAt ?? options.nowMs) - view.startedAt));
  const head = `${view.status === 'running' ? '⎇' : graphViewLoopGlyph(view)} ${view.kind}${view.title ? ` · ${view.title}` : ''} · ${elapsed}`;
  const children = graphViewChildLanes(views, view);
  const nodes = graphViewDetailNodes(view, views);
  const selected = options.selected !== undefined && options.selected < nodes.length ? options.selected : undefined;
  const logRows = Math.max(1, Math.floor(height / LOG_SHARE));
  let top: { rows: string[]; anchor: number };
  let log: string[];
  let logTitle: string;
  if (children.length > 0) {
    top = { rows: children.map((child, index) => `${index === selected ? '▸' : ' '} ${graphViewChildRow(child, '', views).trimStart()}`), anchor: selected ?? 0 };
    const child = selected === undefined ? undefined : children[selected];
    // The log follows the selected child across all its rounds; without a selection, the harness's own log.
    const rounds = child ? views.filter((candidate) => candidate.parentLoopId === view.loopId && (candidate.title ?? candidate.loopId) === (child.title ?? child.loopId)) : [];
    log = child
      ? rounds.flatMap((round) => round.log.map((entry) => ({ at: entry.at, row: logRow(view, entry, rounds.length > 1 ? `↻${round.round ?? 1} ` : '') })))
        .sort((left, right) => left.at - right.at).map((entry) => entry.row)
      : view.log.map((entry) => logRow(view, entry));
    logTitle = child ? `${child.title ?? child.loopId} · Enter opens its PTY` : 'all children';
  } else {
    top = graphNodeRows(view, views, selected);
    const stage = selected === undefined ? undefined : view.stages[selected];
    log = stage ? stageLog(view, views, stage.id) : view.log.map((entry) => logRow(view, entry));
    logTitle = stage ? stage.label : 'all nodes';
  }
  const fixed = [head, ...(view.stages.length > 0 ? [edgeFor(view, width, views)] : [])];
  const topRows = Math.max(1, height - fixed.length - logRows - 2);
  const hint = '↑↓ node · Enter open · Esc close';
  return [...fixed, ...windowAround(top.rows, top.anchor, topRows), `── log · ${logTitle} ──`, ...tail(log, logRows), hint]
    .map((row) => graphViewFit(row, width)).slice(0, height);
}

/**
 * Which loop (and node) a clicked conversation row belongs to. The row is matched against the same renderer output
 * the conversation shows — the live inline block or the folded line — so a click resolves without screen-only state.
 */
export function graphViewTargetAtRow(rowText: string, views: readonly GraphLoopView[], columns: number, nowMs: number): GraphViewDetailTarget | null {
  // eslint-disable-next-line no-control-regex
  const row = rowText.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, '').trimEnd();
  if (!row.trim()) return null;
  for (const view of views.filter((candidate) => candidate.parentLoopId === undefined)) {
    const options = { nowMs, views };
    const children = graphViewChildLanes(views, view);
    for (const child of children)
      if (row.includes(graphViewChildRow(child, '', views).trimStart())) return { loopId: child.loopId };
    const block = renderGraphViewInline(view, columns, options);
    const folded = renderGraphViewFolded(view, options, columns);
    if (block.some((line) => line.trimEnd() === row.trimStart() || row.trimStart().startsWith(line.trimEnd()) && line.trim().length > 0)
      || row.trimStart() === folded) {
      // A lane row of a graph opens the node the lanes run in.
      const laneRow = /^[├└┌]─ /u.test(row.trimStart());
      const current = view.stages.find((stage) => stage.status === 'running') ?? view.stages.at(-1);
      return laneRow && current ? { loopId: view.loopId, node: current.id } : { loopId: view.loopId };
    }
  }
  return null;
}
