import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDriveInputJail, withDriveJail } from './drive-input-jail.js';

describe('checkDriveInputJail', () => {
  const jail = '/workspace/feature';
  const home = '/home/operator';

  test('rejects absolute paths outside the jail including prefix siblings and traversal', () => {
    for (const path of ['/workspace/other/file.ts', '/workspace/feature-other/file.ts', '/workspace/feature/../other/file.ts']) {
      expect(checkDriveInputJail(`cat ${path}`, jail, home)).toEqual({ allowed: false, reason: 'outside-jail', path });
    }
  });

  test('rejects tilde-expanded paths outside the jail and global nvm/brew tool paths', () => {
    for (const path of ['~/.nvm/versions/node/v22/bin/node', '/home/operator/.nvm/versions/node/v22/bin/node', '/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
      expect(checkDriveInputJail(`run ${path}`, jail, home)).toEqual({ allowed: false, reason: 'outside-jail', path });
    }
    expect(checkDriveInputJail('PATH=/workspace/feature/bin:/opt/homebrew/bin', jail, home))
      .toEqual({ allowed: false, reason: 'outside-jail', path: '/opt/homebrew/bin' });
    expect(checkDriveInputJail('PATH="/workspace/feature/bin:/opt/homebrew/bin"', jail, home))
      .toEqual({ allowed: false, reason: 'outside-jail', path: '/opt/homebrew/bin' });
    expect(checkDriveInputJail('PATH="/workspace/feature/bin:/workspace/feature/tools"', jail, home))
      .toEqual({ allowed: true });
    expect(checkDriveInputJail('brew --prefix=/opt/homebrew', jail, home).allowed).toBe(false);
  });

  test('checks absolute redirect targets even without whitespace and permits inside targets', () => {
    for (const [input, path] of [
      ['cat </etc/passwd', '/etc/passwd'],
      ['echo x >/etc/passwd', '/etc/passwd'],
    ]) expect(checkDriveInputJail(input, jail, home)).toEqual({ allowed: false, reason: 'outside-jail', path });
    for (const input of ['cat </workspace/feature/input', 'echo x >/workspace/feature/output']) {
      expect(checkDriveInputJail(input, jail, home)).toEqual({ allowed: true });
    }
  });

  test('checks paths after adjacent shell pipe and ampersand operators', () => {
    for (const operator of ['|', '||', '&', '&&']) {
      const input = `true${operator}/usr/bin/id`;
      expect(checkDriveInputJail(input, jail, home)).toEqual({ allowed: false, reason: 'outside-jail', path: '/usr/bin/id' });
      expect(checkDriveInputJail(`true${operator}/workspace/feature/bin/id`, jail, home)).toEqual({ allowed: true });
    }
  });

  test('checks a standalone tilde against the jail, including quoted and operator-adjacent forms', () => {
    for (const input of ['cat ~', 'cat "~"', 'true&&~']) {
      expect(checkDriveInputJail(input, jail, home)).toEqual({ allowed: false, reason: 'outside-jail', path: '~' });
      expect(checkDriveInputJail(input, '/home/operator', home)).toEqual({ allowed: true });
    }
    expect(checkDriveInputJail('echo ~other', jail, home)).toEqual({ allowed: true });
  });

  test('allows paths inside the jail and text without paths without modifying input', () => {
    for (const input of [
      'echo hello',
      'bun test src/cli/drive-input-jail.test.ts',
      'cat /workspace/feature',
      'cat /workspace/feature/src/main.ts',
      'cat "/workspace/feature/path with spaces/file.ts"',
      'read https://example.com/docs',
    ]) expect(checkDriveInputJail(input, jail, home)).toEqual({ allowed: true });
    expect(checkDriveInputJail('cat ~/src/main.ts', '/home/operator', home)).toEqual({ allowed: true });
  });

  test('checks paths inside command substitution in a double-quoted path (TC review round 3)', () => {
    expect(checkDriveInputJail('cat "/workspace/feature/$(cat /etc/passwd)"', jail, home))
      .toEqual({ allowed: false, reason: 'outside-jail', path: '/etc/passwd' });
    expect(checkDriveInputJail('cat "/workspace/feature/`cat /etc/hosts`"', jail, home).allowed).toBe(false);
    expect(checkDriveInputJail("cat '/workspace/feature/$(cat /etc/passwd)'", jail, home)).toEqual({ allowed: true });
    expect(checkDriveInputJail('cat "/workspace/feature/$(ls /workspace/feature/src)"', jail, home)).toEqual({ allowed: true });
  });

  test('checks quoted absolute paths with spaces as a single path', () => {
    expect(checkDriveInputJail('cat "/outside/path with spaces/file.ts"', jail, home))
      .toEqual({ allowed: false, reason: 'outside-jail', path: '/outside/path with spaces/file.ts' });
    expect(checkDriveInputJail('cat "see /outside/file.ts"', jail, home).allowed).toBe(false);
  });

  test('rejects symlink escapes even when the literal has the jail prefix', () => {
    const root = mkdtempSync(join(tmpdir(), 'drive-input-jail-'));
    try {
      const boundary = join(root, 'jail');
      const outside = join(root, 'outside');
      mkdirSync(boundary);
      mkdirSync(outside);
      mkdirSync(join(outside, 'subdir'));
      symlinkSync(join(outside, 'subdir'), join(boundary, 'link'));
      const escaped = `${boundary}/link/../secret`;
      expect(checkDriveInputJail(`cat ${boundary}/link/file.ts`, boundary).allowed).toBe(false);
      expect(checkDriveInputJail(`cat ${escaped}`, boundary))
        .toEqual({ allowed: false, reason: 'outside-jail', path: escaped });
      expect(checkDriveInputJail('cat ~/link/../secret', boundary, boundary))
        .toEqual({ allowed: false, reason: 'outside-jail', path: '~/link/../secret' });
      expect(checkDriveInputJail('cat ~/inside.ts', boundary, boundary)).toEqual({ allowed: true });
      expect(checkDriveInputJail(`cat ${join(boundary, 'inside.ts')}`, boundary)).toEqual({ allowed: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('withDriveJail', () => {
  test('blocks an outside input without sending it and tells the brain on the next screen', async () => {
    const sent: string[] = [];
    const logged: unknown[] = [];
    const deps = withDriveJail({ inject: (t: string) => { sent.push(t); return true; }, observe: async () => 'screen' }, '/workspace/feature', (e, d) => logged.push([e, d]));
    expect(deps.inject('source ~/.nvm/nvm.sh')).toBe(true);
    expect(sent).toEqual([]);
    expect(String(await deps.observe())).toContain('input blocked');
    expect(String(await deps.observe())).toBe('screen');
    expect(deps.inject('ls /workspace/feature/src')).toBe(true);
    expect(sent).toEqual(['ls /workspace/feature/src']);
    expect(logged).toHaveLength(1);
  });

  test('no boundary → the same deps object, nothing blocked', () => {
    const raw = { inject: () => true, observe: async () => 's' };
    expect(withDriveJail(raw, undefined)).toBe(raw);
  });
});
