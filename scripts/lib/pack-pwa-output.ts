import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** Bun omits symlinks. Materialize the active generation only in a private archive. */
export function packPwaOutput(root: string, archive: string): void {
  const pwa = realpathSync(join(root, 'apps/pwa'));
  if (!existsSync(join(pwa, 'out'))) throw new Error('PWA build missing: apps/pwa/out/index.html');
  const source = realpathSync(join(pwa, 'out'));
  const inside = relative(pwa, source);
  if (inside === '..' || inside.startsWith('..' + sep) || inside.startsWith(sep)) throw new Error('PWA output escapes package');
  if (!existsSync(join(source, 'index.html')) || !lstatSync(join(source, 'index.html')).isFile()) throw new Error('PWA build missing: apps/pwa/out/index.html');
  const assertRegularTree = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('PWA output contains a non-regular entry');
    if (stat.isDirectory()) for (const entry of readdirSync(path)) assertRegularTree(join(path, entry));
  };
  assertRegularTree(source);
  const staging = mkdtempSync(join(dirname(archive), '.pwa-pack-'));
  const run = (args: string[]): void => {
    // macOS bsdtar writes AppleDouble `._*` members for xattrs unless COPYFILE_DISABLE is set; GNU tar ignores it.
    const result = spawnSync('tar', args, { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } });
    if (result.status !== 0) throw new Error('PWA archive operation failed: ' + result.stderr);
  };
  try {
    run(['-xzf', archive, '-C', staging]);
    const target = join(staging, 'package/apps/pwa/out');
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
    rmSync(join(staging, 'package/apps/pwa/.pwa-generations'), { recursive: true, force: true });
    // Repacking the same commit must retain the same checksum despite temporary directory times.
    const normalizeTimes = (path: string): void => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) for (const entry of readdirSync(path)) normalizeTimes(join(path, entry));
      utimesSync(path, 0, 0);
    };
    normalizeTimes(join(staging, 'package'));
    const packed = join(staging, 'packed.tgz');
    run(['-czf', packed, '-C', staging, 'package']);
    renameSync(packed, archive);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
