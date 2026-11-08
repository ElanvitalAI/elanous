import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateStaticGeneration } from './publish-static-generation';

export function resolveStaticGeneration(options: { outDir: string; explicitDir?: string }): string {
  const explicit = options.explicitDir?.trim();
  return explicit ? resolve(explicit) : realpathSync(resolve(options.outDir));
}

export function pinStaticGeneration(outDir: string, explicitDir = process.env.ELANOUS_PWA_STATIC_DIR): string {
  return resolveStaticGeneration({ outDir, explicitDir });
}

export async function checkStaticExport(appDir = resolve(import.meta.dir, '..')): Promise<string> {
  const generation = pinStaticGeneration(join(appDir, 'out'));
  await validateStaticGeneration(generation);
  return generation;
}

export async function packagePinnedGeneration(appDir = resolve(import.meta.dir, '..'), beforePack?: () => void | Promise<void>): Promise<string> {
  const outDir = join(appDir, 'out');
  const generation = pinStaticGeneration(outDir);
  await validateStaticGeneration(generation);
  const temp = mkdtempSync(join(tmpdir(), 'elanous-pwa-pack-'));
  try {
    const packageJson = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    packageJson.files = ['out'];
    writeFileSync(join(temp, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
    cpSync(generation, join(temp, 'out'), { recursive: true });
    await beforePack?.();
    const packed = spawnSync('bun', ['pm', 'pack', '--destination', temp], { cwd: temp, encoding: 'utf8' });
    if (packed.status !== 0) throw new Error(`bun pm pack failed: ${packed.error?.message ?? packed.stderr?.trim() ?? `exit ${packed.status}`}`);
    const filename = readdirSync(temp).find((entry) => entry.endsWith('.tgz'));
    if (!filename) throw new Error('bun pm pack returned no tarball');
    return join(temp, filename);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const command = process.argv[2];
  const appDir = resolve(import.meta.dir, '..');
  if (command === 'check') {
    await checkStaticExport(appDir);
    console.log('PWA static export valid');
  } else if (command === 'pack') {
    const tarball = await packagePinnedGeneration(appDir);
    console.log(`PWA static package created: ${tarball}`);
  } else throw new Error('usage: static-entry.ts check|pack');
}
