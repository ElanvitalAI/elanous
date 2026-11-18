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
    return `${'  '.repeat(level)}${STATUS[node.status].mark} ${node.label}${note ? ` · ${note}` : ''}`;
  };
  /** A graph run's tab text: its own lines, then its nodes one level in (siblings in start order). */
  const tabText = (child: Child): string => {
    const nodes = [...children.values()].filter((row) => row.parent === child.id && isNode(row));
    return [...child.lines, ...nodes.map((node) => nodeLine(node, 1))].join('\n');
  };
  const draw = (child: Child): void => {
    if (child.tab !== undefined) deps.core.patchVirtual(child.tab, { text: tabText(child), title: title(child), state: paneState(child.status) });
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
      draw(child);
      return opened;
    }
    if (!bundles.has(child.ws)) {
      const opened = deps.core.openVirtual({ ws: child.ws, cwd: child.cwd ?? '/', title: `${indent(0)}⎇ +1 more ●`, text: '' });
      if (opened.exitCode !== 0) return opened;
      bundles.set(child.ws, (JSON.parse(opened.message) as { pane: string }).pane);
    }
    child.view = 'bundle';
    refreshBundle(child.ws);
    return out(JSON.stringify({ bundle: bundles.get(child.ws) }));
  };

  return {
    start(input: ChildStart) {
      if (!input.id || !input.ws || !input.label) return refuse('start needs id, ws and label');
      if (children.has(input.id)) return refuse(`${input.id} already started`);
      const parent = input.parent ? children.get(input.parent) : undefined;
      if (input.parent && !parent) return refuse(`unknown parent ${input.parent}`);
      if (input.source === 'graph-node' && parent?.source !== 'graph') return refuse('a graph-node needs its graph run as parent');
      const t = now();
      const child: Child = { ...input, tab: undefined, view: 'none', promo: undefined, status: 'working', note: '', lines: [], startedAt: t, lastAt: t, pinned: false, timer: undefined };
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
      if (isNode(child)) child.note = line;
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
      child.note = isNode(child) ? summary : '';
      child.lines.push(`${STATUS[child.status].mark} ${summary}`);
      touch(child);
      if (isNode(child)) { const run = graphOf(child); if (run) draw(run); return out('ok'); }
      if (child.promo) { clearTimer(child.promo); child.promo = undefined; }
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
