import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPAWN_SYNC_MAX_BUFFER } from '../../src/util/spawn-sync-output.js';
import { PREBUILD_STAGES, runCutGateImagePrebuild, type PrebuildStage, type PrebuildStageReceipt } from './gate-image-pin.js';

/** RELEASE-REALPATH-PROBE (RELEASE-SELFHEAL-GAP-1118 §3-2): the hard rehearsal walks the real cut image prebuild. */
export interface RealpathProbeReceipt {
  outcome: 'ok' | 'failed' | 'skipped';
  reason: string;
  failedStage?: PrebuildStage;
  stages: PrebuildStageReceipt[];
}

function isStageReceipt(row: unknown): row is PrebuildStageReceipt {
  if (!row || typeof row !== 'object') return false;
  const value = row as Record<string, unknown>;
  return typeof value.stage === 'string' && (PREBUILD_STAGES as readonly string[]).includes(value.stage)
    && (value.exit === null || Number.isSafeInteger(value.exit)) && typeof value.ok === 'boolean' && typeof value.reason === 'string';
}

/**
 * Runs runCutGateImagePrebuild through its runPrebuild seam with `--rehearsal-probe`: clone·deps·skills·base pull·
 * the cut tree's build.sh (pack) · PWA-out-in-package check · registry reachability. Nothing is pushed and the
 * pending/readiness files live in a private scratch root that is removed afterwards (the real version ledger is untouched).
 */
export function runRealpathProbe(input: { checkout: string; commit: string; version: string; runId: string; pool: string | undefined }): RealpathProbeReceipt {
  if (!input.pool) return { outcome: 'skipped', reason: 'gate pool absent (release.loop.gatePodPool)', stages: [] };
  const root = mkdtempSync(join(tmpdir(), 'release-realpath-probe-'));
  try {
    const prebuild = { root, repo: input.checkout, runId: input.runId, version: input.version, commit: input.commit, pool: input.pool };
    const script = join(import.meta.dir, 'gate-image-pin.ts');
    const result = runCutGateImagePrebuild(prebuild, {
      runPrebuild: () => spawnSync('bun', [script, '--prebuild', '--root', root, '--repo', input.checkout, '--run-id', input.runId,
        '--version', input.version, '--commit', input.commit, '--pool', input.pool!, '--rehearsal-probe'], {
        cwd: input.checkout, encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER,
      }),
      writeReady: () => { throw new Error('rehearsal probe must not publish gate image readiness'); },
    });
    const raw = (result as { receipt?: unknown }).receipt;
    const stages = Array.isArray(raw) ? raw.filter(isStageReceipt) : [];
    const failed = stages.find((row) => !row.ok);
    if (result.outcome === 'failed' || failed) {
      return { outcome: 'failed', reason: result.outcome === 'failed' ? result.reason.trim().slice(-300) : failed!.reason,
        ...(failed ? { failedStage: failed.stage } : {}), stages };
    }
    const complete = PREBUILD_STAGES.every((stage, index) => stages[index]?.stage === stage && stages[index]?.ok === true);
    if (!complete) return { outcome: 'failed', reason: `prebuild probe ended without a full stage receipt (${result.outcome})`, stages };
    return { outcome: 'ok', reason: 'reason' in result ? result.reason : result.outcome, stages };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export function realpathProbeSummary(receipt: RealpathProbeReceipt): string {
  if (receipt.outcome === 'skipped') return `realpath probe skipped: ${receipt.reason}`;
  const stages = receipt.stages.map((row) => `${row.stage}=${row.exit ?? 'null'}`).join(' ');
  return receipt.outcome === 'ok' ? `realpath probe ok · ${stages}`
    : `realpath probe failed at ${receipt.failedStage ?? 'unknown'} · ${stages} · ${receipt.reason}`;
}
