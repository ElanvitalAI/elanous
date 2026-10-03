import { setDefaultTimeout, afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectPodAbsorb } from './collect-pod.js';
import { ingestIntakeItems, loadIntakeLedger, markIntakeItem } from './items.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'collect-pod-'));
  dirs.push(base);
  const root = join(base, 'instance');
  const vaultRoot = join(base, 'vault');
  const dir = join(base, 'artifacts');
  mkdirSync(dir, { recursive: true });
  const now = '2026-09-27T00:00:00.000Z';
  ingestIntakeItems(root, 'youtube', [{ url: 'https://www.youtube.com/watch?v=abcdefghijk' }], now, () => {});
  const id = [...loadIntakeLedger(root).items.keys()][0]!;
  markIntakeItem(root, id, { status: 'queued' }, now);
  const ledgerPath = join(root, 'intake', 'items.jsonl');
  const initialLedger = readFileSync(ledgerPath);
  const run = (dryRun = false) => collectPodAbsorb(root, { dir, id, vaultRoot, dryRun, now: '2026-09-27T01:00:00.000Z' });
  const writeResult = (value: unknown) => writeFileSync(join(dir, 'result.json'), JSON.stringify(value));
  return { base, root, vaultRoot, dir, id, run, writeResult, ledgerPath, initialLedger };
}

test('success publishes nested note once and marks the ledger with absolute output', () => {
  const f = fixture();
  mkdirSync(join(f.dir, 'vault', 'a'), { recursive: true });
  writeFileSync(join(f.dir, 'vault', 'a', 'n1.md'), '# note\n');
  f.writeResult({ ok: true, url: 'https://example.org', note: 'a/n1.md', rc: 0 });
  const target = join(f.vaultRoot, 'a', 'n1.md');
  expect(f.run()).toEqual({ outcome: 'absorbed', note: target });
  expect(readFileSync(target, 'utf8')).toBe('# note\n');
  expect(loadIntakeLedger(f.root).items.get(f.id)).toMatchObject({ status: 'absorbed', outputs: [{ kind: 'note', ref: target }] });
  expect(readdirSync(join(f.vaultRoot, 'a'))).toEqual(['n1.md']);
});

test('failed job defers the ledger with rc as reason', () => {
  const f = fixture();
  f.writeResult({ ok: false, url: 'https://example.org', rc: 13, log: 'absorb.log' });
  expect(f.run()).toEqual({ outcome: 'failed', reason: '13' });
  expect(loadIntakeLedger(f.root).items.get(f.id)?.status).toBe('deferred');
  expect(existsSync(f.vaultRoot)).toBe(false);
});

test('existing note is never overwritten and the ledger is unchanged', () => {
  const f = fixture();
  mkdirSync(join(f.dir, 'vault', 'a'), { recursive: true });
  mkdirSync(join(f.vaultRoot, 'a'), { recursive: true });
  writeFileSync(join(f.dir, 'vault', 'a', 'n1.md'), 'new bytes');
  const target = join(f.vaultRoot, 'a', 'n1.md');
  writeFileSync(target, 'old bytes');
  f.writeResult({ ok: true, url: 'https://example.org', note: 'a/n1.md', rc: 0 });
  expect(f.run().outcome).toBe('conflict');
  expect(readFileSync(target, 'utf8')).toBe('old bytes');
  expect(readFileSync(f.ledgerPath)).toEqual(f.initialLedger);
});

test('parent traversal, absolute paths and non-markdown paths are invalid without writes', () => {
  for (const note of ['../x.md', '/tmp/x.md', 'a/../x.md', 'a/n1.txt', 'a\\n1.md']) {
    const f = fixture();
    f.writeResult({ ok: true, url: 'https://example.org', note, rc: 0 });
    expect(f.run().outcome).toBe('invalid');
    expect(existsSync(join(f.base, 'x.md'))).toBe(false);
    expect(existsSync(f.vaultRoot)).toBe(false);
    expect(readFileSync(f.ledgerPath)).toEqual(f.initialLedger);
  }
});

test('missing or malformed result and missing source are invalid without ledger updates', () => {
  const f = fixture();
  expect(f.run().outcome).toBe('invalid');
  f.writeResult({ ok: true, note: 'a/n1.md', rc: 0 });
  expect(f.run().outcome).toBe('invalid');
  f.writeResult({ ok: true, url: 'https://example.org', note: 'a/n1.md', rc: 0 });
  expect(f.run().outcome).toBe('invalid');
  expect(readFileSync(f.ledgerPath)).toEqual(f.initialLedger);
});

test('symlinked source and destination parent cannot escape their roots', () => {
  const f = fixture();
  mkdirSync(join(f.dir, 'vault'), { recursive: true });
  mkdirSync(join(f.base, 'outside'), { recursive: true });
  writeFileSync(join(f.base, 'outside', 'n1.md'), 'outside');
  symlinkSync(join(f.base, 'outside'), join(f.dir, 'vault', 'a'));
  f.writeResult({ ok: true, url: 'https://example.org', note: 'a/n1.md', rc: 0 });
  expect(f.run().outcome).toBe('invalid');
  rmSync(join(f.dir, 'vault', 'a'));
  mkdirSync(join(f.dir, 'vault', 'a'));
  writeFileSync(join(f.dir, 'vault', 'a', 'n1.md'), 'safe');
  mkdirSync(f.vaultRoot);
  symlinkSync(join(f.base, 'outside'), join(f.vaultRoot, 'a'));
  rmSync(join(f.base, 'outside', 'n1.md'));
  expect(f.run().outcome).toBe('invalid');
  expect(existsSync(join(f.base, 'outside', 'n1.md'))).toBe(false);
  expect(readFileSync(f.ledgerPath)).toEqual(f.initialLedger);
});

test('CLI collect-pod JSON dry-run dispatches to the collector and prints one result line', () => {
  const f = fixture();
  mkdirSync(join(f.dir, 'vault', 'a'), { recursive: true });
  writeFileSync(join(f.dir, 'vault', 'a', 'n1.md'), '# preview');
  f.writeResult({ ok: true, url: 'https://example.org', note: 'a/n1.md', rc: 0 });
  const cli = fileURLToPath(new URL('../../bin/elanous.mjs', import.meta.url));
  const proc = spawnSync(process.execPath, [cli, '--test', 'intake', 'collect-pod', f.dir, '--id', f.id, '--vault', f.vaultRoot, '--dry-run', '--json'], {
    cwd: join(import.meta.dir, '../..'), encoding: 'utf8', timeout: 30_000,
  });
  expect(proc.status).toBe(0);
  expect(proc.stdout.trim().split('\n')).toEqual([JSON.stringify({ outcome: 'invalid', reason: 'id not in ledger' })]);
  expect(existsSync(f.vaultRoot)).toBe(false);
  expect(readFileSync(f.ledgerPath)).toEqual(f.initialLedger);
});

test('dry-run reports would-be success, failure and conflict without changing files or ledger', () => {
  const f = fixture();
  mkdirSync(join(f.dir, 'vault', 'a'), { recursive: true });
  writeFileSync(join(f.dir, 'vault', 'a', 'n1.md'), '# preview');
  f.writeResult({ ok: true, url: 'https://example.org', note: 'a/n1.md', rc: 0 });
  const target = join(f.vaultRoot, 'a', 'n1.md');
  expect(f.run(true)).toEqual({ outcome: 'absorbed', note: target });
  expect(existsSync(f.vaultRoot)).toBe(false);
  expect(readFileSync(f.ledgerPath)).toEqual(f.initialLedger);
  mkdirSync(join(f.vaultRoot, 'a'), { recursive: true });
  writeFileSync(target, 'original');
  expect(f.run(true).outcome).toBe('conflict');
  expect(readFileSync(target, 'utf8')).toBe('original');
  f.writeResult({ ok: false, url: 'https://example.org', rc: 2, log: 'absorb.log' });
  expect(f.run(true)).toEqual({ outcome: 'failed', reason: '2' });
  expect(readFileSync(f.ledgerPath)).toEqual(f.initialLedger);
});
