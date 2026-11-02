// Synthetic highlight regression: each scene must survive assembly, and outputs stay in workdir.
import { afterAll, beforeAll, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative } from 'node:path';
import { ffmpeg } from './ffmpeg.js';
import { assembleMaster } from './film.js';

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'film-highlight-output-fu-'));
  for (const [scene, color] of [['briefing', 'blue'], ['browser', 'green']] as const) {
    const source = join(root, `${scene}.mp4`);
    const made = ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=64x64:r=24:d=1`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', source]);
    if (!made.ok) throw new Error(`synthetic ${scene} source failed: ${made.err}`);
  }
}, 60_000);

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

const centerRgb = (file: string, seconds: string): number[] => {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', seconds, '-i', file,
    '-frames:v', '1', '-vf', 'crop=2:2:iw/2:ih/2,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
  { maxBuffer: 1 << 20, timeout: 30_000 });
  if (result.status !== 0) throw new Error(`could not sample assembled frame: ${result.stderr?.toString() ?? result.error?.message ?? 'unknown error'}`);
  return [...(result.stdout as Buffer)].slice(0, 3);
};

const expectDirectoryEntries = (directory: string, expected: string[]) => {
  const actual = readdirSync(directory).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`unexpected files in ${directory}: ${actual.join(', ')}`);
  }
};

// This guards the explicit output root and child cwd; it is not a filesystem-wide sandbox.
it('master contains pixels from each planned scene and writes only beneath the explicit workdir', async () => {
  const before = readdirSync(root).sort();
  const workdir = join(root, 'explicit-output');
  const injectedWorkdir = join(root, 'injected-output');
  const isolatedCwd = join(root, 'isolated-cwd');
  const injectedCwd = join(root, 'injected-cwd');
  const injectedBin = join(root, 'injected-bin');
  mkdirSync(injectedWorkdir);
  mkdirSync(isolatedCwd);
  mkdirSync(injectedCwd);
  mkdirSync(injectedBin);
  const realFfmpeg = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
  if (realFfmpeg.status !== 0) throw new Error(`could not locate ffmpeg: ${realFfmpeg.stderr}`);
  const wrappedFfmpeg = join(injectedBin, 'ffmpeg');
  writeFileSync(wrappedFfmpeg, '#!/bin/sh\nprintf injected > "$PWD/rogue-output.tmp"\nexec "$FILM_REAL_FFMPEG" "$@"\n');
  chmodSync(wrappedFfmpeg, 0o755);
  const cwdBefore = readdirSync(isolatedCwd).sort();
  const child = spawnSync(process.execPath, ['-e', `
    const { assembleMaster } = await import(process.env.FILM_MODULE);
    const plan = [['briefing', 0, 1], ['browser', 1, 1]];
    const result = await assembleMaster({
      workdir: process.env.FILM_WORKDIR,
      state: { plan, shot_sources: { briefing: process.env.BRIEFING, browser: process.env.BROWSER }, fps: 24 },
      log: () => {},
    });
    console.log(JSON.stringify(result));
  `], {
    cwd: isolatedCwd,
    env: {
      ...process.env,
      FILM_MODULE: fileURLToPath(new URL('./film.js', import.meta.url)),
      FILM_WORKDIR: workdir,
      BRIEFING: join(root, 'briefing.mp4'),
      BROWSER: join(root, 'browser.mp4'),
    },
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 2 << 20,
  });
  if (child.status !== 0) throw new Error(`isolated assembler failed: ${child.stderr || child.error?.message || child.status}`);
  const assembled = JSON.parse(child.stdout.trim().split('\n').at(-1)!) as Awaited<ReturnType<typeof assembleMaster>>;

  expect(assembled.outcome).toBe('ok');
  const masterPath = String(assembled.produced?.master_path);
  expect(assembled.produced?.expected_seconds).toBe(2);
  expect(existsSync(masterPath)).toBe(true);

  const first = centerRgb(masterPath, '0.5');
  const second = centerRgb(masterPath, '1.5');
  expect(first[2]).toBeGreaterThan(150);
  expect(first[1]).toBeLessThan(100);
  expect(first[0]).toBeLessThan(100);
  expect(second[1]).toBeGreaterThan(70);
  expect(second[0]).toBeLessThan(80);
  expect(second[2]).toBeLessThan(80);

  const relativeMaster = relative(workdir, masterPath);
  expect(isAbsolute(relativeMaster)).toBe(false);
  expect(relativeMaster).toBe(join('master', 'master_16x9.mp4'));
  expect(readdirSync(root).sort()).toEqual([...before, 'explicit-output', 'injected-output', 'isolated-cwd', 'injected-cwd', 'injected-bin'].sort());
  expect(readdirSync(workdir)).toEqual(['master']);
  expect(readdirSync(join(workdir, 'master'))).toEqual(['master_16x9.mp4']);
  expectDirectoryEntries(isolatedCwd, cwdBefore);

  // Negative control: the child simulates a stray assembly side effect in its cwd.
  const injectedBefore = readdirSync(injectedCwd).sort();
  const injected = spawnSync(process.execPath, ['-e', `
    const { assembleMaster } = await import(process.env.FILM_MODULE);
    const plan = [['briefing', 0, 1], ['browser', 1, 1]];
    const result = await assembleMaster({
      workdir: process.env.FILM_WORKDIR,
      state: { plan, shot_sources: { briefing: process.env.BRIEFING, browser: process.env.BROWSER }, fps: 24 },
      log: () => {},
    });
    if (result.outcome !== 'ok') throw new Error(JSON.stringify(result));
  `], {
    cwd: injectedCwd,
    env: {
      ...process.env,
      FILM_MODULE: fileURLToPath(new URL('./film.js', import.meta.url)),
      FILM_WORKDIR: injectedWorkdir,
      FILM_REAL_FFMPEG: realFfmpeg.stdout.trim(),
      PATH: `${injectedBin}:${process.env.PATH ?? ''}`,
      BRIEFING: join(root, 'briefing.mp4'),
      BROWSER: join(root, 'browser.mp4'),
    },
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 2 << 20,
  });
  if (injected.status !== 0) throw new Error(`injected assembly child failed: ${injected.stderr || injected.error?.message || injected.status}`);
  expect(() => expectDirectoryEntries(injectedCwd, injectedBefore)).toThrow('unexpected files');
  expect(readdirSync(injectedWorkdir)).toEqual(['master']);
  expect(readdirSync(join(injectedWorkdir, 'master'))).toEqual(['master_16x9.mp4']);
  rmSync(join(injectedCwd, 'rogue-output.tmp'));
  expectDirectoryEntries(injectedCwd, injectedBefore);
}, 120_000);
