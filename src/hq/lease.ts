// HQ lease (본부 임대) — single writer across mbp · node-b · cloud-vm with a 2-of-3 quorum (OP 10-04 08:33 · 08:40).
// The arbiter (cloud-vm) keeps one record; promotion requires an explicit opt-in and consecutive
// checks in which neither the arbiter nor the standby can reach the holder. Fenced work carries the generation.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

export const DEFAULT_TTL_SECONDS = 1500;
/** A standby view older than this is not evidence (two heartbeats at the 10-minute cadence). */
export const VIEW_FRESH_SECONDS = 1500;
/** Consecutive dual-unreachable checks before the arbiter promotes the standby. */
export const PROMOTE_AFTER_CHECKS = 2;

export interface HostView { target: string; reachable: boolean; at: number }
export interface LeaseRecord {
  holder: string;
  generation: number;
  acquiredAt: number;
  renewedAt: number;
  ttlSeconds: number;
  /** Each observer's latest view of the holder (arbiter and standby). */
  views?: Record<string, HostView>;
  /** Consecutive arbiter checks in which both arbiter and standby could not reach the holder. */
  dualUnreachableStreak?: number;
  lastCheckAt?: number;
  promotedFrom?: string;
}

export function parseLease(raw: string | null): LeaseRecord | null {
  if (!raw || !raw.trim()) return null;
  const data = JSON.parse(raw) as LeaseRecord;
  if (typeof data.holder !== 'string' || !Number.isSafeInteger(data.generation) || typeof data.renewedAt !== 'number') throw new Error('invalid lease record');
  return data;
}
export const serializeLease = (record: LeaseRecord): string => `${JSON.stringify(record)}\n`;
export const leaseExpired = (record: LeaseRecord, now: number): boolean => record.renewedAt + record.ttlSeconds < now;

/** Host-local, short-lived shell fence snapshot; never the arbiter's CAS lease ledger. */
export interface LocalLeaseCache { holder: string; generation: number; expiresAt: number; host: string; machine: string; confirmedAt: number }
export const LOCAL_LEASE_CACHE_SECONDS = 660; // heartbeat cadence 600s + 60s scheduling slack; still below the 1500s lease TTL
/** A single whitespace-delimited line so /bin/sh can read it without bun or JSON tools. */
export function serializeLocalLeaseCache(cache: LocalLeaseCache): string {
  if (![cache.holder, cache.host, cache.machine].every(value => /^[A-Za-z0-9_.-]+$/.test(value))
    || !Number.isSafeInteger(cache.generation) || cache.generation < 1
    || !Number.isSafeInteger(cache.expiresAt) || cache.expiresAt < 1
    || !Number.isSafeInteger(cache.confirmedAt) || cache.confirmedAt < 1
    || cache.expiresAt <= cache.confirmedAt || cache.expiresAt - cache.confirmedAt > LOCAL_LEASE_CACHE_SECONDS) throw new Error('invalid local lease cache');
  return `${cache.holder} ${cache.generation} ${cache.expiresAt} ${cache.host} ${cache.machine} ${cache.confirmedAt}\n`;
}

/** acquire: only when there is no lease or it has expired; a new holder gets the next generation. */
export function decideAcquire(record: LeaseRecord | null, me: string, now: number, ttlSeconds = DEFAULT_TTL_SECONDS):
  { ok: true; next: LeaseRecord } | { ok: false; reason: string } {
  if (record && record.renewedAt !== 0 && record.holder === me && !leaseExpired(record, now)) return { ok: true, next: { ...record, renewedAt: now, ttlSeconds } };
  if (record && record.renewedAt !== 0 && !leaseExpired(record, now)) return { ok: false, reason: `held by ${record.holder} (generation ${record.generation})` };
  return { ok: true, next: { holder: me, generation: (record?.generation ?? 0) + 1, acquiredAt: now, renewedAt: now, ttlSeconds, views: {}, dualUnreachableStreak: 0 } };
}

export function decideRenew(record: LeaseRecord | null, me: string, generation: number | undefined, now: number):
  { ok: true; next: LeaseRecord } | { ok: false; reason: string } {
  if (!record) return { ok: false, reason: 'no lease' };
  if (record.holder !== me) return { ok: false, reason: `held by ${record.holder} (generation ${record.generation})` };
  if (generation !== undefined && generation < record.generation) return { ok: false, reason: `stale generation ${generation} < ${record.generation}` };
  return { ok: true, next: { ...record, renewedAt: now, dualUnreachableStreak: 0 } };
}

export function decideRelease(record: LeaseRecord | null, me: string, expected?: { holder: string; generation: number }): { ok: true; next: LeaseRecord } | { ok: false; reason: string } {
  if (!record || record.holder !== me) return { ok: false, reason: record ? `held by ${record.holder}` : 'no lease' };
  if (expected && (record.holder !== expected.holder || record.generation !== expected.generation))
    return { ok: false, reason: `lease changed: expected ${expected.holder} generation ${expected.generation}, observed ${record.holder} generation ${record.generation}` };
  return { ok: true, next: { ...record, renewedAt: 0 } };
}

/** The standby reports whether it can reach the holder (rule ②: both views go into the record). */
export function recordView(record: LeaseRecord, observer: string, reachable: boolean, now: number): LeaseRecord {
  return { ...record, views: { ...(record.views ?? {}), [observer]: { target: record.holder, reachable, at: now } } };
}

/**
 * Arbiter check (rule ②). Records the arbiter's own view; counts a dual-unreachable check only when the standby's
 * fresh view of the same holder also says unreachable; promotion is optional and its threshold is configurable.
 */
export function decideArbiterCheck(record: LeaseRecord, input: { arbiter: string; standby: string; arbiterReachesHolder: boolean; now: number; promote?: boolean; promoteAfterChecks?: number }):
  { next: LeaseRecord; promoted: boolean; streak: number } {
  let next = recordView(record, input.arbiter, input.arbiterReachesHolder, input.now);
  const view = next.views?.[input.standby];
  const standbyDown = !!view && view.target === record.holder && !view.reachable && input.now - view.at <= VIEW_FRESH_SECONDS;
  const dual = !input.arbiterReachesHolder && standbyDown && record.holder !== input.standby;
  const streak = dual ? (record.dualUnreachableStreak ?? 0) + 1 : 0;
  next = { ...next, dualUnreachableStreak: streak, lastCheckAt: input.now };
  if (input.promote === false || streak < (input.promoteAfterChecks ?? PROMOTE_AFTER_CHECKS)) return { next, promoted: false, streak };
  return {
    next: { holder: input.standby, generation: record.generation + 1, acquiredAt: input.now, renewedAt: input.now, ttlSeconds: record.ttlSeconds, views: {}, dualUnreachableStreak: 0, lastCheckAt: input.now, promotedFrom: record.holder },
    promoted: true, streak,
  };
}

/** What this host remembers between runs: its last confirmed generation and when quorum last confirmed it. */
export interface LocalHqState { holder?: string; generation?: number; confirmedAt?: number; ttlSeconds?: number }

export type FenceReason = 'holder' | 'quorum-standby' | 'within-ttl' | 'not-holder' | 'stale-generation' | 'no-quorum-expired' | 'no-lease' | 'no-lease-after-seen' | 'fail-open';
/**
 * Fence (rules ① · ③). Arbiter reachable → run only as the current holder at the current generation.
 * Arbiter unreachable → the holder keeps running while it reaches the standby or its own confirmation is within TTL;
 * a standby that reports a higher generation always blocks (a returning old HQ stays standby).
 */
export function decideFence(input: {
  me: string; now: number; local: LocalHqState;
  record: LeaseRecord | null | 'unreachable';
  standbyReachable?: boolean; standbyGeneration?: number; failOpen?: boolean;
  /** Highest generation this host ever saw — a vanished record after that is «unknown», not «no lease yet». */
  seenGeneration?: number;
}): { run: boolean; reason: FenceReason; generation?: number; holder?: string } {
  const { me, now, local, record } = input;
  if (record !== 'unreachable') {
    if (!record) return { run: false, reason: input.seenGeneration !== undefined ? 'no-lease-after-seen' : 'no-lease', ...(input.seenGeneration !== undefined ? { generation: input.seenGeneration } : {}) };
    if (record.holder !== me) return { run: false, reason: 'not-holder', holder: record.holder, generation: record.generation };
    if (local.generation !== undefined && local.generation > record.generation) return { run: false, reason: 'stale-generation', holder: record.holder, generation: record.generation };
    return { run: true, reason: 'holder', generation: record.generation, holder: me };
  }
  if (local.holder !== me || local.generation === undefined) return { run: false, reason: 'not-holder', holder: local.holder, generation: local.generation };
  if (input.standbyGeneration !== undefined && input.standbyGeneration > local.generation) return { run: false, reason: 'stale-generation', generation: input.standbyGeneration };
  if (input.standbyReachable) return { run: true, reason: 'quorum-standby', generation: local.generation, holder: me };
  const ttl = local.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (local.confirmedAt !== undefined && now - local.confirmedAt <= ttl) return { run: true, reason: 'within-ttl', generation: local.generation, holder: me };
  if (input.failOpen) return { run: true, reason: 'fail-open', generation: local.generation, holder: me };
  return { run: false, reason: 'no-quorum-expired', generation: local.generation, holder: me };
}

// ── stores ────────────────────────────────────────────────────────────────────
export interface LeaseStore {
  /** null raw = no record · throws when the store cannot be reached. */
  read(): { now: number; raw: string | null };
  /** Compare-and-swap on the raw bytes; false when someone else wrote first. */
  cas(expected: string | null, next: string): boolean;
}
export const sha = (raw: string | null): string => raw === null ? 'none' : createHash('sha256').update(raw).digest('hex');

/** Arbiter-local store (the arbiter's own check runs next to the file). mkdir is the lock. */
export function fileLeaseStore(path: string, clock: () => number = () => Math.floor(Date.now() / 1000)): LeaseStore {
  const lock = `${path}.lock`;
  return {
    read: () => ({ now: clock(), raw: existsSync(path) ? readFileSync(path, 'utf8') : null }),
    cas(expected, next) {
      mkdirSync(dirname(path), { recursive: true });
      for (let i = 0; ; i++) {
        try { mkdirSync(lock); break; } catch {
          try { if (Date.now() - statSync(lock).mtimeMs > 30_000) { rmdirSync(lock); continue; } } catch { /* raced */ }
          if (i > 100) throw new Error('lease lock busy');
          Bun.sleepSync(50);
        }
      }
      try {
        const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
        if (sha(current) !== sha(expected)) return false;
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, next, { mode: 0o600 });
        renameSync(tmp, path);
        return true;
      } finally { try { rmdirSync(lock); } catch { /* already gone */ } }
    },
  };
}

export type SshRunner = (host: string, script: string, input?: string) => { status: number | null; stdout: string; stderr: string };
export const defaultSshRunner: SshRunner = (host, script, input) => {
  // ssh joins its arguments into one remote shell line — hand bash a single-quoted script.
  const quoted = `'${script.replaceAll("'", "'\\''")}'`;
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, `bash -c ${quoted}`],
    { input: input ?? '', encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** The arbiter itself (cloud-vm) runs the same lease script locally — `hq.arbiter: "local"` (drill 10-04: gcp has no ssh to itself). */
export const localShellRunner: SshRunner = (_host, script, input) => {
  const r = spawnSync('bash', ['-c', script], { input: input ?? '', encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

const REMOTE_DIR = '$HOME/.elanous-hq';
/** Remote store over ssh: the remote side only compares a sha and renames under a mkdir lock — all decisions stay here. */
export function sshLeaseStore(host: string, run: SshRunner = defaultSshRunner): LeaseStore {
  return {
    read() {
      const r = run(host, `date +%s && echo ---- && { cat ${REMOTE_DIR}/lease.json 2>/dev/null || true; }`);
      if (r.status !== 0) throw new Error(`arbiter ${host} unreachable: ${r.stderr.trim().split('\n')[0] ?? r.status}`);
      const [head, ...rest] = r.stdout.split('----\n');
      const now = Number.parseInt((head ?? '').trim(), 10);
      if (!Number.isFinite(now)) throw new Error(`arbiter ${host} gave no clock`);
      const raw = rest.join('----\n');
      return { now, raw: raw.length ? raw : null };
    },
    cas(expected, next) {
      const script = [
        `set -e; d=${REMOTE_DIR}; f=$d/lease.json; mkdir -p "$d"`,
        'i=0; until mkdir "$d/lock" 2>/dev/null; do i=$((i+1)); [ $i -gt 100 ] && { echo BUSY; exit 3; }; sleep 0.05; done',
        'trap \'rmdir "$d/lock" 2>/dev/null || true\' EXIT',
        'if [ -f "$f" ]; then cur=$( (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | cut -d" " -f1); else cur=none; fi',
        `[ "$cur" = "${sha(expected)}" ] || { echo CONFLICT; exit 0; }`,
        'cat > "$f.tmp.$$"; chmod 600 "$f.tmp.$$"; mv "$f.tmp.$$" "$f"; echo OK',
      ].join('\n');
      const r = run(host, script, next);
      if (r.status !== 0) throw new Error(`arbiter ${host} write failed: ${r.stdout.trim() || r.stderr.trim().split('\n')[0]}`);
      return r.stdout.trim().endsWith('OK');
    },
  };
}

/** Home-to-home reachability (ssh true) — used only by the holder to reach the standby, never by the arbiter. */
export const sshReachable = (host: string, run: SshRunner = defaultSshRunner): boolean => {
  try { return run(host, 'true').status === 0; } catch { return false; }
};

/**
 * Tailnet probe (OP 10-04 09:04): liveness = `tailscale ping`, application = nexus health over the tailnet.
 * One «unreachable» observation needs BOTH to fail. No ssh — the arbiter holds no shell on home machines.
 */
export interface HostProbe { ping(host: string): boolean; health(host: string): boolean }
export function probeReachable(host: string, probe: HostProbe): { reachable: boolean; ping: boolean; health: boolean } {
  let ping = false; let health = false;
  try { ping = probe.ping(host); } catch { ping = false; }
  try { health = probe.health(host); } catch { health = false; }
  return { reachable: ping || health, ping, health };
}
