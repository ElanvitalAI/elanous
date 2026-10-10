import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type TrafficSignal = {
  global: string;
  versions?: string[];
  hold?: string[];
  paused?: Record<string, boolean>;
};
export type TrafficSignalRead = TrafficSignal | { unreadable: true } | null;

const defaultPath = (name: string): string => join(homedir(), 'elanous-hq', 'seat-state', 'OP', name);
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** A missing installation has no signal; an invalid or unreadable one cannot authorize a checklist launch. */
export function readTrafficSignal(path?: string): TrafficSignalRead {
  try {
    const value: unknown = JSON.parse(readFileSync(path ?? process.env.ELANOUS_TRAFFIC_SIGNAL ?? defaultPath('traffic.json'), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { unreadable: true };
    const row = value as Record<string, unknown>;
    if (typeof row.global !== 'string'
      || (row.versions !== undefined && (!Array.isArray(row.versions) || !row.versions.every((version) => typeof version === 'string')))
      || (row.hold !== undefined && (!Array.isArray(row.hold) || !row.hold.every((id) => typeof id === 'string')))
      || (row.paused !== undefined && (!row.paused || typeof row.paused !== 'object' || Array.isArray(row.paused)
        || !Object.values(row.paused).every((paused) => typeof paused === 'boolean')))) return { unreadable: true };
    return { global: row.global, ...(row.versions !== undefined ? { versions: row.versions as string[] } : {}),
      ...(row.hold !== undefined ? { hold: row.hold as string[] } : {}),
      ...(row.paused !== undefined ? { paused: row.paused as Record<string, boolean> } : {}) };
  } catch (error) {
    return missing(error) ? null : { unreadable: true };
  }
}

/** A missing handoff ledger has no handed cells; other read errors propagate so selection can fail closed. */
export function readHandedCells(path?: string): Set<string> {
  try {
    return new Set(readFileSync(path ?? process.env.ELANOUS_HANDED_CELLS ?? defaultPath(join('feeder', 'handed.txt')), 'utf8')
      .split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  } catch (error) {
    if (missing(error)) return new Set();
    throw error;
  }
}
