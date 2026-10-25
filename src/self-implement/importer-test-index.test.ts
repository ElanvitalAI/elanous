import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildImporterTestIndex, isSourceLikeSpecifier, isTestPath, measureRuntimeEdgeImpact } from './importer-test-index.js';
import { resolveGateScope } from './gate-scope.js';
import { GATE_SPAWN_LANE_FILES } from '../self-dev/spawn-lane-files.js';

function fixture(files: Record<string, string>): { cwd: string; dispose: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'importer-test-index-'));
  for (const [path, content] of Object.entries(files)) {
    const file = join(cwd, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
  }
  return { cwd, dispose: () => rmSync(cwd, { recursive: true, force: true }) };
}

describe('buildImporterTestIndex — ordered TypeScript extension resolution', () => {
  test('a tracked scripts/ source is indexed from a relative test import without changing src/ resolution', () => {
    const repo = fixture({
      'scripts/compute.ts': 'export const compute = 1;\n',
      'src/service.ts': 'export const service = 1;\n',
      'test/compute.test.ts': "import '../scripts/compute.js';\nimport '../src/service.js';\n",
    });
    try {
      const index = buildImporterTestIndex(repo.cwd, ['test/compute.test.ts'], ['scripts/compute.ts', 'src/service.ts']);
      expect(index?.testsBySource.get('scripts/compute.ts')).toEqual(['test/compute.test.ts']);
      expect(index?.testsBySource.get('src/service.ts')).toEqual(['test/compute.test.ts']);
      expect(index?.unresolvedRelativeSpecifiers).toBe(0);
    } finally { repo.dispose(); }
  });
  test('a .js specifier registers only its first existing .ts candidate when .ts and .js coexist', () => {
    const repo = fixture({
      'src/x.ts': 'export const ts = true;\n',
      'src/x.js': 'export const js = true;\n',
      'test/importer.test.ts': "import '../src/x.js';\n",
    });
    try {
      const index = buildImporterTestIndex(repo.cwd, ['test/importer.test.ts'], ['src/x.ts', 'src/x.js']);
      expect(index).not.toBeNull();
      expect(index?.testsBySource.get('src/x.ts')).toEqual(['test/importer.test.ts']);
      expect(index?.testsBySource.get('src/x.js')).toBeUndefined();

      const scope = resolveGateScope(['src/x.ts', 'src/x.js'], () => false, index ?? undefined);
      expect(scope.importerTestsNotRun).toMatchObject({ total: 1, files: ['test/importer.test.ts'], truncated: false });
    } finally {
      repo.dispose();
    }
  });

  test('a .jsx specifier resolves to .tsx before a coexisting .jsx source', () => {
    const repo = fixture({
      'src/view.tsx': 'export const View = null;\n',
      'src/view.jsx': 'export const View = null;\n',
      'test/importer.test.ts': "import '../src/view.jsx';\n",
    });
    try {
      const index = buildImporterTestIndex(repo.cwd, ['test/importer.test.ts'], ['src/view.tsx', 'src/view.jsx']);
      expect(index).not.toBeNull();
      expect(index?.testsBySource.get('src/view.tsx')).toEqual(['test/importer.test.ts']);
      expect(index?.testsBySource.get('src/view.jsx')).toBeUndefined();
    } finally {
      repo.dispose();
    }
  });

  test('an extensionless directory import resolves its index source and removes its unresolved observation', () => {
    const repo = fixture({
      'src/compact/index.ts': 'export const compact = true;\n',
      'test/importer.test.ts': "import '../src/compact';\n",
    });
    try {
      const unresolved = buildImporterTestIndex(repo.cwd, ['test/importer.test.ts'], []);
      const index = buildImporterTestIndex(repo.cwd, ['test/importer.test.ts'], ['src/compact/index.ts']);
      expect(unresolved?.unresolvedRelativeSpecifiers).toBe(1);
      expect(index?.testsBySource.get('src/compact/index.ts')).toEqual(['test/importer.test.ts']);
      expect(index?.unresolvedRelativeSpecifiers).toBe(0);
    } finally {
      repo.dispose();
    }
  });

  // ⭐ 2026-08-25 — 못 푼 지정자 **20건 중 16건(80%)**이 이 한 가지였다.
  //   `apps/pwa/**` 의 시험이 «같은 모듈을 다른 목으로 여러 번» 부르려고 Bun 쿼리를 쓴다.
  //   ⛔ 그 접미사를 안 벗기면 실재하는 `SubjectList.tsx` 를 «못 찾고», 그 실패가
  //   「해석기의 사각」이 아니라 「소스가 없다」로 잘못 세어진다.
  test('⭐ 모듈 «쿼리» 접미사를 벗기고 해석한다 — `./view?mock` 은 `./view` 다', () => {
    const repo = fixture({
      'src/view.ts': 'export const View = null;\n',
      'test/importer.test.ts': "import '../src/view?first';\nimport '../src/view?second';\n",
    });
    try {
      const index = buildImporterTestIndex(repo.cwd, ['test/importer.test.ts'], ['src/view.ts']);
      expect(index?.testsBySource.get('src/view.ts')).toEqual(['test/importer.test.ts']);
      expect(index?.unresolvedRelativeSpecifiers).toBe(0);
    } finally {
      repo.dispose();
    }
  });

  test('⭐ 확장자 «⊕» 쿼리가 같이 와도 해석한다 — `./view.js?mock`', () => {
    const repo = fixture({
      'src/view.ts': 'export const View = null;\n',
      'test/importer.test.ts': "import '../src/view.js?mock';\n",
    });
    try {
      const index = buildImporterTestIndex(repo.cwd, ['test/importer.test.ts'], ['src/view.ts']);
      expect(index?.testsBySource.get('src/view.ts')).toEqual(['test/importer.test.ts']);
      expect(index?.unresolvedRelativeSpecifiers).toBe(0);
    } finally {
      repo.dispose();
    }
  });

  // ⛔ 쿼리를 벗겼다고 «자원» import 까지 소스로 세면 안 된다 — 그 수가 부풀면
  //   「해석기가 못 읽은 소스」라는 뜻이 다시 흐려진다.
  test('⛔ 자원 import 는 쿼리가 붙어도 «미해결로 세지 않는다» — `./data.json?raw`', () => {
    const repo = fixture({
      'test/importer.test.ts': "import '../fixtures/data.json?raw';\n",
    });
    try {
      const index = buildImporterTestIndex(repo.cwd, ['test/importer.test.ts'], []);
      expect(index?.unresolvedRelativeSpecifiers).toBe(0);
    } finally {
      repo.dispose();
    }
  });
});

// ⛔⭐ 무인 리뷰 must-fix 둘의 회귀 가드 — 「고쳤다」가 «실물»과 갈리지 않게.
test('treats an extensionless relative import as source-like even when the path starts with dots', () => {
  // 📏 종전 판 `^[^.]*$` 는 `../src/missing` 을 «못 물어» 미해결 수를 과소 집계했다.
  expect(isSourceLikeSpecifier('../src/missing')).toBe(true);
  expect(isSourceLikeSpecifier('./sibling')).toBe(true);
  expect(isSourceLikeSpecifier('../src/thing.js')).toBe(true);
  // 자원 import 는 «미해결이 아니라 대상이 아니다» — 세면 수가 부푼다.
  expect(isSourceLikeSpecifier('./fixtures/data.json')).toBe(false);
  expect(isSourceLikeSpecifier('../styles/app.css')).toBe(false);
});

test('recognises a tracked test path that contains a space', () => {
  // 📏 종전 판은 `\\S+` 라 «공백이 든 유효 경로»를 조용히 버렸다 — 그리고 그 판정이 seams 에도 «복제»돼 있었다.
  expect(isTestPath('test/dir with space/thing.test.ts')).toBe(true);
  expect(isTestPath('src/a/b.ts')).toBe(false);
});

// TRAIN-REACH-GROUPING — 릴리스 열차 묶음: 두 PR 의 도달 시험 집합(testsReachingChanged 결과)이
// 같은 시험에 닿으면 두 PR 은 한 열차로 떠나고, 닿지 않으면 별도 열차로 남는다(모의 데이터 무대).
//
// ⛔ `defineTrainGrouping` 은 «이 변경으로 새로 생긴» export 다 — 정적 import 로 끌면 고정 기준점(base)
//   에서 이 파일 «전체»가 모듈 적재 오류로 죽고, gate 는 적재 오류를 유효한 빨강 목격으로 세지 않는다
//   (`unknownReason=module-load-error` → `changed-test-evidence=unproved`). 동적 import 뒤 «export 가
//   함수인가»를 먼저 단언하면 base 에서도 파일은 적재되고 이 세 시험만 «단언 수준»에서 붉어진다.
type TrainReachPair = { pr: string; tests: readonly string[] };

async function defineTrainGrouping(left: TrainReachPair, right: TrainReachPair) {
  const gateClosure = await import('../../scripts/release-loop/gate-closure.js');
  expect(typeof gateClosure.defineTrainGrouping).toBe('function');
  return gateClosure.defineTrainGrouping(left, right);
}

describe('TRAIN-REACH-GROUPING — defineTrainGrouping: 도달 시험 집합 교집합이 열차 묶음을 정한다', () => {
  test('① 교집합이 있는 PR 두 쌍은 같은 열차 ID 로 묶인다', async () => {
    const pairOne = await defineTrainGrouping(
      { pr: '26146', tests: ['src/a.test.ts', 'src/shared.test.ts'] },
      { pr: '26147', tests: ['src/shared.test.ts', 'src/b.test.ts'] },
    );
    expect(pairOne.sameTrain).toBe(true);
    expect(pairOne.trainIds.get('26146')).toBe(pairOne.trainIds.get('26147'));

    const pairTwo = await defineTrainGrouping(
      { pr: '26390', tests: ['test/one.test.ts', 'test/two.test.ts', 'test/three.test.ts'] },
      { pr: '26395', tests: ['test/two.test.ts'] },
    );
    expect(pairTwo.sameTrain).toBe(true);
    expect(pairTwo.trainIds.get('26390')).toBe(pairTwo.trainIds.get('26395'));
  });

  test('② 교집합이 없는 쌍은 별도 열차로 남는다', async () => {
    const disjoint = await defineTrainGrouping(
      { pr: '26101', tests: ['src/c.test.ts'] },
      { pr: '26102', tests: ['src/d.test.ts', 'src/e.test.ts'] },
    );
    expect(disjoint.sameTrain).toBe(false);
    expect(disjoint.intersection).toEqual([]);
    expect(disjoint.trainIds.get('26101')).not.toBe(disjoint.trainIds.get('26102'));

    // 두 도달 집합이 모두 비어 있어도 교집합은 없다 — 별도 열차다.
    const bothEmpty = await defineTrainGrouping({ pr: '26201', tests: [] }, { pr: '26202', tests: [] });
    expect(bothEmpty.sameTrain).toBe(false);
    expect(bothEmpty.trainIds.get('26201')).not.toBe(bothEmpty.trainIds.get('26202'));
  });

  test('③ 교집합·열차 ID 결과를 묶음 원장(반환 데이터)과 대조한다', async () => {
    const ledger = await defineTrainGrouping(
      { pr: '26390', tests: ['src/y.test.ts', 'src/shared.test.ts', 'src/x.test.ts'] },
      { pr: '26391', tests: ['src/shared.test.ts', 'src/z.test.ts', 'src/y.test.ts'] },
    );
    // 원장의 교집합 — 두 도달 집합이 공유하는 시험(정렬).
    expect(ledger.intersection).toEqual(['src/shared.test.ts', 'src/y.test.ts']);
    // 원장의 열차 ID — 두 PR 키가 각각 배정받았고 같은 값이다.
    expect([...ledger.trainIds.keys()].sort()).toEqual(['26390', '26391']);
    expect(ledger.trainIds.get('26390')).toBe(ledger.trainIds.get('26391'));
    // 결정론 — 같은 입력(집합 순서만 다른)에 같은 열차 ID 를 돌려준다.
    const reordered = await defineTrainGrouping(
      { pr: '26390', tests: ['src/shared.test.ts', 'src/y.test.ts', 'src/x.test.ts'] },
      { pr: '26391', tests: ['src/y.test.ts', 'src/shared.test.ts', 'src/z.test.ts'] },
    );
    expect(reordered.trainIds.get('26390')).toBe(ledger.trainIds.get('26390'));
    expect(reordered.trainIds.get('26391')).toBe(ledger.trainIds.get('26391'));
    expect(reordered.intersection).toEqual(ledger.intersection);
  });
});
// ⭐ IMPORT-GRAPH-SCC-FU — 임포트 그래프가 «표현할 수 없는» 간선(spawn · git · 파일 상태)의 **영향 크기**.
//   ⛔ #28322 착지분(BFS 분포 · 사람용 표 렌더링)은 여기서 재구현하지 않는다 — 이 시험은 «수»만 잰다.
describe('measureRuntimeEdgeImpact — 런타임 간선의 영향 크기 실측', () => {
  const SOURCES = ['bin/elanous.mjs', 'src/cli.ts'];
  const TEST_PATHS = ['test/spawns-cli.test.ts', 'test/gits.test.ts', 'test/reads-state.test.ts', 'test/imports-cli.test.ts'];
  const build = () => {
    const repo = fixture({
      'bin/elanous.mjs': '#!/usr/bin/env bun\n',
      'src/cli.ts': 'export const cli = 1;\n',
      // 실물 자식 프로세스 — 임포트 간선은 «없다». 지목한 파일은 루트 기준 리터럴이다.
      'test/spawns-cli.test.ts': "import { spawnSync } from 'node:child_process';\nspawnSync('bun', ['bin/elanous.mjs']);\n",
      // `git` 은 파일을 «지목하지 않는다» — 그래도 실물 자식이다(spawn-lane).
      'test/gits.test.ts': "import { spawnSync } from 'node:child_process';\nspawnSync('git', ['diff', '--name-only']);\n",
      // 파일 상태 — 그 소스의 상태를 읽는다.
      'test/reads-state.test.ts': "import { existsSync } from 'node:fs';\nexistsSync('src/cli.ts');\n",
      // 이미 «임포트» 간선이 있는 대조군 — 런타임 간선 몫으로 두 번 세면 안 된다.
      'test/imports-cli.test.ts': "import '../src/cli.js';\n",
    });
    return { repo, index: buildImporterTestIndex(repo.cwd, TEST_PATHS, SOURCES) };
  };

  test('세 클래스를 구분해 측정한다 — spawn 은 지목한 소스에 닿고 git 은 파일을 지목하지 않는다', () => {
    const { repo, index } = build();
    try {
      expect(index?.runtimeEdges).toContainEqual({ test: 'test/spawns-cli.test.ts', kind: 'spawn', source: 'bin/elanous.mjs' });
      expect(index?.runtimeEdges).toContainEqual({ test: 'test/reads-state.test.ts', kind: 'file-state', source: 'src/cli.ts' });
      expect(index?.runtimeEdges).toContainEqual({ test: 'test/gits.test.ts', kind: 'git', source: null });
      // 실물 소스로 풀리지 않은 런타임 경로는 «0» 이다 — 여기 리터럴은 전부 실재한다.
      expect(index?.unresolvedRuntimeTargets).toBe(0);
    } finally {
      repo.dispose();
    }
  });

  test('영향 크기는 «임포트가 못 잡는 짝»만 센다 — 임포트 간선이 있는 짝은 빼고 센다', () => {
    const { repo, index } = build();
    try {
      // bin/elanous.mjs: 스폰만이 닿는다 ⇒ 1쌍.
      const spawned = measureRuntimeEdgeImpact(index!, ['bin/elanous.mjs']);
      expect(spawned).toMatchObject({ measured: true, pairs: 1, byKind: { spawn: 1, git: 0, 'file-state': 0 } });
      // src/cli.ts: 읽기(파일 상태) 1쌍 + 임포트 1건(이미 아는 짝이라 «빼고» 센다).
      const stateRead = measureRuntimeEdgeImpact(index!, ['src/cli.ts']);
      expect(stateRead).toMatchObject({ measured: true, pairs: 1, byKind: { spawn: 0, git: 0, 'file-state': 1 } });
      // 변경이 없으면 더할 것도 없다.
      expect(measureRuntimeEdgeImpact(index!, []).pairs).toBe(0);
    } finally {
      repo.dispose();
    }
  });

  test('⭐ 착지 열차 소비자 1건의 영향 크기 — 손 목록(GATE_SPAWN_LANE_FILES)이 빠뜨린 실측 시험', () => {
    const { repo, index } = build();
    try {
      // 손 목록이 git 시험만 알고 있다면, 스폰 시험 1건이 «빠진» 크기다.
      expect(measureRuntimeEdgeImpact(index!, [], { handListed: ['test/gits.test.ts'] }).unlistedSpawnLaneTests)
        .toEqual(['test/spawns-cli.test.ts']);
      // 손 목록이 둘 다 알면 드리프트는 0 이다(목록을 고치는 것이 아니라 «크기»를 재는 자리).
      expect(measureRuntimeEdgeImpact(index!, [], { handListed: ['test/gits.test.ts', 'test/spawns-cli.test.ts'] }).unlistedSpawnLaneTests)
        .toEqual([]);
    } finally {
      repo.dispose();
    }
  });

  test('⛔ «안 쟀다»와 «0건»을 섞지 않는다 — 런타임 간선이 없는 색인은 measured: false', () => {
    const legacy = { testsBySource: new Map<string, readonly string[]>(), unresolvedRelativeSpecifiers: 0 };
    expect(measureRuntimeEdgeImpact(legacy, ['src/cli.ts'])).toMatchObject({ measured: false, pairs: 0 });
  });

  test('⭐ 생산 진입점(resolveGateScope)이 이 측정을 «실제로» 부른다 — 판정 필드는 그대로다', () => {
    const { repo, index } = build();
    try {
      const scope = resolveGateScope(['src/cli.ts'], () => false, index ?? undefined);
      // 보존: 기존 관측 필드의 뜻이 안 바뀐다(임포트 간선만 본다).
      expect(scope.importerTestsNotRun).toMatchObject({ total: 1, files: ['test/imports-cli.test.ts'], truncated: false });
      // 배선: 새 필드가 생산 함수의 반환에서 «채워져» 나온다.
      expect(scope.runtimeEdgeImpact).toMatchObject({ measured: true, pairs: 1, byKind: { spawn: 0, git: 0, 'file-state': 1 } });
      // 색인을 안 실으면 못 잰 것(null)이지 0건이 아니다.
      expect(resolveGateScope(['src/cli.ts'], () => false).runtimeEdgeImpact).toBeNull();
    } finally {
      repo.dispose();
    }
  });

  test('⛔ 확장자 순서 해석을 그대로 재사용한다 — `bin/cli.js` 리터럴은 `bin/cli.ts` 로 해석된다', () => {
    const repo = fixture({
      'bin/cli.ts': 'export const cli = 1;\n',
      'test/runs.test.ts': "import { spawnSync } from 'node:child_process';\nspawnSync('bun', ['bin/cli.js']);\n",
    });
    try {
      const index = buildImporterTestIndex(repo.cwd, ['test/runs.test.ts'], ['bin/cli.ts']);
      expect(index?.runtimeEdges).toContainEqual({ test: 'test/runs.test.ts', kind: 'spawn', source: 'bin/cli.ts' });
      expect(index?.unresolvedRuntimeTargets).toBe(0);
    } finally {
      repo.dispose();
    }
  });

  test('못 푼 런타임 경로는 정직하게 센다 — `unresolvedRelativeSpecifiers` 와 같은 자', () => {
    const repo = fixture({
      'test/runs.test.ts': "import { spawnSync } from 'node:child_process';\nspawnSync('bun', ['scripts/gone.ts']);\n",
    });
    try {
      const index = buildImporterTestIndex(repo.cwd, ['test/runs.test.ts'], []);
      expect(index?.unresolvedRuntimeTargets).toBe(1);
      // 지목한 소스가 없어도 «실물을 띄웠다»는 사실은 남는다 — source: null.
      expect(index?.runtimeEdges).toContainEqual({ test: 'test/runs.test.ts', kind: 'spawn', source: null });
      expect(measureRuntimeEdgeImpact(index!, ['scripts/gone.ts']).pairs).toBe(0);
    } finally {
      repo.dispose();
    }
  });

  // ⛔⭐ 무인 리뷰 must-fix — 호출 이름의 «마지막 조각만» 보면 일반 메서드 호출도 간선이 된다.
  //   수신 객체·맨살 callee 의 **임포트 바인딩** 출처를 확인한다: 정규식 `.exec`·`db.exec`·
  //   `fsMock.readFile` 는 spawn·file-state 간선이 «아니다».
  test('⛔ 임포트 바인딩 확인 — `/re/.exec(str)`·`db.exec(...)`·`fsMock.readFile(...)` 는 간선이 아니다', () => {
    const repo = fixture({
      'src/cli.ts': 'export const cli = 1;\n',
      'bin/elanous.mjs': '#!/usr/bin/env bun\n',
      // 정규식 리터럴 수신 — `exec` 는 RegExp.prototype 메서드다.
      'test/regex-exec.test.ts': "const m = /src\\/(.*)/.exec('src/cli.ts');\nif (m) console.log(m[1]);\n",
      // 임포트 출처를 알 수 없는 수신 객체 — `bun:sqlite` 는 런타임 간선 모듈이 아니다.
      'test/db-exec.test.ts': "import { Database } from 'bun:sqlite';\nconst db = new Database(':memory:');\ndb.exec('create table t (x int)');\n",
      // 임포트 출처를 알 수 없는 수신 객체 — mock 헬퍼의 `readFile` 도 파일 상태 간선이 아니다.
      'test/fs-mock-read.test.ts': "import { readFile } from '../helpers/fs-mock.js';\nreadFile('src/cli.ts');\n",
      // 대조군 ① — 런타임 모듈의 named import 맨살 호출은 그대로 간선이다.
      'test/real-spawn.test.ts': "import { spawnSync } from 'node:child_process';\nspawnSync('bun', ['bin/elanous.mjs']);\n",
      // 대조군 ② — 전역 `Bun` 수신도 간선이다(임포트가 없는 유일한 출처).
      'test/bun-spawn.test.ts': "Bun.spawn(['bun', 'bin/elanous.mjs']);\n",
      // 대조군 ③ — 네임스페이스 임포트 수신(`cp.spawnSync`)도 바인딩으로 잡는다.
      'test/namespace-spawn.test.ts': "import * as cp from 'node:child_process';\ncp.spawnSync('git', ['diff', '--name-only']);\n",
    });
    try {
      const index = buildImporterTestIndex(repo.cwd, [
        'test/regex-exec.test.ts', 'test/db-exec.test.ts', 'test/fs-mock-read.test.ts',
        'test/real-spawn.test.ts', 'test/bun-spawn.test.ts', 'test/namespace-spawn.test.ts',
      ], ['bin/elanous.mjs', 'src/cli.ts']);
      const edgesOf = (test: string) => (index?.runtimeEdges ?? []).filter((edge) => edge.test === test);
      // 오탐 셋은 간선이 «없다» — 특히 `regex-exec` 의 `'src/cli.ts'` 인자가 spawn 간선으로 승격되던 버그.
      expect(edgesOf('test/regex-exec.test.ts')).toEqual([]);
      expect(edgesOf('test/db-exec.test.ts')).toEqual([]);
      expect(edgesOf('test/fs-mock-read.test.ts')).toEqual([]);
      // 실물 셋은 그대로 잡는다 — 오탐 제거가 과소 집계로 바뀌면 안 된다.
      expect(edgesOf('test/real-spawn.test.ts')).toContainEqual({ test: 'test/real-spawn.test.ts', kind: 'spawn', source: 'bin/elanous.mjs' });
      expect(edgesOf('test/bun-spawn.test.ts')).toContainEqual({ test: 'test/bun-spawn.test.ts', kind: 'spawn', source: 'bin/elanous.mjs' });
      expect(edgesOf('test/namespace-spawn.test.ts')).toContainEqual({ test: 'test/namespace-spawn.test.ts', kind: 'git', source: null });
      // 미등재 spawn-lane 목록도 같은 판정을 쓴다 — 오탐 시험이 목록에 끼지 «않는다».
      expect(measureRuntimeEdgeImpact(index!, []).unlistedSpawnLaneTests)
        .toEqual(['test/bun-spawn.test.ts', 'test/namespace-spawn.test.ts', 'test/real-spawn.test.ts']);
    } finally {
      repo.dispose();
    }
  });
});

// ⭐ 칸 문면의 판정선 — 합성 fixture 가 아니라 **추적된 실물 트리**에서, 생산 진입점(resolveGateScope)을 지나 영향 크기를 잰다.
//   범위를 `src/self-implement` 로 좁힌 이유는 속도다(전건 추적 트리는 별도 1회 관측 런으로 쟀다).
//   ⛔ #28322 착지분(BFS 분포·사람용 표)은 여기서도 재구현하지 않는다 — 이 측정은 «수»만 낸다.
test('⭐ 실물 트리 — 추적된 src/self-implement 시험에서 런타임 간선 영향 크기를 실제로 잰다', () => {
  const root = join(import.meta.dir, '..', '..');
  const tracked = execFileSync('git', ['ls-files', 'src/self-implement'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
    .split('\n')
    .filter((path) => path.length > 0);
  const testPaths = tracked.filter(isTestPath);
  const sources = tracked.filter((path) => !isTestPath(path) && /\.(?:[cm]?[jt]sx?)$/.test(path));
  expect(testPaths.length).toBeGreaterThan(1);
  const index = buildImporterTestIndex(root, testPaths, sources);
  expect(index).not.toBeNull();
  const impact = measureRuntimeEdgeImpact(index!, sources, { handListed: GATE_SPAWN_LANE_FILES });
  // 「쟀다」가 먼저다 — 못 잰 색인이면 수는 «0건» 이 아니라 «모름» 이다.
  expect(impact.measured).toBe(true);
  // 이 시험 파일 «자신»이 `git ls-files` 를 띄운다 — 실물 간선이 색인에 실제로 잡힌다(fixture 아님).
  expect(index!.runtimeEdges).toContainEqual({ test: 'src/self-implement/importer-test-index.test.ts', kind: 'git', source: null });
  // 착지 열차 손 목록은 실물에서 드리프트하고 있다 — 그 «크기»를 잰다(목록은 고치지 않는다).
  expect(impact.unlistedSpawnLaneTests.length).toBeGreaterThan(0);
  // ⛔⭐ GOODHART 가드(무인 리뷰 must-fix) — `length > 0` 만으로는 오탐만으로도 통과할 수 있다.
  //   ① 진짜 드리프트를 파일명으로 고정한다: 이 시험 파일 «자신»이 `git ls-files` 를 실제로 띄우는데도
  //      `GATE_SPAWN_LANE_FILES` 손 목록에 없다 — 실측 미등재 목록(57건)의 1건이다.
  expect(impact.unlistedSpawnLaneTests).toContain('src/self-implement/importer-test-index.test.ts');
  //   ② 정규식 `.exec` 만 쓰는 실물 시험 파일은 목록에 «없어야» 한다 — 임포트 바인딩 확인이 오탐을
  //      걷어냈다(고치기 전 60건에 있었다 → 57건으로 줄었다). 이 단언이 오탐 회귀를 잡는다.
  expect(impact.unlistedSpawnLaneTests).not.toContain('src/self-implement/goal-digest.test.ts');
  // 배선: 생산 진입점(resolveGateScope)을 «같은 실물 색인»으로 지나면 그 자리에서 측정이 나온다.
  const scope = resolveGateScope(sources, () => false, index!);
  expect(scope.runtimeEdgeImpact).toMatchObject({ measured: true });
  console.log(`[IMPORT-GRAPH-SCC-FU 실물 측정] ${JSON.stringify({
    trackedTests: testPaths.length,
    trackedSources: sources.length,
    runtimeEdges: (index!.runtimeEdges ?? []).length,
    pairs: impact.pairs,
    byKind: impact.byKind,
    handListedSpawnLaneFiles: GATE_SPAWN_LANE_FILES.length,
    unlistedSpawnLaneTests: impact.unlistedSpawnLaneTests.length,
    unresolvedRuntimeTargets: impact.unresolvedRuntimeTargets,
    scopeMeasured: scope.runtimeEdgeImpact?.measured,
    scopePairs: scope.runtimeEdgeImpact?.pairs,
  })}`);
}, 120_000);
