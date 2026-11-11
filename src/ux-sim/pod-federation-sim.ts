import { PodPoolScheduler, type MemberOccupancy, type PodPoolMember } from '../task-orchestrator/surfaces/pod-pool.js';
import { createFakeFleetDevice } from './fake-fleet.js';
import { createFakeCloudVm } from './fake-cloud-vm.js';
import { ResourceLedger } from '../control-plane/ledger.js';
import { reconcileCloudBurstAuto, type CloudBurstAutoInput } from '../fleet/cloud-burst-auto.js';

// Source: 내부 문서 `pod-federation-mapreduce` §5 specifies a virtual 15-minute cloud join.
const CLOUD_JOIN_MS = 15 * 60_000;

export interface FederationBinding {
  readonly runId: string;
  readonly nodeId: string;
  readonly gate: boolean;
  readonly attempt: number;
  readonly host: string | null;
  readonly context: string | null;
  readonly at: number;
}

interface Work {
  readonly runId: string;
  readonly nodeId: string;
  readonly gate: boolean;
  attempt: number;
  member: PodPoolMember | null;
}

const workKey = (runId: string, nodeId: string): string => `${runId}\0${nodeId}`;

/** Deterministic, network-free federation rig using the production placement scheduler. */
export function createPodFederationSim() {
  // Source: 내부 문서 `pod-federation-mapreduce` §2 requires host-specific capacity and a protected gate host.
  const members: PodPoolMember[] = [
    { context: 'pool-minim5', sshHost: 'minim5', capacity: 1, k3dCluster: 'elanous-pool', federationRole: 'task' },
    { context: 'pool-mshq', sshHost: 'mshq', capacity: 2, k3dCluster: 'elanous-pool', federationRole: 'task' },
    { context: 'pool-gate', sshHost: 'gate', capacity: 1, k3dCluster: 'elanous-pool', federationRole: 'gate' },
    { context: 'pool-cloud', sshHost: 'cloud', capacity: 2, k3dCluster: 'elanous-pool', federationRole: 'cloud' },
  ];
  const fleet = createFakeFleetDevice({ clusters: members.map((member) => ({
    host: member.sshHost!, context: member.context, nodes: [`node-${member.sshHost}`],
  })) });
  fleet.setHostOnline('cloud', false);
  const cloud = createFakeCloudVm();
  let cloudStarted = false;
  const work = new Map<string, Work>();
  const completedWork = new Set<string>();
  const history: FederationBinding[] = [];
  const acceptedPieces = new Map<string, { runId: string; nodeId: string; attempt: number }>();
  const occupancy = (): Record<string, MemberOccupancy> => Object.fromEntries(members.map((member) => {
    const response = fleet.kubectl(['--context', member.context, '-n', 'elanous-test', 'get', 'pods', '-o', 'json']);
    if (response.status !== 0) return [member.context, { occupied: null, reason: response.stderr }];
    try {
      const pods = (JSON.parse(response.stdout) as { items: Array<{ status?: { phase?: string } }> }).items;
      return [member.context, { occupied: pods.filter((pod) => pod.status?.phase === 'Running' || pod.status?.phase === 'Pending').length }];
    } catch { return [member.context, { occupied: null, reason: 'invalid fake PodList' }]; }
  }));
  const scheduler = new PodPoolScheduler(members, { occupancy });
  const unavailable = (): Set<string> => new Set(members.filter((member) => !fleet.hostOnline(member.sshHost!)).map((member) => member.context));
  let automaticBurstPromise: Promise<unknown> | undefined;

  async function bind(item: Work): Promise<FederationBinding> {
    const member = await scheduler.tryAcquire(unavailable(), undefined, { gate: item.gate, waiterId: `${item.runId}:${item.nodeId}:${item.attempt}` });
    item.member = member;
    if (member?.sshHost === 'cloud') cloud.openLease('cloud-burst');
    const binding: FederationBinding = { runId: item.runId, nodeId: item.nodeId, gate: item.gate,
      attempt: item.attempt, host: member?.sshHost ?? null, context: member?.context ?? null, at: Date.now() };
    history.push(binding);
    return binding;
  }

  async function reconcileAutomaticBurst(input: CloudBurstAutoInput, ledger: ResourceLedger) {
    const host = input.host;
    return reconcileCloudBurstAuto(input, {
      ledger,
      cloudVm: {
        async start(requestedHost) {
          if (requestedHost !== host) throw new Error('sim cloud host changed');
          const state = cloudStarted ? cloud.status('cloud-burst').state : null;
          if (state === 'parked') cloud.resume('cloud-burst', { readyAfterMs: CLOUD_JOIN_MS });
          else if (!cloudStarted) {
            cloudStarted = true;
            cloud.createFromImage({ id: 'cloud-burst', imageDigest: input.imageDigest, hourlyCost: input.hourlyCostKrw,
              readyAfterMs: CLOUD_JOIN_MS, stopAfterAt: input.now + (1 + input.ttlHours) * 60 * 60_000, terminationProtected: true });
          }
        },
        async stop(requestedHost) {
          if (requestedHost !== host) throw new Error('sim cloud host changed');
          cloud.stop('cloud-burst'); fleet.setHostOnline('cloud', false);
        },
        async status(requestedHost) {
          if (requestedHost !== host) throw new Error('sim cloud host changed');
          const state = cloud.status('cloud-burst').state;
          return { host, state: state === 'ready' || state === 'warming' ? 'running' : state === 'parked' ? 'stopped' : 'unknown' };
        },
      },
      isWarm: async requestedHost => requestedHost === host && cloud.status('cloud-burst').state === 'ready',
      join: async requestedHost => { if (requestedHost !== host) throw new Error('sim cloud host changed'); },
      activeLeases: async requestedHost => requestedHost === host ? cloud.status('cloud-burst').activeLeases : 0,
      admit: async requestedHost => { if (requestedHost === host) { fleet.setHostOnline('cloud', true); scheduler.enableCloudMember(members.find(member => member.federationRole === 'cloud')!); } },
      withdraw: async requestedHost => { if (requestedHost === host) { scheduler.disableCloudMember('pool-cloud'); fleet.setHostOnline('cloud', false); } },
    });
  }

  return {
    async place(input: { runId: string; nodeId: string; gate?: boolean }): Promise<FederationBinding | null> {
      const key = workKey(input.runId, input.nodeId);
      if (work.has(key) || completedWork.has(key)) throw new Error('federation work ID cannot be reused');
      const item: Work = { runId: input.runId, nodeId: input.nodeId, gate: input.gate === true, attempt: 1, member: null };
      work.set(key, item);
      const binding = await bind(item);
      return binding.host ? binding : null;
    },
    async hostDown(host: string): Promise<Array<Pick<FederationBinding, 'runId' | 'nodeId' | 'attempt' | 'host'>>> {
      fleet.setHostOnline(host, false);
      if (host === 'cloud' && cloudStarted) cloud.disappear('cloud-burst');
      const moved: Array<Pick<FederationBinding, 'runId' | 'nodeId' | 'attempt' | 'host'>> = [];
      for (const item of work.values()) {
        if (item.member?.sshHost !== host) continue;
        scheduler.release(item.member);
        item.member = null;
        item.attempt += 1;
        const binding = await bind(item);
        moved.push({ runId: binding.runId, nodeId: binding.nodeId, attempt: binding.attempt, host: binding.host });
      }
      return moved;
    },
    async resumeWaiting(): Promise<Array<Pick<FederationBinding, 'runId' | 'nodeId' | 'attempt' | 'host'>>> {
      const resumed: Array<Pick<FederationBinding, 'runId' | 'nodeId' | 'attempt' | 'host'>> = [];
      for (const item of work.values()) {
        if (item.member) continue;
        const binding = await bind(item);
        if (binding.host) resumed.push({ runId: binding.runId, nodeId: binding.nodeId, attempt: binding.attempt, host: binding.host });
      }
      return resumed;
    },
    finish(input: { runId: string; nodeId: string; attempt: number; pieceId: string }): 'accepted' | 'stale-attempt' | 'already-accepted' {
      const item = work.get(workKey(input.runId, input.nodeId));
      const previous = acceptedPieces.get(input.pieceId);
      if (!item && previous?.runId === input.runId && previous.nodeId === input.nodeId && previous.attempt === input.attempt)
        return 'already-accepted';
      if (!item || input.attempt !== item.attempt || !item.member) return 'stale-attempt';
      if (previous) return previous.runId === input.runId && previous.nodeId === input.nodeId
        && previous.attempt === input.attempt ? 'already-accepted' : 'stale-attempt';
      acceptedPieces.set(input.pieceId, { runId: input.runId, nodeId: input.nodeId, attempt: input.attempt });
      scheduler.release(item.member);
      if (item.member.sshHost === 'cloud') cloud.closeLease('cloud-burst');
      work.delete(workKey(input.runId, input.nodeId));
      completedWork.add(workKey(input.runId, input.nodeId));
      return 'accepted';
    },
    startCloudBurst(): void {
      if (![...work.values()].some((item) => !item.member && !item.gate)) throw new Error('cloud burst requires waiting task work');
      if (cloudStarted) {
        if (cloud.status('cloud-burst').state !== 'parked') throw new Error('cloud burst already started');
        cloud.resume('cloud-burst', { readyAfterMs: CLOUD_JOIN_MS });
      } else {
        cloudStarted = true;
        cloud.createFromImage({ id: 'cloud-burst', imageDigest: 'sha256:simulated', hourlyCost: 0,
          readyAfterMs: CLOUD_JOIN_MS, terminationProtected: true });
      }
    },
    joinCloud(): boolean {
      if (!cloudStarted) return false;
      if (cloud.status('cloud-burst').state !== 'ready') return false;
      fleet.setHostOnline('cloud', true);
      return true;
    },
    parkCloud(): boolean {
      if (!cloudStarted || !fleet.hostOnline('cloud') || cloud.status('cloud-burst').activeLeases > 0) return false;
      cloud.stop('cloud-burst');
      fleet.setHostOnline('cloud', false);
      return true;
    },
    resetCloudAdmission(): void { scheduler.disableCloudMember('pool-cloud'); },
    cloudMemberCapacity(): number { return scheduler.members.find(member => member.context === 'pool-cloud')?.capacity ?? 0; },
    reconcileAutomaticBurst,
    connectAutomaticBurst(input: CloudBurstAutoInput, ledger: ResourceLedger) {
      scheduler.setCloudStarvationHandler(async pressure => {
        automaticBurstPromise = reconcileAutomaticBurst({ ...input, now: Date.now(), queueDepth: pressure.queueDepth,
          blockedCount: pressure.blockedCount }, ledger);
        await automaticBurstPromise;
      });
    },
    async waitAutomaticBurst() { await automaticBurstPromise; },
    async reconcilePoolDemand(reason = 'simulated waiter set changed') {
      await scheduler.reconcileCloudCapacity(reason);
      await automaticBurstPromise;
    },
    cloudStatus: () => cloud.status('cloud-burst'),
    cloudEvents: () => cloud.events(),
    bindings: (): FederationBinding[] => history.map((row) => ({ ...row })),
    lostWork: (): Array<{ runId: string; nodeId: string }> => [...work.values()].filter((item) => !item.member)
      .map(({ runId, nodeId }) => ({ runId, nodeId })),
    fleetCalls: () => fleet.kubectlCalls.map((call) => ({ ...call, args: [...call.args] })),
  };
}
