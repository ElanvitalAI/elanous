// ── Dashboard state snapshot ──
//
// One place that assembles the CURRENT static state the LLM needs to
// reason about "what's on screen and what can I control right now":
//
//   • PTY shells (id, cmd, status, age, detach flag)
//   • terminal-modal sessions (id, title, state, kind)
//   • active workspace (cwd, remote host if any)
//   • tool exposure flags (which migrated tools are currently on
//     dashboard surface — so the LLM doesn't try a tool that the
//     user has turned off)
//
// The LLM gets this three ways:
//
//   1. Native tool `GetDashboardState` — on-demand structured pull.
//   2. System prompt injection — renderDashboardStateForSystemPrompt()
//      returns a compact text summary that the dashboard chat loop
//      prepends to every turn's context so state is always in scope.
//   3. Programmatic consumers (MCP export, logs) use the same snapshot.
//
// Design principle reminder: static current state > history. History
// flows naturally through chat-log activity entries (V2); this module
// guarantees the LLM sees the RIGHT-NOW shape of the world.

import { listPty } from '../../pty-shell/registry.js';
import { getSessionCwd } from '../../session/working-dir.js';
import type {
  TerminalExposureSnapshot,
  TerminalInteractionPolicy,
} from '../terminal-exposure.js';

// ─── Types ────────────────────────────────────────────────────────

export interface SnapshotWorkspace {
  cwd: string;
  remoteHost?: string;
  platform: NodeJS.Platform;
}

export interface SnapshotPty {
  id: string;
  cmd: string;
  status: 'running' | 'exited';
  exitCode: number | null;
  ageSec: number;
  detach: boolean;
}

export interface SnapshotToolFlags {
  /** Tools the dashboard chat exposes to the LLM this turn. Derived
   *  from UserConfig.shell.allow*. Tools the user has disabled are
   *  absent so the LLM knows not to call them. */
  dashboardTools: string[];
}

export interface SnapshotTerminalMouseIntent {
  surfaceId: string;
  paneKind: 'terminal' | 'external-terminal' | 'preview-terminal';
  mouseType: 'click' | 'double-click' | 'right-click' | 'scroll-up' | 'scroll-down' | 'drag' | 'release' | 'motion';
  hostInterpretation: 'caret-focus' | 'word-select' | 'context-menu' | 'viewport-scroll' | 'range-select-update' | 'range-select-end' | 'hover';
  row: number;
  col: number;
  transport: 'pty-forward' | 'host-only';
  exposure: TerminalExposureSnapshot;
  interactionPolicy: TerminalInteractionPolicy;
}

export interface DashboardStateSnapshot {
  capturedAt: string;                     // ISO-8601
  workspace: SnapshotWorkspace;
  ptys: SnapshotPty[];
  tools: SnapshotToolFlags;
  /** Terminal-modal sessions (coding agents, misc PTY shells). Shape
   *  kept simple — ids + state, no embedded preview. */
  terminalSessions: Array<{
    id: string;
    title: string;
    state: string;
    exposure?: TerminalExposureSnapshot;
  }>;
  /** Recent host-side terminal intent events. This keeps terminal
   *  double-click / motion visible to elanous even when PTY forwarding
   *  cannot carry them. */
  recentTerminalMouseIntents: SnapshotTerminalMouseIntent[];
}

// ─── Inputs ───────────────────────────────────────────────────────

export interface CaptureOpts {
  cwd?: string;
  remoteHost?: string;
  platform?: NodeJS.Platform;
  /** Dashboard's chat loop passes this so the list reflects
   *  user-config flags as they land at turn-start (not as they were
   *  when the dashboard booted). */
  dashboardToolNames?: string[];
  /** Terminal-session listing supplied by caller (dashboard has the
   *  registry); kept as DI so this module stays testable without
   *  initDashboardTerminalSessions. */
  terminalSessions?: Array<{
    id: string;
    title: string;
    state: string;
    exposure?: TerminalExposureSnapshot;
  }>;
  /** Recent host-side terminal mouse intent history. Caller owns
   *  retention policy; snapshot just projects the current buffer. */
  recentTerminalMouseIntents?: SnapshotTerminalMouseIntent[];
}

// ─── Capture ──────────────────────────────────────────────────────

export function captureDashboardState(opts: CaptureOpts = {}): DashboardStateSnapshot {
  const capturedAt = new Date().toISOString();
  const workspace: SnapshotWorkspace = {
    cwd: opts.cwd ?? getSessionCwd(),
    remoteHost: opts.remoteHost,
    platform: opts.platform ?? process.platform,
  };

  const now = Date.now();
  const ptys: SnapshotPty[] = [];
  try {
    for (const h of listPty()) {
      ptys.push({
        id: h.id,
        cmd: h.cmd,
        status: h.isAlive() ? 'running' : 'exited',
        exitCode: h.exitCode,
        ageSec: Math.max(0, Math.floor((now - h.startedAt) / 1000)),
        detach: h.detach,
      });
    }
  } catch {
    // node-pty absent — leave empty.
  }

  return {
    capturedAt,
    workspace,
    ptys,
    tools: { dashboardTools: opts.dashboardToolNames ?? [] },
    terminalSessions: opts.terminalSessions ?? [],
    recentTerminalMouseIntents: opts.recentTerminalMouseIntents ?? [],
  };
}

// ─── Renderers ────────────────────────────────────────────────────

/** Compact one-liner-per-top-fact rendering for the system prompt.
 *  Designed to fit in ~20 lines even in busy sessions so it doesn't
 *  dominate the prompt. Empty sections collapse to nothing. */
export function renderDashboardStateForSystemPrompt(s: DashboardStateSnapshot): string {
  const out: string[] = [];
  out.push(`# monad-agent state (captured ${s.capturedAt})`);
  out.push(`workspace: cwd=${s.workspace.cwd}${s.workspace.remoteHost ? ` remote=${s.workspace.remoteHost}` : ''} platform=${s.workspace.platform}`);

  if (s.tools.dashboardTools.length > 0) {
    out.push(`tools exposed this turn: ${s.tools.dashboardTools.join(', ')}`);
  }

  if (s.ptys.length > 0) {
    out.push(`pty shells: ${s.ptys.length}`);
    for (const p of s.ptys) {
      const age = p.ageSec < 60 ? `${p.ageSec}s` : `${Math.floor(p.ageSec / 60)}m${p.ageSec % 60}s`;
      const status = p.status === 'running' ? 'running' : `exited ${p.exitCode}`;
      out.push(`  ${p.id} ${status} age=${age}${p.detach ? ' detach' : ''} cmd="${truncate(p.cmd, 60)}"`);
    }
  }

  if (s.terminalSessions.length > 0) {
    out.push(`terminal sessions: ${s.terminalSessions.length}`);
    for (const t of s.terminalSessions) {
      const exposure = t.exposure
        ? ` user=${t.exposure.userExposure} agent=${t.exposure.agentInteractive ? 'interactive' : 'off'}`
        : '';
      out.push(`  ${t.id} state=${t.state}${exposure} title="${t.title}"`);
    }
  }

  if (s.recentTerminalMouseIntents.length > 0) {
    out.push(`terminal mouse intents: ${s.recentTerminalMouseIntents.length}`);
    for (const ev of s.recentTerminalMouseIntents) {
      out.push(
        `  ${ev.paneKind} ${ev.mouseType} @${ev.row},${ev.col} ${ev.transport} surface=${truncate(ev.surfaceId, 40)}`
        + ` host=${ev.hostInterpretation}`
        + ` user=${ev.exposure.userExposure}`
      );
    }
  }

  return out.join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
