import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStaticBuild } from './static-generation';
import ts from 'typescript';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PWA staged repository inputs', () => {
  test('runStaticBuild stages plugin TypeScript imports, catalog and profiles before invoking Next', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pwa-stage-inputs-test-'));
    roots.push(root);
    const repo = join(root, 'checkout');
    const appDir = join(repo, 'apps', 'pwa');
    const expected = ['scenarios', 'catalog', 'docs/profiles', 'plugins', 'node_modules'];
    for (const path of [...expected, 'src', 'scripts', 'skills/omni-crawl', 'scenarios', 'catalog/models/openrouter', 'docs/profiles', 'plugins/graph-instance-view', 'node_modules']) {
      mkdirSync(join(repo, path), { recursive: true });
    }
    mkdirSync(appDir, { recursive: true });

    const consumer = 'src/graph-runner/capability-providers/upstage-solar-decide.ts';
    mkdirSync(join(repo, 'src/graph-runner/capability-providers'), { recursive: true });
    mkdirSync(join(repo, 'plugins/upstage-solar-decide'), { recursive: true });
    writeFileSync(join(repo, consumer), "export { SOLAR_DECIDE } from '../../../plugins/upstage-solar-decide/plugin.js';\n");
    writeFileSync(join(repo, 'plugins/upstage-solar-decide/plugin.ts'), "export const SOLAR_DECIDE = 'synthetic';\n");

    let inspected = false;
    await runStaticBuild(appDir, {
      runBuild: (_sourceApp, stagedRepo, stagedApp) => {
        for (const path of expected) {
          const staged = join(stagedRepo, path);
          expect(lstatSync(staged).isSymbolicLink()).toBe(true);
          expect(realpathSync(staged)).toBe(realpathSync(join(repo, path)));
        }
        expect(existsSync(join(stagedRepo, 'catalog/models/openrouter'))).toBe(true);
        const resolved = ts.resolveModuleName('../../../plugins/upstage-solar-decide/plugin.js',
          join(stagedRepo, consumer), { moduleResolution: ts.ModuleResolutionKind.Bundler }, ts.sys).resolvedModule;
        expect(resolved?.resolvedFileName).toBe(join(stagedRepo, 'plugins/upstage-solar-decide/plugin.ts'));
        expect(existsSync(join(stagedRepo, 'plugins/upstage-solar-decide/plugin.js'))).toBe(false);
        const out = join(stagedApp, 'out');
        mkdirSync(join(out, '_next'), { recursive: true });
        writeFileSync(join(out, 'index.html'), '<html>fixture</html>');
        writeFileSync(join(out, '_next', 'asset.js'), 'fixture');
        inspected = true;
        return 0;
      },
    });
    expect(inspected).toBe(true);
    expect(existsSync(join(appDir, 'out', 'index.html'))).toBe(true);
  });

  for (const nesting of ['direct', 'nested'] as const) test(`runStaticBuild stages an npm-installed app with ${nesting} parent dependencies`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'pwa-installed-stage-test-'));
    roots.push(root);
    const project = join(root, 'project');
    const parent = nesting === 'direct' ? project : join(project, 'foo');
    const repo = join(parent, 'node_modules', 'parent', 'node_modules', 'elanous');
    const appDir = join(repo, 'apps', 'pwa');
    for (const path of [
      'src', 'scripts', 'skills/omni-crawl', 'scenarios', 'catalog/models/openrouter',
      'docs/profiles', 'plugins/graph-instance-view',
      'apps/pwa/node_modules',
    ]) mkdirSync(join(repo, path), { recursive: true });
    mkdirSync(join(project, 'node_modules', 'yaml'), { recursive: true });
    mkdirSync(join(parent, 'node_modules', 'react'), { recursive: true });
    mkdirSync(join(repo, 'node_modules', 'package-local'), { recursive: true });
    mkdirSync(join(appDir, 'node_modules', '@types', 'pwa-only'), { recursive: true });
    writeFileSync(join(appDir, 'package.json'), '{"name":"@elanous/pwa"}');
    writeFileSync(join(appDir, 'page.tsx'), 'export default function Page() {}');

    let inspected = false;
    await runStaticBuild(appDir, {
      runBuild: (_sourceApp, stagedRepo, stagedApp) => {
        expect(existsSync(join(stagedApp, 'package.json'))).toBe(true);
        expect(existsSync(join(stagedApp, 'page.tsx'))).toBe(true);
        expect(lstatSync(join(stagedRepo, 'node_modules')).isDirectory()).toBe(true);
        expect(readlinkSync(join(stagedRepo, 'node_modules', 'yaml'))).toBe(join(project, 'node_modules', 'yaml'));
        expect(readlinkSync(join(stagedRepo, 'node_modules', 'react'))).toBe(join(parent, 'node_modules', 'react'));
        expect(readlinkSync(join(stagedRepo, 'node_modules', 'package-local'))).toBe(join(repo, 'node_modules', 'package-local'));
        expect(readlinkSync(join(stagedRepo, 'node_modules', '@types', 'pwa-only'))).toBe(join(appDir, 'node_modules', '@types', 'pwa-only'));
        expect(lstatSync(join(stagedApp, 'node_modules')).isSymbolicLink()).toBe(true);
        mkdirSync(join(stagedApp, 'out', '_next'), { recursive: true });
        writeFileSync(join(stagedApp, 'out', 'index.html'), '<html>fixture</html>');
        writeFileSync(join(stagedApp, 'out', '_next', 'asset.js'), 'fixture');
        inspected = true;
        return 0;
      },
    });
    expect(inspected).toBe(true);
    expect(existsSync(join(appDir, 'out', 'index.html'))).toBe(true);
  });
});
