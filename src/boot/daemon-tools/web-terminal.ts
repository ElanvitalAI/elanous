import type { LLMToolSpec } from '../../llm/tool-spec.js';
// Daemon-tool surface for web-terminal LLM tools.
//
// PWA-only `elanous serve` mode bypasses the dashboard's
// `tool-runtime/registry`, so the WT-L-1 runtimes (List · Snapshot ·
// Input) wired by `registerWebTerminalRuntimes()` aren't reachable
// from a daemon-only LLM turn. This module re-exposes the same three
// tool specs through the daemon-tool surface, gated behind the new
// `'webterm'` kind, so an operator running just `elanous serve --tools
// webterm` gets the same agent-driving capability the dashboard ships
// by default.
//
// Why a wrapper rather than a fork: the spec/dispatch implementations
// live in `tool-runtime/web-terminal-runtimes.ts` and reach the same
// `preview-tap-registry`. Importing them keeps the two surfaces in
// lockstep — when (a) WT-S-3's PaneFactory becomes the canonical path
// or (b) snapshot grows a `format: 'png'` option (WT-C-2), both
// surfaces inherit the change.



import {
  buildWebTerminalListTool,
  buildWebTerminalSnapshotTool,
  buildWebTerminalInputTool,
  dispatchWebTerminalList,
  dispatchWebTerminalSnapshot,
  dispatchWebTerminalInput,
} from '../../tool-runtime/web-terminal-runtimes.js';
import {
  buildWebTerminalScreenshotTool,
  dispatchWebTerminalScreenshot,
} from '../../tool-runtime/web-terminal-screenshot.js';
import {
  buildLiveCameraFrameTool,
  dispatchLiveCameraFrame,
} from '../../tool-runtime/web-terminal-live-camera.js';

import {
  ToolSafetyError,
  type DaemonToolDispatchCtx,
} from './types.js';

export const WEB_TERMINAL_TOOL_NAMES = [
  'WebTerminalList',
  'WebTerminalSnapshot',
  'WebTerminalInput',
  'WebTerminalScreenshot',
  'LiveCameraFrame',
] as const;

export function buildWebTerminalSpecs(): LLMToolSpec[] {
  return [
    buildWebTerminalListTool(),
    buildWebTerminalSnapshotTool(),
    buildWebTerminalInputTool(),
    buildWebTerminalScreenshotTool(),
    buildLiveCameraFrameTool(),
  ];
}

/** Dispatch one of the four web-terminal tool calls. Throws
 *  `ToolSafetyError('unavailable', ...)` for unknown names so the
 *  caller can present a uniform "tool refused" surface to the LLM
 *  alongside the rest of the daemon-tool surface. The underlying
 *  dispatchX functions throw `Error` on bad arg shape, which the
 *  daemon-runtime maps to its own error envelope.
 *
 *  Image-pipeline followup #1 (2026-05-05) — `ctx.sessionId` (when
 *  set by the daemon's per-turn closure) is forwarded to each
 *  dispatch* as the auto-injection fallback. The LLM no longer has
 *  to thread sessionId through tool args: when omitted the daemon
 *  fills it from the current ACP session, but explicit args.sessionId
 *  still wins so cross-session debugging stays possible. */
export async function dispatchWebTerminalTool(
  name: string,
  args: Record<string, unknown>,
  ctx: DaemonToolDispatchCtx,
): Promise<unknown> {
  const fallback = ctx.sessionId ? { sessionId: ctx.sessionId } : undefined;
  switch (name) {
    case 'WebTerminalList':
      return dispatchWebTerminalList(args, fallback);
    case 'WebTerminalSnapshot':
      return dispatchWebTerminalSnapshot(args, fallback);
    case 'WebTerminalInput':
      return dispatchWebTerminalInput(args, fallback);
    case 'WebTerminalScreenshot':
      return dispatchWebTerminalScreenshot(args, fallback);
    case 'LiveCameraFrame':
      return dispatchLiveCameraFrame(args, fallback);
    default:
      throw new ToolSafetyError(
        'unavailable',
        `daemon webterm surface does not know tool '${name}' (allowed: ${WEB_TERMINAL_TOOL_NAMES.join(', ')})`,
      );
  }
}
