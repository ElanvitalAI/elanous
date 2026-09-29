import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { packDirDeterministic } from './tgz';

function fixture(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'market-tgz-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function entries(archive: Uint8Array) {
  const tar = gunzipSync(archive);
  const result: Array<{ name: string; mode: number; uid: number; gid: number; mtime: number; type: string; data: string }> = [];
  const value = (part: Buffer) => part.toString('utf8').replace(/\0.*$/, '');
  const octal = (part: Buffer) => parseInt(value(part).trim(), 8);
  let offset = 0;
  while (tar.subarray(offset, offset + 512).some(byte => byte !== 0)) {
    const h = tar.subarray(offset, offset + 512);
    expect(h.subarray(257, 263).toString()).toBe('ustar\0');
    const size = octal(h.subarray(124, 136));
    const prefix = value(h.subarray(345, 500));
    const name = value(h.subarray(0, 100));
    result.push({ name: prefix ? `${prefix}/${name}` : name, mode: octal(h.subarray(100, 108)),
      uid: octal(h.subarray(108, 116)), gid: octal(h.subarray(116, 124)), mtime: octal(h.subarray(136, 148)),
      type: value(h.subarray(156, 157)), data: tar.subarray(offset + 512, offset + 512 + size).toString() });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  expect(tar.subarray(offset).every(byte => byte === 0)).toBe(true);
  return result;
}

describe('packDirDeterministic', () => {
  test('packs sorted files only with normalized headers and reads with system tar', () => fixture(dir => {
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'z'), 'last');
    writeFileSync(join(dir, 'nested', 'run'), 'run');
    chmodSync(join(dir, 'nested', 'run'), 0o751);
    writeFileSync(join(dir, 'A'), 'first');
    const archive = packDirDeterministic(dir);
    expect(entries(archive)).toEqual([
      { name: 'A', mode: 0o644, uid: 0, gid: 0, mtime: 0, type: '0', data: 'first' },
      { name: 'nested/run', mode: 0o755, uid: 0, gid: 0, mtime: 0, type: '0', data: 'run' },
      { name: 'z', mode: 0o644, uid: 0, gid: 0, mtime: 0, type: '0', data: 'last' },
    ]);
    expect(Buffer.from(archive).readUInt32LE(4)).toBe(0);
    const tar = spawnSync('tar', ['-tzf', '-'], { input: archive, encoding: 'utf8' });
    expect(tar.status).toBe(0);
    expect(tar.stdout.trim().split('\n')).toEqual(['A', 'nested/run', 'z']);
  }));

  test('same bytes after mtime change, different sha after content change', () => fixture(dir => {
    writeFileSync(join(dir, 'a'), 'a');
    const before = packDirDeterministic(dir);
    expect(packDirDeterministic(dir)).toEqual(before);
    utimesSync(join(dir, 'a'), new Date('2001-01-01'), new Date('2030-01-01'));
    expect(packDirDeterministic(dir)).toEqual(before);
    writeFileSync(join(dir, 'a'), 'b');
    expect(createHash('sha256').update(packDirDeterministic(dir)).digest('hex'))
      .not.toBe(createHash('sha256').update(before).digest('hex'));
  }));

  test('excludes .git, node_modules, .DS_Store and custom exclusion', () => fixture(dir => {
    mkdirSync(join(dir, '.git'));
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, '.git', 'config'), 'secret');
    writeFileSync(join(dir, 'node_modules', 'dep'), 'dep');
    writeFileSync(join(dir, '.DS_Store'), 'metadata');
    writeFileSync(join(dir, 'keep'), 'keep');
    writeFileSync(join(dir, 'omit'), 'omit');
    expect(entries(packDirDeterministic(dir)).map(e => e.name)).toEqual(['keep', 'omit']);
    expect(entries(packDirDeterministic(dir, { exclude: /omit/g })).map(e => e.name)).toEqual(['keep']);
  }));

  test('bundles external directories deterministically, excluding .env files and conflicting paths', () => fixture(dir => {
    const pack = join(dir, 'pack');
    const skill = join(dir, 'source');
    mkdirSync(pack);
    mkdirSync(skill);
    writeFileSync(join(pack, 'plugin.json'), '{}');
    writeFileSync(join(pack, '.env'), 'secret');
    writeFileSync(join(pack, '.environment'), 'secret');
    writeFileSync(join(skill, '.env.local'), 'secret');
    writeFileSync(join(skill, 'skill.md'), 'lowercase');
    const second = join(dir, 'second');
    mkdirSync(second);
    writeFileSync(join(second, 'SKILL.md'), 'second');
    const opts = { extraDirs: [{ from: second, as: 'skills/zeta' }, { from: skill, as: 'skills/demo' }] };
    const first = packDirDeterministic(pack, opts);
    expect(packDirDeterministic(pack, opts)).toEqual(first);
    expect(entries(first).map(entry => entry.name)).toEqual(['plugin.json', 'skills/demo/SKILL.md', 'skills/zeta/SKILL.md']);
    expect(entries(first)[1]?.data).toBe('lowercase');
    expect(entries(first)[2]?.data).toBe('second');
    mkdirSync(join(pack, 'skills', 'demo'), { recursive: true });
    expect(() => packDirDeterministic(pack, opts)).toThrow('bundle-conflict');
  }));

  test('rejects symlinks and unrepresentable ustar paths', () => fixture(dir => {
    symlinkSync(dir, join(dir, 'link'));
    expect(() => packDirDeterministic(dir)).toThrow('symbolic link');
    rmSync(join(dir, 'link'));
    writeFileSync(join(dir, 'x'.repeat(101)), 'x');
    expect(() => packDirDeterministic(dir)).toThrow('ustar limits');
  }));
});
