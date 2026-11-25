// RES-POLICY-GUARDIAN — the RES kingdom's resource policy as one config (대표 11-25 «policy + 수호자(행정관) + judgment on demand»).
//
// Situation: hands stalled waiting for a «RES 승인 슬롯» even for actions RES always approves (test universe on a
// pre-approved host, a free pregate slot). Canon: LOOP-AGENTS §1 «수호자가 집행 · RES 가 정한다» — RES writes the policy,
// the guardian (and every seat/tool) reads the same policy and only the out-of-policy remainder goes to judgment.
//
// 세 얼굴: 관측 = `res.policy allowed|denied|ask {rule}` per decision · `eln res policy show` / 판단 근거 = this policy
// (defaults in code ⊕ `res.policy` overrides in the operating config) / 수복과 인계 = allow → act without asking ·
// deny → refuse with alternatives · ask → one «[수호자 · RES]» exception card (RES tab, or OP when RES is dormant).
import { debug } from '../debug/log.js';

export type ResVerdict = 'allow' | 'deny' | 'ask';

export interface ResHostLoadCeiling {
  /** Raw 1-minute load average that raises a warning card (the CEO line: alert BEFORE load 100). */
  readonly warnLoad1: number;
  /** Raw 1-minute load average treated as critical (still below 100). */
  readonly criticalLoad1: number;
}

export interface ResPolicy {
  readonly version: string;
  /** Hosts where a seat may run tests in the read-only test universe without asking RES. */
  readonly preApprovedTestHosts: readonly string[];
  /** Hosts where hand tests / pregate / tsc are forbidden (HQ). */
  readonly forbiddenTestHosts: readonly string[];
  /** Pay-per-hour cloud VMs: never always-on; start/stop only within the VM budget. */
  readonly cloudHosts: readonly string[];
  /** Cloud host → provider instance id or name (inventory match). */
  readonly cloudInstances: Readonly<Record<string, string>>;
  readonly vm: {
    /** Daily spend cap across all cloud VMs (USD). */
    readonly dailyBudgetUsd: number;
    /** Hourly price per cloud host (USD); missing = defaultHourlyUsd. */
    readonly hourlyUsd: Readonly<Record<string, number>>;
    readonly defaultHourlyUsd: number;
    /** Start pressure: every pre-approved local host at or above this raw load1, or every pregate slot taken. */
    readonly startWhenLocalLoad1: number;
    /** Stop a running cloud VM once it has been idle (no pregate in flight · load1 below idleLoad1) this long. */
    readonly stopAfterIdleMinutes: number;
    readonly idleLoad1: number;
    /** Hours a start is budgeted for (the start is allowed only if spent + hours × hourly ≤ cap). */
    readonly startBudgetHours: number;
  };
  /** Concurrent pregate slots per host; missing = defaultPregateSlots. */
  readonly pregateSlots: Readonly<Record<string, number>>;
  readonly defaultPregateSlots: number;
  readonly load: ResHostLoadCeiling & {
    readonly perHost: Readonly<Record<string, ResHostLoadCeiling>>;
    /** System free memory % below this = critical (macOS `memory_pressure` free % · Linux MemAvailable). */
    readonly minMemoryAvailablePercent: number;
    /** System free memory % below this = warn. */
    readonly memoryWarnFreePercent: number;
    /** Swap used ≥ swapWarnMb while free memory is below swapWarnBelowFreePercent = warn (paging under pressure). */
    readonly swapWarnMb: number;
    readonly swapWarnBelowFreePercent: number;
    /** Linux PSI memory `some avg10` at or above these = warn / critical. */
    readonly psiWarnAvg10: number;
    readonly psiCriticalAvg10: number;
    /** bun processes above maxBunPerLivePane × live terminal panes (only where panes are counted — the patrol host).
     *  Critical only when the reaper also finds ≥ minChainsToEndCritical chains to end; otherwise info. */
    readonly maxBunPerLivePane: number;
    readonly minChainsToEndCritical: number;
    /** Sum of bun RSS — info only (the sum double-counts shared pages; memory severity comes from system signals). */
    readonly maxBunRssMb: number;
    /** eln TUI processes in one session's restart chain above this = a chain (11-25: 38 in one pane). */
    readonly maxTuiProcessesPerSession: number;
  };
  readonly credentials: {
    readonly expiryWarnHours: number;
    readonly quotaWarnUsedPercent: number;
  };
}

/** Defaults live in code (OPS-RULES «운영 config 최소화»); the operating config overrides only what RES changes. */
export const DEFAULT_RES_POLICY: ResPolicy = {
  version: 'res-policy-v1',
  preApprovedTestHosts: ['minim5', 'node-b', 'node-c'],
  forbiddenTestHosts: ['mshq'],
  cloudHosts: ['aws1', 'aws2', 'aws3', 'gcp1', 'gcp2'],
  // Source: seat-state/OP/tools/cloud-hosts.tsv (11-25).
  cloudInstances: { aws1: 'i-05e66cd52ebd3a2c6', aws2: 'i-02e62f64f818609d5', aws3: 'i-08f7e3976c47a563a', gcp1: 'elanous-burst-128', gcp2: 'elanous-burst-64-b' },
  vm: {
    dailyBudgetUsd: 30,
    hourlyUsd: {},
    defaultHourlyUsd: 1.2,
    startWhenLocalLoad1: 40,
    stopAfterIdleMinutes: 30,
    idleLoad1: 2,
    startBudgetHours: 2,
  },
  pregateSlots: {},
  defaultPregateSlots: 2,
  load: {
    warnLoad1: 60,
    criticalLoad1: 85,
    perHost: {},
    minMemoryAvailablePercent: 10,
    memoryWarnFreePercent: 25,
    // 11-25 mshq: 94% free with 4.7 GB swap used and pressure level normal — swap alone is not a warning.
    swapWarnMb: 4096,
    swapWarnBelowFreePercent: 50,
    psiWarnAvg10: 20,
    psiCriticalAvg10: 50,
    // 11-25 19:5x false alarm: 343 bun / 61 panes / 85 GB RSS sum at 91% free and 0 chains to end (GUARDIAN-RSS-THRESHOLD).
    minChainsToEndCritical: 1,
    // Source: 내부 문서 `LOOP-AGENTS` §1a — 11-25 crisis on mshq: ~53 GB / 733 bun processes at load 759 (OP 11-25).
    maxBunPerLivePane: 2,
    maxBunRssMb: 30 * 1024,
    maxTuiProcessesPerSession: 3,
  },
  credentials: { expiryWarnHours: 4, quotaWarnUsedPercent: 85 },
};

export interface ResConfigSection {
  /** Guardian patrol mode: shadow (default) records VM start/stop as «would»; live executes them within budget. */
  readonly mode?: 'shadow' | 'live';
  /** RES tab not resident: exception cards go to OP and judgment is a capsule spawned on demand. */
  readonly dormant?: boolean;
  /** Commands the patrol runs in live mode for an allowed VM change; `{host}` is replaced by the host name. */
  readonly vmStartCommand?: string;
  readonly vmStopCommand?: string;
  /** Overrides of DEFAULT_RES_POLICY (same shape · partial per section · ill-typed fields ignored). */
  readonly policy?: Readonly<Record<string, unknown>>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, fallback: number): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
const strs = (v: unknown, fallback: readonly string[]): readonly string[] =>
  Array.isArray(v) && v.every((entry) => typeof entry === 'string' && entry.trim()) ? v as string[] : fallback;
function numMap(v: unknown, base: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = { ...base };
  if (isObj(v)) for (const [key, value] of Object.entries(v)) if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value;
  return out;
}
function strMap(v: unknown, base: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = { ...base };
  if (isObj(v)) for (const [key, value] of Object.entries(v)) if (typeof value === 'string' && value.trim()) out[key] = value;
  return out;
}

/** The effective policy = defaults ⊕ config overrides. Ill-typed override fields fall back to the default (no crash). */
export function resolveResPolicy(section: ResConfigSection | undefined): ResPolicy {
  const o: Record<string, unknown> = isObj(section?.policy) ? section!.policy as Record<string, unknown> : {};
  const base = DEFAULT_RES_POLICY;
  const vm = isObj(o.vm) ? o.vm : {};
  const load = isObj(o.load) ? o.load : {};
  const cred = isObj(o.credentials) ? o.credentials : {};
  const perHost: Record<string, ResHostLoadCeiling> = { ...base.load.perHost };
  if (isObj(load.perHost)) for (const [host, value] of Object.entries(load.perHost)) {
    if (isObj(value)) perHost[host] = { warnLoad1: num(value.warnLoad1, base.load.warnLoad1), criticalLoad1: num(value.criticalLoad1, base.load.criticalLoad1) };
  }
  return {
    version: typeof o.version === 'string' && o.version.trim() ? o.version : base.version,
    preApprovedTestHosts: strs(o.preApprovedTestHosts, base.preApprovedTestHosts),
    forbiddenTestHosts: strs(o.forbiddenTestHosts, base.forbiddenTestHosts),
    cloudHosts: strs(o.cloudHosts, base.cloudHosts),
    cloudInstances: strMap(o.cloudInstances, base.cloudInstances),
    vm: {
      dailyBudgetUsd: num(vm.dailyBudgetUsd, base.vm.dailyBudgetUsd),
      hourlyUsd: numMap(vm.hourlyUsd, base.vm.hourlyUsd),
      defaultHourlyUsd: num(vm.defaultHourlyUsd, base.vm.defaultHourlyUsd),
      startWhenLocalLoad1: num(vm.startWhenLocalLoad1, base.vm.startWhenLocalLoad1),
      stopAfterIdleMinutes: num(vm.stopAfterIdleMinutes, base.vm.stopAfterIdleMinutes),
      idleLoad1: num(vm.idleLoad1, base.vm.idleLoad1),
      startBudgetHours: num(vm.startBudgetHours, base.vm.startBudgetHours),
    },
    pregateSlots: numMap(o.pregateSlots, base.pregateSlots),
    defaultPregateSlots: num(o.defaultPregateSlots, base.defaultPregateSlots),
    load: {
      warnLoad1: num(load.warnLoad1, base.load.warnLoad1),
      criticalLoad1: num(load.criticalLoad1, base.load.criticalLoad1),
      perHost,
      minMemoryAvailablePercent: num(load.minMemoryAvailablePercent, base.load.minMemoryAvailablePercent),
      memoryWarnFreePercent: num(load.memoryWarnFreePercent, base.load.memoryWarnFreePercent),
      swapWarnMb: num(load.swapWarnMb, base.load.swapWarnMb),
      swapWarnBelowFreePercent: num(load.swapWarnBelowFreePercent, base.load.swapWarnBelowFreePercent),
      psiWarnAvg10: num(load.psiWarnAvg10, base.load.psiWarnAvg10),
      psiCriticalAvg10: num(load.psiCriticalAvg10, base.load.psiCriticalAvg10),
      maxBunPerLivePane: num(load.maxBunPerLivePane, base.load.maxBunPerLivePane),
      minChainsToEndCritical: num(load.minChainsToEndCritical, base.load.minChainsToEndCritical),
      maxBunRssMb: num(load.maxBunRssMb, base.load.maxBunRssMb),
      maxTuiProcessesPerSession: num(load.maxTuiProcessesPerSession, base.load.maxTuiProcessesPerSession),
    },
    credentials: {
      expiryWarnHours: num(cred.expiryWarnHours, base.credentials.expiryWarnHours),
      quotaWarnUsedPercent: num(cred.quotaWarnUsedPercent, base.credentials.quotaWarnUsedPercent),
    },
  };
}

export function pregateSlotCap(policy: ResPolicy, host: string): number {
  return policy.pregateSlots[host] ?? policy.defaultPregateSlots;
}

export function loadCeiling(policy: ResPolicy, host: string): ResHostLoadCeiling {
  return policy.load.perHost[host] ?? { warnLoad1: policy.load.warnLoad1, criticalLoad1: policy.load.criticalLoad1 };
}

export function vmHourlyUsd(policy: ResPolicy, host: string): number {
  return policy.vm.hourlyUsd[host] ?? policy.vm.defaultHourlyUsd;
}

/** What a seat, tool or the patrol wants to do. */
export type ResAction =
  | { readonly kind: 'test'; readonly host: string; readonly universe?: 'test' | 'ops' }
  | { readonly kind: 'pregate'; readonly host: string; readonly inflight: number; readonly inflightByHost?: Readonly<Record<string, number>> }
  | { readonly kind: 'vm-start'; readonly host: string; readonly pressure: boolean; readonly spentTodayUsd: number }
  | { readonly kind: 'vm-stop'; readonly host: string; readonly idleMinutes: number }
  | { readonly kind: 'vm-keep-on'; readonly host: string };

export interface ResDecision {
  readonly verdict: ResVerdict;
  readonly rule: string;
  readonly detail: string;
  readonly alternatives?: readonly string[];
}

const lc = (host: string) => host.trim().toLowerCase();
const has = (list: readonly string[], host: string) => list.some((entry) => lc(entry) === lc(host));

/** Pure policy decision — no I/O. Every path names the rule it used. */
export function decideResAction(policy: ResPolicy, action: ResAction): ResDecision {
  const host = action.host;
  if (action.kind === 'test' || action.kind === 'pregate') {
    if (has(policy.forbiddenTestHosts, host)) return { verdict: 'deny', rule: 'forbidden-test-host', detail: `${host} is forbidden for tests (HQ)`, alternatives: policy.preApprovedTestHosts };
    if (action.kind === 'test') {
      if (has(policy.preApprovedTestHosts, host) && (action.universe ?? 'test') === 'test')
        return { verdict: 'allow', rule: 'pre-approved-test-host', detail: `${host} is pre-approved for the read-only test universe` };
      if (has(policy.preApprovedTestHosts, host)) return { verdict: 'ask', rule: 'ops-universe-needs-res', detail: `${host}: ops-universe work is outside the pre-approval` };
      if (has(policy.cloudHosts, host)) return { verdict: 'ask', rule: 'cloud-host-needs-budget', detail: `${host} is a paid VM` };
      return { verdict: 'ask', rule: 'unknown-host', detail: `${host} is not in the RES policy` };
    }
    if (!has(policy.preApprovedTestHosts, host)) {
      return has(policy.cloudHosts, host)
        ? { verdict: 'ask', rule: 'cloud-host-needs-budget', detail: `${host} is a paid VM` }
        : { verdict: 'ask', rule: 'unknown-host', detail: `${host} is not in the RES policy` };
    }
    const cap = pregateSlotCap(policy, host);
    if (action.inflight < cap) return { verdict: 'allow', rule: 'pregate-slot-free', detail: `${host} ${action.inflight}/${cap} slots in use` };
    const alternatives = policy.preApprovedTestHosts.filter((other) => lc(other) !== lc(host)
      && (action.inflightByHost?.[other] ?? 0) < pregateSlotCap(policy, other));
    return { verdict: 'deny', rule: 'pregate-slot-full', detail: `${host} ${action.inflight}/${cap} slots in use`, alternatives };
  }
  if (!has(policy.cloudHosts, host)) return { verdict: 'deny', rule: 'not-a-cloud-host', detail: `${host} is not a cloud VM in the RES policy` };
  if (action.kind === 'vm-keep-on') return { verdict: 'deny', rule: 'forbidden-always-on-vm', detail: `${host}: always-on cloud VMs are forbidden` };
  if (action.kind === 'vm-stop') {
    return action.idleMinutes >= policy.vm.stopAfterIdleMinutes
      ? { verdict: 'allow', rule: 'vm-idle-stop', detail: `${host} idle ${action.idleMinutes}m ≥ ${policy.vm.stopAfterIdleMinutes}m` }
      : { verdict: 'deny', rule: 'vm-not-idle', detail: `${host} idle ${action.idleMinutes}m < ${policy.vm.stopAfterIdleMinutes}m` };
  }
  if (!action.pressure) return { verdict: 'deny', rule: 'vm-no-pressure', detail: `${host}: local hosts have room` };
  const projected = action.spentTodayUsd + vmHourlyUsd(policy, host) * policy.vm.startBudgetHours;
  if (projected > policy.vm.dailyBudgetUsd)
    return { verdict: 'ask', rule: 'vm-budget-cap', detail: `${host}: $${projected.toFixed(2)} projected > $${policy.vm.dailyBudgetUsd} daily cap` };
  return { verdict: 'allow', rule: 'vm-start-within-budget', detail: `${host}: $${projected.toFixed(2)} projected ≤ $${policy.vm.dailyBudgetUsd} daily cap` };
}

/** One observable line per decision: `res.policy allowed {rule}` (and denied / ask). */
export function logResDecision(action: ResAction, decision: ResDecision, extra: Record<string, unknown> = {}): void {
  const event = decision.verdict === 'allow' ? 'allowed' : decision.verdict === 'deny' ? 'denied' : 'ask';
  debug.log('res.policy', event, { rule: decision.rule, action: action.kind, host: action.host, detail: decision.detail, ...extra });
}
