/** Production STOP-AUTOHEAL actions. A missing prerequisite is a failed action, never a healed run. */
import { spawnSync } from 'node:child_process';
import { SPAWN_SYNC_MAX_BUFFER } from '../util/spawn-sync-output.js';
import { runHostRegate, type HostRegateInput, type HostRegateResult } from './host-regate.js';
import type { AutohealActions, AutohealContext } from './stop-autoheal.js';

type PrHead = { headRefOid?: string; state?: string; isDraft?: boolean };
export interface OperationalAutohealDeps {
  repoRoot: string;
  readPr?: (number: number, repoRoot: string) => PrHead | null;
  regate?: (input: HostRegateInput) => Promise<HostRegateResult>;
}

function prFromEvidence(ctx: AutohealContext): number | null {
  const match = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/([1-9]\d*)\/?$/.exec(ctx.record.evidenceRef);
  return match ? Number(match[1]) : null;
}

function readPr(number: number, repoRoot: string): PrHead | null {
  const result = spawnSync('gh', ['pr', 'view', String(number), '--json', 'headRefOid,state,isDraft'], {
    cwd: repoRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER,
  });
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout) as PrHead; } catch { return null; }
}

/** Re-gate an existing PR in a clean checkout against current main; never merge from the healer. */
export function operationalAutohealActions(deps: OperationalAutohealDeps): AutohealActions {
  return {
    'clean-workspace-regate': async (ctx) => {
      const number = prFromEvidence(ctx);
      if (!number) return { ok: false, detail: 'PR URL absent from stop evidence' };
      const pr = (deps.readPr ?? readPr)(number, deps.repoRoot);
      if (!pr?.headRefOid || pr.state !== 'OPEN' || typeof pr.isDraft !== 'boolean')
        return { ok: false, detail: `PR #${number} is not an open PR with a measured head and draft state` };
      const result = await (deps.regate ?? runHostRegate)({
        prNumber: number, headCommit: pr.headRefOid, repoRoot: deps.repoRoot, verifyOnly: true,
        ...(pr.isDraft ? { allowDraft: true } : {}),
      });
      return { ok: result.passed, detail: `PR #${number} head ${pr.headRefOid} clean regate ${result.status ?? (result.passed ? 'passed' : 'failed')}${result.failures.length ? `: ${result.failures.map((failure) => failure.step).join(',')}` : ''}` };
    },
  };
}
