import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueMemberToken, listMemberTokens, machineForToken, revokeMemberToken } from './member-tokens.js';

const roots: string[] = [];
function root() { const dir = mkdtempSync(join(tmpdir(), 'control-member-')); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('issuance persists only a hash and timestamp; replacement and revocation invalidate old credentials', () => {
  const dir = root();
  const first = issueMemberToken('node-b', dir);
  const second = issueMemberToken('node-b', dir);
  const path = join(dir, 'control', 'member-tokens.json');
  const contents = readFileSync(path, 'utf8');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(contents).not.toContain(first);
  expect(contents).not.toContain(second);
  const parsed = JSON.parse(contents) as Record<string, { sha256: string; issuedAt: string }>;
  expect(parsed.node-b.sha256).toBe(createHash('sha256').update(second).digest('hex'));
  expect(parsed.node-b.issuedAt).toBe(listMemberTokens(dir)[0]?.issuedAt);
  expect(listMemberTokens(dir)).toEqual([{ machine: 'node-b', issuedAt: parsed.node-b.issuedAt }]);
  expect(machineForToken(first, dir)).toBeUndefined();
  expect(machineForToken('random', dir)).toBeUndefined();
  expect(machineForToken(second, dir)).toBe('node-b');
  chmodSync(path, 0o644);
  expect(listMemberTokens(dir)).toHaveLength(1);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  revokeMemberToken('node-b', dir);
  expect(machineForToken(second, dir)).toBeUndefined();
  expect(listMemberTokens(dir)).toEqual([]);
});

test('machine identifiers must be safe storage keys', () => {
  const dir = root();
  for (const machine of ['', '__proto__', '../other', 'mbp/other', 'a b']) {
    expect(() => issueMemberToken(machine, dir)).toThrow('invalid control machine');
    expect(() => revokeMemberToken(machine, dir)).toThrow('invalid control machine');
  }
  expect(listMemberTokens(dir)).toEqual([]);
});
