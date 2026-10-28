import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { psProcessStartMs } from '../harness/harness-stop.js';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';

interface GateHostClaim {
  token: string;
  runId: string;
  hosts: string[];
  pid: number;
  pidStartedAt: number | null;
  /** Wall-clock claim time. Claims written before this field existed stay readable (optional on read). */
  reservedAt?: number;
}

export type GateHostReservation =
  | { status: 'free' }
  | { status: 'reserved' | 'unknown'; reason: string; runId?: string; reservedAt?: number };

const hostName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const claimsDir = (root: string) => join(root, 'release', 'gate-host-reservations');

/** The release graph's pinned child state and the self gate CLI's selected universe resolve through this same entry. */
export function gateHostReservationRoot(): string { return effectiveInstanceRoot(); }

function claimAlive(claim: GateHostClaim): 'alive' | 'dead' | 'unknown' {
  try { process.kill(claim.pid, 0); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
  }
  if (claim.pidStartedAt === null) return 'unknown';
  const current = psProcessStartMs(claim.pid);
  if (current === null) return 'unknown';
  return Math.abs(current - claim.pidStartedAt) <= 2_000 ? 'alive' : 'dead';
}

/** A gate owns its host until its node exits. A crashed owner's claim is removed on the next read. */
export function reserveReleaseGateHosts(root: string, runId: string, hosts: readonly string[]): () => void {
  const unique = [...new Set(hosts)];
  if (!runId || unique.some(host => host !== '*' && !hostName.test(host))) throw new Error('invalid release gate reservation');
  if (!unique.length) return () => undefined;
  const dir = claimsDir(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const pidStartedAt = psProcessStartMs(process.pid);
  if (pidStartedAt === null) throw new Error('release gate owner start time unmeasured');
  const claim: GateHostClaim = { token, runId, hosts: unique, pid: process.pid, pidStartedAt, reservedAt: Date.now() };
  const path = join(dir, `${token}.json`);
  const temp = join(dir, `.${token}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(claim) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } finally { if (existsSync(temp)) rmSync(temp); }
  debug.log('release-loop.gate', 'host-reserved', { runId, hosts: unique, pid: process.pid, path });
  return () => {
    try {
      const current = JSON.parse(readFileSync(path, 'utf8')) as Partial<GateHostClaim>;
      if (current.token === token) rmSync(path);
      debug.log('release-loop.gate', 'host-released', { runId, hosts: unique, path });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        debug.log('release-loop.gate', 'host-release-unmeasured', { runId, path, error: String(error) });
    }
  };
}

/** An unreadable claim is a reservation, never permission to enter a gate host. */
export function inspectReleaseGateHost(root: string, host: string): GateHostReservation {
  const dir = claimsDir(root);
  let names: string[];
  try { names = readdirSync(dir).filter(name => name.endsWith('.json')); }
  catch (error) {
    return { status: 'unknown', reason: `reservation directory unreadable: ${String(error)}` };
  }
  for (const name of names) {
    const path = join(dir, name);
    let claim: GateHostClaim;
    try {
      claim = JSON.parse(readFileSync(path, 'utf8')) as GateHostClaim;
      if (!claim || !Array.isArray(claim.hosts) || claim.hosts.length === 0
        || !claim.hosts.every(item => typeof item === 'string' && (item === '*' || hostName.test(item)))
        || !Number.isSafeInteger(claim.pid) || claim.pid <= 0 || typeof claim.token !== 'string'
        || typeof claim.runId !== 'string' || !claim.runId
        || (claim.pidStartedAt !== null && (!Number.isSafeInteger(claim.pidStartedAt)
          || claim.pidStartedAt <= 0 || claim.pidStartedAt > Date.now()))
        || (claim.reservedAt !== undefined && (!Number.isSafeInteger(claim.reservedAt)
          || claim.reservedAt <= 0 || claim.reservedAt > Date.now()))) throw new Error('invalid claim');
    } catch (error) { return { status: 'unknown', reason: `reservation unreadable: ${name}: ${String(error)}` }; }
    const live = claimAlive(claim);
    if (live === 'dead') {
      try { rmSync(path); } catch { /* a confirmed dead process cannot still own the host */ }
      debug.log('release-loop.gate', 'host-claim-reclaimed', { runId: claim.runId, hosts: claim.hosts, path });
      continue;
    }
    if (!claim.hosts.includes(host) && !claim.hosts.includes('*')) continue;
    return {
      status: live === 'unknown' ? 'unknown' : 'reserved',
      reason: `release gate ${claim.runId} holds ${host}`,
      runId: claim.runId,
      ...(claim.reservedAt !== undefined ? { reservedAt: claim.reservedAt } : {}),
    };
  }
  return { status: 'free' };
}
