import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueMcpPat, listMcpPats, matchMcpPat, revokeMcpPat } from './pat-store.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mcp-pat-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

test('PAT persists only SHA-256 and timestamps in a private file; list never exposes credentials', () => {
  const issued = issueMcpPat('laptop', { expiresDays: 30 }, root);
  const path = join(root, 'mcp-gateway', 'pats.json');
  const raw = readFileSync(path, 'utf8');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(root, 'mcp-gateway')).mode & 0o777).toBe(0o700);
  expect(raw).not.toContain(issued.token);
  expect(JSON.parse(raw).tokens).toEqual([{ name: 'laptop', hash: createHash('sha256').update(issued.token).digest('hex'), createdAt: issued.createdAt, expiresAt: issued.expiresAt }]);
  expect(listMcpPats(root)).toEqual([{ name: 'laptop', createdAt: issued.createdAt, expiresAt: issued.expiresAt }]);
  expect(JSON.stringify(listMcpPats(root))).not.toContain(issued.token);
  expect(matchMcpPat(issued.token, Date.now(), root)?.name).toBe('laptop');
  expect(matchMcpPat(issued.token, Date.parse(issued.expiresAt!), root)).toBeNull();
  expect(revokeMcpPat('laptop', root)).toBe(true);
  expect(matchMcpPat(issued.token, Date.now(), root)).toBeNull();
  expect(revokeMcpPat('laptop', root)).toBe(false);
});

test('invalid names, duplicate names and corrupt/insecure stores fail closed', () => {
  const issued = issueMcpPat('one', {}, root);
  for (const name of ['', '../evil', 'space name', 'one']) expect(() => issueMcpPat(name, {}, root)).toThrow();
  for (const expiresDays of [0, -1, 1.2, Number.NaN]) expect(() => issueMcpPat('two', { expiresDays }, root)).toThrow();
  expect(matchMcpPat('wrong', Date.now(), root)).toBeNull();
  const path = join(root, 'mcp-gateway', 'pats.json');
  chmodSync(path, 0o644);
  expect(() => matchMcpPat(issued.token, Date.now(), root)).toThrow();
  expect(() => revokeMcpPat('one', root)).toThrow();
});

test('cross-process issuers keep all entries under a file lock', async () => {
  const moduleUrl = new URL('./pat-store.ts', import.meta.url).href;
  const children = Array.from({ length: 6 }, (_, i) => Bun.spawn(['bun', '-e', `import { issueMcpPat } from ${JSON.stringify(moduleUrl)}; issueMcpPat('worker-' + process.env.WORKER, {}, process.env.ROOT);`],
    { env: { ...process.env, ROOT: root, WORKER: String(i) }, stdout: 'pipe', stderr: 'pipe' }));
  expect(await Promise.all(children.map((child) => child.exited))).toEqual(Array(6).fill(0));
  expect(listMcpPats(root)).toHaveLength(6);
});
