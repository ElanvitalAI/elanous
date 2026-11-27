// WORLD-REGISTRY auto-registration — an elanous tool that creates an actor (a cron line through the schedule CRUD, a launchd
// job through an elanous installer) declares it on the lease ledger in the same breath, so the guardian's next sweep finds
// it registered instead of «unregistered». Fail-open: registration never fails the tool that created the actor.
import { hostname } from 'node:os';
import { debug } from '../debug/log.js';
import { recordWorldEvents } from './resource-ledger.js';
import type { WorldActorFields } from './world-ledger-events.js';

/** This machine's host key as the sweep names it (host-registry alias → key), else the short hostname. */
export function localWorldHost(): string {
  try {
    const { readHostLedger } = require('../nexus/host-registry/store.js') as typeof import('../nexus/host-registry/store.js');
    const { localHostKey } = require('./world-discover.js') as typeof import('./world-discover.js');
    const hosts = Object.values(readHostLedger()?.hosts ?? {}).map(h => ({ host: h.host, aliases: h.aliases, lastHeartbeatMs: h.lastHeartbeatMs }));
    return localHostKey(hosts);
  } catch { return hostname().split('.')[0]!; }
}

/** The owner an elanous tool records: the calling seat (ELANOUS_TRACK) — none is honest (the ledger flags no-owner). */
export function callingSeat(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const s = env.ELANOUS_TRACK?.trim();
  return s ? s.toUpperCase() : null;
}

/** Declare one actor as registered (owner mode). Returns true when the line was written. */
export function registerWorldActorQuietly(decl: Omit<WorldActorFields, 'mode' | 'registered'>, by: string, opts: { path?: string; now?: Date } = {}): boolean {
  try {
    recordWorldEvents([{ event: 'world-actor', at: (opts.now ?? new Date()).toISOString(), by, actor: { ...decl, mode: 'owner', registered: true } }], opts.path);
    debug.log('world-registry', 'auto-registered', { id: decl.id, kind: decl.kind, by });
    return true;
  } catch (e) {
    debug.log('world-registry', 'auto-register-failed', { id: decl.id, error: e instanceof Error ? e.message : String(e) }, { level: 'warn' });
    return false;
  }
}

/** A cron line the schedule CRUD just created (id = the schedule registry's content hash, same as the sweep's). */
export function registerCronQuietly(input: { scheduleId: string; cron: string; name: string; command: string }, opts: { path?: string; now?: Date; host?: string; env?: Readonly<Record<string, string | undefined>> } = {}): boolean {
  const owner = callingSeat(opts.env);
  return registerWorldActorQuietly({ id: `cron:${input.scheduleId}@${opts.host ?? localWorldHost()}`, kind: 'cron', host: opts.host ?? localWorldHost(),
    purpose: input.name, wake: input.cron, ...(owner ? { owner } : {}) }, owner ?? 'elanous-schedule', opts);
}

/** A launchd job an elanous installer just bootstrapped. */
export function registerLaunchdQuietly(input: { label: string; plist: string; purpose: string; owner: string; wake?: string }, opts: { path?: string; now?: Date; host?: string } = {}): boolean {
  const host = opts.host ?? localWorldHost();
  return registerWorldActorQuietly({ id: `launchd:${input.label}@${host}`, kind: 'launchd', host, purpose: input.purpose, owner: input.owner,
    wake: input.wake ?? 'always (resident)', meta: { plist: input.plist } }, 'elanous-install', opts);
}
