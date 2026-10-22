import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { createFakeBins, withFakeBins } from './fake-bin.js';

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
