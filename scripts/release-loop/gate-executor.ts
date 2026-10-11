// GATE-HOST-EXECUTOR (0.2.24): the release `gate` node has two executors for the SAME verdict.
// `pod` (default) sweeps in k8s shard Pods; `host` sweeps in a clean clone on an SSH host (`gateRemote`).
// The host executor is not a waiver: attribution (introduced/preexisting/baseline) and blocking stay identical —
// it only lets an operator measure when the Pod infrastructure cannot (10-10: node-b containerd DeadlineExceeded × 4).

export type GateExecutor = 'pod' | 'host';

export const GATE_EXECUTORS: readonly GateExecutor[] = ['pod', 'host'];

/** Same shape `judgeGate` accepts for `gateRemote` (`[user@]host`). */
export const GATE_HOST_PATTERN = /^(?:[\w.-]+@)?[\w.-]+$/;

export function isGateExecutor(value: unknown): value is GateExecutor {
  return typeof value === 'string' && (GATE_EXECUTORS as readonly string[]).includes(value);
}

/** Validate an operator-supplied executor/host pair. Host is required for (and only for) the host executor. */
export function checkGateExecutorChoice(executor: unknown, host: unknown): { executor: GateExecutor; host?: string } {
  if (!isGateExecutor(executor)) throw new Error(`gate executor must be pod or host: ${String(executor)}`);
  if (executor === 'host') {
    if (typeof host !== 'string' || !host.trim()) throw new Error('gate executor host requires a gate host (--gate-host <ssh-host> or release.loop.gateRemote)');
    const trimmed = host.trim();
    if (!GATE_HOST_PATTERN.test(trimmed)) throw new Error(`invalid gate host: ${trimmed}`);
    return { executor, host: trimmed };
  }
  if (host !== undefined) throw new Error('--gate-host applies only to --gate-executor host');
  return { executor };
}
