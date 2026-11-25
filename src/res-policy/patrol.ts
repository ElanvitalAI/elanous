// RES-POLICY-GUARDIAN — guardian patrol, pure half: snapshot ⊕ policy ⊕ previous state → findings, safe actions, cards.
//
// Situation (11-25): a 733-process / 53 GB self-restart chain leak went unseen; load climbed past 100 before anyone
// looked; VMs were started 0 times while hands queued. The patrol runs every 5 minutes (graphs/ops/res-patrol.yaml).
//
// 세 얼굴: 관측 = `res.patrol finding|cleared|tick` ⊕ `res.policy allowed {rule}` for every in-policy action /
// 판단 근거 = ResPolicy thresholds; a finding fires ONCE when it enters and re-arms only after it clears /
// 수복과 인계 = in-policy: reap chains that have no terminal or a frozen root, VM start/stop within budget;
// out-of-policy: one batched «[수호자 · RES]» card per tick to RES (OP when RES is dormant).
import type { ChainPlan } from '../tui/restart-chain.js';
import { decideResAction, loadCeiling, pregateSlotCap, type ResAction, type ResDecision, type ResPolicy } from './policy.js';

export interface PatrolHost {
  readonly host: string;
  readonly at: string;
  readonly load1?: number;
  /** System free memory % (macOS `memory_pressure` · Linux MemAvailable · heartbeat vm_stat/free for remote hosts). */
  readonly memoryAvailablePercent?: number;
  readonly swapUsedMb?: number;
  /** macOS kern.memorystatus_vm_pressure_level (1 normal · 2 warn · 4 critical). */
  readonly memoryPressureLevel?: 'normal' | 'warn' | 'critical';
  /** Linux /proc/pressure/memory `some avg10`. */
  readonly memoryPsiSomeAvg10?: number;
  readonly bunProcesses?: number;
  readonly bunRssMb?: number;
  /** Live terminal panes (distinct controlling ttys) — counted on the patrol host only. */
  readonly livePanes?: number;
}

export interface PatrolCredential {
  readonly provider: string;
  readonly account: string;
  readonly usedPercent?: number | null;
  readonly expiresAt?: string | null;
  readonly error?: string;
}

/** host = policy cloud host name, or the provider instance name for a VM the policy does not list. */
export interface PatrolVm { readonly host: string; readonly state: 'running' | 'stopped' | 'unknown'; readonly protected?: boolean }

export interface PatrolSnapshot {
  readonly hosts: readonly PatrolHost[];
  readonly chains: readonly ChainPlan[];
  /** Live pregate runs per host (RES inflight locks). */
  readonly pregateInflight: Readonly<Record<string, number>>;
  readonly vms: readonly PatrolVm[];
  /** Absent = not collected this tick (credential reads are throttled); previous credential findings are kept. */
  readonly credentials?: readonly PatrolCredential[];
  /** USD already spent on cloud VMs today (estimate). */
  readonly vmSpentTodayUsd: number;
}

export interface PatrolState {
  /** Finding key → first time it fired; present = already carded. */
  readonly active: Readonly<Record<string, string>>;
  /** Cloud host → when it was first seen idle while running. */
  readonly idleSince: Readonly<Record<string, string>>;
  readonly credentialsCheckedAt?: string;
  /** Last VM spend estimate (USD today) — read by the shadow auto-record so it judges with the patrol's number. */
  readonly vmSpentTodayUsd?: number;
  /** Shadow-with-cards: fresh findings waiting for the next 30-minute batched card. */
  readonly pending?: readonly PatrolFinding[];
  readonly lastCardAt?: string;
  readonly lastCardTo?: string;
  /** Federation Board row source: the last tick's findings, mode and time. */
  readonly lastTick?: { readonly at: string; readonly mode: string; readonly findings: readonly PatrolFinding[]; readonly forcedShadow?: string };
}

export const EMPTY_PATROL_STATE: PatrolState = { active: {}, idleSince: {} };

/** info = recorded on the tick (dry-run JSON · board) but never fires, cards or alerts. */
export type FindingSeverity = 'info' | 'warn' | 'critical';
export interface PatrolFinding {
  readonly key: string;
  readonly rule: string;
  readonly subject: string;
  readonly severity: FindingSeverity;
  readonly detail: string;
}

export interface PatrolDecision { readonly action: ResAction; readonly decision: ResDecision }

export interface PatrolResult {
  /** Every breach observed this tick. */
  readonly findings: readonly PatrolFinding[];
  /** Breaches that entered this tick (the ones that card / alert). */
  readonly fresh: readonly PatrolFinding[];
  /** Keys that were active and cleared this tick. */
  readonly cleared: readonly string[];
  /** Chain plans the patrol may apply on its own (no terminal, or a frozen root to thaw). */
  readonly reap: readonly ChainPlan[];
  /** Every VM decision the patrol took this tick (allow = act in live mode). */
  readonly vm: readonly PatrolDecision[];
  readonly next: PatrolState;
}

const sevRank: Record<FindingSeverity, number> = { info: 0, warn: 1, critical: 2 };

/** Chains the reaper would end processes in (`eln self reap-chains --dry-run`): count, processes, MB. */
export function chainsToEnd(chains: readonly ChainPlan[]): { chains: number; processes: number; mb: number } {
  let count = 0, processes = 0, kb = 0;
  for (const plan of chains) {
    if (plan.action.kind !== 'kill-orphan' && plan.action.kind !== 'collapse') continue;
    if (plan.action.kill.length === 0) continue;
    count += 1; processes += plan.action.kill.length; kb += plan.action.reclaimKb;
  }
  return { chains: count, processes, mb: Math.round(kb / 1024) };
}

/** Memory severity from system signals only — never from the bun RSS sum (shared pages count once per process). */
function memoryFinding(policy: ResPolicy, host: PatrolHost): PatrolFinding | null {
  const free = host.memoryAvailablePercent;
  const swap = host.swapUsedMb;
  const psi = host.memoryPsiSomeAvg10;
  const level = host.memoryPressureLevel;
  const signals = [free !== undefined ? `free ${free.toFixed(0)}%` : null, swap !== undefined ? `swap ${(swap / 1024).toFixed(1)} GB` : null,
    level ? `pressure ${level}` : null, psi !== undefined ? `psi some avg10 ${psi.toFixed(1)}` : null].filter(Boolean).join(' · ');
  const critical: string[] = [];
  if (free !== undefined && free < policy.load.minMemoryAvailablePercent) critical.push(`free < ${policy.load.minMemoryAvailablePercent}%`);
  if (level === 'critical') critical.push('vm pressure critical');
  if (psi !== undefined && psi >= policy.load.psiCriticalAvg10) critical.push(`psi ≥ ${policy.load.psiCriticalAvg10}`);
  if (critical.length) return { key: `memory-low:${host.host}`, rule: 'memory-low', subject: host.host, severity: 'critical', detail: `${signals} — ${critical.join(', ')}` };
  const warn: string[] = [];
  if (free !== undefined && free < policy.load.memoryWarnFreePercent) warn.push(`free < ${policy.load.memoryWarnFreePercent}%`);
  if (swap !== undefined && swap >= policy.load.swapWarnMb && free !== undefined && free < policy.load.swapWarnBelowFreePercent)
    warn.push(`swap ≥ ${(policy.load.swapWarnMb / 1024).toFixed(0)} GB with free < ${policy.load.swapWarnBelowFreePercent}%`);
  if (level === 'warn') warn.push('vm pressure warn');
  if (psi !== undefined && psi >= policy.load.psiWarnAvg10) warn.push(`psi ≥ ${policy.load.psiWarnAvg10}`);
  if (warn.length) return { key: `memory-warn:${host.host}`, rule: 'memory-warn', subject: host.host, severity: 'warn', detail: `${signals} — ${warn.join(', ')}` };
  return null;
}

function hostFindings(policy: ResPolicy, host: PatrolHost, ending: { chains: number; processes: number; mb: number }): PatrolFinding[] {
  const out: PatrolFinding[] = [];
  const ceiling = loadCeiling(policy, host.host);
  if (host.load1 !== undefined) {
    if (host.load1 >= ceiling.criticalLoad1)
      out.push({ key: `load-critical:${host.host}`, rule: 'load-critical', subject: host.host, severity: 'critical', detail: `load1 ${host.load1.toFixed(1)} ≥ ${ceiling.criticalLoad1}` });
    else if (host.load1 >= ceiling.warnLoad1)
      out.push({ key: `load-warn:${host.host}`, rule: 'load-warn', subject: host.host, severity: 'warn', detail: `load1 ${host.load1.toFixed(1)} ≥ ${ceiling.warnLoad1}` });
  }
  const memory = memoryFinding(policy, host);
  if (memory) out.push(memory);
  // Process count alone is not a leak: critical only when the reaper finds chains to end (the 11-25 733-process leak had them).
  if (host.bunProcesses !== undefined && host.livePanes !== undefined && host.bunProcesses > policy.load.maxBunPerLivePane * host.livePanes) {
    const leak = ending.chains >= policy.load.minChainsToEndCritical;
    out.push({ key: `bun-processes:${host.host}`, rule: 'bun-processes', subject: host.host, severity: leak ? 'critical' : 'info',
      detail: `${host.bunProcesses} bun processes > ${policy.load.maxBunPerLivePane} × ${host.livePanes} live panes · ${ending.chains} chains to end (${ending.processes} processes · ${ending.mb} MB)` });
  }
  if (host.bunRssMb !== undefined && host.bunRssMb > policy.load.maxBunRssMb)
    out.push({ key: `bun-rss:${host.host}`, rule: 'bun-rss', subject: host.host, severity: 'info', detail: `bun RSS sum ${(host.bunRssMb / 1024).toFixed(1)} GB > ${(policy.load.maxBunRssMb / 1024).toFixed(0)} GB (shared pages double-counted — info)` });
  return out;
}

function credentialFindings(policy: ResPolicy, now: Date, credential: PatrolCredential): PatrolFinding[] {
  const subject = `${credential.provider}/${credential.account}`;
  if (credential.error) return [{ key: `credential-error:${subject}`, rule: 'credential-error', subject, severity: 'warn', detail: credential.error }];
  const out: PatrolFinding[] = [];
  if (credential.expiresAt) {
    const ms = Date.parse(credential.expiresAt) - now.getTime();
    if (Number.isFinite(ms) && ms <= policy.credentials.expiryWarnHours * 3_600_000)
      out.push({ key: `credential-expiry:${subject}`, rule: 'credential-expiry', subject, severity: ms <= 0 ? 'critical' : 'warn',
        detail: ms <= 0 ? `expired at ${credential.expiresAt}` : `expires in ${(ms / 3_600_000).toFixed(1)}h` });
  }
  if (typeof credential.usedPercent === 'number' && credential.usedPercent >= policy.credentials.quotaWarnUsedPercent)
    out.push({ key: `quota-high:${subject}`, rule: 'quota-high', subject, severity: 'warn', detail: `${credential.usedPercent.toFixed(0)}% used ≥ ${policy.credentials.quotaWarnUsedPercent}%` });
  return out;
}

/** In-policy chain actions: no terminal left (kill-orphan) or a frozen root whose leaf exited (thaw). */
export function safeReapPlans(chains: readonly ChainPlan[]): ChainPlan[] {
  return chains.filter((plan) => plan.action.kind === 'kill-orphan' || plan.action.kind === 'thaw');
}

/** VM pressure: every pre-approved local host loaded, or every local pregate slot taken. */
export function localPressure(policy: ResPolicy, hosts: readonly PatrolHost[], inflight: Readonly<Record<string, number>>): boolean {
  const localHosts = hosts.filter((host) => policy.preApprovedTestHosts.includes(host.host));
  const allLoaded = localHosts.length > 0 && localHosts.every((host) => (host.load1 ?? 0) >= policy.vm.startWhenLocalLoad1);
  const allSlotsTaken = policy.preApprovedTestHosts.length > 0
    && policy.preApprovedTestHosts.every((host) => (inflight[host] ?? 0) >= pregateSlotCap(policy, host));
  return allLoaded || allSlotsTaken;
}

export function evaluatePatrol(snapshot: PatrolSnapshot, policy: ResPolicy, prev: PatrolState, now: Date): PatrolResult {
  const findings: PatrolFinding[] = [];
  const ending = chainsToEnd(snapshot.chains);
  for (const host of snapshot.hosts) findings.push(...hostFindings(policy, host, ending));

  for (const plan of snapshot.chains) {
    const subject = plan.sessionId ?? String(plan.pids[0]);
    const overCap = plan.pids.length > policy.load.maxTuiProcessesPerSession;
    // A live chain still holds a terminal: collapsing it freezes the pane root — outside the patrol's safe rules.
    if (plan.action.kind !== 'collapse' && !overCap) continue;
    const reclaim = plan.action.kind === 'collapse' || plan.action.kind === 'kill-orphan' ? ` · ${Math.round(plan.action.reclaimKb / 1024)} MB` : '';
    findings.push({ key: `restart-chain:${subject}`, rule: overCap ? 'tui-chain' : 'restart-chain-live', subject,
      severity: overCap ? 'critical' : 'warn',
      detail: `${plan.pids.length} eln TUI processes on ${plan.tty} (${plan.action.kind})${reclaim} · \`eln self reap-chains --dry-run\`` });
  }

  for (const [host, inflight] of Object.entries(snapshot.pregateInflight)) {
    const cap = pregateSlotCap(policy, host);
    if (inflight > cap) findings.push({ key: `pregate-over-cap:${host}`, rule: 'pregate-over-cap', subject: host, severity: 'warn', detail: `${inflight} pregates in flight > cap ${cap}` });
  }

  const credentialKeys = new Set<string>();
  if (snapshot.credentials) for (const credential of snapshot.credentials) findings.push(...credentialFindings(policy, now, credential));
  else for (const key of Object.keys(prev.active)) if (/^(credential-|quota-high:)/.test(key)) credentialKeys.add(key);

  const pressure = localPressure(policy, snapshot.hosts, snapshot.pregateInflight);
  const vm: PatrolDecision[] = [];
  const idleSince: Record<string, string> = {};
  const running = snapshot.vms.filter((machine) => machine.state === 'running');
  if (pressure && running.length === 0) {
    const candidate = snapshot.vms.find((machine) => machine.state === 'stopped' && policy.cloudHosts.includes(machine.host));
    if (candidate) {
      const action: ResAction = { kind: 'vm-start', host: candidate.host, pressure, spentTodayUsd: snapshot.vmSpentTodayUsd };
      vm.push({ action, decision: decideResAction(policy, action) });
    }
  }
  for (const machine of running) {
    if (!policy.cloudHosts.includes(machine.host)) continue;
    const heartbeat = snapshot.hosts.find((host) => host.host === machine.host);
    const idle = (snapshot.pregateInflight[machine.host] ?? 0) === 0 && heartbeat?.load1 !== undefined && heartbeat.load1 < policy.vm.idleLoad1;
    if (!idle) continue;
    const since = prev.idleSince[machine.host] ?? now.toISOString();
    idleSince[machine.host] = since;
    const idleMinutes = Math.floor((now.getTime() - Date.parse(since)) / 60_000);
    const action: ResAction = { kind: 'vm-stop', host: machine.host, idleMinutes };
    const decision = decideResAction(policy, action);
    if (decision.verdict === 'allow') vm.push({ action, decision });
  }
  for (const machine of running) {
    if (machine.protected || policy.cloudHosts.includes(machine.host)) continue;
    // Unknown VM: no stop rule applies, so the patrol never stops it — RES (OP when dormant) decides.
    findings.push({ key: `unknown-vm-running:${machine.host}`, rule: 'unknown-vm', subject: machine.host, severity: 'warn',
      detail: 'running cloud VM not in the RES policy — exception (no auto-stop)' });
  }
  for (const entry of vm) {
    if (entry.decision.verdict !== 'ask') continue;
    findings.push({ key: `${entry.decision.rule}:${entry.action.host}`, rule: entry.decision.rule, subject: entry.action.host, severity: 'warn', detail: entry.decision.detail });
  }

  // Fire once: a key cards when it enters (or escalates in severity) and re-arms only after it clears.
  const active: Record<string, string> = {};
  const fresh: PatrolFinding[] = [];
  for (const finding of findings) {
    if (finding.severity === 'info' || active[finding.key]) continue;
    const prior = prev.active[finding.key];
    active[finding.key] = prior ?? now.toISOString();
    if (!prior) fresh.push(finding);
  }
  for (const key of credentialKeys) active[key] = prev.active[key]!;
  // Escalation warn → critical is a new key (load-warn → load-critical), so it fires on its own.
  fresh.sort((a, b) => sevRank[b.severity] - sevRank[a.severity]);
  const cleared = Object.keys(prev.active).filter((key) => !(key in active));

  return {
    findings, fresh, cleared, reap: safeReapPlans(snapshot.chains), vm,
    next: { active, idleSince, ...(snapshot.credentials ? { credentialsCheckedAt: now.toISOString() } : prev.credentialsCheckedAt ? { credentialsCheckedAt: prev.credentialsCheckedAt } : {}) },
  };
}

/** One batched exception card for the fresh out-of-policy findings, or null when there is nothing to say. */
export function patrolCard(fresh: readonly PatrolFinding[], dormant: boolean): { to: string; body: string } | null {
  if (fresh.length === 0) return null;
  const lines = fresh.map((finding) => `- ${finding.severity === 'critical' ? '🚨' : '❓'} ${finding.rule} · ${finding.subject} — ${finding.detail}`);
  const tail = dormant ? '\n(RES dormant — 판단이 필요하면 `eln res capsule "<질문>"`)' : '';
  return { to: dormant ? 'OP' : 'RES', body: `[수호자 · RES] 정책 밖 ${fresh.length}건\n${lines.join('\n')}${tail}` };
}
