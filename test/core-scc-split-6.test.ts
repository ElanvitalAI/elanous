import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const repo = resolve(import.meta.dir, '..');
const prompts = 'src/models/prompts.ts';
const leaf = 'src/skills/skill-tier.ts';
const runnerImport = '../skills/runner.js';

function importSpecifiers(source: string): string[] {
  const imports = ts.preProcessFile(source, true, true).importedFiles.map((file) => file.fileName);
  const typeQueries = [...source.matchAll(/\btypeof\s+import\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g)]
    .map((match) => match[2]!);
  return [...new Set([...imports, ...typeQueries])];
}

function source(path: string): string {
  return readFileSync(resolve(repo, path), 'utf8');
}

function repositorySrcFiles(root: string): string[] {
  const result = spawnSync(resolve(repo, 'node_modules/.bin/tsc'), [
    '--listFilesOnly', '--noEmit', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'ESNext', '--moduleResolution', 'bundler', '--types', 'bun-types', root,
  ], { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 90_000 });
  if (result.status !== 0) {
    throw new Error(`tsc --listFilesOnly ${root}: ${result.error ?? (result.stderr || result.stdout)}`);
  }
  return [...new Set(result.stdout.split(/\r?\n/)
    .filter((line) => resolve(repo, line).startsWith(resolve(repo, 'src') + sep) && line.endsWith('.ts'))
    .map((line) => relative(repo, resolve(repo, line))))];
}

// LF-2 removes the old user-config imports; its SkillTier leaf import is harmless.
const preLf2Imports = importSpecifiers(source('src/user-config.ts'))
  .filter((path) => path.startsWith('.') && ![
    './config.js', './debug/log.js', './log-entry.js', './skills/skill-tier.js',
  ].includes(path));

describe('CORE-SCC-SPLIT-6', () => {
  test('prompts imports the leaf, never the skill runner (including typeof imports)', () => {
    const imports = importSpecifiers(source(prompts));
    expect(imports).toContain('../skills/skill-tier.js');
    expect(imports.filter((path) => path === runnerImport)).toHaveLength(0);
  });

  test('forbidden-import detector catches both injected import forms', () => {
    const original = source(prompts);
    expect(importSpecifiers("import type { SkillTier } from '../skills/runner.js';\n" + original)
      .filter((path) => path === runnerImport)).toHaveLength(1);
    expect(importSpecifiers("type Runner = typeof import('../skills/runner.js');\n" + original)
      .filter((path) => path === runnerImport)).toHaveLength(1);
  });

  test('SkillTier is an import-free leaf with exactly one standalone repository src file', () => {
    expect(importSpecifiers(source(leaf))).toHaveLength(0);
    expect(source(leaf).trim()).toBe("export type SkillTier = 'T3' | 'T2' | 'T1';");
    const files = repositorySrcFiles(leaf);
    console.log(`${leaf}: ${files.length} repository src file(s)`);
    expect(files).toEqual([leaf]);
  });

  test('runner retains the SkillTier type re-export', () => {
    expect(source('src/skills/runner.ts')).toContain("export type { SkillTier } from './skill-tier.js';");
  });

  if (preLf2Imports.length) {
    const reason = `LF-2 not landed: ${prompts} still reaches user-config via ${preLf2Imports[0]}; prompts reachability skipped`;
    console.log(reason);
    test.skip(reason, () => {});
  } else {
    test('prompts standalone tsc reaches at most 80 repository src files after LF-2', () => {
      const files = repositorySrcFiles(prompts);
      console.log(`${prompts}: ${files.length} repository src files (limit 80)`);
      expect(files.length, `${prompts}: ${files.length} > 80; first path: ${files.find((file) => file !== prompts) ?? files[0] ?? '(none)'}`)
        .toBeLessThanOrEqual(80);
    });
  }
});
