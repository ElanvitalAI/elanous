import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { newUlid } from '../../src/mss/ulid.js';
import {
  __resetIdentityForTests,
  __setIdentityFileForTests,
  getOrCreateElanousId,
} from '../../src/mss/identity-store.js';

describe('mss identity', () => {
  let dir: string;
  let idFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mss-identity-'));
    idFile = join(dir, 'identity.json');
    __setIdentityFileForTests(idFile);
  });

  afterEach(() => {
    __setIdentityFileForTests(null);
    __resetIdentityForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  test('newUlid → 26-char Crockford base32', () => {
    const u = newUlid();
    expect(u).toHaveLength(26);
    expect(u).toMatch(/^[0-9A-HJKMNPQRSTVWXYZ]{26}$/);
  });

  test('newUlid monotonic timestamp prefix increases with time', () => {
    const a = newUlid(1_700_000_000_000);
    const b = newUlid(1_700_000_001_000);
    expect(b.slice(0, 10) > a.slice(0, 10)).toBe(true);
  });

  test('first call creates identity file; second call returns cached value', () => {
    const id1 = getOrCreateElanousId();
    expect(id1).toHaveLength(26);
    const fileContent = JSON.parse(readFileSync(idFile, 'utf8'));
    expect(fileContent.elanous_id).toBe(id1);
    expect(fileContent.schema_version).toBe(1);

    const id2 = getOrCreateElanousId();
    expect(id2).toBe(id1);
  });

  test('persisted identity recovered after cache reset', () => {
    const id1 = getOrCreateElanousId();
    __resetIdentityForTests();
    const id2 = getOrCreateElanousId();
    expect(id2).toBe(id1);
  });

  test('corrupt file triggers regeneration without throwing', () => {
    writeFileSync(idFile, 'not-json-at-all');
    const id = getOrCreateElanousId();
    expect(id).toHaveLength(26);
    const reloaded = JSON.parse(readFileSync(idFile, 'utf8'));
    expect(reloaded.elanous_id).toBe(id);
  });

  test('wrong-length elanous_id treated as corrupt and regenerated', () => {
    writeFileSync(idFile, JSON.stringify({ elanous_id: 'tooshort', schema_version: 1 }));
    const id = getOrCreateElanousId();
    expect(id).toHaveLength(26);
    expect(id).not.toBe('tooshort');
  });
});
