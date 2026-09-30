// ── Phase L3 + L4 · LSP pool tests ──
//
// Environment-robust shape-checks for src/skills/tools/lsp/pool.ts:
//
// - Disabled-language branch: set lsp.typescript = false in config
//   and verify getTypescriptClient throws the "disabled" error. This
//   path fires regardless of whether the binary is installed, so
//   the test passes on any dev machine.
// - __resetLspPoolForTests idempotence on an empty pool.
//
// Real spawn/reuse/reap semantics need either a real server or the
// mock fixture and live in the integration-style `lsp-*-dispatch`
// suites, not here.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __resetTypescriptServerProbeCacheForTests,
} from '../src/skills/tools/lsp/typescript-server';
import {
  __resetLspPoolForTests,
} from '../src/skills/tools/lsp/pool';
import {
  __resetServerRegistryForTests,
} from '../src/skills/tools/lsp/server-registry';
import { resetUserConfig, reloadUserConfig } from '../src/user-config';

let root: string;
let cfgPath: string;
let originalXdg: string | undefined;

function writeConfig(json: unknown): void {
  writeFileSync(cfgPath, JSON.stringify(json));
  reloadUserConfig();
}

describe('LSP pool · config-driven branches', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lsp-pool-'));
    originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = root;
    const elanousDir = join(root, 'elanous');
    mkdirSync(elanousDir, { recursive: true });
    cfgPath = join(elanousDir, 'config.json');
    writeConfig({});
    __resetTypescriptServerProbeCacheForTests();
    __resetLspPoolForTests();
    __resetServerRegistryForTests();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    resetUserConfig();
    __resetTypescriptServerProbeCacheForTests();
    __resetLspPoolForTests();
    __resetServerRegistryForTests();
  });

  test('disabled typescript → getTypescriptClient throws "disabled" error', async () => {
    writeConfig({ lsp: { typescript: false } });
    const { getTypescriptClient } = await import('../src/skills/tools/lsp/pool');
    await expect(getTypescriptClient('/tmp')).rejects.toThrow(
      /typescript is disabled/,
    );
  });

  test('lsp.enabled:false → resolveLanguageByName returns null → getLspClient bypassed', async () => {
    writeConfig({ lsp: { enabled: false } });
    const { resolveLanguageByName } = await import('../src/skills/tools/lsp/server-registry');
    expect(resolveLanguageByName('typescript')).toBeNull();
  });

  test('__resetLspPoolForTests is idempotent on an empty pool', () => {
    __resetLspPoolForTests();
    expect(() => __resetLspPoolForTests()).not.toThrow();
  });
});
