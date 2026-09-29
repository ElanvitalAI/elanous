import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { DECLARATIVE_KINDS, listDeclarativeFiles, resolveDeclarativeSources } from '../plugin-declarative/discovery.js';
import { scaffoldProject } from './project-scaffold.js';

const directories: string[] = [];
const createDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'project-scaffold-'));
  directories.push(directory);
  return directory;
};
const paths = (root: string) => [
  join(root, '.elanous', 'project.json'),
  join(root, 'AGENTS.md'),
  join(root, 'DESIGN.md'),
  join(root, 'docs', 'PLAN.md'),
  join(root, 'docs', 'SPEC.md'),
];
const successfulGit = () => ({ status: 0, stdout: '', stderr: '' });
const realFs = { lstatSync, mkdirSync, realpathSync, writeFileSync };
const repositoryRoot = join(import.meta.dir, '..', '..');
const craftRulebooksDirectory = join(repositoryRoot, 'docs', 'design', 'craft');
const designSeedPath = join(repositoryRoot, 'src', 'self-implement', 'project-scaffold.ts');

const NON_RULEBOOK_MARKDOWN_FILENAMES = new Set(['NOTICE.md', 'LICENSE.md', 'README.md']);

type CraftRulebookSeedDriftCheck =
  | { status: 'checked' }
  | { status: 'skipped'; reason: string };

function deriveCraftRulebookSlugs(entries: readonly string[]): string[] {
  return entries
    .filter((name) => name.endsWith('.md') && !NON_RULEBOOK_MARKDOWN_FILENAMES.has(name))
    .map((name) => name.slice(0, -'.md'.length));
}

function extractScaffoldCraftRulebookSlugs(source: string): string[] {
  const seed = source.match(/\[\['DESIGN\.md'\], '([^']*)'\]/)?.[1];
  if (!seed) throw new Error('SCAFFOLD_FILES has no DESIGN.md seed.');
  return seed.replaceAll('\\n', '\n')
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice('- '.length));
}

function assertCraftRulebookSlugsMatch(authoritative: readonly string[], seed: readonly string[]): void {
  const authoritativeOnly = authoritative.filter((slug) => !seed.includes(slug));
  const seedOnly = seed.filter((slug) => !authoritative.includes(slug));
  if (authoritativeOnly.length || seedOnly.length) {
    throw new Error(
      `Craft rulebook seed drift: authoritative-only: ${authoritativeOnly.join(', ') || '(none)'}; seed-only: ${seedOnly.join(', ') || '(none)'}.`,
    );
  }
}

function checkCraftRulebookSeedDrift(directory = craftRulebooksDirectory, source = designSeedPath): CraftRulebookSeedDriftCheck {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    const reason = `Skipping Craft rulebook seed drift check: cannot read ${directory}: ${(error as Error).message}`;
    console.warn(reason);
    return { status: 'skipped', reason };
  }

  assertCraftRulebookSlugsMatch(
    deriveCraftRulebookSlugs(entries),
    extractScaffoldCraftRulebookSlugs(readFileSync(source, 'utf8')),
  );
  return { status: 'checked' };
}

function extractProjectDocumentDirectoryPaths(seed: string): string[] {
  const section = seed.match(/## Project documents\n([\s\S]*?)(?:\n## |$)/)?.[1];
  if (!section) throw new Error('AGENTS.md seed has no Project documents section.');
  return [...section.matchAll(/^- `([^`]+)`:/gm)]
    .map((match) => match[1])
    .filter((path) => path.startsWith('docs/') && !path.endsWith('.md'));
}

function assertScaffoldDirectoriesMatchProjectDocuments(directories: readonly string[], documents: readonly string[]): void {
  const directoryOnly = directories.filter((path) => !documents.includes(path));
  const seedOnly = documents.filter((path) => !directories.includes(path));
  if (directoryOnly.length || seedOnly.length) {
    throw new Error(
      `Project document scaffold drift: directory-only: ${directoryOnly.join(', ') || '(none)'}; seed-only: ${seedOnly.join(', ') || '(none)'}.`,
    );
  }
}

function scaffoldDocumentDirectories(root: string, created: readonly string[]): string[] {
  return created
    .map((path) => relative(root, path).split(sep).join('/'))
    .filter((path) => path.startsWith('docs/') && !path.endsWith('.md'));
}

const agentsSeed = `# Project instructions

## Project description
<!-- Owner: describe this project in one line. Agents working in this repository read it and may guess when it is empty; the harness gate does not read it, using commands from the project manifest. -->

## Build command
<!-- Owner: add the build command. Agents working in this repository read it and may guess when it is empty; the harness gate does not read it, using commands from the project manifest. -->

## Test command
<!-- Owner: add the test command. Agents working in this repository read it and may guess when it is empty; the harness gate does not read it, using commands from the project manifest. For gate-driven tests, add a test script to the project manifest (for example, \`npm test\`). -->

## Project documents
- \`docs/goals\`: goal documents.
- \`DESIGN.md\`: design document.
- \`docs/PLAN.md\`: project plan.
- \`docs/SPEC.md\`: project specification.
`;

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('scaffoldProject', () => {
  test('provisions a non-git target through the injected git runner and records every scaffold path', () => {
    const directory = createDirectory();
    const calls: string[][] = [];
    const result = scaffoldProject(directory, { home: tmpdir(), runGit: (_cwd, args) => { calls.push(args); return successfulGit(); } });

    expect(result.status).toBe('provisioned');
    if (result.status === 'not-applicable') throw new Error('expected provisioned scaffold');
    expect(result.ignoreFile).toEqual({ added: 31, preserved: 0, created: true });
    expect(calls).toContainEqual(['init']);
    expect(result.created).toEqual(expect.arrayContaining(paths(result.target)));
    expect(result.created).toEqual(expect.arrayContaining([join(result.target, '.elanous'), join(result.target, 'docs', 'goals')]));
    expect(result.created).not.toContain(join(result.target, 'docs', 'pdca'));
    expect(result.created.length).toBeGreaterThan(0);
    expect(readFileSync(join(result.target, '.elanous', 'project.json'), 'utf8')).toBe('{\n  "kind": "project"\n}\n');
    expect(readFileSync(join(result.target, 'AGENTS.md'), 'utf8')).toBe(agentsSeed);
  });

  test('keeps scaffold document directories aligned with AGENTS.md project documents', () => {
    const directory = createDirectory();
    const result = scaffoldProject(directory, { home: tmpdir(), runGit: successfulGit });
    if (result.status === 'not-applicable') throw new Error('expected provisioned scaffold');

    assertScaffoldDirectoriesMatchProjectDocuments(
      scaffoldDocumentDirectories(result.target, result.created),
      extractProjectDocumentDirectoryPaths(readFileSync(join(result.target, 'AGENTS.md'), 'utf8')),
    );
  });

  test('reports directory-only and seed-only project document drift', () => {
    expect(() => assertScaffoldDirectoriesMatchProjectDocuments(['docs/directory-only'], ['docs/seed-only']))
      .toThrow('directory-only: docs/directory-only; seed-only: docs/seed-only');
  });

  test('writes one visible Craft rulebook access instruction without changing scaffold paths', () => {
    const directory = createDirectory();
    const result = scaffoldProject(directory, { home: tmpdir(), runGit: successfulGit });
    if (result.status === 'not-applicable') throw new Error('expected provisioned scaffold');

    expect(result.created).toEqual(expect.arrayContaining(paths(result.target)));
    const design = readFileSync(join(result.target, 'DESIGN.md'), 'utf8');
    const section = design.match(/## Craft rulebooks\n\n([^\n]+)\n\n-/);
    expect(section?.[1]).toBe('These rulebooks travel with elanous and are not stored in this project; run `elanous repo design-check` to locate the `Craft rulebooks directory`.');
    expect(section?.[1]).not.toContain('<!--');
  });

  function expectCraftRulebookSeedDriftCheckToPass(result: CraftRulebookSeedDriftCheck): void {
    if (result.status === 'skipped') {
      expect(result.reason).toContain('Skipping Craft rulebook seed drift check: cannot read');
      return;
    }
    expect(result).toEqual({ status: 'checked' });
  }

  test('keeps the scaffold rulebook slugs aligned with readable authoritative rulebooks', () => {
    expectCraftRulebookSeedDriftCheckToPass(checkCraftRulebookSeedDrift());
  });

  test('treats an unavailable authoritative directory as a visible successful drift-check skip', () => {
    const warning = console.warn;
    const warnings: string[] = [];
    console.warn = (message: string) => { warnings.push(message); };
    try {
      expectCraftRulebookSeedDriftCheckToPass(checkCraftRulebookSeedDrift(join(createDirectory(), 'missing')));
    } finally {
      console.warn = warning;
    }
    expect(warnings).toEqual([expect.stringContaining('Skipping Craft rulebook seed drift check: cannot read')]);
  });

  test('excludes notice, license, and readme markdown documents from authoritative rulebooks', () => {
    expect(deriveCraftRulebookSlugs(['rulebook.md', 'NOTICE.md', 'LICENSE.md', 'README.md', 'LICENSE', 'notes.txt']))
      .toEqual(['rulebook']);
  });

  test('reports authoritative-only and seed-only Craft rulebook drift', () => {
    expect(() => assertCraftRulebookSlugsMatch(['authoritative-only'], ['seed-only']))
      .toThrow('authoritative-only: authoritative-only; seed-only: seed-only');
  });

  test('makes every owner-guidance comment agent-facing rather than a harness gate input', () => {
    for (const heading of ['Project description', 'Build command', 'Test command']) {
      const section = agentsSeed.match(new RegExp(`## ${heading}\\n(<!--[^\\n]+-->)`));
      expect(section?.[1]).toContain('Agents working in this repository read it');
      expect(section?.[1]).toContain('may guess when it is empty');
      expect(section?.[1]).toContain('the harness gate does not read it');
      expect(section?.[1]).toContain('commands from the project manifest');
      expect(section?.[1]?.split('\n')).toHaveLength(1);
    }
    const testGuidance = agentsSeed.match(/## Test command\n(<!--[^\n]+-->)/)?.[1];
    expect(testGuidance).toContain('add a test script to the project manifest');
    expect(testGuidance).toContain('for example, `npm test`');
  });

  test('preserves the already-git status while adding the scaffold and promotion-equivalent ignores', () => {
    const directory = createDirectory();
    mkdirSync(join(directory, '.git'));
    writeFileSync(join(directory, '.gitignore'), 'human-rule/\n');
    const result = scaffoldProject(directory, { home: tmpdir() });

    expect(result.status).toBe('already-git');
    if (result.status === 'not-applicable') throw new Error('expected already-git scaffold');
    expect(result.ignoreFile).toEqual({ added: 31, preserved: 1, created: false });
    expect(result.created).toEqual(expect.arrayContaining(paths(result.target)));
    expect(result.created).toEqual(expect.arrayContaining([join(result.target, '.elanous'), join(result.target, 'docs', 'goals')]));
    expect(result.created).not.toContain(join(result.target, 'docs', 'pdca'));
    const ignored = readFileSync(join(directory, '.gitignore'), 'utf8').split('\n');
    expect(ignored).toEqual(expect.arrayContaining(['human-rule/', '.elanous/', '.elanous-test/']));
  });

  test('stops without filesystem writes for a non-applicable target', () => {
    const missing = join(tmpdir(), `project-scaffold-missing-${crypto.randomUUID()}`);
    const result = scaffoldProject(missing, { home: tmpdir() });

    expect(result).toMatchObject({ status: 'not-applicable', reason: 'missing', created: [], existing: [] });
    expect(existsSync(join(missing, '.elanous'))).toBe(false);
  });

  test('preserves an existing scaffold file and reports it by path', () => {
    const directory = createDirectory();
    const existing = join(directory, 'DESIGN.md');
    writeFileSync(existing, 'keep this design\n');
    const result = scaffoldProject(directory, { home: tmpdir(), runGit: successfulGit });

    expect(readFileSync(existing, 'utf8')).toBe('keep this design\n');
    expect(result.existing).toContain(join(realpathSync(directory), 'DESIGN.md'));
    expect(result.existing.length).toBeGreaterThan(0);
  });

  test('treats atomic EEXIST during creation as an existing file without overwriting it', () => {
    const directory = createDirectory();
    const raced = join(realpathSync(directory), 'DESIGN.md');
    let racedOnce = false;
    const result = scaffoldProject(directory, {
      home: tmpdir(),
      runGit: successfulGit,
      fs: {
        ...realFs,
        writeFileSync: (path, data, options) => {
          if (path === 'DESIGN.md' && !racedOnce) {
            racedOnce = true;
            writeFileSync(path, 'created concurrently\n', { encoding: 'utf8', flag: 'wx' });
          }
          return writeFileSync(path, data, options);
        },
      },
    });

    expect(readFileSync(raced, 'utf8')).toBe('created concurrently\n');
    expect(result.existing).toContain(raced);
  });

  test('does not report a file as created when the working directory changes before its write', () => {
    const directory = createDirectory();
    const outside = createDirectory();
    const originalCwd = process.cwd();
    let replaced = false;
    try {
      expect(() => scaffoldProject(directory, {
        home: tmpdir(),
        runGit: successfulGit,
        fs: {
          ...realFs,
          writeFileSync: (path, data, options) => {
            if (path === 'project.json' && !replaced) {
              replaced = true;
              process.chdir(outside);
            }
            return writeFileSync(path, data, options);
          },
        },
      })).toThrow('scaffold directory escapes repository root');
    } finally {
      process.chdir(originalCwd);
    }

    expect(replaced).toBe(true);
    expect(existsSync(join(directory, '.elanous', 'project.json'))).toBe(false);
    expect(existsSync(join(outside, 'project.json'))).toBe(true);
  });

  test('revalidates a concurrently-created scaffold directory after mkdir EEXIST', () => {
    const directory = createDirectory();
    const raced = join(realpathSync(directory), 'docs');
    let racedOnce = false;
    const result = scaffoldProject(directory, {
      home: tmpdir(),
      runGit: successfulGit,
      fs: {
        ...realFs,
        mkdirSync: ((path: Parameters<typeof mkdirSync>[0], options?: Parameters<typeof mkdirSync>[1]) => {
          if (path === 'docs' && !racedOnce) {
            racedOnce = true;
            mkdirSync(path);
          }
          return mkdirSync(path, options);
        }) as typeof mkdirSync,
      },
    });

    expect(result.existing).toContain(raced);
    expect(result.created).toContain(join(raced, 'goals'));
    expect(result.created).not.toContain(join(raced, 'pdca'));
  });

  test.each(['.elanous', 'docs'])('rejects an external symbolic-link %s without writing outside the project', (name) => {
    const directory = createDirectory();
    const outside = createDirectory();
    const link = join(directory, name);
    symlinkSync(outside, link);

    expect(() => scaffoldProject(directory, { home: tmpdir(), runGit: successfulGit })).toThrow('unsafe scaffold directory');
    expect(existsSync(join(outside, 'project.json'))).toBe(false);
    expect(existsSync(join(outside, 'PLAN.md'))).toBe(false);
  });

  test.each(['.elanous', 'docs'])('rejects a dangling symbolic-link %s', (name) => {
    const directory = createDirectory();
    const link = join(directory, name);
    symlinkSync(join(directory, 'missing-target'), link);

    expect(() => scaffoldProject(directory, { home: tmpdir(), runGit: successfulGit })).toThrow('unsafe scaffold directory');
  });

  test.each(['.elanous', 'docs'])('does not write outside when %s is replaced by an external symbolic link before entry', (name) => {
    const directory = createDirectory();
    const outside = createDirectory();
    let replaced = false;
    const originalCwd = process.cwd();
    try {
      expect(() => scaffoldProject(directory, {
        home: tmpdir(),
        runGit: successfulGit,
        beforeEnterDirectory: (relativePath) => {
          if (relativePath !== name || replaced) return;
          replaced = true;
          rmSync(join(directory, name), { recursive: true, force: true });
          symlinkSync(outside, join(directory, name));
        },
      })).toThrow('scaffold directory escapes repository root');
    } finally {
      process.chdir(originalCwd);
    }
    expect(replaced).toBe(true);
    expect(existsSync(join(outside, 'project.json'))).toBe(false);
    expect(existsSync(join(outside, 'PLAN.md'))).toBe(false);
    expect(existsSync(join(outside, 'goals'))).toBe(false);
  });

  test('does not add declarative sources while making the project root discoverable', () => {
    const directory = createDirectory();
    scaffoldProject(directory, { home: tmpdir(), runGit: successfulGit });

    const sources = resolveDeclarativeSources({ cwd: directory, home: createDirectory(), env: {} });
    expect(sources.project).toBe(join(directory, '.elanous'));
    for (const kind of DECLARATIVE_KINDS) expect(listDeclarativeFiles(sources.project!, kind)).toEqual([]);
  });
});
