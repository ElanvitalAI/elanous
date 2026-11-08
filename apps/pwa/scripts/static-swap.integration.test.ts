import { expect, test } from 'bun:test';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { migrateStoppedOut } from './static-generation';
import { publishStaticGeneration } from './publish-static-generation';
import { pinStaticGeneration, packagePinnedGeneration, checkStaticExport } from './static-entry';
import { resolvePwaStaticDir } from '../../../src/nexus/static-dir-resolve';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pwa-swap-'));
  const out = join(root, 'out');
  const source = join(root, 'source');
  const page = (directory: string, version: string) => {
    const assets = join(directory, '_next');
    const html = `<html>${version}<script src="/_next/app.js"></script></html>`;
    const js = `document.body.dataset.version='${version}'`;
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(directory, 'index.html'), html);
    writeFileSync(join(assets, 'app.js'), js);
  };
  page(source, 'A');
  await publishStaticGeneration(source, root);
  return { root, out, source, page };
}

test('production entry pins one complete generation through copy failure and pre-publish process death', async () => {
  const f = await fixture();
  try {
    const serverA = pinStaticGeneration(f.out);
    f.page(f.source, 'B');
    await expect(publishStaticGeneration(f.source, f.root, {
      copyDirectory: async (source, destination) => {
        cpSync(source, destination, { recursive: true });
        throw new Error('injected copy failure');
      },
    })).rejects.toThrow('injected copy failure');
    expect(pinStaticGeneration(f.out)).toBe(serverA);

    const script = `import {publishStaticGeneration} from ${JSON.stringify(join(import.meta.dir, 'publish-static-generation.ts'))}; await publishStaticGeneration(${JSON.stringify(f.source)},${JSON.stringify(f.root)},{onStage(stage){if(stage==='before-swap')process.exit(71)}});`;
    const child = spawnSync('bun', ['-e', script], { encoding: 'utf8' });
    expect(child.status).toBe(71);
    expect(pinStaticGeneration(f.out)).toBe(serverA);
    expect(readFileSync(join(serverA, 'index.html'), 'utf8')).toContain('A');
    expect(readFileSync(join(serverA, '_next/app.js'), 'utf8')).toContain("'A'");

    await publishStaticGeneration(f.source, f.root);
    const serverB = pinStaticGeneration(f.out);
    expect(serverB).not.toBe(serverA);
    expect(readFileSync(join(serverB, 'index.html'), 'utf8')).toContain('B');
    expect(readFileSync(join(serverB, '_next/app.js'), 'utf8')).toContain("'B'");
    expect(existsSync(join(serverA, 'index.html'))).toBe(true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('startup resolver pins the real generation while explicit paths keep their original value', async () => {
  const f = await fixture();
  try {
    const explicit = join(f.root, 'explicit-link');
    symlinkSync(f.out, explicit, 'dir');
    const resolved = resolvePwaStaticDir({ candidates: [f.out], exists: () => true, env: { NODE_ENV: process.env.NODE_ENV ?? 'test' } });
    expect(resolved).toBe(pinStaticGeneration(f.out));
    expect(resolved).not.toBe(f.out);
    expect(resolvePwaStaticDir({ argvBin: '', env: { NODE_ENV: process.env.NODE_ENV ?? 'test', ELANOUS_PWA_STATIC_DIR: explicit } })).toBe(explicit);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('stopped migration leaves a symlinked complete generation and rejects a second migration', () => {
  const root = mkdtempSync(join(tmpdir(), 'pwa-migration-'));
  const out = join(root, 'out');
  const linkedAssets = join(root, 'legacy-assets');
  try {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'index.html'), '<html>legacy</html>');
    mkdirSync(linkedAssets);
    writeFileSync(join(linkedAssets, 'legacy.js'), 'legacy');
    symlinkSync(linkedAssets, join(out, '_next'), 'dir');
    const first = migrateStoppedOut(out);
    expect(pinStaticGeneration(out)).toBe(realpathSync(first));
    expect(lstatSync(join(first, '_next')).isDirectory()).toBe(true);
    expect(lstatSync(join(first, '_next')).isSymbolicLink()).toBe(false);
    rmSync(linkedAssets, { recursive: true, force: true });
    expect(readFileSync(join(out, '_next', 'legacy.js'), 'utf8')).toBe('legacy');
    expect(() => migrateStoppedOut(out)).toThrow('real out directory');
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toContain('legacy');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stopped migration resumes after process death between legacy backup and pointer rename', () => {
  const root = mkdtempSync(join(tmpdir(), 'pwa-migration-recovery-'));
  const out = join(root, 'out');
  try {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'index.html'), '<html>legacy</html>');
    mkdirSync(join(out, '_next'));
    writeFileSync(join(out, '_next', 'legacy.js'), 'legacy');
    const script = `import {migrateStoppedOut} from ${JSON.stringify(join(import.meta.dir, 'static-generation.ts'))}; migrateStoppedOut(${JSON.stringify(out)},()=>process.exit(72));`;
    const child = spawnSync('bun', ['-e', script], { encoding: 'utf8' });
    expect(child.status).toBe(72);
    const recovered = migrateStoppedOut(out);
    expect(pinStaticGeneration(out)).toBe(realpathSync(recovered));
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toContain('legacy');
    expect(readdirSync(root).some((entry) => entry.startsWith('.out-legacy-'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('npm tarball contains the pinned generation even when out swaps during packaging', async () => {
  const f = await fixture();
  const app = join(f.root, 'package-app');
  const extracted = join(f.root, 'extracted');
  let tarball = '';
  try {
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'pwa-static-test', version: '1.0.0' }));
    symlinkSync(f.out, join(app, 'out'), 'dir');
    tarball = await packagePinnedGeneration(app, () => {
      f.page(f.source, 'B');
      return publishStaticGeneration(f.source, f.root).then(() => undefined);
    });
    mkdirSync(extracted, { recursive: true });
    const unpack = spawnSync('tar', ['-xzf', tarball, '-C', extracted], { encoding: 'utf8' });
    if (unpack.status !== 0) throw new Error(`tar extraction failed: ${unpack.stderr}`);
    expect(unpack.status).toBe(0);
    expect(readFileSync(join(extracted, 'package', 'out', 'index.html'), 'utf8')).toContain('A');
    expect(readFileSync(join(extracted, 'package', 'out', '_next', 'app.js'), 'utf8')).toContain("'A'");
  } finally {
    if (tarball) rmSync(dirname(tarball), { recursive: true, force: true });
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('explicit static directory remains unchanged and a real out directory is not auto-migrated', async () => {
  const f = await fixture();
  const explicit = join(f.root, 'external');
  try {
    f.page(explicit, 'explicit');
    expect(pinStaticGeneration(f.out, explicit)).toBe(explicit);
    rmSync(f.out, { recursive: true, force: true });
    const real = join(f.root, 'legacy');
    f.page(real, 'legacy');
    cpSync(real, f.out, { recursive: true });
    await expect(publishStaticGeneration(f.source, f.root)).rejects.toThrow(/service.*stop|stop.*service/i);
    expect(readFileSync(join(f.out, 'index.html'), 'utf8')).toContain('legacy');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('export-check consumer validates the active generation selected through out', async () => {
  const f = await fixture();
  try {
    const active = pinStaticGeneration(f.out);
    expect(await checkStaticExport(f.root)).toBe(active);
    f.page(f.source, 'B');
    await publishStaticGeneration(f.source, f.root);
    expect(await checkStaticExport(f.root)).toBe(pinStaticGeneration(f.out));
    expect(await checkStaticExport(f.root)).not.toBe(active);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

