import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── ShellList / ShellPoll / ShellKill LLM tools (NT-C2) ──
//
// Three thin LLM wrappers around the ShellRegistry. They let a
// model reason about persistent / background shell commands the
// same way codex's UnifiedExecProcessManager exposes PID-style
// reattach semantics — except our "pid" is the Shell Runner
// handle id (e.g. "sh-abc123"), since multiple LLM commands share
// the same underlying PTY in a VW runner.
//
// These tools do NOT spawn. Spawning is the job of the future
// RunShell re-wiring (NT-C1b). Today these enumerate and manipulate
// whatever the shell-runner dispatch has already registered.
//
// Return shapes are intentionally shallow — LLM prompts are already
// noisy; `output` is the first-glance summary, and the structured
// fields let the LLM pick out specifics for follow-ups.


import type { ShellHandle, ShellMode, ShellStatus } from '../../shell-runner/types.js';
import type { ShellRegistry } from '../../shell-runner/registry.js';
import type {
  TerminalSurfaceCapability,
  TerminalUserExposure,
} from '../../terminal/posture.js';
import { deriveTerminalCapability } from '../../terminal/posture.js';

// ── Schemas ────────────────────────────────────────────────────

export function buildShellListTool(): LLMToolSpec {
  return {
    name: 'ShellList',
    description:
      'Enumerate shell-runner commands registered in the current session. ' +
      'Useful before ShellPoll / ShellKill / for tracking background jobs. ' +
      'Returns running + backgrounded + (briefly) completed handles.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['running', 'backgrounded', 'completed', 'killed'],
          description: 'Optional status filter. Omit to list all.',
        },
        mode: {
          type: 'string',
          enum: ['inline', 'bg', 'modal', 'vw'],
          description: 'Optional mode filter. Omit to list all.',
        },
      },
      additionalProperties: false,
    },
  };
}

export function buildShellPollTool(): LLMToolSpec {
  return {
    name: 'ShellPoll',
    description:
      'Read the current state of a shell-runner handle by id — useful to ' +
      'check if a backgrounded command has finished. Returns status, ' +
      'elapsed, and exit code if the command has resolved. Does not block.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Handle id returned by a prior RunShell (form: "sh-xxxx").',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  };
}

export function buildShellKillTool(): LLMToolSpec {
  return {
    name: 'ShellKill',
    description:
      'Send SIGTERM (default) or SIGKILL to a running shell-runner handle. ' +
      'Returns the final status after the kill request; note that graceful ' +
      'shutdown may need a follow-up ShellPoll to confirm "killed" status.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        signal: {
          type: 'string',
          enum: ['SIGTERM', 'SIGKILL'],
          description: "Signal to send. Default 'SIGTERM'.",
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  };
}

// ── Dispatch args + results ─────────────────────────────────────

export interface ShellListResult extends Record<string, unknown> {
  output: string;
  count: number;
  entries: ShellSummary[];
}

export interface ShellSummary {
  id: string;
  mode: ShellMode;
  status: ShellStatus;
  /**
   * PR-1 — multi-platform substrate ROADMAP §C.
   *
   * userExposure + capability vector reflect surface posture (Layer 1
   * vocabulary). LLM agents reading this output see the same 4 values
   * regardless of TUI / PWA / Discord host. interactionPolicy (Layer 2,
   * TUI-specific) is intentionally NOT included here — that lives in
   * the dashboard state snapshot for TUI consumers only.
   *
   * Both fields are nullable: handles with no attached surface and
   * mode != 'bg' (e.g. inline) report null because user-facing posture
   * isn't applicable.
   */
  userExposure?: TerminalUserExposure | null;
  capability?: TerminalSurfaceCapability | null;
}

export interface ShellPollResult extends Record<string, unknown> {
  output: string;
  found: boolean;
  id: string;
  mode?: ShellMode;
  status?: ShellStatus;
  exitCode?: number;
  finished?: boolean;
  userExposure?: TerminalUserExposure | null;
  capability?: TerminalSurfaceCapability | null;
}

export interface ShellKillResult extends Record<string, unknown> {
  output: string;
  found: boolean;
  id: string;
  status?: ShellStatus;
}

// ── Dispatchers ─────────────────────────────────────────────────

export function dispatchShellList(
  raw: Record<string, unknown>,
  registry: ShellRegistry,
): ShellListResult {
  const status = asStatus(raw.status);
  const mode = asMode(raw.mode);
  const filter: { status?: ShellStatus; mode?: Exclude<ShellMode, 'auto'> } = {};
  if (status) filter.status = status;
  if (mode && mode !== 'auto') filter.mode = mode;
  const handles = registry.list(filter);
  return {
    output: `ShellList count=${handles.length}`,
    count: handles.length,
    entries: handles.map((h) => summarize(h, registry)),
  };
}

export function dispatchShellPoll(
  raw: Record<string, unknown>,
  registry: ShellRegistry,
): ShellPollResult {
  const id = requireString(raw.id, 'id');
  const h = registry.get(id);
  if (!h) {
    return {
      output: `ShellPoll found=false id=${id}`,
      found: false,
      id,
    };
  }
  const exposure = registry.describePosture(h.id);
  const capability = exposure ? deriveTerminalCapability(exposure) : null;
  const userExposure = exposure?.userExposure ?? null;
  const r: ShellPollResult = {
    output: formatShellPollOutput(h, userExposure, capability),
    found: true,
    id: h.id,
    mode: h.mode,
    status: h.status,
    finished: h.status === 'completed' || h.status === 'killed',
    userExposure,
    capability,
  };
  return r;
}

function formatShellPollOutput(
  h: ShellHandle,
  userExposure: TerminalUserExposure | null,
  capability: TerminalSurfaceCapability | null,
): string {
  let out = `ShellPoll id=${h.id} status=${h.status} mode=${h.mode}`;
  if (userExposure) out += ` user=${userExposure}`;
  if (capability) {
    // Compact one-line capability summary: 4 letters R/I/W/i with - for false.
    const cap = (capability.canRead ? 'R' : '-')
              + (capability.canInterrupt ? 'I' : '-')
              + (capability.canWrite ? 'W' : '-')
              + (capability.canInspect ? 'i' : '-');
    out += ` cap=${cap}`;
  }
  return out;
}

export async function dispatchShellKill(
  raw: Record<string, unknown>,
  registry: ShellRegistry,
): Promise<ShellKillResult> {
  const id = requireString(raw.id, 'id');
  const signal = asSignal(raw.signal) ?? 'SIGTERM';
  const h = registry.get(id);
  if (!h) {
    return {
      output: `ShellKill found=false id=${id}`,
      found: false,
      id,
    };
  }
  try { h.kill(signal); } catch { /* swallow; surface via status */ }
  // Wait one microtask so the engine has a chance to flip status
  // before the LLM sees the result. The dispatch caller can still
  // follow up with ShellPoll to confirm full shutdown (graceful
  // teardown may take longer).
  await Promise.resolve();
  return {
    output: `ShellKill id=${h.id} signal=${signal} status=${h.status}`,
    found: true,
    id: h.id,
    status: h.status,
  };
}

// ── Argument parsers ────────────────────────────────────────────

function asStatus(raw: unknown): ShellStatus | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'running' || raw === 'backgrounded' || raw === 'completed' || raw === 'killed') {
    return raw;
  }
  throw new Error(`invalid status value: ${JSON.stringify(raw)}`);
}

function asMode(raw: unknown): ShellMode | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'inline' || raw === 'bg' || raw === 'modal' || raw === 'vw' || raw === 'auto') {
    return raw;
  }
  throw new Error(`invalid mode value: ${JSON.stringify(raw)}`);
}

function asSignal(raw: unknown): 'SIGTERM' | 'SIGKILL' | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'SIGTERM' || raw === 'SIGKILL') return raw;
  throw new Error(`invalid signal value: ${JSON.stringify(raw)}`);
}

function requireString(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw === '') {
    throw new Error(`'${field}' must be a non-empty string`);
  }
  return raw;
}

function summarize(h: ShellHandle, registry: ShellRegistry): ShellSummary {
  const exposure = registry.describePosture(h.id);
  const capability = exposure ? deriveTerminalCapability(exposure) : null;
  return {
    id: h.id,
    mode: h.mode,
    status: h.status,
    userExposure: exposure?.userExposure ?? null,
    capability,
  };
}
