import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GATE_DEPS_TREES, gateDepsInstallScript, parseGateDeps, projectDepsManifest, stageGateDeps } from './pod-gate-deps.js';
import { gateShardShell } from '../../../scripts/release-loop/gate-node.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const ROOT_PKG = { name: 'elanous', version: '0.2.20-dev.0', description: 'x', scripts: { test: 'bun test', postinstall: 'echo hi' }, dependencies: { chalk: '^5.4.1' }, devDependencies: { typescript: '^5.9.0' }, trustedDependencies: ['node-pty'] };
const PWA_PKG = { name: '@elanous/pwa', version: '0.1.0', private: true, scripts: { dev: 'next dev' }, dependencies: { react: '19.0.0' } };

/** A source tree (the image build's) and a repo clone (the shard's) with the same two install trees. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gate-deps-')));
  roots.push(root);
  const source = join(root, 'source');
  const repo = join(root, 'work', 'repo');
  for (const base of [source, repo]) {
    mkdirSync(join(base, 'apps/pwa'), { recursive: true });
    writeFileSync(join(base, 'package.json'), JSON.stringify(ROOT_PKG, null, 2));
    writeFileSync(join(base, 'bun.lock'), '{ "lockfileVersion": 1, "root": 1 }\n');
    writeFileSync(join(base, 'apps/pwa/package.json'), JSON.stringify(PWA_PKG, null, 2));
    writeFileSync(join(base, 'apps/pwa/bun.lock'), '{ "lockfileVersion": 1, "pwa": 1 }\n');
  }
  const deps = join(root, 'opt', 'elanous-gate-deps');
  // A bun that is real for `-e` (the projection) and fake for `install` (records the tree · prints bun's summary).
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'bun'), `#!/bin/bash
if [ "$1" = install ]; then echo "$PWD" >> '${root}/installs'; [ -e '${root}/install-fails' ] && exit 7; echo "5 packages installed [750ms]"; exit 0; fi
exec '${process.execPath}' "$@"
`);
  chmodSync(join(bin, 'bun'), 0o755);
  return { root, source, repo, deps, bin };
}

/** Bakes like the Dockerfile: stage, then a node_modules per tree. */
function bake(f: ReturnType<typeof fixture>) {
  const staged = stageGateDeps(f.source, f.deps);
  for (const tree of GATE_DEPS_TREES) mkdirSync(join(f.deps, tree, 'node_modules', 'marker'), { recursive: true });
  return staged;
}

function runInstall(f: ReturnType<typeof fixture>, installSlots = 0) {
  const slots = installSlots > 0 ? [
    `install_slot_acquire() { echo acquire >> '${f.root}/slots'; echo "[gate] install-slot 0 waited 0s"; }`,
    `install_slot_release() { echo release >> '${f.root}/slots'; }`,
  ] : [];
  const script = [...slots, gateDepsInstallScript({ log: `'${f.root}/install.log'`, installSlots, depsDir: f.deps }), 'echo "irc=$irc"'].join('\n');
  const run = spawnSync('bash', ['-c', script], { cwd: f.repo, encoding: 'utf8', timeout: 20_000, env: { PATH: `${f.bin}:/usr/bin:/bin`, HOME: f.root } });
  const read = (name: string) => existsSync(join(f.root, name)) ? readFileSync(join(f.root, name), 'utf8') : '';
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, log: read('install.log'), installs: read('installs').trim().split('\n').filter(Boolean), slots: read('slots').trim().split('\n').filter(Boolean) };
}

test('matching lockfiles link both trees to the baked node_modules — no install, no install slot', () => {
  const f = fixture();
  bake(f);
  const r = runInstall(f, 4);
  expect(r.stdout).toContain('irc=0');
  expect(r.installs).toEqual([]);
  expect(r.slots).toEqual([]);
  expect(parseGateDeps(r.log)).toEqual({ '.': 'baked', 'apps/pwa': 'baked' });
  for (const tree of GATE_DEPS_TREES) {
    expect(lstatSync(join(f.repo, tree, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(f.repo, tree, 'node_modules'))).toBe(join(f.deps, tree, 'node_modules'));
    expect(existsSync(join(f.repo, tree, 'node_modules', 'marker'))).toBe(true);
  }
});

test('a release bump or a new non-install script does not invalidate the baked layer; a dependency change does', () => {
  const f = fixture();
  bake(f);
  writeFileSync(join(f.repo, 'package.json'), JSON.stringify({ ...ROOT_PKG, version: '0.2.21-dev.0', description: 'new', scripts: { ...ROOT_PKG.scripts, lint: 'x' } }, null, 2));
  writeFileSync(join(f.repo, 'apps/pwa/package.json'), JSON.stringify({ ...PWA_PKG, dependencies: { react: '19.1.0' } }, null, 2));
  const r = runInstall(f, 4);
  expect(r.stdout).toContain('irc=0');
  expect(parseGateDeps(r.log)).toEqual({ '.': 'baked', 'apps/pwa': 'miss:package.json differs' });
  // Only the missing tree installs, and only it takes a slot.
  expect(r.installs).toEqual([join(f.repo, 'apps/pwa')].map((p) => resolve(p)));
  expect(r.slots).toEqual(['acquire', 'release']);
  expect(lstatSync(join(f.repo, 'node_modules')).isSymbolicLink()).toBe(true);
  expect(existsSync(join(f.repo, 'apps/pwa/node_modules'))).toBe(false);
});

test('a different lockfile, an old image (nothing baked), or an existing node_modules falls back to the old install in order', () => {
  const f = fixture();
  bake(f);
  writeFileSync(join(f.repo, 'bun.lock'), '{ "lockfileVersion": 1, "root": 2 }\n');
  mkdirSync(join(f.repo, 'apps/pwa/node_modules'));
  const r = runInstall(f);
  expect(r.stdout).toContain('irc=0');
  expect(parseGateDeps(r.log)).toEqual({ '.': 'miss:bun.lock differs', 'apps/pwa': 'miss:node_modules exists' });
  expect(r.installs).toEqual([f.repo, join(f.repo, 'apps/pwa')].map((p) => resolve(p)));
  expect(r.log).toContain('5 packages installed [750ms]');

  const old = fixture();   // no bake at all
  const o = runInstall(old, 2);
  expect(parseGateDeps(o.log)).toEqual({ '.': 'miss:no baked deps', 'apps/pwa': 'miss:no baked deps' });
  expect(o.installs).toEqual([old.repo, join(old.repo, 'apps/pwa')].map((p) => resolve(p)));
  expect(o.slots).toEqual(['acquire', 'release']);
});

test('a failed install stops at that tree and reports its exit (the shard runs no tests)', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'install-fails'), '');
  const r = runInstall(f);
  expect(r.stdout).toContain('irc=7');
  expect(r.installs).toEqual([resolve(f.repo)]);
});

test('the shell projection (bun -e) and the staging projection agree byte for byte', () => {
  const f = fixture();
  bake(f);
  for (const tree of GATE_DEPS_TREES) {
    const staged = readFileSync(join(f.deps, tree, 'package.json'), 'utf8');
    const source = JSON.parse(readFileSync(join(f.source, tree, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(staged).toBe(`${JSON.stringify(projectDepsManifest(source), null, 2)}\n`);
    expect(staged).not.toContain('"version"');
  }
  expect(JSON.parse(readFileSync(join(f.deps, 'package.json'), 'utf8')).scripts).toEqual({ postinstall: 'echo hi' });
  // The real repo manifests stage too (the build's input).
  const real = stageGateDeps(resolve(import.meta.dir, '../../..'), join(f.root, 'real'));
  expect(real.trees).toEqual(['.', 'apps/pwa']);
  expect(real.digest).toMatch(/^[0-9a-f]{12}$/);
});

test('the gate shard shell links baked deps and still runs its parts', () => {
  const f = fixture();
  bake(f);
  const home = join(f.root, 'home');
  mkdirSync(home);
  // The soft deadline is counted from the container's PID 1 (pod_age): inside a long-lived container or gate Pod a small
  // value is already spent (measured in elanous-harness:local on node-b — part-0 never started), so give it a day.
  const shell = gateShardShell({ parts: [['src/a.test.ts']], cdpPatterns: [], softSeconds: 86_400, cachePrefix: '', installSlots: 4, depsDir: f.deps });
  // `bun run test:deterministic …` → the fake bun execs the real one, which would need a script; stub it instead.
  writeFileSync(join(f.bin, 'timeout'), '#!/bin/bash\n[ "$1" = -k ] && shift 2\nshift\necho "1 pass"; echo "Ran 1 tests across 1 files."\n');
  chmodSync(join(f.bin, 'timeout'), 0o755);
  const run = spawnSync('bash', ['-c', shell], { cwd: f.repo, encoding: 'utf8', timeout: 20_000, env: { PATH: `${f.bin}:/usr/bin:/bin`, HOME: home } });
  expect(run.status).toBe(0);
  const outbox = join(home, 'outbox');
  expect(readFileSync(join(outbox, 'install.rc'), 'utf8').trim()).toBe('0');
  expect(readFileSync(join(outbox, 'part-0.rc'), 'utf8').trim()).toBe('0');
  expect(parseGateDeps(readFileSync(join(outbox, 'install.log'), 'utf8'))).toEqual({ '.': 'baked', 'apps/pwa': 'baked' });
  expect(readFileSync(join(outbox, 'install.log'), 'utf8')).not.toContain('install-slot');
});

test('the full harness image bakes the gate deps before the per-commit package layer, fail-soft; build.sh stages and labels them', () => {
  const dockerfile = readFileSync(resolve(import.meta.dir, '../../../docker/harness/Dockerfile'), 'utf8');
  const bake = dockerfile.indexOf('COPY --chown=ubuntu:ubuntu gate-deps/ /opt/elanous-gate-deps/');
  expect(bake).toBeGreaterThan(0);
  expect(bake).toBeLessThan(dockerfile.indexOf('COPY --chown=ubuntu:ubuntu install.sh elanous.tgz'));
  expect(dockerfile).toContain('bun install --frozen-lockfile');
  expect(dockerfile).toContain('rm -rf "$t/node_modules"');
  const build = readFileSync(resolve(import.meta.dir, '../../../docker/harness/build.sh'), 'utf8');
  expect(build).toContain('pod-gate-deps.ts stage "$CTX/gate-deps"');
  expect(build).toContain('elanous.gate-deps=$GATE_DEPS_DIGEST');
  expect(readFileSync(resolve(import.meta.dir, '../../../docker/harness/Dockerfile.lite'), 'utf8')).not.toContain('gate-deps');
});
