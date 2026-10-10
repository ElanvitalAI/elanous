import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { PluginHost, USER_DIR, type HostHooks } from './host.js';
import { installPlugin, removePlugin } from '../install/plugin-install.js';

const tempDirs: string[] = [];

const hooks: HostHooks = {
  log: () => {},
  hudSet: () => {},
  requestRender: () => {},
  focusPane: () => {},
};

const MINIMAL_PLUGIN = `export default { name: 'mine', version: '1', description: '', initialState: () => ({}), panes: {} };`;

function createDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Layout measured 2026-09-04 under ~/.claude/plugins. */
function writeClaudeManagedLayout(userDir: string): void {
  mkdirSync(join(userDir, 'cache'), { recursive: true });
  mkdirSync(join(userDir, 'data'), { recursive: true });
  mkdirSync(join(userDir, 'marketplaces'), { recursive: true });
  writeFileSync(join(userDir, 'blocklist.json'), '{}');
  writeFileSync(join(userDir, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {} }));
  writeFileSync(join(userDir, 'known_marketplaces.json'), '{}');
  writeFileSync(join(userDir, 'plugin-catalog-cache.json'), '{}');
  // Claude installs packages under cache/<marketplace>/<plugin>/<revision>/,
  // not as immediate <name>/plugin.ts children. A nested entry must not be adopted.
  const nested = join(userDir, 'cache', 'claude-plugins-official', 'nested-pkg', '1.0.0');
  mkdirSync(nested, { recursive: true });
  writeFileSync(
    join(nested, 'plugin.ts'),
    `export default { name: 'nested-pkg', version: '1', description: '', initialState: () => ({}), panes: {} };`,
  );
}

function writeMinePlugin(userDir: string): void {
  const mineDir = join(userDir, 'mine');
  mkdirSync(mineDir, { recursive: true });
  writeFileSync(join(mineDir, 'plugin.ts'), MINIMAL_PLUGIN);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('PluginHost user-dir contract vs Claude package management', () => {
  test('USER_DIR stays at ~/.claude/plugins and the header names that same path', () => {
    expect(USER_DIR).toBe(join(homedir(), '.claude', 'plugins'));
    const src = readFileSync(join(import.meta.dir, 'host.ts'), 'utf8');
    const header = src.split('\n').slice(0, 20).join('\n');
    expect(header).toContain('~/.claude/plugins');
    expect(header).toContain('src/plugins/adapters/claude-package.ts');
    expect(header).toMatch(/package-management directory/);
    expect(header).toContain('<name>/plugin.ts');
    expect(header).toMatch(/currently finds no Claude-managed/);
  });

  test('discover() finds repository built-ins including botlab', async () => {
    const userDir = createDir('elanous-host-user-empty-');
    const host = new PluginHost(hooks, null, { userDir });
    await host.discover();
    const builtins = host.list().filter((entry) => entry.source === 'builtin');
    expect(builtins).toHaveLength(8);
    expect(builtins.some((entry) => entry.manifest.id === 'botlab')).toBe(true);
    expect(builtins.some((entry) => entry.manifest.id === 'elanous-hwp')).toBe(true);
    expect(host.list().filter((entry) => entry.source === 'user')).toHaveLength(0);
  });

  test('Claude management dirs are not adopted as plugins when injected as userDir', async () => {
    const userDir = createDir('elanous-host-claude-layout-');
    writeClaudeManagedLayout(userDir);
    const host = new PluginHost(hooks, null, { userDir });
    await host.discover();

    const names = host.list().map((entry) => entry.manifest.id);
    expect(names).not.toContain('cache');
    expect(names).not.toContain('data');
    expect(names).not.toContain('marketplaces');
    expect(names).not.toContain('nested-pkg');
    expect(host.list().filter((entry) => entry.source === 'user')).toHaveLength(0);
    expect(host.list().filter((entry) => entry.source === 'builtin')).toHaveLength(8);
  });

  test('a sibling mine/plugin.ts following the Elanous convention is discovered', async () => {
    const userDir = createDir('elanous-host-claude-layout-mine-');
    writeClaudeManagedLayout(userDir);
    writeMinePlugin(userDir);
    const host = new PluginHost(hooks, null, { userDir });
    await host.discover();

    const names = host.list().map((entry) => entry.manifest.id);
    expect(names).not.toContain('cache');
    expect(names).not.toContain('data');
    expect(names).not.toContain('marketplaces');
    expect(names).toContain('mine');
    const userPlugins = host.list().filter((entry) => entry.source === 'user');
    expect(userPlugins.map((entry) => entry.manifest.id)).toEqual(['mine']);
    expect(host.list().filter((entry) => entry.source === 'builtin')).toHaveLength(8);
  });

  test('ledger entries alone are discovered; removal and corrupt ledger preserve built-ins and user plugins', async () => {
    const original = process.env.ELANOUS_STATE_DIR;
    const root = createDir('elanous-host-ledger-');
    const userDir = createDir('elanous-host-user-ledger-');
    const source = createDir('elanous-host-source-ledger-');
    writeMinePlugin(userDir);
    writeFileSync(join(source, 'plugin.json'), JSON.stringify({ id: 'installed-test', name: 'installed-test', version: '1.0.0', main: './plugin.ts' }));
    writeFileSync(join(source, 'plugin.ts'), `export default { name: 'installed-test', version: '1.0.0', initialState: () => ({}), panes: {} };`);
    process.env.ELANOUS_STATE_DIR = root;
    try {
      const installed = await installPlugin(source, { root, yes: true });
      const override = join(root, 'plugins', 'local', 'mine', '1.0.0');
      mkdirSync(override, { recursive: true });
      writeFileSync(join(override, 'plugin.json'), JSON.stringify({ id: 'mine', version: '1.0.0', main: './plugin.ts' }));
      writeFileSync(join(override, 'plugin.ts'), MINIMAL_PLUGIN);
      const ledgerFile = join(root, 'plugins', 'installed.json');
      const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8')) as object[];
      writeFileSync(ledgerFile, JSON.stringify([...ledger, { name: 'mine', version: '1.0.0', market: 'local', sha256: null }]));
      const stray = join(root, 'plugins', 'local', 'stray-test', '1.0.0');
      const fakeVersion = join(root, 'plugins', 'local', 'installed-test', '9.0.0');
      mkdirSync(fakeVersion, { recursive: true });
      writeFileSync(join(fakeVersion, 'plugin.json'), JSON.stringify({ id: 'installed-test', version: '9.0.0', main: './plugin.ts' }));
      writeFileSync(join(fakeVersion, 'plugin.ts'), MINIMAL_PLUGIN);
      mkdirSync(stray, { recursive: true });
      writeFileSync(join(stray, 'plugin.json'), JSON.stringify({ id: 'stray-test', version: '1.0.0', main: './plugin.ts' }));
      writeFileSync(join(stray, 'plugin.ts'), MINIMAL_PLUGIN);
      const warnings: string[] = [];
      const host = new PluginHost({ ...hooks, log: message => warnings.push(message) }, null, { userDir });
      await host.discover();
      expect(host.list().find(entry => entry.manifest.id === 'installed-test')).toMatchObject({ path: installed.path, source: 'installed' });
      expect(host.list().some(entry => entry.manifest.id === 'stray-test')).toBe(false);
      expect(host.list().find(entry => entry.manifest.id === 'installed-test')?.manifest.version).toBe('1.0.0');
      expect(host.list().filter(entry => entry.source === 'builtin')).toHaveLength(8);
      expect(host.list().filter(entry => entry.source === 'user').map(entry => entry.manifest.id)).toEqual(['mine']);
      expect(host.list().find(entry => entry.manifest.id === 'mine')?.path).toBe(join(userDir, 'mine'));
      rmSync(fakeVersion, { recursive: true });
      rmSync(stray, { recursive: true });
      expect(removePlugin('installed-test', root)).toBe(1);
      await host.discover();
      expect(host.list().some(entry => entry.manifest.id === 'installed-test')).toBe(false);
      expect(host.list().some(entry => entry.manifest.id === 'stray-test')).toBe(false);
      writeFileSync(join(root, 'plugins', 'installed.json'), '{bad');
      await host.discover();
      expect(warnings.some(message => message.includes('installed.json'))).toBe(true);
      expect(host.list().filter(entry => entry.source === 'builtin')).toHaveLength(8);
      expect(host.list().filter(entry => entry.source === 'user').map(entry => entry.manifest.id)).toEqual(['mine']);
    } finally {
      if (original === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = original;
    }
  });
});

test('installed onActivate cannot register a hook through its context', async () => {
  const original = process.env.ELANOUS_STATE_DIR;
  const root = createDir('elanous-host-programmatic-state-');
  const source = createDir('elanous-host-programmatic-source-');
  const userDir = createDir('elanous-host-programmatic-user-');
  const messages: string[] = [];
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({ id: 'installed-programmatic', version: '1.0.0', main: './plugin.ts' }));
  writeFileSync(join(source, 'plugin.ts'), `export default {
    name: 'installed-programmatic', initialState: () => ({}), panes: {},
    onActivate(ctx) {
      ctx.log('context hooks available: ' + ('hooks' in ctx));
      ctx.hooks?.register({ id: 'turn', event: 'Turn', command: 'echo forbidden' });
    },
  };`);
  process.env.ELANOUS_STATE_DIR = root;
  try {
    await installPlugin(source, { root, yes: true });
    const host = new PluginHost({ ...hooks, log: message => messages.push(message) }, null, { userDir });
    await host.discover();
    await host.activate('installed-programmatic');
    expect(messages).toContain('context hooks available: false');
    expect(host.active()?.ownedHookDisposers).toHaveLength(0);
    await host.deactivate();
  } finally {
    if (original === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = original;
  }
});

test('installed manifest hooks stay off at activation while built-in and user behavior is unchanged', async () => {
  const original = process.env.ELANOUS_STATE_DIR;
  const root = createDir('elanous-host-hook-state-');
  const source = createDir('elanous-host-hook-source-');
  const userDir = createDir('elanous-host-hook-user-');
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({ id: 'installed-hook', version: '1.0.0', main: './plugin.ts',
    contributes: { hooks: [{ id: 'turn', event: 'Turn', command: 'echo hooked' }] } }));
  writeFileSync(join(source, 'plugin.ts'), "export default { name: 'installed-hook', initialState: () => ({}), panes: {} };\n");
  process.env.ELANOUS_STATE_DIR = root;
  try {
    await installPlugin(source, { root, yes: true });
    const host = new PluginHost(hooks, null, { userDir });
    await host.discover();
    expect(host.list().find(entry => entry.manifest.id === 'installed-hook')?.source).toBe('installed');
    await host.activate('installed-hook');
    expect(host.active()?.ownedHookDisposers).toHaveLength(0);
    await host.deactivate();
  } finally {
    if (original === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = original;
  }
});

describe('skill-only packs (no main) boot quietly', () => {
  test('a manifest pack with skills/ and no plugin.ts is not warned as «main not found»; an explicit missing main still is', async () => {
    const userDir = createDir('elanous-host-skill-only-');
    const skillPack = join(userDir, 'skill-pack');
    mkdirSync(join(skillPack, 'skills', 'hello'), { recursive: true });
    writeFileSync(join(skillPack, 'plugin.json'), JSON.stringify({ id: 'skill-pack', version: '0.1.0' }));
    writeFileSync(join(skillPack, 'skills', 'hello', 'SKILL.md'), '# hello\n');
    const broken = join(userDir, 'broken-pack');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'plugin.json'), JSON.stringify({ id: 'broken-pack', version: '0.1.0', main: './dist/index.js' }));
    const warnings: string[] = [];
    const host = new PluginHost({ ...hooks, log: (m) => warnings.push(m) }, null, { userDir });
    await host.discover();
    expect(warnings.some((w) => w.includes('skill-pack') && w.includes('main not found'))).toBe(false);
    expect(warnings.some((w) => w.includes('broken-pack') && w.includes('main not found'))).toBe(true);
  });
});
