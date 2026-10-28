import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReferenceCard, nodeRefIndexFs, type RefIndexFs } from './ref-index.js';
import { sourceStatus, type GroundingSource } from './sources.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(home: string, name: string): string {
  const repo = join(home, 'source', 'ref', name);
  mkdirSync(join(repo, 'docs', 'guide'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'ref@example.test']);
  git(repo, ['config', 'user.name', 'ref']);
  return repo;
}

function commitAll(repo: string): void {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'init']);
}

const sourceOf = (id: string, path: string, kind: GroundingSource['kind'] = 'local-repo'): GroundingSource => ({
  id, kind, path, sync: 'manual',
});

describe('buildReferenceCard', () => {
  test('L0 card (name, one line, directories, received date) and L1 titles + bin commands', () => {
    const home = mkdtempSync(join(tmpdir(), 'ref-index-'));
    try {
      const repo = makeRepo(home, 'alpha');
      writeFileSync(join(repo, 'README.md'), '# Alpha Tool\n\n[![ci](x)](y)\n\nAlpha parses things\nacross two lines.\n\nSecond paragraph.\n\n## Install\n\n```\n# not a title\n```\n');
      writeFileSync(join(repo, 'docs', 'intro.md'), '# Intro\n');
      writeFileSync(join(repo, 'docs', 'guide', 'deep.md'), '## Deep Guide\n');
      writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'alpha', bin: { zeta: 'z.js', alpha: 'a.js' } }));
      writeFileSync(join(repo, 'node_modules', 'dep', 'README.md'), '# Ignored\n');
      commitAll(repo);

      const card = buildReferenceCard(sourceOf('alpha', repo), nodeRefIndexFs);
      expect(card.name).toBe('alpha');
      expect(card.oneLine).toBe('Alpha parses things across two lines.');
      expect(card.oneLineFile).toBe('README.md');
      expect(card.directories).toEqual(['docs', 'src']);
      expect(card.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(card.titles).toEqual([
        { file: 'README.md', title: 'Alpha Tool' },
        { file: 'README.md', title: 'Install' },
        { file: join('docs', 'guide', 'deep.md'), title: 'Deep Guide' },
        { file: join('docs', 'intro.md'), title: 'Intro' },
      ]);
      expect(card.commands).toEqual(['alpha', 'zeta']);
      expect(card.truncated).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('marks truncated when the file-count or byte limit is exceeded, and never reads past the byte cap', () => {
    const home = mkdtempSync(join(tmpdir(), 'ref-index-'));
    try {
      const repo = makeRepo(home, 'big');
      writeFileSync(join(repo, 'README.md'), '# Big\n\nbig repo\n');
      writeFileSync(join(repo, 'docs', 'a.md'), '# A\n');
      writeFileSync(join(repo, 'docs', 'b.md'), '# B\n');
      writeFileSync(join(repo, 'docs', 'huge.md'), `# Head\n${'x'.repeat(5000)}\n# Tail\n`);

      const byCount = buildReferenceCard(sourceOf('big', repo), nodeRefIndexFs, { maxFiles: 2 });
      expect(byCount.truncated).toBe(true);
      expect(byCount.titles.map((t) => t.title)).toEqual(['Big', 'A']);

      const byBytes = buildReferenceCard(sourceOf('big', repo), nodeRefIndexFs, { maxBytesPerFile: 100 });
      expect(byBytes.truncated).toBe(true);
      const titles = byBytes.titles.map((t) => t.title);
      expect(titles).toContain('Head');
      expect(titles).not.toContain('Tail');

      const requested: number[] = [];
      const spy: RefIndexFs = {
        ...nodeRefIndexFs,
        readHead: (file, max) => { requested.push(max); return nodeRefIndexFs.readHead(file, max); },
      };
      buildReferenceCard(sourceOf('big', repo), spy, { maxBytesPerFile: 100 });
      expect(requested.length).toBeGreaterThan(0);
      expect(requested.every((n) => n === 100)).toBe(true);

      const roomy = buildReferenceCard(sourceOf('big', repo), nodeRefIndexFs);
      expect(roomy.truncated).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('still yields a card when README is missing, and indexes local-docs sources', () => {
    const home = mkdtempSync(join(tmpdir(), 'ref-index-'));
    try {
      const repo = makeRepo(home, 'bare');
      writeFileSync(join(repo, 'main.ts'), 'export {};\n');
      commitAll(repo);
      const card = buildReferenceCard(sourceOf('bare', repo), nodeRefIndexFs);
      expect(card.name).toBe('bare');
      expect(card.oneLine).toBe('');
      expect(card.directories).toEqual(['docs', 'src']);
      expect(card.titles).toEqual([]);
      expect(card.commands).toEqual([]);
      expect(card.truncated).toBe(false);

      const docs = join(home, 'docs', 'ref', 'beta');
      mkdirSync(join(docs, 'sub'), { recursive: true });
      writeFileSync(join(docs, 'sub', 'note.md'), '# Note\n');
      const docsCard = buildReferenceCard(sourceOf('beta', docs, 'local-docs'), nodeRefIndexFs);
      expect(docsCard.directories).toEqual(['sub']);
      expect(docsCard.titles).toEqual([{ file: join('sub', 'note.md'), title: 'Note' }]);
      expect(docsCard.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('card name comes from the repository (package.json name, else directory name), not the registry id', () => {
    const home = mkdtempSync(join(tmpdir(), 'ref-index-'));
    try {
      const withPkg = makeRepo(home, 'alpha');
      writeFileSync(join(withPkg, 'package.json'), JSON.stringify({ name: 'alpha-pkg' }));
      commitAll(withPkg);
      const fromPkg = buildReferenceCard(sourceOf('x', withPkg), nodeRefIndexFs);
      expect(fromPkg.id).toBe('x');
      expect(fromPkg.name).toBe('alpha-pkg');

      const noPkg = makeRepo(home, 'gamma');
      writeFileSync(join(noPkg, 'README.md'), '# Gamma\n');
      commitAll(noPkg);
      const fromDir = buildReferenceCard(sourceOf('y', noPkg), nodeRefIndexFs);
      expect(fromDir.id).toBe('y');
      expect(fromDir.name).toBe('gamma');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('rejects sources that are not local paths', () => {
    expect(() => buildReferenceCard({ id: 'w', kind: 'web', url: 'https://x.test', sync: 'manual' }, nodeRefIndexFs))
      .toThrow(/local-repo\/local-docs/);
  });

  test('keeps a trailing # that is part of the title (C#), strips only a spaced closing run', () => {
    const files: Record<string, string> = { '/r/README.md': '# C#\n## F# notes ##\n### Plain ###\n' };
    const fs: RefIndexFs = {
      readDir: (dir) => (dir === '/r' ? [{ name: 'README.md', isDirectory: false }] : []),
      readHead: (file) => (file in files ? { text: files[file]!, truncated: false } : undefined),
      mtimeMs: () => 0,
      lastCommitAt: () => undefined,
    };
    const card = buildReferenceCard(sourceOf('r', '/r'), fs);
    expect(card.titles.map((t) => t.title)).toEqual(['C#', 'F# notes', 'Plain']);
  });

  test('stops walking the docs tree once the file budget is spent (truncated, bounded listing)', () => {
    let listed = 0;
    const fs: RefIndexFs = {
      readDir: (dir) => {
        listed += 1;
        const depth = dir.split('/').length;
        if (depth > 40) return [];
        return [{ name: 'a.md', isDirectory: false }, { name: 'b.md', isDirectory: false }, { name: 'sub', isDirectory: true }];
      },
      readHead: () => ({ text: '# T\n', truncated: false }),
      mtimeMs: () => 0,
      lastCommitAt: () => undefined,
    };
    const card = buildReferenceCard(sourceOf('d', '/d', 'local-docs'), fs, { maxFiles: 2 });
    expect(card.truncated).toBe(true);
    expect(listed).toBeLessThan(6);
  });

  test('REF-INDEX-L0L1: card stamps orchestrationId and sourceStatus reaches buildReferenceCard from sources.ts', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ref-index-'));
    try {
      const repo = makeRepo(home, 'wired');
      writeFileSync(join(repo, 'README.md'), '# Wired\n\nwired repo\n');
      commitAll(repo);

      const card = buildReferenceCard(sourceOf('wired', repo), nodeRefIndexFs);
      expect(card.orchestrationId).toBe('grounding:local-repo:wired');

      const status = await sourceStatus(sourceOf('wired', repo));
      expect(status.measured).toBe(true);
      expect(status.lastCommitAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a missing source path throws instead of yielding an empty card', () => {
    const home = mkdtempSync(join(tmpdir(), 'ref-index-'));
    try {
      expect(() => buildReferenceCard(sourceOf('gone', join(home, 'nope')), nodeRefIndexFs)).toThrow(/not readable/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
