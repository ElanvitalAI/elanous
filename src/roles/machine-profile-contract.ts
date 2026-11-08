import { join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';

export const MACHINE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function machineConfigPath(root: string = effectiveInstanceRoot()): string {
  return join(root, 'control', 'machine.json');
}
