import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { withPrivateFileLock } from '../../nexus/api/private-file-lock.js';
import { emptyGraphCapabilityRegistry, registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration,
  type GraphCapabilityProvider, type GraphCapabilityRegistry } from '../capabilities.js';

const COLLECTIONS = ['scraps', 'briefings', 'design-packs', 'suggestions', 'member-app-slots'] as const;
type Collection = typeof COLLECTIONS[number];
type Row = Record<string, unknown>;
type JournalRow = { collection: Collection; key: string; value: Row };
const MEMBER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;

function object(value: unknown): Row | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
}
function validString(value: unknown): value is string {
  return typeof value === 'string' && KEY.test(value);
}
function validCollection(value: unknown): value is Collection {
  return typeof value === 'string' && COLLECTIONS.some(collection => collection === value);
}
function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
}
function safeValue(value: unknown): Row | null {
  if (!object(value)) return null;
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || Buffer.byteLength(serialized) > MAX_RECORD_BYTES) return null;
    return object(JSON.parse(serialized));
  } catch { return null; }
}
function validValue(collection: Collection, value: Row): boolean {
  if (collection === 'scraps') return typeof value.kind === 'string' &&
    ['web', 'x', 'youtube', 'voice', 'video', 'photo', 'text', 'pdf'].includes(value.kind) &&
    [value.text, value.url, value.mediaRef].some(item => typeof item === 'string' && item.length > 0);
  if (collection === 'briefings') return validString(value.id) && typeof value.summary === 'string' &&
    stringArray(value.scrapIds) && Array.isArray(value.groups) && Array.isArray(value.todos);
  if (collection === 'design-packs') return validString(value.briefingId) && validString(value.appId) &&
    stringArray(value.scrapIds) && stringArray(value.requirementLines) && value.requirementLines.length === 3 &&
    Array.isArray(value.changes);
  if (collection === 'suggestions') return validString(value.id) && validString(value.briefingId) &&
    validString(value.appId) && typeof value.ask === 'string' && value.ask.trim().length > 0 &&
    stringArray(value.evidenceScrapIds);
  return validString(value.id) &&
    (value.screens === undefined || stringArray(value.screens)) &&
    (value.rpc === undefined || stringArray(value.rpc));
}
function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error('member graph store directory must be private');
}
function journalPath(root: string, owner: string): string {
  return join(root, `member-${createHash('sha256').update(owner).digest('hex')}.jsonl`);
}
function readJournal(path: string): JournalRow[] {
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  // The caller holds the member lock. A crash may leave only the final append incomplete.
  const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > MAX_JOURNAL_BYTES + MAX_RECORD_BYTES)
      throw new Error('member graph store journal is invalid');
    let bytes = readFileSync(fd);
    if (bytes.length && bytes[bytes.length - 1] !== 0x0a) {
      const completeLength = bytes.lastIndexOf(0x0a) + 1;
      ftruncateSync(fd, completeLength);
      fsyncSync(fd);
      bytes = bytes.subarray(0, completeLength);
    }
    if (bytes.length > MAX_JOURNAL_BYTES) throw new Error('member graph store journal is full');
    const source = bytes.toString('utf8');
    return source.split('\n').filter(Boolean).map(line => {
      const item: unknown = JSON.parse(line);
      const row = object(item);
      const value = object(row?.value);
      if (!row || !validCollection(row.collection) || !validString(row.key) || !value)
        throw new Error('member graph store journal contains invalid record');
      return { collection: row.collection, key: row.key, value };
    });
  } finally { closeSync(fd); }
}
function syncParentDirectory(path: string): void {
  const directoryFd = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}
function appendJournal(path: string, row: JournalRow, syncParent: (path: string) => void): void {
  const bytes = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8');
  if (bytes.byteLength > MAX_RECORD_BYTES) throw new Error('member graph store record exceeds limit');
  const fd = openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size + bytes.byteLength > MAX_JOURNAL_BYTES)
      throw new Error('member graph store journal is invalid or full');
    let offset = 0;
    try {
      while (offset < bytes.byteLength) {
        const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
        if (written <= 0) throw new Error('member graph store write made no progress');
        offset += written;
      }
      fsyncSync(fd);
      // A prior failed first append can leave an empty file. Every acknowledged
      // append must also make its directory entry durable, including retries.
      syncParent(path);
    } catch (error) {
      try { ftruncateSync(fd, stat.size); fsyncSync(fd); }
      catch { throw new Error('member graph store rollback failed'); }
      throw error;
    }
  } finally { closeSync(fd); }
}
function latest(rows: JournalRow[], collection: Collection): Map<string, Row> {
  const items = new Map<string, Row>();
  for (const row of rows) if (row.collection === collection) items.set(row.key, row.value);
  return items;
}
function failure(error: string) { return { ok: false as const, outcome: 'failed' as const, error }; }

export interface MemberStoreOptions {
  readonly root?: string;
  /** Fault injection for the new-journal directory durability step. */
  readonly syncParent?: (path: string) => void;
}

/** Durable graph store for an authenticated member. The caller's owner ID is never inferred from graph input. */
export function createMemberStoreProvider(options: MemberStoreOptions, access: 'read' | 'write'): GraphCapabilityProvider {
  const root = options.root ?? join(elanousStateRoot(), 'member-graph-store');
  return context => {
    const owner = context.verifiedOwnerId;
    const query = object(context.nodeInput ?? context.input);
    const graphContext = object(object(context.graphInput ?? context.input)?.context);
    if (!owner || !MEMBER_ID.test(owner) || !query || query.ownerScoped !== true ||
      (query.owner !== undefined && query.owner !== owner) ||
      (graphContext?.memberId !== undefined && graphContext.memberId !== owner)) return failure('verified member owner required');
    if (!validCollection(query.collection)) return failure('unsupported store collection');
    const collection = query.collection;
    const op = query.op;
    if (op !== 'list' && op !== 'get' && op !== 'create' && op !== 'upsert') return failure('unsupported store operation');
    if (access === 'read' && op !== 'list' && op !== 'get' || access === 'write' && op !== 'create' && op !== 'upsert')
      return failure('store contract operation mismatch');
    if (op === 'list' && query.where !== undefined && query.where !== 'status == new' &&
      query.where !== 'owner == $context.memberId') return failure('unsupported store filter');
    if (op !== 'list' && query.where !== undefined) return failure('unsupported store filter');
    if (op === 'upsert' && collection !== 'briefings' && collection !== 'design-packs' && collection !== 'member-app-slots')
      return failure('upsert is unavailable for this collection');
    if (op === 'create' && collection === 'briefings') return failure('create is unavailable for this collection');
    if (op === 'list' && query.where === 'status == new' && collection !== 'scraps')
      return failure('status filter is unavailable for this collection');
    const requestedKey = query.key ?? query.id;
    if (op === 'get' && !validString(requestedKey)) return failure('store key required');
    if (op === 'get' && query.key !== undefined && query.id !== undefined && query.key !== query.id)
      return failure('store key mismatch');
    let value: Row | null = null;
    let key: string | undefined;
    if (op === 'create' || op === 'upsert') {
      value = safeValue(query.value);
      if (!value || !validValue(collection, value) || value.owner !== undefined && value.owner !== owner)
        return failure('invalid owner-scoped store value');
      key = validString(requestedKey) ? requestedKey : collection === 'scraps'
        ? validString(value.id) ? value.id : `scrap-${createHash('sha256').update(`${context.graphId}:${context.runId}:${context.nodeId}`).digest('hex').slice(0, 32)}`
        : value.id as string;
      if (!validString(key) || (collection === 'suggestions' || collection === 'member-app-slots') && value.id !== key ||
        collection === 'design-packs' && value.briefingId !== key) return failure('store key/value mismatch');
      if (op === 'upsert' && !validString(query.key)) return failure('upsert key required');
      value = { ...value, id: collection === 'scraps' ? key : value.id, owner,
        ...(collection === 'scraps' ? { status: query.status ?? value.status ?? 'new' } : {}) };
      if (collection === 'scraps' && value.status !== 'new' && value.status !== 'processed')
        return failure('invalid scrap status');
    }
    try {
      privateDirectory(root);
      const path = journalPath(root, owner);
      return withPrivateFileLock(`${path}.lock`, () => {
        const rows = readJournal(path);
        const items = latest(rows, collection);
        if (op === 'list') {
          const found = [...items.values()].filter(item => query.where !== 'status == new' || item.status === 'new');
          return { ok: true, outcome: 'done', result: { items: found }, evidence: { owner, count: found.length } };
        }
        if (op === 'get') {
          const found = items.get(requestedKey as string);
          if (!found) return failure('owner-scoped store item unavailable');
          return { ok: true, outcome: 'done', result: found,
            evidence: { owner, key: requestedKey, ...(collection === 'suggestions' ? { suggestion: found } : {}) } };
        }
        if (op === 'create' && items.has(key!)) return failure('owner-scoped store key already exists');
        appendJournal(path, { collection, key: key!, value: value! }, options.syncParent ?? syncParentDirectory);
        return { ok: true, outcome: 'done', result: value!, evidence: { owner, key, stored: true } };
      }, 'graph.member-store', true);
    } catch { return failure('member store unavailable'); }
  };
}

/** Add only the two store contracts; registry composition remains with the owning graph route. */
export function registerMemberStoreProviders(registry: GraphCapabilityRegistry, options: MemberStoreOptions = {}): GraphCapabilityRegistry {
  let next = registry;
  for (const id of ['store.read@1', 'store.write@1'] as const) {
    if (!Object.hasOwn(next.contracts, id)) next = registerGraphCapabilityContract(next,
      { id, input: { type: 'object' }, output: { type: 'object' } });
  }
  next = registerGraphCapabilityProviderDeclaration(next, {
    id: 'nexus-member-graph-store-read', provides: ['store.read@1'], tier: 'free',
    invoke: createMemberStoreProvider(options, 'read'),
  });
  return registerGraphCapabilityProviderDeclaration(next, {
    id: 'nexus-member-graph-store-write', provides: ['store.write@1'], tier: 'free',
    invoke: createMemberStoreProvider(options, 'write'),
  });
}

export function createMemberStoreRegistry(options: MemberStoreOptions = {}): GraphCapabilityRegistry {
  return registerMemberStoreProviders(emptyGraphCapabilityRegistry(), options);
}
