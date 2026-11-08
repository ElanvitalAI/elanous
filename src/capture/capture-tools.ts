import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── Capture arc — LLM tool surface (Screenshot + InspectPane) ──
//
// Exposes two native tools backed by the capture engine:
//
//   Screenshot({windowId, paneId, format, width?, height?})
//     → returns text/ansi/svg/asciicast body, or PNG base64 when
//       format='png'. Callers decide whether to pipe into a vision
//       model or render. For LLM consumption the 'png' format is the
//       killer feature — Claude / GPT-4V / Gemini read layout visually
//       (tmux status bars, htop gauges, btop graphs) that the text
//       path would destroy.
//
//   InspectPane({windowId, paneId})
//     → returns the pane's describe() payload (title / summary / kind
//       / supportedTaps / chords / tools). Lightweight inspection
//       before the caller decides to Screenshot or WatchPane.
//
// Both tools dispatch through the ToolRuntime abstraction so skill-
// runner, dashboard, and future MCP exports see a uniform entry.
//
// See: 내부 문서 `CAPABILITIES-capture-engine` §9.3


import { captureImage, type CaptureImageResult } from './engine.js';
import {
  createPaneSource,
  PaneSourceNotFoundError,
  resolvePaneAnsi,
} from './sources/pane-source.js';
import { resolveSurfaceAnsi, type SurfaceSourceDeps } from './sources/surface-source.js';
import { ModalSourceNotFoundError } from './sources/modal-source.js';
import { WidgetSourceNotFoundError } from './sources/widget-source.js';
import {
  dispatchDescribeSurface,
  type SurfaceUIDeps,
} from '../surface/llm-tools.js';
import type { SurfaceAddress } from '../surface/index.js';
import type { PaneVisualState } from '../panes/visual-state.js';
import type { CaptureFormat } from './types.js';

// ── Tool spec builders ─────────────────────────────────────────

const SUPPORTED_SCREENSHOT_FORMATS: readonly CaptureFormat[] = [
  'text', 'ansi', 'svg', 'png', 'asciicast',
];

export function buildScreenshotTool(): LLMToolSpec {
  return {
    name: 'Screenshot',
    description:
      'Capture a surface (pane / modal / widget / popover / inline / bg / screen) as '
      + 'text / ansi / svg / png / asciicast. '
      + 'Pass `target: SurfaceAddress` for new first-class addressing, or keep the '
      + 'legacy `{windowId, paneId}` shape for pane capture (auto-wrapped). '
      + 'Use "png" for visual inspection when you need to see layout '
      + '(tmux status, htop gauges, btop graphs) that ANSI-strip would destroy. '
      + 'Use `target: {kind:"screen"}` for a z-ordered composite dump of every '
      + 'visible surface. Returns {format, bytes, body?, bodyBase64?, note?}.',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'object',
          description: 'SurfaceAddress. Alternative to windowId/paneId. Includes {kind:"screen"} for composite.',
          properties: {
            kind: { type: 'string', enum: ['pane', 'modal', 'widget', 'popover', 'inline', 'bg', 'window', 'screen'] },
            modalId: { type: 'string' },
            widgetId: { type: 'string' },
            popoverId: { type: 'string' },
            inlineId: { type: 'string' },
            bgId: { type: 'string' },
            ref: {
              type: 'object',
              properties: {
                windowId: { type: 'string' },
                paneId: { type: 'string' },
                runnerLabel: { type: 'string' },
              },
            },
          },
          required: ['kind'],
        },
        windowId: { type: 'string', description: 'Legacy pane capture (use `target` instead for new callers).' },
        paneId: { type: 'string', description: 'Legacy pane capture.' },
        runnerLabel: { type: 'string', description: 'Legacy pane capture · optional.' },
        format: {
          type: 'string',
          enum: [...SUPPORTED_SCREENSHOT_FORMATS],
          description: 'Output format. Default "text".',
        },
        width: { type: 'integer', description: 'PNG-only — target pixel width; aspect preserved.' },
        height: { type: 'integer', description: 'PNG-only — target pixel height; aspect preserved.' },
        cols: { type: 'integer', description: 'Dimension hint for SVG/PNG; default 80.' },
        rows: { type: 'integer', description: 'Dimension hint for SVG/PNG; default 24.' },
        title: { type: 'string', description: 'Optional artifact title (asciicast header / SVG <title>).' },
      },
      required: ['windowId', 'paneId'],
    },
  };
}

export function buildInspectPaneTool(): LLMToolSpec {
  return {
    name: 'InspectPane',
    description:
      'Describe a pane without capturing content. Returns title / summary / kind / '
      + 'supportedTaps / chords / tools for planning whether to Screenshot or WatchPane. '
      + 'Structurally equivalent to DescribeSurface({addr:{kind:"pane",ref}}).detail '
      + '(chords / tools arrays carry the same {chord,label,mirrorTool}/{tool,label,mirrorChord} '
      + 'shape) — B-9 will re-skin InspectPane as a DescribeSurface shim. Prefer DescribeSurface '
      + 'for new calls when you also need visualState (focus/visibility/placement/focusPolicy).',
    parameters: {
      type: 'object',
      properties: {
        windowId: { type: 'string', description: 'Virtual window id owning the pane.' },
        paneId: { type: 'string', description: 'Canonical pane id (substrate PaneRef.paneId).' },
        runnerLabel: { type: 'string', description: 'Shell Runner label when target is external-terminal. Optional.' },
      },
      required: ['windowId', 'paneId'],
    },
  };
}

// ── Dispatchers ────────────────────────────────────────────────

export interface ScreenshotArgs {
  /** Legacy pane capture path (backward compat). New callers should
   *  use `target` instead. When neither `target` nor
   *  (`windowId` + `paneId`) is provided, parse throws. */
  readonly windowId?: string;
  readonly paneId?: string;
  readonly runnerLabel?: string;
  /** IUL Phase C·a+b (Bundle 6T) — first-class SurfaceAddress. */
  readonly target?: SurfaceAddress | { readonly kind: 'screen' };
  readonly format?: CaptureFormat;
  readonly width?: number;
  readonly height?: number;
  readonly cols?: number;
  readonly rows?: number;
  readonly title?: string;
}

export interface ScreenshotOut {
  readonly format: CaptureFormat;
  readonly bytes: number;
  readonly body?: string;        // text/ansi/asciicast/svg
  readonly bodyBase64?: string;  // png (plus an auxiliary copy for svg when requested)
  readonly note?: string;
  readonly target?: SurfaceAddress | { readonly kind: 'screen' };
}

export async function dispatchScreenshot(
  raw: Record<string, unknown>,
  deps: SurfaceSourceDeps = {},
): Promise<ScreenshotOut> {
  const args = parseScreenshotArgs(raw);
  const target = args.target;
  const format: CaptureFormat = args.format ?? 'text';
  const dims = { cols: args.cols ?? 80, rows: args.rows ?? 24 };

  // Resolve ANSI via the surface-source dispatcher (Bundle 6T) when
  // target is provided · legacy path stays on resolvePaneAnsi for
  // performance + behavior parity.
  let ansi: string;
  try {
    if (target) {
      if (target.kind === 'screen') {
        // Inline require to avoid circular import at module init
        const { resolveScreenAnsi } = await import('./sources/surface-source.js');
        ansi = await resolveScreenAnsi({ ...deps, dims });
      } else {
        ansi = await resolveSurfaceAnsi(target, { ...deps, dims });
      }
    } else {
      // Legacy caller
      ansi = await resolvePaneAnsi({
        windowId: args.windowId!,
        paneId: args.paneId!,
        ...(args.runnerLabel !== undefined ? { runnerLabel: args.runnerLabel } : {}),
      });
    }
  } catch (err) {
    return surfaceResolutionError(err, target, format, args);
  }

  try {
    const result: CaptureImageResult = await captureImage({
      target: { kind: 'pane', paneId: legacyPaneIdFrom(target, args) },
      format,
      dims,
      source: () => ansi,
      ...(args.title !== undefined ? { title: args.title } : {}),
    }, format === 'png'
      ? {
          ...(args.width !== undefined ? { width: args.width } : {}),
          ...(args.height !== undefined ? { height: args.height } : {}),
        }
      : {});
    if (format === 'png') {
      return {
        format,
        bytes: result.bytes,
        bodyBase64: result.bodyBytes.toString('base64'),
        ...(target ? { target } : {}),
      };
    }
    return {
      format,
      bytes: result.bytes,
      body: result.body,
      ...(target ? { target } : {}),
    };
  } catch (err) {
    return surfaceResolutionError(err, target, format, args);
  }
}

function legacyPaneIdFrom(
  target: SurfaceAddress | { readonly kind: 'screen' } | undefined,
  args: ScreenshotArgs,
): string {
  if (target?.kind === 'pane') return target.ref.paneId;
  if (args.paneId) return args.paneId;
  return `surface:${target?.kind ?? 'stream'}`;
}

function surfaceResolutionError(
  err: unknown,
  target: SurfaceAddress | { readonly kind: 'screen' } | undefined,
  format: CaptureFormat,
  args: ScreenshotArgs,
): ScreenshotOut {
  if (err instanceof PaneSourceNotFoundError) {
    return {
      format, bytes: 0,
      note: `pane not found: ${args.windowId}::${args.paneId}`,
      ...(target ? { target } : {}),
    };
  }
  if (err instanceof ModalSourceNotFoundError) {
    return {
      format, bytes: 0,
      note: `modal not found: ${err.modalId}`,
      ...(target ? { target } : {}),
    };
  }
  if (err instanceof WidgetSourceNotFoundError) {
    return {
      format, bytes: 0,
      note: `widget source unavailable: ${err.widgetId}`,
      ...(target ? { target } : {}),
    };
  }
  throw err;
}

export interface InspectPaneArgs {
  readonly windowId: string;
  readonly paneId: string;
  readonly runnerLabel?: string;
}

export interface InspectPaneOut {
  readonly found: boolean;
  readonly ref?: { windowId: string; paneId: string; runnerLabel?: string };
  readonly kind?: string;
  readonly title?: string;
  readonly summary?: string;
  readonly supportedTaps?: readonly string[];
  readonly chords?: readonly { chord: string; label: string; mirrorTool?: string }[];
  readonly tools?: readonly { tool: string; label: string; mirrorChord?: string }[];
  /** Bundle B-9-α · additive — present only when a PaneVisualStateStore
   *  is wired into deps. Callers that never needed visualState observe
   *  the pre-B-9 shape (field omitted). */
  readonly visualState?: PaneVisualState;
  readonly note?: string;
}

/** Bundle B-9-α (Phase P7 continuation) — thin projection over
 *  `dispatchDescribeSurface({addr:{kind:'pane',ref}})`. Behavior-preserving
 *  for callers that never pass `deps`; when a store is supplied the
 *  output additionally carries `visualState` (4-axis tuple). This unifies
 *  the pane-describe code path on `describePane` → DescribeSurface and
 *  lets the LLM reach the same information from either tool. */
export function dispatchInspectPane(
  raw: Record<string, unknown>,
  deps: SurfaceUIDeps = {},
): InspectPaneOut {
  const args = parseInspectPaneArgs(raw);
  const ref = {
    windowId: args.windowId,
    paneId: args.paneId,
    ...(args.runnerLabel !== undefined ? { runnerLabel: args.runnerLabel } : {}),
  };
  const out = dispatchDescribeSurface({ addr: { kind: 'pane', ref } }, deps);
  if (!out.found) {
    // Preserve the pre-B-9 note format so existing callers / tests that
    // grep for "not found" keep matching. DescribeSurface's own note
    // ("pane not resolved through PaneFactory") would break that.
    return {
      found: false,
      note: `pane not found: ${args.windowId}::${args.paneId}`,
    };
  }
  const detail = out.detail as {
    summary: string;
    supportedTaps: readonly string[];
    chords: readonly { chord: string; label: string; mirrorTool?: string }[];
    tools: readonly { tool: string; label: string; mirrorChord?: string }[];
    visualState?: PaneVisualState;
  };
  return {
    found: true,
    ref,
    kind: out.kindTag ?? '',
    title: out.title ?? '',
    summary: detail.summary,
    supportedTaps: detail.supportedTaps,
    chords: detail.chords,
    tools: detail.tools,
    ...(detail.visualState !== undefined ? { visualState: detail.visualState } : {}),
  };
}

// ── Arg parsing (runtime validation) ───────────────────────────

function parseScreenshotArgs(raw: Record<string, unknown>): ScreenshotArgs {
  const format = raw.format;
  if (format !== undefined && !SUPPORTED_SCREENSHOT_FORMATS.includes(format as CaptureFormat)) {
    throw new Error(`Screenshot: unsupported format ${String(format)}`);
  }

  // New-style target (Bundle 6T)
  const target = parseTarget(raw.target);
  if (target) {
    return {
      target,
      ...(format !== undefined ? { format: format as CaptureFormat } : {}),
      ...(typeof raw.width === 'number' ? { width: raw.width } : {}),
      ...(typeof raw.height === 'number' ? { height: raw.height } : {}),
      ...(typeof raw.cols === 'number' ? { cols: raw.cols } : {}),
      ...(typeof raw.rows === 'number' ? { rows: raw.rows } : {}),
      ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    };
  }

  // Legacy pane path
  const windowId = raw.windowId;
  const paneId = raw.paneId;
  if (typeof windowId !== 'string' || windowId === '') {
    throw new Error('Screenshot: target or (windowId, paneId) is required');
  }
  if (typeof paneId !== 'string' || paneId === '') {
    throw new Error('Screenshot: paneId is required (string) when target is omitted');
  }
  return {
    windowId, paneId,
    ...(typeof raw.runnerLabel === 'string' ? { runnerLabel: raw.runnerLabel } : {}),
    ...(format !== undefined ? { format: format as CaptureFormat } : {}),
    ...(typeof raw.width === 'number' ? { width: raw.width } : {}),
    ...(typeof raw.height === 'number' ? { height: raw.height } : {}),
    ...(typeof raw.cols === 'number' ? { cols: raw.cols } : {}),
    ...(typeof raw.rows === 'number' ? { rows: raw.rows } : {}),
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
  };
}

/** Parse `target` arg into SurfaceAddress | {kind:'screen'} — returns
 *  undefined when the raw shape is missing or malformed, so callers
 *  fall through to the legacy path. */
function parseTarget(raw: unknown): SurfaceAddress | { readonly kind: 'screen' } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  switch (obj.kind) {
    case 'screen':
      return { kind: 'screen' };
    case 'pane': {
      const ref = obj.ref;
      if (!ref || typeof ref !== 'object') return undefined;
      const r = ref as Record<string, unknown>;
      if (typeof r.windowId !== 'string' || typeof r.paneId !== 'string') return undefined;
      return {
        kind: 'pane',
        ref: {
          windowId: r.windowId,
          paneId: r.paneId,
          ...(typeof r.runnerLabel === 'string' ? { runnerLabel: r.runnerLabel } : {}),
        },
      };
    }
    case 'modal':
      if (typeof obj.modalId !== 'string') return undefined;
      return { kind: 'modal', modalId: obj.modalId };
    case 'widget':
      if (typeof obj.widgetId !== 'string') return undefined;
      return { kind: 'widget', widgetId: obj.widgetId };
    case 'popover':
      if (typeof obj.popoverId !== 'string') return undefined;
      return { kind: 'popover', popoverId: obj.popoverId };
    case 'inline':
      if (typeof obj.inlineId !== 'string') return undefined;
      return { kind: 'inline', inlineId: obj.inlineId };
    case 'bg':
      if (typeof obj.bgId !== 'string') return undefined;
      return { kind: 'bg', bgId: obj.bgId };
    case 'window': {
      // B-13-α — accept number or numeric string (JSON coercion).
      const raw = obj.windowId;
      const n = typeof raw === 'number' ? raw
        : typeof raw === 'string' ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n <= 0) return undefined;
      return { kind: 'window', windowId: n };
    }
    default:
      return undefined;
  }
}

function parseInspectPaneArgs(raw: Record<string, unknown>): InspectPaneArgs {
  const windowId = raw.windowId;
  const paneId = raw.paneId;
  if (typeof windowId !== 'string' || windowId === '') {
    throw new Error('InspectPane: windowId is required (string)');
  }
  if (typeof paneId !== 'string' || paneId === '') {
    throw new Error('InspectPane: paneId is required (string)');
  }
  return {
    windowId, paneId,
    ...(typeof raw.runnerLabel === 'string' ? { runnerLabel: raw.runnerLabel } : {}),
  };
}

// Re-export for callers wiring the runtime.
export { createPaneSource };
