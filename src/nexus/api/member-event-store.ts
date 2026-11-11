import { isRecord } from '../../primitives/guards.js';
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, ftruncateSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphCapabilityProviderDeclaration, GraphCapabilityRegistry } from '../../graph-runner/capabilities.js';
import {
  registerGraphCapabilityContract,
  registerGraphCapabilityProviderDeclaration,
  STORE_EVENTS_CONTRACT,
} from '../../graph-runner/capabilities.js';
import { createDefaultMarketDataRegistry } from '../../graph-runner/capability-providers/market-data/registry.js';
import { withPrivateFileLock } from './private-file-lock.js';

export interface MemberEvent {
  readonly type: string;
  readonly memberId: string;
  readonly [key: string]: unknown;
}

export interface MemberEventQuery {
  readonly memberId: string;
  readonly type: string;
  readonly since?: string;
}

export interface MemberEventStore {
  append(event: unknown): Promise<void>;
  scan(request: { type: string }): Promise<readonly MemberEvent[]>;
  query(request: MemberEventQuery): Promise<readonly MemberEvent[]>;
  subscribe(listener: (event: MemberEvent) => void): () => void;
}

const MEMBER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const EVENT_TYPE = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;

function validMemberId(value: unknown): value is string {
  return typeof value === 'string' && MEMBER_ID.test(value);
}

function memberFile(directory: string, memberId: string): string {
  const digest = createHash('sha256').update(memberId).digest('hex');
  return join(directory, `member-${digest}.jsonl`);
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error('member event directory must be a private directory');
}

function parseEvent(value: unknown, memberId: string): MemberEvent {
  if (!isRecord(value) || value.memberId !== memberId || typeof value.type !== 'string' || !EVENT_TYPE.test(value.type)) {
    throw new Error('member event must include its owning memberId and a valid type');
  }
  return value as MemberEvent;
}

/** Write one complete record or restore the prior journal length before surfacing an error. */
export function appendJournalRecord(
  fd: number,
  serialized: Uint8Array,
  write: (fd: number, buffer: Uint8Array, offset: number, length: number) => number =
    (file, buffer, offset, length) => writeSync(file, buffer, offset, length),
): void {
  const originalSize = fstatSync(fd).size;
  let offset = 0;
  try {
    while (offset < serialized.byteLength) {
      const written = write(fd, serialized, offset, serialized.byteLength - offset);
      if (written <= 0) throw new Error('member event journal write made no progress');
      offset += written;
    }
    fsyncSync(fd);
  } catch (error) {
    try {
      ftruncateSync(fd, originalSize);
      fsyncSync(fd);
    } catch { throw new Error('member event journal append failed and rollback failed'); }
    throw error;
  }
}

function readMemberEvents(directory: string, memberId: string): MemberEvent[] {
  const path = memberFile(directory, memberId);
  if (!existsSync(path)) return [];
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('member event journal must be a private regular file');
  const contents = readFileSync(path, 'utf8');
  if (!contents) return [];
  return contents.split('\n').filter(Boolean).map(line => {
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { throw new Error('member event journal contains invalid JSON'); }
    return parseEvent(value, memberId);
  });
}

/** Append-only per-member JSONL journal; lock files and journals follow ingest-token's private flock ledger rules. */
export function createJsonlMemberEventStore(directory: string): MemberEventStore {
  ensurePrivateDirectory(directory);
  const listeners = new Set<(event: MemberEvent) => void>();

  return {
    async append(value) {
      if (!isRecord(value) || !validMemberId(value.memberId)) throw new Error('memberId is required for event append');
      const event = parseEvent(value, value.memberId);
      ensurePrivateDirectory(directory);
      const path = memberFile(directory, event.memberId);
      const lockPath = `${path}.lock`;
      const serialized = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
      withPrivateFileLock(lockPath, () => {
        const flags = constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW;
        const fd = openSync(path, flags, 0o600);
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('member event journal must be a private regular file');
          appendJournalRecord(fd, serialized);
        } finally { closeSync(fd); }
      }, 'nexus.member-event-store', true);
      for (const listener of listeners) {
        try { listener(event); } catch { /* one subscriber cannot break journal append */ }
      }
    },

    async query(request) {
      if (!validMemberId(request.memberId) || !EVENT_TYPE.test(request.type)) throw new Error('memberId and type are required for event query');
      ensurePrivateDirectory(directory);
      const path = memberFile(directory, request.memberId);
      const events = withPrivateFileLock(`${path}.lock`, () => readMemberEvents(directory, request.memberId), 'nexus.member-event-store', true);
      const since = request.since === undefined ? undefined : Date.parse(request.since);
      if (since !== undefined && (!Number.isFinite(since) || !/^\d{4}-\d{2}-\d{2}T/.test(request.since!))) throw new Error('since must be an ISO timestamp');
      return events.filter(event => event.type === request.type
        && (since === undefined || (typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)) && Date.parse(event.at) >= since)));
    },

    async scan(request) {
      if (!EVENT_TYPE.test(request.type)) throw new Error('type is required for event scan');
      ensurePrivateDirectory(directory);
      const rows: MemberEvent[] = [];
      for (const name of readdirSync(directory)) {
        if (!/^member-[a-f0-9]{64}\.jsonl$/.test(name)) continue;
        const path = join(directory, name);
        if (lstatSync(path).isSymbolicLink()) throw new Error('member event journal must not be a symlink');
        const events = withPrivateFileLock(`${path}.lock`, () => {
          const firstLine = readFileSync(path, 'utf8').split('\n', 1)[0];
          if (!firstLine) return [];
          const first: unknown = JSON.parse(firstLine);
          if (!isRecord(first) || !validMemberId(first.memberId) || memberFile(directory, first.memberId) !== path) {
            throw new Error('member event journal identity mismatch');
          }
          return readMemberEvents(directory, first.memberId);
        }, 'nexus.member-event-store', true);
        rows.push(...events.filter(event => event.type === request.type));
      }
      return rows;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

function storeEventsProvider(store: MemberEventStore): GraphCapabilityProviderDeclaration {
  return {
    id: 'nexus-jsonl-event-store',
    provides: ['store.events@1'],
    tier: 'free',
    invoke: async context => {
      if (!isRecord(context.input) || !validMemberId(context.input.memberId)) {
        return { ok: false, outcome: 'failed', error: 'invalid-input' };
      }
      const memberId = context.input.memberId;
      try {
        if (context.input.operation === 'append') {
          if (!isRecord(context.input.event) || context.input.event.memberId !== memberId) {
            return { ok: false, outcome: 'failed', error: 'member-mismatch' };
          }
          await store.append(context.input.event);
          return { ok: true, outcome: 'ok', result: { appended: true } };
        }
        if (context.input.operation === 'query') {
          if (typeof context.input.type !== 'string') return { ok: false, outcome: 'failed', error: 'invalid-input' };
          if (context.input.since !== undefined && typeof context.input.since !== 'string') return { ok: false, outcome: 'failed', error: 'invalid-input' };
          const events = await store.query({
            memberId,
            type: context.input.type,
            ...(typeof context.input.since === 'string' ? { since: context.input.since } : {}),
          });
          return { ok: true, outcome: 'ok', result: { events } };
        }
        return { ok: false, outcome: 'failed', error: 'invalid-operation' };
      } catch {
        return { ok: false, outcome: 'failed', error: 'store-error' };
      }
    },
  };
}

export function createNexusCapabilityRegistry(store: MemberEventStore): GraphCapabilityRegistry {
  let registry = registerGraphCapabilityContract(createDefaultMarketDataRegistry(), STORE_EVENTS_CONTRACT);
  registry = registerGraphCapabilityProviderDeclaration(registry, storeEventsProvider(store));
  return registry;
}
