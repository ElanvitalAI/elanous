import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Writable } from 'node:stream';

import { createFakeBins, createFakeExecutableDevice, withFakeBins, withFakeExecutableDevice } from './fake-bin.js';

describe('fake-bin', () => {
  test('recorder does not recurse when its own mktemp, cat, and rm utilities are faked', () => {
    const fakeBins = createFakeBins({
      mktemp: { stdout: 'fake-mktemp\n' },
      cat: { stdout: 'fake-cat\n' },
      rm: { stdout: 'fake-rm\n' },
    });
    try {
      for (const name of ['mktemp', 'cat', 'rm'] as const) {
        const result = spawnSync(fakeBins.bin(name), ['sample'], { encoding: 'utf8', env: fakeBins.env, timeout: 2_000 });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(`fake-${name}\n`);
      }
      expect(fakeBins.calls()).toEqual([
        { name: 'mktemp', argv: ['sample'] },
        { name: 'cat', argv: ['sample'] },
        { name: 'rm', argv: ['sample'] },
      ]);
    } finally { fakeBins.cleanup(); }
  });

  test('a fake executable prints its stdout/stderr, exits with its code and records argv', () => {
    const fakeBins = createFakeBins({ magick: { stdout: 'out line\n', stderr: "it's err\n", exitCode: 3 } });
    try {
      const result = spawnSync(fakeBins.bin('magick'), ['identify', 'a b.png', ''], { encoding: 'utf8' });
      expect(result.status).toBe(3);
      expect(result.stdout).toBe('out line\n');
      expect(result.stderr).toBe("it's err\n");
      expect(fakeBins.calls()).toEqual([{ name: 'magick', argv: ['identify', 'a b.png', ''] }]);
    } finally {
      fakeBins.cleanup();
    }
    expect(existsSync(fakeBins.dir)).toBe(false);
  });

  test('whenArgsStartWith fakes only the matching subcommand and hands every other call to the real executable', () => {
    const realSh = Bun.which('sh');
    if (!realSh) throw new Error('sh unavailable');
    const fakeBins = createFakeBins({ sh: { whenArgsStartWith: ['-c', 'exit 7'], stderr: 'fatal: injected\n', exitCode: 128, otherwise: realSh } });
    try {
      const faked = spawnSync(fakeBins.bin('sh'), ['-c', 'exit 7'], { encoding: 'utf8' });
      expect(faked.status).toBe(128);
      expect(faked.stderr).toBe('fatal: injected\n');
      const passed = spawnSync(fakeBins.bin('sh'), ['-c', 'printf real; exit 5'], { encoding: 'utf8' });
      expect(passed.status).toBe(5);
      expect(passed.stdout).toBe('real');
      expect(passed.stderr).toBe('');
      expect(fakeBins.calls().map((call) => call.argv)).toEqual([['-c', 'exit 7'], ['-c', 'printf real; exit 5']]);
    } finally {
      fakeBins.cleanup();
    }
  });

  test('killSignal makes the fake die by that signal after its output, with no exit code (a «died without a word» failure)', () => {
    const fakeBins = createFakeBins({ tool: { killSignal: 'KILL' }, noisy: { stdout: 'partial\n', killSignal: 'TERM' } });
    try {
      const silent = spawnSync(fakeBins.bin('tool'), ['worktree', 'add'], { encoding: 'utf8' });
      expect(silent.status).toBeNull();
      expect(silent.signal).toBe('SIGKILL');
      expect(silent.stderr).toBe('');
      const noisy = spawnSync(fakeBins.bin('noisy'), [], { encoding: 'utf8' });
      expect(noisy.signal).toBe('SIGTERM');
      expect(noisy.stdout).toBe('partial\n');
    } finally {
      fakeBins.cleanup();
    }
    const slept = createFakeBins({ tool: { sleepSeconds: 1, killSignal: 'KILL' } });
    try {
      expect(spawnSync(slept.bin('tool'), [], { encoding: 'utf8' }).signal).toBe('SIGKILL');
    } finally {
      slept.cleanup();
    }
    expect(() => createFakeBins({ tool: { killSignal: 'kill; rm' as 'KILL' } })).toThrow(/killSignal/);
  });

  test('whenArgsStartWith needs an absolute otherwise executable, and otherwise needs a match', () => {
    expect(() => createFakeBins({ tool: { whenArgsStartWith: ['worktree', 'add'] } })).toThrow(/otherwise/);
    expect(() => createFakeBins({ tool: { whenArgsStartWith: ['worktree'], otherwise: 'tool' } })).toThrow(/absolute/);
    expect(() => createFakeBins({ tool: { otherwise: '/bin/sh' } })).toThrow(/whenArgsStartWith/);
  });

  test('withFakeBins puts the fakes first on PATH for calls without env and restores PATH afterwards', async () => {
    const before = process.env.PATH;
    const seen = await withFakeBins({ tesseract: { stdout: 'tesseract 9.9.9-fake\n' } }, (fakeBins) => {
      // Called by bare name: Bun needs test/preload-child-env.ts to see the changed PATH.
      const result = spawnSync('tesseract', ['--version'], { encoding: 'utf8' });
      expect(result.stdout).toBe('tesseract 9.9.9-fake\n');
      expect(spawnSync('tesseract', [], { encoding: 'utf8', env: fakeBins.env }).status).toBe(0);
      return fakeBins.calls().map((call) => call.argv);
    });
    expect(seen).toEqual([['--version'], []]);
    expect(process.env.PATH).toBe(before);
  });

  test('withFakeBins restores PATH and removes the fakes when the body throws', async () => {
    const before = process.env.PATH;
    let dir = '';
    await expect(withFakeBins({ grok: {} }, (fakeBins) => {
      dir = fakeBins.dir;
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(process.env.PATH).toBe(before);
    expect(existsSync(dir)).toBe(false);
  });

  test('sleepSeconds keeps a daemon-like fake alive until killed', async () => {
    await withFakeBins({ grok: { sleepSeconds: 30 } }, async (fakeBins) => {
      const child = spawn(fakeBins.bin('grok'), ['agent', 'leader'], { stdio: 'ignore' });
      const exited = new Promise((resolve) => child.once('exit', resolve));
      try {
        expect(await fakeBins.waitForCalls(1)).toEqual([{ name: 'grok', argv: ['agent', 'leader'] }]);
        expect(child.exitCode).toBeNull();
      } finally {
        child.kill('SIGKILL');
        await exited;
      }
    });
  });

  test('sleepSeconds with a non-zero exitCode exits with that code after the sleep', async () => {
    await withFakeBins({ codex: { sleepSeconds: 1, exitCode: 4 } }, (fakeBins) => {
      const started = Date.now();
      const result = spawnSync(fakeBins.bin('codex'), ['exec'], { encoding: 'utf8' });
      expect(result.status).toBe(4);
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    });
  });

  test('fractional sleepSeconds keeps sub-second latency (not rounded up to a whole second)', async () => {
    await withFakeBins({ gh: { sleepSeconds: 0.2, stdout: 'x' } }, (fakeBins) => {
      const started = Date.now();
      const result = spawnSync(fakeBins.bin('gh'), ['pr', 'diff', '1'], { encoding: 'utf8' });
      const elapsed = Date.now() - started;
      expect(result.status).toBe(0);
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(900);
    });
  });

  test('concurrent calls each record one intact argv (no interleaved records)', async () => {
    await withFakeBins({ gh: { sleepSeconds: 0.1 } }, async (fakeBins) => {
      const children = Array.from({ length: 20 }, (_, i) => spawn(fakeBins.bin('gh'), ['pr', 'diff', String(i), '--patch'], { stdio: 'ignore' }));
      await Promise.all(children.map((child) => new Promise((resolve) => child.once('exit', resolve))));
      const argvs = fakeBins.calls().map((call) => call.argv.join(' ')).sort();
      expect(argvs).toEqual(Array.from({ length: 20 }, (_, i) => `pr diff ${i} --patch`).sort());
    });
  });

  test('waitForCalls fails loudly when the fake was never called', async () => {
    await withFakeBins({ grok: {} }, async (fakeBins) => {
      await expect(fakeBins.waitForCalls(1, 50)).rejects.toThrow('expected 1 call(s) within 50ms, saw 0');
    });
  });

  test('rejects names that are not a single path segment', () => {
    for (const name of ['../grok', '.', '..', '']) {
      expect(() => createFakeBins({ [name]: {} })).toThrow('invalid executable name');
    }
  });
});

describe('fake executable result receipts', () => {
  test('run preserves shell metacharacters as argv and rejects shell mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'fake-bin-shell-boundary-'));
    const marker = join(root, 'shell-ran');
    const payload = `before; touch '${marker}'; \`echo injected\` $(echo injected) after`;
    const device = createFakeExecutableDevice({ mocktool: { stdout: 'safe\n' } });
    try {
      const result = device.run('mocktool', ['--value', payload]);
      expect(result.status).toBe(0);
      expect(device.calls()).toEqual([{ name: 'mocktool', argv: ['--value', payload] }]);
      expect(device.runs()[0]?.argv).toEqual(['--value', payload]);
      expect(existsSync(marker)).toBe(false);

      expect(() => device.run('mocktool', ['--value', payload], { shell: true } as never))
        .toThrow('fake-bin: run does not support shell; argv must remain literal');
      expect(existsSync(marker)).toBe(false);
    } finally {
      device.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('PATH execution captures argv, stdout, stderr, and exit status', () => {
    const device = createFakeExecutableDevice({
      mocktool: { stdout: 'out\n', stderr: 'warn\n', exitCode: 7 },
    });
    try {
      const result = device.run('mocktool', ['--name', 'two words', '']);
      expect(result.status).toBe(7);
      expect(result.stdout).toBe('out\n');
      expect(result.stderr).toBe('warn\n');
      expect(device.calls()).toEqual([{ name: 'mocktool', argv: ['--name', 'two words', ''] }]);
      expect(device.runs()).toEqual([{
        name: 'mocktool', argv: ['--name', 'two words', ''], stdout: 'out\n', stderr: 'warn\n', exitCode: 7, signal: null,
      }]);
    } finally {
      device.cleanup();
    }
    expect(existsSync(device.dir)).toBe(false);
  });

  test('captures a zero exit and supports caller environment while keeping the fake first on PATH', async () => {
    let dir = '';
    await withFakeExecutableDevice({ tool: { stdout: 'ready\n' } }, async (device) => {
      dir = device.dir;
      const result = spawnSync('tool', ['--version'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: device.path('/usr/bin') },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('ready\n');
      expect(device.path('/usr/bin').split(':').slice(0, 2)).toEqual([device.dir, '/usr/bin']);
      expect(device.calls()).toEqual([{ name: 'tool', argv: ['--version'] }]);
    });
    expect(existsSync(dir)).toBe(false);
  });

  test('records a signaled child as no exit code plus its signal', () => {
    const device = createFakeExecutableDevice({ quiet: { killSignal: 'TERM' } });
    try {
      const result = device.run('quiet', ['check']);
      expect(result.status).toBeNull();
      expect(result.signal).toBe('SIGTERM');
      expect(device.runs()).toEqual([{
        name: 'quiet', argv: ['check'], stdout: '', stderr: '', exitCode: null, signal: 'SIGTERM',
      }]);
    } finally {
      device.cleanup();
    }
  });

  test('refuses unregistered names and stdio modes that prevent output capture', () => {
    const device = createFakeExecutableDevice({ tool: { stdout: 'ok\n' } });
    try {
      expect(() => device.run('/bin/echo', ['must-not-run'])).toThrow(/registered executable name/);
      expect(() => device.run('tool', [], { stdio: 'inherit' })).toThrow(/stdio=pipe/);
      expect(device.runs()).toEqual([]);
      expect(device.calls()).toEqual([]);
    } finally {
      device.cleanup();
    }
  });

  test('declared package artifacts are written only to the exact install prefix', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ux-sim-install-prefix-')));
    const prefix = join(root, 'prefix');
    const outside = join(root, 'outside');
    mkdirSync(outside);
    const args = ['install', '-g', '@openai/codex@latest'];
    const specs = { npm: { stdout: 'installer stdout\n', stderr: 'installer stderr\n', installArtifacts: { prefixEnv: 'NPM_CONFIG_PREFIX', prefix, argv: args, files: [{ path: 'bin/codex', contents: '#!/bin/sh\necho Codex 9.8.7\n' }] } } };
    const device = createFakeExecutableDevice(specs);
    try {
      const wrongArgs = device.run('npm', ['view', '@openai/codex'], { env: { NPM_CONFIG_PREFIX: prefix } });
      expect(wrongArgs.status).toBe(64);
      const refused = device.run('npm', args, { env: { NPM_CONFIG_PREFIX: outside } });
      expect(refused.status).toBe(78);
      expect(existsSync(join(outside, 'bin/codex'))).toBe(false);

      const linkedPrefix = join(root, 'linked-prefix');
      const linkedPrefixDevice = createFakeExecutableDevice({ npm: { ...specs.npm, installArtifacts: { ...specs.npm.installArtifacts, prefix: linkedPrefix } } });
      try {
        symlinkSync(outside, linkedPrefix, 'dir');
        expect(linkedPrefixDevice.run('npm', args, { env: { NPM_CONFIG_PREFIX: linkedPrefix } }).status).toBe(73);
        expect(existsSync(join(outside, 'bin/codex'))).toBe(false);
      } finally { linkedPrefixDevice.cleanup(); }

      const runtimeParent = join(root, 'runtime-parent');
      mkdirSync(runtimeParent);
      const runtimePrefix = join(runtimeParent, 'prefix');
      const runtimeSymlinkDevice = createFakeExecutableDevice({ npm: { ...specs.npm, installArtifacts: { ...specs.npm.installArtifacts, prefix: runtimePrefix } } });
      try {
        renameSync(runtimeParent, join(root, 'moved-runtime-parent'));
        symlinkSync(outside, runtimeParent, 'dir');
        expect(runtimeSymlinkDevice.run('npm', args, { env: { NPM_CONFIG_PREFIX: runtimePrefix } }).status).toBe(73);
        expect(existsSync(join(outside, 'prefix/bin/codex'))).toBe(false);
      } finally { runtimeSymlinkDevice.cleanup(); }

      mkdirSync(prefix);
      symlinkSync(outside, join(prefix, 'bin'), 'dir');
      expect(device.run('npm', args, { env: { NPM_CONFIG_PREFIX: prefix } }).status).toBe(73);
      expect(existsSync(join(outside, 'codex'))).toBe(false);
      unlinkSync(join(prefix, 'bin'));

      mkdirSync(join(prefix, 'bin'));
      symlinkSync(join(outside, 'codex'), join(prefix, 'bin/codex'));
      expect(device.run('npm', args, { env: { NPM_CONFIG_PREFIX: prefix } }).status).toBe(73);
      expect(existsSync(join(outside, 'codex'))).toBe(false);
      unlinkSync(join(prefix, 'bin/codex'));

      const failedInstall = createFakeExecutableDevice({ npm: { exitCode: 1, installArtifacts: specs.npm.installArtifacts } });
      try {
        expect(failedInstall.run('npm', args, { env: { NPM_CONFIG_PREFIX: prefix } }).status).toBe(1);
        expect(existsSync(join(prefix, 'bin/codex'))).toBe(false);
      } finally { failedInstall.cleanup(); }

      const blockedPrefix = join(root, 'blocked-prefix');
      writeFileSync(blockedPrefix, 'not a directory');
      const blockedInstall = createFakeExecutableDevice({ npm: { installArtifacts: { ...specs.npm.installArtifacts, prefix: blockedPrefix } } });
      try {
        expect(blockedInstall.run('npm', args, { env: { NPM_CONFIG_PREFIX: blockedPrefix } }).status).toBe(74);
        expect(existsSync(join(blockedPrefix, 'bin/codex'))).toBe(false);
      } finally { blockedInstall.cleanup(); }

      const manyArgPrefix = join(root, 'many-arg-prefix');
      const manyArgs = ['install', '-g', 'fixture', '--scope', 'private', '--registry', 'https://registry.invalid', '--offline', '--audit=false', '--fund=false'];
      const manyArgDevice = createFakeExecutableDevice({ npm: { installArtifacts: { prefixEnv: 'NPM_CONFIG_PREFIX', prefix: manyArgPrefix, argv: manyArgs, files: [{ path: 'bin/tool', contents: '#!/bin/sh\nexit 0\n' }] } } });
      try {
        expect(manyArgDevice.run('npm', manyArgs, { env: { NPM_CONFIG_PREFIX: manyArgPrefix } }).status).toBe(0);
        expect(existsSync(join(manyArgPrefix, 'bin/tool'))).toBe(true);
      } finally { manyArgDevice.cleanup(); }

      const installed = device.run('npm', args, { env: { NPM_CONFIG_PREFIX: prefix } });
      expect(installed.status).toBe(0);
      expect(installed.stdout).toBe('installer stdout\n');
      expect(installed.stderr).toBe('installer stderr\n');
      expect(existsSync(join(prefix, 'bin/codex'))).toBe(true);
      expect(device.calls()).toHaveLength(5);
    } finally {
      device.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('install prefixes and artifact paths reject NUL before native path truncation', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ux-sim-install-nul-')));
    const outside = join(root, 'outside');
    const files = [{ path: 'bin/codex', contents: 'must not be written' }];
    try {
      expect(() => createFakeExecutableDevice({
        npm: { installArtifacts: { prefixEnv: 'NPM_CONFIG_PREFIX', prefix: join(root, 'prefix'), argv: ['install'], files: [{ path: '..\0x/outside', contents: 'escape' }] } },
      })).toThrow(/install artifact path must stay relative/);
      expect(() => createFakeExecutableDevice({
        npm: { installArtifacts: { prefixEnv: 'NPM_CONFIG_PREFIX', prefix: join(root, 'prefix\0truncated'), argv: ['install'], files } },
      })).toThrow(/install prefix must not contain NUL/);
      expect(existsSync(outside)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a prefix-parent symlink swap after descriptor pinning cannot redirect an artifact write', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ux-sim-install-race-')));
    const parent = join(root, 'runtime-parent');
    const movedParent = join(root, 'moved-runtime-parent');
    const outside = join(root, 'outside');
    mkdirSync(parent);
    mkdirSync(outside);
    const prefix = join(parent, 'prefix');
    const argv = ['install', '-g', 'fixture'];
    const device = createFakeExecutableDevice({ npm: { installArtifacts: {
      prefixEnv: 'NPM_CONFIG_PREFIX', prefix, argv,
      files: [{ path: 'bin/codex', contents: '#!/bin/sh\nexit 0\n' }],
      testBarrier: true,
    } } });
    const child = spawn(device.bin('npm'), argv, {
      env: { ...process.env, PATH: device.path(), NPM_CONFIG_PREFIX: prefix },
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    try {
      const ready = await new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('installer did not reach prefix barrier')), 5_000);
        child.stdio[3]?.once('data', () => { clearTimeout(timer); resolve(true); });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
      });
      expect(ready).toBe(true);
      renameSync(parent, movedParent);
      symlinkSync(outside, parent, 'dir');
      (child.stdio[4] as Writable | null)?.write('continue\n');
      expect(await exited).toEqual({ code: 0, signal: null });
      expect(existsSync(join(outside, 'prefix/bin/codex'))).toBe(false);
      expect(existsSync(join(movedParent, 'prefix/bin/codex'))).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
      device.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('records spawn errors alongside the returned error object', () => {
    const name = 'echo';
    const parentPath = mkdtempSync(join(tmpdir(), 'ux-sim-fake-executable-parent-path-'));
    const marker = join(parentPath, 'external-echo-ran');
    const externalEcho = join(parentPath, name);
    writeFileSync(externalEcho, `#!/bin/sh\nprintf reached > '${marker}'\n`);
    chmodSync(externalEcho, 0o755);
    const device = createFakeExecutableDevice({ [name]: {} });
    device.cleanup();

    try {
      const result = device.run(name, ['must-not-fall-through'], {
        env: { PATH: [parentPath, process.env.PATH ?? ''].filter(Boolean).join(delimiter) },
      });
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('ENOENT');
      expect(existsSync(marker)).toBe(false);
      expect(device.runs()).toEqual([{
        name,
        argv: ['must-not-fall-through'],
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.status,
        signal: result.signal,
        error: result.error?.message,
      }]);
    } finally {
      rmSync(parentPath, { recursive: true, force: true });
    }
  });
});
