import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { buildGeneration } from './standby-snapshot';
import { parsePromoteArgs, promote } from './standby-promote';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function write(path: string, contents: string): void { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, contents); }
function files(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(root, path);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) result[rel] = `link:${readlinkSync(path)}`;
      else if (stat.isDirectory()) walk(path);
      else result[rel] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  }
  walk(root);
  return result;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hq-promote-'));
  roots.push(root);
  const source = join(root, 'source');
  const standby = join(root, 'standby');
  const to = join(root, 'promoted');
  const host = join(root, 'hqcfg');
  write(join(source, 'config.json'), JSON.stringify({ telegram: { enabled: true, token: 'x' }, discord: { enabled: true, token: 'y' }, hq: { hostName: 'mbp' } }));
  mkdirSync(join(source, 'release'), { recursive: true });
  const features = new Database(join(source, 'release', 'features.sqlite'));
  features.exec('CREATE TABLE features (enabled INTEGER)');
  features.exec('INSERT INTO features VALUES (1)');
  features.close();
  const sqlite3 = join(root, 'sqlite3');
  write(sqlite3, `#!/usr/bin/env python3\nimport sqlite3, sys\nsrc = sqlite3.connect(sys.argv[1])\nif sys.argv[2].startswith(".backup '"):\n    dest = sqlite3.connect(sys.argv[2][9:-1].replace("''", "'"))\n    src.backup(dest)\n    dest.close()\nelse:\n    src.executescript(sys.argv[2])\nsrc.close()\n`);
  chmodSync(sqlite3, 0o700);
  write(join(source, 'decisions', 'entry.jsonl'), 'one');
  write(join(host, 'config.json'), JSON.stringify({ hq: { hostName: 'node-b', arbiter: 'cloud-vm' } }));
  const core = buildGeneration({ root: source, out: join(standby, 'core', '20261004T000000Z'), tier: 'core', now: new Date('2026-10-04T00:00:00Z'), sqlite3 });
  symlinkSync(core.generation, join(standby, 'core', 'latest'));
  // A valid large SQLite ledger exercises the big tier's size rule and .backup path.
  mkdirSync(join(source, 'conatus'), { recursive: true });
  const large = new Database(join(source, 'conatus', 'large.db'));
  large.exec('CREATE TABLE payload (data BLOB)');
  large.query('INSERT INTO payload VALUES (?)').run(Buffer.alloc(20 * 1024 * 1024 + 1));
  large.close();
  const big = buildGeneration({ root: source, out: join(standby, 'big', '20261004T010000Z'), tier: 'big', now: new Date('2026-10-04T01:00:00Z'), sqlite3 });
  symlinkSync(big.generation, join(standby, 'big', 'latest'));
  return { standby, to, host, core, big, before: files(standby) };
}

function run(f: ReturnType<typeof fixture>, ...args: string[]) {
  const r = spawnSync('bun', ['scripts/hq/standby-promote.ts', '--standby', f.standby, '--to', f.to, ...args], { cwd: join(import.meta.dir, '..', '..'), encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

test('promotes verified core then big; backs up config, switches pollers off and installs host hq settings', () => {
  const f = fixture();
  const r = run(f, '--hq-config', f.host);
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(new RegExp(`^promoted .* core=${f.core.generation} big=${f.big.generation} files=${f.core.entries.length + f.big.entries.length} features=yes pollers=off hq=node-b [0-9]+s$`));
  expect(lstatSync(f.to).mode & 0o777).toBe(0o700);
  const config = JSON.parse(readFileSync(join(f.to, 'config.json'), 'utf8'));
  expect(config.telegram).toEqual({ enabled: false, token: 'x' });
  expect(config.discord).toEqual({ enabled: false, token: 'y' });
  expect(config.hq).toEqual({ hostName: 'node-b', arbiter: 'cloud-vm' });
  expect(JSON.parse(readFileSync(join(f.to, 'config.json.pre-promote'), 'utf8')).hq).toBeUndefined();
  const promotedDb = new Database(join(f.to, 'release', 'features.sqlite'), { readonly: true });
  expect(promotedDb.query('SELECT enabled FROM features').get()).toEqual({ enabled: 1 });
  promotedDb.close();
  expect(readFileSync(join(f.to, 'conatus', 'large.db')).length).toBeGreaterThan(20 * 1024 * 1024);
  expect(existsSync(join(f.to, 'SHA256SUMS'))).toBe(false);
  expect(existsSync(join(f.to, 'MANIFEST.json'))).toBe(false);
  const promoted = Object.keys(files(f.to));
  expect(promoted.filter(name => name !== 'config.json.pre-promote')).toHaveLength(f.core.entries.length + f.big.entries.length);
  for (const entry of [...f.core.entries, ...f.big.entries]) expect(promoted).toContain(entry.path);
  expect(files(f.standby)).toEqual(f.before);
  expect(JSON.parse(readFileSync(join(f.host, 'config.json'), 'utf8')).hq.hostName).toBe('node-b');
});

test('existing target is refused without changing target or standby, including on a second invocation', () => {
  const f = fixture();
  expect(run(f, '--hq-config', f.host).status).toBe(0);
  const beforeTarget = files(f.to);
  const r = run(f, '--hq-config', f.host);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('target already exists');
  expect(files(f.to)).toEqual(beforeTarget);
  expect(files(f.standby)).toEqual(f.before);
});

test('corrupted or missing standby bytes refuse before creating target', () => {
  for (const change of ['corrupt', 'missing']) {
    const f = fixture();
    const path = join(f.standby, 'core', f.core.generation, 'config.json');
    if (change === 'corrupt') writeFileSync(path, 'changed');
    else rmSync(path);
    const before = files(f.standby);
    const r = run(f, '--hq-config', f.host);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/checksum mismatch|ENOENT/);
    expect(existsSync(f.to)).toBe(false);
    expect(files(f.standby)).toEqual(before);
  }
});

test('dry-run checks checksums and existing target, prints plan and writes no target', () => {
  const f = fixture();
  const r = run(f, '--dry-run');
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(`core=${f.core.generation} big=${f.big.generation} files=${f.core.entries.length + f.big.entries.length}`);
  expect(existsSync(f.to)).toBe(false);
  expect(files(f.standby)).toEqual(f.before);
  write(f.to, 'existing');
  expect(run(f, '--dry-run').status).toBe(1);
  expect(files(f.standby)).toEqual(f.before);
  rmSync(f.to);
  const damaged = join(f.standby, 'big', f.big.generation, 'conatus', 'large.db');
  writeFileSync(damaged, 'bad');
  const beforeCorruptDryRun = files(f.standby);
  expect(run(f, '--dry-run').status).toBe(1);
  expect(existsSync(f.to)).toBe(false);
  expect(files(f.standby)).toEqual(beforeCorruptDryRun);
});

test('target cannot be placed inside standby, including through a parent symlink', () => {
  const f = fixture();
  const directTo = join(f.standby, 'new-target');
  const direct = run({ ...f, to: directTo });
  expect(direct.status).toBe(1);
  expect(existsSync(directTo)).toBe(false);
  const alias = join(f.to, '..', 'standby-alias');
  symlinkSync(f.standby, alias);
  const linked = run({ ...f, to: join(alias, 'new-target') });
  expect(linked.status).toBe(1);
  expect(existsSync(join(f.standby, 'new-target'))).toBe(false);
  expect(files(f.standby)).toEqual(f.before);
});

test('a listed symlink cannot copy bytes from outside the verified generation', () => {
  const f = fixture();
  const path = join(f.standby, 'core', f.core.generation, 'config.json');
  const external = join(f.to, '..', 'external-config.json');
  write(external, readFileSync(path, 'utf8'));
  rmSync(path);
  symlinkSync(external, path);
  const before = files(f.standby);
  const result = run(f);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('symlink in generation');
  expect(existsSync(f.to)).toBe(false);
  expect(files(f.standby)).toEqual(before);
});

test('config rewrite failure removes only the newly created target and allows retry', async () => {
  const f = fixture();
  const hostBefore = files(f.host);
  const options = parsePromoteArgs(['--standby', f.standby, '--to', f.to, '--hq-config', f.host]);
  let rewriteAttempted = false;
  await expect(promote(options, ((path: string, contents: string) => {
    expect(path).toBe(join(f.to, 'config.json'));
    expect(JSON.parse(contents).telegram.enabled).toBe(false);
    expect(readFileSync(join(f.to, 'config.json.pre-promote'), 'utf8')).toBe(readFileSync(join(f.standby, 'core', f.core.generation, 'config.json'), 'utf8'));
    rewriteAttempted = true;
    throw new Error('injected config rewrite failure');
  }))).rejects.toThrow('injected config rewrite failure');
  expect(rewriteAttempted).toBe(true);
  expect(existsSync(f.to)).toBe(false);
  expect(files(f.standby)).toEqual(f.before);
  expect(files(f.host)).toEqual(hostBefore);
  const retry = run(f, '--hq-config', f.host);
  expect(retry.status).toBe(0);
  expect(JSON.parse(readFileSync(join(f.to, 'config.json'), 'utf8')).telegram.enabled).toBe(false);
  expect(files(f.standby)).toEqual(f.before);
});

test('json, tier selection and missing host block fail closed', () => {
  const f = fixture();
  const json = run(f, '--tiers', 'core', '--json', '--dry-run');
  expect(json.status).toBe(0);
  expect(JSON.parse(json.stdout)).toMatchObject({ dryRun: true, files: f.core.entries.length, tiers: { core: f.core.generation } });
  write(join(f.host, 'config.json'), '{}');
  const refused = run(f, '--hq-config', f.host);
  expect(refused.status).toBe(1);
  expect(existsSync(f.to)).toBe(false);
  expect(files(f.standby)).toEqual(f.before);
});
