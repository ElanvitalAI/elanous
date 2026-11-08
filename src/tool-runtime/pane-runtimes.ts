import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── VW-term-infra Bundle B-1 · B1-1 — pane LLM tools (Phase 5 foundation) ──
//
// Two LLM-facing tools wrapping Bundle A's `PaneVisualStateStore` +
// existing `describePane` helper:
//
//   SetFocusPolicy({ref, next})
//     → store.setState(ref, {focusPolicy: next})
//     → { applied, prev, next }   (no throw on unknown `next` · note)
//
//   DescribePane({ref})
//     → describePaneWithState(ref, deps)
//     → { found, description?, visualState?, note? }
//
// Both tools advertise a chord hint via `mirror-hints.ts` so the LLM
// sees "this tool mirrors `^B p` / `^B d`" in the spec — Phase 5
// symmetry bridge first two pairs.
//
// Ownership: pure terminal-team turf. PaneRef based · no widget-host
// coupling · no dashboard mutation on the critical path (store write
// only).
//
// PLAN: 내부 문서 `PLAN-vw-term-bundle-b1-symmetry-foundation` §2.1


import { describePaneWithState } from '../panes/describe-with-state.js';
import type {
  PaneFocusPolicy,
  PaneVisualState,
  PaneVisualStateStore,
} from '../panes/visual-state.js';
import { PANE_FOCUS_POLICY } from '../panes/visual-state.js';
import type { PaneRef } from '../panes/types.js';
import { registerToolRuntime } from './registry.js';
import type { ToolRuntime } from './types.js';
import { withChordHint, type LLMToolSpecWithMirror } from './mirror-hints.js';

// ── Types ────────────────────────────────────────────────────────

export interface PaneRuntimeDeps {
  /** Bundle A · A3 store. Required — store is the single source of
   *  truth for focusPolicy. */
  readonly store: PaneVisualStateStore;
}

type Args = Record<string, unknown>;
type Out = { output: string };

// ── Tool specs (with chord hints) ────────────────────────────────

export function buildSetFocusPolicyTool(): LLMToolSpecWithMirror {
  return withChordHint(
    {
      name: 'SetFocusPolicy',
      description:
        'Set the focus policy for a pane (`normal` | `skip` | `no-focus`). '
        + '`skip` removes the pane from Alt+N cycling · `no-focus` blocks '
        + 'even explicit setFocus calls. Mirrors the `^B p` chord.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'object',
            properties: {
              windowId: { type: 'string' },
              paneId: { type: 'string' },
              runnerLabel: { type: 'string' },
            },
            required: ['windowId', 'paneId'],
          },
          next: {
            type: 'string',
            enum: ['normal', 'skip', 'no-focus'],
            description: 'Target focusPolicy.',
          },
        },
        required: ['ref', 'next'],
      },
    },
    '^B p',
  );
}

export function buildDescribePaneTool(): LLMToolSpecWithMirror {
  return withChordHint(
    {
      name: 'DescribePane',
      description:
        'Return a pane\'s description block (title / summary / kind / '
        + 'supportedTaps / chords / tools) merged with its 4-axis '
        + 'visualState (focus · visibility · placement · focusPolicy). '
        + 'Mirrors the `^B d` chord.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'object',
            properties: {
              windowId: { type: 'string' },
              paneId: { type: 'string' },
              runnerLabel: { type: 'string' },
            },
            required: ['windowId', 'paneId'],
          },
        },
        required: ['ref'],
      },
    },
    '^B d',
  );
}

// ── Dispatch ─────────────────────────────────────────────────────

export interface SetFocusPolicyOut {
  readonly applied: boolean;
  readonly prev: PaneFocusPolicy;
  readonly next: PaneFocusPolicy | string;
  readonly note?: string;
}

export function dispatchSetFocusPolicy(
  raw: Args,
  deps: PaneRuntimeDeps,
): SetFocusPolicyOut {
  const ref = parseRef(raw.ref);
  if (!ref) {
    return {
      applied: false,
      prev: PANE_FOCUS_POLICY.normal,
      next: String(typeof raw.next === 'string' ? raw.next : ''),
      note: 'ref missing or malformed',
    };
  }
  const nextRaw = typeof raw.next === 'string' ? raw.next : '';
  if (
    nextRaw !== PANE_FOCUS_POLICY.normal
    && nextRaw !== PANE_FOCUS_POLICY.skip
    && nextRaw !== PANE_FOCUS_POLICY['no-focus']
  ) {
    const prev = deps.store.snapshot(ref).focusPolicy;
    return {
      applied: false,
      prev,
      next: nextRaw,
      note: `invalid focusPolicy "${nextRaw}" — expected normal | skip | no-focus`,
    };
  }
  const prev = deps.store.snapshot(ref).focusPolicy;
  const applied = deps.store.setState(ref, { focusPolicy: nextRaw as PaneFocusPolicy });
  return {
    applied,
    prev,
    next: nextRaw as PaneFocusPolicy,
    ...(applied ? {} : { note: 'setState rejected — identical or illegal transition' }),
  };
}

export interface DescribePaneOut {
  readonly found: boolean;
  readonly ref: PaneRef;
  readonly description?: unknown;     // PaneDescription (shape-preserved for serialize)
  readonly visualState?: PaneVisualState;
  readonly note?: string;
}

export function dispatchDescribePane(
  raw: Args,
  deps: PaneRuntimeDeps,
): DescribePaneOut {
  const ref = parseRef(raw.ref);
  if (!ref) {
    return {
      found: false,
      ref: { windowId: '', paneId: '' },
      note: 'ref missing or malformed',
    };
  }
  return describePaneWithState(ref, deps);
}

// ── Parse ────────────────────────────────────────────────────────

function parseRef(raw: unknown): PaneRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.windowId !== 'string' || r.windowId.length === 0) return null;
  if (typeof r.paneId !== 'string' || r.paneId.length === 0) return null;
  return {
    windowId: r.windowId,
    paneId: r.paneId,
    ...(typeof r.runnerLabel === 'string' && r.runnerLabel.length > 0
      ? { runnerLabel: r.runnerLabel }
      : {}),
  };
}

// ── Runtimes ─────────────────────────────────────────────────────

type StrArgs = Record<string, unknown>;

function stringify(obj: unknown): Out {
  return { output: JSON.stringify(obj) };
}

let _depsRef: PaneRuntimeDeps | null = null;
let registered = false;

function requireDeps(): PaneRuntimeDeps {
  if (!_depsRef) {
    throw new Error(
      'pane-runtimes: not registered — call registerPaneRuntimes({store}) first',
    );
  }
  return _depsRef;
}

export function createSetFocusPolicyRuntime(): ToolRuntime<StrArgs, Out> {
  return {
    id: 'pane_set_focus_policy',
    spec: buildSetFocusPolicyTool(),
    async run(req) {
      return stringify(dispatchSetFocusPolicy(req, requireDeps()));
    },
  };
}

export function createDescribePaneRuntime(): ToolRuntime<StrArgs, Out> {
  return {
    id: 'pane_describe',
    spec: buildDescribePaneTool(),
    async run(req) {
      return stringify(dispatchDescribePane(req, requireDeps()));
    },
  };
}

/** Idempotent registration — dashboard calls once after the
 *  `PaneVisualStateStore` is created. Re-calling updates `_depsRef`
 *  (hot-reload / test swap) without duplicating registry entries. */
export function registerPaneRuntimes(deps: PaneRuntimeDeps): void {
  _depsRef = deps;
  if (registered) return;
  registerToolRuntime(createSetFocusPolicyRuntime());
  registerToolRuntime(createDescribePaneRuntime());
  registered = true;
}

/** Test-only — wipe registration + deps so integration tests can
 *  re-register with fresh deps. */
export function __resetPaneRuntimesForTest(): void {
  _depsRef = null;
  registered = false;
}
