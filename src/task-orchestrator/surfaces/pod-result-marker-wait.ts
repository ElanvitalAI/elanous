// TA-POD-WARMBOOT-PARITY (10-15) — the Pod result marker (GATE-POD-RESULT-MARKER · #27815) for Jobs that do not go
// through runPodCommand (the si-task Job in self-implement-pod.ts).
//
// S: runPodCommand prints `\n<marker> <launch> rc=<n>\n` as the child's last line and ends its wait on it when the Job
//    condition lags (k3d). The si-task Job builds its own manifest and waits only on the condition.
// A: reuse the marker format and split from pod-command-job.ts (no second format), and keep the one-poll judgement
//    («no condition yet → read the tail → this launch's marker? → rc») as a pure function here.
// ⚠️ pod-command-job.ts imports self-implement-pod.ts statically, so self-implement-pod.ts loads this module with a
//    dynamic import only (a static import back would hit the TDZ of the cycle).
// Later (after T1): runPodCommand's own loop can call podResultMarkerRc too.
import { podResultMarker, splitPodResultMarker } from './pod-command-job.js';


/** The child's final shell line: prints this launch's marker with the child rc (same bytes runPodCommand's child prints).
 *  null when the token is not a plain id (`[A-Za-z0-9_.:-]+`) — the Job then runs without a marker (condition path only). */
export function podResultMarkerShellLine(token: string): string | null {
  if (!/^[\w.:-]+$/.test(token)) return null;
  return `printf '\\n%s rc=%s\\n' '${podResultMarker(token)}' "$rc"`;
}

/**
 * One poll, condition not there yet: the `kubectl logs … --tail=2` result → this launch's rc, or null.
 * A failed read (Pod pending · init container), another launch's marker, or a bare marker word is null (keep waiting).
 */
export function podResultMarkerRc(tail: { status: number | null; stdout: string }, token: string): number | null {
  if (tail.status !== 0) return null;
  return splitPodResultMarker(tail.stdout.startsWith('\n') ? tail.stdout : `\n${tail.stdout}`, token).rc;
}

/** Remove this launch's marker tail from the child logs before they are parsed (other bytes unchanged). */
export function stripPodResultMarker(logs: string, token: string): string {
  return splitPodResultMarker(logs, token).logs;
}
