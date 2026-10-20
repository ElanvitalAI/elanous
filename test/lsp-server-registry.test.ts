// ── Phase L4 · LSP server registry tests ──
//
// Focused coverage for src/skills/tools/lsp/server-registry.ts —
// language detection by file extension, disabled-language handling,
// probe cache reset. Doesn't spawn any real servers.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetUserConfig, reloadUserConfig } from '../src/user-config';
import { setElanousConfigDir, resetElanousConfigDir } from '../src/elanous-config-dir';
import {
  resolveLanguageByName, resolveLanguageForFile,
  __resetServerRegistryForTests,
} from '../src/skills/tools/lsp/server-registry';

let root: string;
let cfgPath: string;
let originalXdg: string | undefined;

function writeConfig(json: unknown): void {
  writeFileSync(cfgPath, JSON.stringify(json));
  reloadUserConfig();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lsp-registry-'));
  setElanousConfigDir(join(root, 'elanous'));
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  const elanousDir = join(root, 'elanous');
  writeFileSync(join(root, '.keep'), '');
  // userConfigPath resolves to XDG_CONFIG_HOME/elanous/config.json
  cfgPath = join(elanousDir, 'config.json');
  require('node:fs').mkdirSync(elanousDir, { recursive: true });
  writeConfig({});
  __resetServerRegistryForTests();
});

afterEach(() => {
  resetElanousConfigDir();
  rmSync(root, { recursive: true, force: true });
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  resetUserConfig();
  __resetServerRegistryForTests();
});

describe('resolveLanguageByName · defaults', () => {
  test('typescript → typescript-language-server / --stdio', () => {
    const entry = resolveLanguageByName('typescript');
    expect(entry).not.toBeNull();
    expect(entry!.command).toBe('typescript-language-server');
    expect(entry!.args).toContain('--stdio');
    expect(entry!.extensions).toContain('ts');
    expect(entry!.extensions).toContain('tsx');
    expect(entry!.extensions).toContain('js');
  });

  test('python → pyright-langserver / --stdio / .py', () => {
    const entry = resolveLanguageByName('python');
    expect(entry).not.toBeNull();
    expect(entry!.command).toBe('pyright-langserver');
    expect(entry!.extensions).toEqual(['py']);
  });

  test('rust → rust-analyzer / no args / .rs', () => {
    const entry = resolveLanguageByName('rust');
    expect(entry).not.toBeNull();
    expect(entry!.command).toBe('rust-analyzer');
    expect(entry!.args).toEqual([]);
    expect(entry!.extensions).toEqual(['rs']);
  });

  test('master enabled:false → all languages disabled', () => {
    writeConfig({ lsp: { enabled: false } });
    expect(resolveLanguageByName('typescript')).toBeNull();
    expect(resolveLanguageByName('python')).toBeNull();
    expect(resolveLanguageByName('rust')).toBeNull();
  });
});

describe('resolveLanguageByName · per-language disable', () => {
  test('lsp.python: false → python disabled, others default', () => {
    writeConfig({ lsp: { python: false } });
    expect(resolveLanguageByName('python')).toBeNull();
    expect(resolveLanguageByName('typescript')).not.toBeNull();
    expect(resolveLanguageByName('rust')).not.toBeNull();
  });
});

describe('resolveLanguageForFile · extension routing', () => {
  test('.ts → typescript', () => {
    expect(resolveLanguageForFile('/p/foo.ts')?.language).toBe('typescript');
  });
  test('.tsx → typescript', () => {
    expect(resolveLanguageForFile('/p/c.tsx')?.language).toBe('typescript');
  });
  test('.py → python', () => {
    expect(resolveLanguageForFile('/p/x.py')?.language).toBe('python');
  });
  test('.rs → rust', () => {
    expect(resolveLanguageForFile('/p/m.rs')?.language).toBe('rust');
  });
  test('case-insensitive — .TS → typescript', () => {
    expect(resolveLanguageForFile('/p/Foo.TS')?.language).toBe('typescript');
  });
  test('no extension → null', () => {
    expect(resolveLanguageForFile('/p/bin')).toBeNull();
  });
  test('unknown extension → null', () => {
    expect(resolveLanguageForFile('/p/README.md')).toBeNull();
  });
  test('disabled language returns null even when extension matches', () => {
    writeConfig({ lsp: { python: false } });
    expect(resolveLanguageForFile('/p/x.py')).toBeNull();
  });
});

describe('resolveLanguageForFile · config override', () => {
  test('custom extensions list is respected', () => {
    writeConfig({
      lsp: {
        typescript: { command: 'tsserver', args: ['--stdio'], extensions: ['ts', 'vue'] },
      },
    });
    expect(resolveLanguageForFile('/p/Component.vue')?.language).toBe('typescript');
    expect(resolveLanguageForFile('/p/bare.jsx')).toBeNull();   // default-only ext removed
  });

  test('custom command passes through', () => {
    writeConfig({
      lsp: { typescript: { command: '/opt/tsls/bin/server', extensions: ['ts'] } },
    });
    const entry = resolveLanguageByName('typescript');
    expect(entry!.command).toBe('/opt/tsls/bin/server');
  });
});
