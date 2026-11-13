// Durable owner ledger for verified member chat sessions.
// The HTTP entry passes only the member id resolved by server auth.
// Request fields never select the owner, the session root, or the file that is read.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';
import type { SerializedMessage, SessionMeta } from '../../session/index.js';
import { SessionStore } from '../../session/session-store.js';

export const MEMBER_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LEDGER_FILE = 'owners.json';
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const LOCK_WAIT_MS = 5_000;

// One persistent inode. Replacing the lock file would let two processes flock different inodes.
type Flock = (fd: number, op: number) => number;
let flockFn: Flock | null | undefined;
function osFlock(): Flock | null {
  if (flockFn !== undefined) return flockFn;
  if (process.platform === 'win32') return (flockFn = null);
  try {
    const lib = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    return (flockFn = lib.symbols.flock as Flock);
  } catch {
    return (flockFn = null);
  }
}

export class MemberSessionAccessError extends Error {
  constructor(readonly reason: 'ledger-unavailable' | 'path-rejected') {
    super(reason);
  }
}

export interface MemberSessionCard {
  id: string;
  title: string;
  source: string;
  origin?: string;
  preview: string;
  updatedAt: string;
  messageCount: number;
}

export interface MemberSessionTranscript {
  messages: Array<{ role: string; content: string; toolName?: string; toolResult?: string }>;
}

export interface MemberSessionService {
  readonly store: SessionStore;
  list(memberId: string): MemberSessionCard[];
  read(memberId: string, sessionId: string): MemberSessionTranscript | null;
  saveTurn(memberId: string, content: string): { sessionId: string };
}

interface LedgerFile {
  version: 1;
  bindings: Record<string, string[]>;
}

function safeId(value: string): boolean {
  return MEMBER_SESSION_ID.test(value);
}

function confineDirectory(input: string): string {
  const resolved = resolve(input);
  let ancestor = resolved;
  while (!existsSync(ancestor)) ancestor = resolve(ancestor, '..');
  const ancestorStat = lstatSync(ancestor);
  if (ancestorStat.isSymbolicLink() || !ancestorStat.isDirectory()) throw new MemberSessionAccessError('path-rejected');
  const ancestorReal = realpathSync(ancestor);
  if (!existsSync(resolved)) mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const leaf = lstatSync(resolved);
  if (leaf.isSymbolicLink() || !leaf.isDirectory()) throw new MemberSessionAccessError('path-rejected');
  const real = realpathSync(resolved);
  const rel = relative(ancestorReal, real);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new MemberSessionAccessError('path-rejected');
  return real;
}

function fileInside(root: string, file: string): boolean {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const rel = relative(realpathSync(root), realpathSync(file));
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  } catch {
    return false;
  }
}

function readLedger(directory: string): LedgerFile {
  const target = join(directory, LEDGER_FILE);
  if (!existsSync(target)) return { version: 1, bindings: {} };
  if (!fileInside(directory, target)) throw new MemberSessionAccessError('ledger-unavailable');
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(target, 'utf8')); }
  catch { throw new MemberSessionAccessError('ledger-unavailable'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new MemberSessionAccessError('ledger-unavailable');
  const value = parsed as { version?: unknown; bindings?: unknown };
  if (value.version !== 1 || !value.bindings || typeof value.bindings !== 'object' || Array.isArray(value.bindings)) {
    throw new MemberSessionAccessError('ledger-unavailable');
  }
  const bindings: Record<string, string[]> = {};
  for (const [memberId, sessions] of Object.entries(value.bindings)) {
    if (!safeId(memberId) || !Array.isArray(sessions) || sessions.some(id => typeof id !== 'string' || !safeId(id))) {
      throw new MemberSessionAccessError('ledger-unavailable');
    }
    bindings[memberId] = [...new Set(sessions)];
  }
  return { version: 1, bindings };
}

function withLedgerLock<T>(directory: string, body: () => T): T {
  const flock = osFlock();
  if (!flock) throw new MemberSessionAccessError('ledger-unavailable');
  const lockPath = join(directory, `${LEDGER_FILE}.lock`);
  let fd: number;
  try {
    fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  } catch {
    throw new MemberSessionAccessError('ledger-unavailable');
  }
  let locked = false;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new MemberSessionAccessError('ledger-unavailable');
    if ((opened.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
    const stat = fstatSync(fd);
    const current = lstatSync(lockPath);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || current.isSymbolicLink() || stat.ino !== current.ino || stat.dev !== current.dev) {
      throw new MemberSessionAccessError('ledger-unavailable');
    }
    const until = Date.now() + LOCK_WAIT_MS;
    while (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
      if (Date.now() > until) throw new MemberSessionAccessError('ledger-unavailable');
      Bun.sleepSync(10);
    }
    locked = true;
    const held = lstatSync(lockPath);
    if (held.isSymbolicLink() || stat.ino !== held.ino || stat.dev !== held.dev) {
      throw new MemberSessionAccessError('ledger-unavailable');
    }
    return body();
  } finally {
    if (locked) {
      try { flock(fd, LOCK_UN); } catch { /* the process exit still drops the advisory lock */ }
    }
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

function writeLedger(directory: string, ledger: LedgerFile): void {
  const target = join(directory, LEDGER_FILE);
  if (existsSync(target) && !fileInside(directory, target)) throw new MemberSessionAccessError('ledger-unavailable');
  const temp = join(directory, `.${LEDGER_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(ledger), { flag: 'wx', mode: 0o600 });
    renameSync(temp, target);
  } finally {
    try { unlinkSync(temp); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function previewOf(messages: SerializedMessage[]): string {
  const last = messages.filter(message => message.role === 'user' || message.role === 'assistant').slice(-1)[0];
  return (last?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function publicMessage(message: SerializedMessage): MemberSessionTranscript['messages'][number] {
  return {
    role: message.role,
    content: message.content,
    ...(typeof message.toolName === 'string' ? { toolName: message.toolName } : {}),
    ...(typeof message.toolResult === 'string' ? { toolResult: message.toolResult } : {}),
  };
}

function cardFrom(meta: SessionMeta, messages: SerializedMessage[]): MemberSessionCard {
  return {
    id: meta.id,
    title: meta.title,
    source: meta.source,
    ...(meta.origin ? { origin: meta.origin } : {}),
    preview: previewOf(messages),
    updatedAt: meta.updatedAt,
    messageCount: meta.messageCount,
  };
}

export function createMemberSessionService(options: {
  directory: string;
  sessionRoot: string;
  now?: () => string;
}): MemberSessionService {
  const directory = confineDirectory(options.directory);
  const sessionRoot = confineDirectory(options.sessionRoot);
  const store = new SessionStore(sessionRoot);
  const now = options.now ?? (() => new Date().toISOString());
  const ownedIds = (memberId: string): string[] => {
    if (!safeId(memberId)) return [];
    return readLedger(directory).bindings[memberId] ?? [];
  };
  const loadOwned = (memberId: string, sessionId: string) => {
    if (!safeId(memberId) || !safeId(sessionId) || !ownedIds(memberId).includes(sessionId)) return null;
    const file = join(sessionRoot, `${sessionId}.jsonl`);
    if (!fileInside(sessionRoot, file)) return null;
    return store.load(sessionId);
  };
  return {
    store,
    list(memberId) {
      const cards: MemberSessionCard[] = [];
      for (const sessionId of ownedIds(memberId)) {
        const loaded = loadOwned(memberId, sessionId);
        if (!loaded || loaded.messages.length === 0) continue;
        cards.push(cardFrom(loaded.meta, loaded.messages));
      }
      return cards.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
    read(memberId, sessionId) {
      const loaded = loadOwned(memberId, sessionId);
      if (!loaded) return null;
      return { messages: loaded.messages.map(publicMessage) };
    },
    saveTurn(memberId, content) {
      if (!safeId(memberId)) throw new MemberSessionAccessError('path-rejected');
      const text = content.trim();
      if (!text || text.length > 8_000) throw new MemberSessionAccessError('path-rejected');
      const created = store.create({ source: 'pwa', origin: 'pwa', title: 'member' });
      if (!safeId(created.id)) throw new MemberSessionAccessError('path-rejected');
      store.appendById(created.id, { role: 'user', content: text, ts: now() }, { source: 'pwa', origin: 'pwa' });
      withLedgerLock(directory, () => {
        const ledger = readLedger(directory);
        const existing = ledger.bindings[memberId] ?? [];
        if (!existing.includes(created.id)) ledger.bindings[memberId] = [...existing, created.id];
        writeLedger(directory, ledger);
      });
      return { sessionId: created.id };
    },
  };
}
