import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── VW-term Bundle P7-E-α · ComparePanes LLM tool ──
//
// Produce a unified diff between two pane snapshots. LLM use cases:
//   - build with flag X and without, diff outputs
//   - before/after deploy — log state comparison
//   - side-by-side diagnostics across two terminals
//
// Thin wrapper over existing `resolvePaneAnsi` + `stripAnsi` + `diff`
// (jsdiff). No new registries, no new snapshots — reuses the pane
// substrate that Phase 2b already contracted.
//
// PLAN: 내부 문서 `PLAN-vw-term-p7e-alpha-compare-watch-panes` §2.1

import { createTwoFilesPatch } from 'diff';
import { stripAnsi } from '../tui.js';

import { lookupPane, paneRefOf } from './sources/pane-source.js';
import type { PaneFactory } from '../panes/factory.js';
import type { PaneRef } from '../panes/types.js';

export interface ComparePanesDeps {
  /** Optional — PaneFactory override for tests. Defaults to the
   *  module-level default factory. */
  readonly factory?: PaneFactory;
}

export interface ComparePanesOut {
  readonly found: boolean;
  readonly refA: PaneRef;
  readonly refB: PaneRef;
  readonly samePane?: boolean;
  readonly equal?: boolean;
  readonly diff?: string;
  readonly linesA?: number;
  readonly linesB?: number;
  readonly note?: string;
}

// ── Tool spec ────────────────────────────────────────────────────

export function buildComparePanesTool(): LLMToolSpec {
  return {
    name: 'ComparePanes',
    description:
      'Snapshot two panes and return a unified diff of their current text. '
      + 'Use for before/after comparisons, A/B test output diffs, or '
      + 'cross-service log comparison. Both panes must be resolvable '
      + 'through the pane factory (spawned + registered).',
    parameters: {
      type: 'object',
      properties: {
        refA: {
          type: 'object',
          properties: {
            windowId: { type: 'string' },
            paneId: { type: 'string' },
            runnerLabel: { type: 'string' },
          },
          required: ['windowId', 'paneId'],
        },
        refB: {
          type: 'object',
          properties: {
            windowId: { type: 'string' },
            paneId: { type: 'string' },
            runnerLabel: { type: 'string' },
          },
          required: ['windowId', 'paneId'],
        },
        format: {
          type: 'string',
          enum: ['unified'],
          description: 'Diff format. Only "unified" for now. Default "unified".',
        },
        contextLines: {
          type: 'integer',
          description: 'Lines of context around each hunk. Default 3, max 20.',
        },
        includeAnsi: {
          type: 'boolean',
          description:
            'When true, preserve ANSI escape sequences in snapshots before '
            + 'diffing. Default false (stripped to plain text).',
        },
      },
      required: ['refA', 'refB'],
    },
  };
}

// ── Dispatch ─────────────────────────────────────────────────────

const EMPTY_REF: PaneRef = { windowId: '', paneId: '' };

export async function dispatchComparePanes(
  raw: Record<string, unknown>,
  deps: ComparePanesDeps = {},
): Promise<ComparePanesOut> {
  const refA = parseRef(raw.refA);
  if (!refA) {
    return { found: false, refA: EMPTY_REF, refB: EMPTY_REF, note: 'refA missing or malformed' };
  }
  const refB = parseRef(raw.refB);
  if (!refB) {
    return { found: false, refA, refB: EMPTY_REF, note: 'refB missing or malformed' };
  }

  // Same-ref short-circuit — avoid a round-trip through the snapshot
  // path when the caller asks for `diff(A, A)`.
  if (sameRef(refA, refB)) {
    return { found: true, refA, refB, samePane: true, equal: true, diff: '' };
  }

  const paneA = lookupPane({ ...refA, factory: deps.factory });
  if (!paneA) {
    return { found: false, refA, refB, note: `refA not resolved through PaneFactory` };
  }
  const paneB = lookupPane({ ...refB, factory: deps.factory });
  if (!paneB) {
    return { found: false, refA, refB, note: `refB not resolved through PaneFactory` };
  }

  const includeAnsi = raw.includeAnsi === true;
  const contextLinesRaw =
    typeof raw.contextLines === 'number' && Number.isFinite(raw.contextLines)
      ? Math.max(0, Math.floor(raw.contextLines))
      : 3;
  const contextLines = Math.min(contextLinesRaw, 20);

  const snapA = await paneA.snapshot({ format: 'ansi' });
  const snapB = await paneB.snapshot({ format: 'ansi' });
  const textA = includeAnsi ? (snapA.ansi ?? '') : stripAnsi(snapA.ansi ?? '');
  const textB = includeAnsi ? (snapB.ansi ?? '') : stripAnsi(snapB.ansi ?? '');

  const linesA = textA.length === 0 ? 0 : textA.split('\n').length;
  const linesB = textB.length === 0 ? 0 : textB.split('\n').length;

  if (textA === textB) {
    return { found: true, refA, refB, equal: true, diff: '', linesA, linesB };
  }

  const diff = createTwoFilesPatch(
    paneLabel(refA),
    paneLabel(refB),
    textA,
    textB,
    '',
    '',
    { context: contextLines },
  );

  return { found: true, refA, refB, equal: false, diff, linesA, linesB };
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

function sameRef(a: PaneRef, b: PaneRef): boolean {
  return a.windowId === b.windowId
    && a.paneId === b.paneId
    && (a.runnerLabel ?? '') === (b.runnerLabel ?? '');
}

function paneLabel(ref: PaneRef): string {
  const base = `${ref.windowId}::${ref.paneId}`;
  return ref.runnerLabel ? `${base}::${ref.runnerLabel}` : base;
}

// re-export for convenience
export { paneRefOf };
