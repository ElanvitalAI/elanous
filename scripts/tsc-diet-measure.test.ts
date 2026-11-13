import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClosureGraph, testsReachingChanged, testsReachingChangedFromGraph, type ClosureTree } from './release-loop/gate-closure.js';
import { virtualGraph, virtualTree } from './tsc-diet-measure.js';

const content: Record<string, string> = {
  'src/hub.ts': 'export const value = 1;\n',
  'src/consumer.ts': "import { value } from './hub.js';\nexport { value };\n",
  'src/consumer.test.ts': "import './consumer.js';\n",
};
const tree: ClosureTree = { files: Object.keys(content), read: (path) => content[path], preload: [] };

test('virtual static edge cut reduces the measured reverse gate radius without writing source', () => {
  const tests = ['src/consumer.test.ts'];
  const before = testsReachingChanged(tree, ['src/hub.ts'], tests);
  const cut = virtualTree(tree, { kind: 'edge', from: 'src/consumer.ts', to: 'src/hub.ts' });
  const after = testsReachingChanged(cut, ['src/hub.ts'], tests);
  const cachedGraphResult = testsReachingChangedFromGraph(cut, ['src/hub.ts'], tests,
    virtualGraph(buildClosureGraph(tree), { kind: 'edge', from: 'src/consumer.ts', to: 'src/hub.ts' }, tree));
  expect(before.ok && before.tests).toEqual(tests);
  expect(after.ok && after.tests).toEqual([]);
  expect(cachedGraphResult).toEqual(after);
  expect(content['src/consumer.ts']).toContain("import { value } from './hub.js'");
});

test('virtual edge cut retains a dynamic import of the same module', () => {
  const overlap: Record<string, string> = { ...content, 'src/consumer.ts': "import { value } from './hub.js'; export const load = () => import('./hub.js');\n" };
  const source: ClosureTree = { files: Object.keys(overlap), read: (path) => overlap[path], preload: [] };
  const cut = { kind: 'edge' as const, from: 'src/consumer.ts', to: 'src/hub.ts' };
  const rewritten = virtualTree(source, cut);
  const rebuilt = buildClosureGraph(rewritten);
  const virtual = virtualGraph(buildClosureGraph(source), cut, source);
  expect(virtual.forward.get(cut.from)).toEqual(rebuilt.forward.get(cut.from));
  expect(virtual.staticImports.get(cut.from)).toEqual(rebuilt.staticImports.get(cut.from));
  expect(virtual.forward.get(cut.from)).toContain(cut.to);
});

test('branch CLI reports a conservative full gate for a deleted changed path', () => {
  const repo = mkdtempSync(join(tmpdir(), 'tsc-diet-deleted-'));
  const run = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  try {
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'gone.ts'), 'export const gone = true;\n');
    writeFileSync(join(repo, 'src', 'gone.test.ts'), "import './gone.js';\n");
    expect(run('init').status).toBe(0);
    expect(run('add', '.').status).toBe(0);
    expect(run('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base').status).toBe(0);
    expect(run('rm', 'src/gone.ts').status).toBe(0);
    expect(run('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'delete').status).toBe(0);
    const cli = spawnSync('bun', [join(import.meta.dir, 'tsc-diet-measure.ts'), '--repo', repo,
      '--branch', 'HEAD', '--base', 'HEAD~1'], { cwd: repo, encoding: 'utf8' });
    expect(cli.status).toBe(0);
    const result = JSON.parse(cli.stdout);
    expect(result.changedFiles).toEqual(['src/gone.ts']);
    expect(result.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.contractSelection).toMatchObject({ status: 'full', reason: 'change outside declared implementations' });
    expect(result.before.gate.mode).toBe('full-fallback');
    expect(result.before.tsc.mode).toBe('full');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('branch CLI includes both paths of a rename before choosing the full gate', () => {
  const repo = mkdtempSync(join(tmpdir(), 'tsc-diet-rename-'));
  const run = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  try {
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'before.ts'), 'export const value = true;\n');
    expect(run('init').status).toBe(0);
    expect(run('add', '.').status).toBe(0);
    expect(run('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base').status).toBe(0);
    expect(run('mv', 'src/before.ts', 'src/after.ts').status).toBe(0);
    expect(run('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'rename').status).toBe(0);
    const cli = spawnSync('bun', [join(import.meta.dir, 'tsc-diet-measure.ts'), '--repo', repo,
      '--branch', 'HEAD', '--base', 'HEAD~1'], { cwd: repo, encoding: 'utf8' });
    expect(cli.status).toBe(0);
    const result = JSON.parse(cli.stdout);
    expect(result.changedFiles).toEqual(['src/after.ts', 'src/before.ts']);
    expect(result.before.gate.mode).toBe('full-fallback');
    expect(result.before.tsc.mode).toBe('full');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('explicit files keep working without origin/main and use a full selector candidate', () => {
  const repo = mkdtempSync(join(tmpdir(), 'tsc-diet-no-origin-main-'));
  const run = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  try {
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'hub.ts'), 'export const value = 1;\n');
    writeFileSync(join(repo, 'src', 'hub.test.ts'), "import './hub.js';\n");
    expect(run('init').status).toBe(0);
    expect(run('add', '.').status).toBe(0);
    expect(run('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial').status).toBe(0);
    const cli = spawnSync('bun', [join(import.meta.dir, 'tsc-diet-measure.ts'), '--repo', repo,
      '--branch', 'HEAD', '--files', 'src/hub.ts'], { cwd: repo, encoding: 'utf8' });
    expect(cli.status).toBe(0);
    const result = JSON.parse(cli.stdout);
    expect(result.baseCommit).toBeNull();
    expect(result.contractSelection).toMatchObject({ status: 'full', reason: 'baseline commit unavailable', files: ['src/hub.test.ts'] });
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('module deletion remains a conservative opaque dependency while importers still name it', () => {
  const deleted = virtualTree(tree, { kind: 'module', path: 'src/hub.ts' });
  const verdict = testsReachingChanged(deleted, ['src/consumer.ts'], ['src/consumer.test.ts']);
  expect(verdict.ok && verdict.tests).toEqual(['src/consumer.test.ts']);
  expect(() => virtualTree(tree, { kind: 'edge', from: 'src/hub.ts', to: 'src/consumer.ts' }))
    .toThrow('static edge not found');
});
