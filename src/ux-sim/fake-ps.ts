import type { ResourceMeasurement } from '../resource-ledger/resource-ledger.js';
import type { SimWorldProcess } from './world-schema.js';

export interface FakePsProcess extends SimWorldProcess {
  readonly pid: number;
  readonly alive: boolean;
}

export interface FakePsDevice {
  find(id: string, host: string): FakePsProcess | undefined;
  findByFingerprint(fingerprint: string): FakePsProcess | undefined;
  kill(id: string, host: string): boolean;
  killHost(host: string): readonly FakePsProcess[];
  restartHost(host: string): number;
  restart(id: string, host: string): boolean;
  start(process: Omit<FakePsProcess, 'alive' | 'pid'>): boolean;
  list(host: string): ResourceMeasurement['processes'];
  pidAlive(pid: number): boolean;
}

/** Mutable world process inventory shared by simulated `ps`, monkey, and host recovery. */
export function createFakePsDevice(input: {
  readonly processes?: readonly SimWorldProcess[];
  readonly startAllowed?: (process: Omit<FakePsProcess, 'alive' | 'pid'>) => boolean;
} = {}): FakePsDevice {
  const processes = new Map<string, FakePsProcess>();
  let nextPid = 1_700_000_000;
  const key = (id: string, host: string) => `${id} host=${host}`;
  for (const process of input.processes ?? []) {
    const pid = nextPid++;
    processes.set(key(process.id, process.host), { ...process, pid, alive: true });
  }
  return {
    find: (id, host) => processes.get(key(id, host)),
    findByFingerprint: (fingerprint) => [...processes.values()].find((process) => process.fingerprint === fingerprint && process.alive),
    kill(id, host) {
      const process = processes.get(key(id, host));
      if (!process?.alive) return false;
      processes.set(key(id, host), { ...process, alive: false });
      return true;
    },
    killHost(host) {
      const killed: FakePsProcess[] = [];
      for (const [processKey, process] of processes) {
        if (process.host === host && process.alive) {
          processes.set(processKey, { ...process, alive: false });
          killed.push(process);
        }
      }
      return killed;
    },
    restartHost(host) {
      let restarted = 0;
      for (const process of [...processes.values()]) {
        if (process.host === host && !process.alive && this.start({ id: process.id, host: process.host,
          releaseVersion: process.releaseVersion, fingerprint: process.fingerprint, lane: process.lane,
          mission: process.mission, command: process.command })) restarted++;
      }
      return restarted;
    },
    restart(id, host) {
      const process = processes.get(key(id, host));
      if (!process || process.alive) return false;
      return this.start({ id: process.id, host: process.host, releaseVersion: process.releaseVersion,
        fingerprint: process.fingerprint, lane: process.lane, mission: process.mission, command: process.command });
    },
    start(process) {
      if (input.startAllowed && !input.startAllowed(process)) return false;
      const existing = processes.get(key(process.id, process.host));
      if (existing?.alive) return false;
      processes.set(key(process.id, process.host), { ...process, pid: nextPid++, alive: true });
      return true;
    },
    list(host) {
      return [...processes.values()].filter((process) => process.alive && process.host === host).map((process) => ({
        id: process.id, ...(process.fingerprint ? { fp: process.fingerprint } : {}), ...(process.lane ? { lane: process.lane } : {}),
        ...(process.mission ? { mission: process.mission } : {}), command: process.command ?? process.id,
      }));
    },
    pidAlive(pid) { return [...processes.values()].some((process) => process.alive && process.pid === pid); },
  };
}
