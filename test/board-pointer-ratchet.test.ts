import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CURRENT-RELEASE-ONE-SOURCE 래칫 (대표 11-28 «현재 판 번호 = 가장 중요한 기준선»).
 * «현재 판»은 activeBoardVersion() / readBoardPointer() / boardVersion() 하나로만 읽는다. 패키지 dev 판(devVersion())이나
 * release.graph.version(발사 그래프의 판별 live 승인)을 판 고르기에 직접 쓰는 줄이 새로 생기면 실패한다.
 * 허용 = 아래 리터럴 표(파일별 상한) — 판 고르기가 아닌 쓰임(체크리스트 행의 dev 도장 · 판 고르기 함수 자신 ·
 * 발사 그래프 런 독자 · 관측 명령)만. 주석·시험은 제외. 줄이면 표도 같이 줄인다.
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
/** devVersion() / checklistDevVersion() with no argument, or passed as a default reader `?? devVersion)`. */
const PACKAGE_AS_BOARD = /\b(?:checklistDevVersion|devVersion)\(\)|\?\?\s*(?:checklistDevVersion|devVersion)\)/g;
const GRAPH_AS_BOARD = /\breadReleaseGraphVersion\(/g;

const PACKAGE_ALLOW: Record<string, number> = {
  'src/cli/release-current-cli.ts': 1, // observability: shows the package version beside the board
  'src/ops-dashboard/current-version.ts': 2, // activeBoardVersion's last fallback · resolveCurrentVersion's package source
  'src/release-loop/checklist.ts': 2, // checklistDevVersion's default · mutate's `dev` stamp
  'src/release-loop/feature-store.ts': 10, // `dev` provenance stamp on checklist rows (not a board choice)
};
const GRAPH_ALLOW: Record<string, number> = {
  'src/judge-butler/live.ts': 1, // the readRaw test seam, behind resolveCurrentVersion (board first)
  'src/loop-agent/bodies/hand-steward.ts': 1, // behind resolveCurrentVersion (board first) — #40624 owns the file
  'src/loop-agent/bodies/release-rocket.ts': 1, // graph-run reader (boardVersion: null) — follows the run being launched
  'src/loops/trigger-facts.ts': 1, // graph-run reader — which release-graph run is active
  'src/ops-dashboard/current-version.ts': 1, // resolveCurrentVersion's legacy graph source (readBoardPointer takes it as a default reader)
  'src/ux-sim/sim-world/supervisors/current-board.ts': 1, // the BOARD-TIMELINE-1128 scene replays the pre-fix reader on purpose
};

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'fixtures') sources(path, out); continue; }
    if (/\.(ts|tsx|mjs)$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) out.push(path);
  }
  return out;
}

function count(pattern: RegExp): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of [...sources(join(REPO, 'src')), ...sources(join(REPO, 'scripts'))]) {
    let n = 0;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      if (/^export function (?:devVersion|readReleaseGraphVersion)\(/u.test(t)) continue;
      n += (line.match(pattern) ?? []).length;
    }
    if (n) found[relative(REPO, file)] = n;
  }
  return found;
}

const over = (found: Record<string, number>, allow: Record<string, number>) =>
  Object.entries(found).filter(([file, n]) => n > (allow[file] ?? 0)).map(([file, n]) => `${file}: ${n} > ${allow[file] ?? 0}`);

test('no new board selection from the package dev version (devVersion() · checklistDevVersion())', () => {
  expect(over(count(PACKAGE_AS_BOARD), PACKAGE_ALLOW)).toEqual([]);
});

test('no new board selection from release.graph.version (the graph live approval, not the board)', () => {
  expect(over(count(GRAPH_AS_BOARD), GRAPH_ALLOW)).toEqual([]);
});

test('the allow tables are tight — a file that dropped its uses must drop its row', () => {
  const pkg = count(PACKAGE_AS_BOARD); const graph = count(GRAPH_AS_BOARD);
  expect(Object.entries(PACKAGE_ALLOW).filter(([f, n]) => (pkg[f] ?? 0) < n).map(([f]) => f)).toEqual([]);
  expect(Object.entries(GRAPH_ALLOW).filter(([f, n]) => (graph[f] ?? 0) < n).map(([f]) => f)).toEqual([]);
});
