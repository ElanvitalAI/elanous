import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';

interface MemberTokenEntry { sha256: string; issuedAt: string }
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
      !Object.entries(parsed).every(([machine, entry]) =>
        validMachine(machine) && entry !== null && typeof entry === 'object' && !Array.isArray(entry) &&
        Object.keys(entry).length === 2 &&
        typeof (entry as MemberTokenEntry).sha256 === 'string' && /^[a-f0-9]{64}$/.test((entry as MemberTokenEntry).sha256) &&
        typeof (entry as MemberTokenEntry).issuedAt === 'string' && !Number.isNaN(Date.parse((entry as MemberTokenEntry).issuedAt)))) {
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
  entries[machine] = { sha256: createHash('sha256').update(token).digest('hex'), issuedAt: new Date().toISOString() };
  writeStore(root, entries);
  return token;
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

export function machineForToken(token: string, root: string = effectiveInstanceRoot()): string | undefined {
  const digest = createHash('sha256').update(token).digest();
  let match: string | undefined;
  for (const [machine, { sha256 }] of Object.entries(readStore(root))) {
    if (timingSafeEqual(digest, Buffer.from(sha256, 'hex'))) match = machine;
  }
  return match;
}
