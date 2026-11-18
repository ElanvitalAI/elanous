/**
 * CAPSULE-A2-BASH-DETACH (내부 문서 `TURN-CAPSULE-EVENTS` §3.2 ③-2) — a shell call starts synchronously; past the
 * policy's `syncCapMs` (10s) the SAME process is handed to the background and the turn gets a «capsule started» result.
 *
 * - Within the cap: the call's own result, exactly as today.
 * - Past the cap: the turn's abort signal is unhooked from the process (a later Esc no longer stops it), the capsule is
 *   kept in this module's registry, one `capsule-progress` frame goes out, and the turn continues.
 * - On exit: one `capsule-done` frame (B1 wire) and one task notification (the next turn's drain carries the bounded,
 *   redacted output — the frame itself never carries raw output).
 * - No sink (JUD #38713 must: not the Next TUI chat child — classic · --json · --stdin-jsonl · --scenario · harness · ACP):
 *   nothing would carry the result back, so the call runs inline as before (no timer, no registry, no frame, no notice).
 * - `syncCapMs` = Infinity (`syncCapMs: 0` config): same — inline.
 * - A detached capsule's notification always carries its session (`parentSessionId`): it never reaches another session.
 */
import { globalTaskNotificationQueue, TASK_NOTIFICATION_OUTPUT_CAP, type TaskNotificationQueue } from '../agent/task-notification.js';
import { redactSecretText } from '../debug/log.js';
import { emitTurnLife } from '../debug/turn-life.js';
import type { CapsuleDoneEvent, CapsuleEvent, CapsulePolicy, CapsuleStatus } from './contract.js';

export interface ShellCapsuleCall<R> {
  readonly tool: 'Bash' | 'RunShell';
  /** The command as the model wrote it; only a redacted one-line preview leaves this module. */
  readonly command: string;
  readonly turnSignal?: AbortSignal;
  /** Starts the process. The signal is the turn's until detach, the capsule's own after. */
  start(signal: AbortSignal | undefined): Promise<R>;
  /** Final result → capsule status + the text the notification carries (bounded here). */
  describe(result: R): { readonly status: CapsuleStatus; readonly output: string };
  /** The result the turn gets at detach time. */
  started(capsuleId: string, syncCapMs: number): R;
}

export interface ShellCapsuleDeps {
  readonly policy: CapsulePolicy;
  readonly queue?: TaskNotificationQueue;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
  /** turn-life correlation (OBSERVE-TURN-LIFE-DIAG-COMPLETE): the turn that started the call. */
  readonly correlation?: { readonly turnId?: string };
}

export interface DetachedShellCapsule {
  readonly capsuleId: string;
  readonly tool: 'Bash' | 'RunShell';
  readonly preview: string;
  readonly startedAt: number;
  readonly detachedAt: number;
}

/** Longest command preview a frame or log line carries. 출처: 접힌 한 줄(§3.3 ④) — leaves room for «· status · Ns». */
export const SHELL_CAPSULE_PREVIEW_CAP = 80;

interface Sink { readonly sessionId: string; readonly write: (event: CapsuleEvent) => void }
let sink: Sink | null = null;
let nextId = 0;
const detached = new Map<string, DetachedShellCapsule & { readonly stop: AbortController }>();

/** The chat child's bridge installs the frame writer (it knows the session). No sink = no frame, notification only. */
export function installShellCapsuleSink(sessionId: string, write: (event: CapsuleEvent) => void): { dispose(): void } {
  const mine: Sink = { sessionId, write };
  sink = mine;
  return { dispose() { if (sink === mine) sink = null; } };
}

export function listDetachedShellCapsules(): readonly DetachedShellCapsule[] {
  return [...detached.values()].map(({ stop: _stop, ...rest }) => rest);
}

/** Stops one detached capsule (its process gets the same SIGTERM → SIGKILL path as an Esc). False when unknown. */
export function stopDetachedShellCapsule(capsuleId: string): boolean {
  const entry = detached.get(capsuleId);
  if (!entry) return false;
  entry.stop.abort();
  return true;
}

export function shellCapsulePreview(command: string): string {
  const flat = redactSecretText(command).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > SHELL_CAPSULE_PREVIEW_CAP ? `${flat.slice(0, SHELL_CAPSULE_PREVIEW_CAP - 1)}…` : flat;
}

function bounded(output: string): { text: string; truncated: boolean } {
  const safe = redactSecretText(output);
  if (safe.length <= TASK_NOTIFICATION_OUTPUT_CAP) return { text: safe, truncated: false };
  return { text: `…${safe.slice(-(TASK_NOTIFICATION_OUTPUT_CAP - 1))}`, truncated: true };
}

export async function runShellCapsule<R>(call: ShellCapsuleCall<R>, deps: ShellCapsuleDeps): Promise<R> {
  const decision = deps.policy.decide({ tool: call.tool, kind: 'shell' });
  const cap = decision.mode === 'detach' ? 0 : decision.syncCapMs;
  // Capability, not a switch: only a session with a sink gets the result back — anywhere else, inline.
  if (!Number.isFinite(cap) || sink === null) return call.start(call.turnSignal);

  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const log = deps.log ?? emitTurnLife;
  const turnId = deps.correlation?.turnId;
  const ids = (capsuleId: string) => (turnId ? { turnId, capsuleId } : { capsuleId });
  const startedAt = now();
  const own = new AbortController();
  const forward = (): void => own.abort();
  const turnSignal = call.turnSignal;
  if (turnSignal?.aborted) own.abort();
  else turnSignal?.addEventListener('abort', forward, { once: true });
  const work = call.start(own.signal);

  let timer: unknown;
  const capHit = new Promise<'cap'>((resolve) => { timer = setTimer(() => resolve('cap'), cap); });
  let raced: { value: R } | 'cap';
  try {
    raced = await Promise.race([work.then((value) => ({ value })), capHit]);
  } catch (error) {
    clearTimer(timer);
    turnSignal?.removeEventListener('abort', forward);
    throw error;
  }
  if (raced !== 'cap') {
    clearTimer(timer);
    turnSignal?.removeEventListener('abort', forward);
    return raced.value;
  }

  // Past the cap: the process now belongs to the session, not the turn.
  turnSignal?.removeEventListener('abort', forward);
  const capsuleId = `shell-${startedAt.toString(36)}-${++nextId}`;
  const preview = shellCapsulePreview(call.command);
  const detachedAt = now();
  detached.set(capsuleId, { capsuleId, tool: call.tool, preview, startedAt, detachedAt, stop: own });
  const at = sink;
  try {
    log('turn-life:capsule-detached', { ...ids(capsuleId), tool: call.tool, kind: 'shell', syncCapMs: cap, reason: decision.reason });
  } catch { /* observability is fail-open */ }
  try {
    at?.write({ type: 'capsule-progress', capsuleId, kind: 'shell', sessionId: at.sessionId, at: detachedAt,
      line: `${call.tool} ${preview} · detached after ${Math.round(cap / 1000)}s` });
  } catch { /* a frame failure never stops the capsule */ }

  const settle = (status: CapsuleStatus, output: string): void => {
    detached.delete(capsuleId);
    const endedAt = Math.max(now(), startedAt);
    const seconds = Math.round((endedAt - startedAt) / 1000);
    const { text, truncated } = bounded(output);
    try {
      (deps.queue ?? globalTaskNotificationQueue).enqueue({
        taskId: capsuleId, agentName: call.tool, label: preview,
        ...(at ? { parentSessionId: at.sessionId } : {}),
        state: status === 'ok' ? 'done' : status === 'cancelled' ? 'aborted' : 'error',
        output: text, truncated, durationMs: endedAt - startedAt, finishedAt: endedAt,
        ...(status === 'ok' ? {} : { errorMessage: `capsule ${status}` }),
      });
    } catch { /* the frame below still knocks */ }
    const event: CapsuleDoneEvent | null = at ? {
      type: 'capsule-done', capsuleId, kind: 'shell', sessionId: at.sessionId, startedAt, endedAt, status,
      summary: `${call.tool} ${preview} · ${status} · ${seconds}s`,
    } : null;
    try { if (event) at!.write(event); } catch { /* notification is already queued */ }
    try { log('turn-life:capsule-done', { ...ids(capsuleId), tool: call.tool, kind: 'shell', status, durationMs: endedAt - startedAt }); }
    catch { /* observability is fail-open */ }
  };
  work.then(
    (result) => {
      let described: { readonly status: CapsuleStatus; readonly output: string };
      try { described = call.describe(result); } catch { described = { status: 'failed', output: '' }; }
      settle(described.status, described.output);
    },
    (error: unknown) => settle('failed', error instanceof Error ? error.message : String(error)),
  );
  return call.started(capsuleId, cap);
}
