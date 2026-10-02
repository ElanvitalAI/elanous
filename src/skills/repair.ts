// SK2 — 남의 SKILL.md 를 색인이 못 읽으면(skillIndexProblems) 시스템 에러 대신 «안내 ⊕ 확인 뒤 수리».
// 대표 10-01: «시스템 에러가 아니라 별도 시스템 메시지를 받고 스킬을 수리» · «PR 이 아니라 접근한 서피스에서 간단히».
// 고칠 수 있는 것만 고친다: 한 줄이어야 하는 프론트매터 값이 YAML 목록·인라인 배열이면 한 줄로 편다.
// 권한 오류는 원인·명령만 안내한다. 고치기 전 원본은 옆에 `.bak` 으로 남기고, 다시 읽어 안 풀리면 되돌린다.
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { buildSkillIndex, skillIndexProblems, type SkillIndexProblem } from './index.js';

/** Frontmatter keys the index reads as one-line text. */
const SCALAR_KEYS = ['name', 'description', 'version', 'when_to_use', 'when-to-use', 'argument-hint', 'model', 'category'];

export type SkillRepairPlan =
  | { kind: 'fixable'; problem: SkillIndexProblem; path: string; keys: string[] }
  | { kind: 'fixable-permission'; problem: SkillIndexProblem; path: string }
  | { kind: 'permission'; problem: SkillIndexProblem; path: string; hint: string }
  | { kind: 'manual'; problem: SkillIndexProblem; path: string; hint: string };

export function skillFilePath(problem: SkillIndexProblem): string {
  return join(problem.dir, problem.name, 'SKILL.md');
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function stripQuotes(value: string): string {
  const v = value.trim();
  return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")) ? v.slice(1, -1) : v;
}

/** Rewrite list-valued scalar keys as one quoted line; returns null when nothing needs changing. */
export function flattenScalarLists(markdown: string): { text: string; keys: string[] } | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!fm) return null;
  const lines = fm[1]!.split(/\r?\n/);
  const out: string[] = [];
  const keys: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m || !SCALAR_KEYS.includes(m[1]!)) { out.push(line); continue; }
    const key = m[1]!;
    const value = m[2]!.trim();
    if (/^\[.*\]$/.test(value)) {
      const items = value.slice(1, -1).split(',').map(stripQuotes).filter(Boolean);
      out.push(`${key}: ${quote(items.join(' · '))}`); keys.push(key);
      continue;
    }
    if (value === '') {
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j]!)) { items.push(stripQuotes(lines[j]!.replace(/^\s+-\s+/, ''))); j++; }
      if (items.length) { out.push(`${key}: ${quote(items.join(' · '))}`); keys.push(key); i = j - 1; continue; }
    }
    out.push(line);
  }
  if (!keys.length) return null;
  const text = markdown.slice(0, fm.index) + `---\n${out.join('\n')}\n---` + markdown.slice(fm.index + fm[0].length);
  return { text, keys };
}

export function planSkillRepair(problem: SkillIndexProblem, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): SkillRepairPlan {
  const path = skillFilePath(problem);
  if (problem.code === 'EACCES' || problem.code === 'EPERM') {
    // Our own file: we may add the read bit after the person says yes. Someone else's: name the command only.
    try {
      if (typeof process.getuid === 'function' && statSync(path).uid === process.getuid()) return { kind: 'fixable-permission', problem, path };
    } catch { /* fall through to the hint */ }
    return { kind: 'permission', problem, path, hint: `읽기 권한이 없습니다 — 터미널에서: sudo chmod a+r "${path}"` };
  }
  try {
    const fixed = flattenScalarLists(read(path));
    if (fixed) return { kind: 'fixable', problem, path, keys: fixed.keys };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') return { kind: 'permission', problem, path, hint: `읽기 권한이 없습니다 — 터미널에서: chmod u+r "${path}"` };
  }
  return { kind: 'manual', problem, path, hint: `자동으로 고칠 수 없는 형식입니다 — 파일 맨 위 «---» 사이를 확인해 주세요: ${path}` };
}

export type SkillRepairResult = { ok: true; path: string; keys: string[]; backup: string } | { ok: false; path: string; reason: string };

function stillUnreadable(problem: SkillIndexProblem): boolean {
  buildSkillIndex([problem.dir]);
  return skillIndexProblems().some((p) => p.dir === problem.dir && p.name === problem.name);
}

/** Apply a fixable plan (after the person said yes): read bit, or back up → rewrite → re-index → restore on failure. */
export function applySkillRepair(plan: Extract<SkillRepairPlan, { kind: 'fixable' | 'fixable-permission' }>): SkillRepairResult {
  const { path, problem } = plan;
  if (plan.kind === 'fixable-permission') {
    const before = statSync(path).mode & 0o777;
    chmodSync(path, before | 0o400);
    if (stillUnreadable(problem)) {
      chmodSync(path, before);
      debug.log('skills.repair', 'reverted', { name: problem.name, kind: 'permission' });
      return { ok: false, path, reason: 'still-unreadable' };
    }
    debug.log('skills.repair', 'repaired', { name: problem.name, kind: 'permission' });
    return { ok: true, path, keys: ['permission'], backup: '' };
  }
  const original = readFileSync(path, 'utf8');
  const fixed = flattenScalarLists(original);
  if (!fixed) return { ok: false, path, reason: 'nothing-to-fix' };
  const backup = `${path}.bak`;
  copyFileSync(path, existsSync(backup) ? `${path}.${Date.now()}.bak` : backup);
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, fixed.text);
  renameSync(temp, path);
  if (stillUnreadable(problem)) {
    writeFileSync(path, original);
    debug.log('skills.repair', 'reverted', { name: problem.name, keys: fixed.keys });
    return { ok: false, path, reason: 'still-unreadable' };
  }
  debug.log('skills.repair', 'repaired', { name: problem.name, keys: fixed.keys });
  return { ok: true, path, keys: fixed.keys, backup };
}

/** One line for a surface (TUI · REPL · PWA) — null when every skill was read. */
export function skillRepairNotice(problems: readonly SkillIndexProblem[]): string | null {
  if (!problems.length) return null;
  return `스킬 ${problems.length}개를 읽지 못했습니다 — 고치려면: elanous skills repair (확인한 뒤에만 고칩니다)`;
}
