// Local operator door (CEO 11-24 «불필요한 보안 강화 금지»): same host + same OS user = trusted.
// No key file, no parent-process check — only the kernel peer UID and one audit line per call.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export const LOCAL_OPERATOR_OPS: readonly string[] = ['read', 'status', 'send'];

/** The socket peer's kernel UID must equal the server's own UID; anything else is refused. */
export function localOperatorAllowed(peerUid: number | undefined, serverUid: number | undefined): boolean {
  return peerUid !== undefined && serverUid !== undefined && peerUid === serverUid;
}

export type OperatorAuditEvent = { op: string; pane?: string; uid?: number; pid?: number; chars?: number; result: string };

/** One JSON line per call (who/what). Message text is never written — only its length. Best effort: never blocks a call. */
export function auditOperator(dir: string, event: OperatorAuditEvent): void {
  const { op, pane, uid, pid, chars, result } = event;
  try {
    appendFileSync(join(dir, 'local-operator-audit.jsonl'),
      JSON.stringify({ time: new Date().toISOString(), op, ...(pane ? { pane } : {}), uid, pid, ...(chars !== undefined ? { chars } : {}), result }) + '\n',
      { mode: 0o600 });
  } catch { /* audit is a record, not a gate */ }
}
