import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderConductorCellMap } from '../../scripts/generate-conductor-cell-map.js';
import { integrateTrain } from './merge-train.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-cell-map-train-'));
  dirs.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@localhost');
  for (const path of ['scripts', 'docs/conductor/cells']) mkdirSync(join(repo, path), { recursive: true });
  copyFileSync(resolve(import.meta.dir, '../../scripts/generate-conductor-cell-map.ts'), join(repo, 'scripts/generate-conductor-cell-map.ts'));
  const initial = [{ name: 'CONDUCTOR.md', content: '| 0.3.8 | BASE-CELL |' }];
  writeFileSync(join(repo, 'docs/conductor/cells/CONDUCTOR.md'), initial[0]!.content + '\n');
  writeFileSync(join(repo, 'docs/conductor/CONDUCTOR.md'), `## 8. Cell map\n\n${renderConductorCellMap(initial)}\n\n## 9. Rules\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base with generated conductor cell map');
  return { repo, base: git(repo, 'rev-parse', 'HEAD') };
}

function addCell(repo: string, base: string, branch: string, row: string, editGenerator = false): string {
  git(repo, 'checkout', '-q', '--detach', base);
  git(repo, 'checkout', '-q', '-b', branch);
  writeFileSync(join(repo, `docs/conductor/cells/${branch}.md`), `${row}\n`);
  if (editGenerator) {
    writeFileSync(join(repo, 'scripts/generate-conductor-cell-map.ts'), "throw new Error('PR controlled generator must not run in train');\n");
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', branch);
  return git(repo, 'rev-parse', 'HEAD');
}

test('merge train regenerates CONDUCTOR from independent fragments using trusted generator code', () => {
  const { repo, base } = fixture();
  const first = addCell(repo, base, 'first-cell', '| 0.3.8 | FIRST |');
  const second = addCell(repo, base, 'second-cell', '| 0.3.8 | SECOND |', true);
  const result = integrateTrain(repo, base, [{ number: 1, head: first }, { number: 2, head: second }]);

  expect(result.conflicts).toEqual([]);
  expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
  const conductor = git(repo, 'show', `${result.commitSha}:docs/conductor/CONDUCTOR.md`);
  expect(conductor).toContain('| 0.3.8 | BASE-CELL |');
  expect(conductor).toContain('| 0.3.8 | FIRST |');
  expect(conductor).toContain('| 0.3.8 | SECOND |');
  expect(conductor.indexOf('| 0.3.8 | FIRST |')).toBeLessThan(conductor.indexOf('| 0.3.8 | SECOND |'));
});
