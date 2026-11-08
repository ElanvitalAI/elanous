import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── VW-term Bundle P7-E-α · WatchPane LLM tool ──
//
// Time-boxed observation window on a single pane. LLM use cases:
//   - "Run `npm install` and tell me if anything fails in 10 seconds."
//   - "Deploy 완료될 때까지 server log 30s 감시."
//   - Short transient output capture — finite window · bounded payload.
//
// Built on top of `dispatchObserveSurface` so we reuse the existing
// SurfaceRegistry event plumbing (register / unregister / update).
// Adds optional before/after text snapshot diff for a more compact
// summary when the pane content itself is what the caller cares about.
//
// PLAN: 내부 문서 `PLAN-vw-term-p7e-alpha-compare-watch-panes` §2.2

import { createTwoFilesPatch } from 'diff';
import { stripAnsi } from '../tui.js';

import {
  dispatchObserveSurface,
  type ObserveSurfaceEventOut,
} from '../surface/llm-tools.js';
import type { SurfaceUIDeps } from '../surface/llm-tools.js';
import { lookupPane } from './sources/pane-source.js';
import type { PaneFactory } from '../panes/factory.js';
import type { PaneRef } from '../panes/types.js';

export interface WatchPaneDeps extends SurfaceUIDeps {
  /** Optional — PaneFactory override for tests. */
  readonly factory?: PaneFactory;
}

export interface WatchPaneSnapshotSummary {
  readonly text: string;
  readonly lines: number;
}

export interface WatchPaneOut {
  readonly found: boolean;
  readonly ref: PaneRef;
  readonly windowMs: number;
  readonly events: readonly ObserveSurfaceEventOut[];
  readonly truncated: boolean;
  readonly before?: WatchPaneSnapshotSummary;
  readonly after?: WatchPaneSnapshotSummary;
  readonly diff?: string;
  readonly changed?: boolean;
  readonly note?: string;
}

// ── Tool spec ────────────────────────────────────────────────────

export function buildWatchPaneTool(): LLMToolSpec {
  return {
    name: 'WatchPane',
    description:
      'Observe a single pane for a bounded duration and return the '
      + 'surface-registry events (register/update/unregister) that '
      + 'fired in the window. Optionally capture a before/after text '
      + 'snapshot diff so you can see what the pane rendered during the '
      + 'watch. Use for time-boxed monitoring (deploy, install, transient '
      + 'output) — strictly prefer this over infinite streaming.',
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
        durationMs: {
          type: 'integer',
          description: 'Window length in ms. Default 5000, min 500, max 60000.',
        },
        maxEvents: {
          type: 'integer',
          description: 'Cap on returned events. Default 100.',
        },
        snapshotDiff: {
          type: 'boolean',
          description:
            'When true, take a before + after text snapshot and return '
            + 'a unified diff of what the pane rendered. Default false.',
        },
      },
      required: ['ref'],
    },
  };
}

// ── Dispatch ─────────────────────────────────────────────────────

const EMPTY_REF: PaneRef = { windowId: '', paneId: '' };

const MIN_DURATION_MS = 500;
const MAX_DURATION_MS = 60_000;
const DEFAULT_DURATION_MS = 5000;
const DEFAULT_MAX_EVENTS = 100;

export async function dispatchWatchPane(
  raw: Record<string, unknown>,
  deps: WatchPaneDeps = {},
): Promise<WatchPaneOut> {
  const ref = parseRef(raw.ref);
  if (!ref) {
    return {
      found: false, ref: EMPTY_REF, windowMs: 0,
      events: [], truncated: false,
      note: 'ref missing or malformed',
    };
  }

  const pane = lookupPane({ ...ref, factory: deps.factory });
  if (!pane) {
    return {
      found: false, ref, windowMs: 0,
      events: [], truncated: false,
      note: 'ref not resolved through PaneFactory',
    };
  }

  const durationRaw = typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs)
    ? Math.floor(raw.durationMs)
    : DEFAULT_DURATION_MS;
  const durationMs = Math.max(MIN_DURATION_MS, Math.min(MAX_DURATION_MS, durationRaw));

  const maxEventsRaw = typeof raw.maxEvents === 'number' && Number.isFinite(raw.maxEvents)
    ? Math.max(0, Math.floor(raw.maxEvents))
    : DEFAULT_MAX_EVENTS;

  const snapshotDiff = raw.snapshotDiff === true;

  let before: WatchPaneSnapshotSummary | undefined;
  if (snapshotDiff) {
    const snap = await pane.snapshot({ format: 'ansi' });
    const text = stripAnsi(snap.ansi ?? '');
    before = { text, lines: text.length === 0 ? 0 : text.split('\n').length };
  }

  const observe = await dispatchObserveSurface(
    {
      addr: { kind: 'pane', ref },
      durationMs,
      maxEvents: maxEventsRaw,
    },
    deps,
  );

  let after: WatchPaneSnapshotSummary | undefined;
  let diff: string | undefined;
  let changed: boolean | undefined;
  if (snapshotDiff && before) {
    const snap = await pane.snapshot({ format: 'ansi' });
    const text = stripAnsi(snap.ansi ?? '');
    after = { text, lines: text.length === 0 ? 0 : text.split('\n').length };
    if (before.text === after.text) {
      changed = false;
      diff = '';
    } else {
      changed = true;
      diff = createTwoFilesPatch(
        `${paneLabel(ref)}@before`,
        `${paneLabel(ref)}@after`,
        before.text,
        after.text,
        '', '',
        { context: 3 },
      );
    }
  }

  return {
    found: true,
    ref,
    windowMs: observe.windowMs,
    events: observe.events,
    truncated: observe.truncated,
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(diff !== undefined ? { diff } : {}),
    ...(changed !== undefined ? { changed } : {}),
  };
}

// ── Helpers ──────────────────────────────────────────────────────

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

function paneLabel(ref: PaneRef): string {
  const base = `${ref.windowId}::${ref.paneId}`;
  return ref.runnerLabel ? `${base}::${ref.runnerLabel}` : base;
}
