import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'add-api-key.sh');

// bash 3.2 (macOS /bin/bash) reads variable names byte by byte, so `$NAME»` makes the
// first byte of `»` part of the name and `set -u` dies with "NAME?: unbound variable".
// zsh is multibyte aware and is not affected by these punctuation marks.
const BASH_VAR_THEN_NON_ASCII = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/;

describe('scripts/add-api-key.sh step 3 guidance', () => {
  test('prints the AWS guidance without dying on the variable next to a non-ASCII byte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'add-api-key-'));
    try {
      const cfg = join(dir, 'cfg');
      mkdirSync(cfg, { recursive: true });
      writeFileSync(join(cfg, 'api-keys.zsh'), '');
      writeFileSync(join(dir, '.zshrc'), '');
      // A refresh script that does not mention the name yet is what reaches step 3.
      writeFileSync(join(cfg, 'refresh_api_key_cache.sh'), '#!/bin/bash\n');
      const r = spawnSync('/bin/bash', [SCRIPT, 'ZZ_DUMMY_TEST_KEY'], {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: dir,
          ZDOTDIR: dir,
          LANG: 'en_US.UTF-8',
          ELANOUS_KEY_CACHE_DIR: join(dir, 'cache'),
          ELANOUS_KEY_LOADER: join(cfg, 'api-keys.zsh'),
          ELANOUS_KEY_VALUE: 'dummy-not-a-real-key',
        },
      });
      const out = `${r.stdout}${r.stderr}`;
      expect(out).not.toContain('unbound variable');
      expect(r.status).toBe(0);
      expect(out).toContain('비밀 «ZZ_DUMMY_TEST_KEY» 을 만들고');
      expect(out).toContain('fetch_secret "ZZ_DUMMY_TEST_KEY"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});

describe('bash scripts under scripts/ do not put a non-ASCII byte right after $VAR', () => {
  test('every bash-shebang script (.sh or extensionless) uses ${VAR} before non-ASCII text on code lines', () => {
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const p = join(d, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!name.endsWith('.sh') && name.includes('.')) continue;
        const text = readFileSync(p, 'utf8');
        const first = text.split('\n', 1)[0] ?? '';
        if (!/^#!.*\bbash\b/.test(first)) continue;
        text.split('\n').forEach((line, i) => {
          if (/^\s*#/.test(line)) return;
          if (BASH_VAR_THEN_NON_ASCII.test(line)) offenders.push(`${relative(ROOT, p)}:${i + 1}`);
        });
      }
    };
    walk(join(ROOT, 'scripts'));
    expect(offenders).toEqual([]);
  });
});
