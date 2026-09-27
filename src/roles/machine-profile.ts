import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { debug } from '../debug/log.js';
import { readPrimaryJoin } from '../control-plane/primary.js';
import { MACHINE_NAME, machineConfigPath } from './machine-name.js';

export interface MachineProfile {
  id: string;
  duties: string[];
  seats: Record<string, { rank: number }>;
}

export function validSeatRank(rank: number): boolean {
  return Number.isSafeInteger(rank) && rank >= 1 && rank <= 99;
}

export function readMachineProfile(root?: string): MachineProfile | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(machineConfigPath(root), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const doc = value as Record<string, unknown>;
    const id = doc.id === undefined ? doc.machine : doc.id;
    if (typeof id !== 'string' || !MACHINE_NAME.test(id)) return undefined;
    const duties = doc.duties === undefined ? [] : doc.duties;
    const seats = doc.seats === undefined ? {} : doc.seats;
    if (!Array.isArray(duties) || !duties.every(d => typeof d === 'string' && MACHINE_NAME.test(d)) ||
        !seats || typeof seats !== 'object' || Array.isArray(seats) ||
        !Object.entries(seats).every(([seat, value]) => MACHINE_NAME.test(seat) && value && typeof value === 'object' &&
          !Array.isArray(value) && validSeatRank((value as { rank?: number }).rank as number))) return undefined;
    return { id, duties: [...duties], seats: { ...seats } as MachineProfile['seats'] };
  } catch { return undefined; }
}

export function assertJoinedMachineId(id: string, root?: string): void {
  const joined = readPrimaryJoin(root)?.machine;
  if (joined && joined !== id) {
    throw new Error(`machine id ${id} differs from joined machine ${joined}`);
  }
}

export function writeMachineProfile(profile: MachineProfile, root?: string): void {
  if (typeof profile.id !== 'string' || !MACHINE_NAME.test(profile.id) || !Array.isArray(profile.duties) ||
      !profile.duties.every(d => typeof d === 'string' && MACHINE_NAME.test(d)) ||
      !profile.seats || typeof profile.seats !== 'object' || Array.isArray(profile.seats) ||
      !Object.entries(profile.seats).every(([seat, value]) => MACHINE_NAME.test(seat) && validSeatRank(value?.rank))) {
    throw new Error('invalid machine profile (id, duties, seats or rank)');
  }
  assertJoinedMachineId(profile.id, root);
  const path = machineConfigPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(profile)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  debug.log('roles.machine', 'profile-written', { id: profile.id, duties: profile.duties, seats: profile.seats });
}

export function seatRank(profile: MachineProfile | undefined, seat: string): number | undefined {
  return profile && Object.hasOwn(profile.seats, seat) ? profile.seats[seat]?.rank : undefined;
}
