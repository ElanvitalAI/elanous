// RES-POLICY-GUARDIAN — guardian patrol, I/O half: gather the snapshot, apply in-policy actions, card the rest.
// Runs every 5 minutes from graphs/ops/res-patrol.yaml (`cmd:res-patrol` → `eln res patrol`).
//
// Acts on its own only inside the policy:
//   · restart chains with no terminal (kill-orphan) or a frozen root whose leaf exited (thaw) — the safe rules of
//     `eln self reap-chains` (#40069), exact pids, no pkill; chains that still hold a terminal are carded, not touched;
//   · VM start/stop allowed by the budget — executed only in `res.mode: live` with `res.vmStartCommand/vmStopCommand`;
//     in shadow mode the decision is recorded as a guardian row («would») and nothing runs.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { spawnElanousSync } from '../instance/spawn-elanous.js';
import { openMsgStore } from '../msg/msg-store.js';
import { readResourceLedger, recordResDecision, resourceLedgerPath, type HostReadinessHeartbeat, type ResourceLedgerEvent } from '../resource-ledger/resource-ledger.js';
import { applyChainPlan, planReap, readProcessTable, type ChainPlan, type ProcRow } from '../tui/restart-chain.js';
import { getUserConfig } from '../user-config/reader.js';
import { evaluatePatrol, EMPTY_PATROL_STATE, patrolCard, type PatrolCredential, type PatrolHost, type PatrolResult, type PatrolSnapshot, type PatrolState, type PatrolVm } from './patrol.js';
import { logResDecision, resolveResPolicy, vmHourlyUsd, type ResConfigSection, type ResPolicy } from './policy.js';
import { releaseWindowGuard, shadowCardStep, type ReleaseScheduleLike } from './shadow-cards.js';

/** Heartbeats older than this are not judged (the collector runs every 5 minutes). */
const HEARTBEAT_FRESH_MS = 15 * 60_000;
/** Credential/quota reads hit provider endpoints — at most every 30 minutes. */
const CREDENTIAL_EVERY_MS = 30 * 60_000;

export function patrolStatePath(root = effectiveInstanceRoot()): string {
  return join(root, 'loops', 'res-patrol', 'state.json');
}

export function readPatrolState(path: string): PatrolState {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<PatrolState>;
    return { active: value.active ?? {}, idleSince: value.idleSince ?? {}, ...(value.credentialsCheckedAt ? { credentialsCheckedAt: value.credentialsCheckedAt } : {}),
      ...(typeof value.vmSpentTodayUsd === 'number' ? { vmSpentTodayUsd: value.vmSpentTodayUsd } : {}),
      ...(Array.isArray(value.pending) ? { pending: value.pending } : {}),
      ...(value.lastCardAt ? { lastCardAt: value.lastCardAt } : {}), ...(value.lastCardTo ? { lastCardTo: value.lastCardTo } : {}),
      ...(value.lastTick ? { lastTick: value.lastTick } : {}) };
  } catch { return EMPTY_PATROL_STATE; }
}

function writePatrolState(path: string, state: PatrolState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Latest fresh heartbeat per host from the resource ledger. */
export function heartbeatHosts(events: readonly ResourceLedgerEvent[], now: Date): PatrolHost[] {
  const latest = new Map<string, HostReadinessHeartbeat>();
  for (const event of events) if (event.event === 'host-readiness-heartbeat') {
    const prior = latest.get(event.heartbeat.host);
    if (!prior || Date.parse(event.heartbeat.at) >= Date.parse(prior.at)) latest.set(event.heartbeat.host, event.heartbeat);
  }
  return [...latest.values()].filter((hb) => hb.sample && now.getTime() - Date.parse(hb.at) <= HEARTBEAT_FRESH_MS).map((hb) => ({
    host: hb.host, at: hb.at,
    ...(hb.sample!.load1 !== undefined ? { load1: hb.sample!.load1 } : {}),
    memoryAvailablePercent: hb.sample!.memoryAvailablePercent,
    ...(hb.sample!.bunProcesses !== undefined ? { bunProcesses: hb.sample!.bunProcesses } : {}),
    ...(hb.sample!.bunRssMb !== undefined ? { bunRssMb: hb.sample!.bunRssMb } : {}),
  }));
}

/** bun process count and RSS on this machine from the same ps table the chain reaper reads. */
export function localBunUsage(rows: readonly ProcRow[]): { bunProcesses: number; bunRssMb: number; livePanes: number } {
  const bun = rows.filter((row) => /(^|\/)bun(\s|$)/.test(row.command.split(/\s+/)[0] ?? ''));
  // A live pane = a distinct controlling tty (`??`/`?`/`-` = none).
  const livePanes = new Set(rows.map((row) => row.tty).filter((tty) => tty && !/^(\?\??|-)$/.test(tty))).size;
  return { bunProcesses: bun.length, bunRssMb: Math.round(bun.reduce((sum, row) => sum + row.rssKb, 0) / 1024), livePanes };
}

export interface LocalMemorySignals {
  readonly memoryAvailablePercent?: number;
  readonly swapUsedMb?: number;
  readonly memoryPressureLevel?: 'normal' | 'warn' | 'critical';
  readonly memoryPsiSomeAvg10?: number;
}

/** macOS: `memory_pressure` («System-wide memory free percentage: 91%») · `sysctl vm.swapusage` · kern.memorystatus_vm_pressure_level. */
export function parseDarwinMemory(memoryPressure: string, swapUsage: string, pressureLevel: string): LocalMemorySignals {
  const free = /memory free percentage:\s*(\d+(?:\.\d+)?)%/i.exec(memoryPressure)?.[1];
  const swap = /used\s*=\s*(\d+(?:\.\d+)?)([KMG])/i.exec(swapUsage);
  const swapMb = swap ? Number(swap[1]) * ({ K: 1 / 1024, M: 1, G: 1024 } as Record<string, number>)[swap[2]!.toUpperCase()]! : undefined;
  const level = Number(pressureLevel.trim());
  const memoryPressureLevel = level === 4 ? 'critical' : level === 2 ? 'warn' : level === 1 ? 'normal' : undefined;
  return { ...(free !== undefined ? { memoryAvailablePercent: Number(free) } : {}), ...(swapMb !== undefined ? { swapUsedMb: Math.round(swapMb) } : {}),
    ...(memoryPressureLevel ? { memoryPressureLevel } : {}) };
}

/** Linux: /proc/meminfo (MemAvailable/MemTotal · SwapTotal−SwapFree) ⊕ /proc/pressure/memory `some avg10`. */
export function parseLinuxMemory(meminfo: string, psi: string): LocalMemorySignals {
  const kb = (name: string) => { const m = new RegExp(`^${name}:\\s*(\\d+)\\s*kB`, 'mi').exec(meminfo); return m ? Number(m[1]) : undefined; };
  const total = kb('MemTotal'), available = kb('MemAvailable'), swapTotal = kb('SwapTotal'), swapFree = kb('SwapFree');
  const some = /^some\b.*\bavg10=(\d+(?:\.\d+)?)/m.exec(psi)?.[1];
  return { ...(total && available !== undefined ? { memoryAvailablePercent: available / total * 100 } : {}),
    ...(swapTotal !== undefined && swapFree !== undefined ? { swapUsedMb: Math.round((swapTotal - swapFree) / 1024) } : {}),
    ...(some !== undefined ? { memoryPsiSomeAvg10: Number(some) } : {}) };
}

/** System memory signals of the patrol host; {} when unreadable (the heartbeat value stays). */
export function readLocalMemory(): LocalMemorySignals {
  try {
    if (process.platform === 'darwin') {
      const out = (cmd: string, args: string[]) => { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000 }); return r.status === 0 ? String(r.stdout) : ''; };
      return parseDarwinMemory(out('memory_pressure', []), out('sysctl', ['-n', 'vm.swapusage']), out('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']));
    }
    if (process.platform === 'linux') {
      let psi = '';
      try { psi = readFileSync('/proc/pressure/memory', 'utf8'); } catch { /* PSI not enabled */ }
      return parseLinuxMemory(readFileSync('/proc/meminfo', 'utf8'), psi);
    }
  } catch (error) { debug.log('res.patrol', 'local-memory-unread', { error: String(error) }); }
  return {};
}

/** Per-account credentials from `eln usage --json` rows (the same numbers `eln usage` prints).
 *  Quota = credits.usedPercent of that account (codex weekly window); OpenRouter is prepaid with auto top-up → no quota. */
export function credentialsFromUsageJson(value: unknown): PatrolCredential[] {
  const rows = (value as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) throw new Error('usage json without rows');
  const out: PatrolCredential[] = [];
  for (const raw of rows) {
    const row = raw as { provider?: string; accountName?: string; credits?: { status?: string; usedPercent?: unknown; detail?: unknown };
      subscription?: { status?: string; remainingPercent?: unknown }; resetCredits?: { status?: string; expiresAt?: string } };
    if (!row.provider || !['codex', 'grok', 'openrouter'].includes(row.provider)) continue;
    const account = row.accountName ?? 'default';
    if (row.credits?.status === 'error') { out.push({ provider: row.provider, account, error: String(row.credits.detail ?? 'error') }); continue; }
    const credit = row.credits?.status === 'ok' && typeof row.credits.usedPercent === 'number' ? row.credits.usedPercent : null;
    const subscription = row.subscription?.status === 'available' && typeof row.subscription.remainingPercent === 'number' ? 100 - row.subscription.remainingPercent : null;
    const used = row.provider === 'openrouter' ? null : credit ?? subscription;
    const expiresAt = row.resetCredits?.status === 'expiring-soon' || row.resetCredits?.status === 'expired' ? row.resetCredits.expiresAt ?? null : null;
    out.push({ provider: row.provider, account, usedPercent: used, expiresAt });
  }
  return out;
}

/** Live pregate runs per host from RES inflight locks (`<pid> <host> <token>`); dead pids do not count. */
export function pregateInflight(dir: string, alive: (pid: number) => boolean): Record<string, number> {
  return pregateInflightExcept(dir, alive);
}

/** `excludePid` = the caller's own lock (pregate.py records its decision after taking the slot — «before me» is what counts). */
export function pregateInflightExcept(dir: string, alive: (pid: number) => boolean, excludePid?: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.lock')) continue;
    let raw = '';
    try { raw = readFileSync(join(dir, name), 'utf8'); } catch { continue; }
    const [pidText, host] = raw.trim().split(/\s+/);
    const pid = Number(pidText);
    if (!host || host === '-' || !Number.isSafeInteger(pid) || pid <= 1 || pid === excludePid || !alive(pid)) continue;
    out[host] = (out[host] ?? 0) + 1;
  }
  return out;
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Map the provider inventory onto policy hosts; running unlisted unprotected VMs keep their instance name. */
export function patrolVms(policy: ResPolicy, inventory: ReadonlyArray<{ id: string; name: string; state: string; protected: true | null }>): PatrolVm[] {
  const out: PatrolVm[] = [];
  const claimed = new Set<string>();
  for (const host of policy.cloudHosts) {
    const instance = policy.cloudInstances[host];
    const row = inventory.find((item) => item.id === instance || item.name === instance || item.name === host || item.name === `elanous-${host}`);
    if (!row) continue;
    claimed.add(row.id);
    out.push({ host, state: row.state === 'running' ? 'running' : ['stopped', 'terminated'].includes(row.state) ? 'stopped' : 'unknown' });
  }
  for (const row of inventory) {
    if (claimed.has(row.id) || row.state !== 'running') continue;
    out.push({ host: row.name, state: 'running', ...(row.protected ? { protected: true } : {}) });
  }
  return out;
}

/** Conservative: every running policy VM is charged from local midnight (over-estimates, never under). */
export function vmSpentTodayUsd(policy: ResPolicy, vms: readonly PatrolVm[], now: Date): number {
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const hours = (now.getTime() - midnight.getTime()) / 3_600_000;
  return vms.filter((vm) => vm.state === 'running' && policy.cloudHosts.includes(vm.host))
    .reduce((sum, vm) => sum + vmHourlyUsd(policy, vm.host) * hours, 0);
}

export interface PatrolRunDeps {
  readonly now: () => Date;
  readonly config: () => ResConfigSection | undefined;
  readonly ledger: () => ResourceLedgerEvent[];
  readonly processTable: () => ProcRow[];
  /** System memory signals of the patrol host (absent = heartbeat only). */
  readonly localMemory?: () => LocalMemorySignals;
  readonly localHost: () => string;
  readonly inflightDir: () => string;
  readonly alive: (pid: number) => boolean;
  readonly cloud: () => Promise<ReadonlyArray<{ id: string; name: string; state: string; protected: true | null }> | null>;
  readonly credentials: () => Promise<PatrolCredential[]>;
  readonly statePath: () => string;
  readonly applyReap: (plan: ChainPlan, rows: readonly ProcRow[]) => Promise<{ ok: boolean; detail: string }>;
  readonly runVmCommand: (command: string) => { status: number | null; output: string };
  readonly recordDecision: typeof recordResDecision;
  readonly postCard: (card: { to: string; body: string }, key: string) => void;
  /** Release schedules for the release-window guard; null = unreadable (forces shadow). Absent = none known. */
  readonly releaseSchedules?: () => readonly ReleaseScheduleLike[] | null;
}

export interface PatrolRunResult extends Pick<PatrolResult, 'findings' | 'fresh' | 'cleared'> {
  readonly outcome: 'ok' | 'partial';
  readonly mode: 'shadow' | 'live';
  readonly dormant: boolean;
  readonly reaped: ReadonlyArray<{ sessionId: string | null; action: string; ok: boolean; detail: string }>;
  readonly vm: ReadonlyArray<{ host: string; action: string; verdict: string; rule: string; executed: boolean; detail: string }>;
  readonly carded: string | null;
  readonly unmeasured: readonly string[];
  /** Shadow-with-cards (asked, or forced by the release window): findings card, nothing acts. */
  readonly observeOnly: boolean;
  /** Why the guardian was forced into shadow this tick (release window), else null. */
  readonly forcedShadow: string | null;
}

export async function runResPatrol(deps: PatrolRunDeps, opts: { dryRun?: boolean } = {}): Promise<PatrolRunResult> {
  return runResPatrolWith(deps, opts);
}

/** `shadowCards` = observe-only: no reaps, no VM commands, findings batched into one card per 30 minutes. */
export async function runResPatrolWith(deps: PatrolRunDeps, opts: { dryRun?: boolean; shadowCards?: boolean } = {}): Promise<PatrolRunResult> {
  const now = deps.now();
  const section = deps.config();
  const policy = resolveResPolicy(section);
  let schedules: readonly ReleaseScheduleLike[] | null = [];
  try { schedules = deps.releaseSchedules ? deps.releaseSchedules() : []; } catch { schedules = null; }
  const forcedShadow = releaseWindowGuard(now, schedules);
  const observeOnly = opts.shadowCards === true || forcedShadow !== null;
  if (forcedShadow) debug.log('res.patrol', 'forced-shadow', { reason: forcedShadow, configuredMode: section?.mode ?? 'shadow' });
  const mode = section?.mode === 'live' && !observeOnly ? 'live' : 'shadow';
  const dormant = section?.dormant === true;
  const unmeasured: string[] = [];
  const statePath = deps.statePath();
  const prev = readPatrolState(statePath);

  let events: ResourceLedgerEvent[] = [];
  try { events = deps.ledger(); } catch (error) { unmeasured.push(`ledger: ${String(error)}`); }
  const hosts = heartbeatHosts(events, now);
  const rows = deps.processTable();
  if (rows.length === 0) unmeasured.push('process-table');
  const local = deps.localHost();
  let localMemory: LocalMemorySignals = {};
  try { localMemory = deps.localMemory ? deps.localMemory() : {}; } catch (error) { unmeasured.push(`local-memory: ${String(error)}`); }
  const localUsage = { ...localBunUsage(rows), ...localMemory };
  const localRow = hosts.find((host) => host.host === local);
  const mergedHosts = localRow
    ? hosts.map((host) => host.host === local ? { ...host, ...localUsage } : host)
    : rows.length ? [...hosts, { host: local, at: now.toISOString(), ...localUsage }] : hosts;

  let vms: PatrolVm[] = [];
  try {
    const inventory = await deps.cloud();
    if (inventory) vms = patrolVms(policy, inventory); else unmeasured.push('cloud-inventory');
  } catch (error) { unmeasured.push(`cloud-inventory: ${String(error)}`); }

  let credentials: PatrolCredential[] | undefined;
  const lastCredentials = prev.credentialsCheckedAt ? Date.parse(prev.credentialsCheckedAt) : 0;
  if (!(now.getTime() - lastCredentials < CREDENTIAL_EVERY_MS)) {
    try { credentials = await deps.credentials(); } catch (error) { unmeasured.push(`credentials: ${String(error)}`); }
  }

  const snapshot: PatrolSnapshot = {
    hosts: mergedHosts, chains: planReap(rows), pregateInflight: pregateInflight(deps.inflightDir(), deps.alive),
    vms, vmSpentTodayUsd: vmSpentTodayUsd(policy, vms, now), ...(credentials ? { credentials } : {}),
  };
  const result = evaluatePatrol(snapshot, policy, prev, now);

  const reaped: Array<{ sessionId: string | null; action: string; ok: boolean; detail: string }> = [];
  for (const plan of result.reap) {
    if (opts.dryRun || observeOnly) { reaped.push({ sessionId: plan.sessionId, action: plan.action.kind, ok: true, detail: opts.dryRun ? 'dry-run' : 'shadow (would reap)' }); continue; }
    const applied = await deps.applyReap(plan, rows);
    reaped.push({ sessionId: plan.sessionId, action: plan.action.kind, ...applied });
    debug.log('res.policy', 'allowed', { rule: 'reap-safe-chain', action: plan.action.kind, host: local, sessionId: plan.sessionId, ok: applied.ok, detail: applied.detail });
  }

  const vmOut: Array<{ host: string; action: string; verdict: string; rule: string; executed: boolean; detail: string }> = [];
  for (const entry of result.vm) {
    logResDecision(entry.action, entry.decision, { mode });
    let executed = false;
    let detail = entry.decision.detail;
    const template = entry.action.kind === 'vm-start' ? section?.vmStartCommand : section?.vmStopCommand;
    if (entry.decision.verdict === 'allow' && mode === 'live' && !observeOnly && template && !opts.dryRun) {
      const run = deps.runVmCommand(template.replaceAll('{host}', entry.action.host));
      executed = run.status === 0;
      detail = `${detail} · command rc=${run.status}`;
      if (!executed) unmeasured.push(`vm-${entry.action.kind}:${entry.action.host}`);
    }
    if (!opts.dryRun) {
      try {
        deps.recordDecision({ source: 'guardian', action: entry.action.kind, host: entry.action.host, decision: entry.decision.verdict,
          rule: entry.decision.rule, policyVersion: policy.version, ref: executed ? 'executed' : mode === 'live' ? 'not-executed' : 'shadow-would' }, now);
      } catch (error) { unmeasured.push(`record: ${String(error)}`); }
    }
    vmOut.push({ host: entry.action.host, action: entry.action.kind, verdict: entry.decision.verdict, rule: entry.decision.rule, executed, detail });
  }

  const activeKeys = new Set(Object.keys(result.next.active));
  const batched = observeOnly ? shadowCardStep(prev, result.fresh, activeKeys, dormant, now, forcedShadow) : null;
  const card = batched ? batched.card : patrolCard(result.fresh, dormant);
  let carded: string | null = null;
  let cardFailed = false;
  if (card && !opts.dryRun) {
    const key = `res-patrol:${createHash('sha256').update(batched ? card.body : result.fresh.map((f) => f.key).sort().join('\n')).digest('hex').slice(0, 16)}:${now.toISOString().slice(0, 16)}`;
    // Shadow findings are visible to both seats even when RES is active.
    // Retry the whole batch if either delivery fails rather than losing findings.
    const recipients = batched ? ['RES', 'OP'] : [card.to];
    const delivered: string[] = [];
    for (const to of recipients) {
      try { deps.postCard({ ...card, to }, `${key}:${to}`); delivered.push(to); }
      catch (error) { cardFailed = true; unmeasured.push(`card ${to}: ${String(error)}`); }
    }
    if (!cardFailed) carded = delivered.join(',');
    if (batched && carded) debug.log('res.patrol', 'shadow-card', { to: carded, findings: card.body.split('\n').length - 2, forcedShadow });
  }
  for (const finding of result.fresh) debug.log('res.patrol', 'finding', { rule: finding.rule, subject: finding.subject, severity: finding.severity, detail: finding.detail }, { level: finding.severity === 'critical' ? 'warn' : 'info' });
  for (const key of result.cleared) debug.log('res.patrol', 'cleared', { key });
  // A dry run must not consume the «fire once» edge, or the real tick would never card it.
  if (!opts.dryRun) {
    // A failed batched card keeps its findings pending (the next tick retries) instead of losing them.
    const cardState = batched
      ? (cardFailed ? { pending: [...(prev.pending ?? []), ...result.fresh.filter((f) => !(prev.pending ?? []).some((p) => p.key === f.key))],
        ...(prev.lastCardAt ? { lastCardAt: prev.lastCardAt } : {}), ...(prev.lastCardTo ? { lastCardTo: prev.lastCardTo } : {}) }
        : { pending: batched.pending, ...(batched.lastCardAt ? { lastCardAt: batched.lastCardAt } : {}), ...(batched.lastCardTo ? { lastCardTo: batched.lastCardTo } : {}) })
      : { ...(prev.lastCardAt ? { lastCardAt: prev.lastCardAt } : {}), ...(prev.lastCardTo ? { lastCardTo: prev.lastCardTo } : {}), ...(carded ? { lastCardAt: now.toISOString(), lastCardTo: carded } : {}) };
    writePatrolState(statePath, { ...result.next, vmSpentTodayUsd: snapshot.vmSpentTodayUsd, ...cardState,
      lastTick: { at: now.toISOString(), mode: observeOnly ? 'shadow' : mode, findings: result.findings, ...(forcedShadow ? { forcedShadow } : {}) } });
  }
  debug.log('res.patrol', 'tick', { mode, dormant, findings: result.findings.length, fresh: result.fresh.length, cleared: result.cleared.length,
    reaped: reaped.length, vm: vmOut.length, carded, unmeasured: unmeasured.length, dryRun: opts.dryRun === true, observeOnly, forcedShadow });
  return { outcome: unmeasured.length ? 'partial' : 'ok', mode, dormant, findings: result.findings, fresh: result.fresh, cleared: result.cleared,
    reaped, vm: vmOut, carded, unmeasured, observeOnly, forcedShadow };
}

async function liveCredentials(): Promise<PatrolCredential[]> {
  const out: PatrolCredential[] = [];
  const { readGrokSubscriptionExpiry } = await import('../grok/credential.js');
  const grokExpiry = readGrokSubscriptionExpiry();
  if (grokExpiry) out.push({ provider: 'grok', account: 'subscription', expiresAt: grokExpiry });
  // Same binary and universe as this patrol: `eln usage --json` per account (11-25: the in-process reader misread team/third).
  const run = spawnElanousSync(['usage', '--json'], { encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`eln usage --json rc=${run.status}`);
  out.push(...credentialsFromUsageJson(JSON.parse(String(run.stdout))));
  return out;
}

export function defaultPatrolRunDeps(root = effectiveInstanceRoot()): PatrolRunDeps {
  return {
    now: () => new Date(),
    config: () => getUserConfig().res,
    ledger: () => readResourceLedger(resourceLedgerPath(root)),
    processTable: readProcessTable,
    localMemory: readLocalMemory,
    localHost: () => {
      try { return (require('../hq/hq.js') as typeof import('../hq/hq.js')).hqLocalHostName(); }
      catch { return 'local'; }
    },
    inflightDir: () => process.env.RES_INFLIGHT_DIR || join(homedir(), 'elanous-hq', 'seat-state', 'RES', 'inflight'),
    alive: pidAlive,
    cloud: async () => {
      const { cloudHostInventory } = await import('../fleet/cloud-host-inventory.js');
      const snapshot = await cloudHostInventory();
      return snapshot.providers.some((provider) => provider.status === 'measured') ? snapshot.hosts : null;
    },
    credentials: liveCredentials,
    statePath: () => patrolStatePath(root),
    applyReap: async (plan, rows) => applyChainPlan(plan, rows),
    runVmCommand: (command) => {
      const run = spawnSync('sh', ['-c', command], { encoding: 'utf8', timeout: 300_000 });
      return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}`.slice(-2000) };
    },
    recordDecision: (row, at) => recordResDecision(row, at, resourceLedgerPath(root)),
    releaseSchedules: () => {
      const { releaseLedgerRoot } = require('../instance/resolve.js') as typeof import('../instance/resolve.js');
      if (!existsSync(join(releaseLedgerRoot(), 'release', 'features.sqlite'))) return [];
      const { readSchedules } = require('../release-loop/feature-store.js') as typeof import('../release-loop/feature-store.js');
      return readSchedules();
    },
    postCard: (card, key) => {
      const store = openMsgStore(join(root, 'msg', 'messages.db'));
      try { store.appendWithProvenance({ from: 'GUARDIAN', to: card.to, kind: 'incident', body: card.body }, key); }
      finally { store.close(); }
    },
  };
}
