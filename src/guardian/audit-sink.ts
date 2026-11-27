// Arc B — Guardian audit sink.
//
// Append-only NDJSON trail for every guardian verdict. Lives next to
// the control audit log (`src/control-audit-log.ts` writes
// `control-YYYY-MM-DD.ndjson`) so daily operator review can ingest
// a single directory tree, but kept in a separate file so filters
// ("what policy denied X?") don't need to parse shell events out.
//
// Path: ~/.monad-agent/audit/guardian-YYYY-MM-DD.ndjson
//       (overridable via setGuardianAuditRootForTesting)
//
// Fire-and-forget: failures are swallowed so no dispatch path blocks
// on disk IO. Matches control-audit-log's contract.

import { appendAuditSafe } from '../kit/audit-ledger/index.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { join } from 'node:path';

export interface GuardianAuditEvent {
  ts: string;                    // ISO-8601 UTC
  toolId: string;
  surface: string;
  decision: 'allow' | 'deny' | 'needs-approval';
  reasons: string[];
  /** Policy kind that produced the decisive verdict. `null` when all
   *  policies allowed and no single policy is the decisive one. */
  policy: string | null;
  /** Truncated payload (see `check.ts` summarize). */
  detail?: Record<string, unknown>;
}

type Sink = (ev: GuardianAuditEvent) => void;

let overrideRoot: string | null = null;
let testSink: Sink | null = null;

export function setGuardianAuditRootForTesting(root: string | null): void {
  overrideRoot = root;
}

export function setGuardianAuditSinkForTesting(sink: Sink | null): void {
  testSink = sink;
}

// FU2 Tier 3 (PLAN-config-unification-elanous-root-2026-05-10):
//   moved from ~/.monad-agent/audit/ → ~/.elanous/audit/. control-audit-log
//   shares this dir · migrate is idempotent so any of the audit modules
//   can fire it on first call.
import { migrateLegacyHomeDir } from '../storage/legacy-elanous-dir-migrate.js';
function defaultRoot(): string {
  if (overrideRoot) return overrideRoot;
  migrateLegacyHomeDir({ legacyHomeRel: join('.monad-agent', 'audit'), elanousRel: 'audit' });
  return join(elanousStateRoot(), 'audit');
}

function todayFile(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return join(defaultRoot(), `guardian-${y}-${m}-${d}.ndjson`);
}

export function appendGuardianAudit(ev: GuardianAuditEvent): void {
  if (testSink) {
    try { testSink(ev); } catch { /* swallow */ }
    return;
  }
  // kit/audit-ledger: fsync · rotation · schema tag; the safe writer logs `kit.audit-ledger write-failed` and never throws —
  // dispatch must not block on disk.
  try { appendAuditSafe(todayFile(), 'guardian.verdict/1', { ...ev }); } catch { /* defaultRoot() migration failure — swallow */ }
}
