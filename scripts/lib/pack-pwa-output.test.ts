import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { packPwaOutput } from './pack-pwa-output.js';

// bsdtar `-t` hides AppleDouble members (it folds them back into xattrs), so read the raw tar headers.
function rawMemberNames(archive: string): string[] {
  const tar = gunzipSync(readFileSync(archive));
  const names: string[] = [];
  const field = (block: Buffer, start: number, length: number): string => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
  for (let offset = 0; offset + 512 <= tar.length;) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(block, 124, 12).trim() || '0', 8);
    const type = field(block, 156, 1);
    const prefix = field(block, 345, 155);
    if (type !== 'x' && type !== 'g') names.push(prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

// OP 0.3.29: v0.3.28 tgz carried 10,365 AppleDouble `._*` members from the macOS tar repack.
test('packPwaOutput repacks without AppleDouble members even when PWA files carry xattrs', () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-pwa-appledouble-'));
  try {
    const out = join(root, 'apps/pwa/out');
    mkdirSync(join(out, 'assets'), { recursive: true });
    writeFileSync(join(out, 'index.html'), '<!doctype html><title>pwa</title>\n');
    writeFileSync(join(out, 'assets/app.js'), 'console.log(1);\n');
    mkdirSync(join(root, 'pkg/package'), { recursive: true });
    writeFileSync(join(root, 'pkg/package/package.json'), '{"name":"elanous","version":"0.0.0"}\n');
    if (process.platform === 'darwin') {
      for (const file of ['index.html', 'assets/app.js']) {
        expect(spawnSync('xattr', ['-w', 'com.elanous.test', 'x', join(out, file)]).status).toBe(0);
      }
    }
    const archive = join(root, 'elanous.tgz');
    expect(spawnSync('tar', ['-czf', archive, '-C', join(root, 'pkg'), 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } }).status).toBe(0);
    packPwaOutput(root, archive);
    const entries = rawMemberNames(archive);
    expect(entries).toContain('package/apps/pwa/out/index.html');
    expect(entries).toContain('package/apps/pwa/out/assets/app.js');
    expect(entries.filter((entry) => entry.split('/').some((part) => part.startsWith('._')))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
