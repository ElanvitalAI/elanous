import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDaemonPortBaseline, renderDaemonPortBaseline, runDaemonPortGate, scanDaemonPortSource, scanDaemonPorts } from './ci-daemon-port-gate.js';

describe('daemon port ratchet', () => {
  test('counts lines, not occurrences; ignores comment-only lines but not executable lines', () => {
    expect(scanDaemonPortSource([
      '// port 31415',
      '  /* 31415 */',
      '/*',
      ' * 31415',
      '  31415 is documented here',
      '*/',
      'const port = 31415; // 31415',
      'const another = 31415 + 31415;',
      'const unrelated = 80;',
    ].join('\n'))).toEqual([
      { lineNumber: 7, line: 'const port = 31415; // 31415' },
      { lineNumber: 8, line: 'const another = 31415 + 31415;' },
    ]);
  });

  test('counts a multiplication continuation starting with * while excluding block-comment stars', () => {
    expect(scanDaemonPortSource([
      'const n = 2',
      ' * 31415;',
      '/*',
      ' * 31415',
      ' */',
      'const value = 3 /* 31415 */ * 4;',
    ].join('\n'))).toEqual([{ lineNumber: 2, line: '* 31415;' }]);
  });

  test('keeps URL strings with // as code and excludes actual comments', () => {
    expect(scanDaemonPortSource([
      "const url = 'http://127.0.0.1:31415';",
      'const comment = 80; // 31415',
      'const path = "/* 31415 */";',
      '/* const ignored = 31415; */',
      'const escaped = "text \\" // 31415";',
    ].join('\n'))).toEqual([
      { lineNumber: 1, line: "const url = 'http://127.0.0.1:31415';" },
      { lineNumber: 3, line: 'const path = "/* 31415 */";' },
      { lineNumber: 5, line: 'const escaped = "text \\" // 31415";' },
    ]);
  });

  test('scans template interpolation as code and ignores its comments, including nested templates', () => {
    expect(scanDaemonPortSource([
      'const value = `${',
      '  // 31415',
      '  80',
      '}`;',
      'const mixed = `${{ key: 31415 /* 31415 */ }.key}`;',
      'const nested = `${`inner ${',
      '  /* 31415',
      '   * 31415 */',
      '  80',
      '}`}`;',
      'const after = `port 31415`;',
    ].join('\n'))).toEqual([
      { lineNumber: 5, line: 'const mixed = `${{ key: 31415 /* 31415 */ }.key}`;' },
      { lineNumber: 11, line: 'const after = `port 31415`;' },
    ]);
  });

  test('walks only non-test src/**/*.ts, including nested paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-port-scan-'));
    try {
      mkdirSync(join(root, 'src', 'nested'), { recursive: true });
      mkdirSync(join(root, 'scripts'));
      writeFileSync(join(root, 'src', 'nested', 'live.ts'), 'const port = 31415;\n');
      writeFileSync(join(root, 'src', 'nested', 'live.test.ts'), 'const port = 31415;\n');
      writeFileSync(join(root, 'src', 'nested', 'live.spec.ts'), 'const port = 31415;\n');
      writeFileSync(join(root, 'scripts', 'outside.ts'), 'const port = 31415;\n');
      expect([...scanDaemonPorts(root)]).toEqual([['src/nested/live.ts', [{ lineNumber: 1, line: 'const port = 31415;' }]]]);
    } finally { rmSync(root, { force: true, recursive: true }); }
  });

  test('measured per-file baseline renders and parses without losing counts', () => {
    const entries = new Map([['src/b.ts', 2], ['src/a.ts', 1]]);
    const text = renderDaemonPortBaseline(entries);
    expect(text).toContain('# total=3 files=2');
    expect([...readDaemonPortBaseline(text)]).toEqual([['src/a.ts', 1], ['src/b.ts', 2]]);
    expect(() => readDaemonPortBaseline('not a baseline row\n')).toThrow('Invalid daemon port baseline row');
  });

  test('fails increases and new files with file:line and resolver remediation; allows reductions', () => {
    const file = 'src/nested/live.ts';
    const extra = 'src/new.ts';
    const scanned = new Map([
      [file, [{ lineNumber: 4, line: 'port = 31415' }, { lineNumber: 8, line: 'other = 31415' }]],
      [extra, [{ lineNumber: 3, line: 'port = 31415' }]],
    ]);
    const errors: string[] = [];
    expect(runDaemonPortGate({ args: [], scan: () => scanned, loadBaseline: () => new Map([[file, 1]]), log: () => {}, error: s => errors.push(s) })).toBe(1);
    expect(errors.join('\n')).toContain('src/nested/live.ts: 1 → 2');
    expect(errors.join('\n')).toContain('src/nested/live.ts:8: other = 31415');
    expect(errors.join('\n')).toContain('src/new.ts: 0 → 1');
    expect(errors.join('\n')).toContain('src/new.ts:3: port = 31415');
    expect(errors.join('\n')).toContain('resolveDaemonEndpoint');
    expect(runDaemonPortGate({ args: [], scan: () => new Map([[file, scanned.get(file)!.slice(0, 1)]]), loadBaseline: () => new Map([[file, 2]]), log: () => {}, error: () => {} })).toBe(0);
  });

  test('rejects --changed-files with and without paths instead of bypassing the full gate', () => {
    const scan = () => new Map([['src/outside.ts', [{ lineNumber: 1, line: '31415' }]]]);
    const errors: string[] = [];
    const io = { scan, loadBaseline: () => new Map<string, number>(), log: () => {}, error: (s: string) => errors.push(s) };
    expect(runDaemonPortGate({ ...io, args: ['--changed-files'] })).toBe(1);
    expect(runDaemonPortGate({ ...io, args: ['--changed-files', 'src/mine.ts'] })).toBe(1);
    expect(runDaemonPortGate({ ...io, args: ['--changed-files', 'src/mine.ts', '--update'] })).toBe(1);
    expect(errors.join('\n')).toContain('only --update is supported');
    expect(runDaemonPortGate({ ...io, args: [] })).toBe(1);
    expect(errors.join('\n')).toContain('src/outside.ts:1: 31415');
  });

  test('--update writes the measured full baseline in the injected cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-port-update-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(join(root, 'scripts'));
      writeFileSync(join(root, 'src', 'live.ts'), 'const port = 31415;\n');
      const errors: string[] = [];
      expect(runDaemonPortGate({ args: [], cwd: root, log: () => {}, error: s => errors.push(s) })).toBe(1);
      expect(errors.join('\n')).toContain('missing baseline');
      expect(runDaemonPortGate({ args: ['--update'], cwd: root, log: () => {}, error: () => {} })).toBe(0);
      expect(readDaemonPortBaseline(readFileSync(join(root, 'scripts', 'daemon-port-baseline.txt'), 'utf8')).get('src/live.ts')).toBe(1);
      expect(runDaemonPortGate({ args: [], cwd: root, log: () => {}, error: () => {} })).toBe(0);
    } finally { rmSync(root, { force: true, recursive: true }); }
  });

  test('checked-in measured baseline matches this worktree', () => {
    const actual = new Map([...scanDaemonPorts()].map(([file, hits]) => [file, hits.length]));
    const baseline = readDaemonPortBaseline(readFileSync(join(import.meta.dir, 'daemon-port-baseline.txt'), 'utf8'));
    expect([...actual].sort(([a], [b]) => a.localeCompare(b))).toEqual([...baseline].sort(([a], [b]) => a.localeCompare(b)));
    const logs: string[] = [];
    expect(runDaemonPortGate({ args: [], log: s => logs.push(s), error: s => logs.push(s) })).toBe(0);
    expect(logs.join('\n')).toContain('[daemon-port-gate] PASS');
  });
});
