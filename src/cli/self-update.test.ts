import { describe, expect, test } from 'bun:test';
import { resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readFileSync, lstatSync, readlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { childPath, liveRestartBlocked, planVersionPrune, relayImportClosure, rollbackTarget, runReleaseUpdate, runSelfUpdate, runUpdateForInstallation, updateRelay, versionCommit, type SelfUpdateDeps, type ReleaseUpdateDeps } from './self-update.js';
import type { RestartNeededResult } from './nexus-restart-needed.js';

const checkout = resolve(import.meta.dir, '../..');
const sha = 'abcdef123456abcdef123456abcdef123456abcd';
function fixture(decision: RestartNeededResult = { exitCode: 11, verdict: 'restart' }) {
  const calls: string[] = [];
  const lines: string[] = [];
  let dirty = false;
  let installFails = false;
  const deps: SelfUpdateDeps = {
    cliRoot: checkout,
    git: (_cwd, args) => {
      calls.push(`git ${args.join(' ')}`);
      if (args.includes('--show-toplevel')) return { status: 0, stdout: `${checkout}\n`, stderr: '' };
      if (args.includes('--verify')) return { status: 0, stdout: `${sha}\n`, stderr: '' };
      return { status: dirty ? 1 : 0, stdout: '', stderr: '' };
    },
    decide: async (opts) => { calls.push(`decide ${opts.to} ${opts.cwd}`); return decision; },
    run: (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return { status: cmd === 'bash' && installFails ? 1 : 0, stderr: 'failed' };
    },
    installedVersion: () => '1.0.0-abcdef123456',
    pruneVersions: (plan) => { calls.push(`prune ${plan.current} ${plan.daemonSha} ${plan.keep}`); return { removed: [], kept: [] }; },
    verifyRestart: async (commit) => { calls.push(`verify ${commit}`); return { ok: true, daemonSha: commit }; },
    alert: (text) => { calls.push(`alert ${text.slice(0, 20)}`); },
    os: 'darwin',
    uid: 501,
    allowLiveRestart: true,
    out: { log: (s) => lines.push(s), error: (s) => lines.push(s) },
  };
  return { deps, calls, lines, setDirty: () => { dirty = true; }, failInstall: () => { installFails = true; } };
}

describe('runReleaseUpdate — release installer', () => {
  function setup() {
    const prefix = mkdtempSync(join(tmpdir(), 'elanous-release-update-'));
    const packageRoot = join(prefix, 'versions', 'old', 'node_modules', 'elanous');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(prefix, 'install.json'), JSON.stringify({ version: '0.1.0' }));
    const calls: Array<{ command: string; args: string[]; cwd: string; input?: string; env?: NodeJS.ProcessEnv }> = [];
    const urls: string[] = [];
    const lines: string[] = [];
    let installedVersion = '0.2.0';
    const deps: ReleaseUpdateDeps = {
      packageRoot,
      fetchInstaller: async (url) => { urls.push(url); return 'echo verified installer'; },
      run: (command, args, cwd, input, env) => {
        calls.push({ command, args, cwd, input, env });
        if (command === 'bash') writeFileSync(join(prefix, 'install.json'), JSON.stringify({ version: installedVersion }));
        return { status: 0, stderr: '' };
      },
      os: 'darwin', uid: 501,
      out: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
    };
    return { prefix, packageRoot, calls, urls, lines, deps, setInstalledVersion: (value: string) => { installedVersion = value; }, cleanup: () => rmSync(prefix, { recursive: true, force: true }) };
  }

  test('uses install.json prefix and latest installer, passing script on stdin without changing PATH', async () => {
    const f = setup();
    try {
      const result = await runReleaseUpdate({}, f.deps);
      expect(f.urls).toEqual(['https://github.com/ElanvitalAI/elanous/releases/latest/download/install.sh']);
      expect(f.calls).toEqual([{ command: 'bash', args: ['-s', '--', '--no-modify-path', '--prefix', f.prefix], cwd: f.prefix, input: 'echo verified installer', env: { ELANOUS_VERSION: '', ELANOUS_INSTALL_SOURCE: '', ELANOUS_RELEASE_BASE: 'https://github.com/ElanvitalAI/elanous/releases' } }]);
      expect(result).toMatchObject({ exitCode: 0, installedVersion: '0.2.0', restarted: false });
    } finally { f.cleanup(); }
  });

  test('version-specific release and explicit restart use selected tag and service', async () => {
    const f = setup();
    f.setInstalledVersion('0.2.0-rc.1');
    try {
      const result = await runReleaseUpdate({ version: '0.2.0-rc.1', restart: true, json: true }, f.deps);
      expect(f.urls).toEqual(['https://github.com/ElanvitalAI/elanous/releases/download/v0.2.0-rc.1/install.sh']);
      expect(f.calls[0]?.env).toEqual({ ELANOUS_VERSION: '0.2.0-rc.1', ELANOUS_INSTALL_SOURCE: '', ELANOUS_RELEASE_BASE: 'https://github.com/ElanvitalAI/elanous/releases' });
      expect(f.calls[1]).toEqual({ command: 'launchctl', args: ['kickstart', '-k', 'gui/501/com.elanous.nexus'], cwd: f.prefix, input: undefined, env: undefined });
      expect(result).toMatchObject({ exitCode: 0, installedVersion: '0.2.0-rc.1', restarted: true });
      expect(JSON.parse(f.lines[0]!)).toEqual(result);
    } finally { f.cleanup(); }
  });

  test('the same build again skips the restart; a new build still restarts', async () => {
    for (const [after, restarts] of [[{ version: '0.2.0', versionDir: 'versions/0.2.0', commit: 'a' }, false], [{ version: '0.2.0', versionDir: 'versions/0.2.0-0123456789ab', commit: 'b' }, true]] as const) {
      const f = setup();
      try {
        writeFileSync(join(f.prefix, 'install.json'), JSON.stringify({ version: '0.2.0', versionDir: 'versions/0.2.0', commit: 'a' }));
        const result = await runReleaseUpdate({ version: '0.2.0', restart: true }, { ...f.deps, run: (command, args, cwd, input, env) => {
          f.calls.push({ command, args, cwd, input, env });
          if (command === 'bash') writeFileSync(join(f.prefix, 'install.json'), JSON.stringify(after));
          return { status: 0, stderr: '' };
        } });
        expect(result).toMatchObject({ exitCode: 0, installedVersion: '0.2.0', restarted: restarts });
        expect(f.calls.map((call) => call.command)).toEqual(restarts ? ['bash', 'launchctl'] : ['bash']);
        if (!restarts) expect(result.reason).toBe('already at 0.2.0 · restart skipped');
      } finally { f.cleanup(); }
    }
  });

  test('requested prerelease mismatch fails before service restart', async () => {
    const f = setup();
    try {
      const result = await runReleaseUpdate({ version: '0.2.0-rc.1', restart: true }, f.deps);
      expect(result).toMatchObject({ exitCode: 1, installedVersion: null, restarted: false });
      expect(result.reason).toContain('요청 0.2.0-rc.1, 설치 0.2.0');
      expect(f.calls.map((call) => call.command)).toEqual(['bash']);
    } finally { f.cleanup(); }
  });

  test('no install marker, unsafe version and fetch failure do not execute installer', async () => {
    const f = setup();
    try {
      expect((await runReleaseUpdate({ version: '../bad' }, f.deps)).exitCode).toBe(2);
      expect((await runReleaseUpdate({}, { ...f.deps, exists: () => false })).exitCode).toBe(2);
      const failed = await runReleaseUpdate({}, { ...f.deps, fetchInstaller: async () => { throw new Error('offline'); } });
      expect(failed).toMatchObject({ exitCode: 1, restarted: false });
      expect(failed.reason).toContain('offline');
      expect(f.calls).toHaveLength(0);
    } finally { f.cleanup(); }
  });

  test('release pruning preserves current and previous versions and obeys --keep', async () => {
    const f = setup();
    const versions = join(f.prefix, 'versions');
    mkdirSync(join(versions, 'a'));
    mkdirSync(join(versions, 'b'));
    mkdirSync(join(versions, 'c'));
    for (const name of ['a', 'b', 'old']) utimesSync(join(versions, name), new Date('2020-01-01'), new Date('2020-01-01'));
    utimesSync(join(versions, 'c'), new Date('2021-01-01'), new Date('2021-01-01'));
    writeFileSync(join(f.prefix, 'install.json'), JSON.stringify({ version: '0.1.0', versionDir: 'versions/old' }));
    f.deps.run = (command) => {
      if (command === 'bash') writeFileSync(join(f.prefix, 'install.json'), JSON.stringify({ version: '0.2.0', versionDir: 'versions/c' }));
      return { status: 0, stderr: '' };
    };
    try {
      const result = await runReleaseUpdate({ keep: 1 }, f.deps);
      expect(result.prune).toMatchObject({ kept: expect.arrayContaining(['old', 'c']), removed: expect.arrayContaining(['a', 'b']) });
      expect(result.prune?.skipped).toBeUndefined();
    } finally { f.cleanup(); }
  });

  test('internal revision tag accepts package.json version only on a tailnet install source', async () => {
    const f = setup();
    const internal = 'https://mbp.tailnet-example.ts.net/elanous-internal';
    writeFileSync(join(f.prefix, 'install.json'), JSON.stringify({ version: '0.1.0', source: `${internal}/latest/download/elanous.tgz` }));
    f.setInstalledVersion('0.2.0');
    try {
      const result = await runReleaseUpdate({ version: '0.2.0-abcdef123456' }, f.deps);
      expect(f.urls).toEqual([`${internal}/download/v0.2.0-abcdef123456/install.sh`]);
      expect(f.calls[0]?.env?.ELANOUS_RELEASE_BASE).toBe(internal);
      expect(result).toMatchObject({ exitCode: 0, installedVersion: '0.2.0', releaseBaseSource: 'install-source' });
    } finally { f.cleanup(); }
  });

  test('release failure alerts once when requested, including a download failure', async () => {
    const f = setup();
    const alerts: string[] = [];
    try {
      const failed = await runReleaseUpdate({ alert: true }, { ...f.deps, alert: (text) => alerts.push(text), fetchInstaller: async () => { throw new Error('offline'); } });
      expect(failed.exitCode).toBe(1);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toContain('offline');
      expect(f.calls).toHaveLength(0);
    } finally { f.cleanup(); }
  });

  test('installer and restart failure report failure without claiming restart', async () => {
    const f = setup();
    try {
      const failed = await runReleaseUpdate({ restart: true }, { ...f.deps, run: () => ({ status: 7, stderr: 'install failed' }) });
      expect(failed).toMatchObject({ exitCode: 1, installedVersion: null, restarted: false });
      expect(failed.reason).toContain('install failed');
      const restarted = await runReleaseUpdate({ restart: true }, { ...f.deps, run: (command, args, cwd, input, env) => {
        f.calls.push({ command, args, cwd, input, env });
        return { status: command === 'bash' ? 0 : 1, stderr: 'service failed' };
      } });
      expect(restarted).toMatchObject({ exitCode: 1, installedVersion: '0.1.0', restarted: false });
      expect(restarted.reason).toContain('service failed');
    } finally { f.cleanup(); }
  });
});

describe('self-update installation routing', () => {
  test('installed CLI forwards --alert and --keep; explicit checkout keeps its existing options', async () => {
    const prefix = mkdtempSync(join(tmpdir(), 'elanous-update-options-'));
    const packageRoot = join(prefix, 'versions', 'old', 'node_modules', 'elanous');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(prefix, 'install.json'), JSON.stringify({ version: '0.1.0', versionDir: 'versions/old', source: 'https://github.com/ElanvitalAI/elanous/releases/latest/download/elanous.tgz' }));
    const alerts: string[] = [];
    const plans: Array<{ current: string; previous: string; keep: number; prefix: string }> = [];
    const f = fixture();
    try {
      const releaseDeps: ReleaseUpdateDeps = {
        out: { log: () => {}, error: () => {} },
        alert: (text) => alerts.push(text),
        fetchInstaller: async () => 'echo installer',
        run: (command) => {
          if (command === 'bash') writeFileSync(join(prefix, 'install.json'), JSON.stringify({ version: '0.2.0', versionDir: 'versions/new' }));
          return { status: command === 'bash' ? 0 : 1, stderr: 'restart failed' };
        },
        pruneVersions: (plan) => { plans.push(plan); return { removed: [], kept: ['old', 'new'] }; },
        os: 'darwin', uid: 501,
      };
      const release = await runUpdateForInstallation({ restart: true, alert: true, keep: 7 }, { cliRoot: packageRoot, release: releaseDeps });
      expect(release).toMatchObject({ exitCode: 1, installedVersion: '0.2.0', restarted: false });
      expect(plans).toEqual([{ current: 'new', previous: 'old', keep: 7, prefix }]);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toContain('restart failed');
      const checkoutResult = await runUpdateForInstallation({ from: checkout, keep: 5, alert: true }, { cliRoot: packageRoot, checkout: f.deps });
      expect(checkoutResult.exitCode).toBe(0);
      expect(f.calls).toContain('prune 1.0.0-abcdef123456  5');
      expect(f.calls.some((call) => call.startsWith('alert'))).toBe(false);
    } finally { rmSync(prefix, { recursive: true, force: true }); }
  });

  test('installed CLI selects the release installer; an explicit checkout keeps the git path', async () => {
    const prefix = mkdtempSync(join(tmpdir(), 'elanous-update-routing-'));
    const packageRoot = join(prefix, 'versions', '0.1.0', 'node_modules', 'elanous');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(prefix, 'install.json'), JSON.stringify({ version: '0.1.0', source: 'https://github.com/ElanvitalAI/elanous/releases/latest/download/elanous.tgz' }));
    const releaseCalls: string[] = [];
    const f = fixture();
    try {
      const release = await runUpdateForInstallation({ version: '0.2.0', restart: false }, {
        cliRoot: packageRoot,
        release: {
          out: { log: () => {}, error: () => {} },
          fetchInstaller: async (url) => { releaseCalls.push(url); return 'echo installer'; },
          run: (command) => { releaseCalls.push(command); writeFileSync(join(prefix, 'install.json'), JSON.stringify({ version: '0.2.0' })); return { status: 0, stderr: '' }; },
        },
        checkout: f.deps,
      });
      expect(release).toMatchObject({ exitCode: 0, installedVersion: '0.2.0', restarted: false });
      expect(releaseCalls).toEqual(['https://github.com/ElanvitalAI/elanous/releases/download/v0.2.0/install.sh', 'bash']);
      expect(f.calls).toEqual([]);
      const checkoutResult = await runUpdateForInstallation({ from: checkout }, { cliRoot: packageRoot, checkout: f.deps });
      expect(checkoutResult).toMatchObject({ exitCode: 0, installedVersion: '1.0.0-abcdef123456' });
      expect(f.calls).toContain(`bash ${checkout}/scripts/install.sh --no-modify-path`);
      expect(releaseCalls).toHaveLength(2);
    } finally { rmSync(prefix, { recursive: true, force: true }); }
  });
});

describe('self-update routing by install source (2026-09-25 🅣)', () => {
  function installed(source: string | undefined) {
    const prefix = mkdtempSync(join(tmpdir(), 'elanous-update-source-'));
    const packageRoot = join(prefix, 'versions', '1.0.0-abcdef123456', 'node_modules', 'elanous');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(prefix, 'install.json'), JSON.stringify({ version: '1.0.0', ...(source === undefined ? {} : { source }) }));
    return { prefix, packageRoot };
  }

  test('a checkout-sourced install (this machine: source = pilot checkout) updates from that checkout, never from a release', async () => {
    const f = fixture();
    const inst = installed(checkout);
    const releaseCalls: string[] = [];
    try {
      const result = await runUpdateForInstallation({ keep: 3 }, {
        cliRoot: inst.packageRoot,
        release: { out: { log: () => {}, error: () => {} }, fetchInstaller: async (url) => { releaseCalls.push(url); return 'x'; } },
        checkout: f.deps,
      });
      expect(releaseCalls).toEqual([]);
      expect(result.exitCode).toBe(0);
      expect(f.calls).toContain(`bash ${checkout}/scripts/install.sh --no-modify-path`);
    } finally { rmSync(inst.prefix, { recursive: true, force: true }); }
  });

  test('an install with no readable source stops with rc 2 and names --from — it does not guess', async () => {
    const f = fixture();
    const inst = installed(undefined);
    const logs: string[] = [];
    try {
      const result = await runUpdateForInstallation({}, { cliRoot: inst.packageRoot, checkout: { ...f.deps, out: { log: (t: string) => logs.push(t), error: () => {} } } });
      expect(result.exitCode).toBe(2);
      expect(result.reason).toContain('--from');
      expect(f.calls).toEqual([]);
    } finally { rmSync(inst.prefix, { recursive: true, force: true }); }
  });

  test('release base follows install source, preserves public source and refuses tailnet to public env', async () => {
    const tailBase = 'https://mbp.tailnet-example.ts.net/elanous-internal';
    const publicBase = 'https://github.com/ElanvitalAI/elanous/releases';
    const inst = installed(`${tailBase}/latest/download/elanous.tgz`);
    const lines: string[] = [];
    const urls: string[] = [];
    const old = process.env.ELANOUS_RELEASE_BASE;
    delete process.env.ELANOUS_RELEASE_BASE;
    try {
      const deps: ReleaseUpdateDeps = {
        packageRoot: inst.packageRoot,
        out: { log: (line) => lines.push(line), error: () => {} },
        fetchInstaller: async (url) => { urls.push(url); throw new Error('injected download stop'); },
      };
      const tail = await runUpdateForInstallation({ json: true }, { cliRoot: inst.packageRoot, release: deps });
      expect(urls).toEqual([`${tailBase}/latest/download/install.sh`]);
      expect(tail).toMatchObject({ exitCode: 1, releaseBase: tailBase, releaseBaseSource: 'install-source' });
      expect(JSON.parse(lines.at(-1)!)).toEqual(tail);
      writeFileSync(join(inst.prefix, 'install.json'), JSON.stringify({ source: `${tailBase}/download/v0.2.3-abcdef123456/elanous.tgz` }));
      await runReleaseUpdate({ version: '0.2.3-abcdef123456' }, deps);
      expect(urls.at(-1)).toBe(`${tailBase}/download/v0.2.3-abcdef123456/install.sh`);
      writeFileSync(join(inst.prefix, 'install.json'), JSON.stringify({ source: `${publicBase}/latest/download/elanous.tgz` }));
      const publicResult = await runReleaseUpdate({ json: true }, deps);
      expect(urls.at(-1)).toBe(`${publicBase}/latest/download/install.sh`);
      expect(publicResult).toMatchObject({ releaseBase: publicBase, releaseBaseSource: 'install-source' });
      expect(JSON.parse(lines.at(-1)!)).toEqual(publicResult);
      writeFileSync(join(inst.prefix, 'install.json'), JSON.stringify({ source: `${tailBase}/latest/download/elanous.tgz` }));
      process.env.ELANOUS_RELEASE_BASE = publicBase;
      const refused = await runUpdateForInstallation({ json: true }, { cliRoot: inst.packageRoot, release: deps });
      expect(refused).toMatchObject({ exitCode: 2, releaseBase: publicBase, releaseBaseSource: 'env' });
      expect(refused.reason).toContain('내부 설치본');
      expect(JSON.parse(lines.at(-1)!)).toEqual(refused);
      expect(urls).toHaveLength(3);
      const option = await runReleaseUpdate({ json: true }, { ...deps, releaseBase: publicBase });
      expect(option).toMatchObject({ exitCode: 2, releaseBase: publicBase, releaseBaseSource: 'option' });
      expect(urls).toHaveLength(3);
    } finally {
      if (old === undefined) delete process.env.ELANOUS_RELEASE_BASE;
      else process.env.ELANOUS_RELEASE_BASE = old;
      rmSync(inst.prefix, { recursive: true, force: true });
    }
  });

  test('the release installer URL follows ELANOUS_RELEASE_BASE (mirror or file:// fixture)', async () => {
    const inst = installed('file:///tmp/rel/latest/download/elanous.tgz');
    const urls: string[] = [];
    try {
      await runReleaseUpdate({}, {
        packageRoot: inst.packageRoot, releaseBase: 'file:///tmp/rel/', out: { log: () => {}, error: () => {} },
        fetchInstaller: async (url) => { urls.push(url); throw new Error('stop here'); },
      });
      expect(urls).toEqual(['file:///tmp/rel/latest/download/install.sh']);
    } finally { rmSync(inst.prefix, { recursive: true, force: true }); }
  });
});

describe('self-update — injected commands only', () => {
  test('decides before installation, restarts exactly once after successful install with consent', async () => {
    const f = fixture();
    const result = await runSelfUpdate({ restart: true, json: true }, f.deps);
    expect(result).toMatchObject({ exitCode: 0, installedVersion: '1.0.0-abcdef123456', restarted: true, decision: { verdict: 'restart' } });
    expect(f.calls).toEqual([
      'git rev-parse --show-toplevel', 'git rev-parse --verify HEAD', 'git diff --quiet HEAD --',
      `decide ${sha} ${checkout}`, 'bun install --frozen-lockfile', 'bun install --frozen-lockfile', 'bun bin/elanous.mjs nexus build', `bash ${checkout}/scripts/install.sh --no-modify-path`,
      'prune 1.0.0-abcdef123456  3', 'launchctl kickstart -k gui/501/com.elanous.nexus', 'verify abcdef123456',
    ]);
    expect(JSON.parse(f.lines[0]!)).toEqual(result);
  });
  test('installs root then PWA dependencies before build, using each checkout cwd', async () => {
    const f = fixture();
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const run = f.deps.run!;
    f.deps.run = (cmd, args, cwd, options) => {
      calls.push({ args, cwd });
      return run(cmd, args, cwd, options);
    };
    await runSelfUpdate({}, f.deps);
    expect(calls.slice(0, 4)).toEqual([
      { args: ['install', '--frozen-lockfile'], cwd: checkout },
      { args: ['install', '--frozen-lockfile'], cwd: join(checkout, 'apps/pwa') },
      { args: ['bin/elanous.mjs', 'nexus', 'build'], cwd: checkout },
      { args: [join(checkout, 'scripts/install.sh'), '--no-modify-path'], cwd: checkout },
    ]);
  });

  test.each([checkout, join(checkout, 'apps/pwa')])('failed dependency install in %s leaves the old version untouched', async (failedDir) => {
    const f = fixture();
    const calls: string[] = [];
    const alerts: string[] = [];
    f.deps.run = (cmd, args, cwd) => {
      calls.push(`${cmd} ${args.join(' ')} @ ${cwd}`);
      return { status: cwd === failedDir ? 1 : 0, stderr: cwd === failedDir ? 'first line\nlast diagnostic\n' : '' };
    };
    const result = await runSelfUpdate({ restart: true, alert: true }, {
      ...f.deps,
      alert: (text) => alerts.push(text),
      installedVersion: () => { throw new Error('must not inspect installed version'); },
      pruneVersions: () => { throw new Error('must not prune'); },
      verifyRestart: async () => { throw new Error('must not restart'); },
    });
    expect(result).toMatchObject({ exitCode: 1, installedVersion: null, restarted: false, reason: '의존 설치 실패: last diagnostic' });
    expect(calls).toEqual(failedDir === checkout
      ? [`bun install --frozen-lockfile @ ${checkout}`]
      : [`bun install --frozen-lockfile @ ${checkout}`, `bun install --frozen-lockfile @ ${join(checkout, 'apps/pwa')}`]);
    expect(alerts).toHaveLength(1);
  });

  test('a failed PWA build returns the output tail and alerts once without installing, relinking or restarting', async () => {
    const f = fixture();
    const alerts: string[] = [];
    const sideEffects: string[] = [];
    f.deps.run = (cmd, args, cwd, options) => {
      if (args[0] === 'install') return { status: 0, stderr: '' };
      expect([cmd, args, cwd, options]).toEqual(['bun', ['bin/elanous.mjs', 'nexus', 'build'], checkout, { timeout: 900_000 }]);
      f.calls.push('bun build failed');
      return { status: 1, stdout: 'first line\n', stderr: 'build error\nfinal diagnostic\n' };
    };
    const result = await runSelfUpdate({ restart: true, alert: true }, {
      ...f.deps,
      installedVersion: () => { sideEffects.push('installedVersion'); return 'new'; },
      pruneVersions: () => { sideEffects.push('prune'); return { removed: [], kept: [] }; },
      relinkCurrent: () => { sideEffects.push('relink'); },
      verifyRestart: async () => { sideEffects.push('verify'); return { ok: true }; },
      alert: (text) => alerts.push(text),
    });
    expect(result).toMatchObject({ exitCode: 1, installedVersion: null, restarted: false, reason: 'PWA 빌드 실패: final diagnostic' });
    expect(result.pwaBuiltCommit).toBeUndefined();
    expect(result.reason.split('\n')).toHaveLength(1);
    expect(f.calls).toContain('bun build failed');
    expect(sideEffects).toEqual([]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain(result.reason);
  });

  test('a successful build precedes install and carries checkout HEAD and build timestamp through JSON result', async () => {
    const f = fixture();
    f.deps.run = (cmd, args, cwd, options) => {
      f.calls.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'bun' && args[0] !== 'install') {
        expect([args, cwd, options]).toEqual([['bin/elanous.mjs', 'nexus', 'build'], checkout, { timeout: 900_000 }]);
      }
      return { status: 0, stderr: '' };
    };
    const before = Date.now();
    const result = await runSelfUpdate({ json: true }, f.deps);
    expect(f.calls.filter((c) => c === 'bun bin/elanous.mjs nexus build')).toHaveLength(1);
    expect(f.calls.indexOf('bun bin/elanous.mjs nexus build')).toBeLessThan(f.calls.indexOf(`bash ${checkout}/scripts/install.sh --no-modify-path`));
    expect(result.pwaBuiltCommit).toBe(sha.slice(0, 12));
    expect(Date.parse(result.pwaBuiltAt!)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(result.pwaBuiltAt!)).toBeLessThanOrEqual(Date.now());
    expect(JSON.parse(f.lines[0]!)).toEqual(result);
  });

  test('explicit --skip-pwa-build preserves the checkout install path without running a build', async () => {
    const f = fixture();
    f.deps.run = (cmd, args) => {
      if (cmd === 'bun') expect(args).toEqual(['install', '--frozen-lockfile']);
      f.calls.push(`${cmd} ${args.join(' ')}`);
      return { status: 0, stderr: '' };
    };
    const result = await runSelfUpdate({ skipPwaBuild: true }, f.deps);
    expect(result).toMatchObject({ exitCode: 0, installedVersion: '1.0.0-abcdef123456' });
    expect(result.pwaBuiltCommit).toBeUndefined();
    expect(result.pwaBuiltAt).toBeUndefined();
    expect(f.calls).toContain(`bash ${checkout}/scripts/install.sh --no-modify-path`);
    expect(f.calls.filter((call) => call === 'bun install --frozen-lockfile')).toHaveLength(1);
  });

  test('installation routing forwards explicit skip to the checkout', async () => {
    const f = fixture();
    f.deps.run = (cmd, args) => {
      if (cmd === 'bun') expect(args).toEqual(['install', '--frozen-lockfile']);
      f.calls.push(`${cmd} ${args.join(' ')}`);
      return { status: 0, stderr: '' };
    };
    const result = await runUpdateForInstallation({ from: checkout, skipPwaBuild: true }, { checkout: f.deps });
    expect(result.exitCode).toBe(0);
    expect(f.calls).toContain(`bash ${checkout}/scripts/install.sh --no-modify-path`);
    expect(f.calls.filter((call) => call.startsWith('bun '))).toEqual(['bun install --frozen-lockfile']);
  });

  test('no --restart means no service command and an explicit reason', async () => {
    const f = fixture();
    const result = await runSelfUpdate({}, f.deps);
    expect(result).toMatchObject({ exitCode: 0, restarted: false });
    expect(result.reason).toContain('--restart 없음');
    expect(f.calls.filter((s) => s.startsWith('launchctl'))).toHaveLength(0);
    expect(f.lines).toHaveLength(1);
  });
  test('none does not restart with --restart', async () => {
    const f = fixture({ exitCode: 0, verdict: 'none' });
    const result = await runSelfUpdate({ restart: true }, f.deps);
    expect(result.restarted).toBe(false);
    expect(f.calls.some((s) => s.startsWith('launchctl'))).toBe(false);
  });
  // 2026-09-28 — PWA 만 바뀐 판을 깔고 재시작하지 않자 운영이 옛 PWA 를 계속 서빙했다(넥서스는 부팅 때의 판 디렉터리를 읽는다).
  test('build (PWA-only) restarts with --restart — the running nexus serves its boot-time version dir', async () => {
    const f = fixture({ exitCode: 10, verdict: 'build' });
    const result = await runSelfUpdate({ restart: true }, f.deps);
    expect(f.calls.some((s) => s.startsWith('launchctl'))).toBe(true);
    expect(result.restarted).toBe(true);
  });
  test('build without --restart installs but does not restart', async () => {
    const f = fixture({ exitCode: 10, verdict: 'build' });
    const result = await runSelfUpdate({}, f.deps);
    expect(result.restarted).toBe(false);
    expect(f.calls.some((s) => s.startsWith('launchctl'))).toBe(false);
  });
  test('unknown exit 2 installs but never restarts; preserves reason', async () => {
    const f = fixture({ exitCode: 2, reason: '데몬 무응답' });
    const result = await runSelfUpdate({ restart: true }, f.deps);
    expect(result).toMatchObject({ exitCode: 0, restarted: false });
    expect(result.reason).toContain('데몬 무응답');
    expect(f.calls.some((s) => s.startsWith('launchctl'))).toBe(false);
  });
  test('failed installation exits 1 without restarting', async () => {
    const f = fixture(); f.failInstall();
    const result = await runSelfUpdate({ restart: true }, f.deps);
    expect(result.exitCode).toBe(1);
    expect(result.restarted).toBe(false);
    expect(f.calls.some((s) => s.startsWith('launchctl'))).toBe(false);
  });
  test('tracked changes reject before deciding or installing', async () => {
    const f = fixture(); f.setDirty();
    const result = await runSelfUpdate({ restart: true }, f.deps);
    expect(result.exitCode).toBe(2);
    expect(f.calls.some((s) => s.startsWith('decide') || s.startsWith('bash'))).toBe(false);
  });
  test('missing checkout rejects with reason', async () => {
    const f = fixture();
    const result = await runSelfUpdate({ from: '/nonexistent-elanous-self-update-checkout' }, f.deps);
    expect(result.exitCode).toBe(2);
    expect(result.reason).toContain('체크아웃 없음');
    expect(f.calls).toHaveLength(0);
  });
  test('installation thrown error stops restart with exit 1', async () => {
    const f = fixture();
    f.deps.run = () => { throw new Error('spawn failed'); };
    const result = await runSelfUpdate({ restart: true }, f.deps);
    expect(result).toMatchObject({ exitCode: 1, restarted: false });
    expect(result.reason).toContain('spawn failed');
  });
  test('restart failure exits 1 and reports installed version without claiming restart', async () => {
    const f = fixture();
    f.deps.run = (cmd, args) => {
      f.calls.push(`${cmd} ${args.join(' ')}`);
      return { status: cmd === 'launchctl' ? 1 : 0, stderr: 'service failed' };
    };
    const result = await runSelfUpdate({ restart: true }, f.deps);
    expect(result).toMatchObject({ exitCode: 1, installedVersion: '1.0.0-abcdef123456', restarted: false });
    expect(result.reason).toContain('service failed');
  });
  test('linux restarts via systemctl user', async () => {
    const f = fixture(); f.deps.os = 'linux';
    await runSelfUpdate({ restart: true }, f.deps);
    expect(f.calls.at(-2)).toBe('systemctl --user restart elanous-nexus');
    expect(f.calls.at(-1)).toBe('verify abcdef123456');
  });
});

// 🆕 2026-09-24 — 크론 PATH(/usr/bin:/bin)에도 설치기가 지금의 bun 을 찾게.
describe('childPath', () => {
  test('prepends the running bun directory once and keeps the rest', () => {
    expect(childPath({ PATH: '/usr/bin:/bin' }, '/Users/me/.bun/bin/bun')).toBe('/Users/me/.bun/bin:/usr/bin:/bin');
    expect(childPath({ PATH: '/Users/me/.bun/bin:/usr/bin' }, '/Users/me/.bun/bin/bun')).toBe('/Users/me/.bun/bin:/usr/bin');
    expect(childPath({}, '/opt/bun/bin/bun')).toBe('/opt/bun/bin');
  });
});

// 🆕 2026-09-24 — 야간 자동이 하룻밤 한 판(641MB)씩 쌓는다.
describe('planVersionPrune', () => {
  const e = (name: string, mtimeMs: number) => ({ name, mtimeMs });
  const list = [
    e('1.0.0-111111111111', 1), e('1.0.0-222222222222', 2), e('1.0.0-333333333333-dirty', 3),
    e('1.0.0-444444444444', 4), e('1.0.0-555555555555', 5), e('1.0.0-666666666666', 6),
  ];
  test('keeps current, the daemon version and the newest N; removes the rest', () => {
    const r = planVersionPrune(list, '1.0.0-666666666666', '111111111', 2);
    expect(r.kept.sort()).toEqual(['1.0.0-111111111111', '1.0.0-555555555555', '1.0.0-666666666666']);
    expect(r.removed.sort()).toEqual(['1.0.0-222222222222', '1.0.0-333333333333-dirty', '1.0.0-444444444444']);
  });
  test('removes nothing when the daemon version is unknown or absent', () => {
    expect(planVersionPrune(list, '1.0.0-666666666666', '', 2)).toMatchObject({ removed: [], skipped: expect.stringContaining('데몬 판 모름') });
    expect(planVersionPrune(list, '1.0.0-666666666666', 'deadbeef', 2)).toMatchObject({ removed: [], skipped: expect.stringContaining('목록에 없음') });
    expect(planVersionPrune(list, '1.0.0-777777777777', '111111111', 2)).toMatchObject({ removed: [], skipped: expect.stringContaining('current') });
  });
  test('a -dirty daemon sha still protects its version', () => {
    const r = planVersionPrune(list, '1.0.0-666666666666', '333333333-dirty', 1);
    expect(r.kept).toContain('1.0.0-333333333333-dirty');
  });
});

// 🆕 2026-09-24 — 무인 재시작 뒤 건강 확인 · 실패하면 데몬이 돌던 판으로 되돌림.
describe('self-update — verify after restart and roll back', () => {
  const decision = { exitCode: 11, verdict: 'restart', from: '111111111' } as RestartNeededResult;
  const versions = ['1.0.0-111111111111', '1.0.0-abcdef123456', '1.0.0-222222222222'];
  test('rollbackTarget picks the daemon version, never the installed one', () => {
    expect(rollbackTarget(versions, '111111111', '1.0.0-abcdef123456')).toBe('1.0.0-111111111111');
    expect(rollbackTarget(versions, 'abcdef1234', '1.0.0-abcdef123456')).toBeNull();
    expect(rollbackTarget(versions, '', '1.0.0-abcdef123456')).toBeNull();
    expect(versionCommit('1.0.0-111111111111-dirty')).toBe('111111111111');
  });
  test('unhealthy new version → relink current to daemon version, restart again, alert, exit 1', async () => {
    const f = fixture(decision);
    const verifies: boolean[] = [false, true];
    let relinked = '';
    const result = await runSelfUpdate({ restart: true }, {
      ...f.deps,
      listVersions: () => versions,
      relinkCurrent: (v) => { relinked = v; },
      verifyRestart: async () => ({ ok: verifies.shift() ?? false, reason: 'daemonSha 9914 ≠ abcdef' }),
    });
    expect(relinked).toBe('1.0.0-111111111111');
    expect(result).toMatchObject({ exitCode: 1, health: 'rolled-back', rolledBackTo: '1.0.0-111111111111', restarted: true });
    expect(f.calls.filter((c) => c.startsWith('launchctl')).length).toBe(2);
    expect(f.calls.some((c) => c.startsWith('alert'))).toBe(true);
  });
  test('rollback that also fails is reported as rollback-failed', async () => {
    const f = fixture(decision);
    const result = await runSelfUpdate({ restart: true }, { ...f.deps, listVersions: () => versions, relinkCurrent: () => {}, verifyRestart: async () => ({ ok: false, reason: 'x' }) });
    expect(result).toMatchObject({ exitCode: 1, health: 'rollback-failed' });
  });
  test('no rollback target → alert and exit 1 without relinking', async () => {
    const f = fixture({ ...decision, from: 'deadbeef1' } as RestartNeededResult);
    let relinked = false;
    const result = await runSelfUpdate({ restart: true }, { ...f.deps, listVersions: () => versions, relinkCurrent: () => { relinked = true; }, verifyRestart: async () => ({ ok: false }) });
    expect(relinked).toBe(false);
    expect(result).toMatchObject({ exitCode: 1, health: 'no-rollback-target' });
    expect(f.calls.some((c) => c.startsWith('alert'))).toBe(true);
  });
});

describe('self-update — unmeasured health never rolls back', () => {
  test('verify returns unmeasured → no relink, one restart, alert, health=unmeasured', async () => {
    const f = fixture({ exitCode: 11, verdict: 'restart', from: '111111111' } as RestartNeededResult);
    let relinked = false;
    const result = await runSelfUpdate({ restart: true }, { ...f.deps, listVersions: () => ['1.0.0-111111111111'], relinkCurrent: () => { relinked = true; }, verifyRestart: async () => ({ ok: false, unmeasured: true, reason: 'rest url 없음' }) });
    expect(relinked).toBe(false);
    expect(result).toMatchObject({ exitCode: 1, health: 'unmeasured' });
    expect(f.calls.filter((c) => c.startsWith('launchctl')).length).toBe(1);
    expect(f.calls.some((c) => c.startsWith('alert'))).toBe(true);
  });
});

describe('self-update --alert', () => {
  test('a dirty checkout alerts once with --alert, and stays silent without it', async () => {
    const f = fixture(); f.setDirty();
    const r = await runSelfUpdate({ alert: true }, f.deps);
    expect(r.exitCode).toBe(2);
    expect(f.calls.filter((c) => c.startsWith('alert')).length).toBe(1);
    const g = fixture(); g.setDirty();
    await runSelfUpdate({}, g.deps);
    expect(g.calls.some((c) => c.startsWith('alert'))).toBe(false);
  });
  test('a rollback alerts once even with --alert (no double alert)', async () => {
    const f = fixture({ exitCode: 11, verdict: 'restart', from: '111111111' } as RestartNeededResult);
    const verifies = [false, true];
    await runSelfUpdate({ restart: true, alert: true }, { ...f.deps, listVersions: () => ['1.0.0-111111111111'], relinkCurrent: () => {}, verifyRestart: async () => ({ ok: verifies.shift() ?? false }) });
    expect(f.calls.filter((c) => c.startsWith('alert')).length).toBe(1);
  });
  test('success never alerts', async () => {
    const f = fixture();
    await runSelfUpdate({ restart: true, alert: true }, f.deps);
    expect(f.calls.some((c) => c.startsWith('alert'))).toBe(false);
  });
});

describe('self-update — relay (T5 · 2026-09-24)', () => {
  const decision = { exitCode: 0, verdict: 'none' as const, from: 'aaa', to: 'bbb' };
  const gitWith = (paths: string[]) => (_cwd: string, args: string[]) => (
    args[0] === 'diff' ? { status: 0, stdout: paths.map((p) => `${p}\0`).join(''), stderr: '' } : { status: 1, stdout: '', stderr: 'unexpected' }
  );
  const relayFiles = () => ['scripts/openai-relay-server.ts', 'src/relay/core.ts'];

  test('restarts only the relay when a relay file changed, even if the nexus verdict is none', () => {
    const calls: string[] = [];
    const out = updateRelay(decision, '/co', true, { relayFiles, os: 'darwin', uid: 501 }, gitWith(['src/relay/core.ts', 'docs/x.md']),
      (command, args) => { calls.push(`${command} ${args.join(' ')}`); return { status: 0, stderr: '' }; });
    expect(out).toMatchObject({ verdict: 'restarted', paths: ['src/relay/core.ts'] });
    expect(calls).toEqual(['launchctl kickstart -k gui/501/com.elanous.openai-relay']);
  });

  test('does nothing when no relay file changed, without --restart, or when the daemon commit is unknown', () => {
    const calls: string[] = [];
    const run = () => { calls.push('run'); return { status: 0, stderr: '' }; };
    expect(updateRelay(decision, '/co', true, { relayFiles, os: 'darwin', uid: 501 }, gitWith(['docs/x.md']), run).verdict).toBe('unchanged');
    expect(updateRelay(decision, '/co', false, { relayFiles, os: 'darwin', uid: 501 }, gitWith(['src/relay/core.ts']), run).verdict).toBe('skipped');
    expect(updateRelay({ exitCode: 2 }, '/co', true, { relayFiles, os: 'darwin', uid: 501 }, gitWith(['src/relay/core.ts']), run).verdict).toBe('unknown');
    expect(calls).toEqual([]);
  });

  test('a failed relay restart is reported as failed, not folded into success', () => {
    const out = updateRelay(decision, '/co', true, { relayFiles, os: 'darwin', uid: 501 }, gitWith(['scripts/openai-relay-server.ts']),
      () => ({ status: 1, stderr: 'no such service' }));
    expect(out).toMatchObject({ verdict: 'failed' });
    expect(out.reason).toContain('no such service');
  });

  test('relay import closure follows relative imports from the real entry file', () => {
    const files = relayImportClosure(checkout);
    expect(files).toContain('scripts/openai-relay-server.ts');
    expect(files.length).toBeGreaterThan(1);
  });
});

import { debug } from '../debug/log.js';
import { formatUpdateNotice } from './self-update.js';
describe('self-update --dev and --rollback (temp install root only)', () => {
  const sha12 = sha.slice(0, 12);
  function devRoot() {
    const root = mkdtempSync(join(tmpdir(), 'elanous-dev-install-'));
    mkdirSync(join(root, 'versions', '0.2.15-aaaaaaaaaaaa', 'node_modules', 'elanous', 'bin'), { recursive: true });
    writeFileSync(join(root, 'versions', '0.2.15-aaaaaaaaaaaa', 'node_modules', 'elanous', 'bin', 'elanous.mjs'), '// entry\n');
    symlinkSync('versions/0.2.15-aaaaaaaaaaaa', join(root, 'current'));
    writeFileSync(join(root, 'install.json'), JSON.stringify({
      version: '0.2.15', versionDir: 'versions/0.2.15-aaaaaaaaaaaa', source: checkout, installedAt: '2026-10-01T00:00:00.000Z', commit: 'aaaaaaaaaaaa',
    }));
    return root;
  }
  // The fake installer behaves like scripts/install.sh: lays down versions/<ver>-<sha12> (with or without content), moves current, writes install.json.
  const devDeps = (root: string, opts: { empty?: boolean; failAfterRelink?: boolean } = {}): SelfUpdateDeps => ({
    ...fixture().deps,
    installRoot: root,
    packageVersion: () => '0.2.16-dev.0',
    allowLiveRestart: false,
    run: (cmd) => {
      if (cmd !== 'bash') return { status: 0, stderr: '' };
      const name = `0.2.16-dev.0-${sha12}`;
      mkdirSync(join(root, 'versions', name, 'node_modules', 'elanous', 'bin'), { recursive: true });
      if (!opts.empty) writeFileSync(join(root, 'versions', name, 'node_modules', 'elanous', 'bin', 'elanous.mjs'), '// entry\n');
      rmSync(join(root, 'current'), { force: true });
      symlinkSync(`versions/${name}`, join(root, 'current'));
      // install.sh moves current first (ln -sfn) and can fail afterwards, before writing install.json.
      if (opts.failAfterRelink) return { status: 1, stderr: 'package.json unreadable' };
      writeFileSync(join(root, 'install.json'), JSON.stringify({ version: '0.2.16-dev.0', versionDir: `versions/${name}`, source: checkout, installedAt: '2026-10-06T00:00:00.000Z', commit: sha12 }));
      return { status: 0, stderr: '' };
    },
  });

  test('--dev installs versions/<ver>-dev.<sha12>, moves current, and keeps channel=dev plus previous', async () => {
    const root = devRoot();
    try {
      const result = await runSelfUpdate({ dev: true, from: checkout }, devDeps(root));
      expect(result).toMatchObject({ exitCode: 0, channel: 'dev', current: `versions/0.2.16-dev.0-${sha12}`, previous: 'versions/0.2.15-aaaaaaaaaaaa', restarted: false });
      expect(readlinkSync(join(root, 'current'))).toBe(`versions/0.2.16-dev.0-${sha12}`);
      expect(lstatSync(join(root, 'versions', `0.2.16-dev.0-${sha12}`, 'node_modules', 'elanous', 'bin', 'elanous.mjs')).isFile()).toBe(true);
      const record = JSON.parse(readFileSync(join(root, 'install.json'), 'utf8')) as { channel?: string; previous?: string; versionDir?: string; commit?: string };
      expect(record).toMatchObject({ channel: 'dev', previous: 'versions/0.2.15-aaaaaaaaaaaa', versionDir: `versions/0.2.16-dev.0-${sha12}`, commit: sha12 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('--dev refuses an empty install: current and install.json stay on the previous version (10-06 05:30 incident)', async () => {
    const root = devRoot();
    try {
      const result = await runSelfUpdate({ dev: true, from: checkout }, devDeps(root, { empty: true }));
      expect(result.exitCode).toBe(1);
      expect(result.reason).toContain('빈 판');
      expect(readlinkSync(join(root, 'current'))).toBe('versions/0.2.15-aaaaaaaaaaaa');
      expect(JSON.parse(readFileSync(join(root, 'install.json'), 'utf8'))).toMatchObject({ versionDir: 'versions/0.2.15-aaaaaaaaaaaa', commit: 'aaaaaaaaaaaa' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('--dev restores current and install.json when the installer moves current and then fails (rc≠0)', async () => {
    const root = devRoot();
    try {
      const result = await runSelfUpdate({ dev: true, from: checkout }, devDeps(root, { empty: true, failAfterRelink: true }));
      expect(result.exitCode).toBe(1);
      expect(result.reason).toContain('설치기 실패');
      expect(readlinkSync(join(root, 'current'))).toBe('versions/0.2.15-aaaaaaaaaaaa');
      expect(JSON.parse(readFileSync(join(root, 'install.json'), 'utf8'))).toMatchObject({ versionDir: 'versions/0.2.15-aaaaaaaaaaaa', commit: 'aaaaaaaaaaaa' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('current is never relinked to a version directory without its entry file', async () => {
    const { relinkInstallCurrent } = await import('./self-update.js');
    const root = devRoot();
    try {
      mkdirSync(join(root, 'versions', '0.2.16-bbbbbbbbbbbb'), { recursive: true });
      expect(() => relinkInstallCurrent(root, '0.2.16-bbbbbbbbbbbb')).toThrow('빈 판');
      expect(readlinkSync(join(root, 'current'))).toBe('versions/0.2.15-aaaaaaaaaaaa');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('--rollback returns current to previous; omitting previous makes rollback fail', async () => {
    const root = devRoot();
    try {
      await runSelfUpdate({ dev: true, from: checkout }, devDeps(root));
      const back = await runSelfUpdate({ rollback: true }, devDeps(root));
      expect(back.exitCode).toBe(0);
      expect(readlinkSync(join(root, 'current'))).toBe('versions/0.2.15-aaaaaaaaaaaa');
      expect(back.reason).toContain('0.2.15-aaaaaaaaaaaa');
      // EDGE-RAIL-VERIFY: rollback metadata matches the restored version (05:30 incident left commit=0010… after rollback).
      expect(JSON.parse(readFileSync(join(root, 'install.json'), 'utf8'))).toMatchObject({ version: '0.2.15', commit: 'aaaaaaaaaaaa', versionDir: 'versions/0.2.15-aaaaaaaaaaaa' });
      const wiped = JSON.parse(readFileSync(join(root, 'install.json'), 'utf8')) as { previous?: string };
      delete wiped.previous;
      writeFileSync(join(root, 'install.json'), JSON.stringify(wiped));
      const refused = await runSelfUpdate({ rollback: true }, devDeps(root));
      expect(refused.exitCode).toBe(2);
      expect(refused.reason).toContain('rollback 거부');
      expect(readlinkSync(join(root, 'current'))).toBe('versions/0.2.15-aaaaaaaaaaaa');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a release update over a dev channel logs dev-replaced and the test guard performs zero live restarts', async () => {
    const prefix = mkdtempSync(join(tmpdir(), 'elanous-dev-replaced-'));
    const packageRoot = join(prefix, 'versions', '0.2.16-dev.0-dev.abcdef123456', 'node_modules', 'elanous');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(prefix, 'install.json'), JSON.stringify({
      version: '0.2.16-dev.0', versionDir: 'versions/0.2.16-dev.0-dev.abcdef123456', commit: sha12, channel: 'dev', previous: 'versions/0.2.15-aaaaaaaaaaaa',
      source: 'https://github.com/ElanvitalAI/elanous/releases/latest/download/elanous.tgz',
    }));
    const seen: Array<Record<string, unknown>> = [];
    const original = debug.log.bind(debug);
    debug.log = ((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'self-update' && event === 'dev-replaced') seen.push({ ...(data ?? {}) });
      return undefined;
    }) as typeof debug.log;
    const calls: string[] = [];
    try {
      const result = await runReleaseUpdate({ restart: true }, {
        packageRoot,
        fetchInstaller: async () => 'echo installer',
        run: (command) => {
          calls.push(command);
          if (command === 'bash') {
            writeFileSync(join(prefix, 'install.json'), JSON.stringify({ version: '0.2.16', versionDir: 'versions/0.2.16', commit: 'bbbbbbbbbbbb' }));
          }
          return { status: 0, stderr: '' };
        },
        os: 'darwin', uid: 501,
        out: { log: () => {}, error: () => {} },
      });
      expect(seen).toEqual([{ from: 'versions/0.2.16-dev.0-dev.abcdef123456', to: 'versions/0.2.16' }]);
      expect(result.exitCode).toBe(0);
      expect(calls).toContain('bash');
    } finally {
      debug.log = original;
      rmSync(prefix, { recursive: true, force: true });
    }
    expect(liveRestartBlocked({ ...process.env, NODE_ENV: 'test' })).toBe(true);
    expect(liveRestartBlocked({ ...process.env, NODE_ENV: 'production', ELANOUS_TEST_HOME: '/tmp/elanous-test-home' })).toBe(true);
    const guarded = fixture();
    delete guarded.deps.allowLiveRestart;
    const guardedResult = await runSelfUpdate({ restart: true }, guarded.deps);
    expect(guardedResult.restarted).toBe(false);
    expect(guardedResult.reason).toContain('실물 재시작 0');
    expect(guarded.calls.some((call) => call.startsWith('launchctl') || call.startsWith('systemctl'))).toBe(false);
  });
});

test('판올림 알림 — 재시작이면 «새로고침» 두 줄 · 판이 없으면 null', () => {
  const t = formatUpdateNotice({ installedVersion: '0.2.4-dev.0-abc', restarted: true, decision: null })!;
  expect(t).toContain('0.2.4-dev.0-abc');
  expect(t).toContain('넥서스 재시작함');
  expect(t).toContain('새로고침');
  expect(formatUpdateNotice({ installedVersion: 'x', restarted: false, decision: null })).toContain('재시작 안 함');
  expect(formatUpdateNotice({ installedVersion: null, restarted: false, decision: null })).toBeNull();
});
