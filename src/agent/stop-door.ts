// STOP-DOOR-ONE (WORKER-UNIFY §6-5) — the four stop doors (AgentStop · TUI task-stop ·
// ShellKill · stopDetachedShellCapsule) answer one shape. Pure judge: no I/O, no kill.
// Each door probes its own registry, asks `judgeStop`, and only a `stopped` verdict may signal.
// Fail-closed: a target owned by someone else, or an owner that cannot be compared with the
// requester, is refused — never stopped.

export type StopTargetKind = 'agent' | 'task' | 'shell' | 'capsule';

export type StopRefusal = 'not-found' | 'not-owner' | 'requester-unknown' | 'missing-id';

export interface StopProbe {
  readonly kind: StopTargetKind;
  readonly id: string;
  /** Door found the target in its registry. */
  readonly exists: boolean;
  /** Target already reached a terminal state (done/error/aborted/completed/killed). */
  readonly ended: boolean;
  /** Session that owns the target. Undefined = the door has no owner concept (same-process registry). */
  readonly owner?: string;
  /** Session that asks for the stop. */
  readonly requester?: string;
  readonly reason?: string;
}

export interface StopOutcome {
  readonly kind: StopTargetKind;
  readonly id: string;
  /** True when authorized by the judge and, in a door result, the signal was sent. */
  readonly stopped: boolean;
  readonly alreadyEnded: boolean;
  readonly refused?: StopRefusal;
  readonly failed?: 'signal-failed';
  readonly reason?: string;
}

export function judgeStop(probe: StopProbe): StopOutcome {
  const base = {
    kind: probe.kind,
    id: probe.id,
    ...(probe.reason ? { reason: probe.reason } : {}),
  };
  const refuse = (refused: StopRefusal): StopOutcome =>
    ({ ...base, stopped: false, alreadyEnded: false, refused });
  if (!probe.id) return refuse('missing-id');
  if (!probe.exists) return refuse('not-found');
  if (probe.owner !== undefined) {
    if (probe.requester === undefined || probe.requester === '') return refuse('requester-unknown');
    if (probe.requester !== probe.owner) return refuse('not-owner');
  }
  if (probe.ended) return { ...base, stopped: false, alreadyEnded: true };
  return { ...base, stopped: true, alreadyEnded: false };
}
