import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SMALL_LEDGER_BYTES, buildGeneration, isSecretPath, planSnapshot, stripHostLocalConfig, survivalPaths } from './standby-snapshot';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'hq-standby-'));
  roots.push(root);
  const write = (rel: string, body: string | Buffer) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), body); };
  const db = (rel: string) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    spawnSync('sqlite3', [join(root, rel), 'CREATE TABLE t(x); INSERT INTO t VALUES (1),(2),(3);']);
  };
  db('schedules.db');
  db('tasks/tasks.db');
  db('release/features.sqlite');
  write('decisions/decisions.jsonl', '{"id":"D-1"}\n');
  write('config.json', '{"telegram":{"botToken":"x"},"hq":{"hostName":"mbp","arbiter":"cloud-vm"}}');
  write('config.json.bak-old', '{}');
  write('auth.json', '{"secret":true}');
  write('secrets/key.json', '{}');
  write('release/0.2.13/checklist.json', '{}');
  write('release/0.2.11/gate-logs/cut/pod-1.log', 'x'.repeat(10));
  write('conatus/big.db', Buffer.alloc(SMALL_LEDGER_BYTES + 1));
  write('logs/logs.db', 'not copied in core');
  write('hq-drill/round-trip.jsonl', '{"host":"MacStudioB1","nonce":"n1"}\n');
  write('hq/local.json', '{"holder":"MacBookProM5","generation":1}');
  return root;
}

test('secret-looking paths are recognized', () => {
  for (const p of ['auth.json', 'secrets/key.json', 'apns.p8', 'botlab.env', 'acp-token.json', 'backup-key', 'x/github-token']) expect(isSecretPath(p)).toBe(true);
  for (const p of ['decisions/decisions.jsonl', 'schedules.db', 'release/0.2.13/checklist.json']) expect(isSecretPath(p)).toBe(false);
});

test('core takes only listed ledgers at or under the size cap; big takes the larger ones; nothing else rides along', () => {
  const root = fixture();
  const core = planSnapshot(root, 'core').map(i => i.rel);
  expect(core).toContain('schedules.db');
  expect(core).toContain('config.json');
  expect(core).toContain('release/0.2.13/checklist.json');
  // The drill round-trip marker rides with core; the host's own lease state (hq/local.json) never leaves the host.
  expect(core).toContain('hq-drill/round-trip.jsonl');
  expect(core).not.toContain('hq/local.json');
  for (const p of ['config.json.bak-old', 'auth.json', 'secrets/key.json', 'release/0.2.11/gate-logs/cut/pod-1.log', 'logs/logs.db', 'conatus/big.db']) expect(core).not.toContain(p);
  expect(planSnapshot(root, 'big').map(i => i.rel)).toEqual(['conatus/big.db']);
  expect(planSnapshot(root, 'obs').map(i => i.rel)).toEqual(['logs/logs.db']);
});

test('a generation has a consistent SQLite copy, a sha256 per file, and a survival subset without secrets or config', () => {
  const root = fixture();
  const out = join(root, '..', `${root.split('/').pop()}-out`);
  roots.push(out);
  const manifest = buildGeneration({ root, out, tier: 'core', now: new Date('2026-10-04T00:00:00Z') });
  expect(manifest.generation).toBe('20261004T000000Z');
  // The manifest names the host that took the snapshot (the round-trip check reads it) — not a fixed «mbp».
  expect(manifest.host).toBe(hostname().replace(/\.local$/, ''));
  const rows = spawnSync('sqlite3', [join(out, 'schedules.db'), 'SELECT count(*) FROM t;'], { encoding: 'utf8' }).stdout.trim();
  expect(rows).toBe('3');
  const sums = readFileSync(join(out, 'SHA256SUMS'), 'utf8');
  expect(sums.split('\n').filter(Boolean)).toHaveLength(manifest.entries.length);
  const check = spawnSync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: out, encoding: 'utf8' });
  expect(check.status).toBe(0);
  const survival = survivalPaths(manifest, root);
  expect(survival).toContain('decisions/decisions.jsonl');
  expect(survival).toContain('schedules.db');
  expect(survival).not.toContain('config.json');
  expect(survival.some(isSecretPath)).toBe(false);
});

test('the copied config.json drops the host-local hq block (OP 12:02) and keeps everything else; the checksum matches the copy', () => {
  const root = fixture();
  const out = join(root, '..', `${root.split('/').pop()}-cfg`);
  roots.push(out);
  const manifest = buildGeneration({ root, out, tier: 'core', now: new Date('2026-10-04T03:00:00Z') });
  const copied = JSON.parse(readFileSync(join(out, 'config.json'), 'utf8'));
  expect(copied.hq).toBeUndefined();
  expect(copied.telegram).toEqual({ botToken: 'x' });
  const entry = manifest.entries.find(e => e.path === 'config.json')!;
  const sums = readFileSync(join(out, 'SHA256SUMS'), 'utf8');
  expect(sums).toContain(`${entry.sha256}  config.json`);
  expect(spawnSync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: out, encoding: 'utf8' }).stdout).toContain('config.json: OK');
  // the source is untouched
  expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).hq).toEqual({ hostName: 'mbp', arbiter: 'cloud-vm' });
});

test('stripHostLocalConfig leaves a config without hq, and unparsable text, byte-identical', () => {
  expect(stripHostLocalConfig('{"a":1}')).toBe('{"a":1}');
  expect(stripHostLocalConfig('not json')).toBe('not json');
  expect(JSON.parse(stripHostLocalConfig('{"hq":{"hostName":"mbp"},"b":2}'))).toEqual({ b: 2 });
});
