// els child tabs — a child component seen inside a parent workspace becomes a tab by itself and closes when done.
// Sources (events that already exist; this module only turns them into tabs): sub-agent start/end, harness child
// (run ledger), graph run + node-progress (#38168), side-tab mission, background shell.
//   - tab title «↳ ⎇ harness · label ●» (indent by depth, kind glyph, shared status mark from status-vocab.ts),
//   - a graph run is one tab; its nodes are lines inside it (one level deeper, parallel nodes are siblings); a harness
//     or sub-agent that runs inside a node (`parent` = node id) gets its own tab one level deeper,
//   - success: one result line goes to the parent (returned and passed to `notifyParent`), the tab closes after
//     `closeDelayMs` (10 s) unless pinned; failure: the tab stays marked ✕ until `dismiss`,
//   - only long-lived children get a tab: one still alive after `tabAfterMs` (60 s); shorter ones live in the parent
//     line summary only. A background shell never gets a tab (parent suffix «⌁n» + expandable list) unless pinned,
//   - at most `maxPerWs` (4) auto tabs per parent workspace and `maxTabs` (8) overall; the rest share ONE
//     «⎇ +n» bundle tab per workspace,
//   - `tree()` / `summary()` give the left list (ELS1) the same rows and the «⎇3 ●2 ✕1» suffix: state is kept here once.
import type { ElsCore, ElsResult } from './core.js';
import type { PaneState } from './space.js';
import { projectGraphLoopViews, type GraphViewEvent } from '../graph-view/model.js';
import { renderGraphDashboard, type DashboardColorMode } from '../graph-view/dashboard.js';
import { renderGraphView } from '../graph-view/render.js';
import { agoText, childSummary, KIND_GLYPH, STATUS, type ChildKind, type StatusWord } from './status-vocab.js';

export type ChildSource = ChildKind | 'graph-node';

export interface ChildStart {
  readonly id: string;
  readonly ws: string;
  readonly cwd?: string;
  readonly source: ChildSource;
  readonly label: string;
  /** The child (or graph node) this one runs inside. A graph-node needs its graph run here. */
  readonly parent?: string;
}

export interface ChildTabsDeps {
  readonly core: Pick<ElsCore, 'openVirtual' | 'patchVirtual' | 'closeVirtual'>;
  readonly notifyParent?: (ws: string, line: string) => void;
  readonly maxTabs?: number;
  readonly maxPerWs?: number;
  readonly tabAfterMs?: number;
  readonly closeDelayMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Repaint period of a graph run's widget (spinner). Default 1 s; the timer lives only while a graph tab is running. */
  readonly tickMs?: number;
  /** Size of a tab's pane (maximize / resize changes it); a graph tab draws the full dashboard when it is large enough. */
  readonly paneSize?: (pane: string) => { readonly cols: number; readonly rows: number };
  readonly colorMode?: DashboardColorMode;
  readonly setTick?: (fn: () => void, ms: number) => unknown;
  readonly clearTick?: (handle: unknown) => void;
}

interface Child extends Omit<ChildStart, 'parent'> {
  parent?: string | undefined;
  tab: string | undefined; // pane id of its own tab; undefined for a graph node, a pending/no-tab child or a bundled one
  view: 'pending' | 'tab' | 'bundle' | 'none';
  promo: unknown;
  status: StatusWord;
  note: string;
  lines: string[];
  startedAt: number;
  lastAt: number;
  pinned: boolean;
  timer: unknown;
  tick: number;
  ticker: unknown;
  endedAt?: number;
  drawn?: string;
  model?: string;
}

export interface ChildRow {
  readonly id: string;
  readonly depth: number;
  readonly text: string;
  readonly state: StatusWord;
  readonly color: string;
  readonly elapsed: string;
  readonly last: string;
}

const MAX_LINES = 200;
const out = (text: string) => ({ exitCode: 0 as const, message: text });
const refuse = (text: string) => ({ exitCode: 1 as const, message: `els child: ${text}` });
const paneState = (status: StatusWord): PaneState =>
  status === 'working' ? 'working' : status === 'blocked' ? 'blocked' : status === 'idle' ? 'idle' : 'done';

export function createChildTabs(deps: ChildTabsDeps) {
  const maxTabs = deps.maxTabs ?? 8;
  const maxPerWs = deps.maxPerWs ?? 4;
  const tabAfterMs = deps.tabAfterMs ?? 60_000;
  const closeDelayMs = deps.closeDelayMs ?? 10_000;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle; });
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const tickMs = deps.tickMs ?? 500; // ≤ 2 fps by default; a repaint whose text did not change is not sent
  const colorMode: DashboardColorMode = deps.colorMode ?? (/truecolor|24bit/u.test(process.env.COLORTERM ?? '') ? 'truecolor' : /256/u.test(process.env.TERM ?? '') ? '256' : 'none');
  const setTick = deps.setTick ?? ((fn, ms) => { const handle = setInterval(fn, ms); handle.unref?.(); return handle; });
  const clearTick = deps.clearTick ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const children = new Map<string, Child>();
  const bundles = new Map<string, string>(); // ws -> bundle pane id

  const isNode = (child: Child): boolean => child.source === 'graph-node';
  const depth = (child: Child): number => {
    let n = 0;
    for (let up = child.parent ? children.get(child.parent) : undefined; up; up = up.parent ? children.get(up.parent) : undefined) n++;
    return n;
  };
  const indent = (n: number): string => `${'  '.repeat(n)}↳ `;
  const kindName = (child: Child): string => child.source === 'graph-node' ? 'node' : child.source;
  const glyph = (child: Child): string => child.source === 'graph-node' ? '' : `${KIND_GLYPH[child.source]} `;
  const title = (child: Child): string => `${indent(depth(child))}${glyph(child)}${kindName(child)} · ${child.label} ${STATUS[child.status].mark}`;
  const nodeLine = (node: Child, level: number): string => {
    const note = node.status === 'blocked' && !node.note ? '승인 대기' : node.note;
    // A node's start/progress/status is its last observed event, not proof that it is still active forever.
    const quietMs = Math.max(0, now() - node.lastAt);
    const mark = node.status !== 'working' ? STATUS[node.status].mark
      : quietMs <= 300_000 ? STATUS.working.mark : quietMs <= 1_500_000 ? STATUS.stalled.mark : STATUS.failed.mark;  // 출처: OP #134199/#134208 — 마크 이모지를 한 어휘로
    return `${'  '.repeat(level)}${mark} ${node.label}${note ? ` · ${note}` : ''}`;
  };
  /** A graph run's tab text: its own lines, then its nodes one level in (siblings in start order). */
  const tabText = (child: Child): string => {
    const nodes = [...children.values()].filter((row) => row.parent === child.id && isNode(row));
    const lines = [...child.lines, ...nodes.map((node) => nodeLine(node, 1))].join('\n');
    if (child.source !== 'graph') return lines;
    const widget = graphWidget(child, nodes);
    return widget.length > 8 ? widget.join('\n') : `${widget.join('\n')}\n\n${lines}`;
  };
  /** The graph-view widget (the same one the TUI draws): stage edge of the nodes seen so far, spinner on the running one. */
  const graphWidget = (child: Child, nodes: Child[]): string[] => {
    const events: GraphViewEvent[] = [
      { type: 'loop.started', loopId: 'g', at: child.startedAt, kind: 'graph', lead: 'graph', title: child.label },
      ...nodes.map((node): GraphViewEvent => ({ type: 'stage.changed', loopId: 'g', at: node.lastAt, stage: node.label,
        status: node.status === 'done' ? 'done' : node.status === 'failed' ? 'failed' : 'running' })),
      ...(child.status === 'done' || child.status === 'failed'
        ? [{ type: 'loop.ended', loopId: 'g', at: child.lastAt, status: child.status === 'done' ? 'done' : 'failed' } as GraphViewEvent] : []),
    ];
    const size = child.tab !== undefined ? deps.paneSize?.(child.tab) : undefined;
    const dash = size ? renderGraphDashboard({ name: child.label, status: child.status === 'done' ? 'done' : child.status === 'failed' ? 'failed' : 'running',
      startedAt: child.startedAt, ...(child.status === 'done' || child.status === 'failed' ? { endedAt: child.lastAt } : {}), nowMs: now(), tick: child.tick,
      cols: size.cols, rows: size.rows, color: colorMode,
      nodes: nodes.map((node) => ({ id: node.id, label: node.label, startedAt: node.startedAt, ...(node.endedAt !== undefined ? { endedAt: node.endedAt } : {}),
        state: node.status === 'done' ? 'done' as const : node.status === 'failed' ? 'failed' as const : node.status === 'blocked' ? 'blocked' as const : 'running' as const,
        note: node.model && !/\bmodel[:=]/u.test(node.note) ? `model=${node.model} · ${node.note}` : node.note })) }) : null;
    if (dash) return dash;
    const view = projectGraphLoopViews(events).get('g');
    return view ? renderGraphView(view, 100, 24, { nowMs: now(), tick: child.tick, color: false }) : [];
  };
  const stopTick = (child: Child): void => { if (child.ticker !== undefined) { clearTick(child.ticker); child.ticker = undefined; } };
  const draw = (child: Child): void => {
    if (child.tab === undefined) return;
    const text = tabText(child);
    const key = `${title(child)}\0${child.status}\0${text}`;
    if (child.drawn === key) return; // dirty-only: an identical frame is not sent
    child.drawn = key;
    deps.core.patchVirtual(child.tab, { text, title: title(child), state: paneState(child.status) });
  };
  const graphOf = (node: Child): Child | undefined => node.parent ? children.get(node.parent) : undefined;

  const ownTabs = (): number => [...children.values()].filter((row) => row.view === 'tab').length;
  const wsTabs = (ws: string): number => [...children.values()].filter((row) => row.view === 'tab' && row.ws === ws).length;
  const bundled = (ws: string): Child[] => [...children.values()].filter((row) => row.ws === ws && row.view === 'bundle');
  const refreshBundle = (ws: string): void => {
    const pane = bundles.get(ws);
    if (!pane) return;
    const rows = bundled(ws);
    const state: StatusWord = rows.some((r) => r.status === 'working') ? 'working' : rows.some((r) => r.status === 'blocked') ? 'blocked'
      : rows.some((r) => r.status === 'failed') ? 'failed' : 'done';
    deps.core.patchVirtual(pane, { text: rows.map((r) => `${STATUS[r.status].mark} ${kindName(r)} · ${r.label} ${r.lines.at(-1) ?? ''}`.trimEnd()).join('\n'),
      title: `${indent(0)}⎇ +${rows.length} more ${STATUS[state].mark}`, state: paneState(state) });
  };
  const sweepBundle = (ws: string): void => {
    const pane = bundles.get(ws);
    if (!pane) return;
    const rows = bundled(ws);
    if (rows.some((row) => row.status !== 'done' || row.pinned)) return;
    for (const row of rows) children.delete(row.id);
    bundles.delete(ws);
    deps.core.closeVirtual(pane);
  };
  const remove = (child: Child): void => {
    if (child.timer) clearTimer(child.timer);
    if (child.promo) clearTimer(child.promo);
    stopTick(child);
    children.delete(child.id);
    // Its nodes go with it; anything still running below it moves up to the removed child's own parent.
    const gone = new Set([child.id, ...[...children.values()].filter((row) => row.parent === child.id && isNode(row)).map((row) => row.id)]);
    for (const id of gone) if (id !== child.id) children.delete(id);
    for (const row of children.values()) if (row.parent && gone.has(row.parent)) {
      if (child.parent) row.parent = child.parent; else row.parent = undefined;
    }
    if (child.tab !== undefined) deps.core.closeVirtual(child.tab);
  };
  const scheduleClose = (child: Child): void => {
    if (child.pinned || child.status !== 'done' || isNode(child)) return;
    if (child.timer) clearTimer(child.timer);
    child.timer = setTimer(() => {
      child.timer = undefined;
      if (child.pinned || children.get(child.id) !== child) return;
      if (child.view === 'bundle') sweepBundle(child.ws); else remove(child);
    }, closeDelayMs);
  };
  const touch = (child: Child): void => { child.lastAt = now(); };

  /** Give a long-lived child its tab (or a place in the workspace bundle when the caps are reached). */
  const promote = (child: Child): ElsResult => {
    if (children.get(child.id) !== child || child.view === 'tab' || child.view === 'bundle') return out('ok');
    if (child.promo) { clearTimer(child.promo); child.promo = undefined; }
    if (ownTabs() < maxTabs && wsTabs(child.ws) < maxPerWs) {
      const opened = deps.core.openVirtual({ ws: child.ws, cwd: child.cwd ?? '/', title: title(child), text: tabText(child) });
      if (opened.exitCode !== 0) {
        // A failed save must not lose the tab for good: try again on the next period (a pin reports the failure now).
        if (!child.pinned && child.promo === undefined) child.promo = setTimer(() => { child.promo = undefined; promote(child); }, tabAfterMs);
        return opened;
      }
      child.tab = (JSON.parse(opened.message) as { pane: string }).pane;
      child.view = 'tab';
      if (child.source === 'graph' && child.status !== 'done' && child.status !== 'failed' && tickMs > 0)
        child.ticker = setTick(() => { child.tick++; if (children.get(child.id) !== child || child.status === 'done' || child.status === 'failed') { stopTick(child); return; } draw(child); }, tickMs);
      draw(child);
      return opened;
    }
    if (!bundles.has(child.ws)) {
      const opened = deps.core.openVirtual({ ws: child.ws, cwd: child.cwd ?? '/', title: `${indent(0)}⎇ +1 more ${STATUS.working.mark}`, text: '' });
      if (opened.exitCode !== 0) return opened;
      bundles.set(child.ws, (JSON.parse(opened.message) as { pane: string }).pane);
    }
    child.view = 'bundle';
    refreshBundle(child.ws);
    return out(JSON.stringify({ bundle: bundles.get(child.ws) }));
  };

  return {
    workspaceOf(id: string): string | undefined { return children.get(id)?.ws; },
    start(input: ChildStart) {
      if (!input.id || !input.ws || !input.label) return refuse('start needs id, ws and label');
      if (children.has(input.id)) return refuse(`${input.id} already started`);
      const parent = input.parent ? children.get(input.parent) : undefined;
      if (input.parent && !parent) return refuse(`unknown parent ${input.parent}`);
      if (input.source === 'graph-node' && parent?.source !== 'graph') return refuse('a graph-node needs its graph run as parent');
      const t = now();
      const child: Child = { ...input, tab: undefined, view: 'none', promo: undefined, status: 'working', note: '', lines: [], startedAt: t, lastAt: t, pinned: false, timer: undefined, tick: 0, ticker: undefined };
      children.set(child.id, child);
      if (isNode(child)) { draw(parent!); return out('ok'); }
      if (child.source === 'shell') return out('ok'); // no tab unless pinned
      child.view = 'pending';
      child.promo = setTimer(() => { child.promo = undefined; promote(child); }, tabAfterMs);
      return out('ok');
    },

    progress(id: string, line: string) {
      const child = children.get(id);
      if (!child) return refuse(`unknown child ${id}`);
      if (child.status === 'done' || child.status === 'failed') return refuse(`${id} already ended`);
      child.lines.push(line);
      if (child.lines.length > MAX_LINES) child.lines.splice(0, child.lines.length - MAX_LINES);
      touch(child);
      if (isNode(child)) { child.note = line; const m = /\bmodel[:=]\s*([\w./-]+)/u.exec(line)?.[1]; if (m) child.model = m; }
      const owner = isNode(child) ? graphOf(child) : child;
      if (owner?.view === 'bundle') refreshBundle(child.ws); else if (owner) draw(owner);
      return out('ok');
    },

    /** A non-final state from the ledger (node-progress / report_agent): working, blocked («승인 대기») or idle. */
    status(id: string, state: 'working' | 'blocked' | 'idle', note = '') {
      const child = children.get(id);
      if (!child) return refuse(`unknown child ${id}`);
      if (child.status === 'done' || child.status === 'failed') return refuse(`${id} already ended`);
      child.status = state;
      child.note = note;
      touch(child);
      const owner = isNode(child) ? graphOf(child) : child;
      if (owner?.view === 'bundle') refreshBundle(child.ws); else if (owner) draw(owner);
      return out('ok');
    },

    /** The child ended. Returns the one result line for the parent session (a node has none: its run reports). */
    end(id: string, ok: boolean, summary: string) {
      const child = children.get(id);
      if (!child) return refuse(`unknown child ${id}`);
      if (child.status === 'done' || child.status === 'failed') return refuse(`${id} already ended`);
      child.status = ok ? 'done' : 'failed';
      child.endedAt = now();
      child.note = isNode(child) ? summary : '';
      child.lines.push(`${STATUS[child.status].mark} ${summary}`);
      touch(child);
      if (isNode(child)) { const run = graphOf(child); if (run) draw(run); return out('ok'); }
      if (child.promo) { clearTimer(child.promo); child.promo = undefined; }
      stopTick(child);
      draw(child);
      if (child.view === 'bundle') refreshBundle(child.ws);
      const line = `${KIND_GLYPH[child.source as ChildKind]} ${child.label} [${child.source}] ${ok ? 'done' : 'FAILED'}: ${summary}`;
      try { deps.notifyParent?.(child.ws, line); } catch { /* the parent line is best effort */ }
      if (ok) scheduleClose(child);
      return out(line);
    },

    pin(id: string) {
      const child = children.get(id);
      if (!child) return refuse(`unknown child ${id}`);
      child.pinned = true;
      if (child.timer) { clearTimer(child.timer); child.timer = undefined; }
      if (!isNode(child)) { const shown = promote(child); if (shown.exitCode !== 0) return shown; }
      return out('pinned');
    },
    unpin(id: string) {
      const child = children.get(id);
      if (!child) return refuse(`unknown child ${id}`);
      child.pinned = false;
      scheduleClose(child);
      return out('unpinned');
    },
    /** Close a finished child's tab now (a failed one stays until this). */
    dismiss(id: string) {
      const child = children.get(id);
      if (!child) return refuse(`unknown child ${id}`);
      if (child.status === 'working' || child.status === 'blocked' || child.status === 'idle') return refuse(`${id} is still running`);
      const ws = child.ws;
      const wasBundled = child.view === 'bundle';
      remove(child);
      if (wasBundled) {
        if (bundled(ws).length === 0) { const pane = bundles.get(ws); bundles.delete(ws); if (pane) deps.core.closeVirtual(pane); }
        else refreshBundle(ws);
      }
      return out('closed');
    },

    /** Rows for the left list under workspace `ws`: parent order, children indented, graph nodes one level deeper. */
    tree(ws: string): ChildRow[] {
      const at = now();
      const rows: ChildRow[] = [];
      const walk = (parentId: string | undefined, level: number): void => {
        for (const child of children.values()) {
          if (child.ws !== ws || child.parent !== parentId) continue;
          const note = child.status === 'blocked' && isNode(child) && !child.note ? '승인 대기' : child.note;
          rows.push({ id: child.id, depth: level, state: child.status, color: STATUS[child.status].color,
            text: isNode(child) ? nodeLine(child, level)
              : `${indent(level)}${glyph(child)}${kindName(child)} · ${child.label}${note ? ` · ${note}` : ''}`,
            elapsed: agoText(at - child.startedAt).replace(' 전', ''), last: agoText(at - child.lastAt) });
          walk(child.id, level + 1);
        }
      };
      walk(undefined, 0);
      return rows;
    },

    /** «⎇3 ●2 ✕1» for the parent line: the workspace's top-level children. */
    summary(ws: string): string {
      const top = [...children.values()].filter((row) => row.ws === ws && !row.parent);
      const shells = top.filter((row) => row.source === 'shell' && row.status !== 'done' && row.status !== 'failed').length;
      const base = childSummary(top.filter((row) => row.source !== 'shell').map((row) => row.status));
      return [base, shells > 0 ? `⌁${shells}` : ''].filter(Boolean).join(' ');
    },
  };
}

export type ChildTabs = ReturnType<typeof createChildTabs>;
