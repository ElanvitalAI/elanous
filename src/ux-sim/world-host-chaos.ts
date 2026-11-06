import type { ResourceMeasurement } from '../resource-ledger/resource-ledger.js';
import { measurePoolLease } from '../task-orchestrator/surfaces/pod-lease.js';
import { measureMemberOccupancy, PodPoolScheduler, type PodPoolMember, type PoolKubectl } from '../task-orchestrator/surfaces/pod-pool.js';
import { createFakeKubectl } from './fake-kubectl.js';
import { createFakeFleetDevice } from './fake-fleet.js';
import { createFakeCloudVm } from './fake-cloud-vm.js';
import type { FakePsDevice } from './fake-ps.js';
import type { SimGorillaFault, SimWorldSpec } from './world-schema.js';
import type { PendingChaosRecovery, WorldChaosClock, WorldChaosObservation, WorldHostChaosController } from './world-chaos-runtime.js';

type FakeHost = ReturnType<typeof createFakeKubectl>;
type HostReading = { selectedHost: string | null; schedulableCpuMillicores: number | null };
function durationMs(value: string): number {
  const match = /^\+(0|[1-9]\d*)(ms|s|m|h)$/.exec(value);
  if (!match) throw new Error(`invalid host fault duration: ${value}`);
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
  return Number(match[1]) * scale[match[2] as keyof typeof scale];
}

/** Gorilla faults use production pool measurement and placement with the shared world process table. */
export function createWorldHostChaosController(input: {
  world: string;
  hosts: NonNullable<SimWorldSpec['hosts']>;
  devices: ReadonlyMap<string, unknown>;
  baseTimeMs: number;
  clock: Pick<WorldChaosClock, 'now'>;
  processTable: FakePsDevice;
  fleet?: ReturnType<typeof createFakeFleetDevice>;
  cloudVm?: ReturnType<typeof createFakeCloudVm>;
  cloudVmIds?: Readonly<Record<string, string>>;
  onFaultStart?: (host: string) => void;
  awaitActiveRecovery?: (host: string) => Promise<void>;
}): WorldHostChaosController {
  const activeRecovery = Boolean(input.onFaultStart || input.awaitActiveRecovery);
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
    start(fault: SimGorillaFault, atMs: number): PendingChaosRecovery {
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
