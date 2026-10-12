import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveInstance } from './resolve.js';

const prodRoot = '/tmp/elanous-prod';
const sourceRoot = '/tmp/elanous-source/.elanous-test';

describe('leader-independent universe selection', () => {
  test('explicit roots outrank stamps, installed execution and source trees', () => {
    expect(resolveInstance({ explicitFlagRoot: prodRoot, stampedStateDir: sourceRoot, installedCopy: false, treeTestRoot: sourceRoot, prodRoot })).toMatchObject({ kind: 'prod', root: prodRoot, layer: 'explicit-flag' });
    expect(resolveInstance({ explicitFlagRoot: sourceRoot, installedCopy: true, prodRoot })).toMatchObject({ kind: 'test', layer: 'explicit-flag' });
    expect(resolveInstance({ stampedStateDir: prodRoot, installedCopy: false, treeTestRoot: sourceRoot, prodRoot })).toMatchObject({ kind: 'prod', layer: 'parent-stamp' });
    expect(resolveInstance({ stampedStateDir: sourceRoot, installedCopy: true, prodRoot })).toMatchObject({ kind: 'test', layer: 'parent-stamp' });
  });

  test('installed and source CLI select the operating house without an explicit test root', () => {
    expect(resolveInstance({ installedCopy: true, treeTestRoot: sourceRoot, prodRoot })).toMatchObject({ kind: 'prod', root: prodRoot, layer: 'installed' });
    expect(resolveInstance({ installedCopy: false, axes: { selfInstalled: true }, treeTestRoot: sourceRoot, prodRoot })).toMatchObject({ kind: 'prod', root: prodRoot, layer: 'default' });
    for (const depth of [0, 2]) {
      expect(resolveInstance({ installedCopy: false, treeTestRoot: sourceRoot, prodRoot, depth })).toMatchObject({ kind: 'prod', root: prodRoot, layer: 'default' });
    }
  });

  test('actual tree CLI uses operating house by default and isolates only with --test', () => {
    const temp = realpathSync(mkdtempSync(join(tmpdir(), 'elanous-where-')));
    try {
      mkdirSync(join(temp, '.git'));
      const home = join(temp, 'home');
      mkdirSync(join(home, '.elanous'), { recursive: true });
      const sentinel = join(home, '.elanous', 'sentinel');
      writeFileSync(sentinel, 'operating-house-unchanged');
      for (const leader of [true, false]) {
        if (leader) writeFileSync(join(home, '.elanous', 'leader.json'), JSON.stringify({ tree: temp }));
        else rmSync(join(home, '.elanous', 'leader.json'), { force: true });
        for (const testFlag of [false, true]) {
          const run = spawnSync('bun', [join(process.cwd(), 'bin/elanous.mjs'), ...(testFlag ? ['--test'] : []), 'where', '--json'], {
            cwd: temp, encoding: 'utf8', timeout: 90_000,
            env: { ...process.env, HOME: home, BUN_INSTALL_CACHE_DIR: join(homedir(), '.bun', 'install', 'cache'), ELANOUS_STATE_DIR: '', ELANOUS_CONFIG_DIR: '', ELANOUS_TEST_STATE_DIR: '' },
          });
          expect(run.status, run.stderr).toBe(0);
          const output = JSON.parse(run.stdout.slice(run.stdout.indexOf('{'))) as Record<string, unknown>;
          expect(output.kind).toBe(testFlag ? 'test' : 'prod');
          expect(output.root).toBe(testFlag ? join(temp, '.elanous-test') : join(home, '.elanous'));
          expect(output.layer).toBe(testFlag ? 'explicit-flag' : 'default');
          expect(output.mismatch).toBeNull();
          expect(output).not.toHaveProperty('authority');
          expect(output).not.toHaveProperty('isLeader');
        }
      }
      expect(readFileSync(sentinel, 'utf8')).toBe('operating-house-unchanged');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }, 180_000);

  test('tree bun test writes through its preload scope without touching the operating house', () => {
    const temp = realpathSync(mkdtempSync(join(tmpdir(), 'elanous-bun-test-house-')));
    const home = join(temp, 'home');
    const operating = join(home, '.elanous');
    const sentinel = join(operating, 'sentinel');
    const fixture = join(temp, 'house-scope.test.ts');
    try {
      mkdirSync(operating, { recursive: true });
      writeFileSync(sentinel, 'operating-house-unchanged');
      writeFileSync(fixture, `
        import { expect, test } from 'bun:test';
        import { writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        import { effectiveInstanceRoot } from ${JSON.stringify(join(process.cwd(), 'src/instance/resolve.ts'))};
        test('preload scope', () => {
          const root = effectiveInstanceRoot();
          expect(root).not.toBe(join(process.env.HOME!, '.elanous'));
          writeFileSync(join(root, 'probe'), 'isolated');
        });
      `);
      const run = spawnSync('bun', ['test', fixture], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 90_000,
        env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: '', ELANOUS_CONFIG_DIR: '' },
      });
      expect(run.status, run.stderr).toBe(0);
      expect(readFileSync(sentinel, 'utf8')).toBe('operating-house-unchanged');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }, 120_000);
});
