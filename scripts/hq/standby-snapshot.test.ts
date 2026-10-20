import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SMALL_LEDGER_BYTES, assertSurvivalKeepArgs, buildGeneration, isSecretPath, planSnapshot, snapshotItem, stripHostLocalConfig, survivalPaths } from './standby-snapshot';

const roots: string[] = [];
// GATE-PREEXISTING-ZERO — fixtures and read-backs go through bun:sqlite (in-process); only the product's own
//   `sqlite3 VACUUM INTO` stays a real spawn. On a loaded gate Pod each sqlite3 spawn took ~2s, so a fixture of three
//   spawns plus the snapshot ran past bun's 5s default (0.2.30 HARD #3). Tests that spawn get an explicit cap.
const SPAWN_TEST_TIMEOUT_MS = 60_000;
function sqlExec(path: string, sql: string): void {
  const db = new Database(path, { create: true });
  try { db.exec(sql); } finally { db.close(); }
}
function sqlRows(path: string, sql: string): string[] {
  const db = new Database(path, { readonly: true });
  try { return db.query(sql).values().map(row => String(row[0])); } finally { db.close(); }
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'hq-standby-'));
  roots.push(root);
  const write = (rel: string, body: string | Buffer) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), body); };
  const db = (rel: string) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    sqlExec(join(root, rel), 'CREATE TABLE t(x); INSERT INTO t VALUES (1),(2),(3);');
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
  expect(sqlRows(join(out, 'schedules.db'), 'SELECT count(*) FROM t;')).toEqual(['3']);
  const sums = readFileSync(join(out, 'SHA256SUMS'), 'utf8');
  expect(sums.split('\n').filter(Boolean)).toHaveLength(manifest.entries.length);
  const check = spawnSync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: out, encoding: 'utf8' });
  expect(check.status).toBe(0);
  const survival = survivalPaths(manifest, root);
  expect(survival).toContain('decisions/decisions.jsonl');
  expect(survival).toContain('schedules.db');
  expect(survival).not.toContain('config.json');
  expect(survival.some(isSecretPath)).toBe(false);
}, SPAWN_TEST_TIMEOUT_MS);

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
}, SPAWN_TEST_TIMEOUT_MS);

test('stripHostLocalConfig leaves a config without hq, and unparsable text, byte-identical', () => {
  expect(stripHostLocalConfig('{"a":1}')).toBe('{"a":1}');
  expect(stripHostLocalConfig('not json')).toBe('not json');
  expect(JSON.parse(stripHostLocalConfig('{"hq":{"hostName":"mbp"},"b":2}'))).toEqual({ b: 2 });
});

test('sqlite snapshot uses one consistent copy and replaces a stale destination (VACUUM INTO, not .backup)', () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-standby-vac-'));
  roots.push(root);
  const out = join(root, 'out');
  mkdirSync(join(root, 'logs'), { recursive: true });
  sqlExec(join(root, 'logs/logs.db'), 'PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1),(2),(3);');
  // A destination left by an earlier generation must not make VACUUM INTO fail ("output file already exists").
  mkdirSync(join(out, 'logs'), { recursive: true });
  writeFileSync(join(out, 'logs/logs.db'), 'stale');
  snapshotItem(root, out, { rel: 'logs/logs.db', kind: 'sqlite' } as Parameters<typeof snapshotItem>[2]);
  expect(sqlRows(join(out, 'logs/logs.db'), 'SELECT count(*) FROM t;')).toEqual(['3']);
  expect(sqlRows(join(out, 'logs/logs.db'), 'PRAGMA integrity_check;')).toEqual(['ok']);
}, SPAWN_TEST_TIMEOUT_MS);

function runSnapshotCli(...args: string[]) {
  // Production entry path: spawn the script so import.meta.main argv parse runs (not a source-string check).
  return spawnSync(process.execPath, [join(import.meta.dir, 'standby-snapshot.ts'), ...args], {
    encoding: 'utf8',
    cwd: join(import.meta.dir, '..', '..'),
    env: { ...process.env, ELANOUS_STATE_DIR: join(tmpdir(), 'hq-standby-missing-state-never') },
  });
}

test('valueless --survival-keep(-daily) and targetless --prune-survival exit 2 before snapshot work', () => {
  for (const flag of ['--survival-keep', '--survival-keep-daily', '--prune-survival'] as const) {
    expect(() => assertSurvivalKeepArgs([flag])).toThrow(`${flag} requires a value`);
    expect(() => assertSurvivalKeepArgs([flag, '--dry-run'])).toThrow(`${flag} requires a value`);
    expect(() => assertSurvivalKeepArgs([`${flag}=`])).toThrow(`${flag} requires a value`);
    const bare = runSnapshotCli(flag);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toContain(`${flag} requires a value`);
    // Must refuse before planSnapshot/buildGeneration — a dry-run would otherwise exit 0 with a plan.
    const withDryRun = runSnapshotCli(flag, '--dry-run', '--json');
    expect(withDryRun.status).toBe(2);
    expect(withDryRun.stderr).toContain(`${flag} requires a value`);
    expect(withDryRun.stdout).toBe('');
    // Equals-form empty value is still a valueless occurrence on the production entry path.
    const equalsEmpty = runSnapshotCli(`${flag}=`, '--dry-run', '--json');
    expect(equalsEmpty.status).toBe(2);
    expect(equalsEmpty.stderr).toContain(`${flag} requires a value`);
    expect(equalsEmpty.stdout).toBe('');
  }
  // A value present is accepted by the keep/prune gate (other work may still fail later).
  expect(() => assertSurvivalKeepArgs(['--survival-keep', '7', '--dry-run'])).not.toThrow();
  expect(() => assertSurvivalKeepArgs(['--survival-keep-daily', '3'])).not.toThrow();
  expect(() => assertSurvivalKeepArgs(['--prune-survival', 's3://bucket/prefix'])).not.toThrow();
  // Boundary: a valued equals-form occurrence is not a valueless one; consume-or-reject for that
  // shape stays outside this cell's line.
  expect(() => assertSurvivalKeepArgs(['--survival-keep=7'])).not.toThrow();
  const valued = runSnapshotCli('--survival-keep', '7', '--dry-run', '--json');
  expect(valued.status).toBe(0);
  expect(JSON.parse(valued.stdout)).toMatchObject({ tier: 'core' });
  // A valid first occurrence must not hide a later valueless occurrence on the production entry path.
  const repeated = runSnapshotCli('--survival-keep', '7', '--survival-keep', '--dry-run', '--json');
  expect(repeated.status).toBe(2);
  expect(repeated.stderr).toContain('--survival-keep requires a value');
  expect(repeated.stdout).toBe('');
}, SPAWN_TEST_TIMEOUT_MS);
