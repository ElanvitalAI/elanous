// RESOURCE-OPT-STEWARD — live wiring: SeatAssign through the CLI (`eln seat assign … --json` · #40072), routine requests
// as one ledger mail each. Kept out of steward.ts so the steward stays pure (fixtures decide it).
import { vetoOwner } from '../org/land-authority.js';
import type { OrgDeps } from '../org/org-map.js';
import { execFile } from 'node:child_process';
import type { MatchingRow } from './matching-table.js';
import { STEWARD_UNAVAILABLE, type StewardAssignResult, type StewardDeps } from './steward.js';

type AssignRow = Extract<MatchingRow, { kind: 'assign' }>;

/** Parse `eln seat assign --json` output. Anything that is not its JSON (unknown command, crash) = unavailable. */
export function parseSeatAssignOutput(stdout: string, exitCode: number | null): StewardAssignResult {
  const line = stdout.trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
  if (line) {
    try {
      const parsed = JSON.parse(line) as { ok?: unknown; code?: unknown; reason?: unknown };
      if (parsed.ok === true) return { ok: true };
      if (parsed.ok === false) return { ok: false, ...(typeof parsed.code === 'string' ? { code: parsed.code } : {}), reason: typeof parsed.reason === 'string' ? parsed.reason : 'refused' };
    } catch { /* not the result line */ }
  }
  return { ok: false, code: STEWARD_UNAVAILABLE, reason: `seat assign gave no result (exit ${exitCode ?? 'signal'})` };
}

export function liveStewardAssign(actor = 'OP'): (row: AssignRow, version?: string) => Promise<StewardAssignResult> {
  return async (row, version) => {
    const { elanousInvocation } = await import('../instance/spawn-elanous.js');
    const inv = elanousInvocation(['seat', 'assign', row.seat, row.cell, '--from', actor, '--json', ...(version ? ['--version', version] : []),
      '--why', `[steward ${row.id}] ${row.priority} ${row.why} · idle ${row.idleMin ?? '?'}m`]);
    return new Promise((resolve) => {
      execFile(inv.command, [...inv.args], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: inv.env }, (error, stdout) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? null : 0;
        resolve(parseSeatAssignOutput(String(stdout ?? ''), code));
      });
    });
  };
}

/** Routine requests as ledger mail (judge requests → the org map's veto owner · JUD-SPLIT-FU-CONSUMERS) from the HQ seat (one per PR head / judge cell — the steward dedupes). */
export function liveStewardRequests(post: (mail: { from: string; to: string; kind: string; intent: 'request'; body: string; refs: string[] }) => unknown, actor = 'OP', orgDeps: OrgDeps = {}):
  Pick<StewardDeps, 'requestPregate' | 'requestJudge'> {
  return {
    requestPregate: (row) => {
      if (row.seat === 'UNKNOWN') return false;
      post({ from: actor, to: row.seat, kind: 'request', intent: 'request', refs: [`pr:${row.pr}`, 'steward:pregate'],
        body: `[steward] pregate #${row.pr} on its current head ${row.head} (light) — no same-head receipt yet` });
      return true;
    },
    requestJudge: (row) => {
      post({ from: actor, to: vetoOwner(orgDeps), kind: 'request', intent: 'request', refs: [`cell:${row.cell}`, ...(row.pr ? [`pr:${row.pr}`] : []), 'steward:judge'],
        body: `[steward] judge ${row.cell}${row.pr ? ` #${row.pr}` : ''} — waiting ${row.ageMin}m in the judge queue` });
      return true;
    },
  };
}
