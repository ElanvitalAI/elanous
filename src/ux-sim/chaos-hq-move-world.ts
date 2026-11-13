import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HqPriorityHost } from '../hq/arbiter.contract.js';
import { hqArbiterCheck, hqHeartbeat } from '../hq/hq.js';
import { createFakePsDevice } from './fake-ps.js';
import { ChaosTaskQueue, type ChaosTask, type ChaosWorker } from './chaos-hq-task-queue.js';
import { decideFence, recordView, serializeLease, type LeaseRecord, type LeaseStore } from '../hq/lease.js';

export type ChaosHqMoveKind = 'monkey' | 'gorilla' | 'kong';
export interface ReturnedWorkerFenceProof {
  taskId: string;
  caller: ChaosWorker;
  assignment: ChaosWorker;
  live: boolean;
  deniedAck: boolean;
  permittedAck: boolean;
  stateAfterDenied: ChaosTask['state'];
  stateAfterPermitted: ChaosTask['state'];
}
export interface ChaosHqMoveReceipt {
  scenario: `${ChaosHqMoveKind}-${1 | 2 | 3}`;
  selectedHost: HqPriorityHost;
  generation: number;
  recoveryMs: number;
  lostTasks: number;
  manualInterventions: number;
  realMachineStops: 0;
  staleObservationHeld: boolean;
  oldHolderFenced: boolean;
  runbookDelta: string;
  events: readonly string[];
  tasks: readonly ChaosTask[];
  faultAt: number;
  recoveredAt: number | null;
  failedPids: readonly number[];
  resumedPids: readonly number[];
  returnedWorkerFenceProof?: ReturnedWorkerFenceProof;
}

const START = Date.parse('2026-11-13T09:00:00Z');
const TASKS = ['task-01', 'task-02', 'task-03'];

interface DrillClock { now(): number; tick(ms: number): void }
export interface ChaosHqMoveOptions {
  approveKong?: () => boolean;
  clock?: DrillClock;
  restartAfterTicks?: number;
  restartAllowed?: boolean;
  replacementClaimAllowed?: boolean;
  dropTask?: string;
}

function proveArbiterEntry(kind: ChaosHqMoveKind, repetition: 1 | 2 | 3, clock: DrillClock, online: Record<string, boolean>) {
  const root = mkdtempSync(join(tmpdir(), 'chaos-hq-entry-'));
  try {
    const start = clock.now();
    let now = start / 1_000;
    let raw: string | null = serializeLease({ holder: 'mshq', generation: 7, acquiredAt: now,
      renewedAt: now, ttlSeconds: 1_500, dualUnreachableStreak: 0 });
    const store: LeaseStore = {
      read: () => ({ now, raw }),
      cas: (expected, next) => {
        if (expected !== raw) return false;
        raw = next;
        return true;
      },
    };
    const promoted: string[] = [];
    const deps = {
      config: { hostName: 'cloud-vm', arbiter: 'local', standby: 'node-b', autoPromote: { enabled: true, streak: 2 } },
      store,
      probe: { ping: (host: string) => online[host] === true, health: () => false },
      hostPath: join(root, 'host'), localPath: join(root, 'local.json'), seenPath: join(root, 'seen'),
      now: () => now, log: () => {},
      opRequest: (request: { key: string }) => ({ key: request.key, created: true }),
      promote: (host: string) => { promoted.push(host); return { ok: true, apply: true, host, lines: [] }; },
    };
    const current = (): LeaseRecord => JSON.parse(raw ?? 'null') as LeaseRecord;
    if (kind === 'monkey') {
      const check = hqArbiterCheck(deps);
      if (check.promoted || current().holder !== 'mshq' || promoted.length !== 0) throw new Error('real arbiter moved HQ for a local fault');
      return { holder: 'mshq', generation: 7, recoveryMs: 0, staleHeld: false, returnHeld: false, oldFenced: false,
        oldWriterAllowed: true, writerAllowed: decideFence({ me: 'mshq', now, local: { holder: 'mshq', generation: 7, confirmedAt: now }, record: current(), seenGeneration: 7 }).run,
        events: ['arbiter-entry:holder-mshq'] };
    }
    const target = kind === 'gorilla' ? 'node-b' : 'aws1';
    const events: string[] = [];
    let staleHeld = false;
    const checks = repetition === 2 ? 3 : 2;
    for (let tick = 1; tick <= checks; tick++) {
      clock.tick(600_000);
      now = clock.now() / 1_000;
      if (repetition === 2 && tick === 1) {
        raw = serializeLease(recordView(current(), target, false, now - 1_501));
        events.push('candidate-view:stale');
      } else {
        const heartbeat = hqHeartbeat({ ...deps,
          config: { hostName: target, arbiter: 'local', standby: 'node-b' },
          hostPath: join(root, `host-${target}`), localPath: join(root, `local-${target}.json`),
          seenPath: join(root, `seen-${target}`),
        });
        if (heartbeat.outcome !== 'standby' || heartbeat.holder !== 'mshq' || heartbeat.holderReachable !== false) {
          throw new Error('real candidate heartbeat failed holder-negative view');
        }
        events.push(`candidate-heartbeat:${target}:${tick}`);
      }
      const check = hqArbiterCheck(deps);
      events.push(`arbiter-entry:${tick}:${check.holder}:${check.streak}:${check.promoted}`);
      if (repetition === 2 && tick === 1) staleHeld = check.streak === 0 && check.promoted === false;
      if (tick < checks && check.promoted) throw new Error('real arbiter promoted before two fresh checks');
    }
    const lease = current();
    if (lease.holder !== target || lease.generation !== 8 || promoted.length !== 1 || promoted[0] !== target) {
      throw new Error(`real hqArbiterCheck chose ${lease.holder}; expected ${target}`);
    }
    const oldFence = decideFence({ me: 'mshq', now,
      local: { holder: 'mshq', generation: 7, confirmedAt: start / 1_000 }, record: lease, seenGeneration: 7 });
    const newFence = decideFence({ me: target, now,
      local: { holder: target, generation: 8, confirmedAt: now }, record: lease, seenGeneration: 8 });
    if (oldFence.run || !newFence.run) throw new Error('actual lease failed single-writer fence');
    let returnHeld = true;
    if (repetition === 3) {
      online['mshq'] = true;
      const returned = hqArbiterCheck(deps);
      returnHeld = returned.promoted === false && current().holder === target;
      if (!returnHeld) throw new Error('real arbiter failed old-holder return fence');
      events.push('arbiter-entry:old-holder-return-held');
    }
    return { holder: target, generation: lease.generation, recoveryMs: clock.now() - start,
      staleHeld, returnHeld, oldFenced: !oldFence.run, oldWriterAllowed: oldFence.run, writerAllowed: newFence.run, events };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A36 drill through real arbiter/heartbeat entries and a durable virtual worker queue. */
export function runChaosHqMoveWorld(kind: ChaosHqMoveKind, repetition: 1 | 2 | 3,
  options: ChaosHqMoveOptions = {}): ChaosHqMoveReceipt {
  if (!['monkey', 'gorilla', 'kong'].includes(kind) || ![1, 2, 3].includes(repetition)) {
    throw new Error('unknown HQ chaos scenario');
  }
  const restartAfterTicks = options.restartAfterTicks ?? repetition + 1;
  if (!Number.isInteger(restartAfterTicks) || restartAfterTicks < 1 || restartAfterTicks > 20) {
    throw new Error('restartAfterTicks must be an integer from 1 to 20');
  }
  let virtualNow = START;
  const clock = options.clock ?? { now: () => virtualNow, tick: (ms: number) => { virtualNow += ms; } };
  const root = mkdtempSync(join(tmpdir(), 'chaos-hq-queue-'));
  const tasks = TASKS.map((id, index) => ({ id, loop: `loop-${index + 1}` }));
  const processes = createFakePsDevice({ processes: tasks.map(task => ({
    id: task.loop, host: 'mshq', releaseVersion: 'simulation',
  })), startAllowed: () => options.restartAllowed !== false });
  const path = join(root, 'tasks.json');
  const queue = new ChaosTaskQueue(path);
  const events: string[] = [];
  try {
    queue.initialize(tasks);
    // Capture worker identity at dispatch; an old callback must never inherit a replacement PID.
    const originalWorkers = new Map<string, ChaosWorker>(tasks.map(task => [task.loop,
      { host: 'mshq', pid: processes.find(task.loop, 'mshq')!.pid, generation: 7 }]));
    for (const task of tasks) queue.claim(task.loop, originalWorkers.get(task.loop)!, processes, true);
    const failedLoop = tasks[repetition - 1]!.loop;
    if (kind === 'monkey') {
      for (const task of tasks.filter(task => task.loop !== failedLoop)) {
        queue.complete(task.loop, originalWorkers.get(task.loop)!, processes, true, clock.now());
      }
    }
    const failedPids = tasks.filter(task => kind !== 'monkey' || task.loop === failedLoop)
      .map(task => processes.find(task.loop, 'mshq')!.pid);
    const faultAt = clock.now();
    const online: Record<string, boolean> = { 'mshq': true, 'node-b': true, 'aws1': true };
    if (kind === 'monkey') processes.kill(failedLoop, 'mshq');
    else {
      online['mshq'] = false;
      processes.killHost('mshq');
      if (kind === 'kong') { online['node-b'] = false; processes.killHost('node-b'); }
    }
    events.push(`fault-observed:${faultAt}:dead-pids=${failedPids.filter(pid => !processes.pidAlive(pid)).join(',')}`);
    // A dead worker cannot acknowledge its in-flight TASK even with a still-valid lease.
    for (const task of tasks.filter(task => kind !== 'monkey' || task.loop === failedLoop)) {
      if (queue.complete(task.loop, originalWorkers.get(task.loop)!, processes, true, clock.now())) throw new Error('dead worker completed TASK');
    }
    if (options.dropTask) queue.drop(options.dropTask);
    let manualInterventions = 0;
    if (kind === 'kong') {
      if (options.approveKong?.() !== true) throw new Error('Kong promotion requires one explicit virtual HITL approval');
      manualInterventions++;
      events.push('telegram-hitl:one-virtual-tap');
    }
    const entry = proveArbiterEntry(kind, repetition, clock, online);
    if (kind !== 'monkey' && repetition === 2 && !entry.staleHeld) throw new Error('real arbiter did not hold a stale candidate view');
    events.push(...entry.events);
    if (kind === 'monkey') {
      for (let tick = 1; tick <= restartAfterTicks; tick++) {
        clock.tick(15_000);
        if (tick === restartAfterTicks && processes.restart(failedLoop, 'mshq')) {
          events.push(`restart-observed:${clock.now()}:${failedLoop}:${processes.find(failedLoop, 'mshq')!.pid}`);
        }
      }
    } else {
      for (const task of tasks) processes.start({ id: task.loop, host: entry.holder, releaseVersion: 'simulation' });
      events.push(`survivor-workers:${clock.now()}:${entry.holder}`);
    }
    let returnedWorkerFenceProof: ReturnedWorkerFenceProof | undefined;
    if (kind !== 'monkey' && repetition === 3) {
      processes.restartHost('mshq');
      const process = processes.find(failedLoop, 'mshq');
      if (process?.alive) {
        const caller = { host: 'mshq', pid: process.pid, generation: 7 };
        // Model a returned worker holding valid local work despite its stale HQ lease.
        // The permit=true setup is a controlled assignment fixture, not a lease grant.
        queue.recover(processes, caller.host, caller.generation);
        if (queue.claim(failedLoop, caller, processes, true)) {
          const before = queue.snapshot();
          const assigned = before.find(task => task.loop === failedLoop)!;
          const controlPath = join(root, 'returned-holder-permitted-control.json');
          copyFileSync(path, controlPath);
          const control = new ChaosTaskQueue(controlPath);
          // Identical TASK assignment/caller/process: only the fence permission changes.
          const deniedAck = queue.complete(failedLoop, caller, processes, entry.oldWriterAllowed, clock.now());
          const afterDenied = queue.snapshot();
          const permittedAck = control.complete(failedLoop, caller, processes, true, clock.now());
          const afterPermitted = control.snapshot().find(task => task.id === assigned.id)!;
          if (deniedAck || !permittedAck || JSON.stringify(before) !== JSON.stringify(afterDenied)) {
            throw new Error('returned-worker fence failed denied/permitted ACK controls');
          }
          returnedWorkerFenceProof = { taskId: assigned.id, caller, assignment: assigned.worker!, live: process.alive,
            deniedAck, permittedAck, stateAfterDenied: afterDenied.find(task => task.id === assigned.id)!.state,
            stateAfterPermitted: afterPermitted.state };
          events.push('returned-workers:task-ack-fenced');
          // The permitted ACK touched only the counterfactual fork; real work stays pending recovery.
        }
      }
      if (!returnedWorkerFenceProof) events.push('returned-workers:fence-proof-unavailable');
    }
    // Recovery reopens persisted state; no task IDs are synthesized from the expected input.
    const resumed = new ChaosTaskQueue(path);
    resumed.recover(processes, entry.holder, entry.generation);
    const resumedWorkers = new Map<string, ChaosWorker>();
    for (const task of resumed.snapshot()) {
      const process = processes.find(task.loop, entry.holder);
      if (!process?.alive) continue;
      const worker = { host: entry.holder, pid: process.pid, generation: entry.generation };
      if (resumed.claim(task.loop, worker, processes, entry.writerAllowed && options.replacementClaimAllowed !== false)) resumedWorkers.set(task.loop, worker);
    }
    if (kind === 'monkey') {
      const replacement = resumedWorkers.get(failedLoop);
      if (replacement) {
        events.push(`replacement-claim:accepted:${replacement.pid}`);
        const staleWorker = originalWorkers.get(failedLoop)!;
        if (resumed.complete(failedLoop, staleWorker, processes, entry.writerAllowed, clock.now())) {
          throw new Error('old PID acknowledged TASK after replacement claim');
        }
        events.push('old-pid-ack:rejected-after-reassignment');
      } else {
        events.push('replacement-claim:failed');
      }
    }
    clock.tick(1_000);
    for (const task of resumed.snapshot()) {
      const worker = resumedWorkers.get(task.loop);
      if (worker && resumed.complete(task.loop, worker, processes, entry.writerAllowed, clock.now())) {
        events.push(`task-completed:${clock.now()}:${task.id}`);
      }
    }
    const observedTasks = resumed.snapshot();
    const completed = observedTasks.filter(task => task.state === 'done');
    const lostTasks = TASKS.filter(id => !completed.some(task => task.id === id)).length;
    const recoveredAt = lostTasks === 0 ? Math.max(...completed.map(task => task.completedAt!)) : null;
    return {
      scenario: `${kind}-${repetition}`, selectedHost: entry.holder as HqPriorityHost, generation: entry.generation,
      recoveryMs: recoveredAt === null ? 0 : recoveredAt - faultAt, lostTasks, manualInterventions,
      realMachineStops: 0, staleObservationHeld: entry.staleHeld,
      oldHolderFenced: entry.oldFenced && entry.returnHeld,
      runbookDelta: kind === 'monkey' ? 'Monkey: observe dead PID, replacement PID and durable TASK acknowledgement'
        : kind === 'kong' ? 'Kong: aws1 standby proof, one approval tap, durable TASK resume and return fence'
          : 'Gorilla: two fresh dual-negative probes, node-b promotion, durable TASK resume and return fence',
      events, tasks: observedTasks, faultAt, recoveredAt, failedPids, returnedWorkerFenceProof,
      resumedPids: completed.filter(task => task.completedAt! > faultAt).map(task => task.worker!.pid),
    };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export function runChaosHqMoveMatrix(options: ChaosHqMoveOptions = {}): ChaosHqMoveReceipt[] {
  return (['monkey', 'gorilla', 'kong'] as const).flatMap(kind =>
    ([1, 2, 3] as const).map(repetition => runChaosHqMoveWorld(kind, repetition, options)));
}
