import { execFile } from 'node:child_process';
import type { UserConfig } from '../user-config/types.js';
import type { CloudVmAdapter } from '../release-loop/cloud-vm-adapter.js';
import { createCommandCloudVmAdapter } from '../release-loop/cloud-vm-adapter.js';
import { NODE_REGISTRY, type PodPoolMember, type PodPoolScheduler } from '../task-orchestrator/surfaces/pod-pool.js';
import { ResourceLedger } from '../control-plane/ledger.js';
import { debug } from '../debug/log.js';
import { reconcileCloudBurstAuto, type CloudBurstAutoInput, type CloudBurstVmHost } from './cloud-burst-auto.js';
import type { BurstPurpose, BurstTtlHours } from './burst-auto-within-budget.js';

export interface CloudBurstRuntimeConfig {
  readonly joinCommand?: string;
  readonly host: CloudBurstVmHost;
  readonly context: string;
  readonly capacity: number;
  readonly threshold: number;
  readonly hourlyCostKrw: number;
  readonly ttlHours: BurstTtlHours;
  readonly imageDigest: string;
  readonly owner: string;
  readonly purpose: BurstPurpose;
}

/** Read a complete, explicit opt-in from preserved raw config; invalid or absent data stays disabled. */
export function cloudBurstRuntimeConfig(config: UserConfig): CloudBurstRuntimeConfig | undefined {
  const fleet = config.raw.fleet;
  if (!fleet || typeof fleet !== 'object' || Array.isArray(fleet)) return undefined;
  const burst = (fleet as Record<string, unknown>).cloudBurst;
  if (!burst || typeof burst !== 'object' || Array.isArray(burst)) return undefined;
  const raw = burst as Record<string, unknown>;
  const valid = typeof raw.joinCommand === 'string' && raw.joinCommand.startsWith('/')
    && (raw.host === 'aws2' || raw.host === 'aws3' || raw.host === 'gcp2')
    && typeof raw.context === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(raw.context)
    && Number.isSafeInteger(raw.capacity) && Number(raw.capacity) > 0
    && Number.isSafeInteger(raw.threshold) && Number(raw.threshold) > 0
    && Number.isSafeInteger(raw.hourlyCostKrw) && Number(raw.hourlyCostKrw) > 0
    && (raw.ttlHours === 2 || raw.ttlHours === 4)
    && typeof raw.imageDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(raw.imageDigest)
    && typeof raw.owner === 'string' && raw.owner.trim().length > 0
    && (raw.purpose === 'gate' || raw.purpose === 'implementation' || raw.purpose === 'execution');
  if (!valid) return undefined;
  return { joinCommand: raw.joinCommand as string, host: raw.host as CloudBurstVmHost, context: raw.context as string,
    capacity: Number(raw.capacity), threshold: Number(raw.threshold), hourlyCostKrw: Number(raw.hourlyCostKrw),
    ttlHours: raw.ttlHours as BurstTtlHours, imageDigest: raw.imageDigest as string, owner: raw.owner as string,
    purpose: raw.purpose as BurstPurpose };
}

export function reservedCloudBurstMember(config: CloudBurstRuntimeConfig): PodPoolMember {
  return { context: config.context, sshHost: config.host, capacity: 0, k3dCluster: 'elanous-pool', federationRole: 'cloud',
    imageRef: `${NODE_REGISTRY}/elanous-harness@${config.imageDigest}` };
}

export function cloudPoolImageDigestReady(context: string, expectedDigest: string,
  kubectl: (args: readonly string[]) => { status: number | null; stdout: string }): boolean {
  const result = kubectl(['--context', context, '--request-timeout=10s', 'get', 'nodes', '-o', 'json']);
  if (result.status !== 0) return false;
  try {
    const nodes = (JSON.parse(result.stdout) as { items?: Array<{ status?: { conditions?: Array<{ type?: string; status?: string }>; images?: Array<{ names?: string[] }> } }> }).items ?? [];
    const ready = nodes.filter(node => node.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True'));
    return ready.length > 0 && ready.every(node => node.status?.images?.some(image => image.names?.some(name => name.endsWith(`@${expectedDigest}`))) === true);
  } catch { return false; }
}

function invokeJoinCommand(command: string, host: CloudBurstVmHost, capacity: number, imageDigest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, [host, '--caps', String(capacity), '--image-digest', imageDigest], { encoding: 'utf8', timeout: 35 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => { // Source: cloud-join may wait through boot, rail, image verification and worker checks.
      if (!error) { resolve(); return; }
      reject(new Error(`cloud join command failed: ${error.message}${stderr.trim() ? ` · ${stderr.trim()}` : ''}${stdout.trim() ? ` · ${stdout.trim()}` : ''}`));
    });
  });
}

/** Connect observed Pod starvation to the budgeted controller; no settings means telemetry only. */
export function installCloudBurstAuto(input: {
  readonly pool: PodPoolScheduler;
  readonly config?: CloudBurstRuntimeConfig;
  readonly join?: (host: CloudBurstVmHost, capacity: number) => Promise<void>;
  readonly cloudVmCommand?: string;
  readonly cloudVm?: CloudVmAdapter;
  readonly ledger?: ResourceLedger;
  readonly isWarm: (member: PodPoolMember, expectedImageDigest: string) => Promise<boolean>;
  readonly runJoinCommand?: (command: string, args: string[]) => Promise<void>;
  readonly now?: () => number;
  readonly reconcileIntervalMs?: number;
}): () => void {
  const config = input.config;
  const ledger = input.ledger ?? new ResourceLedger();
  let inFlight: Promise<void> | undefined;
  let pendingPressure: { queueDepth: number; blockedCount: number; reason: string } | undefined;
  let observedRequestId: string | undefined;
  const canJoin = (): boolean => Boolean(config && (input.join || config.joinCommand)
    && (input.cloudVm || input.cloudVmCommand));
  const reconcilePressure = async (pressure: { queueDepth: number; blockedCount: number; reason: string }): Promise<void> => {
    if (!config || !canJoin()) return;
    const now = (input.now ?? Date.now)();
    const existing = ledger.list({ kind: 'universe', name: 'cloud-burst-lifecycle' }, now)
      .filter(row => row.attrs.type === 'cloud-burst-lifecycle' && row.attrs.host === config.host && row.attrs.state !== 'stopped')
      .sort((a, b) => b.observedAt - a.observedAt)[0];
    const requestId = typeof existing?.attrs.requestId === 'string' ? existing.attrs.requestId : `pod-${config.host}-${Math.trunc(now)}`;
    observedRequestId = requestId;
    const vm = input.cloudVm ?? createCommandCloudVmAdapter(input.cloudVmCommand!, undefined, {
      reason: 'budgeted Pod federation capacity burst', source: 'fleet.cloudBurst',
    });
    const member = reservedCloudBurstMember(config);
    const burstInput: CloudBurstAutoInput = { requestId, owner: config.owner, host: config.host, purpose: config.purpose,
      now, queueDepth: pressure.queueDepth, blockedCount: pressure.blockedCount, threshold: config.threshold,
      imageDigest: config.imageDigest, hourlyCostKrw: config.hourlyCostKrw, ttlHours: config.ttlHours };
    const result = await reconcileCloudBurstAuto(burstInput, {
      ledger,
      cloudVm: vm,
      join: host => input.join ? input.join(host, config.capacity)
        : input.runJoinCommand ? input.runJoinCommand(config.joinCommand!, [host, '--caps', String(config.capacity), '--image-digest', config.imageDigest])
          : invokeJoinCommand(config.joinCommand!, host, config.capacity, config.imageDigest),
      isWarm: async () => input.isWarm({ ...member, capacity: config.capacity }, config.imageDigest),
      activeLeases: host => input.pool.activeMemberLeases(config.context),
      admit: async () => { input.pool.enableCloudMember({ ...member, capacity: config.capacity }); },
      withdraw: async () => input.pool.disableCloudMember(config.context),
    });
    debug.log('fleet.cloud-burst', 'reconciled', { requestId, state: result.state, admissionAt: result.admissionAt ?? null });
  };
  input.pool.setCloudStarvationHandler(async pressure => {
    debug.log('fleet.cloud-burst', 'admit-starved', { ...pressure, configured: canJoin() }, { level: 'warn' });
    if (!canJoin()) return;
    if (inFlight) { pendingPressure = pressure; return inFlight; }
    inFlight = (async () => {
      let next: typeof pressure | undefined = pressure;
      try {
        while (next) {
          pendingPressure = undefined;
          try { await reconcilePressure(next); }
          catch (error) { debug.log('fleet.cloud-burst', 'reconcile-failed', { requestId: observedRequestId ?? null, error: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
          next = pendingPressure;
        }
      } finally { inFlight = undefined; pendingPressure = undefined; }
    })();
    return inFlight;
  });
  // Source: CONDUCTOR §6c requires a zero-demand stop even when no caller remains in tryAcquire.
  const timer = setInterval(() => {
    void input.pool.reconcileCloudCapacity('periodic zero-demand and TTL reconciliation').catch(error =>
      debug.log('fleet.cloud-burst', 'periodic-reconcile-failed', { error: error instanceof Error ? error.message : String(error) }, { level: 'warn' }));
  }, input.reconcileIntervalMs ?? 60_000); // Source: a one-minute reconciliation cadence bounds idle shutdown delay.
  (timer as { unref?: () => void }).unref?.();
  debug.log('fleet.cloud-burst', 'runtime-installed', { configured: Boolean(config), host: config?.host ?? null, requestId: observedRequestId ?? null });
  return () => clearInterval(timer);
}
