import { setDefaultTimeout, afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRelease } from './release-build.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const tempRoots: string[] = [];
afterEach(() => { for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(version = '0.0.1'): { root: string; out: string } {
  const base = mkdtempSync(join(tmpdir(), 'release-build-'));
  tempRoots.push(base);
  const root = join(base, 'public-tree');
  const out = join(base, 'assets');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'elanous', version, files: ['scripts/'] }));
  writeFileSync(join(root, 'scripts/install.sh'), '#!/bin/sh\necho shell\n');
  writeFileSync(join(root, 'scripts/install.ps1'), 'Write-Output powershell\n');
  writeFileSync(join(root, 'scripts/uninstall.sh'), '#!/bin/sh\necho remove\n');
  expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
  expect(spawnSync('git', ['add', '-A'], { cwd: root }).status).toBe(0);
  return { root, out };
}

const script = join(import.meta.dir, 'release-build.ts');

test('packs only the supplied tree, copies installers, writes sorted SHA256SUMS and package version', () => {
  const { root, out } = fixture();
  const result = buildRelease({ root, out });
  expect(result.version).toBe('0.0.1');
  expect(result.prerelease).toBe(false);
  expect(result.tag).toBeUndefined();
  expect(readdirSync(out).sort()).toEqual(['SHA256SUMS', 'elanous.tgz', 'install.ps1', 'install.sh', 'uninstall.sh']);
  expect(readFileSync(join(out, 'install.sh'), 'utf8')).toBe('#!/bin/sh\necho shell\n');
  expect(readFileSync(join(out, 'install.ps1'), 'utf8')).toBe('Write-Output powershell\n');
  expect(readFileSync(join(out, 'uninstall.sh'), 'utf8')).toBe('#!/bin/sh\necho remove\n');
  const names = ['install.ps1', 'install.sh', 'elanous.tgz', 'uninstall.sh'];
  expect(result.files.map((f) => f.name)).toEqual(names);
  const expected = names.map((name) => {
    const body = readFileSync(join(out, name));
    const sha256 = createHash('sha256').update(body).digest('hex');
    expect(result.files.find((f) => f.name === name)).toEqual({ name, sha256, bytes: body.byteLength });
    return `${sha256}  ${name}`;
  });
  expect(readFileSync(join(out, 'SHA256SUMS'), 'utf8')).toBe(`${expected.join('\n')}\n`);
  const tar = spawnSync('tar', ['-tzf', join(out, 'elanous.tgz')], { encoding: 'utf8' });
  expect(tar.status).toBe(0);
  expect(tar.stdout.split('\n')).toContain('package/package.json');
  const pkg = spawnSync('tar', ['-xOzf', join(out, 'elanous.tgz'), 'package/package.json'], { encoding: 'utf8' });
  expect(pkg.status).toBe(0);
  expect(JSON.parse(pkg.stdout).version).toBe('0.0.1');
});

test('CLI prints only JSON on stdout and warns once for missing PWA output', () => {
  const { root, out } = fixture();
  const child = spawnSync('bun', [script, '--root', root, '--out', out], { encoding: 'utf8' });
  expect(child.status).toBe(0);
  expect(child.stderr.trim().split('\n')).toEqual(['웹 화면 없는 판']);
  expect(JSON.parse(child.stdout)).toEqual({ version: '0.0.1', files: ['install.ps1', 'install.sh', 'elanous.tgz', 'uninstall.sh'].map((name) => {
    const body = readFileSync(join(out, name));
    return { name, sha256: createHash('sha256').update(body).digest('hex'), bytes: body.byteLength };
  }), prerelease: false });
});

test('CLI accepts matching stable tag and packs five files with the package version', () => {
  const { root, out } = fixture('0.1.0');
  const child = spawnSync('bun', [script, '--root', root, '--out', out, '--tag', 'v0.1.0'], { encoding: 'utf8' });
  expect(child.status).toBe(0);
  const result = JSON.parse(child.stdout);
  expect(result.version).toBe('0.1.0');
  expect(result.tag).toBe('v0.1.0');
  expect(result.prerelease).toBe(false);
  expect(result.files.map((file: { name: string }) => file.name)).toEqual(['install.ps1', 'install.sh', 'elanous.tgz', 'uninstall.sh']);
  expect(readdirSync(out).sort()).toEqual(['SHA256SUMS', 'elanous.tgz', 'install.ps1', 'install.sh', 'uninstall.sh']);
  const pkg = spawnSync('tar', ['-xOzf', join(out, 'elanous.tgz'), 'package/package.json'], { encoding: 'utf8' });
  expect(pkg.status).toBe(0);
  expect(JSON.parse(pkg.stdout).version).toBe('0.1.0');
});

test('CLI rejects mismatched tag with rc=2 and no output', () => {
  const { root, out } = fixture('0.1.0');
  const child = spawnSync('bun', [script, '--root', root, '--out', out, '--tag', 'v0.2.0'], { encoding: 'utf8' });
  expect(child.status).toBe(2);
  expect(child.stdout).toBe('');
  expect(child.stderr).toContain('0.2.0');
  expect(child.stderr).toContain('0.1.0');
  expect(existsSync(out)).toBe(false);
});

test.each(['rc', 'alpha', 'beta'])('CLI accepts matching %s prerelease tag', (channel) => {
  const version = `0.2.0-${channel}.1`;
  const { root, out } = fixture(version);
  const child = spawnSync('bun', [script, '--root', root, '--out', out, '--tag', `v${version}`], { encoding: 'utf8' });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toMatchObject({ version, tag: `v${version}`, prerelease: true });
  expect(readdirSync(out)).toHaveLength(5);
});

test.each(['0.2.0', 'v0.2.0-preview.1', 'v0.2.0-rc', 'v0.2.0-rc.x'])('CLI rejects malformed tag %s before output', (tag) => {
  const { root, out } = fixture('0.2.0');
  const child = spawnSync('bun', [script, '--root', root, '--out', out, '--tag', tag], { encoding: 'utf8' });
  expect(child.status).toBe(2);
  expect(child.stderr).toContain('format');
  expect(child.stdout).toBe('');
  expect(existsSync(out)).toBe(false);
});

test('buildRelease rejects an invalid tag before touching an existing empty output directory', () => {
  const { root, out } = fixture('0.1.0');
  mkdirSync(out);
  expect(() => buildRelease({ root, out, tag: 'v0.2.0' })).toThrow('0.1.0');
  expect(readdirSync(out)).toEqual([]);
});

test('CLI rejects nonempty output with rc=2 without overwriting existing data', () => {
  const { root, out } = fixture();
  mkdirSync(out);
  writeFileSync(join(out, 'sentinel'), 'untouched');
  const child = spawnSync('bun', [script, '--root', root, '--out', out], { encoding: 'utf8' });
  expect(child.status).toBe(2);
  expect(readdirSync(out)).toEqual(['sentinel']);
  expect(readFileSync(join(out, 'sentinel'), 'utf8')).toBe('untouched');
});

test('pack runs the supplied tree prepack hook and does not warn when PWA is present', () => {
  const { root, out } = fixture();
  mkdirSync(join(root, 'apps/pwa/out'), { recursive: true });
  writeFileSync(join(root, 'apps/pwa/out/index.html'), '<html></html>');
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  manifest.scripts = { prepack: 'bun -e "import { writeFileSync } from \'node:fs\'; writeFileSync(\'scripts/packed-marker\', \'from-public-tree\')"' };
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  const child = spawnSync('bun', [script, '--root', root, '--out', out], { encoding: 'utf8' });
  expect(child.status).toBe(0);
  expect(child.stderr).toBe('');
  const marker = spawnSync('tar', ['-xOzf', join(out, 'elanous.tgz'), 'package/scripts/packed-marker'], { encoding: 'utf8' });
  expect(marker.status).toBe(0);
  expect(marker.stdout).toBe('from-public-tree');
});

test('CLI requires --out', () => {
  const child = spawnSync('bun', [script], { encoding: 'utf8' });
  expect(child.status).toBe(2);
});
