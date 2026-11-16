import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readSync,
  realpathSync, unlinkSync, writeSync } from 'node:fs';
import { isAbsolute, join, dirname, resolve } from 'node:path';

const ORIGIN = 'https://api.elanous.ai';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KEY = /^emk_[A-Za-z0-9]{1,43}$/u;
const SHA = /^[0-9a-f]{64}$/u;
const fail = (): never => { throw new Error('relay member key binding unavailable'); };

function privateRegular(path: string, limit: number): Buffer {
  const named = lstatSync(path);
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > limit
    || (named.mode & 0o077) !== 0 || process.getuid && named.uid !== process.getuid()
    || realpathSync(path) !== path) return fail();
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') return fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== named.dev || opened.ino !== named.ino
      || opened.size > limit || (opened.mode & 0o077) !== 0
      || process.getuid && opened.uid !== process.getuid()) return fail();
    const data = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < data.length) {
      const n = readSync(fd, data, count, data.length - count, null);
      if (n === 0) break;
      count += n;
    }
    const after = fstatSync(fd);
    if (count > limit || count !== opened.size || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs) return fail();
    return data.subarray(0, count);
  } finally { closeSync(fd); }
}

function privateKey(path: string): string {
  const key = privateRegular(path, 128).toString('utf8').trim();
  if (!KEY.test(key)) return fail();
  return key;
}

function keyPathFor(configDir: string): string {
  if (!isAbsolute(configDir) || realpathSync(configDir) !== resolve(configDir)) return fail();
  const config = JSON.parse(privateRegular(join(configDir, 'config.json'), 1024 * 1024).toString('utf8')) as {
    nexus?: { relay?: { memberKeyFile?: unknown; memberNexusUrl?: unknown } };
  };
  const relay = config?.nexus?.relay;
  if (!relay || relay.memberNexusUrl !== ORIGIN || typeof relay.memberKeyFile !== 'string') return fail();
  const path = relay.memberKeyFile;
  if (!isAbsolute(path) || resolve(path) !== path || dirname(path) !== resolve(configDir)) return fail();
  return path;
}

/** Save only the official issue201 key identity, never another copy of the key. */
export function writeRelayMemberKeyBinding(keyPath: string, keyId: string, issuedKey: string): void {
  if (!isAbsolute(keyPath) || resolve(keyPath) !== keyPath || realpathSync(dirname(keyPath)) !== dirname(keyPath)
    || !ID.test(keyId) || !KEY.test(issuedKey) || privateKey(keyPath) !== issuedKey) return fail();
  const path = keyPath + '.binding.json';
  const value = JSON.stringify({ schemaVersion: 1, keyId, issuerOrigin: ORIGIN,
    keySha256: createHash('sha256').update(issuedKey).digest('hex') }) + '\n';
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    const bytes = Buffer.from(value);
    if (writeSync(fd, bytes) !== bytes.length) return fail();
    fsyncSync(fd); closeSync(fd); fd = undefined;
    const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } catch {
    if (fd !== undefined) closeSync(fd);
    // Only a file created by this writer may be removed by this writer.
    if (created) { try { unlinkSync(path); } catch { /* no retained binding */ } }
    return fail();
  }
}

/** Current key and official issue201 identity must match before grant issuance. */
export function readRelayMemberKeyId(configDir: string): string | undefined {
  try {
    const keyPath = keyPathFor(configDir);
    const key = privateKey(keyPath);
    const value: unknown = JSON.parse(privateRegular(keyPath + '.binding.json', 512).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const binding = value as Record<string, unknown>;
    if (Object.keys(binding).sort().join() !== 'issuerOrigin,keyId,keySha256,schemaVersion'
      || binding.schemaVersion !== 1 || binding.issuerOrigin !== ORIGIN
      || typeof binding.keyId !== 'string' || !ID.test(binding.keyId)
      || typeof binding.keySha256 !== 'string' || !SHA.test(binding.keySha256)
      || binding.keySha256 !== createHash('sha256').update(key).digest('hex')) return undefined;
    return binding.keyId;
  } catch { return undefined; }
}
