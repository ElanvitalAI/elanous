#!/usr/bin/env bun
// HQ-REP direction — which way does this host replicate? (OP 10-04 10:09 · «되돌리기 방향»)
// The lease holder is the source and the other host is the standby: once node-b holds the lease, node-b → mbp.
//   · a lease record exists, or the arbiter cannot be read → `fenced`: the caller runs the copy under
//     `elanous hq fence --role cron`, which alone decides (holder · generation · arbiter-down rules, src/hq/lease.ts).
//   · no lease record yet (before HQ-HB acquires one) → `direct` on the default source host only, `skip` elsewhere,
//     so the mbp → node-b copy keeps running until the first lease exists (OP 10:12 bootstrap rule).
//   · TC 10:12: a host that has ever seen a lease generation treats a missing record as «unknown» and skips — otherwise
//     a lost arbiter file after the drill would turn mbp back into the source while node-b is HQ (split-brain).
//     «Seen» = `~/.elanous-hq/seen-generation` (HQ-HB writes it) or a generation in the local lease state (hq/local.json).
// Usage: bun scripts/hq/standby-role.ts --default-source <host> [--config-dir <dir>] [--me <host>] [--json]   → prints `direct` | `fenced` | `skip`
import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { getElanousConfigDir, setElanousConfigDir } from '../../src/elanous-config-dir.js';
import { hqLease, readLocal } from '../../src/hq/hq.js';
import { getUserConfig } from '../../src/user-config.js';
import type { LeaseRecord } from '../../src/hq/lease.js';

export type ReplicationRole = 'direct' | 'fenced' | 'skip';
export interface RoleDecision { role: ReplicationRole; reason: 'lease-exists' | 'lease-unreadable' | 'no-lease-default-source' | 'no-lease-not-default' | 'no-lease-after-seen'; holder?: string }

/** `defaultSource` may list aliases (`MacBookProM5,mbp`) — the lease name is `hq.hostName` when set, else the OS host name. */
export function decideReplicationRole(input: { me: string; defaultSource: string; record: LeaseRecord | null | 'unreadable'; seenGeneration?: boolean }): RoleDecision {
  const { me, defaultSource, record } = input;
  if (record === 'unreadable') return { role: 'fenced', reason: 'lease-unreadable' };
  if (record) return { role: 'fenced', reason: 'lease-exists', holder: record.holder };
  if (input.seenGeneration) return { role: 'skip', reason: 'no-lease-after-seen' };
  const aliases = defaultSource.split(',').map(s => s.trim()).filter(Boolean);
  return aliases.includes(me) ? { role: 'direct', reason: 'no-lease-default-source' } : { role: 'skip', reason: 'no-lease-not-default' };
}

/** Has this host ever seen a lease generation? (TC 10:12 · see the header.) */
export function hasSeenGeneration(home: string = homedir(), localPath: string = join(getElanousConfigDir(), 'hq', 'local.json')): boolean {
  if (existsSync(join(home, '.elanous-hq', 'seen-generation'))) return true;
  return typeof readLocal(localPath).generation === 'number';
}

/** Same host name the lease uses (src/hq/hq.ts resolve): `hq.hostName`, else the OS host name without `.local`. */
export function leaseHostName(configured: string | undefined = getUserConfig().hq?.hostName, raw: string = hostname()): string {
  return configured ?? raw.replace(/\.local$/, '');
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const defaultSource = arg('--default-source');
  if (!defaultSource) { console.error('standby-role: --default-source <host> required'); process.exit(2); }
  // Same lease name and local state as HQ-HB: the config dir moves only by this setter (an env var is ignored).
  const configDir = arg('--config-dir');
  if (configDir) setElanousConfigDir(configDir);
  const me = arg('--me') ?? leaseHostName();
  let record: LeaseRecord | null | 'unreadable';
  try { record = hqLease('status').record; } catch { record = 'unreadable'; }
  const decided = decideReplicationRole({ me, defaultSource, record, seenGeneration: hasSeenGeneration() });
  debug.log('hq.standby', 'role', { me, defaultSource, ...decided });
  console.log(argv.includes('--json') ? JSON.stringify({ me, defaultSource, ...decided }) : decided.role);
}
