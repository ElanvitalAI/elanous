/** Pure catch-up decision for a remote host. Input is sha strings only (no registry import). No I/O. */
export interface CatchUpInput {
  host: string;
  installedSha: string;
  /** Sha of the daemon actually running (verified by a health probe); undefined = not verified. */
  daemonSha?: string;
  desiredSha: string;
  /** OP seat: never restarted automatically. */
  seatIsOp: boolean;
  /** Phase rules.rail (interpreted by phase.py): false = no install/restart now. Unknown must be passed as false. */
  railAllowed: boolean;
}
export interface CatchUpPlan {
  action: 'none' | 'install' | 'hitl';
  /** Gate state RECORDED for this host (host-assign-gate.json): open only after desiredSha is installed AND verified running. Recording only —
   *  no assignment path reads it yet (follow-up cell HOST-ASSIGN-GATE-CONSUME); until then it does not stop any assignment. */
  assignGate: 'open' | 'closed';
  reason: string;
}

const SHA = /^[a-f0-9]{12,40}$/i;

/** Equal when both are 12-40 hex chars and one is a prefix of the other. */
export function shaMatches(a: string, b: string): boolean {
  if (!SHA.test(a) || !SHA.test(b)) return false;
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x.startsWith(y) || y.startsWith(x);
}

export function planCatchUp(input: CatchUpInput): CatchUpPlan {
  const { host, installedSha, daemonSha, desiredSha, seatIsOp, railAllowed } = input;
  if (!SHA.test(installedSha) || !SHA.test(desiredSha)) return { action: 'none', assignGate: 'closed', reason: `${host}: installed or desired sha unknown` };
  // The gate opens only for a daemon verified to be RUNNING desired — an installed record alone proves nothing.
  if (shaMatches(installedSha, desiredSha) && daemonSha && shaMatches(daemonSha, desiredSha)) return { action: 'none', assignGate: 'open', reason: `${host}: running daemon matches desired` };
  if (seatIsOp) return { action: 'hitl', assignGate: 'closed', reason: `${host}: OP seat not running desired; no automatic restart` };
  if (!railAllowed) return { action: 'none', assignGate: 'closed', reason: `${host}: behind, rail not allowed by current phase` };
  return { action: 'install', assignGate: 'closed', reason: `${host}: not running desired; install/restart then reopen gate` };
}
