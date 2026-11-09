import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type SeatRegistryWake = 'herdr' | 'pty-inject' | 'none';
export type SeatRegistryReplyBody = 'agent' | 'none' | 'rules';

export interface SeatRegistryEntry {
  readonly address: string;
  readonly host: string;
  readonly target?: string;
  readonly wake: SeatRegistryWake;
  readonly replyBody: SeatRegistryReplyBody;
  /** Human panes must opt in explicitly. This flag is the single registry source for that choice. */
  readonly optIn: boolean;
}

export interface SeatRegistry { readonly version: 1; readonly seats: readonly SeatRegistryEntry[] }
export type SeatRegistryRead =
  | { readonly status: 'absent' }
  | { readonly status: 'invalid'; readonly reason: string }
  | { readonly status: 'ready'; readonly registry: SeatRegistry };

const ADDRESS = /^[A-Z][A-Z0-9_-]{0,63}$/;
const HOST = /^(?:local|[A-Za-z0-9][A-Za-z0-9.-]{0,252})$/;
const TARGET = /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/;

function parseRegistry(raw: unknown): SeatRegistry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected an object');
  const row = raw as Record<string, unknown>;
  if (row.version !== 1 || !Array.isArray(row.seats)) throw new Error('expected version 1 and seats array');
  const seen = new Set<string>();
  const seats = row.seats.map((value, index): SeatRegistryEntry => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`seats[${index}] must be an object`);
    const entry = value as Record<string, unknown>;
    const address = typeof entry.address === 'string' ? entry.address.trim().toUpperCase() : '';
    const host = typeof entry.host === 'string' ? entry.host.trim() : '';
    const target = typeof entry.target === 'string' ? entry.target.trim() : undefined;
    if (!ADDRESS.test(address)) throw new Error(`seats[${index}].address is invalid`);
    if (seen.has(address)) throw new Error(`duplicate address ${address}`);
    seen.add(address);
    if (!HOST.test(host)) throw new Error(`seats[${index}].host is invalid`);
    if (entry.wake !== 'herdr' && entry.wake !== 'pty-inject' && entry.wake !== 'none') throw new Error(`seats[${index}].wake is invalid`);
    if (entry.replyBody !== 'agent' && entry.replyBody !== 'none' && entry.replyBody !== 'rules') throw new Error(`seats[${index}].replyBody is invalid`);
    if (typeof entry.optIn !== 'boolean') throw new Error(`seats[${index}].optIn must be boolean`);
    if (entry.wake !== 'none' && (!target || !TARGET.test(target))) throw new Error(`seats[${index}].target is required and must be host:pane`);
    if (entry.wake === 'pty-inject' && host !== 'local') throw new Error(`seats[${index}]: pty-inject requires host=local`);
    if (entry.wake === 'none' && target !== undefined && !TARGET.test(target)) throw new Error(`seats[${index}].target is invalid`);
    if (host === 'unknown' && (entry.wake !== 'none' || target !== undefined || entry.optIn !== false)) throw new Error('unknown host cannot bind a wake target');
    return { address, host, ...(target ? { target } : {}), wake: entry.wake, replyBody: entry.replyBody, optIn: entry.optIn };
  });
  return { version: 1, seats };
}

export function readSeatRegistry(path: string): SeatRegistryRead {
  let contents: string;
  try { contents = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
    return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }
  try { return { status: 'ready', registry: parseRegistry(JSON.parse(contents)) }; }
  catch (error) { return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) }; }
}

export function seatRegistryPath(seatStateRoot: string): string {
  return join(seatStateRoot, 'seat-registry.json');
}

export function seatRegistryEntry(registry: SeatRegistry, address: string): SeatRegistryEntry | undefined {
  const key = address.trim().toUpperCase();
  return registry.seats.find(entry => entry.address === key);
}
