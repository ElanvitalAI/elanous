// GATE-HOSTMIRROR-EXPLICIT (10-16 · seat-state/OPC/GATE-POD-PRECHECKOUT-LAG-1016.md):
// a gate run under an isolated config dir (`setElanousConfigDir(<run root>)` — the HARD run book) resolved
// `pod.hostMirror` inside runPodCommand from the isolated config, found nothing, and every gate Pod cloned from
// GitHub (157/157 `SOURCE_VIA github` · node-b clone p50 252s). The gate now resolves the mirror once and passes it
// to every podCommand explicitly. Order: gate option → env ELANOUS_POD_HOST_MIRROR → current config pod.hostMirror
// → (isolated config only) the operating config's pod.hostMirror, read-only → none. A failed operating read is none.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { getElanousConfigDir } from '../../src/elanous-config-dir.js';
import { getUserConfig } from '../../src/user-config.js';

export type GateHostMirrorSource = 'option' | 'env' | 'config' | 'operating-config' | 'none';

export interface GateHostMirrorReaders {
  env?: NodeJS.ProcessEnv;
  /** pod.hostMirror of the config the gate runs under. */
  config?: () => string | undefined;
  /** True when that config is not the operating one (`~/.elanous`). */
  isolated?: () => boolean;
  /** pod.hostMirror of the operating config — read only, never written. */
  operatingConfig?: () => string | undefined;
}

export interface GateHostMirror { hostMirror?: string; source: GateHostMirrorSource; path: string | null }

export const OPERATING_CONFIG_DIR = join(homedir(), '.elanous');

/** The operating config's pod.hostMirror (raw file read; no migration, no write). Any failure reads as absent. */
export function readOperatingHostMirror(dir = OPERATING_CONFIG_DIR): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { pod?: { hostMirror?: unknown } } | null;
    const value = raw?.pod?.hostMirror;
    return typeof value === 'string' ? value : undefined;
  } catch { return undefined; }
}

export function defaultGateHostMirrorReaders(): Required<GateHostMirrorReaders> {
  return {
    env: process.env,
    config: () => getUserConfig().pod?.hostMirror,
    isolated: () => resolve(getElanousConfigDir()) !== resolve(OPERATING_CONFIG_DIR),
    operatingConfig: () => readOperatingHostMirror(),
  };
}

export function resolveGateHostMirror(option: string | undefined, readers: GateHostMirrorReaders): GateHostMirror {
  const pick = (value: string | undefined) => value?.trim() || undefined;
  const found = (hostMirror: string, source: GateHostMirrorSource): GateHostMirror => ({ hostMirror, source, path: hostMirror });
  const fromOption = pick(option);
  if (fromOption) return found(fromOption, 'option');
  const fromEnv = pick(readers.env?.ELANOUS_POD_HOST_MIRROR);
  if (fromEnv) return found(fromEnv, 'env');
  let fromConfig: string | undefined;
  try { fromConfig = pick(readers.config?.()); } catch { fromConfig = undefined; }
  if (fromConfig) return found(fromConfig, 'config');
  let isolated = false;
  try { isolated = readers.isolated?.() === true; } catch { isolated = false; }
  if (isolated) {
    let operating: string | undefined;
    try { operating = pick(readers.operatingConfig?.()); } catch { operating = undefined; }
    // A borrowed value that runPodCommand would reject (not absolute) must not fail the gate — it reads as none.
    if (operating && isAbsolute(operating)) return found(operating, 'operating-config');
  }
  return { source: 'none', path: null };
}
