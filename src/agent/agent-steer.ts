// AGENT-STEER — a live correction channel from a parent (seat or person) to its subagents.
//
// Situation: the parent spawns background Agent capsules; the instruction changes while they run. Without this
// channel the only move was to stop and re-spawn (losing the child's context). Here:
//   · running  → the body is queued on the task; the child's tool loop drains it right before its next model
//                request (`streamLLMWithTools` · `drainPendingUserInput`), or the runner feeds it as one more step
//                when the child was about to finish.
//   · finished → the task resumes with its full prior messages plus the new body (`AgentRegistry.resume`).
//   · unknown  → an error that names the live and recent agents.
// Observation: `agent.steer {from,to,bytes}` / `agent.resume {from,to,bytes}` · `task.corrections` counts sends.

import { debug } from '../debug/log.js';
import type { AgentRegistry } from './registry.js';
import type { AgentTask } from './types.js';

export type AgentSendMode = 'steer' | 'resume';

/** IPC message the Next TUI sends to its REPL child for `/agent <name> <text>`. */
export const NEXT_TUI_AGENT_SEND_TYPE = 'elanous.next-tui.agent-send';

/** The header every correction carries in the child's conversation. */
export const AGENT_CORRECTION_HEAD = '[correction from parent · the latest instruction wins]';

/** One line appended to every subagent system prompt. */
export const AGENT_STEER_SYSTEM_NOTE =
  'Corrections from your parent may arrive mid-run as user messages headed «' + AGENT_CORRECTION_HEAD + '». ' +
  'When one arrives, the latest instruction wins: adjust the remaining work to it instead of finishing the old plan.';

const inbox = new Map<string, string[]>();

export function enqueueAgentSteer(taskId: string, text: string): void {
  inbox.set(taskId, [...(inbox.get(taskId) ?? []), text]);
}

/** Drain (and empty) the queued corrections for one task. */
export function drainAgentSteer(taskId: string): string[] {
  const items = inbox.get(taskId) ?? [];
  inbox.delete(taskId);
  return items;
}

export function hasAgentSteer(taskId: string): boolean {
  return (inbox.get(taskId)?.length ?? 0) > 0;
}

/** Test isolation. */
export function clearAgentSteerInbox(): void { inbox.clear(); }

function isTerminal(task: AgentTask): boolean {
  return task.state === 'done' || task.state === 'error' || task.state === 'aborted';
}

/** The names a caller may use: label (the Agent tool's `name`/`description`), definition name, id. */
export function agentDisplayName(task: AgentTask): string {
  return task.label ?? task.definition.name;
}

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

/** Resolve `to` among the tasks this requester owns: exact id → unique id prefix (≥4) → label → definition name.
 *  Among several name matches a live task wins over a finished one, then the most recent. */
export function resolveAgentTarget(tasks: readonly AgentTask[], to: string): AgentTask | null {
  const raw = to.trim();
  if (!raw) return null;
  const exact = tasks.find((task) => task.id === raw);
  if (exact) return exact;
  if (raw.length >= 4) {
    const byPrefix = tasks.filter((task) => task.id.startsWith(raw));
    if (byPrefix.length === 1) return byPrefix[0]!;
  }
  const key = norm(raw);
  const byName = tasks.filter((task) => (task.label !== undefined && norm(task.label) === key) || norm(task.definition.name) === key);
  if (byName.length === 0) return null;
  return [...byName].sort((a, b) => Number(isTerminal(a)) - Number(isTerminal(b)) || (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]!;
}

export interface AgentSendRequest {
  to: string;
  body: string;
  mode?: AgentSendMode;
  /** Who sends: the parent session id, or 'human' for the TUI slash command. */
  from: string;
  /** When set, only tasks owned by this session are addressable. */
  ownerSessionId?: string;
}

export type AgentSendOutcome =
  | { ok: true; delivered: 'steer' | 'resume'; taskId: string; name: string; corrections: number }
  | { ok: false; error: string; known: string[] };

/** One line per addressable task, live first: «name (state · id8)». */
export function addressableAgentNames(tasks: readonly AgentTask[]): string[] {
  return [...tasks]
    .sort((a, b) => Number(isTerminal(a)) - Number(isTerminal(b)) || (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .map((task) => `${agentDisplayName(task)} (${task.state} · ${task.id.slice(0, 8)})`);
}

export function sendToAgent(registry: AgentRegistry, request: AgentSendRequest): AgentSendOutcome {
  const tasks = registry.list().filter((task) => request.ownerSessionId === undefined
    || task.parentSessionId === undefined || task.parentSessionId === request.ownerSessionId);
  const known = addressableAgentNames(tasks);
  const body = request.body.trim();
  if (!body) return { ok: false, error: 'AgentSend: body must be non-empty', known };
  const target = resolveAgentTarget(tasks, request.to);
  if (!target) {
    return { ok: false, known,
      error: `AgentSend: no agent named '${request.to}'. Addressable: ${known.length ? known.join(', ') : '(none)'}` };
  }
  const bytes = Buffer.byteLength(body, 'utf8');
  const text = `${AGENT_CORRECTION_HEAD}\n${body}`;
  const name = agentDisplayName(target);
  if (!isTerminal(target) && request.mode !== 'resume') {
    enqueueAgentSteer(target.id, text);
    target.corrections = (target.corrections ?? 0) + 1;
    debug.log('agent.steer', `${request.from} → ${name}`, { from: request.from, to: target.id, bytes }, { level: 'info' });
    return { ok: true, delivered: 'steer', taskId: target.id, name, corrections: target.corrections };
  }
  if (!isTerminal(target)) {
    return { ok: false, known, error: `AgentSend: '${name}' is still ${target.state} — use mode "steer" (resume is for a finished agent)` };
  }
  if (!registry.canResume(target.id)) {
    return { ok: false, known, error: `AgentSend: '${name}' finished but was not started by an Agent spawn in this process — it cannot be resumed` };
  }
  target.corrections = (target.corrections ?? 0) + 1;
  const handle = registry.resume(target.id, text);
  debug.log('agent.resume', `${request.from} → ${name}`, { from: request.from, to: target.id, bytes }, { level: 'info' });
  // Drain off-thread like a background spawn; completion reaches the parent through the task-notification queue.
  void (async () => {
    try { for await (const _ev of handle.events) { /* state lives on the task */ } }
    catch (error) { debug.log('agent.error', 'resume-drain', { taskId: target.id, message: error instanceof Error ? error.message : String(error) }, { level: 'error' }); }
  })();
  return { ok: true, delivered: 'resume', taskId: target.id, name, corrections: target.corrections };
}

/** Parse `/agent <name> <text>` (name may be quoted to hold spaces). Null = not this command or missing parts. */
export function parseAgentSlash(input: string): { to: string; body: string } | null {
  const trimmed = input.trim();
  if (trimmed !== '/agent' && !trimmed.startsWith('/agent ')) return null;
  const rest = trimmed.slice('/agent'.length).trim();
  if (!rest) return null;
  let to: string;
  let body: string;
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    const end = rest.indexOf(quote, 1);
    if (end < 0) return null;
    to = rest.slice(1, end);
    body = rest.slice(end + 1).trim();
  } else {
    const space = rest.search(/\s/);
    if (space < 0) return null;
    to = rest.slice(0, space);
    body = rest.slice(space + 1).trim();
  }
  return to.trim() && body ? { to: to.trim(), body } : null;
}
