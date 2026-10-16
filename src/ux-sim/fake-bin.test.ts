import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { createFakeBins, withFakeBins } from './fake-bin.js';

describe('fake-bin', () => {
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
