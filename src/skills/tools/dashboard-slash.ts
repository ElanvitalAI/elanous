// Native tool: DashboardSlashExecute — T6-K3.
//
// Programmatically fire a slash command. The LLM in dashboard-
// control mode (T6-K1/K2) uses this to run things like `/term list`
// without asking the user to type them.
//
// Allow-list: only a curated subset of SLASH_COMMANDS is callable
// by the LLM. Mutating or confusing commands (e.g. /quit, /sync
// full) are blocked — the user can still type those themselves.
//
// The actual slash dispatch lives in dashboard.ts inside a big
// switch. Rather than refactoring that out, this tool calls a
// host-registered handler that DOES the dispatch. Dashboard wires
// `initDashboardSlashExecutor(handler)` at init.

import type { LLMToolSpec } from '../../llm.js';

export interface SlashExecuteRequest {
  name: string;
  args: string[];
}

export interface SlashExecuteResult {
  ok: boolean;
  name: string;
  args: string[];
  /** Host-emitted log lines the user saw after execution. Best-effort. */
  logLines?: string[];
  /** Error message when ok=false. */
  message?: string;
}

export type SlashExecuteHandler = (
  req: SlashExecuteRequest,
) => Promise<SlashExecuteResult>;

let _handler: SlashExecuteHandler | null = null;

export function initDashboardSlashExecutor(handler: SlashExecuteHandler): void {
  _handler = handler;
}

export function _resetDashboardSlashExecutorForTesting(): void {
  _handler = null;
}

/** Allow-list of slashes the LLM may fire. Kept conservative —
 *  the user can still type anything themselves. Extend when an
 *  additional command proves safe + useful in control mode. */
export const ALLOWED_SLASHES: readonly string[] = Object.freeze([
  'term', 'terminal',
  'provider', 'p',
  'context', 'ctx',
  'plugin', 'plugins',
  'widget', 'widgets',
  'memory', 'mem',
  'status', 'st',
  'surface', 'surf',
  'delta', 'diffs',
  'hint',
  'api-allow', 'api',
  'prompt', 'prompts',
  'history', 'hist',
  'log',
  'claude',
  'codex',
  'control', 'default',
  'help', '?',
  'run-skill', 'rs',
]);

// ⛔⭐ 여기 이름을 더하기 «전»에 — 그 이름이 «실제로 닿는지» 확인한다.
//   📏 2026-08-21 실측: 'keys'·'keybindings' 가 이 목록에 있었는데
//     레지스트리에도 · 레거시 switch 에도 · 즉시 실행기에도 «없었다».
//     ⇒ 툴은 그것을 «큐에 넣고 ok:true» 를 돌려줬고, 사람이 Enter 를 치면 `Unknown command: /keys` 였다.
//     즉 ***모델에게 「부를 수 있다」고 약속하고 실패를 성공으로 보고***했다. 그래서 뺐다.
//   ✅ 그 재발은 아래 시험이 막는다 — test/skill-tool-dashboard-slash.test.ts
const BLOCKED_SLASHES: readonly string[] = Object.freeze([
  'quit', 'q', 'exit',           // never let the LLM kill the dashboard
  'clear', 'cls',                // wipes chat history — user should confirm
  'codex-setup', 'codex-init',   // interactive OAuth
  'telegram', 'tg',              // sensitive config
  'debug',                       // tracer toggles — user-driven
  'perf',                        // profiler — user-driven
]);

export function buildDashboardSlashExecuteTool(): LLMToolSpec {
  return {
    name: 'DashboardSlashExecute',
    description:
      'Run a slash command programmatically from control mode. Only a curated allow-list is callable (term, provider, context, plugin, widget, memory, status, hint, api-allow, prompt, history, claude, codex, control, help, run-skill). Interactive/destructive commands (quit, clear, debug, perf, codex-setup, telegram) are blocked — ask the user to type those. Returns ok=false + reason when the command is blocked or unrecognized.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Slash name without the leading `/`. Case-insensitive.' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Positional args (e.g. ["spawn", "yazi"] for `/term spawn yazi`).',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  };
}

export async function dispatchDashboardSlashExecute(
  rawArgs: Record<string, unknown>,
  deps: { handler?: SlashExecuteHandler } = {},
): Promise<{ output: string }> {
  const handler = deps.handler ?? _handler;
  if (!handler) {
    throw new Error(
      'DashboardSlashExecute is not wired — dashboard must call ' +
      'initDashboardSlashExecutor(handler) at startup.',
    );
  }
  const name = String(rawArgs.name ?? '').trim().replace(/^\//, '').toLowerCase();
  if (!name) throw new Error(`'name' is required`);
  if (BLOCKED_SLASHES.includes(name)) {
    return {
      output: `DashboardSlashExecute refused: /${name} is on the block-list (interactive / destructive). Ask the user to type it themselves.`,
    };
  }
  if (!ALLOWED_SLASHES.includes(name)) {
    return {
      output: `DashboardSlashExecute refused: /${name} is not on the LLM allow-list. If you think this should be callable, mention it to the user and they can add it.`,
    };
  }
  const args = Array.isArray(rawArgs.args) ? rawArgs.args.map(String) : [];
  const r = await handler({ name, args });
  const lines = [`DashboardSlashExecute /${name}${args.length ? ' ' + args.join(' ') : ''} → ${r.ok ? 'ok' : 'failed'}`];
  if (r.logLines && r.logLines.length > 0) {
    lines.push('', '--- log output ---');
    lines.push(...r.logLines.slice(-16));
  }
  if (!r.ok && r.message) lines.push('', `error: ${r.message}`);
  return { output: lines.join('\n') };
}
