import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { integrateTrain } from './merge-train.js';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

test('merge train regenerates CONDUCTOR from independent landed cell fragments', () => {
  const root = mkdtempSync(join(tmpdir(), 'conductor-map-train-'));
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'test');
    git(root, 'config', 'user.email', 'test@localhost');
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'docs/conductor/cells'), { recursive: true });
    writeFileSync(join(root, 'scripts/generate-conductor-cell-map.ts'), readFileSync(resolve('scripts/generate-conductor-cell-map.ts'), 'utf8'));
    writeFileSync(join(root, 'docs/conductor/CONDUCTOR.md'), [
      '| 판 | 칸 |', '|---|---|', '| <!-- BEGIN GENERATED CONDUCTOR CELL MAP -->old | row <!-- END GENERATED CONDUCTOR CELL MAP -->|', '',
    ].join('\n'));
    writeFileSync(join(root, 'docs/conductor/cells/base.md'), '<!-- order: 010 -->\n| base | row |\n');
    const initialGeneration = spawnSync('bun', ['scripts/generate-conductor-cell-map.ts'], { cwd: root, encoding: 'utf8' });
    expect(initialGeneration.status, initialGeneration.stderr || initialGeneration.stdout).toBe(0);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'base');
    const base = git(root, 'rev-parse', 'HEAD');

    const makeFragmentBranch = (branch: string, file: string, order: string, row: string) => {
      git(root, 'checkout', '-q', '--detach', base);
      git(root, 'checkout', '-q', '-b', branch);
      writeFileSync(join(root, 'docs/conductor/cells', file), `<!-- order: ${order} -->\n${row}\n`);
      git(root, 'add', '.');
      git(root, 'commit', '-qm', branch);
      return git(root, 'rev-parse', 'HEAD');
    };
    const first = makeFragmentBranch('fragment-alpha', 'alpha.md', '020', '| alpha | row |');
    const second = makeFragmentBranch('fragment-beta', 'beta.md', '030', '| beta | row |');
    const headBefore = git(root, 'rev-parse', 'HEAD');
    const result = integrateTrain(root, base, [{ number: 1, head: first }, { number: 2, head: second }]);
    expect(result.conflicts).toEqual([]);
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(headBefore);
    const generated = git(root, 'show', `${result.commitSha}:docs/conductor/CONDUCTOR.md`)
      .replace('<!-- BEGIN GENERATED CONDUCTOR CELL MAP -->', '')
      .replace('<!-- END GENERATED CONDUCTOR CELL MAP -->', '');
    expect(generated).toContain('| base | row |');
    expect(generated).toContain('| alpha | row |');
    expect(generated).toContain('| beta | row |');

    git(root, 'checkout', '-q', '--detach', base);
    git(root, 'checkout', '-q', '-b', 'generator-and-fragment');
    writeFileSync(join(root, 'scripts/generate-conductor-cell-map.ts'), `${readFileSync(join(root, 'scripts/generate-conductor-cell-map.ts'), 'utf8')}\n// changed with a source fragment\n`);
    writeFileSync(join(root, 'docs/conductor/cells/gamma.md'), '<!-- order: 040 -->\n| gamma | row |\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'change generator and fragment together');
    const generatorAndFragment = integrateTrain(root, base, [{ number: 3, head: git(root, 'rev-parse', 'HEAD') }]);
    const trustedGeneratorOutput = git(root, 'show', `${generatorAndFragment.commitSha}:docs/conductor/CONDUCTOR.md`);
    expect(trustedGeneratorOutput).toContain('| gamma | row |');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
