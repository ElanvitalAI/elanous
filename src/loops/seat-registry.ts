import { readFileSync as readFileSyncFs } from 'node:fs';
import { join } from 'node:path';

export const registryFileRead: { read: (path: string) => string } = {
  read: path => readFileSyncFs(path, 'utf8'),
};

export function readRegistryFile(path: string): string {
  return registryFileRead.read(path);
}

export type SeatRegistryWake = 'herdr' | 'pty-inject' | 'none';
export type SeatRegistryReplyBody = 'agent' | 'none' | 'rules';
/** Which agent body runs in the seat's pane (OP 11-17 21:5x). `eln` seats watch their own inbox (#38164) when opted in. */
export type SeatAgentRuntime = 'eln' | 'claude-code' | 'codex';
export const SEAT_AGENT_RUNTIMES: readonly SeatAgentRuntime[] = ['eln', 'claude-code', 'codex'];

export interface SeatRegistryEntry {
  readonly address: string;
  readonly host: string;
  readonly target?: string;
  readonly wake: SeatRegistryWake;
  readonly replyBody: SeatRegistryReplyBody;
  /** Human panes must opt in explicitly. This flag is the single registry source for that choice. */
  readonly optIn: boolean;
  /** Optional: the agent body in the pane. Absent = not declared (old files stay valid). */
  readonly runtime?: SeatAgentRuntime;
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
    if (entry.runtime !== undefined && !SEAT_AGENT_RUNTIMES.includes(entry.runtime as SeatAgentRuntime)) throw new Error(`seats[${index}].runtime must be eln, claude-code or codex`);
    return { address, host, ...(target ? { target } : {}), wake: entry.wake, replyBody: entry.replyBody, optIn: entry.optIn,
      ...(entry.runtime === undefined ? {} : { runtime: entry.runtime as SeatAgentRuntime }) };
  });
  return { version: 1, seats };
}

export function readSeatRegistry(path: string, contents?: string): SeatRegistryRead {
  if (contents === undefined) {
    try { contents = readRegistryFile(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
      return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
    }
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

// ── SEAT-INBOX B1-B — registry v2 view (protocol §2) ─────────────────────────
// v1 files stay valid. v2 names how a seat is delivered to, not how it is woken.
// Agent seats cannot declare delivery=none (the old wake=none dead address).

export type SeatRegistryRuntime = 'eln' | 'external-cli' | 'human';
export type SeatRegistryDelivery = 'queue' | 'adapter' | 'parked' | 'none';

export interface SeatRegistryEntryV2 {
  readonly address: string;
  readonly host: string;
  readonly runtime: SeatRegistryRuntime;
  readonly delivery: SeatRegistryDelivery;
  readonly session?: string;
  readonly replyBody: SeatRegistryReplyBody;
  readonly optIn: boolean;
}

export interface SeatRegistryV2 { readonly version: 2; readonly seats: readonly SeatRegistryEntryV2[] }

const SESSION = /^[A-Za-z0-9_.:-]{1,128}$/;

function runtimeOf(value: unknown, index: number): SeatRegistryRuntime {
  if (value === 'eln' || value === 'external-cli' || value === 'human') return value;
  throw new Error(`seats[${index}].runtime is invalid`);
}

function deliveryOf(value: unknown, index: number): SeatRegistryDelivery {
  if (value === 'queue' || value === 'adapter' || value === 'parked' || value === 'none') return value;
  throw new Error(`seats[${index}].delivery is invalid`);
}

/** v1 wake column → v2 delivery. wake=none on an eln seat is queue, not a dead address.
 *  herdr/pty-inject inject, so they are adapter and keep the pane target as session.
 *  Any other wake (including a future no-inject value) stays eln/queue and must not invent an adapter session. */
export function normalizeSeatRegistryV1Entry(entry: SeatRegistryEntry): SeatRegistryEntryV2 {
  if (entry.wake === 'herdr' || entry.wake === 'pty-inject') {
    return {
      // A declared eln body keeps its pane as the adapter session (the 60s fallback knocks there) but is runtime eln.
      address: entry.address, host: entry.host, runtime: entry.runtime === 'eln' ? 'eln' : 'external-cli', delivery: 'adapter',
      ...(entry.target ? { session: entry.target } : {}), replyBody: entry.replyBody, optIn: entry.optIn,
    };
  }
  return { address: entry.address, host: entry.host, runtime: 'eln', delivery: 'queue', replyBody: entry.replyBody, optIn: entry.optIn };
}

function parseV2Seat(value: unknown, index: number, seen: Set<string>): SeatRegistryEntryV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`seats[${index}] must be an object`);
  const entry = value as Record<string, unknown>;
  const address = typeof entry.address === 'string' ? entry.address.trim().toUpperCase() : '';
  const host = typeof entry.host === 'string' ? entry.host.trim() : '';
  if ('session' in entry && entry.session !== undefined && typeof entry.session !== 'string') {
    throw new Error(`seats[${index}].session must be a string`);
  }
  const session = typeof entry.session === 'string' ? entry.session.trim() : undefined;
  if (!ADDRESS.test(address)) throw new Error(`seats[${index}].address is invalid`);
  if (seen.has(address)) throw new Error(`duplicate address ${address}`);
  seen.add(address);
  if (!HOST.test(host) && host !== 'unknown') throw new Error(`seats[${index}].host is invalid`);
  const runtime = runtimeOf(entry.runtime, index);
  const delivery = deliveryOf(entry.delivery, index);
  if (entry.replyBody !== 'agent' && entry.replyBody !== 'none' && entry.replyBody !== 'rules') throw new Error(`seats[${index}].replyBody is invalid`);
  if (typeof entry.optIn !== 'boolean') throw new Error(`seats[${index}].optIn must be boolean`);
  if (session !== undefined && !SESSION.test(session) && !TARGET.test(session)) throw new Error(`seats[${index}].session is invalid`);
  // Agent seats have no delivery=none. parked is only for a human reader.
  if (runtime !== 'human' && delivery === 'none') throw new Error(`seats[${index}]: agent seat cannot use delivery=none`);
  if (delivery === 'parked' && runtime !== 'human') throw new Error(`seats[${index}]: parked delivery requires runtime=human`);
  if (delivery === 'adapter' && !session) throw new Error(`seats[${index}].session is required for adapter delivery`);
  // queue is no-inject for an agent seat. Only adapter (needs a session) and parked/none (human) are special.
  if (runtime === 'eln' && delivery !== 'queue' && delivery !== 'adapter') throw new Error(`seats[${index}]: eln requires delivery=queue or adapter`);
  return {
    address, host, runtime, delivery, ...(session ? { session } : {}), replyBody: entry.replyBody, optIn: entry.optIn,
  };
}

function parseRegistryV2(raw: Record<string, unknown>): SeatRegistryV2 {
  if (!Array.isArray(raw.seats)) throw new Error('expected version 2 and seats array');
  const seen = new Set<string>();
  return { version: 2, seats: raw.seats.map((value, index) => parseV2Seat(value, index, seen)) };
}

/** Read v1 or v2 and always return the v2 delivery view. v1 wake=none becomes eln/queue. */
export function readSeatRegistryV2(path: string, contents?: string):
  | { readonly status: 'absent' }
  | { readonly status: 'invalid'; readonly reason: string }
  | { readonly status: 'ready'; readonly registry: SeatRegistryV2 } {
  if (contents === undefined) {
    try { contents = readRegistryFile(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
      return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
    }
  }
  try {
    const raw = JSON.parse(contents) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected an object');
    const row = raw as Record<string, unknown>;
    if (row.version === 1) {
      const v1 = parseRegistry(raw);
      return { status: 'ready', registry: { version: 2, seats: v1.seats.map(normalizeSeatRegistryV1Entry) } };
    }
    if (row.version === 2) return { status: 'ready', registry: parseRegistryV2(row) };
    throw new Error('expected version 1 or 2 and seats array');
  } catch (error) {
    return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }
}

export function seatRegistryV2Entry(registry: SeatRegistryV2, address: string): SeatRegistryEntryV2 | undefined {
  const key = address.trim().toUpperCase();
  return registry.seats.find(entry => entry.address === key);
}
