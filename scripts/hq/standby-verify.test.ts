import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGeneration } from './standby-snapshot';
import { parseVerifyArgs, verifyStandby } from './standby-verify';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): { standby: string; generation: string; host: string } {
  const root = mkdtempSync(join(tmpdir(), 'hq-verify-'));
  roots.push(root);
  const source = join(root, 'source');
  const standby = join(root, 'standby');
  mkdirSync(join(source, 'hq-drill'), { recursive: true });
  writeFileSync(join(source, 'config.json'), 'one');
  // The runbook's round-trip writer, executed locally instead of over ssh.
  const writer = spawnSync('sh', ['-c', `printf '{"host":"%s","nonce":"%s"}\\n' "$(hostname -s)" "$N" >> "$FILE"`], {
    encoding: 'utf8', env: { ...process.env, N: 'drill-1', FILE: join(source, 'hq-drill', 'round-trip.jsonl') },
  });
  if (writer.status !== 0) throw new Error(`runbook drill writer failed: ${writer.stderr}`);
  const host = 'source-host';
  const tier = join(standby, 'core');
  const now = new Date();
  const generation = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  buildGeneration({ root: source, out: join(tier, generation), tier: 'core', host, now });
  symlinkSync(generation, join(tier, 'latest'));
  return { standby, generation, host };
}

function run(standby: string, ...args: string[]) {
  const result = spawnSync('bun', ['scripts/hq/standby-verify.ts', '--root', standby, '--tier', 'core', ...args], { encoding: 'utf8', cwd: join(import.meta.dir, '..', '..') });
  return { code: result.status, out: result.stdout.trim(), err: result.stderr.trim() };
}

test('intact generation reports generation, host, age and checksum count in one OK line without writing to standby', () => {
  const { standby, generation, host } = fixture();
  const before = readdirSync(join(standby, 'core')).sort();
  const result = run(standby);
  expect(result.code).toBe(0);
  expect(result.out.split('\n')).toHaveLength(1);
  expect(result.out).toContain(`core=${generation}`);
  expect(result.out).toContain(host);
  expect(result.out).toContain('ok 2/2');
  expect(result.out).toEndWith(' OK');
  expect(readdirSync(join(standby, 'core')).sort()).toEqual(before);
  expect(readlinkSync(join(standby, 'core', 'latest'))).toBe(generation);
});

test('verified manifest digest identifies the exact bytes read by the checksum verifier', async () => {
  const { standby, generation } = fixture();
  const path = join(standby, 'core', generation, 'MANIFEST.json');
  const before = await verifyStandby({ root: standby, tiers: ['core'] });
  expect(before.ok).toBe(true);
  expect(before.tiers[0].manifestSha256).toBe(createHash('sha256').update(readFileSync(path)).digest('hex'));
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.host = 'changed-host';
  writeFileSync(path, JSON.stringify(manifest));
  const after = await verifyStandby({ root: standby, tiers: ['core'] });
  expect(after.ok).toBe(true);
  expect(after.tiers[0].manifestSha256).not.toBe(before.tiers[0].manifestSha256);
});

test('changed bytes and listed missing file are distinct FAIL counts', () => {
  const { standby, generation } = fixture();
  const file = join(standby, 'core', generation, 'config.json');
  writeFileSync(file, 'two');
  const changed = run(standby, '--json');
  expect(changed.code).toBe(1);
  const mismatch = JSON.parse(changed.out);
  expect(mismatch.tiers[0]).toMatchObject({ mismatches: 1, missing: 0, checked: 1, unreadable: false });
  expect(mismatch.reasons).toContain('core:checksum mismatch 1');
  rmSync(file);
  const absent = run(standby, '--json');
  expect(absent.code).toBe(1);
  expect(JSON.parse(absent.out).tiers[0]).toMatchObject({ mismatches: 0, missing: 1, unreadable: false });
});

test('missing latest fails rather than treating zero checks as success', () => {
  const { standby } = fixture();
  rmSync(join(standby, 'core', 'latest'));
  const result = run(standby);
  expect(result.code).toBe(1);
  expect(result.out).toContain('FAIL core:latest missing');
});

test('runbook-written drill record has the same marker line count as grep -c; zero, duplicate and missing stay distinct', () => {
  const { standby, generation } = fixture();
  const markerFile = join(standby, 'core', generation, 'hq-drill', 'round-trip.jsonl');
  const countWithRunbook = (marker: string) => spawnSync('grep', ['-c', marker, markerFile], { encoding: 'utf8' }).stdout.trim();
  expect(JSON.parse(readFileSync(markerFile, 'utf8').trim())).toMatchObject({ nonce: 'drill-1', host: expect.any(String) });
  expect(countWithRunbook('drill-1')).toBe('1');
  const found = run(standby, '--marker', 'drill-1', '--json');
  expect(found.code).toBe(0);
  expect(JSON.parse(found.out).marker).toBe(Number(countWithRunbook('drill-1')));
  expect(run(standby, '--marker', 'drill-1').out).toContain('marker=1 OK');
  const zero = run(standby, '--marker', 'other');
  expect(zero.code).toBe(1);
  expect(zero.out).toContain('marker=0 FAIL marker:not found');
  expect(countWithRunbook('other')).toBe('0');

  // grep counts lines containing the marker, not only JSON objects with a top-level nonce.
  appendFileSync(markerFile, '{"marker":"drill-2"}\n');
  expect(countWithRunbook('drill-2')).toBe('1');
  const field = run(standby, '--marker', 'drill-2', '--json');
  expect(JSON.parse(field.out).marker).toBe(Number(countWithRunbook('drill-2')));
  appendFileSync(markerFile, '{"message":"drill-1 drill-1"}\n');
  expect(countWithRunbook('drill-1')).toBe('2');
  const duplicate = run(standby, '--marker', 'drill-1');
  expect(duplicate.code).toBe(1);
  expect(duplicate.out).toContain(`marker=${countWithRunbook('drill-1')} FAIL core:checksum mismatch 1, marker:count 2`);
  rmSync(markerFile);
  const missing = run(standby, '--marker', 'drill-1');
  expect(missing.code).toBe(1);
  expect(missing.out).toContain('marker=missing');
});

test('EISDIR while hashing a listed file reports unreadable and exits 1, not argument error 2', () => {
  const { standby, generation } = fixture();
  const file = join(standby, 'core', generation, 'config.json');
  rmSync(file);
  mkdirSync(file);
  const result = run(standby, '--json');
  expect(result.code).toBe(1);
  const verification = JSON.parse(result.out);
  expect(verification.tiers[0]).toMatchObject({ unreadable: true, missing: 0, mismatches: 0, checked: 1 });
  expect(verification.reasons).toContain('core:unreadable');
});

test.skipIf(process.platform !== 'linux')('EIO while hashing a listed file reports unreadable and exits 1', () => {
  const { standby, generation } = fixture();
  const file = join(standby, 'core', generation, 'config.json');
  rmSync(file);
  symlinkSync('/proc/self/mem', file);
  expect(() => readFileSync(file)).toThrow(expect.objectContaining({ code: 'EIO' }));
  const result = run(standby, '--json');
  expect(result.code).toBe(1);
  expect(JSON.parse(result.out).tiers[0]).toMatchObject({ unreadable: true, missing: 0, checked: 1 });
});

test('EISDIR in manifest and drill marker reads reports unreadable and exits 1', () => {
  const { standby, generation } = fixture();
  const dir = join(standby, 'core', generation);
  const markerFile = join(dir, 'hq-drill', 'round-trip.jsonl');
  rmSync(markerFile);
  mkdirSync(markerFile);
  const markerResult = run(standby, '--marker', 'drill-1', '--json');
  expect(markerResult.code).toBe(1);
  expect(JSON.parse(markerResult.out)).toMatchObject({ marker: 'unreadable' });
  rmSync(join(dir, 'MANIFEST.json'));
  mkdirSync(join(dir, 'MANIFEST.json'));
  const manifestResult = run(standby, '--json');
  expect(manifestResult.code).toBe(1);
  expect(JSON.parse(manifestResult.out).tiers[0]).toMatchObject({ unreadable: true });
});

test('unreadable folder is not an OK zero and exits 1', () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-verify-empty-'));
  roots.push(root);
  const result = run(join(root, 'absent'));
  expect(result.code).toBe(1);
  expect(result.out).toContain('core=unreadable');
  expect(result.out).toContain('FAIL core:unreadable');
});

test('age threshold compares elapsed time before rounding display minutes', async () => {
  const { standby, generation } = fixture();
  const now = new Date('2026-10-04T01:00:00.000Z');
  const manifestPath = join(standby, 'core', generation, 'MANIFEST.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.createdAt = new Date(now.getTime() - 5 * 60_000 - 59_000).toISOString();
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const exceeded = await verifyStandby({ root: standby, tiers: ['core'], maxAgeMin: 5, now });
  expect(exceeded.tiers[0].ageMin).toBe(5);
  expect(exceeded.ok).toBe(false);
  expect(exceeded.reasons).toContain('core:age exceeded');

  manifest.createdAt = new Date(now.getTime() - 5 * 60_000).toISOString();
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const atLimit = await verifyStandby({ root: standby, tiers: ['core'], maxAgeMin: 5, now });
  expect(atLimit.tiers[0].ageMin).toBe(5);
  expect(atLimit.ok).toBe(true);
});

test('age threshold, multi-tier defaults and argument errors', () => {
  const { standby, generation } = fixture();
  const manifestPath = join(standby, 'core', generation, 'MANIFEST.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.createdAt = new Date(Date.now() - 10 * 60_000).toISOString();
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const old = run(standby, '--max-age-min', '5', '--json');
  expect(old.code).toBe(1);
  expect(JSON.parse(old.out).tiers[0].ageMin).toBeGreaterThan(5);
  expect(JSON.parse(old.out).reasons).toContain('core:age exceeded');
  const defaultTiers = spawnSync('bun', ['scripts/hq/standby-verify.ts', '--root', standby, '--json'], { encoding: 'utf8', cwd: join(import.meta.dir, '..', '..') });
  expect(defaultTiers.status).toBe(1);
  expect(JSON.parse(defaultTiers.stdout).tiers.map((t: { tier: string }) => t.tier)).toEqual(['core', 'big', 'obs']);
  expect(run(standby, '--max-age-min', '-1').code).toBe(2);
  expect(run(standby, '--tier', 'unknown').code).toBe(2);
  expect(run(standby, '--root').code).toBe(2);
});

test('per-tier limits parse and assess core 10m OK and big 500m FAIL; the numeric limit still applies to every tier', async () => {
  const { standby, generation } = fixture();
  const now = new Date();
  const coreManifest = join(standby, 'core', generation, 'MANIFEST.json');
  const core = JSON.parse(readFileSync(coreManifest, 'utf8'));
  core.createdAt = new Date(now.getTime() - 10 * 60_000).toISOString();
  writeFileSync(coreManifest, JSON.stringify(core));
  const bigGeneration = new Date(now.getTime() - 500 * 60_000).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const bigDir = join(standby, 'big', bigGeneration);
  mkdirSync(bigDir, { recursive: true });
  const bytes = 'large-db';
  const digest = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(bigDir, 'knowledge.db'), bytes);
  writeFileSync(join(bigDir, 'SHA256SUMS'), `${digest}  knowledge.db\n`);
  writeFileSync(join(bigDir, 'MANIFEST.json'), JSON.stringify({ generation: bigGeneration, tier: 'big', host: 'source-host', createdAt: new Date(now.getTime() - 500 * 60_000).toISOString(), entries: [{ path: 'knowledge.db', sha256: digest }] }));
  symlinkSync(bigGeneration, join(standby, 'big', 'latest'));

  const parsed = parseVerifyArgs(['--root', standby, '--tier', 'core,big', '--max-age-min', 'core=30,big=400']);
  expect(parsed.options.maxAgeMin).toEqual({ core: 30, big: 400 });
  const verified = await verifyStandby({ ...parsed.options, now });
  expect(verified.tiers.map(t => ({ tier: t.tier, checked: t.checked, reasons: t.reasons }))).toEqual([
    { tier: 'core', checked: 2, reasons: [] }, { tier: 'big', checked: 1, reasons: ['big:age exceeded'] },
  ]);
  expect(verified.ok).toBe(false);
  const cli = spawnSync('bun', ['scripts/hq/standby-verify.ts', '--root', standby, '--tier', 'core,big', '--max-age-min', 'core=30,big=400'], { encoding: 'utf8', cwd: join(import.meta.dir, '..', '..') });
  expect(cli.status).toBe(1);
  expect(cli.stdout.trim().split('\n')).toHaveLength(1);
  expect(cli.stdout).toContain('core=');
  expect(cli.stdout).toContain('big=');
  expect(cli.stdout).toContain('FAIL big:age exceeded');
  expect(parseVerifyArgs(['--max-age-min', '30']).options.maxAgeMin).toBe(30);
  expect((await verifyStandby({ root: standby, tiers: ['core', 'big'], maxAgeMin: 30, now })).reasons).toEqual(['big:age exceeded']);
  expect((await verifyStandby({ root: standby, tiers: ['core', 'big'], maxAgeMin: 5, now })).reasons).toEqual(['core:age exceeded', 'big:age exceeded']);
  for (const value of ['core=30,big=bad', 'core=30,core=400', 'other=30', 'core=-1', 'core= ', 'core=30,']) {
    expect(() => parseVerifyArgs(['--max-age-min', value])).toThrow();
  }
});

test('a failed CLI verification emits exactly one countable verify-failed event alongside verify', () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-verify-log-'));
  roots.push(root);
  const script = join(import.meta.dir, 'standby-verify.ts');
  const result = spawnSync('bun', [script, '--root', join(root, 'not-received'), '--tier', 'core,big', '--max-age-min', 'core=30,big=400'], {
    encoding: 'utf8', cwd: root, env: { ...process.env, HOME: root, ELANOUS_STATE_DIR: root, ELANOUS_CONFIG_DIR: root },
  });
  expect(result.status).toBe(1);
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  expect(result.stdout).toContain('core=unreadable(');
  expect(result.stdout).toContain('big=unreadable(');
  const logs = readdirSync(join(root, '.elanous', 'debug')).filter(name => name.startsWith('debug-') && name.endsWith('.log'));
  const events = logs.flatMap(name => readFileSync(join(root, '.elanous', 'debug', name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)));
  expect(events.filter(event => event.category === 'hq.standby' && event.event === 'verify')).toHaveLength(1);
  expect(events.filter(event => event.category === 'hq.standby' && event.event === 'verify-failed').map(event => event.data.reasons)).toEqual([['core:unreadable', 'big:unreadable']]);
});

test('a folder whose name differs from MANIFEST.generation fails (10-04 12:13 big drift: folder 031304Z · manifest 031309Z)', () => {
  const { standby, generation } = fixture();
  const core = join(standby, 'core');
  const drifted = `${generation.slice(0, -3)}${String((Number(generation.slice(-3, -1)) + 5) % 60).padStart(2, '0')}Z`;
  spawnSync('mv', [join(core, generation), join(core, drifted)]);
  rmSync(join(core, 'latest'));
  symlinkSync(drifted, join(core, 'latest'));
  const r = run(standby);
  expect(r.code).toBe(1);
  expect(r.out).toContain('core:invalid manifest');
});
