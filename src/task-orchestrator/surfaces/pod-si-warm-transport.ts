/** Host boundary for si-v1. No si-task Pod runner is installed yet; callers must supply a fixed runner. */
import { assessSiWarmReply, decideSiWarmNextStep, parseSiWarmCommand, siWarmDigestMatches,
  type SiWarmCommand, type SiWarmReply, type SiWarmReturnedBytes,
  type SiWarmValidationReason } from './pod-si-warm-protocol.js';

const MAX_PRIVATE_BYTES = 64 * 1024 * 1024;
const MAX_WIRE_BYTES = 128 * 1024 * 1024;
const RUNNER_PATH = '/workspace/repo/src/task-orchestrator/surfaces/pod-si-warm-runner.ts';
const DNS = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export interface SiWarmPodIdentity {
  context: string;
  namespace: string;
  name: string;
  podUid: string;
  workerId: string;
  sourceSha: string;
  imageDigest: string;
  lockHash: string;
  architecture: string;
}

export interface SiWarmExecReceipt {
  reply: unknown;
  bytes: SiWarmReturnedBytes | null;
  /** Cleanup is performed inside the fenced runner after the child exits. */
  cleanup: 'clean' | 'failed' | 'unknown';
}

export interface SiWarmFixedRunner {
  /** Read the live Pod UID and immutable annotations immediately before exec. */
  inspect(pod: SiWarmPodIdentity): Promise<SiWarmPodIdentity | null>;
  /** The adapter must bind this invocation to the exact Pod UID and use stdin only for private bytes. */
  execute(argv: readonly string[], stdin: Uint8Array, timeoutMs: number): Promise<SiWarmExecReceipt>;
  /** Persist quarantine against this exact lease; an unsuccessful call remains quarantine-required. */
  quarantine(command: SiWarmCommand, reason: string): Promise<boolean>;
}

export type SiWarmTransportReason = 'match' | 'runner-unavailable' | 'invalid-command'
  | 'pod-identity' | 'lease-unfenced' | 'expired' | 'private-input-too-large'
  | 'exec-uncertain' | 'cleanup' | SiWarmValidationReason;

export interface SiWarmTransportResult {
  boundary: 'not-entered' | 'exec-attempted';
  reason: SiWarmTransportReason;
  measured: boolean;
  quarantineWorker: boolean;
  quarantineRecorded: boolean;
  quarantineError?: string;
  validationReason?: SiWarmValidationReason;
  /** Verified child bytes retained for PR reconciliation even when cleanup blocks adoption. */
  verifiedBytesForReconcile?: SiWarmReturnedBytes;
  reply: SiWarmReply | null;
  bytes: SiWarmReturnedBytes | null;
}

const noEntry = (reason: SiWarmTransportReason): SiWarmTransportResult => ({
  boundary: 'not-entered', reason, measured: false, quarantineWorker: false,
  quarantineRecorded: false, reply: null, bytes: null,
});

/** An unfenced lease is unconfirmed: the si-v1 decision contract (decideSiWarmNextStep) judges it
 *  reconcile-only with worker quarantine, so the transport must never report quarantineWorker:false there. */
const noEntryUnfenced = (): SiWarmTransportResult => ({
  boundary: 'not-entered', reason: 'lease-unfenced', measured: false, quarantineWorker: true,
  quarantineRecorded: false, reply: null, bytes: null,
});

/** Length-prefixed binary fields. Neither payload nor credential bytes enter argv or logs. */
export function encodeSiWarmPrivateStdin(command: SiWarmCommand, payload: Uint8Array,
  credentialBundle: Uint8Array): Uint8Array {
  const metadata = Buffer.from(JSON.stringify(command));
  const parts = [metadata, Buffer.from(payload), Buffer.from(credentialBundle)];
  if (parts.some(part => part.length > MAX_PRIVATE_BYTES)
    || parts.reduce((sum, part) => sum + part.length + 4, 0) > MAX_WIRE_BYTES)
    throw new Error('private-input-too-large');
  const frame = Buffer.allocUnsafe(parts.reduce((sum, part) => sum + part.length + 4, 0));
  let offset = 0;
  for (const part of parts) {
    frame.writeUInt32BE(part.length, offset);
    offset += 4;
    part.copy(frame, offset);
    offset += part.length;
  }
  return frame;
}

function samePod(command: SiWarmCommand, pod: SiWarmPodIdentity): boolean {
  return pod.namespace.length <= 63 && pod.name.length <= 63
    && DNS.test(pod.namespace) && DNS.test(pod.name) && !!pod.context
    && command.podUid === pod.podUid && command.workerId === pod.workerId
    && command.sourceSha === pod.sourceSha && command.key.context === pod.context
    && command.key.imageDigest === pod.imageDigest && command.key.lockHash === pod.lockHash
    && command.key.architecture === pod.architecture;
}

/** An exec may have produced a PR before its response was lost. Every attempted failure requires reconciliation. */
export async function executeSiWarmTransport(input: {
  command: unknown;
  pod: SiWarmPodIdentity;
  leaseFenced: boolean;
  payload: Uint8Array;
  credentialBundle: Uint8Array;
  runner?: SiWarmFixedRunner;
  now?: () => number;
}): Promise<SiWarmTransportResult> {
  const command = parseSiWarmCommand(input.command);
  if (!command || !(input.payload instanceof Uint8Array)
    || !(input.credentialBundle instanceof Uint8Array)
    || !siWarmDigestMatches(input.payload, command.payloadSha256)
    || !siWarmDigestMatches(input.credentialBundle, command.credentialBundleSha256))
    return noEntry('invalid-command');
  if (!input.leaseFenced) return noEntryUnfenced();
  if (!samePod(command, input.pod)) return noEntry('pod-identity');
  const budget = command.deadlineAt - (input.now ?? Date.now)();
  if (!Number.isSafeInteger(budget) || budget < 1) return noEntry('expired');
  // The current Pod image has only the gate-v1 runner. Do not enter it on an si-task request.
  if (!input.runner) return noEntry('runner-unavailable');
  let observed: SiWarmPodIdentity | null;
  try { observed = await input.runner.inspect(input.pod); }
  catch { return noEntry('pod-identity'); }
  if (!observed || !samePod(command, observed) || observed.name !== input.pod.name
    || observed.namespace !== input.pod.namespace) return noEntry('pod-identity');
  const remaining = command.deadlineAt - (input.now ?? Date.now)();
  if (!Number.isSafeInteger(remaining) || remaining < 1) return noEntry('expired');
  let stdin: Uint8Array;
  try { stdin = encodeSiWarmPrivateStdin(command, input.payload, input.credentialBundle); }
  catch { return noEntry('private-input-too-large'); }
  const argv = ['--context', input.pod.context, '-n', input.pod.namespace,
    'exec', `pod/${input.pod.name}`, '-c', 'worker', '-i', '--', 'bun', RUNNER_PATH] as const;
  // A severed exec stream leaves the worker state unknown. Propagate the failure so the
  // host boundary quarantines the lease instead of trusting an unmeasured receipt.
  // The lease and child share the admitted deadline. A shorter exec timeout
  // would quarantine a healthy long SI run while it is still within budget.
  const receipt: SiWarmExecReceipt = await input.runner.execute(argv, stdin, remaining);
  const validation = assessSiWarmReply(command, receipt.reply, receipt.bytes,
    input.payload, input.credentialBundle);
  const reason: SiWarmTransportReason = receipt.cleanup !== 'clean'
    ? (validation.reason === 'match' ? 'cleanup' : 'exec-uncertain') : validation.reason;
  const decision = decideSiWarmNextStep({ boundary: 'exec-attempted',
    leaseFenced: input.leaseFenced, validation });
  if (decision.next === 'adopt-warm' && receipt.cleanup === 'clean')
    return { boundary: 'exec-attempted', reason: 'match', measured: true,
    quarantineWorker: false, quarantineRecorded: false,
    validationReason: validation.reason, reply: receipt.reply as SiWarmReply, bytes: receipt.bytes };
  let quarantineRecorded = false;
  let quarantineError: string | undefined;
  try { quarantineRecorded = await input.runner.quarantine(command, reason); }
  catch (error) { quarantineError = error instanceof Error ? error.message : String(error); }
  if (!quarantineRecorded && !quarantineError) quarantineError = 'quarantine was not recorded';
  return { boundary: 'exec-attempted', reason, measured: false, quarantineWorker: true,
    quarantineRecorded, ...(quarantineError ? { quarantineError } : {}),
    validationReason: validation.reason,
    ...(validation.measured && validation.reason === 'match' && receipt.bytes
      ? { verifiedBytesForReconcile: receipt.bytes } : {}),
    reply: null, bytes: null };
}
