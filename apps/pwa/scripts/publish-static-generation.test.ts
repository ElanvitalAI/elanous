import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { publishStaticGeneration } from './publish-static-generation';
import { resolveNextBuildBin } from './static-generation';

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'pwa-static-generation-'));
  roots.push(root);
  const source = path.join(root, 'source');
  const publishRoot = path.join(root, 'publish');
  await mkdir(path.join(source, '_next'), { recursive: true });
  await writeFile(path.join(source, 'index.html'), '<html>new</html>');
  await writeFile(path.join(source, '_next', 'asset.js'), 'new-asset');
  await mkdir(publishRoot, { recursive: true });
  return { root, source, publishRoot, out: path.join(publishRoot, 'out') };
}

async function installOld(out: string) {
  const old = path.join(path.dirname(out), '.pwa-generations', 'old');
  await mkdir(path.join(old, '_next'), { recursive: true });
  await writeFile(path.join(old, 'index.html'), '<html>old</html>');
  await writeFile(path.join(old, '_next', 'asset.js'), 'old-asset');
  await symlink(path.relative(path.dirname(out), old), out, 'dir');
  return old;
}

async function expectOld(out: string, old: string) {
  expect(await readlink(out)).toBe(path.relative(path.dirname(out), old));
  expect(await readFile(path.join(out, 'index.html'), 'utf8')).toBe('<html>old</html>');
  expect(await readFile(path.join(out, '_next', 'asset.js'), 'utf8')).toBe('old-asset');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('publishStaticGeneration', () => {
  test('resolves Next from a hoisted workspace root when the app has no local node_modules', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pwa-hoisted-next-'));
    roots.push(root);
    const appDir = path.join(root, 'apps', 'pwa');
    const nextBin = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
    await mkdir(appDir, { recursive: true });
    await mkdir(path.dirname(nextBin), { recursive: true });
    await writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: '@test/pwa' }));
    await writeFile(path.join(root, 'node_modules', 'next', 'package.json'), JSON.stringify({ name: 'next' }));
    await writeFile(nextBin, '#!/usr/bin/env node\n');

    expect(resolveNextBuildBin(appDir)).toBe(await realpath(nextBin));
  });

  test('supports the first publish when out does not exist', async () => {
    const { source, publishRoot, out } = await fixture();

    const generation = await publishStaticGeneration(source, publishRoot);

    expect(await readlink(out)).toBe(path.relative(path.dirname(out), generation));
    expect(await readFile(path.join(out, 'index.html'), 'utf8')).toBe('<html>new</html>');
  });

  test('publishes a complete new generation and keeps the old generation readable', async () => {
    const { source, publishRoot, out } = await fixture();
    const old = await installOld(out);

    const result = await publishStaticGeneration(source, publishRoot);

    expect(result).toBe(path.resolve(publishRoot, '.pwa-generations', path.basename(result)));
    expect(await readlink(out)).toBe(path.relative(path.dirname(out), result));
    expect(await readFile(path.join(out, 'index.html'), 'utf8')).toBe('<html>new</html>');
    expect(await readFile(path.join(out, '_next', 'asset.js'), 'utf8')).toBe('new-asset');
    expect(await readFile(path.join(old, 'index.html'), 'utf8')).toBe('<html>old</html>');
    expect(await readFile(path.join(old, '_next', 'asset.js'), 'utf8')).toBe('old-asset');
  });

  test('published generations remain readable after source and symlink target are removed', async () => {
    const { root, source, publishRoot, out } = await fixture();
    const externalAssets = path.join(root, 'external-assets');
    await rm(path.join(source, '_next'), { recursive: true, force: true });
    await mkdir(externalAssets, { recursive: true });
    await writeFile(path.join(externalAssets, 'asset.js'), 'linked-asset');
    await symlink(externalAssets, path.join(source, '_next'), 'dir');

    const first = await publishStaticGeneration(source, publishRoot);
    await writeFile(path.join(source, 'index.html'), '<html>second</html>');
    const second = await publishStaticGeneration(source, publishRoot);

    await rm(source, { recursive: true, force: true });
    await rm(externalAssets, { recursive: true, force: true });

    expect(await readFile(path.join(out, 'index.html'), 'utf8')).toBe('<html>second</html>');
    expect(await readFile(path.join(out, '_next', 'asset.js'), 'utf8')).toBe('linked-asset');
    expect(await readFile(path.join(first, 'index.html'), 'utf8')).toBe('<html>new</html>');
    expect(await readFile(path.join(first, '_next', 'asset.js'), 'utf8')).toBe('linked-asset');
    expect(await readFile(path.join(second, 'index.html'), 'utf8')).toBe('<html>second</html>');
    expect(await readFile(path.join(second, '_next', 'asset.js'), 'utf8')).toBe('linked-asset');
  });

  test('copy failure leaves the active generation untouched', async () => {
    const { source, publishRoot, out } = await fixture();
    const old = await installOld(out);

    await expect(publishStaticGeneration(source, publishRoot, {
      copyDirectory: async () => { throw new Error('injected copy failure'); },
    })).rejects.toThrow('injected copy failure');

    await expectOld(out, old);
  });

  test('validation failure leaves the active generation untouched', async () => {
    const { source, publishRoot, out } = await fixture();
    const old = await installOld(out);

    await expect(publishStaticGeneration(source, publishRoot, {
      validateGeneration: async () => { throw new Error('injected validation failure'); },
    })).rejects.toThrow('injected validation failure');

    await expectOld(out, old);
  });

  test('rename failure leaves the active generation untouched', async () => {
    const { source, publishRoot, out } = await fixture();
    const old = await installOld(out);

    await expect(publishStaticGeneration(source, publishRoot, {
      renamePointer: async () => { throw new Error('injected rename failure'); },
    })).rejects.toThrow('injected rename failure');

    await expectOld(out, old);
  });

  test('rejects a broken out symlink without replacing it', async () => {
    const { source, publishRoot, out } = await fixture();
    await symlink('missing-generation', out, 'dir');

    await expect(publishStaticGeneration(source, publishRoot)).rejects.toThrow('broken symlink');
    expect(await readlink(out)).toBe('missing-generation');
  });

  test('rejects a real out directory without changing it', async () => {
    const { source, publishRoot, out } = await fixture();
    await mkdir(out);
    await writeFile(path.join(out, 'index.html'), '<html>legacy</html>');

    await expect(publishStaticGeneration(source, publishRoot)).rejects.toThrow(/service.*stop|stop.*service/i);
    expect(await readFile(path.join(out, 'index.html'), 'utf8')).toBe('<html>legacy</html>');
  });

  for (const [stage, code, expected] of [
    ['before-swap', 71, '<html>old</html>'],
    ['after-swap', 72, '<html>new</html>'],
  ] as const) {
    test(`process exit at ${stage} leaves a valid active generation`, async () => {
      const { source, publishRoot, out } = await fixture();
      const old = await installOld(out);
      const modulePath = path.resolve(import.meta.dir, 'publish-static-generation.ts');
      const script = `import { publishStaticGeneration } from ${JSON.stringify(modulePath)}; await publishStaticGeneration(${JSON.stringify(source)}, ${JSON.stringify(publishRoot)}, { onStage(stage) { if (stage === ${JSON.stringify(stage)}) process.exit(${code}); } });`;
      const child = spawnSync('bun', ['-e', script], { encoding: 'utf8' });

      expect(child.status).toBe(code);
      expect(await readFile(path.join(out, 'index.html'), 'utf8')).toBe(expected);
      expect(await readFile(path.join(out, '_next', 'asset.js'), 'utf8')).toBe(expected.includes('old') ? 'old-asset' : 'new-asset');
      expect(await readFile(path.join(old, 'index.html'), 'utf8')).toBe('<html>old</html>');
    });
  }
});
