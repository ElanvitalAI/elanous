// GRAPH-VIEW-DETAIL-SIDETAB (ASK-GRAPH-LOOP-VIEW-METHOD-1117 개정 5) — the Next TUI side of the graph loop detail.
// Opened only on request (Ctrl/Alt+click on an inline block row, Ctrl+G, /graph [loopId[:node]]), shown as a panel
// right of the chat or over the whole screen when there is no room. entry.ts only forwards keys, the painted chat
// rows and the frame to this controller (대표 10-25 TUI radius rule: features live in their own module).
import type { GraphLoopView } from '../../graph-view/model.js';
import {
  graphViewDetailIndex, graphViewDetailNodes, graphViewDetailWidth, graphViewTargetAtRow, isHarnessChild,
  latestGraphViewLoop, parseGraphCommand, renderGraphViewDetail, type GraphViewDetailTarget,
} from '../../graph-view/detail.js';
import { fitLogLine } from '../chat/log-view.js';

export interface GraphDetailHost {
  /** Every graph loop this session showed (settled turns and the running one). */
  views(): GraphLoopView[];
  render(): void;
  setStatus(text: string): void;
  /** A harness child's PTY screen, read-only (defaults to the PTY manifest snapshot). */
  readPty?(ptyId: string, columns: number): Promise<string[] | null>;
}

export interface GraphDetailKey {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly mouse?: { readonly row: number; readonly col: number; readonly type: string };
}

type DetailState = { loopId: string; selected?: number; parent?: { loopId: string; selected?: number } };

export const GRAPH_DETAIL_STATUS = 'Graph detail · ↑↓ node · Enter open · Esc close';
const IDLE_STATUS = 'Enter send · Esc cancel · Ctrl+Q quit';
// 출처: pty-shell manifest snapshots refresh about once a second; the panel follows at the same pace.
const PTY_REFRESH_MS = 1000;
// 출처: a terminal screen is at most a few hundred rows; the panel keeps only the tail it can show.
const PTY_TAIL_ROWS = 200;

/** The PTY manifest snapshot of `ptyId` as plain rows (the `pty snapshot` source); nothing is ever written to it. */
async function manifestPtyRows(ptyId: string, columns: number): Promise<string[] | null> {
  const [{ listPtyManifestRows }, { formatSidetabPeekLines }] = await Promise.all([
    import('../../pty-shell/pty-manifest.js'), import('../sidetab/peek.js')]);
  const row = listPtyManifestRows().find((candidate) => candidate.id === ptyId);
  const source = row ? row.snapshot || row.frame : '';
  return source ? formatSidetabPeekLines(source, Math.max(5, columns), PTY_TAIL_ROWS) : null;
}

export function createGraphDetailController(host: GraphDetailHost) {
  let state: DetailState | null = null;
  let focused = false;
  let pty: string[] | null = null;
  let ptyTimer: ReturnType<typeof setInterval> | null = null;
  let chatRows: readonly string[] = [];
  let chatColumns = 0;
  let chatLeft = 0;
  const readPty = host.readPty ?? manifestPtyRows;

  const current = (views = host.views()) => (state ? views.find((view) => view.loopId === state!.loopId) : undefined);
  const stopPty = (): void => {
    if (ptyTimer !== null) clearInterval(ptyTimer);
    ptyTimer = null;
    pty = null;
  };
  const refreshPty = async (): Promise<void> => {
    const view = current();
    try { pty = view?.ptyId ? await readPty(view.ptyId, process.stdout.columns || 80) : null; }
    catch { pty = null; }
  };
  const open = (target: GraphViewDetailTarget, from?: { loopId: string; selected?: number }): boolean => {
    const views = host.views();
    const view = views.find((candidate) => candidate.loopId === target.loopId);
    if (!view) { host.setStatus('Graph not found · /graph lists the latest loop'); return false; }
    // Reopening the same target keeps the open detail (one detail tab, no duplicates).
    if (state?.loopId !== view.loopId || target.node !== undefined) {
      const selected = graphViewDetailIndex(view, views, target.node)
        ?? graphViewDetailNodes(view, views).findIndex((node) => view.stages.find((stage) => stage.id === node.id)?.status === 'running');
      state = { loopId: view.loopId, ...(selected >= 0 ? { selected } : {}), ...(from ? { parent: from } : {}) };
    }
    focused = true;
    stopPty();
    if (isHarnessChild(view)) {
      void refreshPty().then(() => host.render());
      ptyTimer = setInterval(() => { void refreshPty().then(() => host.render()); }, PTY_REFRESH_MS);
    }
    host.setStatus(GRAPH_DETAIL_STATUS);
    return true;
  };
  const close = (): void => {
    stopPty();
    state = null;
    focused = false;
    host.setStatus(IDLE_STATUS);
  };
  const lines = (width: number, height: number): string[] => {
    const views = host.views();
    const view = current(views);
    if (!view) return [fitLogLine('Graph not found · Esc close', width)];
    return renderGraphViewDetail(view, width, height, { nowMs: Date.now(), views,
      ...(state?.selected === undefined ? {} : { selected: state.selected }), ptyScreen: pty });
  };
  const openLatest = (): void => {
    const latest = latestGraphViewLoop(host.views());
    if (latest) open({ loopId: latest.loopId });
    else host.setStatus('No graph loop in this session yet');
  };

  return {
    get isOpen() { return state !== null; },
    /** Panel columns right of the chat; 0 when closed or when the detail must cover the screen instead. */
    columns(totalColumns: number): number { return state ? graphViewDetailWidth(totalColumns) : 0; },
    /** Full-screen rows (height = rows - 1, the caller adds its footer) when open with no room beside the chat. */
    overlay(totalColumns: number, rows: number, compact: boolean): string[] | null {
      if (!state || (!compact && graphViewDetailWidth(totalColumns) > 0)) return null;
      const body = lines(totalColumns, rows - 1);
      return [...body, ...Array<string>(Math.max(0, rows - 1 - body.length)).fill('')];
    },
    /** The chat rows as painted (index = screen row - 1), their width and left edge, for Ctrl/Alt+click. */
    noteChatFrame(rows: readonly string[], columns: number, left: number): void {
      chatRows = rows;
      chatColumns = columns;
      chatLeft = left;
    },
    /** Screen rows with the detail panel joined to the right of `screenLines` (unchanged when there is no panel). */
    compose(screenLines: readonly string[], totalColumns: number, rows: number): string[] {
      const panel = this.columns(totalColumns);
      if (panel === 0) return [...screenLines];
      const detail = lines(panel, Math.max(1, rows - 1));
      const left = totalColumns - panel - 1;
      return Array.from({ length: Math.max(screenLines.length, detail.length) }, (_, index) => {
        const row = screenLines[index] ?? '';
        return `${row}${' '.repeat(Math.max(0, left - Bun.stringWidth(row)))}│${detail[index] ?? ''}`;
      });
    },
    /** `/graph`, `/graph <loopId>`, `/graph <loopId>:<node>`. */
    runCommand(text: string): void {
      const views = host.views();
      const parsed = parseGraphCommand(text, views);
      if (parsed === 'latest') openLatest();
      else if (parsed) open(parsed);
      else host.setStatus(views.length === 0 ? 'No graph loop in this session yet'
        : `Graph not found · loops: ${views.filter((view) => view.parentLoopId === undefined).map((view) => view.loopId).join(', ')}`);
    },
    /** True when the key belonged to the detail (the caller renders and moves on). */
    handleKey(key: GraphDetailKey, composerEmpty: boolean): boolean {
      // Ctrl/Alt+click on an inline block row opens its detail.
      if (key.name === 'mouse' && key.mouse?.type === 'click' && (key.ctrl || key.alt || key.meta)) {
        const row = chatRows[key.mouse.row - 1];
        const target = row !== undefined && key.mouse.col > chatLeft ? graphViewTargetAtRow(row, host.views(), chatColumns, Date.now()) : null;
        return target ? (open(target), true) : false;
      }
      if (key.ctrl && key.name === 'g' && !key.alt && !key.meta) {
        if (state) close(); else openLatest();
        return true;
      }
      if (!state || !focused) return false;
      const plain = !key.ctrl && !key.alt && !key.shift;
      if ((key.name === 'up' || key.name === 'down') && plain) {
        const views = host.views();
        const view = current(views);
        const count = view ? graphViewDetailNodes(view, views).length : 0;
        if (count > 0) {
          const from = state.selected ?? (key.name === 'down' ? -1 : count);
          state = { ...state, selected: Math.max(0, Math.min(count - 1, from + (key.name === 'down' ? 1 : -1))) };
        }
        return true;
      }
      if ((key.name === 'enter' || key.name === 'return') && !key.shift && composerEmpty) {
        const views = host.views();
        const view = current(views);
        const node = view && state.selected !== undefined ? graphViewDetailNodes(view, views)[state.selected] : undefined;
        // Enter on a harness child opens that child's detail (its PTY read-only and its activity log).
        if (node?.childLoopId) open({ loopId: node.childLoopId }, { loopId: state.loopId, ...(state.selected === undefined ? {} : { selected: state.selected }) });
        return true;
      }
      if (key.name === 'escape') {
        const parent = state.parent;
        if (parent) {
          stopPty();
          state = { loopId: parent.loopId, ...(parent.selected === undefined ? {} : { selected: parent.selected }) };
          host.setStatus(GRAPH_DETAIL_STATUS);
        } else close();
        return true;
      }
      // Typing goes back to the composer; the detail stays open until Esc or Ctrl+G.
      if (key.name !== 'mouse') focused = false;
      return false;
    },
    dispose: stopPty,
  };
}
