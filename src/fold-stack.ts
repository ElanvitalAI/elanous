// ── Fold stack — unified fold/unfold controller for the log pane ──
//
// Before this module the dashboard had three disconnected fold idioms:
//   1. Live Agent-batch footer — `liveAgentBatchRerender` closure +
//      `liveAgentBatchExpanded` boolean. Only meaningful during a
//      running batch; resets when the skill ends.
//   2. `r` key response re-render — splices chatLines[start,end)
//      with alternate formatting. Only ONE target (last assistant
//      turn); separate concept, kept separate.
//   3. Static render-time truncation — tool-body, agent-child block,
//      bg-batch-launch each truncate at their own constant with
//      their own "N more …" text and NO way to unfold afterwards.
//
// FoldStack replaces (1) and extends the model to cover (3) so the
// `f` key does the same thing everywhere: toggle the nearest folded
// thing. LIFO ordering means `f` always hits the most-recent fold
// target, matching the user's mental model (the thing you JUST saw
// get folded is the thing you probably want to unfold).
//
// Two target kinds:
//   • 'live'   — owned by a callback; toggling re-runs the callback
//                to repaint an external surface (typically the
//                pinned thinking line for an in-flight batch). Has
//                no lineStart/lineEnd; doesn't touch chatLines.
//   • 'static' — owned by a range inside chatLines. Toggling calls
//                the supplied rerender() to compute a new line
//                block, then splices chatLines in place. Offsets of
//                later static targets auto-shift.
//
// The stack is kept deliberately small: a run of 5 agents with a
// folded tree registers exactly one target; nested folds inside
// that tree are not independently toggleable (KISS).

import { debug } from './debug/log.js';

export type FoldTargetId = string;

export interface LiveFoldTarget {
  kind: 'live';
  id: FoldTargetId;
  /** True = the external surface is currently expanded. The
   *  rerender callback reads this via closure, so FoldStack only
   *  flips the flag and invokes rerender; it doesn't know what
   *  "expanded" means to the caller. */
  expanded: boolean;
  /** Repaint the external surface with the current `expanded` value.
   *  Called synchronously by FoldStack on every toggle. */
  rerender: () => void;
  /** Called when FoldStack.remove(id) runs — e.g. the batch ended
   *  and the footer is being cleared. Optional cleanup hook. */
  onDispose?: () => void;
}

export interface StaticFoldTarget {
  kind: 'static';
  id: FoldTargetId;
  /** Inclusive start index into chatLines. */
  lineStart: number;
  /** Exclusive end index into chatLines (so length = end - start). */
  lineEnd: number;
  /** Render the block with the current `expanded` value. FoldStack
   *  calls this on toggle, takes the returned lines, and splices
   *  them into chatLines[lineStart, lineEnd). Must be deterministic
   *  for a given `expanded` value — FoldStack will call it twice per
   *  toggle if needed. */
  rerender: (expanded: boolean) => string[];
  expanded: boolean;
  /** Join key shared with fold-applied (first-member callId). FoldStack
   *  does not invent this; the registrar supplies the existing identifier. */
  groupKey?: string;
  /** Fold mode shared with fold-applied. FoldStack does not invent this. */
  mode?: string;
  /** Offset (from lineStart) of the click that expanded this target —
   *  clicking the same row again collapses it (#16 two-way click). */
  expandedAtOffset?: number;
}

export type FoldTarget = LiveFoldTarget | StaticFoldTarget;

/** Max static candidate ranges included in a toggleAtLine miss observation. */
export const TOGGLE_AT_LINE_MISS_CANDIDATE_LIMIT = 8;

export interface FoldStackOpts {
  /** The chatLines array to splice into for static toggles. Kept as
   *  a reference (not a copy) so the stack observes external pushes
   *  by index arithmetic only. */
  chatLines: string[];
  /** Hook invoked AFTER a successful toggle so the host can trigger
   *  a redraw + scroll-anchor adjustment. */
  onAfterToggle?: (target: FoldTarget, delta: number) => void;
}

export class FoldStack {
  private targets: FoldTarget[] = [];
  private seq = 0;
  constructor(private opts: FoldStackOpts) {}

  /** Push a new target and return a handle the caller can use to
   *  remove / update it later. Most recent push = top of the stack.
   *  Accepts the two discriminants as distinct overloads so callers
   *  can use the kind-specific fields (onDispose for live;
   *  lineStart/lineEnd for static) without Omit-distribution losing
   *  them. */
  push(target: Omit<LiveFoldTarget, 'id'>): FoldTargetId;
  push(target: Omit<StaticFoldTarget, 'id'>): FoldTargetId;
  push(target: Omit<LiveFoldTarget, 'id'> | Omit<StaticFoldTarget, 'id'>): FoldTargetId {
    const id = `fold-${++this.seq}`;
    this.targets.push({ ...target, id } as FoldTarget);
    return id;
  }

  /** Remove a target by id. Silent no-op if not found. Calls any
   *  onDispose hook on live targets. */
  remove(id: FoldTargetId): void {
    const idx = this.targets.findIndex(t => t.id === id);
    if (idx < 0) return;
    const t = this.targets[idx]!;
    if (t.kind === 'live' && t.onDispose) t.onDispose();
    this.targets.splice(idx, 1);
  }

  /** Clear all targets (e.g. on /clear or when the log pane is
   *  reset). Runs onDispose on each live target. */
  clear(): void {
    for (const t of this.targets) {
      if (t.kind === 'live' && t.onDispose) t.onDispose();
    }
    this.targets.length = 0;
  }

  /** Number of registered targets. For tests + the help hint. */
  size(): number { return this.targets.length; }

  /** Is there any target the `f` key could act on right now? */
  hasTarget(): boolean { return this.targets.length > 0; }

  /** Peek at the top target without modifying the stack. */
  top(): FoldTarget | null {
    return this.targets[this.targets.length - 1] ?? null;
  }

  /** Mutate a static target's lineStart/lineEnd in place. Used when
   *  an external force (another push, a non-fold splice) shifts the
   *  chatLines range under this target. */
  shiftStatic(id: FoldTargetId, delta: number): void {
    const t = this.targets.find(x => x.id === id);
    if (!t || t.kind !== 'static') return;
    t.lineStart += delta;
    t.lineEnd   += delta;
  }

  /** Latest-pushed static target whose range contains `lineIndex`,
   *  or null. Live (callback) targets have no line range and are
   *  skipped. `lineEnd` is exclusive. */
  private findLatestStaticContaining(lineIndex: number): StaticFoldTarget | null {
    for (let i = this.targets.length - 1; i >= 0; i--) {
      const t = this.targets[i]!;
      if (t.kind !== 'static') continue;
      if (lineIndex >= t.lineStart && lineIndex < t.lineEnd) return t;
    }
    return null;
  }

  /** Toggle one already-resolved target. Shared by toggleTop and
   *  toggleAtLine so splice + range-cascade stay in one place. */
  private toggleTarget(t: FoldTarget): boolean {
    if (t.kind === 'live') {
      t.expanded = !t.expanded;
      t.rerender();
      this.opts.onAfterToggle?.(t, 0);
      return true;
    }

    // static: compute fresh lines for the flipped state, splice, and
    // adjust cascades. We compute new lines BEFORE flipping expanded
    // so rerender sees the target value.
    const nextExpanded = !t.expanded;
    const newLines = t.rerender(nextExpanded);
    const oldLen = t.lineEnd - t.lineStart;
    const delta = newLines.length - oldLen;

    this.opts.chatLines.splice(t.lineStart, oldLen, ...newLines);
    t.expanded = nextExpanded;
    t.expandedAtOffset = undefined;
    t.lineEnd  = t.lineStart + newLines.length;

    // Any OTHER static target whose lineStart is ≥ the toggled
    // target's lineEnd needs to shift by `delta`. Walk the full list
    // and fix up — cheap even at dozens of targets.
    if (delta !== 0) {
      for (const other of this.targets) {
        if (other === t) continue;
        if (other.kind !== 'static') continue;
        if (other.lineStart >= t.lineEnd - delta) {
          other.lineStart += delta;
          other.lineEnd   += delta;
        }
      }
    }

    this.opts.onAfterToggle?.(t, delta);
    return true;
  }

  /** Toggle the topmost target. Returns true when a target was
   *  toggled, false when the stack was empty. For static targets
   *  this splices chatLines in place and cascades the line-range
   *  delta to any static targets sitting above (older) on the
   *  stack — live targets are skipped (they have no line range). */
  toggleTop(): boolean {
    const t = this.top();
    if (!t) return false;
    return this.toggleTarget(t);
  }

  /** Toggle the latest-pushed static target whose range contains
   *  `lineIndex`. Returns true when a target was toggled, false
   *  when none contained the line (live targets are never chosen).
   *  Reuses the single-target splice/cascade path. */
  toggleAtLine(lineIndex: number): boolean {
    const t = this.findLatestStaticContaining(lineIndex);
    if (!t) {
      this.logToggleAtLineMiss(lineIndex);
      return false;
    }
    // Capture the selected exclusive range before splice; after toggle,
    // lineEnd may move and would no longer answer "did this click hit this fold?".
    const lineStart = t.lineStart;
    const lineEnd = t.lineEnd;
    const toggled = this.toggleTarget(t);
    if (toggled) t.expandedAtOffset = t.expanded ? lineIndex - lineStart : undefined;
    if (toggled) {
      debug.log('log.fold', t.expanded ? 'fold-expanded' : 'fold-recollapsed', {
        mode: t.mode ?? null,
        groupKey: t.groupKey ?? null,
        lineIndex,
        lineStart,
        lineEnd,
      });
    }
    return toggled;
  }

  /** Bounded miss observation: requested line vs registered static ranges. */
  private logToggleAtLineMiss(lineIndex: number): void {
    const statics = this.targets.filter((x): x is StaticFoldTarget => x.kind === 'static');
    const truncated = statics.length > TOGGLE_AT_LINE_MISS_CANDIDATE_LIMIT;
    const candidates = statics
      .slice(0, TOGGLE_AT_LINE_MISS_CANDIDATE_LIMIT)
      .map((s) => ({ lineStart: s.lineStart, lineEnd: s.lineEnd }));
    debug.log('log.fold', 'toggle-at-line-miss', {
      lineIndex,
      candidates,
      truncated,
    });
  }

  /** Fact for callers: is `lineIndex` the first line of the
   *  latest-pushed static target that contains it, and is that
   *  target currently expanded? Policy (collapse only on first
   *  line) stays with the caller. */
  isExpandedFirstLine(lineIndex: number): boolean {
    const t = this.findLatestStaticContaining(lineIndex);
    return t != null && t.expanded && t.lineStart === lineIndex;
  }

  /** Fact for callers: may a click on `lineIndex` collapse its expanded
   *  target? True on the first line, the last line, and the row whose
   *  click expanded it — the rest of the body stays a reading area. */
  isExpandedCollapseLine(lineIndex: number): boolean {
    const t = this.findLatestStaticContaining(lineIndex);
    if (t == null || !t.expanded) return false;
    const offset = lineIndex - t.lineStart;
    return offset === 0 || lineIndex === t.lineEnd - 1 || offset === t.expandedAtOffset;
  }

  /** Toggle every static target on the stack in the same direction.
   *  If ≥ half are already expanded we collapse all; otherwise we
   *  expand all. Returns the number of targets that actually changed
   *  state (targets already in the desired state are no-ops). Live
   *  targets are skipped — the live footer has its own `f`-key
   *  interaction and bulk-toggling it rarely matches user intent.
   *  Processes bottom-up so cascaded deltas don't invalidate ranges
   *  we haven't visited yet: toggling lower-line targets first means
   *  higher-line targets' ranges get shifted once, then we toggle
   *  those higher targets against the already-shifted chatLines. */
  toggleAll(): number {
    const statics = this.targets.filter((t): t is StaticFoldTarget => t.kind === 'static');
    if (statics.length === 0) return 0;
    const expandedCount = statics.filter(t => t.expanded).length;
    return this.setAll(expandedCount * 2 < statics.length); // <50% → expand all
  }

  /** Put every static target in one explicit state (`/log unfold all` ·
   *  `/log fold all`). Returns how many targets changed; live targets are
   *  skipped exactly as in toggleAll. */
  setAll(targetExpanded: boolean): number {
    const statics = this.targets.filter((t): t is StaticFoldTarget => t.kind === 'static');
    // Sort by lineStart ascending; toggling from the top of chatLines
    // down means later targets shift consistently as we go. Skip
    // targets already in the desired state.
    const todo = statics
      .filter(t => t.expanded !== targetExpanded)
      .sort((a, b) => a.lineStart - b.lineStart);
    let changed = 0;
    for (const t of todo) {
      const newLines = t.rerender(targetExpanded);
      const oldLen = t.lineEnd - t.lineStart;
      const delta = newLines.length - oldLen;
      this.opts.chatLines.splice(t.lineStart, oldLen, ...newLines);
      t.expanded = targetExpanded;
      t.expandedAtOffset = undefined;
      t.lineEnd = t.lineStart + newLines.length;
      if (delta !== 0) {
        for (const other of this.targets) {
          if (other === t) continue;
          if (other.kind !== 'static') continue;
          if (other.lineStart >= t.lineEnd - delta) {
            other.lineStart += delta;
            other.lineEnd   += delta;
          }
        }
      }
      this.opts.onAfterToggle?.(t, delta);
      changed++;
    }
    return changed;
  }

  /** For tests: snapshot the current targets. Returns plain data so
   *  assertions don't depend on identity. */
  snapshot(): Array<Pick<FoldTarget, 'kind' | 'expanded'> & { id: FoldTargetId; lineStart?: number; lineEnd?: number }> {
    return this.targets.map(t => t.kind === 'static'
      ? { kind: t.kind, expanded: t.expanded, id: t.id, lineStart: t.lineStart, lineEnd: t.lineEnd }
      : { kind: t.kind, expanded: t.expanded, id: t.id },
    );
  }
}
