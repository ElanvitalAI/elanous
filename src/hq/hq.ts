// HQ lease operations — CLI-facing glue over the pure decisions in ./lease.ts (HQ-HB · HQ-FENCE · 10-04).
// Every outcome leaves one observation line (hq.lease / hq.fence) so the 12:00 drill is measurable from logs.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Command } from 'commander';
import { writeStdoutJson } from '../cli/stdout-json.js';
import { debug } from '../debug/log.js';
import { DEFAULT_NEXUS_HTTP_PORT } from '../nexus/default-port.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { getUserConfig, type HqConfig, type HqFenceRole } from '../user-config.js';
import { promoteHq, proposeHqPromotion, writeOpSeatRequest } from './promote.js';
import type { HqOpRequestWriter, PromoteResult } from './promote.js';
import {
  DEFAULT_TTL_SECONDS, decideAcquire, decideArbiterCheck, decideFence, decideRelease, decideRenew, defaultSshRunner,
  fileLeaseStore, leaseExpired, parseLease, probeReachable, recordView, serializeLease, sshLeaseStore, sshReachable, localShellRunner,
  type HostProbe, type LeaseRecord, type LeaseStore, type LocalHqState, type SshRunner,
} from './lease.js';

export const FENCE_ROLES: readonly HqFenceRole[] = ['telegram-poller', 'cron', 'seat-loop', 'release-run', 'conatus', 'git-push', 'ledger-cli'];

/** Register only the read-only move inventory; keep it outside lease/fence mutation flows. */
export function registerHqMovePlanCommand(hqCmd: Command): void {
  hqCmd.command('move-plan').description('현재 호스트의 작업·launchd 및 대상 호스트 파일을 조회(읽기 전용)')
    .requiredOption('--to <host>', '이동 대상 호스트')
    .option('--json', 'JSON 출력')
    .action(async (opts: { to: string; json?: boolean }) => {
      try {
        const { hqMovePlan, formatMovePlan } = await import('./move-plan.js');
        const result = hqMovePlan(opts.to);
        if (opts.json) await writeStdoutJson(`${JSON.stringify(result)}\n`);
        else console.log(formatMovePlan(result));
      } catch (error) { console.error(`hq move-plan: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
    });
}

export interface HqDeps {
  config?: HqConfig;
  store?: LeaseStore;
  ssh?: SshRunner;
  /** Holder/standby views and the arbiter's check use this tailnet probe — never ssh (OP 10-04 09:04). */
  probe?: HostProbe;
  localPath?: string;
  /** Host-local identity, deliberately outside the replicated config/state directory. */
  hostPath?: string;
  /** Seen-generation marker (default hq.seenGenerationFile · ~/.elanous-hq/seen-generation). */
  seenPath?: string;
  now?: () => number;
  log?: typeof debug.log;
  /** Injection points for the OP seat request and the promotion runbook; production uses durable defaults. */
  opRequest?: HqOpRequestWriter;
  promote?: (host: string, apply: boolean) => PromoteResult;
}

interface Resolved { me: string; arbiter: string; standby: string; ttl: number; failOpen: Set<HqFenceRole>; store: LeaseStore; ssh: SshRunner; probe: HostProbe; localPath: string; seenPath: string; now: () => number; log: typeof debug.log }
const defaultHostPath = () => join(homedir(), '.elanous-hq', 'host');

function readHost(path: string): string | undefined {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const text = readFileSync(path, 'utf8');
  const name = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (!name || name !== name.trim() || /[\r\n]/.test(name)) {
    throw new Error(`hq host: invalid host file: ${path}`);
  }
  return name;
}

/** Set this machine's identity outside the replicable config.json and HQ state universe. */
export function hqHostSet(name: string, path = defaultHostPath()): string {
  if (!name || name !== name.trim() || /[\r\n]/.test(name)) throw new Error('hq host set: name must be one nonempty line without surrounding whitespace');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempDir = mkdtempSync(`${path}.`);
  try {
    chmodSync(tempDir, 0o700);
    const tmp = join(tempDir, 'host');
    writeFileSync(tmp, `${name}\n`, { flag: 'wx', mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  return path;
}

function resolve(deps: HqDeps = {}): Resolved {
  const config = deps.config ?? getUserConfig().hq ?? {};
  const ssh = deps.ssh ?? defaultSshRunner;
  const arbiter = config.arbiter ?? 'cloud-vm';
  const local = readHost(deps.hostPath ?? defaultHostPath());
  const me = local ?? config.hostName ?? hostname().replace(/\.local$/, '');
  const log = deps.log ?? debug.log.bind(debug);
  if (local && config.hostName && local !== config.hostName) {
    try { log('hq.lease', 'hostname-mismatch', { local, config: config.hostName }); } catch { /* observation is fail-soft */ }
  }
  return {
    me,
    arbiter,
    standby: config.standby ?? 'node-b',
    ttl: config.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    failOpen: new Set(config.failOpenRoles ?? []),
    store: deps.store ?? sshLeaseStore(arbiter, arbiter === 'local' ? localShellRunner : ssh),
    ssh,
    probe: deps.probe ?? tailnetProbe(config),
    localPath: deps.localPath ?? join(getElanousConfigDir(), 'hq', 'local.json'),
    seenPath: deps.seenPath ?? config.seenGenerationFile ?? (deps.localPath ? `${deps.localPath}.seen-generation` : join(homedir(), '.elanous-hq', 'seen-generation')),
    now: deps.now ?? (() => Math.floor(Date.now() / 1000)),
    log,
  };
}

/** MagicDNS suffix from `tailscale status --json` (cached per process). */
let dnsSuffix: string | null | undefined;
function magicDnsSuffix(bin: string): string | undefined {
  if (dnsSuffix !== undefined) return dnsSuffix ?? undefined;
  const r = spawnSync(bin, ['status', '--json'], { encoding: 'utf8', timeout: 10_000 });
  try { dnsSuffix = (JSON.parse(r.stdout || '{}') as { MagicDNSSuffix?: string }).MagicDNSSuffix?.replace(/\.$/, '') || null; } catch { dnsSuffix = null; }
  return dnsSuffix ?? undefined;
}

/** Health URL of a remote host's nexus over the tailnet — its `tailscale serve` TLS mapping of the default nexus port
 *  (resolveDaemonEndpoint only knows this machine's daemon; the arbiter probes another host). */
export function healthUrlFor(host: string, config: HqConfig, suffix: () => string | undefined): string | undefined {
  const pinned = config.healthUrls?.[host];
  if (pinned) return pinned;
  const domain = config.tailnetDomain ?? suffix();
  return domain ? `https://${host}.${domain}:${DEFAULT_NEXUS_HTTP_PORT}/v1/health` : undefined;
}

/** Default probe: `tailscale ping -c 1` ⊕ curl of the nexus health (200 only). Both are tailnet-only, no ssh. */
export function tailnetProbe(config: HqConfig): HostProbe {
  const bin = config.tailscaleBin ?? 'tailscale';
  const timeout = config.probeTimeoutSeconds ?? 5;
  return {
    ping(host) {
      const r = spawnSync(bin, ['ping', '-c', '1', '--timeout', `${timeout}s`, host], { encoding: 'utf8', timeout: (timeout + 5) * 1000 });
      return r.status === 0 && /\bpong\b/.test(r.stdout ?? '');
    },
    health(host) {
      const url = healthUrlFor(host, config, () => magicDnsSuffix(bin));
      if (!url) return false;
      const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-m', String(timeout), '-w', '%{http_code}', url], { encoding: 'utf8', timeout: (timeout + 5) * 1000 });
      return (r.stdout ?? '').trim() === '200';
    },
  };
}

export function readLocal(path: string): LocalHqState {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as LocalHqState : {}; } catch { return {}; }
}
function writeLocal(path: string, state: LocalHqState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Highest lease generation this host ever observed (null = never). */
export function readSeenGeneration(path: string): number | null {
  try {
    if (!existsSync(path)) return null;
    const n = Number(readFileSync(path, 'utf8').trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}
/** Keep the max generation seen (atomic · 600). Fail-soft: a lost write never blocks the lease operation. */
function noteSeen(r: Resolved, record: LeaseRecord | null | undefined): void {
  if (!record || !Number.isSafeInteger(record.generation) || record.generation < 1) return;
  try {
    const prev = readSeenGeneration(r.seenPath);
    if (prev !== null && prev >= record.generation) return;
    mkdirSync(dirname(r.seenPath), { recursive: true, mode: 0o700 });
    const tmp = `${r.seenPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${record.generation}\n`, { mode: 0o600 });
    renameSync(tmp, r.seenPath);
  } catch (error) { observe(r, 'hq.lease', 'seen-write-failed', { error: String(error).slice(0, 200) }); }
}

/** `elanous hq seen` — wrappers use «never seen» (exit 3) to allow the pre-drill default-source path only. */
export function hqSeen(deps: HqDeps = {}): { seen: boolean; generation: number | null; path: string } {
  const r = resolve(deps);
  const generation = readSeenGeneration(r.seenPath);
  return { seen: generation !== null, generation, path: r.seenPath };
}

function observe(r: Resolved, category: 'hq.lease' | 'hq.fence', event: string, data: Record<string, unknown>): void {
  try { r.log(category, event, { host: r.me, ...data }); } catch { /* observation is fail-soft */ }
}

/** Read → decide → CAS, retried on a lost race (two hosts racing cannot both win: only one CAS sees the old bytes). */
function mutate(r: Resolved, decide: (record: LeaseRecord | null, now: number) => { ok: true; next: LeaseRecord } | { ok: false; reason: string }):
  { ok: true; record: LeaseRecord } | { ok: false; reason: string; record: LeaseRecord | null } {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { now, raw } = r.store.read();
    const record = parseLease(raw);
    const decided = decide(record, now);
    if (!decided.ok) return { ok: false, reason: decided.reason, record };
    if (r.store.cas(raw, serializeLease(decided.next))) return { ok: true, record: decided.next };
  }
  return { ok: false, reason: 'lost the race five times', record: null };
}

export type LeaseAction = 'acquire' | 'renew' | 'status' | 'release';
export function hqLease(action: LeaseAction, deps: HqDeps = {}, opts: { host?: string; expectedHolder?: string; expectedGeneration?: number } = {}) {
  const r0 = resolve(deps);
  const r = opts.host ? { ...r0, me: opts.host } : r0;
  if (action === 'status') {
    const { now, raw } = r.store.read();
    const record = parseLease(raw);
    noteSeen(r, record);
    return { ok: true as const, action, record, ageSeconds: record ? now - record.renewedAt : null, expired: record ? leaseExpired(record, now) : null };
  }
  if (action === 'release' && ((opts.expectedHolder === undefined) !== (opts.expectedGeneration === undefined)
    || (opts.expectedGeneration !== undefined && (!Number.isSafeInteger(opts.expectedGeneration) || opts.expectedGeneration < 1))
    || (opts.expectedHolder !== undefined && !opts.expectedHolder)))
    throw new Error('hq lease release: expected holder and positive generation must be supplied together');
  const local = readLocal(r.localPath);
  const expected = opts.expectedHolder !== undefined && opts.expectedGeneration !== undefined
    ? { holder: opts.expectedHolder, generation: opts.expectedGeneration } : undefined;
  const result = mutate(r, (record, now) => action === 'acquire' ? decideAcquire(record, r.me, now, r.ttl)
    : action === 'renew' ? decideRenew(record, r.me, local.generation, now) : decideRelease(record, r.me, expected));
  noteSeen(r, result.record);
  if (result.ok && action !== 'release') writeLocal(r.localPath, { holder: result.record.holder, generation: result.record.generation, confirmedAt: r.now(), ttlSeconds: result.record.ttlSeconds });
  if (result.ok && action === 'release') writeLocal(r.localPath, { ...local, holder: undefined, confirmedAt: undefined });
  observe(r, 'hq.lease', result.ok ? (action === 'acquire' ? 'acquired' : action === 'renew' ? 'renewed' : 'released') : `${action}-refused`,
    result.ok ? { generation: result.record.generation } : { reason: result.reason });
  return { action, ...result };
}

/**
 * Heartbeat (every 10 min on mbp and node-b). Holder → renew at the arbiter, or (arbiter down) confirm quorum through the standby.
 * Non-holder → report its view of the holder to the arbiter (rule ②) and adopt a generation the arbiter granted it.
 */
export function hqHeartbeat(deps: HqDeps = {}) {
  const r = resolve(deps);
  const local = readLocal(r.localPath);
  let read: { now: number; raw: string | null };
  try { read = r.store.read(); } catch (error) {
    const standbyUp = local.holder === r.me ? sshReachable(r.standby, r.ssh) : false;
    if (local.holder === r.me && standbyUp) writeLocal(r.localPath, { ...local, confirmedAt: r.now() });
    const outcome = local.holder === r.me ? (standbyUp ? 'quorum-standby' : 'arbiter-unreachable') : 'arbiter-unreachable';
    observe(r, 'hq.lease', outcome, { error: String(error).slice(0, 200), standbyReachable: standbyUp });
    return { outcome };
  }
  const record = parseLease(read.raw);
  noteSeen(r, record);
  if (!record) { observe(r, 'hq.lease', 'no-lease', { seenGeneration: readSeenGeneration(r.seenPath) }); return { outcome: 'no-lease' as const }; }
  if (record.holder === r.me) {
    // The record names me as holder: a generation the arbiter granted me (promotion) is adopted, never refused.
    const renewed = mutate(r, (current, now) => decideRenew(current, r.me, Math.max(local.generation ?? 0, current?.generation ?? 0), now));
    if (renewed.ok && (local.generation ?? 0) < renewed.record.generation) observe(r, 'hq.lease', 'generation-adopted', { from: local.generation ?? null, to: renewed.record.generation });
    if (renewed.ok) {
      noteSeen(r, renewed.record);
      writeLocal(r.localPath, { holder: r.me, generation: renewed.record.generation, confirmedAt: r.now(), ttlSeconds: renewed.record.ttlSeconds });
      observe(r, 'hq.lease', 'renewed', { generation: renewed.record.generation });
      return { outcome: 'renewed' as const, generation: renewed.record.generation };
    }
    observe(r, 'hq.lease', 'renew-refused', { reason: renewed.reason });
    return { outcome: 'renew-refused' as const, reason: renewed.reason };
  }
  // Not the holder: report the view, keep the granted generation, stay standby.
  const seen = probeReachable(record.holder, r.probe);
  const reachable = seen.reachable;
  mutate(r, (current) => current ? { ok: true, next: recordView(current, r.me, reachable, read.now) } : { ok: false, reason: 'no lease' });
  if (leaseExpired(record, read.now)) observe(r, 'hq.lease', 'expired-seen', { holder: record.holder, generation: record.generation });
  writeLocal(r.localPath, { holder: record.holder, generation: record.generation, ttlSeconds: record.ttlSeconds });
  observe(r, 'hq.lease', 'standby', { holder: record.holder, generation: record.generation, holderReachable: reachable, ping: seen.ping, health: seen.health });
  return { outcome: 'standby' as const, holder: record.holder, holderReachable: reachable };
}

/**
 * Arbiter check (cron on cloud-vm every 10 min, next to the file): probe the holder over the tailnet
 * (`tailscale ping` ⊕ nexus health · no ssh into home machines); propose to OP by default.
 */
export function hqArbiterCheck(deps: HqDeps & { leasePath?: string } = {}) {
  const r0 = resolve(deps);
  const r = deps.store ? r0 : { ...r0, store: fileLeaseStore(deps.leasePath ?? join(process.env.HOME ?? '', '.elanous-hq', 'lease.json')) };
  let outcome: { promoted: boolean; streak: number; holder?: string; generation?: number; ping?: boolean; health?: boolean; runbookFailed?: string } = { promoted: false, streak: 0 };
  let proposal: { holder: string; generation: number; streak: number } | undefined;
  const config = deps.config ?? getUserConfig().hq ?? {};
  const threshold = config.autoPromote?.streak ?? 3;
  const autoPromote = config.autoPromote?.enabled === true;
  let leaseMoved: { from: string; to: string; generation: number } | undefined;
  const result = mutate(r, (record, now) => {
    if (!record) return { ok: false, reason: 'no lease' };
    const seen = probeReachable(record.holder, r.probe);
    const checked = decideArbiterCheck(record, { arbiter: r.me, standby: r.standby, arbiterReachesHolder: seen.reachable, now,
      promote: autoPromote, promoteAfterChecks: threshold });
    proposal = !autoPromote && !seen.reachable && record.holder !== r.standby && checked.streak >= threshold
      ? { holder: record.holder, generation: record.generation, streak: checked.streak } : undefined;
    // promoteHq's own precondition is «lease holder = target», so the lease moves first and the runbook follows.
    if (checked.promoted) leaseMoved = { from: record.holder, to: checked.next.holder, generation: checked.next.generation };
    outcome = { promoted: false, streak: checked.streak, holder: checked.next.holder, generation: checked.next.generation, ping: seen.ping, health: seen.health };
    return { ok: true, next: checked.next };
  });
  const moved = leaseMoved as { from: string; to: string; generation: number } | undefined; // assigned inside the mutate callback
  if (result.ok && moved) {
    let promotion: PromoteResult | undefined;
    let failure: string | undefined;
    try {
      promotion = (deps.promote ?? ((host: string, apply: boolean) => promoteHq(host, apply)))(moved.to, true);
      if (!promotion.ok) failure = promotion.lines.filter((line) => line.status === 'failed').map((line) => `${line.step}: ${line.measurement}`).join(' · ') || 'runbook returned ok=false';
    } catch (error) { failure = String(error); }
    if (failure === undefined) outcome = { ...outcome, promoted: true };
    else {
      // The lease already names the standby but the services did not move — never report this as a promotion.
      outcome = { ...outcome, promoted: false, runbookFailed: failure };
      try { r.log('hq.arbiter', 'promote-runbook-failed', { ...moved, error: failure }); } catch { /* observation is fail-soft */ }
      try {
        (deps.opRequest ?? ((request) => writeOpSeatRequest(request)))({
          key: `hq:promote-failed:${moved.to}:${moved.generation}`,
          text: `자동 승격 런북 실패 — 임대는 ${moved.to}(세대 ${moved.generation})로 옮겨졌지만 서비스 이전이 끝나지 않았다: ${failure}. OP 가 \`eln hq promote --to ${moved.to}\` 로 확인한다.`,
        });
      } catch (error) { try { r.log('hq.arbiter', 'promote-request-failed', { ...moved, error: String(error) }); } catch { /* fail-soft */ } }
    }
  }
  const proposed = proposal as { holder: string; generation: number; streak: number } | undefined;
  if (result.ok && proposed) {
    try { proposeHqPromotion({ ...proposed, standby: r.standby }, { request: deps.opRequest, log: r.log }); }
    catch (error) { try { r.log('hq.arbiter', 'promote-proposal-failed', { ...proposed, error: String(error) }); } catch { /* observation is fail-soft */ } }
  }
  observe(r, 'hq.lease', outcome.promoted ? 'promoted' : 'arbiter-check', { ...outcome, ok: result.ok });
  return { ok: result.ok, ...outcome };
}

/** Standby's own generation, asked over ssh (rule ③ when the arbiter is down). */
function standbyGeneration(r: Resolved): number | undefined {
  const res = r.ssh(r.standby, 'cat "$HOME/.elanous/hq/local.json" 2>/dev/null || true');
  try { const g = (JSON.parse(res.stdout || '{}') as LocalHqState).generation; return typeof g === 'number' ? g : undefined; } catch { return undefined; }
}

export function hqFenceDecision(role: HqFenceRole, deps: HqDeps = {}) {
  const r = resolve(deps);
  const local = readLocal(r.localPath);
  let record: LeaseRecord | null | 'unreachable';
  try { record = parseLease(r.store.read().raw); } catch { record = 'unreachable'; }
  if (record !== 'unreachable') noteSeen(r, record);
  const seenGeneration = readSeenGeneration(r.seenPath);
  const standbyUp = record === 'unreachable' && local.holder === r.me ? sshReachable(r.standby, r.ssh) : undefined;
  const decided = decideFence({
    me: r.me, now: r.now(), local, record,
    ...(standbyUp !== undefined ? { standbyReachable: standbyUp } : {}),
    ...(standbyUp ? { standbyGeneration: standbyGeneration(r) } : {}),
    failOpen: role !== 'ledger-cli' && r.failOpen.has(role),
    ...(seenGeneration !== null ? { seenGeneration } : {}),
  });
  if (decided.run && record !== 'unreachable' && record) writeLocal(r.localPath, { holder: r.me, generation: record.generation, confirmedAt: r.now(), ttlSeconds: record.ttlSeconds });
  observe(r, 'hq.fence', decided.run ? 'allowed' : 'skipped', { role, reason: decided.reason, holder: decided.holder, generation: decided.generation });
  return decided;
}

/** CLI ledger writes fail closed after the first lease; bootstrap is allowed only before any generation was seen. */
export function hqCliWriteAllowed(command: string, override = false, deps: HqDeps = {}): boolean {
  const decision = hqFenceDecision('ledger-cli', deps);
  const allowed = decision.run || decision.reason === 'no-lease';
  const r = resolve(deps);
  if (override) {
    observe(r, 'hq.fence', 'cli-override', { command, reason: decision.reason, holder: decision.holder, generation: decision.generation, allowed });
    console.error(`hq override: ${command} — ${decision.reason} (holder ${decision.holder ?? 'unknown'} gen ${decision.generation ?? 'unknown'})`);
    return true;
  }
  if (allowed) return true;
  observe(r, 'hq.fence', 'cli-refused', { command, reason: decision.reason, holder: decision.holder, generation: decision.generation });
  console.error(`본부는 ${decision.holder ?? 'unknown'} gen ${decision.generation ?? 'unknown'} — 원장 쓰기는 지금 본부로 보내라 (수동 우회: --hq-override, 관측)`);
  process.exitCode = 4;
  return false;
}

/** Run `command` only when this host may write; the child sees ELANOUS_HQ_GENERATION. Skips exit 0. */
export function hqFenceRun(role: HqFenceRole, command: string[], deps: HqDeps = {}): number {
  const decided = hqFenceDecision(role, deps);
  if (!decided.run) { console.error(`hq fence: skip ${role} — ${decided.reason}${decided.holder ? ` (holder ${decided.holder} gen ${decided.generation})` : ''}`); return 0; }
  const [cmd, ...args] = command;
  if (!cmd) throw new Error('hq fence: command required after --');
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ELANOUS_HQ_GENERATION: String(decided.generation ?? '') } });
  return r.status ?? 1;
}
