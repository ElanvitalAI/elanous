// ── PFC-S1 P2: background task-notification queue ──
//
// When `Agent(..., run_in_background: true)` finishes, the parent LLM
// is no longer awaiting the tool_result — the spawn returned a stub
// "(running in background)" message on the same turn. To surface the
// eventual result, we collect a `PendingTaskNotification` per completed
// background task and inject a `<task-notification>` XML user message
// at the start of the parent's NEXT turn.
//
// Why XML injection instead of a tool ──
//  • Tool-loop parents would need to remember to poll; the reliability
//    of that is low. XML as a system-reminder-style user message means
//    the notification is in the LLM's context whether it asked or not.
//  • Same pattern as task-notification in claude-code fork (AgentTool
//    final message injection).
//
// Scope of this file ──
//  • Queue + XML renderer + singleton.
//  • Auto-wires to globalAgentRegistry.onTaskDone on module load so the
//    background task state transition (src/agent/runner.ts) enqueues
//    automatically — no caller needs to remember to push.
//  • Does NOT touch NotificationStore directly; that wiring lives in
//    chat.ts / skill-runner.ts at the turn-kickoff injection point so
//    we can stamp the right sessionId per call.

import {
  globalAgentRegistry,
  type AgentRegistry,
} from './registry.js';
import type { AgentTask } from './types.js';
import { globalAgentFlash } from '../display/agent-flash.js';
import { debug } from '../debug/log.js';

/** Max chars of the child's final result we echo in the notification.
 *  The parent can still fetch the full text via the registry if it
 *  needs more — this cap keeps the XML compact. */
export const TASK_NOTIFICATION_OUTPUT_CAP = 500;

export interface PendingTaskNotification {
  taskId: string;
  agentName: string;
  /** Caller-supplied short label (Agent tool's `name` arg). */
  label?: string;
  /** Team context this task belonged to (Agent tool's `team_name`). */
  teamName?: string;
  /** Final state of the task — parent LLM sees this to choose follow-up. */
  state: 'done' | 'error' | 'aborted';
  /** Child's final text (capped at TASK_NOTIFICATION_OUTPUT_CAP). */
  output: string;
  /** Whether output was truncated (for XML `truncated` attribute). */
  truncated: boolean;
  /** When state === 'error', the error message from runner. */
  errorMessage?: string;
  /** Wall-clock ms from task.startedAt to task.finishedAt. */
  durationMs: number;
  finishedAt: number;
}

export class TaskNotificationQueue {
  private queue: PendingTaskNotification[] = [];
  /** De-dup guard — same task.finishedAt can fire twice if a caller
   *  listens to both runner events and a separate `onTaskDone` hook.
   *  Keyed by taskId. */
  private seen = new Set<string>();
  /** Wake listeners — fired once per REAL enqueue (not on seen-dup).
   *  TUI-SEAT-READY ③ first shard: one completion event = one wake
   *  signal so an idle parent can open the next turn. Opening the turn
   *  itself is deliberately NOT wired here (next shard). */
  private wakeListeners = new Set<(n: PendingTaskNotification) => void>();

  /** Register a wake listener; returns an unsubscribe function.
   *  Listeners survive `clear()` — they belong to the wiring, not the
   *  queue contents. */
  onEnqueue(listener: (n: PendingTaskNotification) => void): () => void {
    this.wakeListeners.add(listener);
    return () => { this.wakeListeners.delete(listener); };
  }

  enqueue(n: PendingTaskNotification): void {
    if (this.seen.has(n.taskId)) return;
    this.seen.add(n.taskId);
    this.queue.push(n);
    debug.log('agent.task-notification', 'wake', { taskId: n.taskId, size: this.queue.length });
    for (const listener of this.wakeListeners) {
      try {
        listener(n);
      } catch (error) {
        // fail-soft — a throwing wake listener must not lose the
        // queued notification or break sibling listeners.
        try {
          debug.log('agent.task-notification', 'wake-listener-failed', {
            taskId: n.taskId,
            reason: error instanceof Error ? error.message : String(error),
          });
        } catch { /* */ }
      }
    }
  }

  /** Return all pending notifications AND clear the queue. Parents
   *  call this exactly once per turn-start. */
  drain(): PendingTaskNotification[] {
    const out = this.queue;
    this.queue = [];
    // NOTE: we keep `seen` populated so a listener firing a second
    // time for the same task (rare but possible under races) still
    // can't double-inject. `seen` grows unbounded across a session;
    // acceptable — a session produces O(100) tasks at most.
    return out;
  }

  get size(): number {
    return this.queue.length;
  }

  /** Forget everything — tests use this for isolation. Listeners are
   *  preserved: clear() empties queue + seen, not the wake wiring. */
  clear(): void {
    this.queue = [];
    this.seen.clear();
  }
}

export const globalTaskNotificationQueue = new TaskNotificationQueue();

// ── Auto-wire background task completion ─────────────────────────────
//
// The runner (src/agent/runner.ts) flips task.state on done / error /
// abort and updates finishedAt. Its promise continuation is where we
// know the transition has materialised. Rather than touching runner.ts
// we subscribe via AgentRegistry.onTaskDone (P2 extension, below) so
// this file stays a pure consumer.

function buildPendingFromTask(task: AgentTask): PendingTaskNotification | null {
  const state = task.state;
  if (state !== 'done' && state !== 'error' && state !== 'aborted') return null;
  const raw = task.result ?? '';
  const truncated = raw.length > TASK_NOTIFICATION_OUTPUT_CAP;
  const output = truncated
    ? raw.slice(0, TASK_NOTIFICATION_OUTPUT_CAP) + '…(truncated)'
    : raw;
  return {
    taskId: task.id,
    agentName: task.definition.name,
    ...(task.label ? { label: task.label } : {}),
    ...(task.teamName ? { teamName: task.teamName } : {}),
    state,
    output,
    truncated,
    ...(task.error ? { errorMessage: task.error } : {}),
    durationMs: (task.finishedAt ?? Date.now()) - (task.startedAt ?? Date.now()),
    finishedAt: task.finishedAt ?? Date.now(),
  };
}

/** Subscribe a queue to a registry's task-done stream. Only background
 *  tasks are enqueued (foreground tasks are already awaited by the
 *  parent tool-loop and their output is returned as the tool_result).
 *  Returns a disposer. Exported for tests; at module load we call it
 *  once with the global pair. */
export function wireTaskNotifications(
  queue: TaskNotificationQueue = globalTaskNotificationQueue,
  registry: AgentRegistry = globalAgentRegistry,
): () => void {
  const sub = registry.onTaskDone((task) => {
    // PFC-S2 P2: universal flash (foreground + background) so the
    // operator catches completion on the roster regardless of routing.
    globalAgentFlash.register(task.id);
    if (!task.background) return;
    const pending = buildPendingFromTask(task);
    if (!pending) return;
    queue.enqueue(pending);
    if (registry.markForeground(task.id, { allowTerminal: true })) {
      debug.log('agent.task-routing', 'auto-foreground-on-completion', {
        taskId: task.id,
        state: task.state,
        finishedAt: task.finishedAt,
        reason: 'background-task-completed',
      });
    }
  });
  return () => sub.dispose();
}

// Module-load side effect: wire the global pair. Idempotent because
// `onTaskDone` stores listeners in a Set (same function reference
// won't register twice), and the registry itself is a singleton.
let globalWireDisposer: (() => void) | null = null;
function ensureGlobalWire(): void {
  if (globalWireDisposer) return;
  try {
    globalWireDisposer = wireTaskNotifications();
  } catch (error) {
    // 🩸 2026-09-24: registry.ts → runner.js → … → 이 파일 → registry.ts 순환에서, 진입점에 따라(예: scripts/botlab/bot2bot-probe.ts)
    //    이 모듈이 registry 보다 «먼저» 평가되면 `globalAgentRegistry` 가 TDZ 라 ReferenceError 로 «모듈 로드 자체»가 죽었다.
    //    ⇒ 그 경우만 모듈 그래프가 다 올라온 뒤로 미룬다(되는 경로의 동기 배선은 그대로).
    if (!(error instanceof ReferenceError)) throw error;
    try { debug.log('agent.task-notification', 'global-wire-deferred', { reason: error.message }); } catch { /* */ }
    queueMicrotask(() => {
      try { ensureGlobalWire(); } catch { setTimeout(() => { try { ensureGlobalWire(); } catch (late) { try { debug.log('agent.task-notification', 'global-wire-failed', { reason: String(late) }); } catch { /* */ } } }, 0); }
    });
  }
}
ensureGlobalWire();

/** Re-install the global wire — tests may `clear()` the registry
 *  which drops listeners. Call this after a clear to keep task-notifications
 *  flowing again. */
export function rewireGlobalTaskNotifications(): void {
  globalWireDisposer?.();
  globalWireDisposer = null;
  ensureGlobalWire();
}

// ── XML rendering ─────────────────────────────────────────────────────
//
// Format chosen to match the existing <system-reminder> / <task-notification>
// conventions in the Claude-Code fork. The output is intentionally terse
// — the parent LLM just needs state + output; full context lives in the
// registry for follow-up `AgentList` / future `AgentInspect` queries.

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Render N pending notifications as a single `<task-notification>` block.
 *  Returns an empty string when the input array is empty so callers
 *  can `if (rendered) messages.unshift(...)` without branching on length. */
export function renderTaskNotificationsXml(
  items: readonly PendingTaskNotification[],
): string {
  if (items.length === 0) return '';
  const lines: string[] = ['<task-notification>'];
  for (const p of items) {
    const attrs = [
      `id="${escapeXml(p.taskId)}"`,
      `agent="${escapeXml(p.agentName)}"`,
      p.label ? `name="${escapeXml(p.label)}"` : null,
      p.teamName ? `team="${escapeXml(p.teamName)}"` : null,
      `status="${p.state}"`,
      `duration="${formatDuration(p.durationMs)}"`,
      p.truncated ? `truncated="true"` : null,
    ].filter(Boolean).join(' ');
    lines.push(`  <task ${attrs}>`);
    if (p.state === 'error' && p.errorMessage) {
      lines.push(`    <error>${escapeXml(p.errorMessage)}</error>`);
    }
    if (p.output) {
      lines.push(`    <output>${escapeXml(p.output)}</output>`);
    }
    lines.push(`  </task>`);
  }
  lines.push('</task-notification>');
  return lines.join('\n');
}
