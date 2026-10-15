import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { scanCodexTurns } from './recorder.js';

export interface PtyUsageReemitOpts {
  readonly codexHome: string;
  readonly runId: string;
  /** Spawned child's worktree, recorded by Codex session_meta; shared-home sessions in other worktrees are excluded. */
  readonly workdir: string;
  /** Codex session UUID observed from this child PTY; empty when unavailable (emit nothing). */
  readonly sessionId: string;
  /** Caller-observed metadata only. Never infer a Codex account from CODEX_HOME. */
  readonly role?: string;
  readonly stage?: string;
  readonly account?: string;
  /** Child start time: do not attribute older sessions in a shared CODEX_HOME to this child. */
  readonly sinceMs?: number;
  /** Override the dedup ledger location in isolated tests. */
  readonly ledgerPath?: string;
}

/** Persist turn identity across rescans and process restarts, then publish new turns to logs.db. */
export function reemitPtyUsage(opts: PtyUsageReemitOpts): number {
  if (!debug.isAnySinkEnabled() || !opts.sessionId) return 0;
  const { turns, errors } = scanCodexTurns({ codexRoot: join(opts.codexHome, 'sessions'), codexSessionCwd: opts.workdir,
    ...(opts.sinceMs !== undefined ? { lookbackDays: Math.max(30, (Date.now() - opts.sinceMs) / 86_400_000 + 1) } : {}),
  });
  if (errors) debug.log('budget.pty-usage', 'scan-errors', { runId: opts.runId, errors }, { level: 'warn' });
  const eligible = turns.filter((turn) =>
    (opts.sinceMs === undefined || turn.completedAt >= opts.sinceMs)
    && turn.sessionId === opts.sessionId);
  const ledgerPath = opts.ledgerPath ?? join(elanousStateRoot(), 'budget', 'pty-usage-reemit.sqlite');
  mkdirSync(resolve(ledgerPath, '..'), { recursive: true });
  const db = new Database(ledgerPath);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS emitted_turns (codex_home TEXT NOT NULL, turn_id TEXT NOT NULL, PRIMARY KEY (codex_home, turn_id))');
    const insert = db.prepare('INSERT OR IGNORE INTO emitted_turns (codex_home, turn_id) VALUES (?, ?)');
    const home = resolve(opts.codexHome);
    let emitted = 0;
    for (const turn of eligible) {
      if (Number(insert.run(home, turn.turnId).changes) === 0) continue;
      debug.log('llm.usage', 'llm-usage', {
        runId: opts.runId,
        ...(opts.role !== undefined ? { role: opts.role } : {}),
        ...(opts.stage !== undefined ? { stage: opts.stage } : {}),
        ...(opts.account !== undefined ? { account: opts.account } : {}),
        substrate: 'pty',
        site: 'pty-rollup:codex',
        turnId: turn.turnId,
        model: turn.model,
        provider: turn.provider,
        billingProvider: 'codex',
        billing: 'subscription',
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        ...(turn.cacheReadTokens !== undefined ? { cacheReadInputTokens: turn.cacheReadTokens } : {}),
        cost: { kind: 'unknown', model: turn.model },
      });
      emitted++;
    }
    return emitted;
  } finally {
    db.close();
  }
}
