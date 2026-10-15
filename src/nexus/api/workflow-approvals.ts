// Archon-port follow-up §5.1 (2026-05-08) — workflow approval registry.
//
// The Nexus REST runner is detached (POST /run → 202; the executor
// runs to completion in a background async generator). When an
// approval node fires, there's no stdin to read from. Pre-§5.1 the
// `requestApproval` dep just threw, so any workflow with an approval
// node failed under Nexus.
//
// This module bridges that gap. The Nexus deps' `requestApproval`
// implementation registers a deferred Promise here keyed by runId.
// A new REST endpoint (`POST /v1/workflows/runs/:runId/approve`)
// resolves the Promise with the optional response body, unblocking
// the executor.
//
// Discovery: clients can poll `GET /v1/workflows/runs/pending` to
// see which runs are waiting on input, or subscribe to the SSE
// stream + filter on `kind: 'workflow.approval-requested'` (PR
// follow-up — wired below by `setApprovalListener`).

export interface PendingApprovalSummary {
  runId: string;
  message: string;
  requestedAt: number;
  /** Explicit project ownership. The approval registry does not currently populate this field. */
  projectId?: string;
}

interface PendingApprovalEntry extends PendingApprovalSummary {
  resolve: (response: string | undefined) => void;
  reject: (err: Error) => void;
}

const PENDING = new Map<string, PendingApprovalEntry>();

let approvalRequestedListener: ((summary: PendingApprovalSummary) => void) | null = null;
let approvalResolvedListener: ((runId: string, decision: 'approved' | 'rejected', response?: string) => void) | null = null;

/** Wire an observer for approval-requested events (e.g., the SSE
 *  fan-out path). Pass `null` to clear. Single observer model — keeps
 *  the wire small; if a future caller needs N observers, replace with
 *  the existing `NexusEventBus`. */
export function setApprovalListener(
  fn: ((summary: PendingApprovalSummary) => void) | null,
): void {
  approvalRequestedListener = fn;
}

/** Wire an observer for approval-resolved events (POST /approve or
 *  /reject). Mirrors `setApprovalListener` shape. */
export function setApprovalResolvedListener(
  fn:
    | ((runId: string, decision: 'approved' | 'rejected', response?: string) => void)
    | null,
): void {
  approvalResolvedListener = fn;
}

/** Block until the user POSTs /approve for `runId`. Returns the
 *  response body (or undefined when the approve POST didn't include
 *  one). Throws when /reject is POSTed instead, or the run is
 *  cancelled / times out. */
export function registerApproval(runId: string, message: string): Promise<string | undefined> {
  // If an entry already exists for this runId, reject the older one
  // — no use leaving a dangling Promise across re-runs.
  const existing = PENDING.get(runId);
  if (existing) {
    existing.reject(new Error('approval superseded by a newer request for the same runId'));
  }
  return new Promise((resolve, reject) => {
    const entry: PendingApprovalEntry = {
      runId,
      message,
      requestedAt: Date.now(),
      resolve,
      reject,
    };
    PENDING.set(runId, entry);
    if (approvalRequestedListener) {
      try {
        approvalRequestedListener({ runId, message, requestedAt: entry.requestedAt });
      } catch {
        // observer threw — don't leak into the runtime
      }
    }
  });
}

/** Resolve a pending approval. Returns true when an entry existed
 *  (i.e. the approve POST is targeting a real runId). */
export function resolveApproval(runId: string, response: string | undefined): boolean {
  const p = PENDING.get(runId);
  if (!p) return false;
  PENDING.delete(runId);
  p.resolve(response);
  if (approvalResolvedListener) {
    try { approvalResolvedListener(runId, 'approved', response); } catch { /* swallow */ }
  }
  return true;
}

/** Reject a pending approval — surfaces as an Error inside the
 *  executor, which fails the approval node + the workflow. */
export function rejectApproval(runId: string, reason?: string): boolean {
  const p = PENDING.get(runId);
  if (!p) return false;
  PENDING.delete(runId);
  p.reject(new Error(reason ?? 'approval rejected by user'));
  if (approvalResolvedListener) {
    try { approvalResolvedListener(runId, 'rejected', reason); } catch { /* swallow */ }
  }
  return true;
}

/** Snapshot all pending approvals — read-only view for the GET
 *  /pending endpoint. */
export function listPendingApprovals(): PendingApprovalSummary[] {
  return [...PENDING.values()].map(({ runId, message, requestedAt }) => ({
    runId,
    message,
    requestedAt,
  }));
}

/** Test-only: clear the registry between cases. Also rejects every
 *  outstanding Promise so nothing leaks across test files. */
export function _resetApprovalsForTest(): void {
  for (const p of PENDING.values()) {
    p.reject(new Error('approval registry reset (test)'));
  }
  PENDING.clear();
  approvalRequestedListener = null;
  approvalResolvedListener = null;
}
