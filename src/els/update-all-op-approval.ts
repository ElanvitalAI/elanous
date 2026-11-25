// ELS-UPDATE-ALL-BY-OP (대표 11-25 11:4x «제 개입 없이 해주세요»): the OP install→migrate step of `els update-all`.
// A one-time standing-approval record lets OP (or a rail script) migrate seats without a terminal once the target build
// is the published desiredSha and is already installed on this host. Without that record the terminal HITL stays the
// default, a non-TTY run fails fast with a clear reason, and an install failure always carries its reason.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface StandingApproval {
  readonly grantedBy: 'CEO';
  readonly grantedAt: string;
  readonly note?: string;
}

export const NEEDS_APPROVAL_MESSAGE = 'needs approval: run once in a terminal or grant standing approval (els update-all --grant-standing)';

export function standingApprovalPath(stateRoot: string): string {
  return join(stateRoot, 'els', 'update-all-standing-approval.json');
}

/** A record counts only when it names the CEO and carries a parseable grant time; anything else is no approval. */
export function readStandingApproval(path: string): StandingApproval | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { grantedBy?: unknown; grantedAt?: unknown; note?: unknown };
    if (raw.grantedBy !== 'CEO' || typeof raw.grantedAt !== 'string' || !Number.isFinite(Date.parse(raw.grantedAt))) return null;
    return { grantedBy: 'CEO', grantedAt: raw.grantedAt, ...(typeof raw.note === 'string' ? { note: raw.note } : {}) };
  } catch { return null; }
}

export function writeStandingApproval(path: string, record: StandingApproval): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function revokeStandingApproval(path: string): void { rmSync(path, { force: true }); }

export interface CatchUpOutcome { readonly exitCode: number; readonly reason?: string }

export interface OpPrepareDeps {
  readonly target: string | undefined;
  readonly installedCommit: () => string;
  readonly desired: () => string | undefined;
  readonly standing: () => StandingApproval | null;
  readonly interactive: boolean;
  /** Terminal HITL with the update preview; true = approved. */
  readonly askTerminal: () => Promise<boolean>;
  readonly runCatchUp: (approveOp: () => Promise<boolean>, out: { log: (line: string) => void; error: (line: string) => void }) => Promise<CatchUpOutcome>;
  readonly log: (event: string, data: Record<string, unknown>) => void;
  readonly stderr: (line: string) => void;
}

export type OpInstallStatus = 'already up to date (skipped)' | 'updated';

const same = (a: string | undefined, b: string): boolean => (a ?? '').toLowerCase() === b.toLowerCase();

export async function prepareOpUpdate(deps: OpPrepareDeps): Promise<OpInstallStatus> {
  const target = deps.target;
  if (!target || !/^[a-f0-9]{40}$/i.test(target)) throw new Error('Target build unavailable');
  const standingFor = (): StandingApproval | null => {
    const record = deps.standing();
    return record && same(deps.desired(), target) && same(deps.installedCommit(), target) ? record : null;
  };
  const wasCurrent = same(deps.installedCommit(), target);
  if (!deps.interactive && !standingFor()) {
    const reason = deps.standing() && !wasCurrent
      ? `${NEEDS_APPROVAL_MESSAGE}; standing approval covers migration only after ${target.slice(0, 12)} is installed on this host`
      : NEEDS_APPROVAL_MESSAGE;
    deps.log('els.update-all failed', { reason, target });
    throw new Error(reason);
  }
  let approved = false;
  const confirm = async (): Promise<boolean> => {
    const record = standingFor();
    if (record) {
      deps.log('els.update-all approved-by-standing', { grantedBy: record.grantedBy, grantedAt: record.grantedAt, target });
      deps.stderr(`els update-all: approved by standing approval (granted by ${record.grantedBy} at ${record.grantedAt})`);
      approved = true;
      return true;
    }
    if (!deps.interactive) throw new Error(NEEDS_APPROVAL_MESSAGE);
    approved = await deps.askTerminal();
    return approved;
  };
  const lines: string[] = [];
  const installed = await deps.runCatchUp(confirm, {
    log: line => { lines.push(line); },
    error: line => { lines.push(line); deps.stderr(`els update-all: ${line}`); },
  });
  if (installed.exitCode !== 0) {
    const reason = (installed.reason ?? lines.at(-1) ?? 'no reason reported').replace(/^self-update --catch-up(?: failed)?: /, '');
    deps.log('els.update-all failed', { reason, target, exitCode: installed.exitCode });
    throw new Error(`Installation update failed: ${reason}`);
  }
  if (!approved && !(await confirm())) throw new Error('Migration cancelled');
  if (!same(deps.desired(), target)) throw new Error('Target build changed; no migration requested');
  return wasCurrent ? 'already up to date (skipped)' : 'updated';
}
