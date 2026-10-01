/**
 * 문면 래칫 — 꾸러미에 실리는 파일의 사람 홈 절대경로 회귀를 막는다.
 *
 * `src/` 는 즉시 0건이어야 하고, 나머지 shipped 파일은 기존 위반을
 * 기준선으로 삼아 새 살아 있는 경로만 막는다. scripts/webclone/** 및 skills/**의
 * 기존 경로 정리는 이 테스트의 범위 밖이다.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
/** ⛔ 이 수는 ***이 시험의 분류기가 «직접 잰» 값***이어야 한다 — 사람이 문서에 쓴 수를 옮기면 «여유»가 생겨 안 문다.
 *  📏 2026-09-21: 문서의 244 대신 실측 242 로 못 박았다.
 *  📏 현재 꾸러미 재측정: 252. 기존 242 위에 실재하는 10건을 숨기지 않고
 *     현 시점의 부채를 래칫한다. 한 줄 더 넣으면 253 > 252 로 실패해야 한다.
 *  🔎 올릴 일이 생기면 «먼저» 왜 늘었는지 답하라. 내리는 것은 자유다. */
const LIVE_PERSONAL_HOME_BASELINE = 252;

type PackageJson = { files?: string[] };

type PersonalHomeCounts = {
  comment: number;
  live: number;
  liveViolations: string[];
};

/** 예시·자리표로 쓰이는 사용자 이름 — 실재 계정이 아니다. */
const PLACEHOLDER_USERS = new Set(['...', 'alice', 'bob', 'user', 'username', 'you', 'me', 'someone']);

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('#');
}

/** `/Users/<segment>` 에서 그 segment 가 «실재 계정처럼 보이는가». 치환식(`${…}`·`$HOME`·`<user>`)은 아니다. */
export function personalHomeSegment(line: string): string | undefined {
  for (const match of line.matchAll(/\/Users\/([^/'"`\s)\]}]+)/g)) {
    const segment = match[1]!;
    if (PLACEHOLDER_USERS.has(segment.toLowerCase())) continue;
    if (/[$<{]/.test(segment)) continue;
    return segment;
  }
  return undefined;
}

function filesMatching(root: string, pattern: string): string[] {
  const normalized = pattern.replace(/^\.\//, '');
  const path = join(root, normalized.replace(/\/$/, ''));
  const matches = existsSync(path)
    ? [normalized]
    : [...new Bun.Glob(normalized).scanSync({ cwd: root, onlyFiles: false, dot: true })];
  const files = new Set<string>();
  for (const match of matches) {
    const fullPath = join(root, match);
    const status = statSync(fullPath);
    if (status.isFile()) {
      files.add(match);
      continue;
    }
    if (status.isDirectory()) {
      for (const file of new Bun.Glob(`${match.replace(/\/$/, '')}/**/*`).scanSync({ cwd: root, onlyFiles: true, dot: true })) {
        files.add(file);
      }
    }
  }
  return [...files];
}

/** ⛔ npm 이 «선언 없이» 늘 빼는 것들 — `package.json` 의 `files` 에는 «안 적힌다».
 *  📏 2026-09-21 실측: 이것을 안 빼면 `tools/**\/node_modules` 가 딸려 와 살아 있는 줄이
 *     ***244 → 3,850*** 으로 부푼다. 「files 를 그대로 따랐다」만으로는 꾸러미와 안 맞는다.
 *  🔗 같은 뿌리의 결함이 `scripts/ci-shipped-devdep-gate.ts` 에도 있다(파일시스템 글롭). */
const NPM_IMPLICIT_EXCLUDES = ['node_modules', '.git'] as const;

function isImplicitlyExcluded(file: string): boolean {
  const segments = file.split('/');
  return NPM_IMPLICIT_EXCLUDES.some((name) => segments.includes(name));
}

function shippedFiles(root: string, packageJson: PackageJson): string[] {
  const entries = packageJson.files;
  if (!entries?.length) throw new Error('package.json files contract is missing or empty');
  const included = new Set<string>();
  const excluded = new Set<string>();
  for (const entry of entries) {
    if (!entry) throw new Error('package.json files contains an empty pattern');
    const target = entry.startsWith('!') ? excluded : included;
    for (const file of filesMatching(root, entry.startsWith('!') ? entry.slice(1) : entry)) target.add(file);
  }
  return [...included].filter(file => !excluded.has(file) && !isImplicitlyExcluded(file)).sort();
}

function countPersonalHomes(files: readonly string[], root = ROOT): PersonalHomeCounts {
  const counts: PersonalHomeCounts = { comment: 0, live: 0, liveViolations: [] };
  for (const file of files) {
    const lines = readFileSync(join(root, file), 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      const segment = personalHomeSegment(line);
      if (!segment) return;
      if (isCommentLine(line)) {
        counts.comment += 1;
        return;
      }
      counts.live += 1;
      counts.liveViolations.push(`${file}:${index + 1} → /Users/${segment}`);
    });
  }
  return counts;
}

function assertLiveBaseline(liveCount: number): void {
  if (liveCount > LIVE_PERSONAL_HOME_BASELINE) {
    throw new Error(`shipped live personal-home paths increased: ${liveCount} > ${LIVE_PERSONAL_HOME_BASELINE}`);
  }
}

function sourceFiles(root = ROOT): string[] {
  return filesMatching(root, 'src/').filter(file =>
    /\.[cm]?[jt]sx?$/.test(file)
    && !file.endsWith('.test.ts')
    && !file.includes('/node_modules/')
    && !file.includes('/__snapshots__/'));
}

function withFixture(files: Record<string, string>, run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'no-personal-home-in-core-'));
  try {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('문면 래칫 — 꾸러미에 실리는 사람 홈 절대경로', () => {
  test('★ src/ 의 «비주석» 줄에 /Users/<실재 계정> 이 0건이다', () => {
    const counts = countPersonalHomes(sourceFiles());
    expect(counts.liveViolations).toEqual([]);
  }, 60_000);

  test('package.json files 선언에서 shipped 파일을 파생하고 모든 ! 제외를 존중한다', () => {
    const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as PackageJson;
    const files = shippedFiles(ROOT, packageJson);

    expect(files.length).toBeGreaterThan(0);
    expect(files).not.toContain('scripts/no-personal-home-in-core.test.ts');
    expect(files.some(file => file.endsWith('.log'))).toBeFalse();
    expect(files.some(file => file.includes('/__snapshots__/'))).toBeFalse();
    expect(files.some(file => file.endsWith('.pyc') || file.includes('/__pycache__/'))).toBeFalse();
  }, 60_000);

  test('src/ 독립 순회는 shipped 집합이 비어도 기존 소스 필터 안의 개인 홈 위반을 유지한다', () => {
    withFixture({
      'package.json': JSON.stringify({ files: ['scripts/', '!scripts/**'] }),
      'src/excluded.ts': "export const path = '/Users/jdoe/private';\n",
      'src/node_modules/dependency.ts': "export const path = '/Users/jdoe/dependency';\n",
      'src/__snapshots__/fixture.ts': "export const path = '/Users/jdoe/snapshot';\n",
      'src/readme.md': '/Users/jdoe/non-code\n',
    }, root => {
      const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson;
      expect(shippedFiles(root, packageJson)).toEqual([]);
      expect(sourceFiles(root)).toEqual(['src/excluded.ts']);
      expect(countPersonalHomes(sourceFiles(root), root).liveViolations).toEqual([
        'src/excluded.ts:1 → /Users/jdoe',
      ]);
    });
  });

  test('실제 꾸러미의 주석과 살아 있는 개인 홈 경로를 따로 세고, 살아 있는 수를 래칫한다', () => {
    const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as PackageJson;
    const counts = countPersonalHomes(shippedFiles(ROOT, packageJson));

    expect(counts.comment).toBeGreaterThan(0);
    expect(counts.live).toBeLessThanOrEqual(LIVE_PERSONAL_HOME_BASELINE);
    assertLiveBaseline(counts.live);
  }, 60_000);

  test('★ 벙어리가 아니다 — 기준선보다 하나 많으면 실패하고, 더 적으면 통과한다', () => {
    expect(() => assertLiveBaseline(LIVE_PERSONAL_HOME_BASELINE + 1)).toThrow(
      `shipped live personal-home paths increased: ${LIVE_PERSONAL_HOME_BASELINE + 1} > ${LIVE_PERSONAL_HOME_BASELINE}`,
    );
    expect(() => assertLiveBaseline(LIVE_PERSONAL_HOME_BASELINE - 1)).not.toThrow();
  });

  test('★ 위반 한 줄은 걸리고 자리표와 치환식은 안 건다', () => {
    expect(personalHomeSegment("const D = '/Users/jdoe/obsidian/X';")).toBe('jdoe');
    expect(personalHomeSegment("const D = join(HOME, 'obsidian/X');")).toBeUndefined();
    expect(personalHomeSegment('e.g. /Users/alice vs /Users/bob')).toBeUndefined();
    expect(personalHomeSegment('Absolute paths (`/Users/...`) preferred')).toBeUndefined();
    expect(personalHomeSegment('const p = `/Users/${name}/x`;')).toBeUndefined();
  });
});
