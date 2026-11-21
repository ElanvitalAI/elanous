import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import type { HealActionResult, HealStep } from './heal-runner.js';

function numberArg(args: HealStep['args'], name: string, min: number, max: number): number {
  const value = args?.[name];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`heal action: invalid ${name}`);
  return value;
}
function pathArg(args: HealStep['args']): string[] {
  const value = args?.path;
  if (typeof value !== 'string' || value.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(value)) throw new Error('heal action: invalid path');
  const parts = value.split('/');
  if (parts.length !== 4 || parts.some((part) => !part || part === '.' || part === '..')) throw new Error('heal action: invalid path');
  if (parts[0] !== 'OPS' || parts[1] !== 'tb' || parts[2] !== 'evidence' || !/^[a-z0-9-]+\.(?:json|log)$/.test(parts[3]!)) {
    throw new Error('heal action: path must be one OPS/tb/evidence file');
  }
  return parts;
}

/** Validate the whole card before any action runs. */
export function validateHealAction(action: string, args: HealStep['args']): void {
  switch (action) {
    case 'evidence.read':
      pathArg(args);
      if (Object.keys(args ?? {}).some((key) => key !== 'path')) throw new Error('heal action: unexpected argument');
      return;
    case 'host.load.read':
    case 'hitl.request':
      if (Object.keys(args ?? {}).length) throw new Error('heal action: unexpected argument');
      return;
    case 'host.load.wait':
      numberArg(args, 'maxLoad', 0, 50);
      numberArg(args, 'seconds', 0, 5);
      if (Object.keys(args ?? {}).some((key) => key !== 'maxLoad' && key !== 'seconds')) throw new Error('heal action: unexpected argument');
      return;
    case 'host.load.verify':
      numberArg(args, 'maxLoad', 0, 50);
      if (Object.keys(args ?? {}).some((key) => key !== 'maxLoad')) throw new Error('heal action: unexpected argument');
      return;
    default: throw new Error(`heal action: unsupported ${action}`);
  }
}

function readEvidence(root: string, args: HealStep['args']): HealActionResult {
  const parts = pathArg(args);
  let path = root;
  const base = lstatSync(path);
  if (!base.isDirectory() || base.isSymbolicLink()) throw new Error('heal action: unsafe evidence root');
  for (const part of parts.slice(0, -1)) {
    path = join(path, part);
    const st = lstatSync(path);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('heal action: unsafe evidence parent');
  }
  path = join(path, parts.at(-1)!);
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 16 * 1024) throw new Error('heal action: unsafe evidence file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > 16 * 1024) throw new Error('heal action: unsafe opened evidence');
    return { ok: true, detail: readFileSync(fd, 'utf8').trim() };
  } finally { closeSync(fd); }
}

export async function executeHealAction(seatStateRoot: string, action: string, args?: HealStep['args']): Promise<HealActionResult> {
  validateHealAction(action, args);
  switch (action) {
    case 'evidence.read': return readEvidence(seatStateRoot, args);
    case 'host.load.read': return { ok: true, detail: `load1=${loadavg()[0]!.toFixed(2)}` };
    case 'host.load.wait': {
      const maxLoad = numberArg(args, 'maxLoad', 0, 50);
      const seconds = numberArg(args, 'seconds', 0, 5);
      const deadline = Date.now() + seconds * 1000;
      while (loadavg()[0]! > maxLoad && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
      const observed = loadavg()[0]!;
      return { ok: observed <= maxLoad, detail: `load1=${observed.toFixed(2)} max=${maxLoad}` };
    }
    case 'host.load.verify': {
      const maxLoad = numberArg(args, 'maxLoad', 0, 50);
      const observed = loadavg()[0]!;
      return { ok: observed <= maxLoad, detail: `load1=${observed.toFixed(2)} max=${maxLoad}` };
    }
    case 'hitl.request': throw new Error('heal action: HITL step cannot execute automatically');
    default: throw new Error(`heal action: unsupported ${action}`);
  }
}
