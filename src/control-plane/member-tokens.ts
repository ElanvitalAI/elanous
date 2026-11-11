import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, fsyncSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';

export const MEMBER_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // cloud-join 하루 주기
interface MemberTokenEntry { sha256: string; issuedAt: string; expiresAt?: string }
type MemberTokenStore = Record<string, MemberTokenEntry>;

function pathFor(root: string): string {
  return join(root, 'control', 'member-tokens.json');
}

function validMachine(machine: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(machine) && !['__proto__', 'constructor', 'prototype'].includes(machine);
}

function checkMachine(machine: string): void {
  if (!validMachine(machine)) throw new Error('invalid control machine');
}

function validTokenEntry(entry: unknown): entry is MemberTokenEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const keys = Object.keys(entry);
  const legacy = keys.length === 2 && keys.every(key => ['sha256', 'issuedAt'].includes(key));
  const expiring = keys.length === 3 && keys.every(key => ['sha256', 'issuedAt', 'expiresAt'].includes(key));
  const token = entry as Partial<MemberTokenEntry>;
  return (legacy || expiring) && typeof token.sha256 === 'string' && /^[a-f0-9]{64}$/.test(token.sha256) &&
    typeof token.issuedAt === 'string' && !Number.isNaN(Date.parse(token.issuedAt)) &&
    (token.expiresAt === undefined || (typeof token.expiresAt === 'string' && !Number.isNaN(Date.parse(token.expiresAt))));
}

function readStore(root: string): MemberTokenStore {
  const path = pathFor(root);
  let contents: string;
  try { contents = readFileSync(path, 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const parsed: unknown = JSON.parse(contents);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      !Object.entries(parsed).every(([machine, entry]) => validMachine(machine) && validTokenEntry(entry))) {
    throw new Error('invalid control member tokens file');
  }
  const entries = parsed as MemberTokenStore;
  if (new Set(Object.values(entries).map(entry => entry.sha256)).size !== Object.keys(entries).length) {
    throw new Error('duplicate control member tokens');
  }
  if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
  return entries;
}

function writeStore(root: string, entries: MemberTokenStore): void {
  const path = pathFor(root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(entries), { flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* no temporary file */ }
    throw err;
  }
}

export function issueMemberToken(machine: string, root: string = effectiveInstanceRoot()): string {
  checkMachine(machine);
  const entries = readStore(root);
  const token = randomBytes(32).toString('hex');
  const issuedAt = Date.now();
  entries[machine] = { sha256: createHash('sha256').update(token).digest('hex'), issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(issuedAt + MEMBER_TOKEN_TTL_MS).toISOString() };
  writeStore(root, entries);
  return token;
}

/** Issue a member credential into a new private file without sending the value to stdout. */
export function issueMemberTokenToFile(machine: string, tokenFile: string, root: string = effectiveInstanceRoot()): void {
  checkMachine(machine);
  if (!isAbsolute(tokenFile)) throw new Error('token file path must be absolute');
  const token = randomBytes(32).toString('hex');
  mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
  let outputCreated = false;
  try {
    const fd = openSync(tokenFile, 'wx', 0o600);
    outputCreated = true;
    try {
      writeFileSync(fd, `${token}\n`, 'utf8');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const entries = readStore(root);
    const issuedAt = Date.now();
    entries[machine] = { sha256: createHash('sha256').update(token).digest('hex'), issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + MEMBER_TOKEN_TTL_MS).toISOString() };
    writeStore(root, entries);
  } catch (error) {
    if (outputCreated) try { unlinkSync(tokenFile); } catch { /* retain the original failure */ }
    throw error;
  }
}

export function revokeMemberToken(machine: string, root: string = effectiveInstanceRoot()): void {
  checkMachine(machine);
  const entries = readStore(root);
  if (Object.hasOwn(entries, machine)) {
    delete entries[machine];
    writeStore(root, entries);
  }
}

export function listMemberTokens(root: string = effectiveInstanceRoot()): Array<{ machine: string; issuedAt: string }> {
  return Object.entries(readStore(root)).map(([machine, { issuedAt }]) => ({ machine, issuedAt }));
}

function machineForTokenChecked(token: string, root: string, requireExpiry: boolean): string | undefined {
  const digest = createHash('sha256').update(token).digest();
  const now = Date.now();
  let match: string | undefined;
  for (const [machine, { sha256, expiresAt }] of Object.entries(readStore(root))) {
    if (!timingSafeEqual(digest, Buffer.from(sha256, 'hex'))) continue;
    if (expiresAt === undefined && !requireExpiry) {
      debug.log('resource-ledger.auth', 'legacy-machine-token-without-exp', { machine });
      match = machine;
    } else if (expiresAt !== undefined && Date.parse(expiresAt) > now) match = machine;
  }
  return match;
}

export function machineForToken(token: string, root: string = effectiveInstanceRoot()): string | undefined {
  return machineForTokenChecked(token, root, false);
}

/** Strict admission for credential-bearing proxy calls; legacy non-expiring entries are refused. */
export function machineForExpiringToken(token: string, root: string = effectiveInstanceRoot()): string | undefined {
  return machineForTokenChecked(token, root, true);
}
