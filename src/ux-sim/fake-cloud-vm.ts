/**
 * Deterministic control-plane fake for parked cloud VMs.
 *
 * This device never contacts a provider. It models only image-based create,
 * resume, stop, lease draining, status, and powered-on cost. Termination is
 * deliberately an assertion failure: grid simulations must stop VMs, never
 * destroy them.
 */

export type FakeCloudVmState = 'warming' | 'ready' | 'draining' | 'parked' | 'disappeared';

export interface FakeCloudVmSpec {
  readonly id: string;
  readonly imageDigest: string;
  readonly hourlyCost: number;
  readonly readyAfterMs?: number;
  /** Absolute fake-clock epoch in milliseconds. Expiry drains, then stops. */
  readonly stopAfterAt?: number;
  readonly terminationProtected?: boolean;
}

export interface FakeCloudVmSnapshot {
  readonly id: string;
  readonly imageDigest: string;
  readonly state: FakeCloudVmState;
  readonly readyAt: number;
  readonly activeLeases: number;
  readonly poweredOnMs: number;
  readonly estimatedCost: number;
  readonly terminationProtected: boolean;
  readonly stopAfterAt?: number;
}

export type FakeCloudVmEvent =
  | { readonly type: 'create-from-image'; readonly id: string; readonly imageDigest: string; readonly at: number }
  | { readonly type: 'resume'; readonly id: string; readonly at: number }
  | { readonly type: 'ready'; readonly id: string; readonly at: number }
  | { readonly type: 'lease-opened'; readonly id: string; readonly at: number }
  | { readonly type: 'lease-closed'; readonly id: string; readonly at: number }
  | { readonly type: 'stop-after-draining'; readonly id: string; readonly at: number }
  | { readonly type: 'stop'; readonly id: string; readonly at: number }
  | { readonly type: 'vm-disappeared'; readonly id: string; readonly lostLeases: number; readonly at: number }
  | { readonly type: 'forbidden-terminate'; readonly id: string; readonly known: boolean; readonly protected: boolean; readonly at: number };

interface VmRecord {
  readonly id: string;
  readonly imageDigest: string;
  readonly hourlyCost: number;
  readonly terminationProtected: boolean;
  state: FakeCloudVmState;
  readyAt: number;
  stopAfterAt?: number;
  poweredSince?: number;
  poweredOnMs: number;
  activeLeases: number;
}

const HOUR_MS = 60 * 60 * 1000;

function requireDuration(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a nonnegative finite number`);
}

/** Create an isolated fake VM fleet whose time source is the fake-clock's Date. */
export function createFakeCloudVm() {
  const vms = new Map<string, VmRecord>();
  const events: FakeCloudVmEvent[] = [];

  function now(): number { return Date.now(); }

  function requireVm(id: string): VmRecord {
    const vm = vms.get(id);
    if (!vm) throw new Error(`fake-cloud-vm: unknown VM ${id}`);
    return vm;
  }

  function recordPoweredTime(vm: VmRecord, at: number): number {
    return vm.poweredOnMs + (vm.poweredSince === undefined ? 0 : Math.max(0, at - vm.poweredSince));
  }

  function snapshot(vm: VmRecord, at = now()): FakeCloudVmSnapshot {
    const poweredOnMs = recordPoweredTime(vm, at);
    return {
      id: vm.id,
      imageDigest: vm.imageDigest,
      state: vm.state,
      readyAt: vm.readyAt,
      activeLeases: vm.activeLeases,
      poweredOnMs,
      estimatedCost: poweredOnMs / HOUR_MS * vm.hourlyCost,
      terminationProtected: vm.terminationProtected,
      ...(vm.stopAfterAt === undefined ? {} : { stopAfterAt: vm.stopAfterAt }),
    };
  }

  function stop(vm: VmRecord, at: number): FakeCloudVmSnapshot {
    if (vm.activeLeases !== 0) throw new Error(`fake-cloud-vm: cannot stop ${vm.id} with ${vm.activeLeases} active lease(s)`);
    if (vm.state === 'parked') return snapshot(vm, at);
    vm.poweredOnMs = recordPoweredTime(vm, at);
    vm.poweredSince = undefined;
    vm.state = 'parked';
    events.push({ type: 'stop', id: vm.id, at });
    return snapshot(vm, at);
  }

  function reconcile(vm: VmRecord, at: number): void {
    const deadline = vm.stopAfterAt;
    if ((vm.state === 'warming' || vm.state === 'ready') && deadline !== undefined && at >= deadline) {
      // A caller may supply an already-expired deadline when starting a new
      // powered session. It takes effect immediately, never before power-on.
      const effectiveDeadline = Math.max(deadline, vm.poweredSince ?? deadline);
      // Apply the event timeline, not the time of a late status poll. If the
      // VM was ready before its deadline, preserve that event; a deadline that
      // wins (including a tie) never reports a ready VM after it began draining.
      if (vm.state === 'warming' && vm.readyAt < effectiveDeadline) {
        vm.state = 'ready';
        events.push({ type: 'ready', id: vm.id, at: vm.readyAt });
      }
      vm.state = 'draining';
      events.push({ type: 'stop-after-draining', id: vm.id, at: effectiveDeadline });
      if (vm.activeLeases === 0) stop(vm, effectiveDeadline);
      return;
    }
    if (vm.state === 'warming' && at >= vm.readyAt) {
      vm.state = 'ready';
      events.push({ type: 'ready', id: vm.id, at: vm.readyAt });
    }
  }

  function beginPower(vm: VmRecord, readyAfterMs: number, stopAfterAt: number | undefined, at: number): void {
    requireDuration(readyAfterMs, 'readyAfterMs');
    if (stopAfterAt !== undefined && !Number.isFinite(stopAfterAt)) throw new Error('stopAfterAt must be a finite epoch');
    vm.state = 'warming';
    vm.readyAt = at + readyAfterMs;
    vm.poweredSince = at;
    vm.stopAfterAt = stopAfterAt;
  }

  return {
    createFromImage(spec: FakeCloudVmSpec): FakeCloudVmSnapshot {
      if (!spec.id.trim()) throw new Error('fake-cloud-vm: id is required');
      if (!spec.imageDigest.trim()) throw new Error('fake-cloud-vm: imageDigest is required');
      if (!Number.isFinite(spec.hourlyCost) || spec.hourlyCost < 0) throw new Error('hourlyCost must be a nonnegative finite number');
      if (vms.has(spec.id)) throw new Error(`fake-cloud-vm: VM ${spec.id} already exists`);
      const at = now();
      const vm: VmRecord = {
        id: spec.id,
        imageDigest: spec.imageDigest,
        hourlyCost: spec.hourlyCost,
        terminationProtected: spec.terminationProtected ?? true,
        state: 'warming',
        readyAt: at,
        ...(spec.stopAfterAt === undefined ? {} : { stopAfterAt: spec.stopAfterAt }),
        poweredSince: at,
        poweredOnMs: 0,
        activeLeases: 0,
      };
      beginPower(vm, spec.readyAfterMs ?? 0, spec.stopAfterAt, at);
      vms.set(vm.id, vm);
      events.push({ type: 'create-from-image', id: vm.id, imageDigest: vm.imageDigest, at });
      reconcile(vm, at);
      return snapshot(vm, at);
    },

    /** Resume starts a fresh powered session; a stopAfter deadline must be supplied again. */
    resume(id: string, options: { readonly readyAfterMs?: number; readonly stopAfterAt?: number } = {}): FakeCloudVmSnapshot {
      const vm = requireVm(id);
      if (vm.state !== 'parked') throw new Error(`fake-cloud-vm: cannot resume ${id} from ${vm.state}`);
      const at = now();
      beginPower(vm, options.readyAfterMs ?? 0, options.stopAfterAt, at);
      events.push({ type: 'resume', id, at });
      reconcile(vm, at);
      return snapshot(vm, at);
    },

    stop(id: string): FakeCloudVmSnapshot {
      const at = now();
      const vm = requireVm(id);
      reconcile(vm, at);
      return stop(vm, at);
    },

    status(id: string): FakeCloudVmSnapshot {
      const at = now();
      const vm = requireVm(id);
      reconcile(vm, at);
      return snapshot(vm, at);
    },

    openLease(id: string): FakeCloudVmSnapshot {
      const at = now();
      const vm = requireVm(id);
      reconcile(vm, at);
      if (vm.state !== 'ready') throw new Error(`fake-cloud-vm: new lease refused for ${id} in ${vm.state}`);
      vm.activeLeases += 1;
      events.push({ type: 'lease-opened', id, at });
      return snapshot(vm, at);
    },

    /** Simulate an unannounced cloud/host loss; all resident leases become stale immediately. */
    disappear(id: string): FakeCloudVmSnapshot {
      const vm = requireVm(id);
      const at = now();
      const lostLeases = vm.activeLeases;
      vm.poweredOnMs = recordPoweredTime(vm, at);
      vm.poweredSince = undefined;
      vm.activeLeases = 0;
      vm.state = 'disappeared';
      events.push({ type: 'vm-disappeared', id, lostLeases, at });
      return snapshot(vm, at);
    },

    closeLease(id: string): FakeCloudVmSnapshot {
      const at = now();
      const vm = requireVm(id);
      reconcile(vm, at);
      if (vm.activeLeases === 0) throw new Error(`fake-cloud-vm: no active lease to close for ${id}`);
      vm.activeLeases -= 1;
      events.push({ type: 'lease-closed', id, at });
      if (vm.state === 'draining' && vm.activeLeases === 0) stop(vm, at);
      return snapshot(vm, at);
    },

    /** Any terminate request is forbidden and remains visible in the event record. */
    terminate(id: string): never {
      const vm = vms.get(id);
      events.push({ type: 'forbidden-terminate', id, known: vm !== undefined, protected: vm?.terminationProtected ?? false, at: now() });
      throw new Error(`fake-cloud-vm: terminate is forbidden for ${id}; stop is the only supported shutdown`);
    },

    statusAll(): FakeCloudVmSnapshot[] {
      const at = now();
      return [...vms.values()].sort((left, right) => left.id.localeCompare(right.id)).map((vm) => {
        reconcile(vm, at);
        return snapshot(vm, at);
      });
    },

    events(): FakeCloudVmEvent[] { return events.map((event) => ({ ...event })); },
  };
}
