import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

interface ChangedPath { path: string; previousPath?: string }
type Snapshot = 'index' | 'worktree';

function runGit(args: string[], cwd = process.cwd()): string {
  return execFileSync('git', args, { encoding: 'utf8', cwd });
}

function baseSha(): string {
  const base = runGit(['merge-base', 'HEAD', 'origin/main']).trim();
  if (!base) throw new Error('cannot measure refactor radius without origin/main merge-base');
  return base;
}

function parseNameStatus(output: string): ChangedPath[] {
  const fields = output.split('\0');
  const paths: ChangedPath[] = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const status = fields[i++]!;
    const first = fields[i++]!;
    if (status.startsWith('D')) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      paths.push({ previousPath: first, path: fields[i++]! });
    } else paths.push({ path: first });
  }
  return paths;
}

function snapshotSource(path: string, snapshot: Snapshot, cwd = process.cwd()): string | null {
  if (snapshot === 'worktree') return existsSync(join(cwd, path)) ? readFileSync(join(cwd, path), 'utf8') : null;
  try { return runGit(['show', `:${path}`], cwd); } catch { return null; }
}

function changedSourcePaths(base: string, cwd = process.cwd(), snapshot: Snapshot = 'worktree'): ChangedPath[] {
  const changed = parseNameStatus(runGit(['diff', ...(snapshot === 'index' ? ['--cached'] : []),
    '--name-status', '-z', '-M', base, '--', 'src'], cwd));
  if (snapshot === 'worktree') {
    const tracked = new Set(changed.map((entry) => entry.path));
    for (const path of runGit(['ls-files', '--others', '--exclude-standard', '-z', '--', 'src'], cwd).split('\0').filter(Boolean)) {
      if (!tracked.has(path)) changed.push({ path });
    }
  }
  return changed.filter(({ path }) => /\.[cm]?tsx?$/.test(path) && snapshotSource(path, snapshot, cwd) !== null);
}

function sourceFile(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
}

function contractViolations(path: string, source: string): string[] {
  const file = sourceFile(path, source);
  return file.statements.flatMap((statement) => {
    if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) return [];
    if (ts.isExportDeclaration(statement) && (statement.isTypeOnly
      || (statement.exportClause && ts.isNamedExports(statement.exportClause)
        && statement.exportClause.elements.every((element) => element.isTypeOnly)))) return [];
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return [];
    if (ts.isModuleDeclaration(statement) && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return [];
    return [`${path}:${file.getLineAndCharacterOfPosition(statement.getStart(file)).line + 1}`];
  });
}

function exportStarSpecifiers(path: string, source: string): string[] {
  return sourceFile(path, source).statements.flatMap((statement) => ts.isExportDeclaration(statement)
    && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
    && (!statement.exportClause || ts.isNamespaceExport(statement.exportClause))
    ? [statement.moduleSpecifier.text] : []);
}

function staticValueImports(path: string, source: string): string[] {
  return sourceFile(path, source).statements.flatMap((statement) => ts.isImportDeclaration(statement)
    && !statement.importClause?.isTypeOnly && ts.isStringLiteral(statement.moduleSpecifier)
    ? [statement.moduleSpecifier.text] : []);
}

function previousSource(base: string, path?: string, cwd = process.cwd()): string {
  if (!path) return '';
  try { return runGit(['show', `${base}:${path}`], cwd); } catch { return ''; }
}

function addedItems(current: string[], previous: string[]): string[] {
  const remaining = [...previous];
  return current.filter((item) => {
    const index = remaining.indexOf(item);
    if (index >= 0) { remaining.splice(index, 1); return false; }
    return true;
  });
}

test('new or changed contract modules have no runtime statements', () => {
  const base = baseSha();
  const paths = (['index', 'worktree'] as const).flatMap((snapshot) =>
    changedSourcePaths(base, process.cwd(), snapshot).map((entry) => ({ ...entry, snapshot })));
  console.log(`[refactor-radius] changed source snapshots=${paths.length}; zero means source rule unmeasured`);
  const violations = paths.filter(({ path }) => /(?:^|\/)(?:contract|[^/]+\.contract)\.[cm]?tsx?$/.test(path))
    .flatMap(({ path, snapshot }) => contractViolations(path, snapshotSource(path, snapshot)!));
  expect(violations).toEqual([]);
});

test('new export-star barrels are absent from changed source', () => {
  const base = baseSha();
  const violations = (['index', 'worktree'] as const).flatMap((snapshot) =>
    changedSourcePaths(base, process.cwd(), snapshot).flatMap(({ path, previousPath }) =>
      addedItems(exportStarSpecifiers(path, snapshotSource(path, snapshot)!),
        exportStarSpecifiers(previousPath ?? path, previousSource(base, previousPath ?? path)))
        .map((specifier) => `${snapshot}:${path}:${specifier}`)));
  expect(violations).toEqual([]);
});

function cliViolations(base: string, cwd = process.cwd()): string[] {
  const violations: string[] = [];
  for (const snapshot of ['index', 'worktree'] as const) {
    for (const { path, previousPath } of changedSourcePaths(base, cwd, snapshot)
      .filter(({ path }) => path === 'src/index.ts' || path.startsWith('src/cli/'))) {
      const current = staticValueImports(path, snapshotSource(path, snapshot, cwd)!);
      // Moving a module into the CLI entry tree makes all its value imports
      // new CLI edges, even when the source bytes did not change.
      const wasCli = !previousPath || previousPath === 'src/index.ts' || previousPath.startsWith('src/cli/');
      const previous = wasCli ? staticValueImports(previousPath ?? path,
        previousSource(base, previousPath ?? path, cwd)) : [];
      for (const specifier of addedItems(current, previous)) {
        if (/(?:^|\/)(?:tui|dashboard)(?:\/|$)|^(?:ink|react)(?:\/|$)/.test(specifier)) {
          violations.push(`${snapshot}:${path}:${specifier}`);
        }
      }
    }
  }
  return violations;
}

test('CLI entry adds no eager TUI, dashboard, Ink, or React imports', () => {
  expect(cliViolations(baseSha())).toEqual([]);
});

test('guard handles staged and unstaged status, rename, and delete records', () => {
  expect(parseNameStatus('M\0src/a.ts\0R100\0src/old.ts\0src/new.ts\0D\0src/gone.ts\0'))
    .toEqual([{ path: 'src/a.ts' }, { previousPath: 'src/old.ts', path: 'src/new.ts' }]);
});

test('worktree diff includes committed, staged, unstaged, renamed, and untracked source', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'refactor-radius-git-'));
  try {
    runGit(['init', '-q'], cwd);
    mkdirSync(join(cwd, 'src'));
    for (const name of ['a.ts', 'old.ts', 'gone.ts', 'staged.ts', 'unstaged.ts']) {
      writeFileSync(join(cwd, 'src', name), `export type ${name.split('.')[0]} = string;\n`);
    }
    runGit(['add', 'src'], cwd);
    runGit(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base'], cwd);
    const base = runGit(['rev-parse', 'HEAD'], cwd).trim();
    writeFileSync(join(cwd, 'src/untracked.ts'), 'export type U = number;\n');
    expect(changedSourcePaths(base, cwd)).toEqual([{ path: 'src/untracked.ts' }]);
    writeFileSync(join(cwd, 'src/committed.ts'), 'export type Committed = string;\n');
    runGit(['add', 'src/committed.ts'], cwd);
    runGit(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'after base'], cwd);
    runGit(['mv', 'src/old.ts', 'src/new.ts'], cwd);
    runGit(['rm', '-q', 'src/gone.ts'], cwd);
    writeFileSync(join(cwd, 'src/a.ts'), 'export type A = number;\n');
    writeFileSync(join(cwd, 'src/staged.ts'), 'export type Staged = number;\n');
    runGit(['add', 'src/staged.ts'], cwd);
    writeFileSync(join(cwd, 'src/unstaged.ts'), 'export type Unstaged = number;\n');
    expect(changedSourcePaths(base, cwd)).toEqual([
      { path: 'src/a.ts' },
      { path: 'src/committed.ts' },
      { previousPath: 'src/old.ts', path: 'src/new.ts' },
      { path: 'src/staged.ts' },
      { path: 'src/unstaged.ts' },
      { path: 'src/untracked.ts' },
    ]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('staged violation survives worktree revert and external-to-CLI rename adds its imports', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'refactor-radius-cli-'));
  try {
    runGit(['init', '-q'], cwd);
    mkdirSync(join(cwd, 'src/cli'), { recursive: true });
    writeFileSync(join(cwd, 'src/cli/entry.ts'), 'export {};\n');
    writeFileSync(join(cwd, 'src/other.ts'), "import '../tui/entry';\n");
    runGit(['add', 'src'], cwd);
    runGit(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base'], cwd);
    const base = runGit(['rev-parse', 'HEAD'], cwd).trim();
    writeFileSync(join(cwd, 'src/cli/entry.ts'), "import '../tui/entry';\n");
    runGit(['add', 'src/cli/entry.ts'], cwd);
    writeFileSync(join(cwd, 'src/cli/entry.ts'), 'export {};\n');
    runGit(['mv', 'src/other.ts', 'src/cli/other.ts'], cwd);
    expect(cliViolations(base, cwd)).toEqual([
      'index:src/cli/entry.ts:../tui/entry',
      'index:src/cli/other.ts:../tui/entry',
      'worktree:src/cli/other.ts:../tui/entry',
    ]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('AST catches multiline export-star barrels while preserving unchanged renamed exports', () => {
  expect(exportStarSpecifiers('sample.ts', 'export *\n from "./impl";\nexport * as ns\n from "./other";'))
    .toEqual(['./impl', './other']);
  expect(addedItems(['./impl'], ['./impl'])).toEqual([]);
  expect(addedItems(['./impl', './impl'], ['./impl'])).toEqual(['./impl']);
});

test('contract guard rejects value imports and implementation', () => {
  expect(contractViolations('sample.contract.ts', 'import { x } from "./x";\nexport const y = x;')).toHaveLength(2);
  expect(contractViolations('sample.contract.ts', 'import type { X } from "./x";\nexport type Y = X;')).toEqual([]);
});
