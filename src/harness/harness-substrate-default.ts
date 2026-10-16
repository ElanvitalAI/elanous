import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadavg, cpus, freemem } from 'node:os';
import { effectiveInstanceRoot, prodInstanceRoot, treeDerivedRootFor } from '../instance/resolve.js';
import { getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { buildUserConfig, getUserConfig, type UserConfig } from '../user-config.js';
import { resolveCodexQuotaPolicy } from '../oauth/codex-quota-policy.js';
import { debug } from '../debug/log.js';
import type { PoolLeaseRecommendation } from '../task-orchestrator/surfaces/pod-lease.js';
import type { PodPoolMember, PoolKubectl } from '../task-orchestrator/surfaces/pod-pool.js';

/** Key-order-insensitive JSON so equal per-account caps written in another order do not warn. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : v);
}

function readOperationalLaunchConfig(path: string): UserConfig | null {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (err) {
    // Only a missing file (fresh install, CI, isolated fixtures) means «no operational policy»; permission or I/O errors refuse.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`launch policy: 운영 config 를 읽을 수 없다 — ${path}`);
  }
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new Error(`launch policy: 운영 config 를 읽을 수 없다 — ${path}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`launch policy: 운영 config 형식이 잘못됐다 — ${path}`);
  return buildUserConfig(path);
}

/** Launch policy belongs to the host, not to the materialized config in a derived worktree.
 * Explicit test/config universes remain isolated; this only applies to tree-derived launches. */
export function harnessLaunchPolicyConfig(options: {
  derived?: UserConfig;
  operationalRoot?: string;
  derivedRoot?: string;
  warn?: (line: string) => void;
  /** Reads the operational config at `path`; injected by tests so they never touch the host's real config. */
  readOperational?: (path: string) => UserConfig | null;
} = {}): UserConfig {
  const derived = options.derived ?? getUserConfig();
  const operationalRoot = options.operationalRoot ?? prodInstanceRoot();
  const derivedRoot = options.derivedRoot ?? effectiveInstanceRoot();
  const isDerived = options.derivedRoot !== undefined
    ? derivedRoot !== operationalRoot
    : derivedRoot !== operationalRoot && !getElanousConfigDirOverride() && (
      process.env.ELANOUS_STATE_DIR_SOURCE === 'derived'
      || derivedRoot === treeDerivedRootFor(process.cwd())
    );
  if (!isDerived) return derived;
  const path = join(operationalRoot, 'config.json');
  const operational = (options.readOperational ?? readOperationalLaunchConfig)(path);
  if (!operational) {
    (options.warn ?? console.error)(`⚠️ launch policy: 운영 config 가 없다 (${path}) — 이 우주의 정책으로 발사`);
    return derived;
  }
  const policy = (config: UserConfig) => ({
    quota: resolveCodexQuotaPolicy(config.llm).policy,
    accountLimits: config.llm?.codexAccountRotationThresholdPercentByAccount,
    fallbackChain: config.llm?.fallbackChain,
    childLlm: config.tools?.selfImplement?.childLlm,
    budgetGate: config.harness?.budgetGate,
    podPool: config.harness?.podPool ?? config.pod?.pool,
    grokApiKeyOptIn: config.harness?.pod?.grokApiKeyOptIn === true,
  });
  const actual = policy(derived);
  const expected = policy(operational);
  if (derived.llm?.codexQuotaPolicy === undefined && derived.llm?.codexCreditsAllowed === undefined
    || stableJson(actual) !== stableJson(expected)) {
    (options.warn ?? console.error)('⚠️ launch policy: 파생 시험 우주 정책이 없거나 운영과 다르다 — 운영 정책으로 발사');
  }
  return operational;
}

export type HarnessSubstrate = 'local' | 'pod';
export interface ResolvedHarnessSubstrate {
  substrate: HarnessSubstrate;
  pool: string | null;
  source: 'flag' | 'config' | 'default';
}

/** Conservative local headroom for one standard harness goal (the Pod lease's default per-goal size). */
export const AUTO_LOCAL_MIN_AVAILABLE_MEMORY_BYTES = 16 * 1024 ** 3;

export interface AutoSubstrateSignals {
  /** A blocked memory admission has recommended=0 and limitedBy=memory; unknown is not blocked. */
  podAdmission: Pick<PoolLeaseRecommendation, 'recommended' | 'limitedBy'> | null;
  load1: number | null;
  cores: number | null;
  availableMemoryBytes: number | null;
  localLaneOpen: boolean;
}

export interface AutoSubstrateDecision {
  substrate: HarnessSubstrate;
  reason: string;
}

export interface AutoSubstrateReadDeps {
  loadavg?: typeof loadavg;
  cpus?: typeof cpus;
  freemem?: typeof freemem;
  podAdmission?: () => AutoSubstrateSignals['podAdmission'];
  localLaneOpen?: () => boolean;
  /** Resolved by the launch decision, using its flag → env → config → context precedence. */
  pool?: string | null;
  config?: Pick<UserConfig, 'harness' | 'pod'>;
  measurePoolLease?: typeof import('../task-orchestrator/surfaces/pod-lease.js').measurePoolLease;
}

/** Read Pod admission using the same pool, usage and account inputs as dispatch backpressure. */
function readAutoPodAdmission(deps: AutoSubstrateReadDeps): AutoSubstrateSignals['podAdmission'] {
  // Keep Pod lease dependencies lazy for local-only launches.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { leaseKubectl, measurePoolLease, recommendConcurrency } = require('../task-orchestrator/surfaces/pod-lease.js') as typeof import('../task-orchestrator/surfaces/pod-lease.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parsePodPool, resolvePodPoolSpec } = require('../task-orchestrator/surfaces/pod-pool.js') as typeof import('../task-orchestrator/surfaces/pod-pool.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { listCodexAccountsInStore } = require('../oauth/codex-account-store.js') as typeof import('../oauth/codex-account-store.js');
  // A direct collector call can resolve its own pool. The launch resolver passes a string or null
  // explicitly so it never substitutes another universe's pool when the launch pool is unreadable.
  const fallback = deps.pool === undefined ? (deps.config ?? getUserConfig()) : null;
  const spec = fallback ? resolvePodPoolSpec(undefined, process.env, () => fallback.harness?.podPool ?? fallback.pod?.pool) : null;
  const current = fallback && !spec ? leaseKubectl(['config', 'current-context']) : null;
  const pool = deps.pool === undefined ? (spec ?? (current?.status === 0 ? current.stdout.trim() : null)) : deps.pool;
  if (!pool) return null;
  const members = parsePodPool(pool);
  const measure = (deps.measurePoolLease ?? measurePoolLease)(members, { measureUsage: true, skipDnsProbe: true });
  let accounts = -1;
  try { accounts = listCodexAccountsInStore().length; } catch { /* Accounts are only observed, not a limit. */ }
  const { recommended, limitedBy } = recommendConcurrency(measure, {
    capacity: members.reduce((sum, member) => sum + member.capacity, 0),
    accounts, perAccount: (deps.config ?? getUserConfig()).pod?.lease?.perAccount ?? 4,
  });
  return recommended === null || limitedBy === null ? null : { recommended, limitedBy };
}

/** Collect observations on the launch host; an unreadable Pod recommendation is not a refusal. */
export function readAutoSubstrateSignals(deps: AutoSubstrateReadDeps = {}): AutoSubstrateSignals {
  let podAdmission: AutoSubstrateSignals['podAdmission'];
  try { podAdmission = (deps.podAdmission ?? (() => readAutoPodAdmission(deps)))() ?? null; }
  catch { podAdmission = null; }
  if (podAdmission?.recommended === null || podAdmission?.limitedBy === null) podAdmission = null;
  return {
    load1: (deps.loadavg ?? loadavg)()[0],
    cores: (deps.cpus ?? cpus)().length,
    availableMemoryBytes: (deps.freemem ?? freemem)(),
    podAdmission,
    localLaneOpen: deps.localLaneOpen?.() ?? false,
  };
}

export interface NextLocalLaneCapInput {
  current: number;
  wanted: number;
  lastRaisedAtMs: number | null;
  nowMs: number;
  load1: number | null;
  cores: number | null;
}

export interface NextLocalLaneCapDecision {
  cap: number;
  action: 'raise' | 'hold' | 'lower';
  reason: string;
}

/** Decide one conservative local-lane cap adjustment from the current observations. */
export function nextLocalLaneCap({ current, wanted, lastRaisedAtMs, nowMs, load1, cores }: NextLocalLaneCapInput): NextLocalLaneCapDecision {
  let decision: NextLocalLaneCapDecision;
  if (load1 === null || cores === null || !Number.isFinite(load1) || !Number.isFinite(cores) || load1 < 0 || cores <= 0) {
    decision = { cap: current, action: 'hold', reason: 'load-unreadable' };
  } else if (load1 >= cores) {
    decision = { cap: Math.max(0, current - 5), action: 'lower', reason: 'local-load-overloaded' };
  } else if (!Number.isFinite(current) || !Number.isFinite(wanted) || !Number.isFinite(nowMs)) {
    decision = { cap: current, action: 'hold', reason: 'cap-or-time-unreadable' };
  } else if (wanted <= current) {
    decision = { cap: current, action: 'hold', reason: 'no-increase-requested' };
  } else if (load1 >= cores / 2) {
    decision = { cap: current, action: 'hold', reason: 'local-load-not-spare' };
  } else if (lastRaisedAtMs !== null && (!Number.isFinite(lastRaisedAtMs) || nowMs - lastRaisedAtMs < 15 * 60 * 1000)) {
    decision = { cap: current, action: 'hold', reason: 'raise-cooldown' };
  } else {
    decision = { cap: Math.min(wanted, current + 5), action: 'raise', reason: 'local-load-spare' };
  }
  debug.log('harness.guardian', 'lane-step', { current, wanted, lastRaisedAtMs, nowMs, load1, cores, ...decision });
  return decision;
}

/** Pure routing judgment. Missing/invalid observations are not evidence that the host has room. */
export function routeAutoSubstrate(signals: AutoSubstrateSignals): AutoSubstrateDecision {
  const { podAdmission, load1, cores, availableMemoryBytes, localLaneOpen } = signals;
  if (podAdmission === null || podAdmission.recommended === null || podAdmission.limitedBy === null)
    return { substrate: 'pod', reason: 'pod-admission-unobserved' };
  if (podAdmission.recommended !== 0 || podAdmission.limitedBy !== 'memory')
    return { substrate: 'pod', reason: 'pod-admission-not-memory-blocked' };
  if (!localLaneOpen) return { substrate: 'pod', reason: 'local-lane-closed' };
  if (cores === null || !Number.isFinite(cores) || cores <= 0 || load1 === null || !Number.isFinite(load1) || load1 < 0 || load1 >= cores / 2)
    return { substrate: 'pod', reason: 'local-load-not-spare' };
  if (availableMemoryBytes === null || !Number.isFinite(availableMemoryBytes) || availableMemoryBytes < AUTO_LOCAL_MIN_AVAILABLE_MEMORY_BYTES)
    return { substrate: 'pod', reason: 'local-memory-not-spare' };
  return { substrate: 'local', reason: 'pod-memory-blocked-local-spare' };
}

/**
 * POD-POOL-UNCAPPED-SPEC — the pre-launch pool check of an «implicit» Pod pool (the current kube context),
 * reported in context names. `unmeasured` = kubectl itself could not run, so nothing was measured:
 * «unknown» is not «unfit» (same rule as LAUNCH-STALL's unreadable member memory).
 */
export interface HarnessPoolCheck {
  ok: boolean;
  ready: string[];
  dropped: { context: string; reason: string }[];
  unmeasured?: string | null;
}

/** `checkPodPool` over one pool spec — a kube context that cannot answer before launch is refused, not silently kept. */
export function checkHarnessPodPool(pool: string, run?: PoolKubectl): HarnessPoolCheck {
  // Lazy require: the Pod surface pulls `bun:ffi`, and only a Pod launch without an explicit pool needs it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const surface = require('../task-orchestrator/surfaces/pod-pool.js') as typeof import('../task-orchestrator/surfaces/pod-pool.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const leaseKubectl = run ?? (require('../task-orchestrator/surfaces/pod-lease.js') as typeof import('../task-orchestrator/surfaces/pod-lease.js')).leaseKubectl;
  let members: PodPoolMember[];
  try { members = surface.parsePodPool(pool); }
  catch (error) {
    return { ok: false, ready: [], dropped: [{ context: pool, reason: error instanceof Error ? error.message : String(error) }] };
  }
  let calls = 0;
  let unrunnable = 0;
  const kubectl: PoolKubectl = (args, input) => {
    const r = leaseKubectl(args, input);
    calls++;
    // Only «kubectl is not installed» (spawn ENOENT) is no verdict about the cluster. A kubectl that started but
    // timed out (status null · ETIMEDOUT) is a cluster that did not answer — that stays a measured refusal.
    if (r.status === null && /\bENOENT\b/.test(r.stderr)) unrunnable++;
    return r;
  };
  const checked = surface.checkPodPool(members, kubectl);
  if (!checked.ok && calls > 0 && unrunnable === calls) return { ok: true, ready: [], dropped: checked.dropped, unmeasured: 'kubectl 을 실행할 수 없다' };
  return { ok: checked.ok, ready: checked.ready.map((m) => m.context), dropped: checked.dropped };
}

/** Only inspect the current context when no explicit pool is available. Never turn an explicit Pod selection into local. */
export function resolveHarnessSubstrate({ flag, config, env, currentContext = () => {
  const result = spawnSync('kubectl', ['config', 'current-context'], { encoding: 'utf8', timeout: 5000 });
  return result.status === 0 ? result.stdout?.trim() : undefined;
  }, autoSignals, readAutoSignals, autoReadDeps, poolCheck = checkHarnessPodPool }: {
  flag?: { substrate?: HarnessSubstrate | 'auto'; podPool?: string };
  config?: Pick<UserConfig, 'harness' | 'pod'>;
  env?: NodeJS.ProcessEnv;
  currentContext?: () => string | undefined;
  /** Signals must come from the launch host and Pod admission, not a worktree's cached config. */
  autoSignals?: AutoSubstrateSignals;
  /** Inject the collector at the decision boundary; explicit requests never invoke it. */
  readAutoSignals?: () => AutoSubstrateSignals;
  /** Inject measurement dependencies without bypassing the default collector or pool selection. */
  autoReadDeps?: Omit<AutoSubstrateReadDeps, 'pool' | 'config' | 'podAdmission'>;
  /** POD-POOL-UNCAPPED-SPEC — pre-launch check of the implicit kube context; tests inject it instead of shelling out. */
  poolCheck?: (pool: string) => HarnessPoolCheck;
}): ResolvedHarnessSubstrate {
  const requested = flag?.substrate ?? config?.harness?.substrate ?? 'local';
  if (requested !== 'local' && requested !== 'pod' && requested !== 'auto') throw new Error('harness.substrate: local, pod 또는 auto 만 허용한다');
  const source = flag?.substrate ? 'flag' : config?.harness?.substrate ? 'config' : 'default';
  const explicit = flag?.podPool?.trim() || env?.ELANOUS_POD_POOL?.trim() || config?.harness?.podPool?.trim() || config?.pod?.pool?.trim();
  // Reuse the same pool choice for admission and launch; do not fall back to a different universe's pool.
  let implicit: string | undefined;
  let contextRead = false;
  const selectedPool = () => {
    if (explicit) return explicit;
    if (!contextRead) { implicit = currentContext()?.trim(); contextRead = true; }
    return implicit;
  };
  const signals = requested === 'auto'
    ? (autoSignals ?? (readAutoSignals ?? (() => readAutoSubstrateSignals({ ...autoReadDeps, pool: selectedPool() ?? null, config })))())
    : null;
  if (signals && autoSignals === undefined) debug.log('harness.substrate', 'auto-signals', {
    load1: signals.load1, cores: signals.cores, availableMemoryBytes: signals.availableMemoryBytes,
    podAdmission: signals.podAdmission, localLaneOpen: signals.localLaneOpen,
  });
  const decision = signals ? routeAutoSubstrate(signals) : null;
  const substrate: HarnessSubstrate = requested === 'auto' ? decision!.substrate : requested;
  if (decision) debug.log('harness.substrate', 'route', { substrate, reason: decision.reason, source });
  if (substrate === 'local') return { substrate, pool: null, source };
  const pool = selectedPool();
  if (!pool) throw new Error(`harness.substrate=${decision ? `auto→pod(${decision.reason})` : 'pod'}: Pod 풀 또는 현재 컨텍스트에 닿지 못했다 — 풀을 설정하거나 \`--substrate local\` 로 명시하라`);
  // POD-POOL-UNCAPPED-SPEC — an explicit pool is the operator's own statement and gets `checkPodPool` at the launch
  //   site (`src/index.ts` self orchestrate · `src/loops/orchestrator/tick.ts` · `pod-command-job.ts`). The implicit
  //   kube context had no such gate: a context whose cluster is gone, or whose `elanous-test` namespace is missing,
  //   sailed through here and then sat on `recommended=0` for 35 minutes (10-10 probe, 6 runs). Check before launch.
  if (!explicit) {
    const checked = poolCheck(pool);
    debug.log('harness.substrate', 'pool-check', { pool, origin: 'current-context', ok: checked.ok, ready: checked.ready, dropped: checked.dropped, unmeasured: checked.unmeasured ?? null });
    if (!checked.ok) {
      const why = checked.dropped.map((d) => `${d.context}: ${d.reason}`).join(' · ') || '노드가 하나도 준비되지 않았다';
      throw new Error(`harness.substrate=pod: 현재 컨텍스트 「${pool}」 이 발사 전 풀 점검을 넘지 못했다 — ${why} · 풀을 설정하거나 \`--substrate local\` 로 명시하라`);
    }
    if (checked.unmeasured) debug.log('harness.substrate', 'pool-check-unmeasured', { pool, reason: checked.unmeasured }, { level: 'warn' });
  }
  return { substrate, pool, source };
}

/** `dev --ask` → Pod dispatch input. Carries `--no-auto-merge` (commander: autoMerge === false) like the
 *  other Pod entrance, so a remote run never merges when the caller asked it not to. */
export function devAskPodDispatchInput(opts: { base?: string; autoMerge?: boolean }, goalFile: string, podPool: string): {
  entrance: 'cli-harness-ask'; input: string; podPool: string; base?: string; autoMerge?: false;
} {
  return {
    entrance: 'cli-harness-ask', input: goalFile, podPool,
    ...(opts.base !== undefined ? { base: opts.base } : {}),
    ...(opts.autoMerge === false ? { autoMerge: false as const } : {}),
  };
}
