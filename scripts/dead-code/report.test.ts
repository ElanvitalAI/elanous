import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeReachability, inventoryRoots, renderMarkdown, trackedModules } from './report.ts';

let root: string;
const put = (file: string, text: string) => {
  const path = join(root, file);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'elanous-dead-code-report-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  put('tsconfig.json', JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler' } }));
  put('apps/pwa/tsconfig.json', JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', baseUrl: '.', paths: { '@/*': ['./src/*'] } } }));
  put('bin/elanous.mjs', "import('../src/index.ts');\n");
  put('src/index.ts', "import { server } from './cli/a2a-cli.ts'; export { server };\n");
  put('src/cli/a2a-cli.ts', "export const server = () => import('../a2a/server.js');\n");
  put('src/a2a/server.ts', 'export const live = true;\n');
  put('src/boot/acp-server.ts', 'export const boot = true;\n');
  put('scripts/independent.ts', "import '../src/independent.ts';\n");
  put('src/independent.ts', 'export const independent = true;\n');
  put('apps/pwa/src/app/page.tsx', "import '@/lib/pwa'; export default function Page() { return null; }\n");
  put('apps/pwa/src/lib/pwa.ts', 'export const pwa = true;\n');
  put('apps/desktop/src/main.ts', 'export const desktop = true;\n');
  put('plugins/hello/manifest.json', JSON.stringify({ entry: 'plugin.ts' }));
  put('plugins/hello/plugin.ts', "import './child.ts';\n");
  put('plugins/hello/child.ts', 'export const plugin = true;\n');
  put('plugins/bot/plugin.json', JSON.stringify({ main: './plugin.ts' }));
  put('plugins/bot/plugin.ts', 'export const bot = true;\n');
  put('plugins/missing/manifest.json', JSON.stringify({ entry: 'missing.ts' }));
  put('src/unknown.ts', "const name = './chosen.ts'; import(name); import './missing.ts';\n");
  put('src/chosen.ts', 'export const chosen = true;\n');
  put('src/not-loaded.ts', 'export const notLoaded = true;\n');
  execFileSync('git', ['add', '.'], { cwd: root });
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('conservative multi-entrypoint report', () => {
  it('follows CLI lazy import, independent script, app alias, and both manifest formats', () => {
    const files = trackedModules(root);
    const report = analyzeReachability(root, files, inventoryRoots(root, files));
    for (const file of ['src/a2a/server.ts', 'src/independent.ts', 'apps/pwa/src/lib/pwa.ts', 'apps/desktop/src/main.ts', 'plugins/hello/child.ts', 'plugins/bot/plugin.ts', 'src/boot/acp-server.ts']) {
      expect(report.unionReachable).toContain(file);
      expect(report.unknownKeep).not.toContain(file);
    }
    expect(report.groups.find(g => g.name === 'scripts')?.roots).toContain('scripts/independent.ts');
    expect(report.groups.find(g => g.name === 'plugins')?.roots).toEqual(['plugins/bot/plugin.ts', 'plugins/hello/plugin.ts', 'plugins/missing/missing.ts']);
    expect(report.unresolved).toContainEqual({ importer: '(root:plugins)', specifier: 'plugins/missing/missing.ts', kind: 'unresolved' });
    expect(report.unknownKeep).toContain('plugins/missing/missing.ts');
    expect(report.deletions).toBe(0);
    expect(renderMarkdown(report)).toContain('Deletions: 0');
  });

  it('reports missing declared runtime roots instead of silently omitting them', () => {
    const files = trackedModules(root);
    const report = analyzeReachability(root, files, [...inventoryRoots(root, files), { name: 'missing-runtime', roots: ['src/missing-runtime.ts'], configuration: 'tsconfig.json' }]);
    expect(report.unresolved).toContainEqual({ importer: '(root:missing-runtime)', specifier: 'src/missing-runtime.ts', kind: 'unresolved' });
    expect(report.unknownKeep).toContain('src/missing-runtime.ts');
    expect(report.deletions).toBe(0);
  });

  it('keeps dynamic, unresolved and unclassified files unknown rather than declaring deletions', () => {
    const files = trackedModules(root);
    const report = analyzeReachability(root, files, [...inventoryRoots(root, files), { name: 'dynamic-probe', roots: ['src/unknown.ts'], configuration: 'tsconfig.json' }]);
    expect(report.dynamic).toContainEqual(expect.objectContaining({ importer: 'src/unknown.ts', kind: 'dynamic' }));
    expect(report.unresolved).toContainEqual(expect.objectContaining({ importer: 'src/unknown.ts', specifier: './missing.ts' }));
    expect(report.unknownKeep).toContain('src/unknown.ts');
    expect(report.unknownKeep).toContain('src/not-loaded.ts');
    expect(report.unclassifiedKeep).toContain('src/not-loaded.ts');
    expect(report.deletions).toBe(0);
  });
});
