import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dir, 'uninstall.sh');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const START = '# >>> elanous installer PATH >>>';
const END = '# <<< elanous installer PATH <<<';

function fixture(withInstallJson = true) {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-uninstall-'));
  dirs.push(dir);
  const home = join(dir, 'home');
  const prefix = join(dir, 'prefix');
  mkdirSync(join(prefix, 'versions', '0.1.0', 'node_modules'), { recursive: true });
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  mkdirSync(join(home, '.elanous'), { recursive: true });
  if (withInstallJson) writeFileSync(join(prefix, 'install.json'), '{"version":"0.1.0"}\n');
  const block = `\n${START}\nexport PATH='${prefix}/bin':"$PATH"\n${END}\n`;
  writeFileSync(join(home, '.zshrc'), `export KEEP=1${block}alias ll='ls -l'\n`);
  writeFileSync(join(home, '.profile'), `umask 022${block}`);
  return { dir, home, prefix };
}

function run(env: { home: string; prefix: string }, args: string[] = []) {
  return spawnSync('/bin/bash', [script, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: env.home, ELANOUS_INSTALL_PREFIX: env.prefix },
  });
}

describe('scripts/uninstall.sh', () => {
  test('removes the install root and every PATH block, keeps other startup lines and the ~/.elanous state', () => {
    const f = fixture();
    const r = run(f);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(f.prefix)).toBe(false);
    const zshrc = readFileSync(join(f.home, '.zshrc'), 'utf8');
    expect(zshrc).not.toContain(START);
    expect(zshrc).toContain('export KEEP=1');
    expect(zshrc).toContain("alias ll='ls -l'");
    expect(readFileSync(join(f.home, '.profile'), 'utf8')).not.toContain(START);
    expect(existsSync(join(f.home, '.elanous'))).toBe(true);
    expect(r.stdout).toContain('kept state:');
  });

  // 🩸 09-25 — 기억 저장소 기본 위치가 설치 폴더 안(~/.local/share/elanous/memory)이라 통째로 지우면 기억이 사라졌다.
  test('removes bin/elanous whether it is the old symlink or the installed sh wrapper, without deleting memory', () => {
    for (const kind of ['symlink', 'wrapper']) {
      const f = fixture();
      const elanous = join(f.prefix, 'bin', 'elanous');
      mkdirSync(join(f.prefix, 'memory'));
      writeFileSync(join(f.prefix, 'memory', 'MEMORY.md'), 'keep\n');
      if (kind === 'symlink') symlinkSync('../current/node_modules/.bin/elanous', elanous);
      else writeFileSync(elanous, '#!/bin/sh\nexit 0\n');
      const removed = run(f);
      expect(removed.status, removed.stderr).toBe(0);
      expect(existsSync(elanous)).toBe(false);
      expect(existsSync(join(f.prefix, 'bin'))).toBe(false);
      expect(readFileSync(join(f.prefix, 'memory', 'MEMORY.md'), 'utf8')).toBe('keep\n');
    }
  });

  test('removes only a marked eln wrapper and preserves a foreign eln', () => {
    for (const owned of [true, false]) {
      const f = fixture();
      const eln = join(f.prefix, 'bin', 'eln');
      const body = owned ? '#!/bin/sh\n# elanous-wrapper\nexit 0\n' : '#!/bin/sh\necho other\n';
      writeFileSync(eln, body);
      const removed = run(f);
      expect(removed.status, removed.stderr).toBe(0);
      expect(existsSync(eln)).toBe(!owned);
      if (!owned) expect(readFileSync(eln, 'utf8')).toBe(body);
    }
  });

  test('keeps what is not part of the installation (memory/) and says so; removes only the four install items', () => {
    const f = fixture();
    mkdirSync(join(f.prefix, 'memory'), { recursive: true });
    writeFileSync(join(f.prefix, 'memory', 'MEMORY.md'), '- [probe](x.md)\n');
    const r = run(f);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(f.prefix, 'memory', 'MEMORY.md'), 'utf8')).toContain('probe');
    for (const item of ['versions', 'current', 'bin', 'install.json']) expect(existsSync(join(f.prefix, item))).toBe(false);
    expect(r.stdout).toContain('kept in');
    expect(r.stdout).toContain('memory');
  });

  test('--dry-run and --keep-path change nothing they should not', () => {
    const f = fixture();
    const dry = run(f, ['--dry-run']);
    expect(dry.status).toBe(0);
    expect(existsSync(f.prefix)).toBe(true);
    expect(readFileSync(join(f.home, '.zshrc'), 'utf8')).toContain(START);
    const keep = run(f, ['--keep-path']);
    expect(keep.status).toBe(0);
    expect(existsSync(f.prefix)).toBe(false);
    expect(readFileSync(join(f.home, '.zshrc'), 'utf8')).toContain(START);
  });

  test('refuses a folder without install.json and refuses the state folder itself — nothing removed', () => {
    const f = fixture(false);
    const r = run(f);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no install.json');
    expect(existsSync(f.prefix)).toBe(true);
    const state = run({ home: f.home, prefix: join(f.home, '.elanous') });
    expect(state.status).toBe(2);
    expect(existsSync(join(f.home, '.elanous'))).toBe(true);
  });
});
