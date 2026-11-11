import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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

  test('NODE_OPTIONS cannot prevent the fake from recording and returning its declared response', () => {
    const fakeBins = createFakeBins({ tool: { stdout: 'ok\n' } });
    try {
      const env = { ...process.env, NODE_OPTIONS: '--require=/definitely/missing/fake-bin-node-option.cjs' };
      const result = spawnSync(fakeBins.bin('tool'), ['inspect'], { encoding: 'utf8', env });
      expect([result.status, result.stdout]).toEqual([0, 'ok\n']);
      expect(fakeBins.calls()).toEqual([{ name: 'tool', argv: ['inspect'] }]);
    } finally { fakeBins.cleanup(); }
  });

  test('PERL5OPT cannot inject a missing module before the fake shim starts', () => {
    const fakeBins = createFakeBins({ tool: { stdout: 'ok\n' } });
    try {
      const env = { ...process.env, PERL5OPT: '-Mfake_bin_missing_startup_module' };
      const result = spawnSync(fakeBins.bin('tool'), ['inspect'], { encoding: 'utf8', env });
      expect([result.status, result.stdout]).toEqual([0, 'ok\n']);
      expect(fakeBins.calls()).toEqual([{ name: 'tool', argv: ['inspect'] }]);
    } finally { fakeBins.cleanup(); }
  });

  test('PERL5OPT and UTF-8 recordEnv survive the fake and a delegated child', () => {
    const sh = Bun.which('sh');
    if (!sh) throw new Error('sh unavailable');
    const fakeBins = createFakeBins({ tool: {
      stdout: 'ok\n', whenArgsStartWith: ['inspect'], otherwise: sh,
      recordEnv: ['PERL5OPT', 'FAKE_UNICODE'],
    } });
    try {
      const env = { ...fakeBins.env, PERL5OPT: '-Mfake_bin_missing_startup_module', FAKE_UNICODE: '値🙂' };
      const fake = spawnSync(fakeBins.bin('tool'), ['inspect'], { encoding: 'utf8', env });
      const delegated = spawnSync(fakeBins.bin('tool'), ['-c', 'printf "%s" "$PERL5OPT"'], { encoding: 'utf8', env });
      expect([fake.status, fake.stdout]).toEqual([0, 'ok\n']);
      expect([delegated.status, delegated.stdout]).toEqual([0, env.PERL5OPT]);
      expect(fakeBins.calls().map((call) => call.env)).toEqual([
        { PERL5OPT: env.PERL5OPT, FAKE_UNICODE: '値🙂' },
        { PERL5OPT: env.PERL5OPT, FAKE_UNICODE: '値🙂' },
      ]);
    } finally { fakeBins.cleanup(); }
  });

  test('delegation preserves a relative and writable caller PATH under Perl taint mode', () => {
    const sh = Bun.which('sh');
    if (!sh) throw new Error('sh unavailable');
    const writable = mkdtempSync(join(tmpdir(), 'fake-bin-writable-path-'));
    chmodSync(writable, 0o777);
    const fakeBins = createFakeBins({ tool: { whenArgsStartWith: ['fake-only'], otherwise: sh, recordEnv: ['PATH'] } });
    try {
      const path = ['.', writable, fakeBins.env.PATH ?? ''].join(delimiter);
      const result = spawnSync(fakeBins.bin('tool'), ['-c', 'printf "%s" "$PATH"'],
        { encoding: 'utf8', env: { ...fakeBins.env, PATH: path } });
      expect([result.status, result.stdout, result.stderr]).toEqual([0, path, '']);
      expect(fakeBins.calls()[0]?.env?.PATH).toBe(path);
    } finally { fakeBins.cleanup(); rmSync(writable, { recursive: true, force: true }); }
  });

  test('delegation preserves taint-sensitive environment and an executable path containing equals', () => {
    const perl = Bun.which('perl');
    if (!perl) throw new Error('perl unavailable');
    const root = mkdtempSync(join(tmpdir(), 'fake-bin-equals-path-'));
    const executable = join(root, 'a=b-tool');
    symlinkSync(perl, executable);
    const fakeBins = createFakeBins({ tool: { whenArgsStartWith: ['fake-only'], otherwise: executable,
      recordEnv: ['PATH', 'IFS', 'CDPATH', 'ENV', 'BASH_ENV'] } });
    try {
      const env = { ...fakeBins.env, PATH: ['.', root, fakeBins.env.PATH ?? ''].join(delimiter),
        IFS: '|', CDPATH: 'relative-cdpath', ENV: '/tmp/missing-env-file', BASH_ENV: '/tmp/missing-bash-env' };
      const result = spawnSync(fakeBins.bin('tool'), ['-e', 'print join("\\n", map { $ENV{$_} // "" } qw(PATH IFS CDPATH ENV BASH_ENV)), "\\n";'],
        { encoding: 'utf8', env });
      expect([result.status, result.stderr]).toEqual([0, '']);
      expect(result.stdout).toBe([env.PATH, env.IFS, env.CDPATH, env.ENV, env.BASH_ENV, ''].join('\n'));
      expect(fakeBins.calls()[0]?.env).toEqual({ PATH: env.PATH, IFS: env.IFS,
        CDPATH: env.CDPATH, ENV: env.ENV, BASH_ENV: env.BASH_ENV });
    } finally { fakeBins.cleanup(); rmSync(root, { recursive: true, force: true }); }
  });

  test('delegation leaves caller variables matching the generated restore prefix untouched', () => {
    const perl = Bun.which('perl');
    if (!perl) throw new Error('perl unavailable');
    const fakeBins = createFakeBins({ tool: { whenArgsStartWith: ['fake-only'], otherwise: perl } });
    try {
      const shim = readFileSync(fakeBins.bin('tool'), 'utf8');
      const prefix = shim.match(/"restorePrefix":"(ELANOUS_FAKE_BIN_RESTORE_[A-Za-z0-9]+_)"/)?.[1];
      if (!prefix) throw new Error('restore prefix missing from shim');
      const collidingKey = `${prefix}PATH`;
      const env = { ...fakeBins.env, [collidingKey]: 'caller-owned', [`${prefix}_PATH`]: 'caller-owned-too' };
      const result = spawnSync(fakeBins.bin('tool'), ['-e', 'print join("\\n", $ENV{PATH}, $ENV{shift @ARGV}, $ENV{shift @ARGV})', collidingKey, `${prefix}_PATH`],
        { encoding: 'utf8', env });
      expect([result.status, result.stderr]).toEqual([0, '']);
      expect(result.stdout).toBe([env.PATH, 'caller-owned', 'caller-owned-too'].join('\n'));
    } finally { fakeBins.cleanup(); }
  });

  test('Perl interpreter path with spaces still starts the shim', () => {
    const perl = Bun.which('perl');
    if (!perl) throw new Error('perl unavailable');
    const root = mkdtempSync(join(tmpdir(), 'fake bin perl path '));
    const originalPath = process.env.PATH;
    let fakeBins: ReturnType<typeof createFakeBins> | undefined;
    try {
      symlinkSync(perl, join(root, 'perl'));
      process.env.PATH = `${root}${delimiter}${originalPath ?? ''}`;
      fakeBins = createFakeBins({ tool: { stdout: 'space-ok\n' } });
      process.env.PATH = originalPath;
      const result = spawnSync(fakeBins.bin('tool'), ['inspect'], { encoding: 'utf8' });
      expect([result.status, result.stdout]).toEqual([0, 'space-ok\n']);
      expect(fakeBins.calls()[0]?.argv).toEqual(['inspect']);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      fakeBins?.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('UTF-8 argv, recorded env and output round-trip through response matching', () => {
    const fakeBins = createFakeBins({ tool: {
      recordEnv: ['FAKE_UNICODE'],
      responses: [{ argsStartWith: ['部署', '--'], stdout: '応答🙂\n' }],
    } });
    try {
      const result = spawnSync(fakeBins.bin('tool'), ['部署', '--', '終'], {
        encoding: 'utf8', env: { ...fakeBins.env, FAKE_UNICODE: '値🙂' },
      });
      expect([result.status, result.stdout]).toEqual([0, '応答🙂\n']);
      expect(fakeBins.calls()).toEqual([{ name: 'tool', argv: ['部署', '--', '終'], env: { FAKE_UNICODE: '値🙂' } }]);
    } finally { fakeBins.cleanup(); }
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

  test('responses select output and exit status by argv prefix, then use the default for unmatched argv', () => {
    const fakeBins = createFakeBins({
      tool: {
        stdout: 'default\n',
        responses: [
          { argsStartWith: ['auth', 'status'], stdout: 'logged-in\n', exitCode: 0 },
          { argsStartWith: ['auth', 'login'], stderr: 'login denied\n', exitCode: 17 },
        ],
      },
    });
    try {
      const status = spawnSync(fakeBins.bin('tool'), ['auth', 'status', '--json'], { encoding: 'utf8' });
      const login = spawnSync(fakeBins.bin('tool'), ['auth', 'login'], { encoding: 'utf8' });
      const other = spawnSync(fakeBins.bin('tool'), ['version'], { encoding: 'utf8' });
      expect([status.status, status.stdout, status.stderr]).toEqual([0, 'logged-in\n', '']);
      expect([login.status, login.stdout, login.stderr]).toEqual([17, '', 'login denied\n']);
      expect([other.status, other.stdout, other.stderr]).toEqual([0, 'default\n', '']);
      expect(fakeBins.calls().map((call) => call.argv)).toEqual([
        ['auth', 'status', '--json'], ['auth', 'login'], ['version'],
      ]);
    } finally {
      fakeBins.cleanup();
    }
  });

  test('responses match argv prefixes beyond the ninth positional argument', () => {
    const prefix = Array.from({ length: 10 }, (_, index) => `arg-${index + 1}`);
    const fakeBins = createFakeBins({ tool: { responses: [{ argsStartWith: prefix, stdout: 'matched\n' }] } });
    try {
      const result = spawnSync(fakeBins.bin('tool'), [...prefix, 'tail'], { encoding: 'utf8' });
      expect([result.status, result.stdout]).toEqual([0, 'matched\n']);
      expect(fakeBins.calls()[0]?.argv).toEqual([...prefix, 'tail']);
    } finally {
      fakeBins.cleanup();
    }
  });

  test('recordEnv captures delimiter, internal-name, empty, and absent values with each argv', () => {
    const fakeBins = createFakeBins({ tool: { recordEnv: ['FAKE_PRESENT', 'FAKE_EMPTY', 'FAKE_ABSENT', 'rec', 'arg'] } });
    try {
      const env: Record<string, string | undefined> = { ...fakeBins.env, FAKE_PRESENT: 'left\u001eright', FAKE_EMPTY: '', rec: 'caller-value', arg: 'argv-loop-collision' };
      delete env.FAKE_ABSENT;
      const result = spawnSync(fakeBins.bin('tool'), ['inspect', 'two words'], { encoding: 'utf8', env });
      const unsetArgEnv = { ...env };
      delete unsetArgEnv.arg;
      const unsetArgResult = spawnSync(fakeBins.bin('tool'), ['inspect', 'still has argv'], { encoding: 'utf8', env: unsetArgEnv });
      expect(result.status).toBe(0);
      expect(unsetArgResult.status).toBe(0);
      expect(fakeBins.calls()).toEqual([
        { name: 'tool', argv: ['inspect', 'two words'], env: { FAKE_PRESENT: 'left\u001eright', FAKE_EMPTY: '', FAKE_ABSENT: null, rec: 'caller-value', arg: 'argv-loop-collision' } },
        { name: 'tool', argv: ['inspect', 'still has argv'], env: { FAKE_PRESENT: 'left\u001eright', FAKE_EMPTY: '', FAKE_ABSENT: null, rec: 'caller-value', arg: null } },
      ]);
    } finally {
      fakeBins.cleanup();
    }
  });

  test('long repeated argv and env values plus special and unset env names round-trip exactly', () => {
    const repeatedArg = 'x'.repeat(16_384);
    const repeatedEnv = 'z'.repeat(16_384);
    const fakeBins = createFakeBins({ tool: { recordEnv: ['PWD', 'FAKE_UNSET_PWD', '__proto__', 'FAKE_LONG'] } });
    try {
      const env: Record<string, string | undefined> = { ...fakeBins.env, PWD: '/caller/pwd-value', FAKE_LONG: repeatedEnv };
      delete env.FAKE_UNSET_PWD;
      Object.defineProperty(env, '__proto__', { value: 'own-proto-value', enumerable: true, configurable: true, writable: true });
      // Bun's spawnSync drops a `__proto__` env entry before execve. Route only
      // this edge through Node so the test reaches the shim with the exact OS env.
      const node = Bun.which('node');
      if (!node) throw new Error('node unavailable for special environment key test');
      const nodeSpawn = [
        '-e',
        'const { spawnSync } = require("node:child_process"); const env = JSON.parse(process.argv[1]); const result = spawnSync(process.argv[2], JSON.parse(process.argv[3]), { encoding: "utf8", env }); process.stdout.write(JSON.stringify({ status: result.status, signal: result.signal }));',
      ];
      const present = spawnSync(node, [...nodeSpawn, JSON.stringify(env), fakeBins.bin('tool'), JSON.stringify([repeatedArg, '--', 'after--'])], { encoding: 'utf8' });
      const absentEnv = { ...env };
      delete absentEnv.PWD;
      const absent = spawnSync(node, [...nodeSpawn, JSON.stringify(absentEnv), fakeBins.bin('tool'), JSON.stringify(['unset-pwd'])], { encoding: 'utf8' });

      expect(JSON.parse(present.stdout).status).toBe(0);
      expect(JSON.parse(absent.stdout).status).toBe(0);
      const [first, second] = fakeBins.calls();
      expect(first?.argv).toEqual([repeatedArg, '--', 'after--']);
      expect(first?.env?.PWD).toBe('/caller/pwd-value');
      expect(first?.env?.FAKE_UNSET_PWD).toBeNull();
      expect(first?.env?.FAKE_LONG).toBe(repeatedEnv);
      expect(Object.hasOwn(first?.env ?? {}, '__proto__')).toBe(true);
      expect(first?.env?.['__proto__']).toBe('own-proto-value');
      expect(second?.env?.PWD).toBeNull();
      expect(second?.env?.FAKE_UNSET_PWD).toBeNull();
    } finally {
      fakeBins.cleanup();
    }
  });

  test('concurrent long argv and env records append as intact single JSON lines', async () => {
    const fakeBins = createFakeBins({ tool: { recordEnv: ['FAKE_BULK'] } });
    try {
      const expected = new Map<string, string>();
      const children = Array.from({ length: 12 }, (_, index) => {
        const id = `call-${index}`;
        const arg = `${id}:${'a'.repeat(16_384)}`;
        const value = `${id}:${'b'.repeat(16_384)}`;
        expected.set(id, value);
        const env = { ...fakeBins.env, FAKE_BULK: value };
        return spawn(fakeBins.bin('tool'), ['bulk', id, arg], { env, stdio: 'ignore' });
      });
      await Promise.all(children.map((child) => new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`fake child exit ${code}`)));
      })));
      const calls = fakeBins.calls();
      expect(calls).toHaveLength(expected.size);
      for (const call of calls) {
        const id = call.argv[1]!;
        expect(call.argv[2]).toBe(`${id}:${'a'.repeat(16_384)}`);
        expect(call.env?.FAKE_BULK).toBe(expected.get(id));
      }
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

  test('large output is drained before sleep and signal termination', () => {
    const payload = 'x'.repeat(256 * 1024);
    const fakeBins = createFakeBins({
      sleeper: { stdout: payload, sleepSeconds: 0.1 },
      noisy: { stdout: payload, killSignal: 'TERM' },
    });
    try {
      const sleeper = spawnSync(fakeBins.bin('sleeper'), [], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
      expect([sleeper.status, sleeper.stdout]).toEqual([0, payload]);
      const noisy = spawnSync(fakeBins.bin('noisy'), [], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
      expect(noisy.signal).toBe('SIGTERM');
      expect(noisy.stdout).toBe(payload);
    } finally { fakeBins.cleanup(); }
  });

  test('delegation replaces the shim so forced termination cannot orphan the real executable', async () => {
    const sh = Bun.which('sh');
    if (!sh) throw new Error('sh unavailable');
    const root = mkdtempSync(join(tmpdir(), 'fake-bin-delegate-'));
    const marker = join(root, 'delegate-started');
    const fakeBins = createFakeBins({ tool: { whenArgsStartWith: ['fake-only'], otherwise: sh } });
    try {
      const child = spawn(fakeBins.bin('tool'), ['-c', 'touch "$1"; exec sleep 30', 'sh', marker], { stdio: 'ignore' });
      const deadline = Date.now() + 5_000;
      while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(marker)).toBe(true);
      const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.kill('SIGKILL');
      await exited;
      expect(child.signalCode).toBe('SIGKILL');
      expect(() => process.kill(child.pid!, 0)).toThrow();
    } finally { fakeBins.cleanup(); rmSync(root, { recursive: true, force: true }); }
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
