// PWA-RUNTIME-LEAN — the installed package serves its packaged static PWA and
// never installs apps/pwa/node_modules when that PWA is this version's build.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptPackagedOut, replaceInstalledRealDirOut, runStaticBuild } from '../apps/pwa/scripts/static-generation';
import { checkPrebuiltPwa, runPwaBuild } from '../src/cli/pwa-build';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PACKED = '1234567890abcdef1234567890abcdef12345678';
const OTHER = 'ffffffffffffffffffffffffffffffffffffffff';

/** An installed-package layout: packed revision, no .git, apps/pwa with an out. */
function installedPackage(opts: { marker?: string; out?: 'valid' | 'error-shell' | 'none' } = {}): { root: string; app: string } {
  const root = mkdtempSync(join(tmpdir(), 'pwa-lean-installed-'));
  roots.push(root);
  const app = join(root, 'apps', 'pwa');
  mkdirSync(join(root, 'src', 'version'), { recursive: true });
  writeFileSync(join(root, 'src', 'version', 'packed-revision.json'), JSON.stringify({ commit: PACKED, builtAt: 1 }));
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), '{"name":"@elanous/pwa"}');
  writeFileSync(join(app, 'bun.lock'), '{}');
  if ((opts.out ?? 'valid') !== 'none') {
    const out = join(app, 'out');
    mkdirSync(join(out, '_next'), { recursive: true });
    writeFileSync(join(out, 'index.html'), opts.out === 'error-shell' ? '<html id="__next_error__"></html>' : '<html>packaged</html>');
    writeFileSync(join(out, '_next', 'app.js'), 'packaged');
    if (opts.marker) writeFileSync(join(out, 'elanous-pwa-build.json'), JSON.stringify({ commit: opts.marker }));
  }
  return { root, app };
}

function sink() {
  const logs: string[] = [];
  return { logs, out: { log: (s: string) => { logs.push(s); }, error: (s: string) => { logs.push(s); } } };
}

describe('checkPrebuiltPwa', () => {
  test('a checkout (has .git) keeps the build path', () => {
    const { root, app } = installedPackage({ marker: PACKED });
    writeFileSync(join(root, '.git'), 'gitdir: elsewhere\n');
    expect(checkPrebuiltPwa(app)).toEqual({ kind: 'checkout' });
  });

  test('installed package with this version\'s marker is prebuilt', () => {
    expect(checkPrebuiltPwa(installedPackage({ marker: PACKED }).app)).toEqual({ kind: 'prebuilt', commit: PACKED });
  });

  test('missing marker, other commit, error shell and missing out fall back to the in-place build', () => {
    expect(checkPrebuiltPwa(installedPackage().app)).toEqual({ kind: 'fallback', reason: 'marker-missing' });
    expect(checkPrebuiltPwa(installedPackage({ marker: OTHER }).app)).toEqual({ kind: 'fallback', reason: 'marker-mismatch out=ffffffffffff package=1234567890ab' });
    expect(checkPrebuiltPwa(installedPackage({ marker: PACKED, out: 'error-shell' }).app)).toEqual({ kind: 'fallback', reason: 'out-error-shell' });
    expect(checkPrebuiltPwa(installedPackage({ out: 'none' }).app)).toEqual({ kind: 'fallback', reason: 'out-missing' });
  });
});

describe('runPwaBuild in an installed package', () => {
  test('prebuilt: no bun install, no build, exit 0', async () => {
    const { app } = installedPackage({ marker: PACKED });
    const calls: string[][] = [];
    const { logs, out } = sink();
    const result = await runPwaBuild({ cwd: app, out, spawnFn: async (cmd, args) => { calls.push([cmd, ...args]); return 0; } });
    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([]);
    expect(existsSync(join(app, 'node_modules'))).toBe(false);
    expect(logs.join('\n')).toContain('pwa.lean skip=prebuilt commit=1234567890ab');
  });

  test('stale marker: logs the fallback and runs the old install + build path', async () => {
    const { app } = installedPackage({ marker: OTHER });
    const calls: string[][] = [];
    const { logs, out } = sink();
    const result = await runPwaBuild({ cwd: app, out, spawnFn: async (cmd, args) => { calls.push([cmd, ...args]); return 0; } });
    expect(logs.join('\n')).toContain('pwa.lean fallback=in-place-build reason=marker-mismatch');
    expect(calls[0]).toEqual(['bun', 'install', '--frozen-lockfile']);
    // The fake install adds no packages, so the old precheck refuses before `bun run build` — unchanged behavior.
    expect(result.exitCode).toBe(1);
  });
});

describe('adoptPackagedOut', () => {
  test('a valid real-directory out becomes a .pwa-generations symlink with the same files and no leftover backup', () => {
    const { app } = installedPackage({ marker: PACKED });
    const verdict = adoptPackagedOut(app);
    expect(verdict).toStartWith('pwa.lean adopt=generation id=');
    expect(lstatSync(join(app, 'out')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(app, 'out'))).toStartWith('.pwa-generations/');
    expect(readFileSync(join(app, 'out', 'index.html'), 'utf8')).toBe('<html>packaged</html>');
    expect(readFileSync(join(app, 'out', 'elanous-pwa-build.json'), 'utf8')).toContain(PACKED);
    expect(readdirSync(app).filter((name) => name.startsWith('.out-'))).toEqual([]);
    expect(adoptPackagedOut(app)).toBe('pwa.lean adopt=skip reason=already-generation');
    expect(checkPrebuiltPwa(app)).toEqual({ kind: 'prebuilt', commit: PACKED });
  });

  test('an invalid out is left as it is (never a blank PWA) and a missing out is a skip', () => {
    const { app } = installedPackage({ out: 'error-shell' });
    expect(adoptPackagedOut(app)).toStartWith('pwa.lean adopt=skip reason=');
    expect(lstatSync(join(app, 'out')).isDirectory()).toBe(true);
    expect(readFileSync(join(app, 'out', 'index.html'), 'utf8')).toContain('__next_error__');
    expect(adoptPackagedOut(installedPackage({ out: 'none' }).app)).toBe('pwa.lean adopt=skip reason=out-missing');
  });
});

describe('build marker', () => {
  test('runStaticBuild in an installed package stamps the packed commit into the published generation', async () => {
    const { root, app } = installedPackage({ out: 'none' });
    for (const path of ['scripts', 'skills/omni-crawl', 'scenarios', 'catalog', 'docs/profiles', 'plugins', 'node_modules']) {
      mkdirSync(join(root, path), { recursive: true });
    }
    let seenSha = '';
    await runStaticBuild(app, {
      runBuild: (_app, _stagedRepo, stagedApp) => {
        mkdirSync(join(stagedApp, 'out', '_next'), { recursive: true });
        writeFileSync(join(stagedApp, 'out', 'index.html'), '<html>rebuilt</html>');
        writeFileSync(join(stagedApp, 'out', '_next', 'a.js'), 'x');
        seenSha = 'ran';
        return 0;
      },
    });
    expect(seenSha).toBe('ran');
    expect(lstatSync(join(app, 'out')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(join(app, 'out', 'elanous-pwa-build.json'), 'utf8')).commit).toBe(PACKED);
    expect(checkPrebuiltPwa(app)).toEqual({ kind: 'prebuilt', commit: PACKED });
  });

  test('installed fallback over a real-directory out: swapped only after the build, restored when publishing fails', async () => {
    const { root, app } = installedPackage({ out: 'error-shell' });
    for (const path of ['scripts', 'skills/omni-crawl', 'scenarios', 'catalog', 'docs/profiles', 'plugins', 'node_modules']) {
      mkdirSync(join(root, path), { recursive: true });
    }
    await expect(replaceInstalledRealDirOut(app, async () => { throw new Error('disk full'); })).rejects.toThrow('disk full');
    expect(lstatSync(join(app, 'out')).isDirectory()).toBe(true);
    expect(readFileSync(join(app, 'out', 'index.html'), 'utf8')).toContain('__next_error__');
    let outDuringBuild = false;
    await runStaticBuild(app, {
      runBuild: (_app, _stagedRepo, stagedApp) => {
        outDuringBuild = existsSync(join(app, 'out', 'index.html'));
        mkdirSync(join(stagedApp, 'out', '_next'), { recursive: true });
        writeFileSync(join(stagedApp, 'out', 'index.html'), '<html>rebuilt</html>');
        writeFileSync(join(stagedApp, 'out', '_next', 'a.js'), 'x');
        return 0;
      },
    });
    expect(outDuringBuild).toBe(true);
    expect(lstatSync(join(app, 'out')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(app, 'out', 'index.html'), 'utf8')).toBe('<html>rebuilt</html>');
    expect(readdirSync(app).filter((name) => name.startsWith('.out-pre-lean-'))).toEqual([]);
  });

  test('the generation symlink layout from a previous in-place build still reads as prebuilt', () => {
    const { app } = installedPackage({ out: 'none' });
    const generation = join(app, '.pwa-generations', 'g1');
    mkdirSync(join(generation, '_next'), { recursive: true });
    writeFileSync(join(generation, 'index.html'), '<html>g1</html>');
    writeFileSync(join(generation, '_next', 'a.js'), 'x');
    writeFileSync(join(generation, 'elanous-pwa-build.json'), JSON.stringify({ commit: PACKED }));
    symlinkSync('.pwa-generations/g1', join(app, 'out'));
    expect(checkPrebuiltPwa(app)).toEqual({ kind: 'prebuilt', commit: PACKED });
  });
});
