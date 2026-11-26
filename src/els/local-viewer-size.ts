/**
 * ELS-PANE-HEIGHT (대표 11-26 04:57): a pane's PTY size belongs to the viewer on the pane's OWN host while one is attached.
 * REMOTE-PANE-SIZE (#40159/#40183) let a viewer on another host set the PTY to its own (smaller) pane area; the local
 * view never re-sent its size, so the child TUI drew in the top part of the local pane and left the rest empty.
 * Local socket attaches register their last size here; an over-the-network resize is applied only when no local view
 * is attached, and otherwise re-asserts the local size.
 */
export interface PaneSize { readonly cols: number; readonly rows: number }

const viewersByCore = new WeakMap<object, Map<string, Map<object, PaneSize>>>();

function panesOf(core: object): Map<string, Map<object, PaneSize>> {
  let panes = viewersByCore.get(core);
  if (!panes) { panes = new Map(); viewersByCore.set(core, panes); }
  return panes;
}

/** A local view (one socket) attached to `pane` asked for `size`. */
export function noteLocalViewer(core: object, pane: string, viewer: object, size: PaneSize): void {
  const panes = panesOf(core);
  const viewers = panes.get(pane) ?? new Map<object, PaneSize>();
  viewers.delete(viewer);           // re-insert: the newest local request is the last entry
  viewers.set(viewer, { cols: size.cols, rows: size.rows });
  panes.set(pane, viewers);
}

// ELS-OP-INPUT-FLICKER (대표 11-26 09:5x): one size owner per pane — herdr semantics. Two local views of different sizes
// each re-asserted their own rect (createSizeReassert) and the PTY flipped 195x60 <-> 204x47 ~0.5 s apart, on every
// keystroke: typing sends a frame to every view and the other view's re-assert fired 500 ms later. The owner is the
// view that was last ACTIVE (attached/selected the pane, or typed into it). Only the owner resizes the PTY; another
// view's size is remembered and applied once when that view becomes active. Non-owners do not re-assert (letterbox).
const ownersByCore = new WeakMap<object, Map<string, object>>();
/** herdr next_activity_stamp: the last activity of each view, for promote-latest-remaining on detach. */
const activityByCore = new WeakMap<object, Map<string, Map<object, number>>>();
let activityStamp = 0;

function ownersOf(core: object): Map<string, object> {
  let owners = ownersByCore.get(core);
  if (!owners) { owners = new Map(); ownersByCore.set(core, owners); }
  return owners;
}

/** Is `viewer` the pane's size owner (or is there none)? */
export function isSizeOwner(core: object, pane: string, viewer: object): boolean {
  const owner = ownersByCore.get(core)?.get(pane);
  return owner === undefined || owner === viewer;
}

/** `viewer` was active (attached or typed): it owns the pane's size. Returns its remembered size when ownership moved. */
export function claimSizeOwner(core: object, pane: string, viewer: object): PaneSize | undefined {
  const previous = ownersOf(core).get(pane);
  ownersOf(core).set(pane, viewer);
  let stamps = activityByCore.get(core);
  if (!stamps) { stamps = new Map(); activityByCore.set(core, stamps); }
  const views = stamps.get(pane) ?? new Map<object, number>();
  views.set(viewer, ++activityStamp); stamps.set(pane, views);
  return previous === viewer ? undefined : viewersByCore.get(core)?.get(pane)?.get(viewer);
}

/** May `viewer` set the pane's size? Yes when it is the owner or no owner is attached (it then becomes the owner). */
export function localResizeAllowed(core: object, pane: string, viewer: object): boolean {
  const owner = ownersOf(core).get(pane);
  if (owner === undefined || owner === viewer) { ownersOf(core).set(pane, viewer); return true; }
  return false;
}

/** The local view ended. When it was the size owner, the most recently active remaining view is promoted
 *  (herdr promote_latest_remaining_client) and its size is returned for the caller to apply. */
export function dropLocalViewer(core: object, pane: string, viewer: object): PaneSize | undefined {
  const wasOwner = ownersByCore.get(core)?.get(pane) === viewer;
  if (wasOwner) ownersByCore.get(core)!.delete(pane);
  activityByCore.get(core)?.get(pane)?.delete(viewer);
  const panes = viewersByCore.get(core);
  const viewers = panes?.get(pane);
  if (!viewers) return undefined;
  viewers.delete(viewer);
  if (viewers.size === 0) { panes!.delete(pane); activityByCore.get(core)?.delete(pane); return undefined; }
  if (!wasOwner) return undefined;
  const stamps = activityByCore.get(core)?.get(pane);
  let next: object | undefined; let best = -1;
  for (const view of viewers.keys()) { const at = stamps?.get(view) ?? 0; if (at > best) { best = at; next = view; } }
  if (next === undefined) return undefined;
  ownersOf(core).set(pane, next);
  return viewers.get(next);
}

/** The size the most recent local view asked for, or undefined when no local view is attached. */
export function localViewerSize(core: object, pane: string): PaneSize | undefined {
  const viewers = viewersByCore.get(core)?.get(pane);
  if (!viewers || viewers.size === 0) return undefined;
  const owner = ownersByCore.get(core)?.get(pane);
  return (owner !== undefined ? viewers.get(owner) : undefined) ?? [...viewers.values()].at(-1);
}

/** A resize asked over the network (another host's viewer): while a local view is attached its size wins. */
export function remoteResize<R extends { exitCode: number }>(core: { resize(ref: string, cols: number, rows: number): R }, pane: string, cols: number, rows: number, by = 'host:remote'): { readonly result: R; readonly kept: boolean } {
  const local = localViewerSize(core, pane);
  const size = local ?? { cols, rows };
  const result = core.resize(pane, size.cols, size.rows);
  if (result.exitCode === 0) noteResize(core, pane, size, local ? 'viewer:local(kept)' : by);
  return { result, kept: local !== undefined };
}

// ELS-PANE-HEIGHT r2: one structured line per real size change — `els.pane.resize {pane, from, to, by}` — so the next
// shrink names who did it (by = `viewer:local` for a socket attach on this host, `host:<name>/<pane>` for a remote ask).
const lastSize = new WeakMap<object, Map<string, PaneSize>>();
const resizeSinks = new WeakMap<object, (line: string) => void>();

export function setResizeLog(core: object, sink: (line: string) => void): void { if (!resizeSinks.has(core)) resizeSinks.set(core, sink); }

/** Record a resize that the core accepted; logs only when the size really changed. */
export function noteResize(core: object, pane: string, to: PaneSize, by: string, at = Date.now()): { pane: string; from: PaneSize | null; to: PaneSize; by: string } | undefined {
  let panes = lastSize.get(core);
  if (!panes) { panes = new Map(); lastSize.set(core, panes); }
  const from = panes.get(pane) ?? null;
  panes.set(pane, { cols: to.cols, rows: to.rows });
  if (from && from.cols === to.cols && from.rows === to.rows) return undefined;
  const event = { pane, from, to: { cols: to.cols, rows: to.rows }, by };
  try { resizeSinks.get(core)?.(`${JSON.stringify({ event: 'els.pane.resize', at: new Date(at).toISOString(), ...event })}\n`); } catch { /* logging never blocks a resize */ }
  return event;
}

/**
 * The focused viewer re-asserts its pane rect when the frames say the PTY is another size (a second local view, a
 * remote viewer, a create with a stale size, anything). Only on mismatch, debounced, and rate-limited so two views
 * fighting over one pane cannot make a SIGWINCH storm.
 */
export interface SizeReassertOptions {
  readonly send: (size: PaneSize) => void;
  readonly now?: () => number;
  readonly schedule?: (run: () => void, ms: number) => { cancel(): void };
  readonly debounceMs?: number;
  /** At most `burst` re-asserts per `windowMs` per pane. */
  readonly burst?: number;
  readonly windowMs?: number;
}

export function createSizeReassert(options: SizeReassertOptions) {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((run, ms) => { const t = setTimeout(run, ms); t.unref?.(); return { cancel: () => clearTimeout(t) }; });
  const debounceMs = options.debounceMs ?? 500;
  const burst = options.burst ?? 3;
  const windowMs = options.windowMs ?? 30_000;
  let pending: { cancel(): void } | undefined;
  let latest: { pane: string; seen: PaneSize; want: PaneSize } | undefined;
  const sent = new Map<string, number[]>();
  return {
    /** Every frame: the PTY size it carries and the viewer's pane rect. */
    frame(pane: string, seen: PaneSize, want: PaneSize): void {
      latest = { pane, seen, want };
      if (seen.cols === want.cols && seen.rows === want.rows) { pending?.cancel(); pending = undefined; return; }
      if (pending) return;
      pending = schedule(() => {
        pending = undefined;
        const last = latest;
        if (!last || (last.seen.cols === last.want.cols && last.seen.rows === last.want.rows)) return;
        const t = now();
        const times = (sent.get(last.pane) ?? []).filter((at) => t - at < windowMs);
        if (times.length >= burst) { sent.set(last.pane, times); return; }
        times.push(t); sent.set(last.pane, times);
        options.send(last.want);
      }, debounceMs);
    },
    /** The selection moved or the view ended. */
    reset(): void { pending?.cancel(); pending = undefined; latest = undefined; },
  };
}
