/**
 * CAPSULE-B5 (TC #90636 · JUD #90631) — completions the chat child files only in its own task-notification queue
 * also leave as `capsule-done` frames, so the TUI (onLocalChatCapsuleEvent · #38676) can open a turn for them.
 *
 * Which queue items need this (seat-state/TC/CAPSULE-B-CC1-STEP0-1118.md «B5 0단계»):
 *   `shell:<handle>:<n>`              RunShell bg completion (shell.ts enqueueShellCompletionNotice)  → kind shell
 *   `self-implement-stop:<run>:<task>` self-implement run-stop (task-notification.ts)               → kind harness
 * Not bridged (already framed, or not a completion): background Agent tasks (registry ids — B1 watchCapsuleDone),
 * A2 shell capsules (`shell-<b36>-<n>` — installShellCapsuleSink writes its own frame), `shell-watch:` line hits
 * (state running = progress), supplements, another session's items.
 */
import type { PendingTaskNotification } from '../agent/task-notification.js';
import { emitTurnLife } from '../debug/turn-life.js';
import { capsuleDoneTurnEvent, encodeCapsuleFrame } from './capsule-frame.js';
import { capsuleDoneFromHarnessNotification } from './capsule-sources.js';
import type { CapsuleKind } from './contract.js';

/** The kind of a queue item this bridge forwards, or null when another path already frames it (or it is not one). */
export function bridgedCapsuleKind(taskId: string): Extract<CapsuleKind, 'shell' | 'harness'> | null {
  if (taskId.startsWith('shell:')) return 'shell';
  if (taskId.startsWith('self-implement-stop:')) return 'harness';
  return null;
}

export interface QueueBridgeSource {
  onEnqueue(listener: (n: PendingTaskNotification) => void): () => void;
}

export function watchQueueCapsuleDone(
  sessionId: string,
  queue: QueueBridgeSource,
  write: (line: string) => void = (line) => { process.stderr.write(line); },
): { dispose(): void } {
  const emitted = new Set<string>();
  const stop = queue.onEnqueue((n) => {
    const kind = bridgedCapsuleKind(n.taskId);
    if (!kind || emitted.has(n.taskId) || n.state === 'running') return;
    if (n.parentSessionId !== undefined && n.parentSessionId !== sessionId) return;
    const base = capsuleDoneFromHarnessNotification(n, sessionId);
    if (!base) return;
    emitted.add(n.taskId);
    const event = { ...base, kind };
    write(encodeCapsuleFrame(event));
    emitTurnLife('turn-life:capsule-done-emitted', { sessionId, capsuleId: event.capsuleId, eventId: capsuleDoneTurnEvent(event).id, kind, status: event.status,
      durationMs: event.endedAt - event.startedAt, source: 'queue' });
  });
  return { dispose() { stop(); } };
}
