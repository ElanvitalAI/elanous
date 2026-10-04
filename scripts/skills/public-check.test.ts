import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPublicSkills, formatPublicCheck } from './public-check.js';
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

describe('public skill structural check', () => {
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
