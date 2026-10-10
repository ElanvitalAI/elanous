import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CLAUDE_PACKAGE_MISSING,
  INSTALLED_PLUGINS_FILENAME,
  KNOWN_MARKETPLACES_FILENAME,
  readClaudePackageLedger,
  splitClaudePluginKey,
} from './claude-package.js';

function writeLedger(
  root: string,
  installed: unknown,
  marketplaces: unknown,
): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, INSTALLED_PLUGINS_FILENAME), JSON.stringify(installed));
  writeFileSync(join(root, KNOWN_MARKETPLACES_FILENAME), JSON.stringify(marketplaces));
}

function withTempRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'claude-package-ledger-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('splitClaudePluginKey', () => {
  test('splits the market at the last @ so two markets stay distinct', () => {
    expect(splitClaudePluginKey('alpha@market-one')).toEqual({
      plugin: 'alpha',
      marketplace: 'market-one',
    });
    expect(splitClaudePluginKey('beta@market-two')).toEqual({
      plugin: 'beta',
      marketplace: 'market-two',
    });
    expect(splitClaudePluginKey('antv-infographic-skills@antv-infographic')).toEqual({
      plugin: 'antv-infographic-skills',
      marketplace: 'antv-infographic',
    });
  });
});

describe('readClaudePackageLedger', () => {
  test('joins compound keys to marketplace source, path, scope, and revision', () => {
    withTempRoot((root) => {
      writeLedger(
        root,
        {
          version: 2,
          plugins: {
            'alpha@market-one': [{
              scope: 'user',
              installPath: '/tmp/alpha',
              version: '1.0.0',
            }],
            'beta@market-two': [{
              scope: 'project',
              installPath: '/tmp/beta',
              version: '2.0.0',
            }],
          },
        },
        {
          'market-one': { source: { source: 'github', repo: 'org/one' } },
          'market-two': { source: { source: 'github', repo: 'org/two' } },
        },
      );

      const result = readClaudePackageLedger({ pluginsRoot: root });
      expect(result.status).toBe('ok');
      expect(result.packages).toHaveLength(2);

      const byName = Object.fromEntries(result.packages.map((pkg) => [pkg.name, pkg]));
      expect(byName['alpha@market-one']).toMatchObject({
        plugin: 'alpha',
        marketplace: 'market-one',
        installPath: '/tmp/alpha',
        scope: 'user',
        source: 'github:org/one',
        revision: '1.0.0',
      });
      expect(byName['beta@market-two']).toMatchObject({
        plugin: 'beta',
        marketplace: 'market-two',
        installPath: '/tmp/beta',
        scope: 'project',
        source: 'github:org/two',
        revision: '2.0.0',
      });
    });
  });

  test('returns 없다 for a missing version instead of inventing a revision', () => {
    withTempRoot((root) => {
      writeLedger(
        root,
        {
          version: 2,
          plugins: {
            'no-ver@market-one': [{
              scope: 'user',
              installPath: '/tmp/no-ver',
            }],
          },
        },
        {
          'market-one': { source: { source: 'github', repo: 'org/one' } },
        },
      );

      const result = readClaudePackageLedger({ pluginsRoot: root });
      expect(result.status).toBe('ok');
      expect(result.packages).toHaveLength(1);
      expect(result.packages[0]!.revision).toBe(CLAUDE_PACKAGE_MISSING);
      expect(result.packages[0]!.revision).toBe('없다');
    });
  });

  test('returns 없다 for source when the marketplace is unknown', () => {
    withTempRoot((root) => {
      writeLedger(
        root,
        {
          version: 2,
          plugins: {
            'orphan@missing-market': [{
              scope: 'user',
              installPath: '/tmp/orphan',
              version: '1',
            }],
          },
        },
        {},
      );

      const result = readClaudePackageLedger({ pluginsRoot: root });
      expect(result.status).toBe('ok');
      expect(result.packages[0]!.source).toBe('없다');
      expect(result.packages[0]!.marketplace).toBe('missing-market');
    });
  });

  test('returns a named status when installed_plugins.json is absent', () => {
    withTempRoot((root) => {
      writeFileSync(join(root, KNOWN_MARKETPLACES_FILENAME), '{}');
      const result = readClaudePackageLedger({ pluginsRoot: root });
      expect(result.status).toBe('installed-plugins-unreadable');
      expect(result.packages).toEqual([]);
      expect(result.status).not.toBe('ok');
    });
  });

  test('returns a named status when known_marketplaces.json is absent', () => {
    withTempRoot((root) => {
      writeFileSync(
        join(root, INSTALLED_PLUGINS_FILENAME),
        JSON.stringify({ version: 2, plugins: {} }),
      );
      const result = readClaudePackageLedger({ pluginsRoot: root });
      expect(result.status).toBe('known-marketplaces-unreadable');
      expect(result.packages).toEqual([]);
      expect(result.status).not.toBe('ok');
    });
  });

  test('retains installed packages without marketplace metadata, without inventing a source', () => {
    withTempRoot((root) => {
      writeFileSync(join(root, INSTALLED_PLUGINS_FILENAME), JSON.stringify({ plugins: {
        'existing@offline-market': [{ scope: 'user', installPath: '/local/existing' }],
      } }));
      const result = readClaudePackageLedger({ pluginsRoot: root });
      expect(result.status).toBe('known-marketplaces-unreadable');
      expect(result.packages).toMatchObject([{
        name: 'existing@offline-market', plugin: 'existing', marketplace: 'offline-market',
        installPath: '/local/existing', source: CLAUDE_PACKAGE_MISSING,
      }]);
    });
  });

  test('returns a named status for invalid installed_plugins JSON', () => {
    withTempRoot((root) => {
      writeFileSync(join(root, INSTALLED_PLUGINS_FILENAME), '{not-json');
      writeFileSync(join(root, KNOWN_MARKETPLACES_FILENAME), '{}');
      const result = readClaudePackageLedger({ pluginsRoot: root });
      expect(result.status).toBe('installed-plugins-unreadable');
      expect(result.packages).toEqual([]);
    });
  });

  test('does not write the ledger files it reads', () => {
    withTempRoot((root) => {
      writeLedger(
        root,
        { version: 2, plugins: {} },
        {},
      );
      const installedPath = join(root, INSTALLED_PLUGINS_FILENAME);
      const marketplacesPath = join(root, KNOWN_MARKETPLACES_FILENAME);
      const beforeInstalled = {
        mtimeMs: statSync(installedPath).mtimeMs,
        body: readFileSync(installedPath, 'utf8'),
      };
      const beforeMarketplaces = {
        mtimeMs: statSync(marketplacesPath).mtimeMs,
        body: readFileSync(marketplacesPath, 'utf8'),
      };

      const result = readClaudePackageLedger({ pluginsRoot: root });
      expect(result.status).toBe('ok');

      expect(readFileSync(installedPath, 'utf8')).toBe(beforeInstalled.body);
      expect(readFileSync(marketplacesPath, 'utf8')).toBe(beforeMarketplaces.body);
      expect(statSync(installedPath).mtimeMs).toBe(beforeInstalled.mtimeMs);
      expect(statSync(marketplacesPath).mtimeMs).toBe(beforeMarketplaces.mtimeMs);
    });
  });

  test('reads this machine live ledger without a pluginsRoot override', () => {
    const result = readClaudePackageLedger();
    expect(result.status).toBe('ok');
    expect(result.packages.length).toBeGreaterThan(0);

    const names = result.packages.map((pkg) => pkg.name);
    expect(names).toContain('antv-infographic-skills@antv-infographic');

    for (const pkg of result.packages) {
      expect(pkg.name.length).toBeGreaterThan(0);
      expect(pkg.installPath).not.toBe(CLAUDE_PACKAGE_MISSING);
      expect(pkg.scope.length).toBeGreaterThan(0);
      expect(typeof pkg.source).toBe('string');
      expect(typeof pkg.revision).toBe('string');
    }

    const antv = result.packages.find(
      (pkg) => pkg.name === 'antv-infographic-skills@antv-infographic',
    );
    expect(antv).toBeDefined();
    expect(antv!.installPath.length).toBeGreaterThan(0);
    expect(antv!.scope).toBe('user');
    expect(antv!.source).not.toBe(CLAUDE_PACKAGE_MISSING);
    expect(antv!.revision).not.toBe(CLAUDE_PACKAGE_MISSING);
    expect(antv!.marketplace).toBe('antv-infographic');
  });
});
