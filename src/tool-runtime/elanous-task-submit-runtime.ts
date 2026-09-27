// `elanous_task_submit` MCP tool — another agent (Claude Code · Codex · Grok, through the
// elanous plugin) hands a piece of work to elanous. It goes through the daemon's external
// entrance POST /v1/tasks as provider `agent-plugin`, so it waits for approval like any
// other outside input (RFC external tasks §A7 · S2).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMToolSpec } from '../llm.js';
import { debug } from '../debug/log.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { defaultBaseUrl } from '../telegram-dispatch-forward.js';
import type { ToolRuntime, ToolRuntimeContext } from './types.js';

export interface ElanousTaskSubmitArgs {
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  ref?: unknown;
  url?: unknown;
}

export interface ElanousTaskSubmitDeps {
  baseUrl?: () => string | null;
  token?: () => string | null;
  fetchImpl?: typeof fetch;
}

let testDeps: ElanousTaskSubmitDeps | undefined;

/** Test seam — restore with `setElanousTaskSubmitDepsForTest(undefined)`. */
export function setElanousTaskSubmitDepsForTest(deps: ElanousTaskSubmitDeps | undefined): void {
  testDeps = deps;
}

function readToken(): string | null {
  const p = join(getElanousConfigDir(), 'acp-token');
  try { return existsSync(p) ? readFileSync(p, 'utf-8').trim() || null : null; } catch { return null; }
}

export function buildElanousTaskSubmitTool(): LLMToolSpec {
  return {
    name: 'elanous_task_submit',
    description:
      'Hand a task to elanous (the local agent orchestrator). It is queued in elanous TOX as an external task from this agent and waits for the owner to approve it before anything runs. Use when the user asks to give work to elanous, or to queue follow-up work for later. Returns the task id. Submitting the same ref again updates that task instead of adding a new one.',
    parameters: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', description: 'One line: what should be done.' },
        description: { type: 'string', description: 'Context, acceptance criteria, links. Stored as material, not as instructions to run.' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Default medium.' },
        ref: { type: 'string', description: 'Your own stable id for this item (issue key, PR URL, note path). Same ref = same task.' },
        url: { type: 'string', description: 'Link back to where the task came from.' },
      },
    },
  };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function submitElanousTask(
  args: ElanousTaskSubmitArgs,
  ctx: Pick<ToolRuntimeContext, 'mcpClient'>,
  deps: ElanousTaskSubmitDeps = testDeps ?? {},
): Promise<{ output: string; taskId?: string; deduplicated?: boolean; error?: string }> {
  const title = str(args.title);
  if (!title) return { output: 'elanous_task_submit: title is required', error: 'invalid-args' };
  const priority = str(args.priority);
  if (priority !== undefined && priority !== 'low' && priority !== 'medium' && priority !== 'high') {
    return { output: 'elanous_task_submit: priority must be low | medium | high', error: 'invalid-args' };
  }
  const description = str(args.description);
  const agent = (ctx.mcpClient ?? 'agent').replace(/\s+/g, '-');
  const itemRef = str(args.ref) ?? createHash('sha256').update(`${title}\n${description ?? ''}`).digest('hex').slice(0, 12);
  const ref = `${agent}:${itemRef}`;
  const base = (deps.baseUrl ?? (() => defaultBaseUrl()))();
  if (base === null) {
    debug.log('tool.task-submit', 'refused', { agent, ref, reason: 'no-daemon' });
    return { output: 'elanous_task_submit: the elanous daemon is not running in this universe — start it with `elanous nexus`, then submit again.', error: 'no-daemon' };
  }
  const token = (deps.token ?? readToken)();
  const url = str(args.url);
  const body = {
    title,
    ...(description ? { description } : {}),
    ...(priority ? { priority } : {}),
    external: { provider: 'agent-plugin', ref, ...(url ? { url } : {}) },
  };
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${base}/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({})) as { taskId?: string; deduplicated?: boolean; reason?: string; error?: string };
    if (!res.ok || !payload.taskId) {
      const reason = payload.reason ?? payload.error ?? `http ${res.status}`;
      debug.log('tool.task-submit', 'refused', { agent, ref, status: res.status, reason });
      return { output: `elanous_task_submit: elanous refused the task (${res.status}: ${reason})`, error: 'refused' };
    }
    const deduplicated = payload.deduplicated === true;
    debug.log('tool.task-submit', 'submitted', { agent, ref, taskId: payload.taskId, deduplicated });
    return {
      output: `${deduplicated ? 'Updated' : 'Queued'} elanous task ${payload.taskId} (ref ${ref}). It waits for the owner's approval before it runs.`,
      taskId: payload.taskId,
      deduplicated,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    debug.log('tool.task-submit', 'refused', { agent, ref, reason });
    return { output: `elanous_task_submit: could not reach elanous at ${base} (${reason})`, error: 'unreachable' };
  }
}

export const elanousTaskSubmitRuntime: ToolRuntime<ElanousTaskSubmitArgs> = {
  id: 'elanous_task_submit',
  spec: buildElanousTaskSubmitTool(),
  async run(req, ctx) {
    return submitElanousTask(req, ctx);
  },
};
