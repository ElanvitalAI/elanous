// Native tools for main ↔ modal terminal context exchange.
//
// Exposes the TerminalSessionRegistry to skill-runner as a set of
// six tools (list / observe / spawn / focus / detach / kill). The
// seventh — inject — lives in skill-tool-terminal-modal-inject (P14)
// because it requires an approval-modal flow + mutating-safety tag.
//
// All dispatchers pull the registry from
// `getDashboardTerminalSessions()`; they throw if the dashboard
// hasn't initialized (headless test paths should either wire a
// mock registry via a follow-up accessor or avoid calling these
// tools directly).

import type { LLMToolSpec } from '../../llm.js';
import { truncateOutput } from '../../output-truncation.js';
import { getSessionCwd } from '../../session/working-dir.js';
import type { TerminalSession, TerminalSessionRegistry } from '../../terminal/session-registry.js';

async function getDashboardTerminalSessions(): Promise<TerminalSessionRegistry> {
  const { getDashboardTerminalSessions: getSessions } = await import('../../dashboard/terminal/session.js');
  return getSessions() as TerminalSessionRegistry;
}

const DEFAULT_MAX_BYTES = 64 * 1024;

// ─── terminal_modal_list ────────────────────────────────────────

export function buildTerminalModalListTool(): LLMToolSpec {
  return {
    name: 'TerminalModalList',
    description:
      'List all active terminal modal sessions (foreground / background, plus any exited-but-not-yet-GCed). ' +
      'Use to check what is running before spawning a new modal; pairs with TerminalModalObserve for reading output.',
    parameters: {
      type: 'object',
      properties: {
        include_exited: { type: 'boolean', description: 'Include exited sessions. Default false.' },
      },
      additionalProperties: false,
    },
  };
}

export async function dispatchTerminalModalList(
  rawArgs: Record<string, unknown>,
  deps?: { registry?: TerminalSessionRegistry },
): Promise<{ output: string }> {
  const registry = deps?.registry ?? await getDashboardTerminalSessions();
  const includeExited = rawArgs.include_exited === true;
  const sessions = registry.list().filter(s => includeExited || s.state !== 'exited');
  if (sessions.length === 0) {
    return { output: 'TerminalModalList (0 sessions)' };
  }
  const lines = [`TerminalModalList (${sessions.length} sessions)`];
  for (const s of sessions) {
    lines.push(formatSessionLine(s));
  }
  return { output: lines.join('\n') };
}

function formatSessionLine(s: TerminalSession): string {
  const brand = s.agentBrand ? ` brand=${s.agentBrand}` : '';
  const attn = s.attentionLevel > 0 ? ` attn=${s.attentionLevel}` : '';
  const exitTxt = s.exitCode !== null ? ` exit=${s.exitCode}` : '';
  const notif = s.lastNotification
    ? ` last="${s.lastNotification.title.slice(0, 40)}"`
    : '';
  return `  ${s.id} state=${s.state}${brand}${attn}${exitTxt} title="${s.title}" cwd="${s.cwd}"${notif}`;
}

// ─── terminal_modal_observe ─────────────────────────────────────

export function buildTerminalModalObserveTool(): LLMToolSpec {
  return {
    name: 'TerminalModalObserve',
    description:
      'Capture a non-destructive snapshot of a terminal modal session\'s current screen. ' +
      'Use to read stdout/stderr of long-running agents (claude-code, codex) you spawned or found via TerminalModalList. ' +
      'Live PTY ownership stays where it is; this is pure observation.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session id from TerminalModalList.' },
        mode: { type: 'string', enum: ['snapshot', 'tail'], description: 'snapshot = current visible grid; tail = snapshot trimmed to the last max_bytes. Default snapshot.' },
        max_bytes: { type: 'integer', description: `Tail cap. Default ${DEFAULT_MAX_BYTES}.` },
      },
      required: ['id'],
      additionalProperties: false,
    },
  };
}

export async function dispatchTerminalModalObserve(
  rawArgs: Record<string, unknown>,
  deps?: { registry?: TerminalSessionRegistry },
): Promise<{ output: string }> {
  const registry = deps?.registry ?? await getDashboardTerminalSessions();
  const id = String(rawArgs.id ?? '').trim();
  if (!id) throw new Error(`'id' is required`);
  const session = registry.get(id);
  if (!session) throw new Error(`unknown session id ${id}`);

  const mode = (rawArgs.mode as string | undefined) ?? 'snapshot';
  const maxBytes = typeof rawArgs.max_bytes === 'number' ? rawArgs.max_bytes : DEFAULT_MAX_BYTES;

  let body: string;
  try { body = session.preview.render(false); } catch { body = ''; }
  if (mode === 'tail' && body.length > maxBytes) {
    body = '… (truncated head) …\n' + body.slice(-maxBytes);
  }

  const trimmed = truncateOutput(body, {
    toolName: 'terminal_modal_observe',
    ext: 'log',
  });
  const header = `TerminalModalObserve id=${session.id} state=${session.state} title="${session.title}"`;
  // raiseAttention is NOT reset here — the agent should clear
  // deliberately via TerminalModalFocus.
  return { output: `${header}\n${trimmed.output}` };
}

// ─── terminal_modal_spawn — REMOVED (NT-C3, session nt 2026-04-18) ──
//
// TerminalModalSpawn was the LLM-triggered "open a PTY in a modal"
// tool. Session-nt replaces it with ShellRunner mode='vw' (the new
// default) which hosts commands in a user-visible VW runner pane
// with focus-policy control and OSC 133 boundary detection. No alias
// is retained — LLMs should call RunShell (re-wired in NT-C1b).
//
// Existing modals opened via this tool prior to the upgrade remain
// fully controllable through TerminalModalObserve / Focus / Detach /
// Kill; only the *spawn* surface is gone.

// ─── terminal_modal_focus ───────────────────────────────────────

export function buildTerminalModalFocusTool(): LLMToolSpec {
  return {
    name: 'TerminalModalFocus',
    description:
      'Promote a background terminal modal session to foreground. The previous foreground auto-detaches (PTY stays alive).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  };
}

export async function dispatchTerminalModalFocus(
  rawArgs: Record<string, unknown>,
  deps?: {
    registry?: TerminalSessionRegistry;
    termCols?: number;
    termRows?: number;
  },
): Promise<{ output: string }> {
  const registry = deps?.registry ?? await getDashboardTerminalSessions();
  const id = String(rawArgs.id ?? '').trim();
  if (!id) throw new Error(`'id' is required`);
  const prior = registry.foreground()?.id ?? null;
  const session = registry.attach(id, {
    termCols: deps?.termCols ?? 100,
    termRows: deps?.termRows ?? 30,
  });
  if (!session) throw new Error(`unknown session id ${id}`);
  registry.clearAttention(session.id);
  return {
    output: `TerminalModalFocus id=${session.id} state=${session.state}${prior ? ` previous=${prior}` : ''}`,
  };
}

// ─── terminal_modal_detach ──────────────────────────────────────

export function buildTerminalModalDetachTool(): LLMToolSpec {
  return {
    name: 'TerminalModalDetach',
    description:
      'Send the current foreground terminal modal (or a specific id) to the background. PTY stays alive; re-attach later with TerminalModalFocus.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional session id. Omit to detach the current foreground.' },
      },
      additionalProperties: false,
    },
  };
}

export async function dispatchTerminalModalDetach(
  rawArgs: Record<string, unknown>,
  deps?: { registry?: TerminalSessionRegistry },
): Promise<{ output: string }> {
  const registry = deps?.registry ?? await getDashboardTerminalSessions();
  const id = typeof rawArgs.id === 'string' && rawArgs.id.length > 0
    ? rawArgs.id
    : registry.foreground()?.id;
  if (!id) {
    return { output: 'TerminalModalDetach (no foreground session — nothing to do)' };
  }
  const session = registry.detach(id);
  if (!session) throw new Error(`unknown session id ${id}`);
  return {
    output: `TerminalModalDetach id=${session.id} state=${session.state}`,
  };
}

// ─── terminal_modal_kill ────────────────────────────────────────

export function buildTerminalModalKillTool(): LLMToolSpec {
  return {
    name: 'TerminalModalKill',
    description:
      'Terminate a terminal modal session. Stops the PTY and removes the modal. Irreversible.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  };
}

export async function dispatchTerminalModalKill(
  rawArgs: Record<string, unknown>,
  deps?: { registry?: TerminalSessionRegistry },
): Promise<{ output: string }> {
  const registry = deps?.registry ?? await getDashboardTerminalSessions();
  const id = String(rawArgs.id ?? '').trim();
  if (!id) throw new Error(`'id' is required`);
  const session = registry.kill(id);
  if (!session) throw new Error(`unknown session id ${id}`);
  return {
    output: `TerminalModalKill id=${session.id} exit=${session.exitCode ?? 'unknown'}`,
  };
}
