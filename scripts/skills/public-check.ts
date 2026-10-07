#!/usr/bin/env bun
/** Public (core) skill readiness inventory; optional builds never execute a skill. */
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep, win32 } from 'node:path';
import { computeSkillBoundaries, type SkillBoundaryReport } from '../skill-boundary.js';

export type PublicCheckKey = 'header' | 'entry' | 'free' | 'portable' | 'install';
export interface PublicSkillRow {
  readonly skill: string;
  readonly checks: Readonly<Record<PublicCheckKey, boolean | 'N/A'> & { build?: SkillBuildResult }>;
  readonly violations: readonly string[];
}
export interface PublicCheckReport {
  readonly skills: readonly PublicSkillRow[];
  readonly errors: readonly string[];
  readonly ok: boolean;
}

const PERSONAL_OR_INTERNAL = /\/Users\/|~\/source(?:\/|\b)|\b(?:INTERNAL_ONLY|ELANOUS_INTERNAL|PRIVATE_INTERNAL|internal-only)\b|@internal\b|내부\s*전용/iu;
const EXECUTABLE = /\.(?:ts|tsx|js|mjs|cjs|py|sh|bash)$/iu;
const ENTRY_DIR = /^(?:scripts|src|bin)\//u;
const NON_ENTRY = /(?:\.d\.ts|\.(?:test|spec)\.[^.]+)$/iu;
const RUN_COMMAND = /(?:^|[\s`$])(?:bun(?:\s+run)?|node|python3?|bash|sh|npx\s+tsx|uv\s+run\s+python3?)\s+((?:\.\/)?(?:scripts|src|bin)\/[\w./-]+\.(?:ts|tsx|js|mjs|cjs|py|sh|bash))\b/gimu;

function skillFiles(dir: string): string[] {
  const files: string[] = [];
  function visit(path: string): void {
    for (const item of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name === '.git' || item.name === 'node_modules' || item.name === '__pycache__') continue;
      const file = join(path, item.name);
      if (item.isDirectory()) visit(file);
      else if (item.isFile()) files.push(file);
    }
  }
  visit(dir);
  return files;
}

function skillHeader(doc: string): string | undefined {
  return /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(doc)?.[1];
}

function headerValid(doc: string, skill: string): boolean {
  const header = skillHeader(doc);
  if (!header) return false;
  const name = /^name:\s*['"]?([^\s'"#]+)['"]?\s*$/mu.exec(header)?.[1];
  const description = /^description:\s*(.*)$/mu.exec(header);
  if (!description) return false;
  const value = description[1]!.replace(/\s+#.*$/u, '').trim();
  const following = header.slice(description.index + description[0].length).split(/\r?\n/u).slice(1);
  const multiline = following.some((line) => /^\s+\S/u.test(line) && !/^\s*#/u.test(line));
  const block = /^[>|][+-]?$/u.test(value);
  // 리뷰 must-fix: `description: >-` 처럼 블록 표시만 있고 뒤 줄이 비면 설명이 없다.
  return name === skill && (value !== '' && !block && !value.startsWith('#') || block && multiline);
}

function promptOnly(doc: string): boolean {
  return /^prompt-only:\s*true\s*(?:#.*)?$/mu.test(skillHeader(doc) ?? '');
}

const ENTRY_NAME = /^(?:scripts|src)\/(?:main|cli|index|run)\.[^/]+$/u;

/** 리뷰 must-fix: 확장자·디렉터리만으로 «실행 진입점»이 아니다(`src/types.ts`).
 *  인정 = 문서가 실제로 실행하는 파일 ∪ `bin/` 아래 ∪ scripts|src 바로 아래 main·cli·index·run. */
function executableEntries(files: readonly string[], dir: string, docs: string): string[] {
  const commanded = new Set([...docs.matchAll(RUN_COMMAND)].map((command) => command[1]!.replace(/^\.\//u, '')));
  return files.map((file) => relative(dir, file)).filter((file) => ENTRY_DIR.test(file) && EXECUTABLE.test(file) && !NON_ENTRY.test(file)
    && (commanded.has(file) || file.startsWith('bin/') || ENTRY_NAME.test(file)));
}

export type SkillBuildResult = 'OK' | 'FAIL' | 'N/A';

/** Build only selected TS/JS entries from an isolated skill copy, never from the repository. */
export function buildSkillEntries(
  dir: string,
  entries: readonly string[],
  run: (args: string[], cwd: string) => boolean = (args, cwd) => Bun.spawnSync(args, {
    cwd, stdout: 'ignore', stderr: 'ignore',
  }).exitCode === 0,
): SkillBuildResult {
  const buildable = entries.filter((entry) => /\.(?:ts|tsx|js|mjs|cjs)$/iu.test(entry));
  if (buildable.length === 0) return 'N/A';
  if (buildable.some((entry) => isAbsolute(entry) || win32.isAbsolute(entry) || entry.split(/[\\/]/u).includes('..'))) return 'FAIL';
  const temp = mkdtempSync(join(tmpdir(), 'skill-public-build-'));
  try {
    const skill = join(temp, 'skill');
    cpSync(dir, skill, {
      recursive: true,
      filter: (source) => source === dir || !['.git', 'node_modules', '__pycache__'].includes(basename(source)) && !lstatSync(source).isSymbolicLink(),
    });
    const copiedRoot = realpathSync(skill);
    for (const entry of buildable) {
      const target = realpathSync(join(skill, entry));
      const inside = relative(copiedRoot, target);
      if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) || !lstatSync(target).isFile()) return 'FAIL';
    }
    if (existsSync(join(skill, 'package.json')) && !run(['bun', 'install', '--ignore-scripts'], skill)) return 'FAIL';
    for (const [index, entry] of buildable.entries()) {
      if (!run(['bun', 'build', entry, '--target=bun', '--outfile', join(temp, `entry-${index}.js`)], skill)) return 'FAIL';
    }
    return 'OK';
  } catch {
    return 'FAIL';
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function freeValid(doc: string, entries: ReadonlySet<string>): boolean {
  const section = /(?:^|\n)#{1,4}\s*[^\n]*(?:무료|free)[^\n]*\n([\s\S]*?)(?=\n#{1,4}\s|$)/giu;
  for (const match of doc.matchAll(section)) {
    const body = match[1]!;
    const keyless = /(?:키\s*없이|키\s*불필요|키\s*없는|API\s*키가\s*필요\s*없|no\s+(?:api\s+)?key|without\s+(?:an?\s+)?(?:api\s+)?key|keyless)/iu;
    const envRequired = body.split(/\r?\n/u).some((line) => /\.env\b/iu.test(line) &&
      !/(?:without|no|not\s+required|optional)\s+(?:an?\s+)?\.env\b|\.env\b[^\n]*(?:없이|불필요|선택|optional|not\s+required)/iu.test(line) &&
      /(?:\b(?:require|need|configure|create|copy|source|set\s*up|must)\b[^\n]*\.env\b|\.env\b[^\n]*(?:필요|설정|생성|복사|로드|\b(?:required|needed|must)\b))/iu.test(line));
    const runnable = [...body.matchAll(RUN_COMMAND)].some((command) => entries.has(command[1]!.replace(/^\.\//u, '')));
    // 리뷰 must-fix: 제목이 «키 없이»여도 본문이 키를 요구하면 무료 경로가 아니다.
    const keyRequired = /(?:\brequires?\s+(?:an?\s+)?(?:api\s+)?key\b|\bneeds?\s+(?:an?\s+)?(?:api\s+)?key\b|(?:API\s*)?키가?\s*필요(?!\s*없))/iu.test(body);
    if (keyless.test(match[0]) && runnable && !envRequired && !keyRequired &&
        !/(?:키\s*없는?\s+(?:자동|실행)\s*(?:경로|을)\s*(?:보장|지원)하지\s*않|without\s+(?:an?\s+)?(?:api\s+)?key\s+(?:is\s+)?not\s+supported)/iu.test(body)) return true;
  }
  return false;
}

/** 리뷰 must-fix: manifest 와 설치 명령의 «종류»가 맞아야 한다(requirements.txt 만 있는데 `bun install` 은 통과 아님). */
function installValid(doc: string, dir: string): boolean {
  const has = (name: string) => existsSync(join(dir, name)) && lstatSync(join(dir, name)).isFile();
  if (has('package.json') && /\b(?:bun|npm|pnpm|yarn)\s+(?:install|i)\b/imu.test(doc)) return true;
  for (const req of ['requirements.txt', 'requirements-python.txt']) {
    if (has(req) && new RegExp(`\\b(?:pip|pip3|uv\\s+pip)\\s+install\\s+-r\\s+\\S*${req.replace('.', '\\.')}\\b`, 'imu').test(doc)) return true;
  }
  if (has('pyproject.toml') && /\b(?:(?:pip|pip3|uv\s+pip)\s+install\s+(?:-e\s+)?\.(?:\s|$|\[)|uv\s+sync\b)/imu.test(doc)) return true;
  return false;
}

/** `boundary` is injectable for pure fixture tests; production always derives it from the repository. */
export function checkPublicSkills(root: string, boundary: SkillBoundaryReport = computeSkillBoundaries(root), build = false): PublicCheckReport {
  const errors = [...boundary.errors];
  const skills: PublicSkillRow[] = [];
  const skillsDir = join(root, 'skills');
  const addon = new Set(boundary.skills.filter((row) => row.verdict === 'addon').map((row) => row.skill));
  const names = existsSync(skillsDir) ? readdirSync(skillsDir).filter((name) => {
    const dir = join(skillsDir, name);
    return lstatSync(dir).isDirectory() && !addon.has(name);
  }).sort() : [];
  if (!existsSync(skillsDir)) errors.push('skills/ 디렉터리가 없다');
  for (const row of boundary.skills) {
    if (row.verdict === 'core' && !names.includes(row.skill)) errors.push(`${row.skill}: skills/ 디렉터리가 없다`);
  }
  for (const skill of names) {
    const dir = join(skillsDir, skill);
    const files = skillFiles(dir);
    const docPath = join(dir, 'SKILL.md');
    const doc = files.includes(docPath) ? readFileSync(docPath, 'utf8') : '';
    const docs = [doc, ...files.filter((f) => f !== docPath && /(?:^|\/)(?:README|INSTALL)\.md$/iu.test(f)).map((f) => readFileSync(f, 'utf8'))].join('\n');
    const matches: string[] = [];
    for (const file of files) {
      const bytes = readFileSync(file);
      if (bytes.includes(0)) continue;
      try {
        if (PERSONAL_OR_INTERNAL.test(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) matches.push(relative(root, file));
      } catch {
        // Binary assets are not text; extensionless and dotfiles are checked when decodable.
      }
    }
    const entries = new Set(executableEntries(files, dir, docs));
    const checks: PublicSkillRow['checks'] = {
      header: headerValid(doc, skill),
      entry: entries.size > 0 ? true : promptOnly(doc) ? 'N/A' : false,
      free: freeValid(docs, entries),
      portable: matches.length === 0,
      install: installValid(docs, dir),
      ...(build ? { build: buildSkillEntries(dir, [...entries]) } : {}),
    };
    const violations = [
      ...(!checks.header ? ['SKILL.md 머리(name·description) 없음/불일치'] : []),
      ...(checks.entry === false ? ['스킬 내부 실행 파일(scripts/src/bin)이 없음'] : []),
      ...(!checks.free ? ['키/.env 없이 쓰는 무료 경로가 문서에 없음'] : []),
      ...matches.map((file) => `${file}: 개인 경로/내부 표지 문자열`),
      ...(!checks.install ? ['의존 manifest와 문서의 한 줄 설치 명령이 없음'] : []),
      ...(checks.build === 'FAIL' ? ['스킬 실행 파일 빌드 실패'] : []),
    ];
    skills.push({ skill, checks, violations });
  }
  return { skills, errors, ok: errors.length === 0 && skills.every((row) => row.violations.length === 0) };
}

export function formatPublicCheck(report: PublicCheckReport): string {
  const columns: (PublicCheckKey | 'build')[] = ['header', 'entry', 'free', 'portable', 'install'];
  if (report.skills.some((row) => row.checks.build !== undefined)) columns.push('build');
  return [
    `skill                              ${columns.map((key) => key.padEnd(9)).join(' ')} result`,
    ...report.skills.map((row) => `${row.skill.padEnd(34)} ${columns.map((key) => { const value = row.checks[key]; return (typeof value === 'string' ? value : value ? 'OK' : 'FAIL').padEnd(9); }).join(' ')} ${row.violations.length ? row.violations.join('; ') : 'OK'}`),
    ...report.errors.map((error) => `ERROR ${error}`),
    `PUBLIC-CHECK ${report.ok ? 'PASS' : 'FAIL'} (${report.skills.length} public skills)`,
  ].join('\n');
}

export function runPublicCheck(root: string, args: readonly string[], boundary?: SkillBoundaryReport): { output: string; exitCode: number } {
  const report = checkPublicSkills(root, boundary, args.includes('--build'));
  return {
    output: args.includes('--json') ? JSON.stringify(report, null, 2) : formatPublicCheck(report),
    exitCode: report.ok ? 0 : 1,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--json' && arg !== '--build')) {
    console.error('Usage: bun scripts/skills/public-check.ts [--json] [--build]');
    process.exitCode = 2;
  } else {
    const result = runPublicCheck(join(import.meta.dir, '..', '..'), args);
    console.log(result.output);
    process.exitCode = result.exitCode;
  }
}
