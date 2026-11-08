import type { LLMToolSpec } from '../llm/tool-spec.js';
// WT-L-1 — LLM tools that work on the web-terminal kind.
//
// Three reads / writes that let an agent inspect + drive web terminals
// the same way it drives the dashboard PreviewTerminal today:
//
//   - WebTerminalList   → enumerate active terminals for a sessionId
//   - WebTerminalSnapshot → plain-text snapshot of the visible buffer
//                           via PreviewTerminal.renderForLLM()
//   - WebTerminalInput  → send raw bytes to PTY (stdin)
//
// Why a dedicated runtime file rather than reusing surface-ui-runtimes:
// the surface-ui tools (ObserveSurface / DescribeSurface / GetUIState)
// target the dashboard *Pane* abstraction. Web terminals haven't yet
// been registered through PaneFactory (WT-S-3 follow-up); until they
// are, agents need a parallel path keyed by `(sessionId, terminalId)`
// directly off the preview-tap-registry. This file is that path.
//
// When WT-S-3 lands and web terminals become real Panes, these
// runtimes can either:
//   (a) deprecate to thin wrappers over ObserveSurface(paneId), or
//   (b) stay as terminal-specific shorthand.
// Today's choice is (b) until usage settles.
//
// Image-pipeline followup #1 (2026-05-05) — `sessionId` no longer in
// the spec's `required` array. The LLM may still pass it (override
// for cross-session debugging / fork scenarios), but when omitted the
// daemon dispatch path auto-injects the current ACP sessionId via
// `DaemonToolDispatchCtx.sessionId`. Each `dispatchWebTerminal*`
// accepts an optional `{ sessionId }` fallback for callers that own
// the resolution; the daemon-tools wrapper threads ctx.sessionId
// through. Direct callers (`acp/server.ts:1134`, dashboard tool
// runtime via `rt.run`) are backward-compatible — args.sessionId
// still wins.

import type { ToolRuntime } from './types.js';
import { registerToolRuntime } from './registry.js';
import {
  lookupPreviewTerminal,
  listPreviewTerminals,
} from '../web-terminal/preview-tap-registry.js';

import { debug } from '../debug/log.js';
import { webTerminalScreenshotRuntime } from './web-terminal-screenshot.js';

type Args = Record<string, unknown>;
type Out = { output: string };

/** Optional fallback bag for dispatch* callers that resolve sessionId
 *  outside of the LLM args (daemon path auto-injection). args.sessionId
 *  always wins; this is consulted only when args lacks it. */
export interface WebTerminalDispatchOpts {
  sessionId?: string;
}

function stringify(obj: unknown): Out {
  return { output: JSON.stringify(obj) };
}

/** Resolve the effective sessionId from args + optional fallback bag.
 *  args.sessionId wins when non-empty; otherwise opts.sessionId; else
 *  throws so the dispatcher reports a clear error to the LLM. */
function resolveSessionId(args: Args, opts: WebTerminalDispatchOpts | undefined, toolName: string): string {
  const fromArgs = String(args.sessionId ?? '').trim();
  if (fromArgs) return fromArgs;
  const fromOpts = String(opts?.sessionId ?? '').trim();
  if (fromOpts) return fromOpts;
  throw new Error(`${toolName}: sessionId required (args.sessionId empty and no ctx.sessionId)`);
}

// Shared description tail for the four web-terminal tools — explains
// the auto-injection contract once so each tool's primary description
// can stay focused on what it does.
const SESSION_NOTE = (
  'sessionId is auto-injected from the current chat session — leave it '
  + 'out of args. Override only when targeting a different session.'
);

// ── List ────────────────────────────────────────────────────────────

export function buildWebTerminalListTool(): LLMToolSpec {
  return {
    name: 'WebTerminalList',
    description: [
      'List active web-terminal PTYs for the current daemon session.',
      'Each entry includes terminalId, pid, dimensions, alive flag.',
      'Use before WebTerminalSnapshot/WebTerminalInput to discover the',
      'terminalId arg.',
      SESSION_NOTE,
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description:
            'OPTIONAL. Daemon-issued ACP sessionId. Omit to use the current chat session.',
        },
      },
      required: [],
    },
  };
}

export function dispatchWebTerminalList(
  args: Args,
  opts?: WebTerminalDispatchOpts,
): { sessionId: string; terminals: ReturnType<typeof listPreviewTerminals> } {
  const sessionId = resolveSessionId(args, opts, 'WebTerminalList');
  const terminals = listPreviewTerminals(sessionId);
  if (debug.enabled) {
    debug.log('webterm.tool.list', 'dispatch', { sessionId, count: terminals.length });
  }
  return { sessionId, terminals };
}

export function webTerminalListRuntime(): ToolRuntime<Args, Out> {
  return {
    id: 'web_terminal_list',
    spec: buildWebTerminalListTool(),
    async run(args, ctx) {
      // ToolRuntimeContext carries no sessionId today, but daemon
      // surfaces that build the ctx by hand may stash one in the
      // shared bag. Read defensively so dashboard callers (no
      // sessionId in ctx) keep working unchanged.
      const sessionId = (ctx as { sessionId?: string } | undefined)?.sessionId;
      return stringify(dispatchWebTerminalList(args, sessionId ? { sessionId } : undefined));
    },
  };
}

// ── Snapshot ────────────────────────────────────────────────────────

export function buildWebTerminalSnapshotTool(): LLMToolSpec {
  return {
    name: 'WebTerminalSnapshot',
    description: [
      'Return a plain-text snapshot of the visible web-terminal buffer.',
      'Strips SGR/cursor-motion/OSC sequences so the returned text is',
      'safe to embed verbatim in an LLM context. Use this to read what',
      'the user is currently seeing in their PWA terminal.',
      SESSION_NOTE,
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'OPTIONAL — auto-injected from the current chat session.',
        },
        terminalId: {
          type: 'string',
          description: 'PreviewTerminal id (e.g. "preview-1"). Get from WebTerminalList.',
        },
      },
      required: ['terminalId'],
    },
  };
}

export function dispatchWebTerminalSnapshot(
  args: Args,
  opts?: WebTerminalDispatchOpts,
): {
  sessionId: string; terminalId: string; text: string; bytes: number; cols: number; rows: number;
} {
  const sessionId = resolveSessionId(args, opts, 'WebTerminalSnapshot');
  const terminalId = String(args.terminalId ?? '').trim();
  if (!terminalId) throw new Error('WebTerminalSnapshot: terminalId required');
  const pt = lookupPreviewTerminal(sessionId, terminalId);
  if (!pt) throw new Error(`WebTerminalSnapshot: unknown terminal ${terminalId}`);
  const text = pt.renderForLLM();
  if (debug.enabled) {
    debug.log('webterm.tool.snapshot', 'dispatch', {
      sessionId, terminalId, bytes: text.length,
    });
  }
  return {
    sessionId, terminalId,
    text,
    bytes: text.length,
    cols: pt.cols,
    rows: pt.rows,
  };
}

export function webTerminalSnapshotRuntime(): ToolRuntime<Args, Out> {
  return {
    id: 'web_terminal_snapshot',
    spec: buildWebTerminalSnapshotTool(),
    async run(args, ctx) {
      const sessionId = (ctx as { sessionId?: string } | undefined)?.sessionId;
      return stringify(dispatchWebTerminalSnapshot(args, sessionId ? { sessionId } : undefined));
    },
  };
}

// ── Input ────────────────────────────────────────────────────────────

export function buildWebTerminalInputTool(): LLMToolSpec {
  return {
    name: 'WebTerminalInput',
    description: [
      'Send raw input bytes to the PTY of a web-terminal. Use a literal',
      '\\n at the end of `data` to submit the line. Equivalent to a',
      'human typing in the PWA xterm view — the sender is recorded as',
      'the agent peer so the user sees a "👤 typing" indicator on',
      'their device.',
      SESSION_NOTE,
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'OPTIONAL — auto-injected from the current chat session.',
        },
        terminalId: { type: 'string' },
        data: {
          type: 'string',
          description: 'Bytes to write to PTY stdin. Include trailing \\n to submit.',
        },
      },
      required: ['terminalId', 'data'],
    },
  };
}

export function dispatchWebTerminalInput(
  args: Args,
  opts?: WebTerminalDispatchOpts,
): {
  sessionId: string; terminalId: string; bytes: number;
} {
  const sessionId = resolveSessionId(args, opts, 'WebTerminalInput');
  const terminalId = String(args.terminalId ?? '').trim();
  const data = typeof args.data === 'string' ? args.data : '';
  if (!terminalId) throw new Error('WebTerminalInput: terminalId required');
  if (data.length === 0) throw new Error('WebTerminalInput: data required (non-empty)');
  const pt = lookupPreviewTerminal(sessionId, terminalId);
  if (!pt) throw new Error(`WebTerminalInput: unknown terminal ${terminalId}`);
  pt.write(data);
  if (debug.enabled) {
    debug.log('webterm.tool.input', 'dispatch', { sessionId, terminalId, bytes: data.length });
  }
  return { sessionId, terminalId, bytes: data.length };
}

export function webTerminalInputRuntime(): ToolRuntime<Args, Out> {
  return {
    id: 'web_terminal_input',
    spec: buildWebTerminalInputTool(),
    async run(args, ctx) {
      const sessionId = (ctx as { sessionId?: string } | undefined)?.sessionId;
      return stringify(dispatchWebTerminalInput(args, sessionId ? { sessionId } : undefined));
    },
  };
}

// ── Bulk register ────────────────────────────────────────────────────

export function webTerminalRuntimes(): ToolRuntime<Args, Out>[] {
  return [
    webTerminalListRuntime(),
    webTerminalSnapshotRuntime(),
    webTerminalInputRuntime(),
    // WT-C-2 — screenshot tool returns JSON-stringified ScreenshotResult
    // through the same Out shape as the others.
    webTerminalScreenshotRuntime() as unknown as ToolRuntime<Args, Out>,
  ];
}

let registered = false;

/** Idempotent registration of the WT-L-1 runtimes + WT-C-2 screenshot.
 *  Called once from daemon boot so agents that share the same daemon
 *  process can drive web terminals without an extra wiring step. */
export function registerWebTerminalRuntimes(): void {
  if (registered) return;
  registerToolRuntime(webTerminalListRuntime());
  registerToolRuntime(webTerminalSnapshotRuntime());
  registerToolRuntime(webTerminalInputRuntime());
  registerToolRuntime(
    webTerminalScreenshotRuntime() as unknown as Parameters<typeof registerToolRuntime>[0],
  );
  registered = true;
}

/** Test-only — reset the global registration. */
export function __resetWebTerminalRuntimesForTest(): void {
  registered = false;
}
