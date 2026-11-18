import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { addedExportNames, deadExportsInDiff, exportNamesInLine, hasOperationalUse, isTestPath, reportForRange } from './dead-export-warn.js';

const DIFF = [
  '@@ -0,0 +1,4 @@',
  '+export function chooseSeatPull() { return 1; }',
  '+export const used = 1;',
  '+const local = 2;',
  '+export type OnlyType = string;',
].join('\n');

function gitRun(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
  }).trim();
}

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dead-export-warn-'));
  gitRun(dir, 'init');
  gitRun(dir, 'config', 'user.email', 'test@example.invalid');
  gitRun(dir, 'config', 'user.name', 'dead-export-warn test');
  gitRun(dir, 'config', 'commit.gpgsign', 'false');
  gitRun(dir, 'config', 'core.autocrlf', 'false');
  gitRun(dir, 'config', 'core.hooksPath', join(dir, 'no-such-hooks-dir'));
  return dir;
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const target = join(dir, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function commitAll(dir: string, message: string): string {
  gitRun(dir, 'add', '-A');
  gitRun(dir, 'commit', '-m', message);
  return gitRun(dir, 'rev-parse', 'HEAD');
}

describe('DEAD-EXPORT-PREGATE', () => {
  test('added export lines keep the new-file line number', () => {
    const found = addedExportNames(DIFF, 'src/dashboard/input/seat-self-pull-sources.ts');
    expect(found).toEqual([
      { name: 'chooseSeatPull', line: 1 },
      { name: 'used', line: 2 },
      { name: 'OnlyType', line: 4 },
    ]);
  });

  test('a non-test caller is operational; a test-only caller is not', () => {
    const files = new Map<string, string>([
      ['src/a.ts', 'export function chooseSeatPull() { return 1; }\n'],
      ['src/b.ts', 'import { chooseSeatPull } from "./a";\nchooseSeatPull();\n'],
      ['src/a.test.ts', 'chooseSeatPull();\n'],
    ]);
    expect(hasOperationalUse('chooseSeatPull', 'src/a.ts', 1, files)).toBe(true);
    const testsOnly = new Map<string, string>([
      ['src/a.ts', 'export function chooseSeatPull() { return 1; }\n'],
      ['src/a.test.ts', 'chooseSeatPull();\n'],
    ]);
    expect(hasOperationalUse('chooseSeatPull', 'src/a.ts', 1, testsOnly)).toBe(false);
  });

  test('warns only the export whose non-test callers are zero', () => {
    const diffs = new Map<string, string>([['src/a.ts', DIFF]]);
    const head = new Map<string, string>([
      ['src/a.ts', 'export function chooseSeatPull() { return 1; }\nexport const used = 1;\nconst local = 2;\nexport type OnlyType = string;\n'],
      ['src/ops.ts', 'import { used } from "./a";\nconsole.log(used);\n'],
      ['src/a.test.ts', 'chooseSeatPull();\n'],
    ]);
    expect(deadExportsInDiff(diffs, head)).toEqual([
      { file: 'src/a.ts', line: 1, name: 'chooseSeatPull' },
      { file: 'src/a.ts', line: 4, name: 'OnlyType' },
    ]);
  });

  test('test paths and non-source files are not scanned as producers', () => {
    expect(isTestPath('src/a.test.ts')).toBe(true);
    expect(isTestPath('skills/bookforge/tests/test_render.py')).toBe(true);
    const diffs = new Map<string, string>([
      ['src/a.test.ts', '+export function helper() {}\n'],
      ['docs/note.md', '+export function nope() {}\n'],
    ]);
    expect(deadExportsInDiff(diffs, new Map())).toEqual([]);
  });

  test('export clause exports the visible alias, not the local name', () => {
    expect(exportNamesInLine("export { a, b as c } from './x';")).toEqual({
      measurable: ['a', 'c'],
      recognizedUnmeasurable: false,
    });
    expect(exportNamesInLine('export { a, b as c };')).toEqual({
      measurable: ['a', 'c'],
      recognizedUnmeasurable: false,
    });
  });

  test('star and default exports are recognized as unmeasurable', () => {
    expect(exportNamesInLine("export * as ns from './x';")).toEqual({
      measurable: ['ns'],
      recognizedUnmeasurable: false,
    });
    expect(exportNamesInLine("export * from './x';")).toEqual({
      measurable: [],
      recognizedUnmeasurable: true,
      unmeasuredName: '*',
    });
    expect(exportNamesInLine('export default function f() {}')).toEqual({
      measurable: [],
      recognizedUnmeasurable: true,
      unmeasuredName: 'f',
    });
    expect(exportNamesInLine('export default 42')).toEqual({
      measurable: [],
      recognizedUnmeasurable: true,
      unmeasuredName: 'default',
    });
  });

  test('declaration-form exports collect the declared name', () => {
    expect(exportNamesInLine('export declare function x();')).toEqual({
      measurable: ['x'],
      recognizedUnmeasurable: false,
    });
    expect(exportNamesInLine('export async function* gen() { yield 1; }')).toEqual({
      measurable: ['gen'],
      recognizedUnmeasurable: false,
    });
    expect(exportNamesInLine('export const y = 1;')).toEqual({
      measurable: ['y'],
      recognizedUnmeasurable: false,
    });
  });

  test('non-export declaration lines are not measurable', () => {
    expect(exportNamesInLine('const notExported = 1;')).toEqual({
      measurable: [],
      recognizedUnmeasurable: false,
    });
    expect(exportNamesInLine('function plain() { return 1; }')).toEqual({
      measurable: [],
      recognizedUnmeasurable: false,
    });
  });

  test('addedExportNames reports clause-form exports with new-file line numbers', () => {
    const clauseDiff = [
      '@@ -1,3 +1,4 @@',
      ' export const kept = 0;',
      '+export { pickSeat, pullSeat as pullSeatAlias } from "./internals";',
      '+export { second } from "./more";',
    ].join('\n');
    expect(addedExportNames(clauseDiff, 'src/seat.ts')).toEqual([
      { name: 'pickSeat', line: 2 },
      { name: 'pullSeatAlias', line: 2 },
      { name: 'second', line: 3 },
    ]);
  });

  test('reportForRange: caller outside the diff file lives in the HEAD tree -> CLEAN', () => {
    const dir = makeGitRepo();
    try {
      writeFiles(dir, {
        'src/a.ts': 'export const old = 1;\n',
        'src/b.ts': 'import { fresh } from "./a";\nexport const value = fresh();\n',
      });
      const base = commitAll(dir, 'base');
      writeFiles(dir, {
        'src/a.ts': 'export const old = 1;\nexport function fresh() { return 2; }\n',
      });
      const head = commitAll(dir, 'head: add fresh');
      const report = reportForRange(base, head, dir);
      expect(report.status).toBe('CLEAN');
      expect(report.warnings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reportForRange: zero callers in the whole HEAD tree -> WARN', () => {
    const dir = makeGitRepo();
    try {
      writeFiles(dir, {
        'src/a.ts': 'export const old = 1;\n',
        'src/b.ts': 'export const other = "b";\n',
      });
      const base = commitAll(dir, 'base');
      writeFiles(dir, {
        'src/a.ts': 'export const old = 1;\nexport function fresh() { return 2; }\n',
      });
      const head = commitAll(dir, 'head: add fresh');
      const report = reportForRange(base, head, dir);
      expect(report.status).toBe('WARN');
      expect(report.warnings).toEqual([{ file: 'src/a.ts', line: 2, name: 'fresh' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reportForRange: default exports are never warned', () => {
    const dir = makeGitRepo();
    try {
      writeFiles(dir, {
        'src/a.ts': 'export const old = 1;\n',
        'src/b.ts': 'export const other = "b";\n',
      });
      const base = commitAll(dir, 'base');
      writeFiles(dir, {
        'src/a.ts': 'export const old = 1;\nexport default function helperFn() { return 3; }\n',
      });
      const head = commitAll(dir, 'head: add default export');
      const report = reportForRange(base, head, dir);
      expect(report.status).toBe('CLEAN');
      expect(report.warnings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reportForRange: non-ASCII caller path in HEAD tree is still found -> CLEAN', () => {
    const dir = makeGitRepo();
    try {
      writeFiles(dir, {
        'src/a.ts': 'export const old = 1;\n',
        'src/호출처.ts': 'import { fresh } from "./a";\nexport const value = fresh();\n',
      });
      const base = commitAll(dir, 'base');
      writeFiles(dir, {
        'src/a.ts': 'export const old = 1;\nexport function fresh() { return 2; }\n',
      });
      const head = commitAll(dir, 'head: add fresh');
      const report = reportForRange(base, head, dir);
      expect(report.status).toBe('CLEAN');
      expect(report.warnings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reportForRange: sha256 object-format repo measures CLEAN/WARN, not UNMEASURED', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dead-export-warn-sha256-'));
    try {
      gitRun(dir, 'init', '--object-format=sha256');
      gitRun(dir, 'config', 'user.email', 'test@example.invalid');
      gitRun(dir, 'config', 'user.name', 'dead-export-warn test');
      gitRun(dir, 'config', 'commit.gpgsign', 'false');
      gitRun(dir, 'config', 'core.autocrlf', 'false');
      gitRun(dir, 'config', 'core.hooksPath', join(dir, 'no-such-hooks-dir'));
      writeFiles(dir, {
        'src/a.ts': 'export const old = 1;\n',
        'src/b.ts': 'import { fresh } from "./a";\nexport const value = fresh();\n',
      });
      const base = commitAll(dir, 'base');
      writeFiles(dir, {
        'src/a.ts': 'export const old = 1;\nexport function fresh() { return 2; }\n',
      });
      const head = commitAll(dir, 'head: add fresh');
      const clean = reportForRange(base, head, dir);
      expect(clean.status).toBe('CLEAN');
      expect(clean.warnings).toEqual([]);

      writeFiles(dir, {
        'src/a.ts': 'export const old = 1;\nexport function fresh() { return 2; }\nexport function orphan() { return 9; }\n',
      });
      const head2 = commitAll(dir, 'head: add orphan');
      const warn = reportForRange(base, head2, dir);
      expect(warn.status).toBe('WARN');
      expect(warn.warnings).toEqual([{ file: 'src/a.ts', line: 3, name: 'orphan' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reportForRange: multi-line export clause in the diff is collected from the real repo', () => {
    const dir = makeGitRepo();
    try {
      writeFiles(dir, {
        'src/a.ts': 'export const old = 1;\n',
        'src/b.ts': 'export const other = "b";\n',
      });
      const base = commitAll(dir, 'base');
      writeFiles(dir, {
        'src/a.ts': 'export const old = 1;\nexport {\n  pickSeat,\n  pullSeat as pullSeatAlias\n} from "./internals";\n',
      });
      const head = commitAll(dir, 'head: multi-line clause');
      const report = reportForRange(base, head, dir);
      expect(report.status).toBe('WARN');
      expect(report.warnings).toEqual([
        { file: 'src/a.ts', line: 2, name: 'pickSeat' },
        { file: 'src/a.ts', line: 2, name: 'pullSeatAlias' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── mustFix 1: EXPORT_RE export 형태 인식 확장 (Terra r1) ─────────────────────
import * as dew from './dead-export-warn.js';

const diffOf = (body: string[]): string => ['@@ -0,0 +1,' + body.length + ' @@', ...body.map((l) => '+' + l)].join('\n');

test('export 형태 전부: 절·default·star·declare 를 놓치지 않는다', () => {
  const r = dew.scanAddedExports(
    diffOf([
      "export { solo } from './x';",
      "export { a, b } from './x';",
      "export { c as alias } from './x';",
      'export default function dfoo() {}',
      'export default class Dcls {}',
      'export default 42',
      "export * from './y';",
      "export * as ns from './y';",
      'export declare function dcl() {}',
      'export declare const dcv = 1',
    ]),
    'src/shapes.ts',
  );
  expect(r.measurable.map((m) => m.name).join(',')).toBe('solo,a,b,alias,ns,dcl,dcv');
  expect(r.unmeasured.map((u) => u.name + ':' + u.reason).join('|')).toBe(
    'dfoo:default-export|Dcls:default-export|default:default-export|*:anonymous-star-reexport',
  );
});

test('export 절 여러 줄 — 첫 줄에 이름이 있어도 절 시작 줄로 수집한다', () => {
  const r = dew.scanAddedExports(
    diffOf(["export { foo,", "  bar } from './x';", 'const local = 1;']),
    'src/clause.ts',
  );
  expect(JSON.stringify(r.measurable)).toBe('[{"name":"foo","line":1},{"name":"bar","line":1}]');
  expect(r.unmeasured.length).toBe(0);
});

test('unmeasuredExportsInDiff: 측정 불가 export 를 조용한 CLEAN 없이 리포트에 남긴다', () => {
  const u = dew.unmeasuredExportsInDiff(
    new Map([
      ['src/a.ts', diffOf(["export * from './x';", 'export default function Entrypoint() {}'])],
      ['src/b.ts', diffOf(["export * as ns from './y';", 'export const used = 1;'])],
    ]),
  );
  expect(JSON.stringify(u)).toBe(
    '[{"file":"src/a.ts","line":1,"name":"*","reason":"anonymous-star-reexport"},{"file":"src/a.ts","line":2,"name":"Entrypoint","reason":"default-export"}]',
  );
});

const ecel = (dew as unknown as Record<string, unknown>).exportClauseEndLine as
  | ((lines: string[], declLine: number) => number)
  | undefined;
if (typeof ecel === 'function') {
  test('exportClauseEndLine: 첫 줄에 이름이 있는 절도 닫는 줄까지 사용-제외한다', () => {
    expect(ecel(['export { foo,', "  bar } from './x';", 'use(foo);'], 1)).toBe(2);
    expect(ecel(['export {', '  a,', "} from './x';", 'use(a);'], 1)).toBe(3);
    expect(ecel(["export { a } from './x';", 'use(a);'], 1)).toBe(1);
    expect(ecel(['export const k = 1;', 'use(k);'], 1)).toBe(1);
  });
}

// ── #38412 r5 must 1: 리포트 출처 키(base·head·pr) ─────────────────────────────
test('reportForRange 는 모든 경로에 base·head 출처 키를 심는다', () => {
  const dir = makeGitRepo();
  try {
    writeFiles(dir, { 'src/base.ts': 'export const one = 1;\n' });
    const base = commitAll(dir, 'base');
    writeFiles(dir, { 'src/a.ts': 'export function lonely() { return 1; }\n' });
    const head = commitAll(dir, 'head');
    const report = reportForRange(base, head, dir);
    expect(report.base).toBe(base);
    expect(report.head).toBe(head);
    expect(report.status).toBe('WARN');
    const unmeasured = reportForRange(base, base, dir);
    expect(unmeasured.status).toBe('CLEAN');
    expect(unmeasured.base).toBe(base);
    expect(unmeasured.head).toBe(base);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
