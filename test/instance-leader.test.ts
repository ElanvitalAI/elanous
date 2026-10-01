import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedCopyRoot, isInstalledCopyScript, resolveSelfTree, treeFromScriptPath } from '../src/instance/leader.js';
import { resolveInstance } from '../src/instance/resolve.js';
import { registerLeaderCommands } from '../src/cli/leader-cli.js';

describe('execution origin without leader authority', () => {
  test('installed build operates and source checkout isolates even if cwd differs', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'elanous-installed-')));
    try {
      const script = join(dir, 'versions/1.0.0/node_modules/elanous/bin/elanous.mjs');
      mkdirSync(join(script, '..'), { recursive: true });
      writeFileSync(script, '');
      expect(isInstalledCopyScript(script)).toBe(true);
      expect(installedCopyRoot(script)).toBe(join(dir, 'versions/1.0.0/node_modules/elanous'));
      expect(resolveInstance({ installedCopy: isInstalledCopyScript(script), treeTestRoot: join(dir, 'checkout/.elanous-test') }).kind).toBe('prod');
      const checkout = join(dir, 'checkout');
      mkdirSync(join(checkout, '.git'), { recursive: true });
      const sourceScript = join(checkout, 'node_modules/elanous/bin/elanous.mjs');
      mkdirSync(join(sourceScript, '..'), { recursive: true });
      writeFileSync(sourceScript, '');
      expect(treeFromScriptPath(sourceScript)).toBe(checkout);
      expect(resolveSelfTree(sourceScript, dir)).toBe(checkout);
      expect(isInstalledCopyScript(sourceScript)).toBe(false);
      expect(resolveInstance({ installedCopy: isInstalledCopyScript(sourceScript), treeTestRoot: join(checkout, '.elanous-test') }).kind).toBe('test');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a global install inside a git-tracked prefix (Homebrew, dotfiles home) is still the installed copy', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'elanous-git-prefix-')));
    try {
      mkdirSync(join(dir, '.git'), { recursive: true });
      for (const rel of ['lib/node_modules/elanous/bin/elanous.mjs', '.bun/install/global/node_modules/elanous/bin/elanous.mjs', 'pnpm/global/5/node_modules/elanous/bin/elanous.mjs']) {
        const script = join(dir, rel);
        mkdirSync(join(script, '..'), { recursive: true });
        writeFileSync(script, '');
        expect(treeFromScriptPath(script)).toBeNull();
        expect(isInstalledCopyScript(script)).toBe(true);
        expect(resolveInstance({ installedCopy: isInstalledCopyScript(script), treeTestRoot: join(dir, '.elanous-test') }).kind).toBe('prod');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('retired status and claim cannot select or materialize a leader tree', () => {
    const messages: string[] = [];
    const errors: string[] = [];
    const program = new Command();
    registerLeaderCommands(program, { out: { log: (s) => messages.push(s), error: (s) => errors.push(s) } });
    program.parse(['node', 'elanous', 'leader', 'status', '--json']);
    expect(JSON.parse(messages[0]!).retired).toBe(true);
    expect(messages[0]).not.toContain('leader.json');
    program.parse(['node', 'elanous', 'leader', 'claim', '--yes']);
    expect(errors[0]).toContain('리더 트리 지정은 폐기되었습니다');
  });
});
