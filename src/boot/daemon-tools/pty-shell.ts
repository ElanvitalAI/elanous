// Daemon-tool surface for PtyShell* interactive-terminal LLM tools.
//
// The PtyShell* family (skills/tools/pty.ts) is elanous's direct analog of
// codex's `unified_exec` (exec_command + write_stdin): the LLM spawns a
// long-running process *under a real PTY*, then poll/send/kill drives it
// turn-by-turn. Unlike WebTerminal* (which *attaches* to a pre-existing
// UI terminal in the terminal-matrix), PtyShell* is headless — it spawns
// its own PTY — which is the right shape for headless surfaces
// (telegram · self) running an autonomous ReAct loop where Bash's
// one-shot model is wrong (REPLs · dev servers · watchers).
//
// Wiring, not new capability: the spec/dispatch implementations already
// exist and are exercised by the skill-runner. This module re-exposes
// them through the daemon-tool surface, gated behind the existing
// `'webterm'` kind (the "heavier PTY risk" opt-in surface) so an
// operator running `elanous nexus --tools webterm` gets interactive
// terminal control without polluting the request-response `chat`
// baseline (PWA · iOS).
//
// Approval: this surface auto-approves the spawn (requireApproval:false).
// Per the autonomous-delegation philosophy (see
// FEATURE-coding-delegation-optimization-2026-07-11 §4.2 — PERMISSION
// auto-approve, QUESTION-only surfacing), an autonomous coding agent
// should not be babysat with per-spawn confirmations. OS-native sandbox
// hardening (codex-style seatbelt/seccomp) is tracked separately as the
// follow-up to this minimal exposure experiment.

import type { LLMToolSpec } from '../../llm.js';

import {
  buildPtyShellStartTool,
  buildPtyShellPollTool,
  buildPtyShellSendTool,
  buildPtyShellKillTool,
  buildPtyShellListTool,
  buildPtyShellSnapshotTool,
  buildPtyShellResizeTool,
  buildPtyShellScreenshotTool,
  dispatchPtyShellStart,
  dispatchPtyShellPoll,
  dispatchPtyShellSend,
  dispatchPtyShellKill,
  dispatchPtyShellList,
  dispatchPtyShellSnapshot,
  dispatchPtyShellResize,
  dispatchPtyShellScreenshot,
} from '../../skills/tools/pty.js';
import {
  buildSpawnCodingAgentHeadlessTool,
  dispatchSpawnCodingAgentHeadless,
  buildDriveCodingAgentHeadlessTool,
  dispatchDriveCodingAgentHeadless,
} from '../../skills/tools/spawn-coding-agent-headless.js';
import {
  buildRelayShellPromptTool,
  dispatchRelayShellPrompt,
} from '../../skills/tools/relay-shell.js';

import {
  ToolSafetyError,
  type DaemonToolDispatchCtx,
} from './types.js';

export const PTY_SHELL_TOOL_NAMES = [
  'PtyShellStart',
  'PtyShellPoll',
  'PtyShellSend',
  'PtyShellKill',
  'PtyShellList',
  'PtyShellSnapshot',
  'PtyShellResize',
  'PtyShellScreenshot',
  'SpawnCodingAgentHeadless',
  'DriveCodingAgentHeadless',
  'RelayShellPrompt',
] as const;

export function buildPtyShellSpecs(): LLMToolSpec[] {
  return [
    buildPtyShellStartTool(),
    buildPtyShellPollTool(),
    buildPtyShellSendTool(),
    buildPtyShellKillTool(),
    buildPtyShellListTool(),
    buildPtyShellSnapshotTool(),
    buildPtyShellResizeTool(),
    buildPtyShellScreenshotTool(),
    buildSpawnCodingAgentHeadlessTool(),
    buildDriveCodingAgentHeadlessTool(),
    buildRelayShellPromptTool(),
  ];
}

/** Dispatch one of the five PtyShell* tool calls. Throws
 *  `ToolSafetyError('unavailable', ...)` for unknown names so the caller
 *  presents a uniform "tool refused" surface to the LLM. The underlying
 *  dispatchX functions throw `Error` on bad arg shape / missing node-pty,
 *  which the daemon-runtime maps to its own error envelope. */
export async function dispatchPtyShellTool(
  name: string,
  args: Record<string, unknown>,
  // Most PtyShell* carry their own process_id and don't need the daemon
  // cwd/signal — but RelayShellPrompt reads the surface channels off ctx
  // to reach the operator (SurfaceUx). Optional so non-daemon callers (the
  // telegram / continuation agent surface) can reuse this dispatcher directly.
  ctx?: DaemonToolDispatchCtx,
): Promise<unknown> {
  switch (name) {
    case 'PtyShellStart': {
      // Autonomous surface — auto-approve the spawn (no HITL babysitting).
      return dispatchPtyShellStart(args, { requireApproval: false });
    }
    case 'PtyShellPoll':
      return dispatchPtyShellPoll(args);
    case 'PtyShellSend':
      return dispatchPtyShellSend(args);
    case 'PtyShellKill':
      return dispatchPtyShellKill(args);
    case 'PtyShellList':
      return dispatchPtyShellList();
    case 'PtyShellSnapshot':
      return dispatchPtyShellSnapshot(args);
    case 'PtyShellResize':
      return dispatchPtyShellResize(args);
    case 'PtyShellScreenshot':
      return dispatchPtyShellScreenshot(args);
    case 'SpawnCodingAgentHeadless':
      return dispatchSpawnCodingAgentHeadless(args);
    case 'DriveCodingAgentHeadless':
      return dispatchDriveCodingAgentHeadless(args);
    case 'RelayShellPrompt':
      // Needs ctx — relays the shell prompt to the operator via SurfaceUx.
      return dispatchRelayShellPrompt(args, ctx);
    default:
      throw new ToolSafetyError(
        'unavailable',
        `daemon webterm surface does not know tool '${name}' (allowed: ${PTY_SHELL_TOOL_NAMES.join(', ')})`,
      );
  }
}
