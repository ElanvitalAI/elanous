import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readQueryCache } from './short-lived-read-cache.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('read query cache reuses a matching source and reloads after an external write', () => {
  const root = mkdtempSync(join(tmpdir(), 'eln-read-cache-'));
  roots.push(root);
  const source = join(root, 'messages.db');
  const cacheRoot = join(root, 'cache');
  writeFileSync(source, 'seq=1');
  let loads = 0;
  const run = () => readQueryCache({ root: cacheRoot, key: { to: 'OP', after: 0 }, sourcePaths: [source],
    ttlMs: 500, now: () => 1000, load: () => ({ seq: ++loads }) });

  expect(run()).toEqual({ seq: 1 });
  expect(run()).toEqual({ seq: 1 });
  expect(loads).toBe(1);
  const cacheName = createHash('sha256').update(JSON.stringify({ to: 'OP', after: 0 })).digest('hex');
  expect(JSON.parse(readFileSync(join(cacheRoot, `${cacheName}.json`), 'utf8'))).toMatchObject({ version: 1 });

  writeFileSync(source, 'seq=2-and-changed-size');
  expect(run()).toEqual({ seq: 2 });
  expect(loads).toBe(2);
});

test('expired or unstable source entries never return an old value', () => {
  const root = mkdtempSync(join(tmpdir(), 'eln-read-cache-expiry-'));
  roots.push(root);
  const source = join(root, 'ledger');
  writeFileSync(source, 'one');
  let now = 100;
  let loads = 0;
  const run = () => readQueryCache({ root: join(root, 'cache'), key: 'list', sourcePaths: [source], ttlMs: 10,
    now: () => now, load: () => ++loads });

  expect(run()).toBe(1);
  now = 111;
  expect(run()).toBe(2);
  expect(loads).toBe(2);
});

test('an optional SQLite WAL appearing or changing invalidates the cached query', () => {
  const root = mkdtempSync(join(tmpdir(), 'eln-read-cache-wal-'));
  roots.push(root);
  const db = join(root, 'messages.db');
  const wal = `${db}-wal`;
  writeFileSync(db, 'schema');
  let loads = 0;
  const run = () => readQueryCache({ root: join(root, 'cache'), key: 'msg-list', sourcePaths: [db, wal],
    ttlMs: 500, now: () => 100, load: () => ++loads });

  expect(run()).toBe(1);
  expect(run()).toBe(1);
  writeFileSync(wal, 'commit 1');
  expect(run()).toBe(2);
  expect(run()).toBe(2);
  expect(loads).toBe(2);
});

test('cache files are bounded and expired entries are pruned as query keys change', () => {
  const root = mkdtempSync(join(tmpdir(), 'eln-read-cache-prune-'));
  roots.push(root);
  const source = join(root, 'ledger');
  const cacheRoot = join(root, 'cache');
  writeFileSync(source, 'stable');
  let now = 100;
  const run = (key: string) => readQueryCache({ root: cacheRoot, key, sourcePaths: [source], ttlMs: 1,
    now: () => now, load: () => key });

  for (let index = 0; index < 140; index += 1) run(`query-${index}`);
  expect(readdirSync(cacheRoot)).toHaveLength(128);
  now = 102;
  run('after-expiry-new-key');
  expect(readdirSync(cacheRoot)).toEqual([
    createHash('sha256').update(JSON.stringify('after-expiry-new-key')).digest('hex') + '.json',
  ]);
});
