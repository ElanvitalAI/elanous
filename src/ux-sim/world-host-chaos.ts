import { join } from 'node:path';
import { activeResourceLeases, beginResourceLease, heartbeatResourceLease, readResourceLedger, reconcileResourceLeases, RESOURCE_LANES, reapResourceLeaseIfCurrent } from '../resource-ledger/resource-ledger.js';
import type { ResourceFinding, ResourceLease, ResourceLedgerEvent, ResourceMeasurement } from '../resource-ledger/resource-ledger.js';
import { measurePoolLease } from '../task-orchestrator/surfaces/pod-lease.js';
import { measureMemberOccupancy, PodPoolScheduler, type PodPoolMember, type PoolKubectl } from '../task-orchestrator/surfaces/pod-pool.js';
import { createFakeKubectl } from './fake-kubectl.js';
import { createFakeFleetDevice } from './fake-fleet.js';
import { createFakeCloudVm } from './fake-cloud-vm.js';
import { createFakePsObserver, type FakePsDevice, type FakePsObserver } from './fake-ps.js';
import type { SimHostChaosFault, SimWorldSpec } from './world-schema.js';
import type { PendingChaosRecovery, WorldChaosClock, WorldChaosObservation, WorldHostChaosController } from './world-chaos-runtime.js';

type FakeHost = ReturnType<typeof createFakeKubectl>;
type HostReading = { selectedHost: string | null; schedulableCpuMillicores: number | null };

export function headquartersHandoffConverged(input: {
  readonly activeLeases: readonly ResourceLease[];
  readonly expectedFingerprint: string;
  readonly expectedProcessId: string;
  readonly survivor: string;
  readonly observedProcesses: ResourceMeasurement['processes'];
  readonly findings: readonly ResourceFinding[];
}): boolean {
  const handoffLeases = input.activeLeases.filter((lease) => lease.id === input.expectedFingerprint && lease.fp === input.expectedFingerprint);
  return handoffLeases.length === 1
    && handoffLeases[0]?.host === input.survivor
    && input.observedProcesses.filter((process) => process.id === input.expectedProcessId && process.fp === input.expectedFingerprint).length === 1
    && input.findings.length === 0;
}

function resourceLedgerRowIdentity(event: ResourceLedgerEvent): string {
  return JSON.stringify(event);
}

/** Recover the source lease from durable rows if a previous process stopped between reap and replacement. */
function recoverInterruptedHandoff(path: string, fingerprint: string, sourceHost: string, now: Date): void {
  const events = readResourceLedger(path);
  if (activeResourceLeases(events).some((lease) => lease.id === fingerprint)) return;
  let reapIndex = -1;
  for (let index = events.length - 1; index >= 0; index--) {
    const row = events[index];
    const sameLease = row?.event === 'lease-created' ? row.lease.id === fingerprint
      : (row?.event === 'lease-heartbeat' || row?.event === 'lease-ended' || row?.event === 'lease-reaped')
        && row.id === fingerprint;
    if (sameLease) { reapIndex = index; break; }
  }
  const reap = events[reapIndex];
  if (reap?.event !== 'lease-reaped' || reap.reason !== 'machine-disappeared') return;
  const previous = activeResourceLeases(events.slice(0, reapIndex)).find((lease) => lease.id === fingerprint && lease.host === sourceHost);
  if (!previous) return;
  try {
    beginResourceLease({ fp: previous.fp, host: previous.host, lane: previous.lane, resources: previous.resources,
      mission: previous.mission, ttlMs: previous.ttlMs, now }, path);
  } catch {
    // A concurrent retry may have restored the same identity; the caller re-reads and validates it.
  }
}
function durationMs(value: string): number {
  const match = /^\+(0|[1-9]\d*)(ms|s|m|h)$/.exec(value);
  if (!match) throw new Error(`invalid host fault duration: ${value}`);
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
  return Number(match[1]) * scale[match[2] as keyof typeof scale];
}

/** Host chaos uses production pool placement, the shared process inventory, and independent lease reconciliation. */
export function createWorldHostChaosController(input: {
  world: string;
  hosts: NonNullable<SimWorldSpec['hosts']>;
  devices: ReadonlyMap<string, unknown>;
  stateRoot?: string;
  baseTimeMs: number;
  clock: Pick<WorldChaosClock, 'now'>;
  processTable: FakePsDevice;
  fleet?: ReturnType<typeof createFakeFleetDevice>;
  cloudVm?: ReturnType<typeof createFakeCloudVm>;
  cloudVmIds?: Readonly<Record<string, string>>;
  onFaultStart?: (host: string) => void;
  awaitActiveRecovery?: (host: string) => Promise<void>;
  processObserver?: FakePsObserver;
  /** Fault seam for a failed handoff write; restoration still uses the real resource ledger writer. */
  createSurvivorLease?: typeof beginResourceLease;
}): WorldHostChaosController {
  const activeRecovery = Boolean(input.onFaultStart || input.awaitActiveRecovery);
  const observer = input.processObserver ?? createFakePsObserver(input.processTable);
  const devices = new Map(input.hosts.map((host) => {
    const key = input.hosts.length === 1 ? 'fake-kubectl' : `fake-kubectl:${host.name}`;
    const device = input.devices.get(key) as FakeHost | undefined;
    if (!device) throw new Error(`world host kubectl device missing: ${key}`);
    return [host.name, device] as const;
  }));
  const members: PodPoolMember[] = input.hosts.map((host) => ({
    context: `${input.world}-${host.name}-context`, sshHost: host.name,
    capacity: Math.max(1, Math.floor(host.cpu)), k3dCluster: `${input.world}-${host.name}`,
  }));
  const memberByHost = new Map(input.hosts.map((host, index) => [host.name, members[index]!]));
  const routeKubectl: PoolKubectl = (args, stdin) => {
    const contextIndex = args.indexOf('--context');
    const context = contextIndex >= 0 ? args[contextIndex + 1] : undefined;
    const host = input.hosts.find((candidate) => memberByHost.get(candidate.name)?.context === context);
    const device = host ? devices.get(host.name) : undefined;
    return device ? device.kubectl(args, stdin) : { status: 1, stdout: '', stderr: `unknown simulated host context: ${context ?? '(missing)'}` };
  };
  const dns = (context: string) => {
    const host = input.hosts.find((candidate) => memberByHost.get(candidate.name)?.context === context);
    return host && devices.get(host.name)?.hostState().egress && (input.fleet?.hostOnline(host.name) ?? true)
      ? 'ready' as const : 'dns' as const;
  };

  const read = async (): Promise<HostReading> => {
    const measured = measurePoolLease(members, { kubectl: routeKubectl, dns });
    const cpuValues = measured.members.map((member) => member.schedulableCpuMillicores);
    const schedulableCpuMillicores = cpuValues.every((value): value is number => value !== null && value !== undefined)
      ? cpuValues.reduce((sum, value) => sum + value, 0) : null;
    const measuredByContext = new Map(measured.members.map((row) => [row.context, row]));
    const selectable = members.map((member) => {
      const row = measuredByContext.get(member.context);
      const selectableCpu = row?.schedulableCpuMillicores;
      return { ...member, capacity: row?.capacity !== 0 && selectableCpu !== null && selectableCpu !== undefined && selectableCpu > 0
        ? Math.max(1, Math.floor(selectableCpu / 1_000)) : 0 };
    });
    const occupancy = measureMemberOccupancy(members, { kubectl: routeKubectl, dns });
    const scheduler = new PodPoolScheduler(selectable, { occupancy: () => occupancy });
    const selected = await scheduler.tryAcquire();
    const selectedHost = selected ? input.hosts.find((host) => memberByHost.get(host.name)?.context === selected.context)?.name ?? null : null;
    return { selectedHost, schedulableCpuMillicores };
  };

  return {
    async start(fault: SimHostChaosFault, atMs: number): Promise<PendingChaosRecovery> {
      if ('disaster' in fault) {
        if (!input.stateRoot) throw new Error('disaster requires a world state root');
        const target = fault.disaster.host;
        const targetDevice = devices.get(target)!;
        const killed = input.processTable.killHost(target);
        const headquarters = killed.find((process) => process.role === 'headquarters');
        if (!headquarters?.fingerprint || !headquarters.lane || !headquarters.mission) {
          throw new Error(`disaster host ${target} needs a declared headquarters process with fingerprint, lane, and mission`);
        }
        if (!RESOURCE_LANES.includes(headquarters.lane as typeof RESOURCE_LANES[number])) {
          throw new Error(`disaster headquarters process has unsupported resource lane: ${headquarters.lane}`);
        }
        const ledgerPath = join(input.stateRoot, 'resource-ledger', 'events.jsonl');
        recoverInterruptedHandoff(ledgerPath, headquarters.fingerprint, target, new Date(input.clock.now()));
        const ledgerBeforeFault = readResourceLedger(ledgerPath);
        const expectedLedgerRows = ledgerBeforeFault.map(resourceLedgerRowIdentity);
        const headquartersLeases = activeResourceLeases(ledgerBeforeFault)
          .filter((lease) => lease.fp === headquarters.fingerprint);
        const headquartersLease = headquartersLeases.length === 1 ? headquartersLeases[0] : undefined;
        if (!headquartersLease || headquartersLease.host !== target
          || headquartersLease.lane !== headquarters.lane
          || headquartersLease.mission.goalId !== headquarters.mission) {
          throw new Error(`disaster headquarters process needs exactly one matching active lease on ${target}`);
        }
        targetDevice.setHostState({ egress: false, cpu: 0, ready: false });
        const reading = await read();
        const survivor = reading.selectedHost;
        const started = new Date(input.clock.now());
        // An unavailable replacement is a hold. Keep the source lease so a later run can retry the handoff.
        const reaped = survivor ? reapResourceLeaseIfCurrent({ id: headquartersLease.id, expectedHeartbeatAt: headquartersLease.heartbeatAt,
          expectedExpiresAtMs: Date.parse(headquartersLease.heartbeatAt) + headquartersLease.ttlMs,
          observedAtMs: started.getTime(), reason: 'machine-disappeared' }, ledgerPath) : false;
        // A failed reap is a missing expected receipt, not a zero-loss run. Keep the
        // expected ledger event independent of the operation result being measured.
        if (survivor) expectedLedgerRows.push(resourceLedgerRowIdentity({ event: 'lease-reaped', at: started.toISOString(),
          id: headquartersLease.id, expectedHeartbeatAt: headquartersLease.heartbeatAt,
          expectedExpiresAt: new Date(Date.parse(headquartersLease.heartbeatAt) + headquartersLease.ttlMs).toISOString(),
          observedAt: started.toISOString(), reason: 'machine-disappeared' }));
        const handoffInput = survivor ? { fp: headquartersLease.fp, host: survivor, lane: headquartersLease.lane,
          resources: headquartersLease.resources, mission: headquartersLease.mission,
          ttlMs: headquartersLease.ttlMs, now: started } : null;
        if (handoffInput) {
          const expectedLease: ResourceLease = { id: headquartersLease.id, fp: handoffInput.fp, host: handoffInput.host,
            lane: handoffInput.lane, resources: handoffInput.resources, mission: handoffInput.mission,
            ttlMs: handoffInput.ttlMs, heartbeatAt: started.toISOString(), startedAt: started.toISOString() };
          expectedLedgerRows.push(resourceLedgerRowIdentity({ event: 'lease-created', at: started.toISOString(), lease: expectedLease }));
        }
        let survivorLease: ResourceLease | null = null;
        let restoredSourceLease = false;
        if (reaped && handoffInput) {
          try { survivorLease = (input.createSurvivorLease ?? beginResourceLease)(handoffInput, ledgerPath); }
          catch {
            // A failed replacement write must not permanently erase the last active HQ lease.
            // If a concurrent writer already supplied one, preserve it; otherwise restore the source identity.
            if (!activeResourceLeases(readResourceLedger(ledgerPath)).some((lease) => lease.id === headquartersLease.id)) {
              try {
                beginResourceLease({ fp: headquartersLease.fp, host: target, lane: headquartersLease.lane,
                  resources: headquartersLease.resources, mission: headquartersLease.mission,
                  ttlMs: headquartersLease.ttlMs, now: started }, ledgerPath);
                restoredSourceLease = true;
              } catch { /* The later ledger read reports an unmeasured restoration if this also failed. */ }
            }
          }
        }
        // Source: #35046 disaster world fixture declares a +1s handoff recovery observation.
        const recoverAtMs = atMs + 1_000;
        return {
          atMs: recoverAtMs, target,
          async complete(): Promise<WorldChaosObservation> {
            const observedAtMs = input.clock.now();
            if (survivor) expectedLedgerRows.push(resourceLedgerRowIdentity({ event: 'lease-heartbeat',
              at: new Date(observedAtMs).toISOString(), id: headquartersLease.id,
              heartbeatAt: new Date(observedAtMs).toISOString(), resources: headquartersLease.resources }));
            let restarted = false;
            if (survivor && survivorLease) {
              restarted = input.processTable.start({ id: headquarters.id, host: survivor,
                releaseVersion: headquarters.releaseVersion, fingerprint: headquarters.fingerprint,
                lane: headquarters.lane, mission: headquarters.mission, command: headquarters.command });
              if (restarted) {
                heartbeatResourceLease(survivorLease.id, survivorLease.resources, new Date(observedAtMs), ledgerPath);
              }
            }
            const ledgerEvents = readResourceLedger(ledgerPath);
            const active = activeResourceLeases(ledgerEvents);
            // The dead host cannot provide a live inventory. Observe only surviving hosts, and never turn
            // an unavailable observer into an empty process list (which would invent absence evidence).
            const activeHosts = [...new Set([...active.map((activeLease) => activeLease.host), ...(survivor ? [survivor] : [])])]
              .filter((host) => host !== target);
            const observedByHost = new Map<string, ResourceMeasurement['processes'] | null>();
            for (const host of activeHosts) {
              try { observedByHost.set(host, observer.observe(host)); }
              catch { observedByHost.set(host, null); }
            }
            const observedProcesses = survivor ? observedByHost.get(survivor) ?? null : null;
            const observerComplete = activeHosts.every((host) => observedByHost.get(host) !== null);
            const measurements: ResourceMeasurement[] = activeHosts.flatMap((host) => {
              const processes = observedByHost.get(host);
              return processes ? [{ host, observedAt: new Date(observedAtMs).toISOString(), pods: [], errors: [], processes }] : [];
            });
            const findings = reconcileResourceLeases({ leases: active, now: new Date(observedAtMs), measurements });
            const survivingHostFindings = findings.filter((finding) => activeHosts.includes(finding.host));
            const actualLedgerRows = ledgerEvents.map(resourceLedgerRowIdentity);
            const actualCounts = new Map<string, number>();
            for (const signature of actualLedgerRows) actualCounts.set(signature, (actualCounts.get(signature) ?? 0) + 1);
            let lostLedgerRows = 0;
            for (const signature of expectedLedgerRows) {
              const count = actualCounts.get(signature) ?? 0;
              if (count > 0) actualCounts.set(signature, count - 1);
              else lostLedgerRows++;
            }
            const unmeasured = !survivor || !observerComplete || observedProcesses === null;
            const passed = Boolean(survivor && reaped && restarted && !unmeasured && observedProcesses
              && lostLedgerRows === 0 && headquartersHandoffConverged({
              activeLeases: active, expectedFingerprint: headquarters.fingerprint!, expectedProcessId: headquarters.id,
              survivor, observedProcesses: observedProcesses!, findings: survivingHostFindings,
            }));
            return {
              kind: 'disaster', faultAtMs: atMs,
              faultVerdict: `${target} down; stopped ${killed.length} declared processes; selected=${survivor ?? 'none'}`,
              recoveredAtMs: passed ? observedAtMs - input.baseTimeMs : null,
              recoveryVerdict: passed
                ? `headquarters handoff to ${survivor}; handoff leases=1 findings=${survivingHostFindings.length}`
                : `handoff ${unmeasured ? 'unmeasured' : 'failed'} (selected=${survivor ?? 'none'} restarted=${restarted} reaped=${reaped} restored=${restoredSourceLease} observed=${observedProcesses?.length ?? 'unmeasured'} findings=${survivingHostFindings.map((finding) => finding.kind).join(',') || 'none'})`,
              recoveryMs: passed ? observedAtMs - (input.baseTimeMs + atMs) : null,
              metrics: { hitlCount: passed ? 0 : 1, lostLedgerRows: unmeasured ? null : lostLedgerRows,
                schedulableCpuMillicores: reading.schedulableCpuMillicores },
            };
          },
        };
      }
      const target = fault.gorilla.host;
      const host = input.hosts.find((candidate) => candidate.name === target)!;
      const device = devices.get(target)!;
      const killed = activeRecovery ? [] : input.processTable.killHost(target);
      input.fleet?.setHostOnline(target, false);
      const cloudVmId = input.cloudVmIds?.[target];
      let lostCloudLeases = 0;
      if (cloudVmId && input.cloudVm) {
        input.cloudVm.disappear(cloudVmId);
        for (const event of input.cloudVm.events()) {
          if (event.type === 'vm-disappeared' && event.id === cloudVmId) lostCloudLeases = event.lostLeases;
        }
      }
      device.setHostState({ egress: false, cpu: fault.gorilla.cpu, ready: false });
      input.onFaultStart?.(target);
      const restoreAtMs = atMs + durationMs(fault.gorilla.for);
      return {
        atMs: restoreAtMs, target,
        async complete() {
          await input.awaitActiveRecovery?.(target);
          const reading = await read();
          const restarted = activeRecovery ? 0 : input.processTable.restartHost(target);
          input.fleet?.setHostOnline(target, true);
          device.setHostState({ egress: host.egress, cpu: host.cpu, ready: true });
          const recoveredAtMs = input.clock.now() - input.baseTimeMs;
          const recoveryMs = recoveredAtMs - atMs;
          const passed = reading.selectedHost !== null && reading.selectedHost !== target
            && (activeRecovery || killed.length > 0 && restarted === killed.length);
          return {
            kind: 'gorilla', faultAtMs: atMs,
            faultVerdict: `${target} down; processes stopped=${killed.length}; egress blocked; allocatable CPU=${fault.gorilla.cpu} cores`,
            recoveredAtMs: passed ? recoveredAtMs : null,
            recoveryVerdict: passed
              ? activeRecovery
                ? `production pool selector chose surviving host ${reading.selectedHost}; unavailable host=${target}; cloud leases lost=${lostCloudLeases}`
                : `production pool selector chose surviving host ${reading.selectedHost}; restarted ${restarted}/${killed.length} processes on ${target}`
              : `host recovery failed (selected=${reading.selectedHost ?? 'none'}; restarted=${restarted}/${killed.length})`,
            recoveryMs: passed ? recoveryMs : null,
            metrics: { hitlCount: passed ? 0 : 1, lostLedgerRows: null, schedulableCpuMillicores: reading.schedulableCpuMillicores },
          };
        },
      };
    },
  };
}
