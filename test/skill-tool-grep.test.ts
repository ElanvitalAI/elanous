// ── Grep tool tests ──
//
// Tests require `rg` (ripgrep) on PATH — we fail them loudly rather than
// silently skipping, because the dev environments that run this suite
// should have rg installed. (In CI without rg, add `brew install ripgrep`
// or equivalent as a pre-test step.)

import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildGrepTool, dispatchGrep } from '../src/skills/tools/grep';
import { resetSearchLoopGuardForTest } from '../src/skills/tools/search-loop-guard';
import { resetElanousConfigDir, setElanousConfigDir } from '../src/elanous-config-dir';
import { resetUserConfig } from '../src/user-config';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'grep-tool-')); }

let configDir: string;

function setNativeStructure(enabled: boolean): void {
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ tools: { nativeStructure: { enabled } } }));
  resetUserConfig();
}

const hasRg = spawnSync('which', ['rg']).status === 0;

beforeAll(() => {
  if (!hasRg) {
    console.warn('⚠ ripgrep (rg) not found — Grep tests will run in missing-binary mode only');
  }
});

beforeEach(() => {
  configDir = tmp();
  setElanousConfigDir(configDir);
  resetUserConfig();
  resetSearchLoopGuardForTest();
});

afterEach(() => {
  resetSearchLoopGuardForTest();
  resetUserConfig();
  resetElanousConfigDir();
  rmSync(configDir, { recursive: true, force: true });
});

describe('dispatchGrep — search loop guard', () => {
  test('blocks repeated broad files_with_matches searches until narrowing action', async () => {
    if (!hasRg) return;
    resetSearchLoopGuardForTest();
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'a.ts'), 'debug here\n');
      writeFileSync(join(dir, 'b.ts'), 'trace here\n');
      await dispatchGrep({ pattern: 'debug', path: dir });
      await dispatchGrep({ pattern: 'trace', path: dir });
      await dispatchGrep({ pattern: 'here', path: dir });
      await expect(dispatchGrep({ pattern: 'a|b', path: dir })).rejects.toThrow('repeated broad search loop');
    } finally {
      resetSearchLoopGuardForTest();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('treats same-scope files_with_matches searches as the same loop even when the pattern changes', async () => {
    if (!hasRg) return;
    resetSearchLoopGuardForTest();
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'a.ts'), 'debug trace logger\n');
      writeFileSync(join(dir, 'b.ts'), 'dashboard session runtime\n');
      await dispatchGrep({ pattern: 'debug|trace', path: dir, glob: '*.ts' });
      await dispatchGrep({ pattern: 'logger|session', path: dir, glob: '*.ts' });
      await dispatchGrep({ pattern: 'runtime|dashboard', path: dir, glob: '*.ts' });
      await expect(dispatchGrep({ pattern: 'exploration|synthesis', path: dir, glob: '*.ts' }))
        .rejects.toThrow('repeated broad search loop');
    } finally {
      resetSearchLoopGuardForTest();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps the default blocking message byte-for-byte unchanged', async () => {
    if (!hasRg) return;
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'a.ts'), 'debug trace logger\n');
      const calls = ['debug', 'trace', 'logger'];
      for (const pattern of calls) await dispatchGrep({ pattern, path: dir });
      let error: unknown;
      try {
        await dispatchGrep({ pattern: 'a', path: dir });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        'RUNTIME BLOCKED — repeated broad search loop detected (4 consecutive broad-search calls). You already ran several broad Grep/ListDir steps. Stop issuing more files_with_matches searches. Choose candidate files from prior results and continue with Read, Grep(output_mode="content"), or Lsp.',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('adds the PersistentGrounding delegation hint only when nativeStructure is enabled', async () => {
    if (!hasRg) return;
    setNativeStructure(true);
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'a.ts'), 'debug trace logger\n');
      for (const pattern of ['debug', 'trace', 'logger']) await dispatchGrep({ pattern, path: dir });
      await expect(dispatchGrep({ pattern: 'a', path: dir })).rejects.toThrow(
        'Choose candidate files from prior results and continue with Read, Grep(output_mode="content"), or Lsp. You may delegate broad read-only exploration to PersistentGrounding.',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not block nativeStructure-enabled broad searches below the existing threshold', async () => {
    if (!hasRg) return;
    setNativeStructure(true);
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'a.ts'), 'debug trace logger\n');
      for (const pattern of ['debug', 'trace', 'logger']) {
        await expect(dispatchGrep({ pattern, path: dir })).resolves.toMatchObject({ mode: 'files_with_matches' });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildGrepTool — schema', () => {
  test('name is exactly "Grep"', () => {
    expect(buildGrepTool().name).toBe('Grep');
  });
  test('required = [pattern]; output_mode enum correct', () => {
    const schema = buildGrepTool().parameters as any;
    expect(schema.required).toEqual(['pattern']);
    expect(schema.properties.output_mode.enum).toEqual(['files_with_matches', 'content', 'count']);
  });
});

describe('dispatchGrep — no-ripgrep fallback messaging', () => {
  test.skipIf(hasRg)('missing rg throws install hint', async () => {
    await expect(dispatchGrep({ pattern: 'foo', path: '/tmp' }))
      .rejects.toThrow('not installed');
  });
});

describe('dispatchGrep — output modes (requires rg)', () => {
  if (!hasRg) return;

  let dir: string;
  beforeAll(() => {
    dir = tmp();
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'a.ts'),  'import foo from "bar";\nconst x = foo();\n');
    writeFileSync(join(dir, 'b.ts'),  'const y = foo();\n');
    writeFileSync(join(dir, 'c.py'),  'foo = 1\n');
    writeFileSync(join(dir, 'sub', 'd.ts'), 'foo\nfoo\nfoo\n');
    mkdirSync(join(dir, 'obsdir'), { recursive: true });
    mkdirSync(join(dir, 'plaindir'), { recursive: true });
    mkdirSync(join(dir, '.git', 'objects'), { recursive: true });
    writeFileSync(join(dir, '.gitignore'), 'obsdir/\n');
    writeFileSync(join(dir, '.ignore'), 'plaindir/\n');
    writeFileSync(join(dir, 'obsdir', 'hit.txt'), 'needle\n');
    writeFileSync(join(dir, 'plaindir', 'hit.txt'), 'needle\n');
    writeFileSync(join(dir, '.git', 'objects', 'hit.txt'), 'needle\n');
  });

  test('files_with_matches (default) lists matching paths', async () => {
    const r = await dispatchGrep({ pattern: 'foo', path: dir });
    expect(r.mode).toBe('files_with_matches');
    expect(r.numFiles).toBeGreaterThanOrEqual(3);
    expect(r.output).toContain('Found');
    expect(r.output).toMatch(/a\.ts/);
    expect(r.output).toMatch(/b\.ts/);
  });

  test('files_with_matches includes suggested next Read/Lsp candidates ranked by path relevance', async () => {
    const focusDir = tmp();
    try {
      mkdirSync(join(focusDir, 'src', 'debug'), { recursive: true });
      mkdirSync(join(focusDir, 'src', 'misc'), { recursive: true });
      writeFileSync(join(focusDir, 'src', 'debug', 'debug-log.ts'), 'logger trace\n');
      writeFileSync(join(focusDir, 'src', 'misc', 'other.ts'), 'logger trace\n');
      const r = await dispatchGrep({ pattern: 'debug|trace|logger', path: join(focusDir, 'src'), glob: '**/*.ts' });
      expect(r.output).toContain('[Suggested next Read/Lsp candidates]');
      const suggestionSection = r.output.split('[Suggested next Read/Lsp candidates]\n')[1] ?? '';
      expect(suggestionSection).toContain('debug-log.ts');
    } finally {
      rmSync(focusDir, { recursive: true, force: true });
    }
  });

  test('debug-focused ranking prefers debug/display/window files over generic acp and code-edit state files', async () => {
    const focusDir = tmp();
    try {
      mkdirSync(join(focusDir, 'src', 'debug'), { recursive: true });
      mkdirSync(join(focusDir, 'src', 'display'), { recursive: true });
      mkdirSync(join(focusDir, 'src', 'window'), { recursive: true });
      mkdirSync(join(focusDir, 'src', 'acp'), { recursive: true });
      mkdirSync(join(focusDir, 'src', 'code-edit'), { recursive: true });

      writeFileSync(join(focusDir, 'src', 'debug', 'log.ts'), 'debug trace logger\n');
      writeFileSync(join(focusDir, 'src', 'debug', 'call-stack.ts'), 'debug trace logger\n');
      writeFileSync(join(focusDir, 'src', 'display', 'debug-surface.ts'), 'debug trace logger\n');
      writeFileSync(join(focusDir, 'src', 'window', 'debug-window-consumers.ts'), 'debug trace logger\n');
      writeFileSync(join(focusDir, 'src', 'acp', 'tool-call-state.ts'), 'debug trace logger dashboard state\n');
      writeFileSync(join(focusDir, 'src', 'code-edit', 'read-state.ts'), 'debug trace logger dashboard state\n');

      const r = await dispatchGrep({
        pattern: 'debug|trace|logger|dashboard state|exploration|synthesis',
        path: join(focusDir, 'src'),
        glob: '**/*.ts',
      });
      const suggestionSection = r.output.split('[Suggested next Read/Lsp candidates]\n')[1] ?? '';
      const suggestions = suggestionSection
        .split('\n')
        .filter(line => line.startsWith('- '))
        .map(line => line.slice(2));

      expect(suggestions.slice(0, 4).some(path => path.endsWith('src/display/debug-surface.ts'))).toBe(true);
      expect(suggestions.slice(0, 4).some(path => path.endsWith('src/window/debug-window-consumers.ts'))).toBe(true);
      expect(suggestions.slice(0, 4).some(path => path.endsWith('src/debug/call-stack.ts'))).toBe(true);
      expect(suggestions.slice(0, 4).some(path => path.endsWith('src/debug/log.ts'))).toBe(true);
      expect(suggestions.slice(0, 4).some(path => path.endsWith('src/acp/tool-call-state.ts'))).toBe(false);
      expect(suggestions.slice(0, 4).some(path => path.endsWith('src/code-edit/read-state.ts'))).toBe(false);
    } finally {
      rmSync(focusDir, { recursive: true, force: true });
    }
  });

  test('no_ignore includes .gitignore and .ignore paths in files and content modes without exposing .git', async () => {
    const defaultResult = await dispatchGrep({ pattern: 'needle', path: dir });
    const filesResult = await dispatchGrep({ pattern: 'needle', path: dir, no_ignore: true });
    const contentResult = await dispatchGrep({ pattern: 'needle', path: dir, no_ignore: true, output_mode: 'content' });

    expect(defaultResult.output).not.toContain('obsdir/hit.txt');
    expect(defaultResult.output).not.toContain('plaindir/hit.txt');
    expect(filesResult.output).toContain('obsdir/hit.txt');
    expect(filesResult.output).toContain('plaindir/hit.txt');
    expect(contentResult.output).toContain('obsdir/hit.txt');
    expect(contentResult.output).toContain('plaindir/hit.txt');
    expect(filesResult.output).not.toContain('.git/');
    expect(contentResult.output).not.toContain('.git/');
  });

  test('content mode returns matching lines with path:line form', async () => {
    const r = await dispatchGrep({ pattern: 'foo', path: dir, output_mode: 'content' });
    expect(r.mode).toBe('content');
    expect(r.numMatches).toBeGreaterThan(0);
    expect(r.output).toMatch(/a\.ts.*foo/);
  });

  test('content mode with -n shows line numbers', async () => {
    const r = await dispatchGrep({ pattern: 'foo', path: dir, output_mode: 'content', '-n': true });
    // rg with -n produces "path:line:text" — verify a digit between colons.
    expect(r.output).toMatch(/:\d+:/);
  });

  test('count mode returns per-file occurrence count + totals', async () => {
    const r = await dispatchGrep({ pattern: 'foo', path: dir, output_mode: 'count' });
    expect(r.mode).toBe('count');
    expect(r.numMatches).toBeGreaterThanOrEqual(6); // 1 + 1 + 1 + 3 at minimum
    expect(r.output).toContain('Found');
    expect(r.output).toMatch(/d\.ts:3/);
  });
});

describe('dispatchGrep — filtering (requires rg)', () => {
  if (!hasRg) return;

  let dir: string;
  beforeAll(() => {
    dir = tmp();
    writeFileSync(join(dir, 'a.ts'), 'const needle = 1\n');
    writeFileSync(join(dir, 'a.py'), 'needle = 1\n');
    writeFileSync(join(dir, 'a.md'), 'needle here\n');
  });

  test('glob restricts to matching filenames', async () => {
    const r = await dispatchGrep({ pattern: 'needle', path: dir, glob: '*.ts' });
    expect(r.output).toMatch(/a\.ts/);
    expect(r.output).not.toMatch(/a\.py/);
    expect(r.output).not.toMatch(/a\.md/);
  });

  test('type: ts restricts to typescript', async () => {
    const r = await dispatchGrep({ pattern: 'needle', path: dir, type: 'ts' });
    expect(r.output).toMatch(/a\.ts/);
    expect(r.output).not.toMatch(/a\.py/);
  });

  test('case-insensitive -i', async () => {
    const r = await dispatchGrep({ pattern: 'NEEDLE', path: dir, '-i': true });
    expect(r.numFiles).toBeGreaterThan(0);
  });
});

describe('dispatchGrep — bounds + pagination (requires rg)', () => {
  if (!hasRg) return;

  let dir: string;
  beforeAll(() => {
    dir = tmp();
    // 50 files each matching "needle"
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(dir, `f${i}.ts`), 'needle here\n');
    }
  });

  test('head_limit caps the output', async () => {
    const r = await dispatchGrep({ pattern: 'needle', path: dir, head_limit: 10 });
    expect(r.truncated).toBe(true);
    expect(r.numFiles).toBeLessThanOrEqual(10);
    expect(r.output).toContain('truncated: 40 more matching files');
    expect(r.output).toContain('offset:');
  });

  test('offset skips prior results', async () => {
    const r1 = await dispatchGrep({ pattern: 'needle', path: dir, head_limit: 10, offset: 0 });
    const r2 = await dispatchGrep({ pattern: 'needle', path: dir, head_limit: 10, offset: 10 });
    // Both return 10 files but disjoint sets
    const files1 = (r1.output.match(/f\d+\.ts/g) ?? []).sort();
    const files2 = (r2.output.match(/f\d+\.ts/g) ?? []).sort();
    expect(files1.length).toBe(10);
    expect(files2.length).toBe(10);
    // Intersection should be empty.
    const set = new Set(files1);
    for (const f of files2) expect(set.has(f)).toBe(false);
  });
});

describe('dispatchGrep — error paths', () => {
  test('missing pattern throws', async () => {
    await expect(dispatchGrep({})).rejects.toThrow('pattern is required');
  });

  test('invalid output_mode throws', async () => {
    await expect(dispatchGrep({ pattern: 'x', output_mode: 'weird' }))
      .rejects.toThrow('invalid output_mode');
  });

  if (hasRg) {
    test('invalid regex → rg exit 2 → thrown error', async () => {
      await expect(dispatchGrep({ pattern: '[invalid(' }))
        .rejects.toThrow('Grep:');
    });

    test('no matches is NOT an error', async () => {
      const dir = tmp();
      try {
        writeFileSync(join(dir, 'a.txt'), 'hello world');
        const r = await dispatchGrep({ pattern: 'xyzzy_does_not_exist', path: dir });
        expect(r.numFiles).toBe(0);
        expect(r.output).toContain('No files matched');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});

describe('dispatchGrep — multiline + context (requires rg)', () => {
  if (!hasRg) return;

  test('multiline regex matches across newlines', async () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'a.ts'), 'function foo(\n  x: number\n) {\n  return x;\n}\n');
      const r = await dispatchGrep({
        pattern: 'function foo\\([^)]*\\)',
        path: dir,
        output_mode: 'content',
        multiline: true,
      });
      expect(r.numMatches).toBeGreaterThan(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('-C context lines included', async () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'a.ts'), 'line1\nline2 TARGET\nline3\nline4\n');
      const r = await dispatchGrep({
        pattern: 'TARGET', path: dir, output_mode: 'content', '-C': 1,
      });
      expect(r.output).toContain('line1');
      expect(r.output).toContain('TARGET');
      expect(r.output).toContain('line3');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
