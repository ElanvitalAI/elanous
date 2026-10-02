import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillIndex, skillIndexProblems } from './index.js';
import { applySkillRepair, flattenScalarLists, planSkillRepair, skillRepairNotice } from './repair.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { try { chmodSync(join(dir, 'locked', 'SKILL.md'), 0o644); } catch { /* none */ } rmSync(dir, { recursive: true, force: true }); } });

function root(): string { const dir = mkdtempSync(join(tmpdir(), 'skills-repair-')); dirs.push(dir); return dir; }
function skill(dir: string, name: string, body: string): string {
  mkdirSync(join(dir, name), { recursive: true });
  const path = join(dir, name, 'SKILL.md');
  writeFileSync(path, body);
  return path;
}

test('an unreadable own skill is a notice, then a confirmed repair re-indexes it (read bit restored)', () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root reads everything
  const dir = root();
  const path = skill(dir, 'locked', '---\nname: locked\ndescription: ok\n---\nbody\n');
  chmodSync(path, 0o000);
  buildSkillIndex([dir]);
  const problems = skillIndexProblems().filter((p) => p.dir === dir);
  expect(problems.map((p) => [p.name, p.code])).toEqual([['locked', 'EACCES']]);
  expect(skillRepairNotice(problems)).toBe('스킬 1개를 읽지 못했습니다 — 고치려면: elanous skills repair (확인한 뒤에만 고칩니다)');
  const plan = planSkillRepair(problems[0]!);
  expect(plan.kind).toBe('fixable-permission');
  if (plan.kind !== 'fixable-permission') return;
  expect(applySkillRepair(plan)).toMatchObject({ ok: true, keys: ['permission'] });
  expect(skillIndexProblems().filter((p) => p.dir === dir)).toEqual([]);
  expect(buildSkillIndex([dir]).map((e) => e.name)).toContain('locked');
});

test('a rebuilt dir drops problems that no longer happen', () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;
  const dir = root();
  const path = skill(dir, 'locked', '---\nname: locked\ndescription: ok\n---\n');
  chmodSync(path, 0o000);
  buildSkillIndex([dir]);
  expect(skillIndexProblems().some((p) => p.dir === dir)).toBe(true);
  chmodSync(path, 0o644);
  buildSkillIndex([dir]);
  expect(skillIndexProblems().some((p) => p.dir === dir)).toBe(false);
  expect(skillRepairNotice([])).toBeNull();
});

test('flattenScalarLists turns list-valued one-line keys into one quoted line and leaves the rest alone', () => {
  const md = '---\nname: a\ndescription:\n  - first "q"\n  - second\nversion: [1, 2]\nallowed-tools:\n  - Read\n---\nbody\n';
  const out = flattenScalarLists(md)!;
  expect(out.keys).toEqual(['description', 'version']);
  expect(out.text).toContain('description: "first \\"q\\" · second"');
  expect(out.text).toContain('version: "1 · 2"');
  expect(out.text).toContain('allowed-tools:\n  - Read');
  expect(out.text.endsWith('---\nbody\n')).toBe(true);
  expect(flattenScalarLists('---\nname: a\ndescription: ok\n---\n')).toBeNull();
});

test('a list-valued file repair keeps a .bak and is reverted when the skill would still fail', () => {
  const dir = root();
  const path = skill(dir, 'listy', '---\nname: listy\ndescription:\n  - a\n  - b\n---\nbody\n');
  const plan = { kind: 'fixable' as const, problem: { name: 'listy', dir, code: null, error: 'x' }, path, keys: ['description'] };
  expect(applySkillRepair(plan)).toMatchObject({ ok: true, keys: ['description'] });
  expect(existsSync(`${path}.bak`)).toBe(true);
  expect(readFileSync(path, 'utf8')).toContain('description: "a · b"');
  expect(planSkillRepair({ name: 'gone', dir, code: null, error: 'x' }).kind).toBe('manual');
});
