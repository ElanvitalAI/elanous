import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEntries, checkPublicSkills, formatPublicCheck, runPublicCheck } from './public-check.js';
import type { SkillBoundaryReport } from '../skill-boundary.js';

const goodDoc = `---
name: example
description: >
  A public skill.
---
# example
## Free path (no API key)
Run locally with \`bun scripts/main.ts --free\` without an API key.
## Installation
\`bun install\` (package.json).
`;
const boundary: SkillBoundaryReport = {
  skills: [
    { skill: 'example', verdict: 'core', requires: [], because: 'fixture' },
    { skill: 'paid', verdict: 'addon', requires: [], because: 'fixture' },
  ],
  errors: [],
};

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'skill-public-'));
  mkdirSync(join(root, 'skills', 'example', 'scripts'), { recursive: true });
  mkdirSync(join(root, 'skills', 'paid'), { recursive: true });
  writeFileSync(join(root, 'skills', 'example', 'SKILL.md'), goodDoc);
  writeFileSync(join(root, 'skills', 'example', 'scripts', 'main.ts'), 'throw new Error("never execute skills")');
  writeFileSync(join(root, 'skills', 'example', 'package.json'), '{}');
  writeFileSync(join(root, 'skills', 'paid', 'SKILL.md'), '/Users/private/ INTERNAL_ONLY');
  return root;
}

function withFixture(fn: (root: string) => void): void {
  const root = fixture();
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('isolated skill build', () => {
  test('copies only the skill, installs once, builds TS/JS entries and cleans the copy', () => withFixture((root) => {
    const dir = join(root, 'skills', 'example');
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'outside');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'old.js'), 'stale');
    symlinkSync(outside, join(dir, 'outside-link'));
    writeFileSync(join(dir, 'scripts', 'other.js'), 'export {}');
    const calls: string[][] = [];
    let copy = '';
    const result = buildSkillEntries(dir, ['scripts/main.ts', 'scripts/other.js', 'scripts/shell.sh'], (args, cwd) => {
      copy = cwd;
      calls.push(args);
      expect(cwd).not.toBe(dir);
      expect(existsSync(join(cwd, 'SKILL.md'))).toBe(true);
      expect(existsSync(join(cwd, 'node_modules', 'old.js'))).toBe(false);
      expect(existsSync(join(cwd, 'outside-link'))).toBe(false);
      expect(existsSync(join(cwd, '..', 'outside.txt'))).toBe(false);
      expect(existsSync(join(cwd, '..', 'skills', 'paid'))).toBe(false);
      return true;
    });
    expect(result).toBe('OK');
    expect(calls[0]).toEqual(['bun', 'install', '--ignore-scripts']);
    expect(calls.slice(1).map((args) => args.slice(0, 4))).toEqual([
      ['bun', 'build', 'scripts/main.ts', '--target=bun'],
      ['bun', 'build', 'scripts/other.js', '--target=bun'],
    ]);
    expect(calls).toHaveLength(3);
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(join(dir, 'scripts', 'main.ts'))).toBe(true);
  }));

  test('rejects absolute, parent traversal and external symlink entries before any install or build', () => withFixture((root) => {
    const dir = join(root, 'skills', 'example');
    const outside = join(root, 'outside.ts');
    writeFileSync(outside, 'export const outside = true;');
    symlinkSync(outside, join(dir, 'scripts', 'linked.ts'));
    const calls: string[][] = [];
    const run = (args: string[]) => { calls.push(args); return true; };
    for (const entry of [outside, '../../outside.ts', 'scripts/../../../outside.ts', 'scripts/linked.ts']) {
      expect(buildSkillEntries(dir, [entry], run)).toBe('FAIL');
    }
    expect(calls).toEqual([]);
    expect(existsSync(outside)).toBe(true);
    expect(buildSkillEntries(dir, ['scripts/main.ts'], run)).toBe('OK');
    expect(calls.map((args) => args[1])).toEqual(['install', 'build']);
  }));

  test('skips install without a manifest and returns N/A for non-TS/JS entries', () => withFixture((root) => {
    const dir = join(root, 'skills', 'example');
    rmSync(join(dir, 'package.json'));
    const commands: string[][] = [];
    expect(buildSkillEntries(dir, ['scripts/main.ts'], (args) => { commands.push(args); return true; })).toBe('OK');
    expect(commands).toHaveLength(1);
    expect(commands[0]!.slice(0, 3)).toEqual(['bun', 'build', 'scripts/main.ts']);
    expect(buildSkillEntries(dir, ['scripts/tool.py'], () => { throw new Error('must not run'); })).toBe('N/A');
  }));

  test('install or build failure returns FAIL and still removes temporary files', () => withFixture((root) => {
    const dir = join(root, 'skills', 'example');
    for (const failingCommand of ['install', 'build']) {
      let copy = '';
      const commands: string[] = [];
      expect(buildSkillEntries(dir, ['scripts/main.ts'], (args, cwd) => {
        copy = cwd;
        commands.push(args[1]!);
        return args[1] !== failingCommand;
      })).toBe('FAIL');
      expect(commands).toEqual(failingCommand === 'install' ? ['install'] : ['install', 'build']);
      expect(existsSync(copy)).toBe(false);
    }
  }));

  test('real bun build reports syntax failure from a copied entry', () => withFixture((root) => {
    const dir = join(root, 'skills', 'example');
    rmSync(join(dir, 'package.json'));
    writeFileSync(join(dir, 'scripts', 'main.ts'), 'const = ;');
    expect(buildSkillEntries(dir, ['scripts/main.ts'])).toBe('FAIL');
    writeFileSync(join(dir, 'scripts', 'main.ts'), 'export const value = 1;');
    expect(buildSkillEntries(dir, ['scripts/main.ts'])).toBe('OK');
  }));
});

describe('public skill structural check', () => {
  test('the CLI entry path builds only with --build and reflects build failure in JSON, table and exit status', () => withFixture((root) => {
    const dir = join(root, 'skills', 'example');
    rmSync(join(dir, 'package.json'));
    writeFileSync(join(dir, 'SKILL.md'), goodDoc.replace('`bun install` (package.json).', '`pip install -r requirements.txt`.'));
    writeFileSync(join(dir, 'requirements.txt'), 'requests\n');
    writeFileSync(join(dir, 'scripts', 'main.ts'), 'const = ;');
    const plain = runPublicCheck(root, ['--json'], boundary);
    expect(plain.exitCode).toBe(0);
    expect(JSON.parse(plain.output).skills[0].checks).not.toHaveProperty('build');
    const json = runPublicCheck(root, ['--json', '--build'], boundary);
    const table = runPublicCheck(root, ['--build'], boundary);
    expect(JSON.parse(json.output).skills[0].checks.build).toBe('FAIL');
    expect(json.exitCode).toBe(1);
    expect(table.exitCode).toBe(1);
    expect(table.output).toContain('build');
    expect(table.output).toContain('스킬 실행 파일 빌드 실패');
    expect(table.output).toContain('PUBLIC-CHECK FAIL');
    const row = table.output.split('\n').find((line) => line.startsWith('example'))!;
    expect(row.slice(35).split(/\s+/u).slice(0, 6)).toEqual(['OK', 'OK', 'OK', 'OK', 'OK', 'FAIL']);
    writeFileSync(join(dir, 'scripts', 'main.ts'), 'export const value = 1;');
    const repaired = runPublicCheck(root, ['--json', '--build'], boundary);
    expect(JSON.parse(repaired.output).skills[0].checks.build).toBe('OK');
    expect(repaired.exitCode).toBe(0);
  }));

  test('build mode marks a non-TS/JS skill N/A without failing it', () => withFixture((root) => {
    const dir = join(root, 'skills', 'example');
    rmSync(join(dir, 'scripts', 'main.ts'));
    writeFileSync(join(dir, 'scripts', 'main.sh'), 'echo ok\n');
    writeFileSync(join(dir, 'SKILL.md'), goodDoc.replaceAll('scripts/main.ts', 'scripts/main.sh'));
    const result = checkPublicSkills(root, boundary, true);
    expect(result.skills[0]!.checks.build).toBe('N/A');
    expect(result.ok).toBe(true);
  }));

  test('reports only public skills and does not execute entrypoints', () => withFixture((root) => {
    const report = checkPublicSkills(root, boundary);
    expect(report.ok).toBe(true);
    expect(report.skills.map((row) => row.skill)).toEqual(['example']);
    expect(Object.values(report.skills[0]!.checks)).toEqual([true, true, true, true, true]);
    expect(formatPublicCheck(report)).toContain('PUBLIC-CHECK PASS (1 public skills)');
  }));

  test('missing header, free path and manifest fail while an undocumented entry remains valid', () => withFixture((root) => {
    const dir = join(root, 'skills', 'example');
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: example\ndescription: \n---\n# example`);
    writeFileSync(join(dir, 'scripts', 'main.ts'), 'const secret = "~/source/private";');
    rmSync(join(dir, 'package.json'));
    const report = checkPublicSkills(root, boundary);
    expect(report.ok).toBe(false);
    expect(report.skills[0]!.checks).toEqual({ header: false, entry: true, free: false, portable: false, install: false });
    expect(report.skills[0]!.violations.join('\n')).toContain('skills/example/scripts/main.ts');
    expect(formatPublicCheck(report)).toContain('PUBLIC-CHECK FAIL');
  }));

  test('paid-only path and install without a manifest fail even when a real entry exists', () => withFixture((root) => {
    const dir = join(root, 'skills', 'example');
    writeFileSync(join(dir, 'SKILL.md'), goodDoc.replace('scripts/main.ts', 'scripts/missing.ts').replace('no API key', 'requires an API key').replace('without an API key', 'with an API key'));
    rmSync(join(dir, 'package.json'));
    const checks = checkPublicSkills(root, boundary).skills[0]!.checks;
    expect(checks.entry).toBe(true);
    expect(checks.free).toBe(false);
    expect(checks.install).toBe(false);
  }));

  test('an install command is not a free run; requiring .env fails even with a run command', () => withFixture((root) => {
    const doc = join(root, 'skills', 'example', 'SKILL.md');
    writeFileSync(doc, goodDoc.replace('Run locally with `bun scripts/main.ts --free` without an API key.', '`bun install` first.'));
    expect(checkPublicSkills(root, boundary).skills[0]!.checks.free).toBe(false);
    writeFileSync(doc, goodDoc.replace('without an API key.', 'without an API key. Configure .env before running.'));
    expect(checkPublicSkills(root, boundary).skills[0]!.checks.free).toBe(false);
  }));

  test('free command must point to an actual skill entry, not just any entry', () => withFixture((root) => {
    const dir = join(root, 'skills', 'example');
    writeFileSync(join(dir, 'SKILL.md'), goodDoc.replace('scripts/main.ts', 'scripts/absent.ts'));
    const missing = checkPublicSkills(root, boundary).skills[0]!.checks;
    expect(missing.entry).toBe(true);
    expect(missing.free).toBe(false);
    writeFileSync(join(dir, 'scripts', 'absent.ts'), 'export {}');
    expect(checkPublicSkills(root, boundary).skills[0]!.checks.free).toBe(true);
    writeFileSync(join(dir, 'SKILL.md'), goodDoc.replace('scripts/main.ts', './scripts/absent.ts'));
    expect(checkPublicSkills(root, boundary).skills[0]!.checks.free).toBe(true);
  }));

  test('entry is a real executable inside the skill, independent of documentation or root files', () => withFixture((root) => {
    const dir = join(root, 'skills', 'example');
    writeFileSync(join(dir, 'SKILL.md'), goodDoc.replaceAll('scripts/main.ts', 'scripts/absent.ts'));
    expect(checkPublicSkills(root, boundary).skills[0]!.checks.entry).toBe(true);
    rmSync(join(dir, 'scripts', 'main.ts'));
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts', 'absent.ts'), 'export {}');
    expect(checkPublicSkills(root, boundary).skills[0]!.checks.entry).toBe(false);
  }));

  test('explicit prompt-only declaration makes only the missing entry N/A', () => withFixture((root) => {
    const dir = join(root, 'skills', 'example');
    rmSync(join(dir, 'scripts', 'main.ts'));
    const doc = join(dir, 'SKILL.md');
    const declared = goodDoc.replace('name: example', 'name: example\nprompt-only: true');
    writeFileSync(doc, declared);
    const row = checkPublicSkills(root, boundary).skills[0]!;
    expect(row.checks).toEqual({ header: true, entry: 'N/A', free: false, portable: true, install: true });
    expect(row.violations).toEqual(['키/.env 없이 쓰는 무료 경로가 문서에 없음']);
    expect(formatPublicCheck(checkPublicSkills(root, boundary))).toContain('example                            OK        N/A       FAIL      OK        OK');
    writeFileSync(doc, declared.replace('prompt-only: true', 'prompt-only: false'));
    expect(checkPublicSkills(root, boundary).skills[0]!.checks.entry).toBe(false);
    writeFileSync(doc, goodDoc + '\nprompt-only: true\n');
    expect(checkPublicSkills(root, boundary).skills[0]!.checks.entry).toBe(false);
    writeFileSync(join(dir, 'scripts', 'main.ts'), 'export {}');
    writeFileSync(doc, declared);
    expect(checkPublicSkills(root, boundary).skills[0]!.checks.entry).toBe(true);
  }));

  test('the prompt-only grill-me skill reports entry N/A without hiding other failures', () => {
    const report = checkPublicSkills(join(import.meta.dir, '..', '..'));
    const row = report.skills.find((skill) => skill.skill === 'grill-me');
    expect(row?.checks.entry).toBe('N/A');
    expect(row?.violations).not.toContain('스킬 내부 실행 파일(scripts/src/bin)이 없음');
    expect(formatPublicCheck(report).split('\n').find((line) => line.startsWith('grill-me'))).toContain('N/A');
  });

  test('declaration files cannot satisfy executable entry or documented free command', () => withFixture((root) => {
    const dir = join(root, 'skills', 'example');
    rmSync(join(dir, 'scripts', 'main.ts'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'types.d.ts'), 'declare const value: string;');
    writeFileSync(join(dir, 'SKILL.md'), goodDoc.replace('scripts/main.ts', 'src/types.d.ts'));
    const checks = checkPublicSkills(root, boundary).skills[0]!.checks;
    expect(checks.entry).toBe(false);
    expect(checks.free).toBe(false);
  }));

  test('optional .env is permitted but a mandatory .env is not', () => withFixture((root) => {
    const doc = join(root, 'skills', 'example', 'SKILL.md');
    writeFileSync(doc, goodDoc.replace('without an API key.', 'without an API key. `.env is optional` for custom settings.'));
    expect(checkPublicSkills(root, boundary).skills[0]!.checks.free).toBe(true);
    writeFileSync(doc, goodDoc.replace('without an API key.', 'without an API key. `.env` is required before running.'));
    expect(checkPublicSkills(root, boundary).skills[0]!.checks.free).toBe(false);
  }));

  test('a YAML comment alone is not a description', () => withFixture((root) => {
    const doc = join(root, 'skills', 'example', 'SKILL.md');
    writeFileSync(doc, goodDoc.replace('description: >\n  A public skill.', 'description: # comment'));
    expect(checkPublicSkills(root, boundary).skills[0]!.checks.header).toBe(false);
    writeFileSync(doc, goodDoc.replace('description: >\n  A public skill.', 'description: real description # comment'));
    expect(checkPublicSkills(root, boundary).skills[0]!.checks.header).toBe(true);
  }));

  test('portable scan includes dotfiles and text configs outside the old extension list', () => withFixture((root) => {
    const dir = join(root, 'skills', 'example');
    writeFileSync(join(dir, '.env.example'), 'WORKDIR=/Users/private/project');
    writeFileSync(join(dir, 'settings.cfg'), 'visibility=INTERNAL_ONLY');
    const row = checkPublicSkills(root, boundary).skills[0]!;
    expect(row.checks.portable).toBe(false);
    expect(row.violations.join('\n')).toContain('skills/example/.env.example');
    expect(row.violations.join('\n')).toContain('skills/example/settings.cfg');
  }));

  test('boundary errors block a passing inventory and are visible in the table', () => withFixture((root) => {
    const report = checkPublicSkills(root, { ...boundary, errors: ['uncertain: cannot classify'] });
    expect(report.ok).toBe(false);
    expect(formatPublicCheck(report)).toContain('ERROR uncertain: cannot classify');
  }));

  test('a skill without frontmatter still has its own five-column row', () => withFixture((root) => {
    mkdirSync(join(root, 'skills', 'unclassified'));
    writeFileSync(join(root, 'skills', 'unclassified', 'SKILL.md'), '# no header');
    const report = checkPublicSkills(root, { ...boundary, errors: ['unclassified: cannot classify'] });
    expect(report.skills.map((row) => row.skill)).toEqual(['example', 'unclassified']);
    expect(report.skills[1]!.checks.header).toBe(false);
    expect(report.ok).toBe(false);
  }));

  test('production CLI table and --json agree on failure and do not execute skills', () => {
    const root = join(import.meta.dir, '..', '..');
    const expected = checkPublicSkills(root);
    const command = join(import.meta.dir, 'public-check.ts');
    const json = Bun.spawnSync(['bun', command, '--json'], { cwd: root });
    const table = Bun.spawnSync(['bun', command], { cwd: root });
    const actual = JSON.parse(json.stdout.toString()) as typeof expected;
    expect(actual).toEqual(expected);
    expect(json.exitCode).toBe(expected.ok ? 0 : 1);
    expect(table.exitCode).toBe(json.exitCode);
    expect(table.stdout.toString()).toContain(`PUBLIC-CHECK ${expected.ok ? 'PASS' : 'FAIL'}`);
    expect(expected.skills.length).toBeGreaterThan(0);
  });
});

// 리뷰 must-fix 넷(#23734 2라운드) — 각 칸이 «모양만»으로 통과하지 않음을 반증 사례로 문다.
describe('review must-fix counter-examples', () => {
  test('a «no API key» heading whose body requires a key is not a free path', () => withFixture((root) => {
    writeFileSync(join(root, 'skills', 'example', 'SKILL.md'), goodDoc.replace(
      'Run locally with `bun scripts/main.ts --free` without an API key.',
      'Requires an API key to run bun scripts/main.ts'));
    expect(checkPublicSkills(root, boundary).skills[0]!.checks.free).toBe(false);
  }));

  test('a non-entry source file such as src/types.ts does not satisfy the entry check', () => withFixture((root) => {
    const dir = join(root, 'skills', 'example');
    rmSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'types.ts'), 'export type X = 1;');
    writeFileSync(join(dir, 'SKILL.md'), goodDoc.replace('bun scripts/main.ts --free', 'it'));
    expect(checkPublicSkills(root, boundary).skills[0]!.checks.entry).toBe(false);
    writeFileSync(join(dir, 'src', 'cli.ts'), 'export {};');
    expect(checkPublicSkills(root, boundary).skills[0]!.checks.entry).toBe(true);
  }));

  test('requirements.txt with only a bun install command does not pass install', () => withFixture((root) => {
    const dir = join(root, 'skills', 'example');
    rmSync(join(dir, 'package.json'));
    writeFileSync(join(dir, 'requirements.txt'), 'requests\n');
    expect(checkPublicSkills(root, boundary).skills[0]!.checks.install).toBe(false);
    writeFileSync(join(dir, 'SKILL.md'), goodDoc.replace('`bun install` (package.json).', '`pip install -r requirements.txt`'));
    expect(checkPublicSkills(root, boundary).skills[0]!.checks.install).toBe(true);
  }));

  test('an empty block scalar description (>-) is not a description', () => withFixture((root) => {
    const dir = join(root, 'skills', 'example');
    writeFileSync(join(dir, 'SKILL.md'), goodDoc.replace('description: >\n  A public skill.\n', 'description: >-\n'));
    expect(checkPublicSkills(root, boundary).skills[0]!.checks.header).toBe(false);
    writeFileSync(join(dir, 'SKILL.md'), goodDoc.replace('description: >\n', 'description: >-\n'));
    expect(checkPublicSkills(root, boundary).skills[0]!.checks.header).toBe(true);
  }));
});
