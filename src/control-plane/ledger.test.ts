import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceLedger } from './ledger.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('ledger retains expired records and persists owner-restricted changes in a 0600 file', () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-ledger-'));
  roots.push(root);
  const ledger = new ResourceLedger(root);
  const row = { id: 'm1', kind: 'machine' as const, machine: 'host', name: 'host', owner: 'untrusted', attrs: {}, observedAt: 100, ttlMs: 50 };
  expect(ledger.register(row, 'member-a').owner).toBe('member-a');
  expect(ledger.list({}, 149)[0]).toMatchObject({ ageMs: 49, expired: false });
  expect(ledger.list({}, 150)[0]).toMatchObject({ ageMs: 50, expired: true });
  expect(ledger.list({}, 151)[0]).toMatchObject({ id: 'm1', ageMs: 51, expired: true });
  expect(new ResourceLedger(root).list({}, 151)).toHaveLength(1);
  expect(statSync(ledger.path).mode & 0o777).toBe(0o600);
  expect(() => ledger.register(row, 'member-b')).toThrow('not-owner');
  expect(() => ledger.heartbeat('m1', 'member-b', {}, 200)).toThrow('not-owner');
  expect(() => ledger.delete('m1', 'member-b')).toThrow('not-owner');
  expect(ledger.list({}, 151)).toHaveLength(1);
  expect(ledger.heartbeat('m1', 'member-a', { load: 2 }, 200).attrs).toEqual({ load: 2 });
  expect(ledger.list({}, 201)[0]).toMatchObject({ ageMs: 1, expired: false });
  expect(readFileSync(ledger.path, 'utf8')).toContain('member-a');
  ledger.delete('m1', 'member-a');
  expect(ledger.list()).toEqual([]);
});

test('a zero-TTL record expires at registration time without being deleted', () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-ledger-zero-'));
  roots.push(root);
  const ledger = new ResourceLedger(root);
  ledger.register({ id: 'zero', kind: 'machine', machine: 'host', name: 'host', owner: 'untrusted', attrs: {}, observedAt: 100, ttlMs: 0 }, 'member-a');
  expect(ledger.list({}, 100)[0]).toMatchObject({ ageMs: 0, expired: true });
  expect(ledger.list({}, 100)).toHaveLength(1);
});
