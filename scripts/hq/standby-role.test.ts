import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { decideReplicationRole, hasSeenGeneration, leaseHostName } from './standby-role';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const record = (holder: string) => ({ holder, generation: 3, acquiredAt: 1, renewedAt: 1, ttlSeconds: 1500 });

test('no lease yet: only the default source copies, directly; the other host stays standby', () => {
  expect(decideReplicationRole({ me: 'MacBookProM5', defaultSource: 'MacBookProM5,mbp', record: null })).toEqual({ role: 'direct', reason: 'no-lease-default-source' });
  expect(decideReplicationRole({ me: 'mbp', defaultSource: 'MacBookProM5,mbp', record: null }).role).toBe('direct');
  expect(decideReplicationRole({ me: 'MacStudioB1', defaultSource: 'MacBookProM5,mbp', record: null })).toEqual({ role: 'skip', reason: 'no-lease-not-default' });
});

test('once a lease exists — whoever holds it — or the arbiter cannot be read, HQ-FENCE decides', () => {
  expect(decideReplicationRole({ me: 'MacStudioB1', defaultSource: 'MacBookProM5', record: record('MacStudioB1') })).toEqual({ role: 'fenced', reason: 'lease-exists', holder: 'MacStudioB1' });
  expect(decideReplicationRole({ me: 'MacBookProM5', defaultSource: 'MacBookProM5', record: record('MacStudioB1') }).role).toBe('fenced');
  expect(decideReplicationRole({ me: 'MacBookProM5', defaultSource: 'MacBookProM5', record: 'unreadable' })).toEqual({ role: 'fenced', reason: 'lease-unreadable' });
});

test('a host that has seen a lease generation never falls back to the default source (TC 10:12 · split-brain)', () => {
  expect(decideReplicationRole({ me: 'MacBookProM5', defaultSource: 'MacBookProM5', record: null, seenGeneration: true })).toEqual({ role: 'skip', reason: 'no-lease-after-seen' });
  expect(decideReplicationRole({ me: 'MacBookProM5', defaultSource: 'MacBookProM5', record: record('MacStudioB1'), seenGeneration: true }).role).toBe('fenced');
  const home = mkdtempSync(join(tmpdir(), 'hq-seen-'));
  dirs.push(home);
  const local = join(home, 'local.json');
  expect(hasSeenGeneration(home, local)).toBe(false);
  writeFileSync(local, JSON.stringify({ holder: 'MacBookProM5' }));
  expect(hasSeenGeneration(home, local)).toBe(false);
  writeFileSync(local, JSON.stringify({ holder: 'MacBookProM5', generation: 1 }));
  expect(hasSeenGeneration(home, local)).toBe(true);
  rmSync(local);
  mkdirSync(join(home, '.elanous-hq'));
  writeFileSync(join(home, '.elanous-hq', 'seen-generation'), '2\n');
  expect(hasSeenGeneration(home, local)).toBe(true);
});

test('lease host name follows hq.hostName, else the OS name without .local', () => {
  expect(leaseHostName('node-b', 'MacStudioB1.local')).toBe('node-b');
  expect(leaseHostName(undefined, 'MacStudioB1.local')).toBe('MacStudioB1');
});

// The body script, with a fake `bun`/`rsync`/`git` on PATH: which command runs for each role, and toward which peer.
function runBody(mode: string, role: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hq-standby-body-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const calls = join(dir, 'calls');
  const fake = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  fake('bun', `case "$*" in
    *standby-role.ts*) echo "$*" | sed 's/.*--config-dir \\([^ ]*\\).*/cfg=\\1/' >> "${calls}.cfg"; echo "${role}";;
    *standby-verify.ts*)
      echo "bun $*" >> "${calls}"
      if [ "$REAL_VERIFY" = 1 ]; then
        shift
        exec "$REAL_BUN" "$VERIFY_SCRIPT" "$@"
      fi
      echo 'hq-standby verify core=unreadable big=unreadable FAIL core:unreadable, big:unreadable'
      [ "$VERIFY_FAIL" != 1 ];;
    *'hq fence --role cron'*)
      echo "bun fence cfg=$3 command=$9" >> "${calls}"
      if [ "$REAL_FENCE" = 1 ] || [ "$REAL_FENCE" = source ]; then
        while [ "$1" != -- ]; do shift; done
        shift
        exec "$REAL_BUN" bin/elanous.mjs --test --config-dir "$HQ_REP_CONFIG_DIR" hq fence --role cron -- "$@"
      fi
      if [ "$FENCE_SKIP" = 1 ]; then echo 'initializing fence' >&2; echo 'fence declined: not-holder' >&2
      else
        while [ "$1" != -- ]; do shift; done
        shift
        "$@"
      fi;;
    *) echo "bun $*" >> "${calls}";;
  esac`);
  fake('rsync', `echo "rsync $*" >> "${calls}"`);
  fake('git', 'echo abc1234');
  fake('env', `echo "env $*" >> "${calls}"`);
  if (env.REAL_FENCE === '1' || env.REAL_FENCE === 'source') {
    mkdirSync(join(dir, '.elanous-hq'), { recursive: true });
    writeFileSync(join(dir, '.elanous-hq', 'lease.json'), JSON.stringify({ holder: env.REAL_FENCE === 'source' ? 'standby-host' : 'other-host', generation: 3, acquiredAt: Math.floor(Date.now() / 1000), renewedAt: Math.floor(Date.now() / 1000), ttlSeconds: 1500 }));
    mkdirSync(join(dir, '.elanous'), { recursive: true });
    writeFileSync(join(dir, '.elanous', 'config.json'), JSON.stringify({ hq: { hostName: 'standby-host', arbiter: 'local' } }));
  }
  if (!env.NO_STATE) { mkdirSync(join(dir, '.elanous', 'release'), { recursive: true }); writeFileSync(join(dir, '.elanous', 'release', 'features.sqlite'), ''); }
  if (env.REAL_VERIFY === '1') mkdirSync(join(dir, '.elanous-standby'));
  const r = spawnSync('sh', [join(import.meta.dir, 'hq-standby.sh'), mode], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, HQ_REP_PEER: 'mbp', HQ_REP_DEFAULT_SOURCE: 'MacBookProM5', REAL_BUN: process.execPath, VERIFY_SCRIPT: join(import.meta.dir, 'standby-verify.ts'), HQ_REP_CONFIG_DIR: join(dir, '.elanous'), ...env, ...(env.STATE_SUB ? { HQ_REP_STATE_DIR: join(dir, env.STATE_SUB) } : {}) },
  });
  let lines: string[] = [];
  try { lines = readFileSync(calls, 'utf8').trim().split('\n').map(l => l.replaceAll(dir, '<home>')); } catch { /* nothing ran */ }
  let cfg = '';
  try { cfg = readFileSync(`${calls}.cfg`, 'utf8').trim().replaceAll(dir, '<home>'); } catch { /* role not asked */ }
  return { status: r.status, out: r.stdout, lines, cfg };
}

test('fenced: the copy runs under `hq fence --role cron` toward the peer, survival only for core', () => {
  const core = runBody('core', 'fenced', { HQ_REP_SURVIVAL: 'cloud-vm,s3://b/p' });
  expect(core.status).toBe(0);
  expect(core.lines).toHaveLength(2);
  expect(core.lines[0]).toBe('bun fence cfg=<home>/.elanous command=sh');
  expect(core.lines[1]).toBe('env ELANOUS_STATE_DIR=<home>/.elanous bun scripts/hq/standby-snapshot.ts --tier core --push mbp --survival cloud-vm,s3://b/p');
  expect(core.out).toContain('role=fenced state=');
  expect(core.out).toContain('→ mbp');
  const big = runBody('big', 'fenced', { HQ_REP_SURVIVAL: 'cloud-vm' });
  expect(big.lines).toEqual(['bun fence cfg=<home>/.elanous command=env', 'env ELANOUS_STATE_DIR=<home>/.elanous bun scripts/hq/standby-snapshot.ts --tier big --push mbp']);
});

test('fenced vault: the fence wraps rsync (bun runs it), one-way with --update and no --delete', () => {
  const v = runBody('vault', 'fenced');
  expect(v.lines).toHaveLength(2);
  expect(v.lines[0]).toBe('bun fence cfg=<home>/.elanous command=rsync');
  expect(v.lines[1]).toStartWith('rsync -a --update');
  expect(v.lines[1]).not.toContain('--delete');
  expect(v.lines[1]).toEndWith('/Obsidian/ElanvitalAI/');
  expect(v.lines[1]).toContain('mbp:');
});

test('direct: no fence, plain copy; skip: core verifies its received copies without failing replication', () => {
  expect(runBody('obs', 'direct').lines).toEqual(['env ELANOUS_STATE_DIR=<home>/.elanous bun scripts/hq/standby-snapshot.ts --tier obs --push mbp']);
  expect(runBody('vault', 'direct').lines[0]).toStartWith('rsync -a --update');
  const s = runBody('core', 'skip', { VERIFY_FAIL: '1' });
  expect(s.status).toBe(0);
  expect(s.lines).toEqual(['bun scripts/hq/standby-verify.ts --root <home>/.elanous-standby --tier core,big --max-age-min core=30,big=400']);
  expect(s.out.trim().split('\n')).toHaveLength(1);
  expect(s.out).toContain('core=unreadable big=unreadable FAIL');
  expect(runBody('big', 'skip').lines).toEqual([]);
});

test('core verifies only a fence skip, never the direct or fence-allowed source', () => {
  expect(runBody('core', 'direct').lines).toEqual(['env ELANOUS_STATE_DIR=<home>/.elanous bun scripts/hq/standby-snapshot.ts --tier core --push mbp']);
  const source = runBody('core', 'fenced');
  expect(source.lines).toHaveLength(2);
  expect(source.lines[1]).toBe('env ELANOUS_STATE_DIR=<home>/.elanous bun scripts/hq/standby-snapshot.ts --tier core --push mbp');
  expect(source.out).not.toContain('hq-standby verify');
  const standby = runBody('core', 'fenced', { FENCE_SKIP: '1', VERIFY_FAIL: '1' });
  expect(standby.status).toBe(0);
  expect(standby.lines).toHaveLength(2);
  expect(standby.lines[0]).toBe('bun fence cfg=<home>/.elanous command=sh');
  expect(standby.lines[1]).toBe('bun scripts/hq/standby-verify.ts --root <home>/.elanous-standby --tier core,big --max-age-min core=30,big=400');
  expect(standby.out).toContain('fence declined: not-holder');
  expect(standby.out).toContain('core=unreadable big=unreadable FAIL');
  expect(runBody('big', 'fenced', { FENCE_SKIP: '1' }).lines).toHaveLength(1);
});

test('the real fence declines for the non-holder, and the wrapper verifies exactly once without parsing its output', () => {
  const result = runBody('core', 'fenced', { REAL_FENCE: '1', VERIFY_FAIL: '1' });
  expect(result.status).toBe(0);
  expect(result.lines.filter(line => line.includes('standby-verify.ts'))).toEqual([
    'bun scripts/hq/standby-verify.ts --root <home>/.elanous-standby --tier core,big --max-age-min core=30,big=400',
  ]);
  expect(result.lines).toHaveLength(2);
  expect(result.out).toContain('hq fence: skip cron — not-holder');
  expect(result.out).toContain('hq-standby verify');
});

test('a non-holder without source ledgers or a received folder still verifies unreadable once and exits 0', () => {
  const skipped = runBody('core', 'skip', { NO_STATE: '1', REAL_VERIFY: '1' });
  expect(skipped.status).toBe(0);
  expect(skipped.lines).toEqual(['bun scripts/hq/standby-verify.ts --root <home>/.elanous-standby --tier core,big --max-age-min core=30,big=400']);
  expect(skipped.out.trim().split('\n')).toEqual([
    'hq-standby verify core=unreadable(?m · ? · ok 0/? · unreadable) big=unreadable(?m · ? · ok 0/? · unreadable) FAIL core:unreadable, big:unreadable',
  ]);
  const result = runBody('core', 'fenced', { REAL_FENCE: '1', NO_STATE: '1', REAL_VERIFY: '1' });
  expect(result.status).toBe(0);
  expect(result.lines).toEqual([
    'bun fence cfg=<home>/.elanous command=sh',
    'bun scripts/hq/standby-verify.ts --root <home>/.elanous-standby --tier core,big --max-age-min core=30,big=400',
  ]);
  expect(result.out.trim().split('\n').filter(line => line.startsWith('hq-standby verify'))).toEqual([
    'hq-standby verify core=unreadable(?m · ? · ok 0/? · unreadable) big=unreadable(?m · ? · ok 0/? · unreadable) FAIL core:unreadable, big:unreadable',
  ]);
});

test('the real fence allows the holder to run the same copy, without standby verification', () => {
  const result = runBody('core', 'fenced', { REAL_FENCE: 'source' });
  expect(result.status).toBe(0);
  expect(result.lines).toEqual([
    'bun fence cfg=<home>/.elanous command=sh',
    'env ELANOUS_STATE_DIR=<home>/.elanous bun scripts/hq/standby-snapshot.ts --tier core --push mbp',
  ]);
  expect(result.out).not.toContain('hq-standby verify');
});

test('the fence-allowed source without HQ ledgers refuses the copy without standby verification', () => {
  const result = runBody('core', 'fenced', { REAL_FENCE: 'source', NO_STATE: '1' });
  expect(result.status).toBe(1);
  expect(result.lines).toEqual(['bun fence cfg=<home>/.elanous command=sh']);
  expect(result.out).toContain('not an HQ state dir');
  expect(result.out).not.toContain('hq-standby verify');
});

test('an unknown role answer (role script failed) still goes through the fence, never a bare copy', () => {
  expect(runBody('core', '')[ 'lines' ][0]).toBe('bun fence cfg=<home>/.elanous command=sh');
});

test('the copy reads HQ_REP_STATE_DIR (node-b ~/.elanous-hqstate), and refuses a dir without the release ledger', () => {
  const r = runBody('core', 'fenced', { STATE_SUB: '.elanous' });
  expect(r.lines[1]).toContain('env ELANOUS_STATE_DIR=<home>/.elanous bun scripts/hq/standby-snapshot.ts');
  const other = runBody('core', 'fenced', { STATE_SUB: '.elanous-hqstate' });
  expect(other.status).toBe(1);
  expect(other.lines).toEqual(['bun fence cfg=<home>/.elanous command=sh']);
  expect(other.out).toContain('not an HQ state dir');
  expect(runBody('vault', 'direct', { NO_STATE: '1' }).lines[0]).toStartWith('rsync');
});

test('the role check and the fence read HQ_REP_CONFIG_DIR (node-b ~/.elanous-hqcfg), default ~/.elanous', () => {
  expect(runBody('core', 'skip').cfg).toBe('cfg=<home>/.elanous');
  expect(runBody('core', 'skip', { HQ_REP_CONFIG_DIR: '/x/.elanous-hqcfg' }).cfg).toBe('cfg=/x/.elanous-hqcfg');
  expect(runBody('core', 'fenced', { HQ_REP_CONFIG_DIR: '/x/.elanous-hqcfg' }).lines[0]).toBe('bun fence cfg=/x/.elanous-hqcfg command=sh');
});

test('missing peer or default source refuses before anything runs', () => {
  expect(runBody('core', 'direct', { HQ_REP_PEER: '' }).status).toBe(2);
  expect(runBody('core', 'direct', { HQ_REP_DEFAULT_SOURCE: '' }).lines).toEqual([]);
});
