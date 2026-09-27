import { hostname } from 'node:os';
import { join } from 'node:path';
import { assertJoinedMachineId, readMachineProfile, writeMachineProfile } from './machine-profile.js';
import { readPrimaryJoin } from '../control-plane/primary.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';

export const MACHINE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export type MachineNameSource = 'option' | 'config' | 'join' | 'hostname';
export interface ResolvedMachineName { readonly machine: string; readonly source: MachineNameSource }

export function machineConfigPath(root: string = effectiveInstanceRoot()): string {
  return join(root, 'control', 'machine.json');
}

/** A missing or damaged file is not a name — fall through to the next source. */
export function readConfiguredMachine(root: string = effectiveInstanceRoot()): string | undefined {
  return readMachineProfile(root)?.id;
}

export function writeConfiguredMachine(machine: string, root: string = effectiveInstanceRoot()): void {
  if (!MACHINE_NAME.test(machine)) throw new Error(`invalid machine: ${machine}`);
  const previous = readMachineProfile(root);
  writeMachineProfile({ id: machine, duties: previous?.duties ?? [], seats: previous?.seats ?? {} }, root);
}

/**
 * The lease uses a configured machine identifier, not the OS hostname.
 * Explicit wins: option → control/machine.json → valid join ID → lowercased hostname.
 */
export function resolveMachineName(opts: {
  option?: string; root?: string; host?: string;
  readJoinMachine?: (root: string) => string | undefined;
} = {}): ResolvedMachineName {
  const root = opts.root ?? effectiveInstanceRoot();
  if (opts.option !== undefined) return { machine: opts.option, source: 'option' };
  const configured = readConfiguredMachine(root);
  if (configured) {
    assertJoinedMachineId(configured, root);
    return { machine: configured, source: 'config' };
  }
  const joined = (opts.readJoinMachine ?? ((r) => readPrimaryJoin(r)?.machine))(root);
  if (joined) {
    if (!MACHINE_NAME.test(joined)) throw new Error(`invalid joined machine id: ${joined}`);
    return { machine: joined, source: 'join' };
  }
  return { machine: (opts.host ?? hostname()).split('.')[0]!.toLowerCase(), source: 'hostname' };
}
