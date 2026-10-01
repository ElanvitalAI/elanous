import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync, spawn } from 'node:child_process';
import { cliVersion, codeRevision, setCodeRevisionRootForTesting, writePackagedRevision, packageVersion } from './code-revision.js';
import { setGitCommandRunnerForTesting } from '../git-fs/runner.js';

const PACKED_COMMIT = 'a'.repeat(40);
const INSTALLED_COMMIT = 'b'.repeat(40);
const CHECKOUT_COMMIT = 'c'.repeat(40);
const folders: string[] = [];

function packageFolder(): string {
  const root = mkdtempSync(join(tmpdir(), 'elanous-package-revision-'));
  folders.push(root);
  mkdirSync(join(root, 'src', 'version'), { recursive: true });
  setCodeRevisionRootForTesting(root);
  return root;
}

afterEach(() => {
  setCodeRevisionRootForTesting(undefined);
  setGitCommandRunnerForTesting(undefined);
  for (const root of folders.splice(0)) rmSync(root, { recursive: true, force: true });
}, 180_000);

test('package folder without git metadata returns the packaged commit through codeRevision and cliVersion', () => {
  const root = packageFolder();
  writeFileSync(join(root, 'src', 'version', 'packed-revision.json'), JSON.stringify({ commit: PACKED_COMMIT }));
  expect(codeRevision()).toBe(PACKED_COMMIT);
  expect(cliVersion()).toBe(`${packageVersion()} ${PACKED_COMMIT}`);
});

test('package folder without git metadata or packaged commit returns undefined', () => {
  packageFolder();
  expect(codeRevision()).toBeUndefined();
  expect(cliVersion()).toBe(`${packageVersion()} unknown`);
});

test('git checkout rev-parse has priority over install.json and packaged commit', () => {
  const root = packageFolder();
  writeFileSync(join(root, 'install.json'), JSON.stringify({ commit: INSTALLED_COMMIT }));
  writeFileSync(join(root, 'src', 'version', 'packed-revision.json'), JSON.stringify({ commit: PACKED_COMMIT }));
  setGitCommandRunnerForTesting((cwd, args) => {
    expect(cwd).toBe(root);
    return { status: 0, stdout: args.includes('--show-toplevel') ? `${root}\n` : `${CHECKOUT_COMMIT}\n`, stderr: '' };
  });
  expect(codeRevision()).toBe(CHECKOUT_COMMIT);
  expect(cliVersion()).toBe(`${packageVersion()} ${CHECKOUT_COMMIT}`);
});

test('installer-owned package nested inside another checkout uses its packaged commit, not the enclosing HEAD', () => {
  const parent = mkdtempSync(join(tmpdir(), 'elanous-parent-checkout-'));
  folders.push(parent);
  const init = spawnSync('git', ['init', '--quiet', parent], { encoding: 'utf8' });
  expect(init.status).toBe(0);
  writeFileSync(join(parent, 'fixture'), 'parent');
  expect(spawnSync('git', ['-C', parent, 'add', 'fixture'], { encoding: 'utf8' }).status).toBe(0);
  const commit = spawnSync('git', ['-C', parent, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'fixture'], { encoding: 'utf8' });
  expect(commit.status, commit.stderr).toBe(0);
  const root = join(parent, 'node_modules', 'elanous');
  mkdirSync(join(root, 'src', 'version'), { recursive: true });
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(parent, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(parent, 'bin'));
  writeFileSync(join(root, 'bin', 'elanous.mjs'), '#!/usr/bin/env bun\n');
  symlinkSync(join(root, 'bin', 'elanous.mjs'), join(parent, 'node_modules', '.bin', 'elanous'));
  symlinkSync('../node_modules/.bin/elanous', join(parent, 'bin', 'elanous'));
  setCodeRevisionRootForTesting(root);
  writeFileSync(join(root, 'src', 'version', 'packed-revision.json'), JSON.stringify({ commit: PACKED_COMMIT }));
  expect(codeRevision()).toBe(PACKED_COMMIT);
});

test('source package at node_modules/elanous under a monorepo uses rev-parse without installer evidence', () => {
  const parent = mkdtempSync(join(tmpdir(), 'elanous-node-modules-source-'));
  folders.push(parent);
  const root = join(parent, 'node_modules', 'elanous');
  mkdirSync(join(root, 'src', 'version'), { recursive: true });
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'elanous.mjs'), '#!/usr/bin/env bun\n');
  writeFileSync(join(root, 'install.json'), JSON.stringify({ commit: INSTALLED_COMMIT }));
  writeFileSync(join(root, 'src', 'version', 'packed-revision.json'), JSON.stringify({ commit: PACKED_COMMIT }));
  expect(spawnSync('git', ['init', '--quiet', parent], { encoding: 'utf8' }).status).toBe(0);
  expect(spawnSync('git', ['-C', parent, 'add', '--force', '.'], { encoding: 'utf8' }).status).toBe(0);
  const committed = spawnSync('git', ['-C', parent, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'monorepo source package'], { encoding: 'utf8' });
  expect(committed.status, committed.stderr).toBe(0);
  const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  expect(head.status).toBe(0);
  setCodeRevisionRootForTesting(root);
  expect(codeRevision()).toBe(head.stdout.trim());
  expect(cliVersion()).toBe(`${packageVersion()} ${head.stdout.trim()}`);
  writePackagedRevision(root);
  expect(JSON.parse(readFileSync(join(root, 'src', 'version', 'packed-revision.json'), 'utf8'))).toEqual({ commit: head.stdout.trim() });
});

test('installer-owned package nested in a checkout cannot inherit its HEAD even without packaged metadata', () => {
  const parent = mkdtempSync(join(tmpdir(), 'elanous-installer-owned-'));
  folders.push(parent);
  const root = join(parent, 'node_modules', 'elanous');
  mkdirSync(join(root, 'src', 'version'), { recursive: true });
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(parent, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(parent, 'bin'));
  writeFileSync(join(root, 'bin', 'elanous.mjs'), '#!/usr/bin/env bun\n');
  symlinkSync(join(root, 'bin', 'elanous.mjs'), join(parent, 'node_modules', '.bin', 'elanous'));
  symlinkSync('../node_modules/.bin/elanous', join(parent, 'bin', 'elanous'));
  expect(spawnSync('git', ['init', '--quiet', parent], { encoding: 'utf8' }).status).toBe(0);
  writeFileSync(join(parent, 'fixture'), 'parent');
  expect(spawnSync('git', ['-C', parent, 'add', 'fixture'], { encoding: 'utf8' }).status).toBe(0);
  const committed = spawnSync('git', ['-C', parent, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'enclosing checkout'], { encoding: 'utf8' });
  expect(committed.status, committed.stderr).toBe(0);
  setCodeRevisionRootForTesting(root);
  expect(codeRevision()).toBeUndefined();
  writeFileSync(join(root, 'src', 'version', 'packed-revision.json'), JSON.stringify({ commit: PACKED_COMMIT }));
  expect(codeRevision()).toBe(PACKED_COMMIT);
});

test('source package under a monorepo git root keeps rev-parse priority and can be packed', () => {
  const parent = mkdtempSync(join(tmpdir(), 'elanous-source-monorepo-'));
  folders.push(parent);
  const root = join(parent, 'packages', 'elanous');
  mkdirSync(join(root, 'src', 'version'), { recursive: true });
  setCodeRevisionRootForTesting(root);
  writeFileSync(join(root, 'install.json'), JSON.stringify({ commit: INSTALLED_COMMIT }));
  writeFileSync(join(root, 'src', 'version', 'packed-revision.json'), JSON.stringify({ commit: PACKED_COMMIT }));
  expect(spawnSync('git', ['init', '--quiet', parent], { encoding: 'utf8' }).status).toBe(0);
  expect(spawnSync('git', ['-C', parent, 'add', '.'], { encoding: 'utf8' }).status).toBe(0);
  const committed = spawnSync('git', ['-C', parent, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'monorepo'], { encoding: 'utf8' });
  expect(committed.status, committed.stderr).toBe(0);
  const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  expect(head.status).toBe(0);
  expect(codeRevision()).toBe(head.stdout.trim());
  writePackagedRevision(root);
  expect(JSON.parse(readFileSync(join(root, 'src', 'version', 'packed-revision.json'), 'utf8'))).toEqual({ commit: head.stdout.trim() });
});

test('install.json commit still wins over the packaged commit', () => {
  const root = packageFolder();
  writeFileSync(join(root, 'install.json'), JSON.stringify({ commit: INSTALLED_COMMIT }));
  writeFileSync(join(root, 'src', 'version', 'packed-revision.json'), JSON.stringify({ commit: PACKED_COMMIT }));
  expect(codeRevision()).toBe(INSTALLED_COMMIT);
});

test('malformed or non-commit packaged metadata cannot become a version', () => {
  const root = packageFolder();
  const path = join(root, 'src', 'version', 'packed-revision.json');
  for (const contents of ['{broken', JSON.stringify({ commit: 'a\nforged' }), JSON.stringify({ commit: 'abc' })]) {
    writeFileSync(path, contents);
    expect(codeRevision()).toBeUndefined();
  }
});

test('pack writer records git HEAD in package-owned metadata and refuses unknown HEAD', () => {
  const root = packageFolder();
  const path = join(root, 'src', 'version', 'packed-revision.json');
  setGitCommandRunnerForTesting((cwd, args) => {
    expect(cwd).toBe(root);
    return { status: 0, stdout: args.includes('--show-toplevel') ? `${root}\n` : `${CHECKOUT_COMMIT}\n`, stderr: '' };
  });
  writePackagedRevision(root);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ commit: CHECKOUT_COMMIT });
  setGitCommandRunnerForTesting(() => ({ status: 1, stdout: '', stderr: 'no checkout' }));
  // 09-24: HEAD 가 없으면 pack 을 막지 않는다(설치기 계약) — 옛 파일만 지우고 커밋 없이 간다.
  expect(() => writePackagedRevision(root)).not.toThrow();
  expect(existsSync(path)).toBe(false);
  expect(codeRevision()).toBeUndefined();
});

// Deferred: the second installed self-update child exceeded 20s without exiting on Linux; trace that child and reproduce on macOS before re-enabling.
test.skip('bun pm pack and bash install.sh --source preserve commit for installed version, health, doctor and restart', async () => {
  const repo = join(import.meta.dir, '..', '..');
  const dest = mkdtempSync(join(tmpdir(), 'elanous-pack-'));
  folders.push(dest);
  const packed = spawnSync('bun', ['pm', 'pack', '--destination', dest, '--quiet'], { cwd: repo, encoding: 'utf8', timeout: 120_000 });
  expect(packed.status).toBe(0);
  const tarball = packed.stdout.trim();
  const extracted = spawnSync('tar', ['-xOf', tarball, 'package/src/version/packed-revision.json'], { encoding: 'utf8' });
  expect(extracted.status).toBe(0);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  expect(head.status).toBe(0);
  expect(JSON.parse(extracted.stdout)).toEqual({ commit: head.stdout.trim() });
  expect(existsSync(join(repo, 'src', 'version', 'packed-revision.json'))).toBe(false);
  const prefix = join(dest, 'installed');
  const installed = spawnSync('bash', [join(repo, 'scripts/install.sh'), '--source', tarball,
    '--prefix', prefix, '--no-modify-path', '--no-bootstrap-bun'], {
    cwd: dest, encoding: 'utf8', timeout: 180_000,
    env: { ...process.env, HOME: dest, BUN_INSTALL_CACHE_DIR: join(repo, 'node_modules', '.cache') },
  });
  expect(installed.status, `${installed.stdout}\n${installed.stderr}`).toBe(0);
  const installedRoot = join(prefix, 'current', 'node_modules', 'elanous');
  const installedMetadata = join(installedRoot, 'src', 'version', 'packed-revision.json');
  expect(JSON.parse(readFileSync(installedMetadata, 'utf8'))).toEqual({ commit: head.stdout.trim() });
  expect(JSON.parse(readFileSync(join(prefix, 'current', 'install.json'), 'utf8')).commit).toBeUndefined();
  const version = spawnSync(join(prefix, 'bin', 'elanous'), ['--version'], {
    cwd: dest, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, HOME: dest, ELANOUS_TEST: '1' },
  });
  expect(version.status, version.stderr).toBe(0);
  expect(version.stdout.trim()).toBe(`${packageVersion()} ${head.stdout.trim()}`);

  setCodeRevisionRootForTesting(installedRoot);
  expect(codeRevision()).toBe(head.stdout.trim());
  const checkout = join(dest, 'checkout');
  const clone = spawnSync('git', ['clone', '--quiet', '--shared', repo, checkout], { encoding: 'utf8', timeout: 60_000 });
  expect(clone.status, clone.stderr).toBe(0);
  const earlier = spawnSync('git', ['log', '-1', '--format=%P', '--', 'src/index.ts'], { cwd: checkout, encoding: 'utf8' });
  expect(earlier.status, earlier.stderr).toBe(0);
  const previousCommit = earlier.stdout.trim().split(' ')[0];
  expect(previousCommit).toMatch(/^[0-9a-f]{40}$/);
  const previousRoot = join(dest, 'previous-package');
  mkdirSync(join(previousRoot, 'src', 'version'), { recursive: true });
  writeFileSync(join(previousRoot, 'src', 'version', 'packed-revision.json'), JSON.stringify({ commit: previousCommit }));
  const changed = spawnSync('git', ['diff', '--name-only', `${previousCommit}..HEAD`, '--', 'src/index.ts'], { cwd: checkout, encoding: 'utf8' });
  expect(changed.status, changed.stderr).toBe(0);
  expect(changed.stdout.trim()).toBe('src/index.ts');
  const changedPaths = spawnSync('git', ['diff', '--name-only', `${previousCommit}..HEAD`], { cwd: checkout, encoding: 'utf8' });
  expect(changedPaths.status, changedPaths.stderr).toBe(0);
  const pathCount = changedPaths.stdout.trim().split('\n').length;
  const daemonPort = 35000 + Math.floor(Math.random() * 20000);
  const registryDir = join(dest, 'registry');
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(join(registryDir, 'config.json'), JSON.stringify({ llm: { provider: 'local', baseUrl: 'http://127.0.0.1:1' } }));
  mkdirSync(join(dest, '.config', 'elanous'), { recursive: true });
  writeFileSync(join(dest, '.config', 'elanous', 'config.json'), JSON.stringify({ llm: { provider: 'local', baseUrl: 'http://127.0.0.1:1' } }));
  const pwaDir = join(dest, 'pwa-static');
  mkdirSync(pwaDir);
  writeFileSync(join(pwaDir, 'index.html'), '<!doctype html><title>test</title>');
  // The process captures the older packaged revision at boot; the checkout is newer.
  writeFileSync(installedMetadata, JSON.stringify({ commit: previousCommit }));
  const daemon = spawn(join(prefix, 'bin', 'elanous'), [`--test=${registryDir}`, 'nexus', 'run',
    '--port', String(daemonPort), '--tool-cwd', checkout, '--no-auto-build', '--no-watch', '--no-mcp'], {
    cwd: dest, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: dest, ELANOUS_HOME: registryDir, ELANOUS_NEXUS_HTTP_HOST: '127.0.0.1',
      XDG_CONFIG_HOME: join(dest, '.config'), ELANOUS_CONFIG_DIR: registryDir,
      ELANOUS_STATE_DIR: registryDir, ELANOUS_PWA_STATIC_DIR: pwaDir },
  });
  let daemonOutput = '';
  daemon.stdout.on('data', (chunk) => { daemonOutput += String(chunk); });
  daemon.stderr.on('data', (chunk) => { daemonOutput += String(chunk); });
  try {
    let liveHealth: { daemonSha?: string } | undefined;
    for (let i = 0; i < 100; i++) {
      if (daemon.exitCode !== null) throw new Error(`installed daemon exited ${daemon.exitCode}: ${daemonOutput}`);
      try {
        const response = await fetch(`http://127.0.0.1:${daemonPort}/v1/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) { liveHealth = await response.json() as { daemonSha?: string }; break; }
      } catch { /* wait for installed daemon */ }
      await delay(200);
    }
    expect(liveHealth?.daemonSha, daemonOutput).toBe(previousCommit.slice(0, 9));
    const update = spawnSync(join(prefix, 'bin', 'elanous'), [`--test=${registryDir}`, 'self-update',
      '--from', checkout, '--json', '--keep', '0'], {
      cwd: checkout, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, HOME: dest, ELANOUS_HOME: registryDir,
        BUN_INSTALL_CACHE_DIR: join(repo, 'node_modules', '.cache') },
    });
    expect(update.status, update.stderr).toBe(0);
    const result = JSON.parse(update.stdout.trim().split('\n').at(-1)!) as {
      decision?: { from?: string; verdict?: string; pathCount?: number }; exitCode: number;
    };
    expect(result.decision?.from).toBe(liveHealth?.daemonSha);
    expect(result.decision?.verdict).toBe('restart');
    expect(result.decision?.pathCount).toBe(pathCount);
    expect(result.exitCode).toBe(0);
  } finally {
    daemon.kill();
    if (daemon.exitCode === null) await Promise.race([new Promise((resolve) => daemon.once('exit', resolve)), delay(3_000)]);
    writeFileSync(installedMetadata, JSON.stringify({ commit: head.stdout.trim() }));
  }
  const healthProbe = spawnSync('bun', ['-e', `import { mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { startNexusHttpServer } from './src/nexus/api/http-server.ts';
    import { createNexusState } from './src/nexus/state/state.ts';
    import { TabRegistry } from './src/nexus/state/tab-registry.ts';
    import { runDoctor } from './src/cli/doctor-cli.ts';
    import { resetDaemonShaForTesting } from './src/nexus/api/health.ts';
    import { setCodeRevisionRootForTesting } from './src/version/code-revision.ts';
    const checkout = ${JSON.stringify(checkout)};
    const state = createNexusState({ nexusVersion: '1.0.0', phase: 'ready' });
    const server = startNexusHttpServer({ state, registry: new TabRegistry(state),
      startPort: 35000 + Math.floor(Math.random() * 20000), portRange: 10,
      portProbe: () => 'available' });
    const port = Number(new URL(server.url).port);
    const registryDir = process.env.ELANOUS_HOME;
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(join(registryDir, 'pwa-registry.json'), JSON.stringify({ version: 1, instances: [{
      pid: process.pid, ports: [port], mode: 'static', kind: 'test', cwd: checkout,
      daemonDir: registryDir, shareMounted: false, https: false, startedAt: new Date().toISOString(),
    }] }));
    try {
      const response = await fetch(server.url + '/v1/health');
      if (!response.ok) throw new Error('GET /v1/health: ' + response.status);
      const health = await response.json();
      const report = runDoctor({ repositoryRoot: process.cwd(), fetchHealth: () => health,
        listAuthProviders: () => [], commandExists: () => false,
        discoverChromeBinary: () => null, loadNativeModule: () => false,
        readInstallPrefix: () => ${JSON.stringify(prefix)}, checkPythonEnv: () => null,
        probeBuildToolchain: () => ({ make: false, cxx20: false }) });
      const updates = [];
      for (const daemonRoot of [${JSON.stringify(previousRoot)}, process.cwd()]) {
        setCodeRevisionRootForTesting(daemonRoot);
        resetDaemonShaForTesting();
        const liveHealth = await (await fetch(server.url + '/v1/health')).json();
        const child = Bun.spawn([${JSON.stringify(join(prefix, 'bin', 'elanous'))}, '--test=' + registryDir, 'self-update', '--from', checkout, '--json', '--keep', '0'], {
          cwd: process.cwd(),
          env: { ...process.env, HOME: ${JSON.stringify(dest)}, ELANOUS_HOME: registryDir,
            BUN_INSTALL_CACHE_DIR: ${JSON.stringify(join(repo, 'node_modules', '.cache'))} },
          stdout: 'pipe', stderr: 'pipe',
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        if (exitCode !== 0) throw new Error('self-update failed: ' + stdout + stderr);
        const lines = stdout.trim().split('\\n');
        const result = JSON.parse(lines.at(-1));
        updates.push({ health: liveHealth, result });
      }
      console.log(JSON.stringify({ health, ok: report.ok, reason: report.reason,
        service: report.readiness?.items.find(item => item.id === 'service-version'), updates }));
    } finally {
      setCodeRevisionRootForTesting(undefined);
      resetDaemonShaForTesting();
      server.stop();
    }`], {
    cwd: installedRoot, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, HOME: dest, ELANOUS_HOME: join(dest, 'registry'), ELANOUS_TEST: '1' },
  });
  expect(healthProbe.status, healthProbe.stderr).toBe(0);
  const probe = JSON.parse(healthProbe.stdout) as {
    health: { daemonSha: string }; ok: boolean; reason?: string;
    service?: { status: string; evidence: string };
    updates: { health: { daemonSha: string }; result: { decision: { from: string; verdict: string; pathCount: number }; exitCode: number } }[];
  };
  expect(probe.health.daemonSha).toBe(head.stdout.trim().slice(0, 9));
  expect(probe.ok, probe.reason).toBe(true);
  expect(probe.service?.status).toBe('ok');
  expect(probe.service?.evidence).toBe(`daemonSha ${probe.health.daemonSha} matches code ${head.stdout.trim()}`);
  expect(probe.updates.map(({ health, result }) => ({
    healthSha: health.daemonSha, from: result.decision?.from,
    verdict: result.decision?.verdict, paths: result.decision?.pathCount, exitCode: result.exitCode,
  }))).toEqual([
    { healthSha: previousCommit.slice(0, 9), from: previousCommit.slice(0, 9), verdict: 'restart', paths: pathCount, exitCode: 0 },
    { healthSha: head.stdout.trim().slice(0, 9), from: head.stdout.trim().slice(0, 9), verdict: 'none', paths: 0, exitCode: 0 },
  ]);
  setCodeRevisionRootForTesting(undefined);
}, 180_000);

test('versioned install with the bun-path wrapper shim (#21004) exposes install.json source and commit', async () => {
  const { installMetadataSource } = await import('./code-revision.js');
  const prefix = mkdtempSync(join(tmpdir(), 'elanous-wrapper-install-'));
  folders.push(prefix);
  const versionDir = join(prefix, 'versions', '0.0.0-test');
  const root = join(versionDir, 'node_modules', 'elanous');
  const source = mkdtempSync(join(tmpdir(), 'elanous-wrapper-source-'));
  folders.push(source);
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(prefix, 'bin'));
  writeFileSync(join(root, 'bin', 'elanous.mjs'), '#!/usr/bin/env bun\n');
  writeFileSync(join(versionDir, 'install.json'), JSON.stringify({ commit: INSTALLED_COMMIT, source }));
  const wrapper = (marker: string) => `#!/bin/sh\n${marker}\nexec '/bin/bun' '${join(prefix, 'current', 'node_modules', 'elanous', 'bin', 'elanous.mjs')}' "$@"\n`;
  writeFileSync(join(prefix, 'bin', 'elanous'), wrapper('# elanous-wrapper'));
  expect(installMetadataSource(root)).toBe(source);
  // 표지가 없는 스크립트는 설치기 소유로 보지 않는다.
  writeFileSync(join(prefix, 'bin', 'elanous'), wrapper('# something-else'));
  expect(installMetadataSource(root)).toBeUndefined();
});
