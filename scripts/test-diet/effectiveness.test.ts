import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixedCountAssertions, flakeVerdict, mutationProbe, sweepSlice, unreachableImports } from './effectiveness.js';
import { judge, propose, writeCardDraft } from './lib.js';

const pass = { rc: 0, pass: 1, fail: 0 };
const fail = { rc: 1, pass: 0, fail: 1 };

describe('TD3 effectiveness', () => {
  test('three outcomes separate flaky, failing and stable', () => {
    expect(flakeVerdict([pass, fail, pass])).toBe('flaky');
    expect(flakeVerdict([fail, fail, fail])).toBe('failing');
    expect(flakeVerdict([pass, pass, pass])).toBe('stable');
    expect(flakeVerdict([{ rc: 0, pass: 0, fail: 0 }, { rc: 0, pass: 0, fail: 0 }, { rc: 0, pass: 0, fail: 0 }])).toBe('failing');
  });
  test('50400 seconds divided into four daily slices for a week with headroom', () => {
    expect(sweepSlice({ totalCostSecs: 50400 })).toEqual({ budgetSecs: 2160, slicesNeeded: 24 });
  });
  test('whole-file packing from a cursor expands the budget to finish within 28 slices', () => {
    const files = Array.from({ length: 29 }, (_, i) => `test/${i}.test.ts`);
    const costs = new Map(files.map((file) => [file, 50400 / 29]));
    const plan = sweepSlice({ totalCostSecs: 50400, files, costs, start: 5 });
    expect(plan.budgetSecs).toBeGreaterThan(2160);
    expect(plan.slicesNeeded).toBeLessThanOrEqual(28);
    expect(plan.slicesNeeded).toBe(15);
    expect(sweepSlice({ totalCostSecs: 50400, files, costs, start: 5, remaining: 2 }).slicesNeeded).toBe(2);
    expect(sweepSlice({ totalCostSecs: 50400, files, costs, start: 5, remaining: 1 }).slicesNeeded).toBe(1);
    const lastSlot = sweepSlice({ totalCostSecs: 50400, files, costs, start: 5, remaining: 2, slotsLeft: 1 });
    expect(lastSlot.slicesNeeded).toBe(1);
    expect(lastSlot.budgetSecs).toBeGreaterThan(2160);
  });
  test('historic live-repository count assertions are reported at their original lines and reach the card', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'td-fixed-count-real-')));
    try {
      mkdirSync(join(root, 'scripts'));
      for (const file of ['audit-test-state-writes.test.ts', 'audit-test-state-writes.ts']) {
        const path = `scripts/${file}`;
        const shown = spawnSync('git', ['show', `45695f85e3:${path}`], { encoding: 'utf8' });
        expect(shown.status).toBe(0);
        writeFileSync(join(root, path), shown.stdout);
      }
      const counts = fixedCountAssertions('scripts/audit-test-state-writes.test.ts', root);
      expect(counts).toEqual([{ line: 20, count: 62 }, { line: 21, count: 62 }]);
      const result = propose(judge({ file: 'scripts/audit-test-state-writes.test.ts', secs: 1, rssMb: 10, rc: 0, pass: 1, fail: 0,
        effectiveness: { flake: 'stable', mutation: 'caught', fixedCounts: counts.length } }, 0), new Map());
      expect(result).toMatchObject({ proposal: 'investigate', basis: '저장소 전수 개수 고정 단언 2줄 — 관련 시험 묶음 후보' });
      const card = writeCardDraft(root, { at: '2026-10-04T00:00:00Z', range: '#0~#0', start: 0, end: 0, next: 1,
        total: 1, commit: '45695f85e3', budgetSecs: 1, results: [result] });
      expect(readFileSync(card!, 'utf8')).toContain('investigate | 저장소 전수 개수 고정 단언 2줄 — 관련 시험 묶음 후보');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('non-repository tests with a literal length do not count', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'td-fixed-count-local-')));
    try {
      writeFileSync(join(root, 'local.test.ts'), 'test("local", () => expect([1, 2, 3]).toHaveLength(3));\n');
      expect(fixedCountAssertions('local.test.ts', root)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('toBe without a count-bearing expect argument does not count', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'td-fixed-count-other-')));
    try {
      writeFileSync(join(root, 'other.test.ts'), "import { readdirSync } from 'node:fs';\ntest('other', () => expect(answer).toBe(62));\n");
      expect(fixedCountAssertions('other.test.ts', root)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('a repository reader with a non-count toBe or toEqual is ignored', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'td-fixed-count-shapes-')));
    try {
      writeFileSync(join(root, 'shapes.test.ts'), "import { globSync } from 'node:fs';\nexpect(answer).toBe(62);\nexpect(files.length).toEqual(4);\nexpect(files.size).toBe(0);\nexpect(count).toBe(1);\nexpect(files.length).toEqual(value);\nexpect(files.length).toBe(1_000);\nexpect(files.length).toBe(0x10);\n");
      expect(fixedCountAssertions('shapes.test.ts', root)).toEqual([
        { line: 3, count: 4 }, { line: 4, count: 0 }, { line: 5, count: 1 },
        { line: 7, count: 1000 }, { line: 8, count: 16 },
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('direct relative imports resolve js-to-ts and index.ts, without following unrelated readers', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'td-fixed-count-imports-')));
    try {
      mkdirSync(join(root, 'src/a'), { recursive: true });
      writeFileSync(join(root, 'src/a/index.ts'), "import { readdirSync } from 'node:fs';\n");
      writeFileSync(join(root, 'src/reader.ts'), "import { globSync } from 'node:fs';\n");
      writeFileSync(join(root, 'src/unrelated.ts'), "import { readdirSync } from 'node:fs';\n");
      writeFileSync(join(root, 'no-reader.test.ts'), 'expect(items.length).toEqual(3);\n');
      expect(fixedCountAssertions('no-reader.test.ts', root)).toEqual([]);
      writeFileSync(join(root, 'js-reader.test.ts'), "import './src/reader.js';\nexpect(items.length).toEqual(3);\n");
      expect(fixedCountAssertions('js-reader.test.ts', root)).toEqual([{ line: 2, count: 3 }]);
      writeFileSync(join(root, 'index-reader.test.ts'), "import './src/a';\nexpect(items.size).toBe(1);\n");
      expect(fixedCountAssertions('index-reader.test.ts', root)).toEqual([{ line: 2, count: 1 }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('a .js relative import prefers reader.ts when reader.js also exists', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'td-fixed-count-dual-extension-')));
    try {
      writeFileSync(join(root, 'reader.js'), 'export const local = 1;\n');
      writeFileSync(join(root, 'reader.ts'), "import { readdirSync } from 'node:fs';\n");
      writeFileSync(join(root, 'dual.test.ts'), "import './reader.js';\nexpect(items.length).toBe(62);\n");
      expect(fixedCountAssertions('dual.test.ts', root)).toEqual([{ line: 2, count: 62 }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('an import mentioned only in a string or comment is not a direct import', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'td-fixed-count-fake-import-')));
    try {
      writeFileSync(join(root, 'reader.ts'), "import { readdirSync } from 'node:fs';\n");
      writeFileSync(join(root, 'fake.test.ts'), [
        '// import "./reader.js";',
        'const example = "import \'./reader.js\'";',
        '/* import("./reader.js") */',
        'expect(items.length).toBe(62);',
      ].join('\n'));
      expect(fixedCountAssertions('fake.test.ts', root)).toEqual([]);
      writeFileSync(join(root, 'real.test.ts'), "const reader = import('./reader.js');\nexpect(items.length).toBe(62);\n");
      expect(fixedCountAssertions('real.test.ts', root)).toEqual([{ line: 2, count: 62 }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('existing proposal priorities beat fixed-count investigation', () => {
    const base = { file: 'test/a.test.ts', secs: 1, rssMb: 1, rc: 0, pass: 1, fail: 0 };
    const effectiveness = { flake: 'stable' as const, mutation: 'caught' as const, fixedCounts: 2 };
    expect(propose(judge({ ...base, effectiveness }, 0), new Map()).proposal).toBe('investigate');
    expect(propose(judge({ ...base, effectiveness }, 0), new Map([['test/a.test.ts', {
      disposition: 'keep', alternative: '', guards: '', why_slow: '',
    }]])).proposal).toBeNull();
    expect(propose(judge({ ...base, effectiveness: { ...effectiveness, mutation: 'survived' } }, 0), new Map()).proposal).toBe('rewrite-cheap');
    expect(propose(judge({ ...base, secs: 61, effectiveness }, 0), new Map()).proposal).toBe('shrink');
    expect(propose(judge({ ...base, effectiveness: { ...effectiveness, fixedCounts: 0 } }, 0), new Map()).proposal).toBeNull();
  });
  test('measure --effectiveness counts unreachable imports and leaves unreadable results absent', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'td-fixed-measure-')));
    const bin = join(root, 'bin');
    const repo = join(root, 'repo');
    mkdirSync(bin);
    mkdirSync(join(repo, 'test'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src/orphan.ts'), 'export const orphan = true;\n');
    writeFileSync(join(repo, 'test/counted.test.ts'), "import { readdirSync } from 'node:fs';\nimport '../src/orphan.js';\nexpect(files.length).toBe(1);\n");
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=TD3', '-c', 'user.email=td3@example.test', 'commit', '-qm', 'fixture']]) {
      expect(spawnSync('git', args, { cwd: repo }).status).toBe(0);
    }
    writeFileSync(join(bin, 'ssh'), '#!/bin/sh\necho "COMMIT abc"\nfor f in test/counted.test.ts test/missing.test.ts; do printf "M\\t%s\\t1\\t1\\t0\\t1\\t0\\t\\n" "$f"; printf "E\\t%s\\t0,1,0;0,1,0;0,1,0\\tcaught\\t1\\n" "$f"; done\n');
    chmodSync(join(bin, 'ssh'), 0o700);
    try {
      const run = spawnSync(process.execPath, [join(import.meta.dir, 'node.ts'), 'measure', '--effectiveness'], {
        cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`,
          ELANOUS_GRAPH_CONTEXT: JSON.stringify({ input: {}, outputs: { pick: { files: ['test/counted.test.ts', 'test/missing.test.ts'] } } }) },
      });
      expect(run.status).toBe(0);
      const measurements = (JSON.parse(run.stdout.trim()) as { measurements: Array<{ effectiveness: { fixedCounts?: number; unreachable?: number } }> }).measurements;
      expect(measurements[0]?.effectiveness.fixedCounts).toBe(1);
      expect(measurements[0]?.effectiveness.unreachable).toBe(1);
      expect(measurements[1]?.effectiveness.fixedCounts).toBeUndefined();
      expect(measurements[1]?.effectiveness.unreachable).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('unreachable direct imports exclude tests and verify resolved tracked importer specifiers', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'td-unreachable-')));
    try {
      mkdirSync(join(root, 'src'));
      mkdirSync(join(root, 'test'));
      writeFileSync(join(root, 'src/used.ts'), 'export const used = true;\n');
      writeFileSync(join(root, 'src/orphan.ts'), 'export const orphan = true;\n');
      writeFileSync(join(root, 'src/used-not.ts'), 'export const other = true;\n');
      writeFileSync(join(root, 'src/main.ts'), "import './used.js';\n");
      writeFileSync(join(root, 'src/orphan-extra.test.ts'), "import './orphan.js';\n");
      writeFileSync(join(root, 'src/used-not.ts'), "import './used-not.js';\n");
      writeFileSync(join(root, 'test/x.test.ts'), "import '../src/used.js';\nimport('../src/orphan.js');\nimport('../../x.js');\n");
      const git = (args: string[]) => {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
        expect(result.status).toBe(0);
      };
      git(['init', '-q']);
      git(['add', '.']);
      git(['-c', 'user.name=TD3', '-c', 'user.email=td3@example.test', 'commit', '-qm', 'fixture']);
      expect(unreachableImports('test/x.test.ts', root)).toEqual(['src/orphan.ts']);
      writeFileSync(join(root, 'src/main.ts'), 'export const main = true;\n');
      git(['add', '.']);
      git(['-c', 'user.name=TD3', '-c', 'user.email=td3@example.test', 'commit', '-qm', 'remove importer']);
      expect(unreachableImports('test/x.test.ts', root)).toEqual(['src/orphan.ts', 'src/used.ts']);
      expect(unreachableImports('test/x.test.ts', root, { importers: () => ['src/used-not.ts'] }))
        .toEqual(['src/orphan.ts', 'src/used.ts']);
      writeFileSync(join(root, 'src/main.ts'), "export { orphan } from './orphan.js';\n");
      git(['add', '.']);
      git(['-c', 'user.name=TD3', '-c', 'user.email=td3@example.test', 'commit', '-qm', 'reexport orphan']);
      expect(unreachableImports('test/x.test.ts', root)).toEqual(['src/used.ts']);
      writeFileSync(join(root, 'src/main.ts'), "export * from './orphan.js';\n");
      git(['add', '.']);
      git(['-c', 'user.name=TD3', '-c', 'user.email=td3@example.test', 'commit', '-qm', 'star reexport orphan']);
      expect(unreachableImports('test/x.test.ts', root)).toEqual(['src/used.ts']);
      writeFileSync(join(root, 'src/orphan-not.ts'), 'export const other = true;\n');
      writeFileSync(join(root, 'src/main.ts'), "export * from './orphan-not.js';\n");
      git(['add', '.']);
      git(['-c', 'user.name=TD3', '-c', 'user.email=td3@example.test', 'commit', '-qm', 'reexport different module']);
      expect(unreachableImports('test/x.test.ts', root)).toEqual(['src/orphan.ts', 'src/used.ts']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('mutation runs only inside a disposable repository copy; original bytes remain intact', () => {
    const root = mkdtempSync(join(tmpdir(), 'td3-probe-'));
    try {
      mkdirSync(join(root, 'src'));
      mkdirSync(join(root, 'test'));
      const a = join(root, 'src/a.ts');
      writeFileSync(a, 'export function enabled() { return true; }\n');
      writeFileSync(join(root, 'src/plain.ts'), 'export const text = "unmutable";\n');
      writeFileSync(join(root, 'src/equality.ts'), 'export function same(a: number, b: number) { return a === b; }\n');
      writeFileSync(join(root, 'test/equality.test.ts'), "import { test, expect } from 'bun:test';\nimport { same } from '../src/equality.ts';\ntest('equality', () => expect(same(1, 1)).toBe(true));\n");
      writeFileSync(join(root, 'test/caught.test.ts'), "import { test, expect } from 'bun:test';\nimport { enabled } from '../src/a.ts';\ntest('asserts', () => expect(enabled()).toBe(true));\n");
      writeFileSync(join(root, 'test/survived.test.ts'), "import { test, expect } from 'bun:test';\nimport { enabled } from '../src/a.ts';\ntest('does not assert', () => { enabled(); expect(1).toBe(1); });\n");
      writeFileSync(join(root, 'test/none.test.ts'), "import { test, expect } from 'bun:test';\nimport { text } from '../src/plain.ts';\ntest('unmutable', () => expect(text).toBe('unmutable'));\n");
      writeFileSync(join(root, 'test/preexisting.test.ts'), "import { test, expect } from 'bun:test';\nimport { enabled } from '../src/a.ts';\ntest('already fails', () => expect(enabled()).toBe(false));\n");
      for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=TD3', '-c', 'user.email=td3@example.test', 'commit', '-qm', 'fixture']]) {
        const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
        expect(run.status).toBe(0);
      }
      const before = readFileSync(a);
      expect(mutationProbe('test/caught.test.ts', { root })).toBe('caught');
      const run = (copy: string, file: string) => spawnSync('bun', ['test', file], { cwd: copy, stdio: 'ignore' }).status;
      expect(mutationProbe('test/survived.test.ts', { root, run })).toBe('survived');
      expect(mutationProbe('test/equality.test.ts', { root, run })).toBe('caught');
      expect(mutationProbe('test/none.test.ts', { root, run: () => { throw new Error('n/a must not execute'); } })).toBe('n/a');
      expect(mutationProbe('test/preexisting.test.ts', { root, run })).toBe('n/a');
      let calls = 0;
      expect(mutationProbe('test/caught.test.ts', { root, run: (copy, file) => ++calls === 2 ? 1 : run(copy, file) })).toBe('n/a');
      expect(calls).toBe(2);
      expect(mutationProbe('test/caught.test.ts', { root, baselineStable: false, run: () => { throw new Error('unstable baseline must not probe'); } })).toBe('n/a');
      expect(readFileSync(a)).toEqual(before);
      expect(readFileSync(join(root, 'src/equality.ts'), 'utf8')).toContain('a === b');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
