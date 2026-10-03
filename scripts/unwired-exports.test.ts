import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { formatUnwiredExportsReport, sweepUnwiredExports } from './unwired-exports.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const roots: string[] = [];
const fixtureParent = `${realpathSync(tmpdir())}${sep}`;
function isFixtureRoot(root: string): boolean { return realpathSync(root).startsWith(fixtureParent); }
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!isFixtureRoot(root)) throw new Error(`refusing to remove non-fixture root: ${root}`);
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture(files: Record<string, string>, include = ['src/**/*.ts', 'test/**/*.ts', 'bin/**/*.ts']): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'unwired-exports-')));
  if (!isFixtureRoot(root)) throw new Error(`fixture root escaped system temporary directory: ${root}`);
  roots.push(root);
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler' }, include }));
  for (const [file, content] of Object.entries(files)) { const path = join(root, file); mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, content); }
  return root;
}
function names(items: { name: string }[]): string[] { return items.map((item) => item.name).sort(); }

function alteredNamespaceRuleFixture(): string {
  return fixture({
    'src/target/exports.ts': 'export function productionNamespace() {}\nexport function testNamespace() {}',
    'src/consumer.ts': 'import * as api from "./target/exports.js"; api.productionNamespace();',
    'test/consumer.test.ts': 'import * as api from "../src/target/exports.js"; api["testNamespace"]();',
  });
}

describe('unwired exports', () => {
  test('separates production, test-only, uncalled, type-only, function-value, external, and barrel callers by TypeScript symbols', async () => {
    const root = fixture({
      'src/target/exports.ts': [
        'export function production() {}', 'export function testHelper() {}', 'export function unused() {}',
        'export const arrow = () => {};', 'export const expression = function () {};',
        'export interface Ignored {}', 'export type AlsoIgnored = string;',
      ].join('\n'),
      'src/target/barrel.ts': 'export { production } from "./exports.js";',
      'src/consumer.ts': 'import { production as renamed, arrow } from "./target/exports.js"; renamed(); arrow();',
      'src/consumer-through-barrel.ts': 'import { production } from "./target/barrel.js"; production();',
      'test/consumer.test.ts': 'import { testHelper } from "../src/target/exports.js"; testHelper();',
    });
    const report = await sweepUnwiredExports('src/target', root);
    expect(report.exportsScanned).toBe(5);
    expect(report.productionCalled).toBe(2);
    expect(names(report.testOnly)).toEqual(['testHelper']);
    expect(names(report.unwired)).toEqual(['expression', 'unused']);
  });

  test('counts namespace property and element access callers by resolved function symbol', async () => {
    const report = await sweepUnwiredExports('src/target', alteredNamespaceRuleFixture());
    expect(report.productionCalled).toBe(1);
    expect(names(report.testOnly)).toEqual(['testNamespace']);
    expect(names(report.unwired)).toEqual([]);
  });

  test('would classify namespace calls incorrectly if the call-target rule stopped resolving property and element access', async () => {
    const root = alteredNamespaceRuleFixture();
    const report = await sweepUnwiredExports('src/target', root);
    expect(names(report.unwired)).not.toContain('productionNamespace');
    expect(names(report.unwired)).not.toContain('testNamespace');
  });

  test('includes callers excluded by tsconfig when classifying production and test-only exports', async () => {
    const root = fixture({
      'src/target/exports.ts': 'export function outsideProduction() {}\nexport function outsideTest() {}',
      'outside/consumer.ts': 'import { outsideProduction } from "../src/target/exports.js"; outsideProduction();',
      'outside/consumer.test.ts': 'import { outsideTest } from "../src/target/exports.js"; outsideTest();',
    }, ['src/**/*.ts']);
    const report = await sweepUnwiredExports('src/target', root);
    expect(report.productionCalled).toBe(1);
    expect(names(report.testOnly)).toEqual(['outsideTest']);
    expect(names(report.unwired)).toEqual([]);
  });

  test('excludes functions registered by src/index.ts and bin JavaScript entrypoints from the denominator', async () => {
    const repositoryEntrypoints = ['src/index.ts', 'src/commands.ts', 'bin/cli.mjs'].map((file) => resolve(import.meta.dir, '..', file));
    const repositoryEntrypointsBefore = new Map(repositoryEntrypoints.map((file) => [file, existsSync(file) ? readFileSync(file, 'utf8') : undefined]));
    const root = fixture({
      'src/commands.ts': 'export function registeredFromIndex() {}\nexport function registeredFromBin() {}\nexport function uncalled() {}',
      'src/index.ts': 'import { registeredFromIndex } from "./commands.js"; cli.action(registeredFromIndex);',
      'bin/cli.mjs': 'import { registeredFromBin } from "../src/commands.js"; cli.command(registeredFromBin);',
    });
    expect(isFixtureRoot(root)).toBe(true);
    for (const file of ['src/index.ts', 'src/commands.ts', 'bin/cli.mjs']) {
      const fixtureFile = realpathSync(resolve(root, file));
      const repositoryFile = resolve(import.meta.dir, '..', file);
      expect(fixtureFile.startsWith(`${root}${sep}`)).toBe(true);
      expect(fixtureFile).not.toBe(repositoryFile);
    }
    for (const [file, content] of repositoryEntrypointsBefore) expect(existsSync(file) ? readFileSync(file, 'utf8') : undefined).toBe(content);
    const report = await sweepUnwiredExports('src', root);
    for (const [file, content] of repositoryEntrypointsBefore) expect(existsSync(file) ? readFileSync(file, 'utf8') : undefined).toBe(content);
    expect(report.entrypointRegistered).toBe(2);
    expect(formatUnwiredExportsReport(report)[0]).toBe(`[unwired-exports] scanned: files=2; exported functions=1; production-called=0; entrypoint-registered=2; root=${root}`);
    expect(report.exportsScanned).toBe(1);
    expect(names(report.unwired)).toEqual(['uncalled']);
  });

  test('counts each literal dynamic-import callback invocation registered by src/index.ts once', async () => {
    const root = fixture({
      'src/commands.ts': 'export function registeredFromDynamicImport() {}\nexport function uncalled() {}',
      'src/index.ts': 'cli.command("dynamic").action(async () => { const { registeredFromDynamicImport } = await import("./commands.js"); registeredFromDynamicImport(); });',
    });
    const report = await sweepUnwiredExports('src', root);
    expect(report.entrypointRegistered).toBe(1);
    expect(report.exportsScanned).toBe(1);
    expect(names(report.unwired)).toEqual(['uncalled']);
  });

  test('counts parenthesized and type-asserted entrypoint callbacks without registering nested functions', async () => {
    const root = fixture({
      'src/commands.ts': 'export function parenthesized() {}\nexport function asserted() {}\nexport function nested() {}\nexport function uncalled() {}',
      'src/index.ts': [
        'import { parenthesized, asserted, nested } from "./commands.js";',
        'cli.action((() => parenthesized()));',
        'cli.action(((() => { asserted(); const unused = () => nested(); }) as () => void));',
      ].join('\n'),
    });
    const report = await sweepUnwiredExports('src', root);
    expect(report.entrypointRegistered).toBe(2);
    expect(report.exportsScanned).toBe(2);
    expect(names(report.unwired)).toEqual(['uncalled']);
  });

  test('does not inherit entrypoint registration into nested functions but permits nested registrations', async () => {
    const root = fixture({
      'src/commands.ts': 'export function direct() {}\nexport function nested() {}\nexport function never() {}\nexport function uncalled() {}',
      'src/index.ts': [
        'import { direct, nested, never } from "./commands.js";',
        'cli.action(() => {',
        '  direct();',
        '  const unused = () => never();',
        '  cli.command("nested").action(() => nested());',
        '});',
      ].join('\n'),
    });
    const report = await sweepUnwiredExports('src', root);
    expect(report.entrypointRegistered).toBe(2);
    expect(report.exportsScanned).toBe(2);
    expect(report.productionCalled).toBe(1);
    expect(names(report.unwired)).toEqual(['uncalled']);
  });

  test('counts static destructured require calls while reporting dynamic require blind spots', async () => {
    const root = fixture({
      'src/target/exports.ts': 'export function required() {}\nexport function other() {}',
      'src/consumer.ts': 'const { required } = require("./target/exports.js"); required(); const path = "./target/exports.js"; require(path);',
    });
    const report = await sweepUnwiredExports('src/target', root);
    expect(report.productionCalled).toBe(1);
    expect(names(report.unwired)).toEqual(['other']);
    expect(report.blindSpots).toEqual({ dynamicRequire: 1, aliasReexport: 0 });
    expect(formatUnwiredExportsReport(report).at(-1)).toBe('[unwired-exports] blindSpots: dynamic-require=1; alias-reexport=0');
  });

  test('counts literal dynamic import bindings as production callers without classifying them as blind spots', async () => {
    const root = fixture({
      'src/target/exports.ts': 'export function imported() {}\nexport function testImported() {}\nexport function other() {}',
      'src/consumer.ts': 'async function run() { const { imported } = await import("./target/exports.js"); imported(); } run();',
      'test/consumer.test.ts': 'async function run() { const { testImported } = await import("../src/target/exports.js"); testImported(); } run();',
    });
    const report = await sweepUnwiredExports('src/target', root);
    expect(report.productionCalled).toBe(1);
    expect(names(report.testOnly)).toEqual(['testImported']);
    expect(names(report.unwired)).toEqual(['other']);
    expect(report.blindSpots.dynamicRequire).toBe(0);
  });

  test('reports nonliteral dynamic import expressions as blind spots', async () => {
    const root = fixture({
      'src/target/exports.ts': 'export function other() {}',
      'src/consumer.ts': 'const path = "./target/exports.js"; import(path);',
    });
    const report = await sweepUnwiredExports('src/target', root);
    expect(report.blindSpots.dynamicRequire).toBe(1);
  });

  test('resolves string property aliases but does not treat computed or rest require properties as static export bindings', async () => {
    const root = fixture({
      'src/target/exports.ts': 'export function f() {}\nexport function other() {}',
      'src/consumer.ts': 'const { "f": local } = require("./target/exports.js"); local(); const key = "other"; const { [key]: f, ...rest } = require("./target/exports.js"); f();',
    });
    const report = await sweepUnwiredExports('src/target', root);
    expect(report.productionCalled).toBe(1);
    expect(names(report.unwired)).toEqual(['other']);
  });

  test('does not treat computed require properties as static export bindings', async () => {
    const root = fixture({
      'src/target/exports.ts': 'export function f() {}\nexport function other() {}',
      'src/consumer.ts': 'const key = "other"; const { [key]: f } = require("./target/exports.js"); f();',
    });
    const report = await sweepUnwiredExports('src/target', root);
    expect(report.productionCalled).toBe(0);
    expect(names(report.unwired)).toEqual(['f', 'other']);
  });

  test('does not treat locally shadowed require bindings as module loaders', async () => {
    const root = fixture({
      'src/target/exports.ts': 'export function parameterShadowed() {}\nexport function functionShadowed() {}',
      'src/parameter-consumer.ts': 'function run(require: (path: string) => { parameterShadowed: () => void }) { const { parameterShadowed } = require("./target/exports.js"); parameterShadowed(); }',
      'src/function-consumer.ts': 'function require(path: string) { return { functionShadowed() {} }; } const { functionShadowed } = require("./target/exports.js"); functionShadowed();',
    });
    const report = await sweepUnwiredExports('src/target', root);
    expect(names(report.unwired)).toEqual(['functionShadowed', 'parameterShadowed']);
    expect(report.blindSpots.dynamicRequire).toBe(0);
  });

  test('reports alias re-exports as blind spots without changing caller classification', async () => {
    const root = fixture({
      'src/target/exports.ts': 'export function f() {}',
      'src/target/barrel.ts': 'export { f as renamed } from "./exports.js";',
    });
    const report = await sweepUnwiredExports('src/target', root);
    expect(names(report.unwired)).toEqual(['f']);
    expect(report.blindSpots).toEqual({ dynamicRequire: 0, aliasReexport: 1 });
    expect(formatUnwiredExportsReport(report).at(-1)).toBe('[unwired-exports] blindSpots: dynamic-require=0; alias-reexport=1');
  });

  test('reports explicit zero candidates and blind spots for an empty target directory', async () => {
    const root = fixture({ 'src/empty/.keep': '' });
    const report = await sweepUnwiredExports('src/empty', root);
    expect(report.directory).toBe(resolve(root, 'src/empty'));
    expect(formatUnwiredExportsReport(report)).toEqual([
      `[unwired-exports] scanned: files=0; exported functions=0; production-called=0; entrypoint-registered=0 (none found: this can be normal or indicate missed self-wiring); root=${root}`,
      '[unwired-exports] testOnly: 0', '[unwired-exports] unwired: 0', '[unwired-exports] blindSpots: dynamic-require=0; alias-reexport=0',
    ]);
  });

  test('classifies oauth resolveRunFallback as production-called through agent-mission static require', async () => {
    const report = await sweepUnwiredExports('src/oauth', resolve(import.meta.dir, '..'));
    expect(names(report.unwired)).not.toContain('resolveRunFallback');
  }, 60_000);

  test('rejects a dash-prefixed CLI argument as an unknown flag before scanning', () => {
    const script = resolve(import.meta.dir, 'unwired-exports.ts');
    const run = Bun.spawnSync(['bun', 'run', script, '--json'], { cwd: resolve(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
    const stdout = new TextDecoder().decode(run.stdout);
    expect(run.exitCode).toBe(1);
    expect(new TextDecoder().decode(run.stderr)).toBe('');
    expect(stdout).toContain('[unwired-exports] unknown flag: --json');
    expect(stdout).not.toContain('scanned: files=0');
  });

  test('rejects an empty CLI scan directory as unmeasured without printing the normal report', () => {
    const root = fixture({ 'src/empty/.keep': '' });
    const script = resolve(import.meta.dir, 'unwired-exports.ts');
    const run = Bun.spawnSync(['bun', 'run', script, 'src/empty'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    const stdout = new TextDecoder().decode(run.stdout);
    expect(run.exitCode).toBe(1);
    expect(new TextDecoder().decode(run.stderr)).toBe('');
    expect(stdout).toBe(`[unwired-exports] nothing was measured; directory=${realpathSync(resolve(root, 'src/empty'))} root=${realpathSync(root)}\n`);
    expect(stdout).not.toContain('scanned: files=0');
  }, 60_000);

  test('reports ad pipeline output helpers and exits zero as a report-only CLI', async () => {
    const script = resolve(import.meta.dir, 'unwired-exports.ts');
    const run = Bun.spawnSync(['bun', 'run', script, 'src/ad-pipeline'], { cwd: resolve(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
    const stdout = new TextDecoder().decode(run.stdout);
    expect(run.exitCode).toBe(0);
    expect(new TextDecoder().decode(run.stderr)).toBe('');
    expect(stdout).toContain('unwired:');
    // ⛔⭐ 2026-09-11 — 이 단언은 «한 번 늙었다». 원래는 adProjectDir·adMasterName 이
    //   여기 나오길 기대했는데, 그 사이 #17295(ad-run-setup)가 «둘을 실제로 불렀다».
    //   ⇒ 자가 틀린 게 아니라 «세상이 바뀌었다». 그래서 「그때의 이름」을 박지 않고
    //   ***「자가 세 칸을 «전부» 내는가」***를 문다 — 그 셋은 이름이 바뀌어도 남는다.
    expect(stdout).toContain('scanned:');
    expect(stdout).toContain('testOnly:');
    expect(stdout).toMatch(/\[unwired-exports\] blindSpots: dynamic-require=\d+; alias-reexport=\d+/);
    // ⊕ 아직 실행 경로에 «없는» 것이 testOnly 로 잡히는지 — adSubDir 이 지금 그 자리다.
    expect(stdout).toContain('adSubDir');
  }, 90_000);
});
