// ── Ephemeral shell audit log (X2) ──
//
// Append-only NDJSON log of every runShell invocation + every
// approval decision. One file per local date; the runtime writes
// fire-and-forget (errors never block the shell call).
//
// Path: ~/.monad-agent/audit/shell-YYYY-MM-DD.ndjson
//       (overridable via setAuditLogRootForTesting).
//
// Rotation: none — one file per day, small enough that daily
// rollover is plenty for interactive use. Operators who want
// long-term retention archive the audit/ directory themselves.
//
// Events:
//   • approval — the decision resolved for an approvalKey + its source
//     (cache | approver | fail-closed). Separate from the run event
//     so denials without execution still show up.
//   • run      — a completed runShell() call (any outcome, including
//     denied / spawn-error / timeout / aborted / exit).
//
// Keeping audit state out of approval-cache.ts on purpose: tests that
// only want to exercise the cache shouldn't have to reset a log sink.

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { join } from 'node:path';

export type AuditEvent =
  | {
      type: 'approval';
      ts: string;               // ISO-8601 UTC
      approvalKey: string;
      decision: string;         // ApprovalDecision union — stringified for NDJSON stability
      source: 'cache' | 'approver' | 'fail-closed' | 'no-approver-non-destructive' | 'relaxed-non-destructive';
      command: string[];
      cwd: string;
    }
  | {
      type: 'run';
      ts: string;
      approvalKey: string;
      command: string[];
      cwd: string;
      outcome: string;          // ShellResult['outcome']
      exitCode: number | null;
      elapsedMs: number;
      truncated: boolean;
    };

// ─── Sink wiring ─────────────────────────────────────────────────

type Sink = (ev: AuditEvent) => void;

/** Log root override for tests. When null, defaults to ~/.monad-agent/audit. */
let overrideRoot: string | null = null;
/** In-memory test sink — captures events instead of writing to disk. */
let testSink: Sink | null = null;

export function setAuditLogRootForTesting(root: string | null): void {
  overrideRoot = root;
}

export function setAuditSinkForTesting(sink: Sink | null): void {
  testSink = sink;
}

// FU2 Tier 3 (PLAN-config-unification-elanous-root-2026-05-10):
//   moved from ~/.monad-agent/audit/ → ~/.elanous/audit/.
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
  return join(defaultRoot(), `shell-${y}-${m}-${d}.ndjson`);
}

/** Emit an event. Sync writes keep ordering deterministic; the hot
 *  path is a single appendFileSync on <1 KB per line, well within
 *  one syscall budget. */
export function recordAudit(ev: AuditEvent): void {
  // Test sink wins when set.
  if (testSink) {
    try { testSink(ev); } catch { /* swallow */ }
    return;
  }
  try {
    const root = defaultRoot();
    if (!existsSync(root)) {
      mkdirSync(root, { recursive: true });
    }
    appendFileSync(todayFile(), JSON.stringify(ev) + '\n');
  } catch {
    // Never let audit failure escape — the shell call took priority.
  }
}

export { defaultRoot as _auditRootForTesting, todayFile as _auditFileForTesting };

/** CEO 11-23 ELS-ELN-SECURITY-RELAX — the audit row for a seat argv that ran without the signed grant. */
export function recordRelaxedAudit(command: readonly string[], cwd: string, approvalKey: string): void {
  recordAudit({ type: 'approval', ts: new Date().toISOString(), approvalKey, decision: 'allow-once',
    source: 'relaxed-non-destructive', command: [...command], cwd });
}
