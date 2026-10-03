// gate-scope — 풀 `bun test` 폴백 제거 + 연관 테스트 유도(순수) 회귀 가드.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildImporterTestIndex } from './importer-test-index.js';
import { deriveRelatedTests, isElanousRuntimeArtifactPath, resolveGateScope } from './gate-scope.js';
import { runIntegrityGate } from '../autopilot/build/integrity-gate.js';

/** 존재 판정 스텁 — 실제 파일시스템 무접촉(순수 계약 검증). */
const has = (...paths: string[]) => (p: string) => paths.includes(p);
const none = () => false;

describe('deriveRelatedTests — 실측된 레포 관례 3종', () => {
  test('co-located 만 존재 → src/<rel>.test.ts', () => {
    expect(deriveRelatedTests(['src/a/b.ts'], has('src/a/b.test.ts'))).toEqual(['src/a/b.test.ts']);
  });

  test('test/ 평탄화만 존재 → test/<a-b>.test.ts (경로 / → -)', () => {
    expect(deriveRelatedTests(['src/a/b.ts'], has('test/a-b.test.ts'))).toEqual(['test/a-b.test.ts']);
  });

  test('중첩 경로도 평탄화된다 — src/x/y/z.ts → test/x-y-z.test.ts', () => {
    expect(deriveRelatedTests(['src/x/y/z.ts'], has('test/x-y-z.test.ts'))).toEqual(['test/x-y-z.test.ts']);
  });

  test('test/ 중첩 경로 → test/<rel>.test.ts (평탄화 모호성 방어 없이)', () => {
    expect(deriveRelatedTests(['src/cli/pr-cli.ts'], has('test/cli/pr-cli.test.ts')))
      .toEqual(['test/cli/pr-cli.test.ts']);
  });

  test('둘 다 존재하면 둘 다(중복 없이·co-located 우선 순서)', () => {
    expect(deriveRelatedTests(['src/a/b.ts'], has('src/a/b.test.ts', 'test/a-b.test.ts')))
      .toEqual(['src/a/b.test.ts', 'test/a-b.test.ts']);
  });

  test('둘 다 없으면 빈 배열 — 존재하지 않는 경로를 절대 만들지 않는다', () => {
    // ⚠️ integrity-gate 는 "0 files ran" 을 의도적 FAIL 로 처리한다 → 유도는 실존 파일만.
    expect(deriveRelatedTests(['src/a/b.ts'], none)).toEqual([]);
  });

  test('입력에 섞인 테스트 파일은 유도 대상이 아니다(changed-tests 분기 소관)', () => {
    expect(deriveRelatedTests(['src/a/b.test.ts'], has('src/a/b.test.test.ts'))).toEqual([]);
  });

  test('src/ 밖(scripts/ 등)은 co-located만 유도하고 test/ 관례를 추측하지 않는다', () => {
    expect(deriveRelatedTests(['scripts/x.ts'], has('scripts/x.test.ts', 'test/x.test.ts', 'test/scripts/x.test.ts')))
      .toEqual(['scripts/x.test.ts']);
  });

  test('여러 소스의 유도 결과가 중복 없이 합쳐진다', () => {
    const got = deriveRelatedTests(['src/a.ts', 'src/a.ts', 'src/b.ts'], has('src/a.test.ts', 'test/b.test.ts'));
    expect(got).toEqual(['src/a.test.ts', 'test/b.test.ts']);
  });

  test('비-소스(.md·.json)는 유도 대상이 아니다', () => {
    expect(deriveRelatedTests(['docs/A.md', 'x.json'], has('src/A.test.ts'))).toEqual([]);
  });

  test('Kotlin main 소스는 test 소스 트리의 XTest.kt로 유도한다', () => {
    const source = 'apps/android/app/src/main/kotlin/com/example/ChatAttachPolicy.kt';
    const related = 'apps/android/app/src/test/kotlin/com/example/ChatAttachPolicyTest.kt';
    expect(deriveRelatedTests([source], has(related))).toEqual([related]);
  });

  test('실존하지 않는 Kotlin 후보는 유도하지 않는다', () => {
    expect(deriveRelatedTests(['apps/android/app/src/main/kotlin/com/example/ChatAttachPolicy.kt'], none)).toEqual([]);
  });

  test('Kotlin XTest.kt 변경은 다시 유도하지 않는다', () => {
    expect(deriveRelatedTests(
      ['apps/android/app/src/test/kotlin/com/example/ChatAttachPolicyTest.kt'],
      has('apps/android/app/src/test/kotlin/com/example/ChatAttachPolicyTestTest.kt'),
    )).toEqual([]);
  });
});

describe('elanous 런타임 산출물 분리와 출력 관측', () => {
  test('알려진 상태 경로만 산출물로 판정하고 유사 사용자 경로는 제외한다', () => {
    for (const path of ['.elanous/debug/debug-x.log', '.elanous-child-liveness.hb', '.elanous-se/state.json', '.elanous-goal-grounding-build/state.json', '.elanous-session/state.json']) {
      expect(isElanousRuntimeArtifactPath(path)).toBe(true);
    }
    for (const path of ['src/.monaco/x.ts', 'src/greet.ts', 'package.json', 'elanous/debug/debug-x.log']) {
      expect(isElanousRuntimeArtifactPath(path)).toBe(false);
    }
  });

  test('혼합 변경은 사용자 미검증과 elanous 산출물을 보존하고 출력에서 각각의 수를 알린다', () => {
    const scope = resolveGateScope(['src/greet.ts', 'package.json', '.elanous/debug/debug-x.log', '.elanous-child-liveness.hb'], none);

    expect(scope.reason).toBe('no-related-tests');
    expect(scope.unverified).toEqual(['src/greet.ts', 'package.json']);
    expect(scope.elanousRuntimeArtifacts).toEqual(['.elanous/debug/debug-x.log', '.elanous-child-liveness.hb']);
  });

  // 🩸 2026-09-26 run-7dd4cce6 — 실패 시험 0 인데 «미검증 2»로 두 라운드 실패: 지운 시험 파일 · import 하는 시험이 돈 소스.
  test('지운 파일은 미검증이 아니고, 실행 집합의 시험이 import 하는 소스는 커버로 센다', () => {
    const present = new Set(['test/dashboard-acp-boot.test.ts', 'test/voice-telegram-voice-adapter.test.ts', 'src/voice/channel-adapters/telegram-voice-adapter.ts']);
    const exists = (p: string) => present.has(p);
    const index = { testsBySource: new Map([['src/voice/channel-adapters/telegram-voice-adapter.ts', ['test/voice-telegram-voice-adapter.test.ts']]]), unresolvedRelativeSpecifiers: 0 };
    const changed = ['test/dashboard-acp-boot-localdaemon.test.ts', 'test/dashboard-acp-boot.test.ts', 'test/voice-telegram-voice-adapter.test.ts', 'src/voice/channel-adapters/telegram-voice-adapter.ts'];
    const fixed = resolveGateScope(changed, exists, index, { isDeleted: (p) => !present.has(p) });
    expect(fixed.reason).toBe('changed-tests');
    expect(fixed.unverified).toEqual([]);
    // 옛 동작(isDeleted 없음 · 색인 없음)은 둘 다 미검증으로 셌다 — 이 대조가 수리를 문다.
    const before = resolveGateScope(changed, exists);
    expect(before.unverified).toEqual(['test/dashboard-acp-boot-localdaemon.test.ts', 'src/voice/channel-adapters/telegram-voice-adapter.ts']);
    // 색인이 있어도 그 시험이 «실행 집합에 없으면» 커버가 아니다.
    const notRun = resolveGateScope(['src/voice/channel-adapters/telegram-voice-adapter.ts', 'test/dashboard-acp-boot.test.ts'], exists, index);
    expect(notRun.testArgs).toContain('test/voice-telegram-voice-adapter.test.ts');
    expect(notRun.unverified).toEqual([]);
  });

  test('산출물만 변경돼도 버리지 않고 unverified 0과 산출물 수를 따로 출력한다', () => {
    const scope = resolveGateScope(['.elanous/debug/chat-x.log', '.elanous-child-liveness.hb'], none);

    expect(scope.reason).toBe('no-changes');
    expect(scope.unverified).toEqual([]);
    expect(scope.elanousRuntimeArtifacts).toEqual(['.elanous/debug/chat-x.log', '.elanous-child-liveness.hb']);
  });
});

describe('resolveGateScope — 5경로 · 풀 폴백 없음', () => {
  test('changed-tests: 변경에 테스트가 있으면 그것만(⚠️ 실존해야 한다 — must-fix 4R)', () => {
    const s = resolveGateScope(['src/a.ts', 'src/a.test.ts'], has('src/a.test.ts'));
    expect(s.reason).toBe('changed-tests');
    expect(s.testArgs).toEqual(['src/a.test.ts']);
    expect(s.skipTestStep).toBe(false);
  });

  test('docs-only: 소스 0 → test 스텝 스킵', () => {
    const s = resolveGateScope(['docs/A.md', 'AGENTS.md'], none);
    expect(s.reason).toBe('docs-only');
    expect(s.skipTestStep).toBe(true);
    expect(s.testArgs).toBeUndefined();
  });

  test('⭐ derived: 소스 O·테스트 X·연관 존재 → 유도된 것만 (풀 폴백 아님)', () => {
    const s = resolveGateScope(['src/a/b.ts'], has('test/a-b.test.ts'));
    expect(s.reason).toBe('derived');
    expect(s.testArgs).toEqual(['test/a-b.test.ts']);
    expect(s.skipTestStep).toBe(false);
  });

  test('⭐ src/cli/pr-cli.ts는 중첩 test 관례로 유도돼 no-related-tests로 스킵되지 않는다', () => {
    const s = resolveGateScope(['src/cli/pr-cli.ts'], has('test/cli/pr-cli.test.ts'));
    expect(s.reason).toBe('derived');
    expect(s.testArgs).toEqual(['test/cli/pr-cli.test.ts']);
    expect(s.skipTestStep).toBe(false);
  });

  test('Kotlin XTest.kt 변경은 changed-tests로 인식하고 X.kt 변경은 derived로 인식한다', () => {
    const source = 'apps/android/app/src/main/kotlin/com/example/ChatAttachPolicy.kt';
    const related = 'apps/android/app/src/test/kotlin/com/example/ChatAttachPolicyTest.kt';

    const changedTest = resolveGateScope([related], has(related));
    expect(changedTest.reason).toBe('changed-tests');
    expect(changedTest.testArgs).toEqual([related]);

    const derived = resolveGateScope([source], has(related));
    expect(derived.reason).toBe('derived');
    expect(derived.testArgs).toEqual([related]);
    expect(derived.skipTestStep).toBe(false);
  });

  test('Kotlin source-only 변경은 docs-only가 아니다', () => {
    const s = resolveGateScope(['apps/android/app/src/main/kotlin/com/example/ChatAttachPolicy.kt'], none);
    expect(s.reason).toBe('no-related-tests');
    expect(s.unverified).toEqual(['apps/android/app/src/main/kotlin/com/example/ChatAttachPolicy.kt']);
  });

  test('⭐ no-related-tests: 소스 O·테스트 X·연관 없음 → test 스텝 스킵 (풀 폴백 아님)', () => {
    const s = resolveGateScope(['src/a/b.ts'], none);
    expect(s.reason).toBe('no-related-tests');
    expect(s.skipTestStep).toBe(true);
    expect(s.testArgs).toBeUndefined();
    expect(s.unverified).toEqual(['src/a/b.ts']);
  });

  test('src/ 밖 소스 개수를 관측용으로 센다', () => {
    const s = resolveGateScope(['scripts/x.ts', 'src/a.ts'], none);
    expect(s.ignoredOutsideSrc).toBe(1);
  });

  test('⭐⭐ 핵심 회귀 가드 — 어떤 입력에서도 testArgs 가 빈 배열로 설정되지 않는다', () => {
    // integrity-gate 계약: `testArgs: []` 는 필터 미적용 = **풀 실행**. 빈 배열이 새면 근본이 되돌아간다.
    const inputs: readonly string[][] = [
      [], ['docs/A.md'], ['src/a.ts'], ['src/a.ts', 'docs/A.md'],
      ['scripts/x.ts'], ['src/a.test.ts'], ['x.json'],
    ];
    for (const changed of inputs) {
      for (const exists of [none, has('src/a.test.ts'), has('test/a.test.ts')]) {
        const s = resolveGateScope(changed, exists);
        if (s.testArgs !== undefined) expect(s.testArgs.length).toBeGreaterThan(0);
      }
    }
  });

  test('⭐ 풀 폴백 부재 불변식 — 소스가 바뀌면 testArgs 가 있거나 skipTestStep 이다(둘 중 하나)', () => {
    // 종전 결함은 "둘 다 아님"(= 필터 없이 test 스텝 실행 = 풀)이었다. 그 상태가 다시 나오면 실패.
    for (const exists of [none, has('test/a-b.test.ts')]) {
      const s = resolveGateScope(['src/a/b.ts'], exists);
      const targeted = (s.testArgs?.length ?? 0) > 0;
      expect(targeted || s.skipTestStep).toBe(true);
    }
  });

  test('빈 변경 목록 → no-changes 로 스킵하고 문서 전용과 구별한다', () => {
    const s = resolveGateScope([], none);
    expect(s.reason).toBe('no-changes');
    expect(s.skipTestStep).toBe(true);
    expect(s.testArgs).toBeUndefined();
  });

  test('주입한 importer 색인은 관례 밖 테스트도 실행 집합에 넣는다', () => {
    const changed = ['src/a.ts'];
    const baseline = resolveGateScope(changed, has('src/a.test.ts'));
    const index = { testsBySource: new Map([['src/a.ts', ['test/off-convention.test.ts']]]), unresolvedRelativeSpecifiers: 2 };
    const observed = resolveGateScope(changed, has('src/a.test.ts', 'test/off-convention.test.ts'), index);

    expect(observed.importerTestsNotRun).toEqual({
      total: 0, files: [], truncated: false, unresolvedRelativeSpecifiers: 2,
    });
    expect(resolveGateScope(changed, has('src/a.test.ts')).importerTestsNotRun).toBeNull();
    expect(baseline.testArgs).toEqual(['src/a.test.ts']);
    expect(observed.testArgs).toEqual(['src/a.test.ts', 'test/off-convention.test.ts']);
    expect(observed.callerTests).toEqual([{ file: 'test/off-convention.test.ts', reasons: ['import'] }]);
    expect(observed.skipTestStep).toBe(baseline.skipTestStep);
    expect(observed.reason).toBe(baseline.reason);
  });

  test('평면 시험의 실제 runtime import만 관측하고 basename 충돌 후보는 제외한다', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gate-scope-flat-importer-'));
    const changed = ['src/tool-runtime/goal-author-runtime.ts'];
    const collision = 'src/self-implement/goal-author-runtime.ts';
    try {
      mkdirSync(join(cwd, 'src/tool-runtime'), { recursive: true });
      mkdirSync(join(cwd, 'src/self-implement'), { recursive: true });
      mkdirSync(join(cwd, 'test'), { recursive: true });
      writeFileSync(join(cwd, changed[0]), 'export {};\n');
      writeFileSync(join(cwd, collision), 'export {};\n');
      writeFileSync(join(cwd, 'test/goal-author-runtime.test.ts'), "import '../src/tool-runtime/goal-author-runtime.js';\n");
      const index = buildImporterTestIndex(cwd, ['test/goal-author-runtime.test.ts'], [...changed, collision]);
      const baseline = resolveGateScope(changed, () => false);
      const observed = resolveGateScope(changed, has('test/goal-author-runtime.test.ts'), index ?? undefined);

      expect(index?.testsBySource.get(changed[0])).toEqual(['test/goal-author-runtime.test.ts']);
      expect(index?.testsBySource.get(collision)).toBeUndefined();
      expect(observed.importerTestsNotRun).toMatchObject({
        total: 0, files: [], truncated: false,
      });
      expect(observed.derived).toEqual(baseline.derived);
      expect(observed.testArgs).toEqual(['test/goal-author-runtime.test.ts']);
      expect(observed.callerTests).toEqual([{ file: 'test/goal-author-runtime.test.ts', reasons: ['import'] }]);
      expect(observed.skipTestStep).toBe(false);
      expect(observed.reason).toBe('derived');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('importer 관측 목록은 상한·총수·절단 여부를 함께 보존한다', () => {
    const importers = Array.from({ length: 21 }, (_, index) => `test/off-${index}.test.ts`);
    const index = { testsBySource: new Map([['src/a.ts', importers]]), unresolvedRelativeSpecifiers: 0 };
    const s = resolveGateScope(['src/a.ts'], has(...importers), index);

    expect(s.testArgs).toHaveLength(21);
    expect(s.importerTestsNotRun).toMatchObject({ total: 0, truncated: false, unresolvedRelativeSpecifiers: 0 });
    expect(s.callerTests).toHaveLength(21);
  });
});

// ── integrity-gate 경계 계약 (리뷰 should-fix 2026-07-26) ─────────────────────────────
//
// 이 수리의 핵심 전제 = "`steps: []` 는 기본 스텝으로 **재해석되지 않는다**". 종전엔 그 전제를
// `integrity-gate.ts` **독해**로만 주장했다(위험 — 코드가 바뀌면 조용히 깨진다). 실제 호출로 고정한다.
describe('integrity-gate 경계 — steps:[] 의 실제 거동', () => {
  test('⭐ steps:[] 는 어떤 스텝도 실행하지 않고 passed:true (기본 스텝 재해석 없음)', async () => {
    let calls = 0;
    const r = await runIntegrityGate('/tmp', { steps: [], runCmd: async () => { calls += 1; return { code: 0, stdout: '', stderr: '', timedOut: false }; } } as never);
    expect(calls).toBe(0);          // ← 기본 스텝으로 폴백하면 여기서 깨진다
    expect(r.passed).toBe(true);
  });

  test('대조 — steps 미지정은 기본 스텝을 실행한다(즉 [] 와 undefined 는 다르다)', async () => {
    let calls = 0;
    const r = await runIntegrityGate('/tmp', { runCmd: async () => { calls += 1; return { code: 0, stdout: '', stderr: '', timedOut: false }; } } as never);
    expect(calls).toBeGreaterThan(0);
    expect(r.passed).toBe(true);
  });

  test('⭐ testArgs:[] 는 필터 미적용 = 풀 실행이다(그래서 빈 배열을 절대 넘기지 않는다)', async () => {
    const seen: string[][] = [];
    await runIntegrityGate('/tmp', { steps: ['test'], testArgs: [], runCmd: async (_c: string, args: string[]) => { seen.push([...args]); return { code: 0, stdout: 'x', stderr: '', timedOut: false }; } } as never);
    // 필터가 붙었다면 args 에 파일 경로가 있어야 한다 — 없으면 풀 실행이라는 뜻.
    expect(seen[0]?.some((a) => a.endsWith('.test.ts'))).toBe(false);
  });
});

// ── 탐지⊥유도 대칭 (리뷰 must-fix 3R) ────────────────────────────────────────────────
//
// 손 나열이 근본 문제였다(1R 수정이 `.spec.js`·`[cm]` 변형을 누락). 이제 문법에서 생성하므로
// **드리프트가 구조적으로 불가능**하지만, 그 사실을 매 실행 확인한다.
describe('deriveRelatedTests — TEST_RE 와의 완전 대칭', () => {
  /** `TEST_RE` = /\.(test|spec)\.[cm]?[tj]sx?$/ 의 전수 조합(2×3×2×2 = 24). */
  const ALL = (['test', 'spec'] as const).flatMap((k) =>
    ['', 'c', 'm'].flatMap((pre) => ['t', 'j'].flatMap((l) => ['s', 'sx'].map((t) => `.${k}.${pre}${l}${t}`))));

  test('문법 전수 조합이 24종이다(TEST_RE 문법과 동일 분해)', () => {
    // ⚠️ `isTestPath` export 는 제거했다(리뷰 should-fix 4R — 제품 코드 미사용 공개 surface).
    //    대칭은 아래 "24종 전부 유도로 발견" 이 **행위로** 보장한다(더 강한 검증).
    expect(ALL.length).toBe(24);
  });

  test('⭐ 24종 **전부** 유도로 발견된다(co-located) — 하나라도 빠지면 no-related-tests 오판', () => {
    for (const sfx of ALL) {
      const target = `src/a/b${sfx}`;
      expect(deriveRelatedTests(['src/a/b.ts'], has(target))).toEqual([target]);
    }
  });

  test('⭐ 24종 전부 유도로 발견된다(test/ 평탄화)', () => {
    for (const sfx of ALL) {
      const target = `test/a-b${sfx}`;
      expect(deriveRelatedTests(['src/a/b.ts'], has(target))).toEqual([target]);
    }
  });

  test('위치-우선 순서 — co-located 가 먼저(혼합 확장자에서도)', () => {
    const got = deriveRelatedTests(['src/a/b.ts'], has('test/a-b.test.ts', 'src/a/b.spec.tsx'));
    expect(got).toEqual(['src/a/b.spec.tsx', 'test/a-b.test.ts']);
  });
});

// ── 평탄화 모호성 (리뷰 should-fix 3R) ────────────────────────────────────────────────
//
// `test/` 관례는 `/`→`-` 라 `src/a/b.ts` 와 `src/a-b.ts` 가 같은 `test/a-b.test.ts` 로 접힌다.
// 그대로 두면 **무관 테스트 오귀속** = 이 PR 이 없애려던 결함이 되살아난다.
describe('deriveRelatedTests — 평탄화 충돌 방어', () => {
  test('⭐ 대시 이름 소스가 실존하면 평탄화 후보를 버린다(오귀속 0·보수적)', () => {
    // src/a-b.ts 가 있으므로 test/a-b.test.ts 는 그쪽 것일 수 있다 → src/a/b.ts 의 유도에서 제외.
    const got = deriveRelatedTests(['src/a/b.ts'], has('test/a-b.test.ts', 'src/a-b.ts'));
    expect(got).toEqual([]);
  });

  test('⭐⭐ 다단 충돌도 잡는다 — src/a/b-c.ts ↔ src/a-b/c.ts (3R 이 놓친 형태)', () => {
    // 둘 다 test/a-b-c.test.ts 로 접힌다. pre-image 전수 판정이라 이제 폐기된다.
    const got = deriveRelatedTests(['src/a/b-c.ts'], has('test/a-b-c.test.ts', 'src/a-b/c.ts'));
    expect(got).toEqual([]);
  });

  test('다단인데 충돌이 없으면 정상 사용한다', () => {
    expect(deriveRelatedTests(['src/a/b-c.ts'], has('test/a-b-c.test.ts'))).toEqual(['test/a-b-c.test.ts']);
  });

  test('세그먼트가 매우 많으면 보수적으로 폐기(조합 폭발 방지·오귀속 0 우선)', () => {
    const rel = 'a/b/c/d/e/f/g/h/i';           // 9 세그먼트 > 상한 8
    const got = deriveRelatedTests([`src/${rel}.ts`], has(`test/${rel.replace(/\//g, '-')}.test.ts`));
    expect(got).toEqual([]);
  });

  test('충돌해도 co-located 는 그대로 쓴다(과잉 보수 금지)', () => {
    const got = deriveRelatedTests(['src/a/b.ts'], has('src/a/b.test.ts', 'test/a-b.test.ts', 'src/a-b.ts'));
    expect(got).toEqual(['src/a/b.test.ts']);
  });

  test('대시 소스가 없으면 평탄화를 정상 사용한다', () => {
    expect(deriveRelatedTests(['src/a/b.ts'], has('test/a-b.test.ts'))).toEqual(['test/a-b.test.ts']);
  });

  test('최상위 소스(경로에 / 없음)는 모호성 판정 불필요', () => {
    expect(deriveRelatedTests(['src/x.ts'], has('test/x.test.ts'))).toEqual(['test/x.test.ts']);
  });
});

// ── 삭제·rename 前 테스트 경로 (리뷰 must-fix 4R) ────────────────────────────────────
//
// `gitChangedFiles` 는 `git diff --name-only HEAD` 라 **삭제된 경로도 포함**한다. 그걸 testArgs 로
// 넘기면 필터 무매치 → integrity-gate 가 "0 files ran"으로 **부당 FAIL**(테스트를 지우는 정당한 변경이
// 게이트에 막힌다). 실존하는 것만 쓴다.
describe('resolveGateScope — 실존하지 않는 테스트 경로 방어', () => {
  test('⭐ 삭제된 테스트 경로는 testArgs 에서 제외된다', () => {
    const s = resolveGateScope(['src/a.ts', 'src/a.test.ts'], has('src/b.test.ts'));
    expect(s.testArgs).toBeUndefined();          // a.test.ts 는 실존 X → changed-tests 성립 안 함
    expect(s.missingTestFiles).toBe(1);
  });

  test('⭐ 테스트를 전부 지운 변경도 게이트를 통과할 수 있다(스킵 또는 유도로 강등)', () => {
    const s = resolveGateScope(['src/a.test.ts'], none);
    // 소스 판정엔 걸리지만(.test.ts 도 SOURCE_RE) 실존 테스트가 없어 유도도 실패 → 스킵.
    expect(s.skipTestStep).toBe(true);
    expect(s.missingTestFiles).toBe(1);
  });

  test('실존하는 것만 남기고 나머지는 유지한다', () => {
    const s = resolveGateScope(['src/a.test.ts', 'src/b.test.ts'], has('src/b.test.ts'));
    expect(s.testArgs).toEqual(['src/b.test.ts']);
    expect(s.missingTestFiles).toBe(1);
  });

  test('실존 테스트만 있으면 missingTestFiles=0', () => {
    const s = resolveGateScope(['src/a.test.ts'], has('src/a.test.ts'));
    expect(s.missingTestFiles).toBe(0);
    expect(s.testArgs).toEqual(['src/a.test.ts']);
  });
});

// ── 같은 stem 확장자 변형 = 같은 모듈 (리뷰 5R must-fix 에 대한 계약 고정) ──────────────
//
// 리뷰는 `src/a.ts` ⊕ `src/a.js` 공존을 충돌로 보라고 했으나 **성질이 다르다**:
//  · 평탄화 충돌은 **다른 모듈**이 같은 테스트 이름으로 접히는 것(오귀속)
//  · 같은 stem 확장자 변형은 **같은 논리 모듈**의 변종 → 그 테스트 실행은 **옳은 동작**
// 실측(2026-07-26): `src/` 의 .js/.jsx/.mjs/.cjs = **0개**(공존 사례도 0). 계약을 테스트로 고정해
// 이후 라운드가 같은 지적을 반복하지 않게 한다.
describe('deriveRelatedTests — 같은 stem 확장자 변형은 충돌이 아니다(의도된 계약)', () => {
  test('src/a.ts ⊕ src/a.js 공존에도 co-located 테스트를 유도한다', () => {
    const got = deriveRelatedTests(['src/a.ts'], has('src/a.test.ts', 'src/a.js'));
    expect(got).toEqual(['src/a.test.ts']);
  });

  test('평탄화 후보도 같은 stem 변형 때문에 폐기되지 않는다', () => {
    const got = deriveRelatedTests(['src/x/y.ts'], has('test/x-y.test.ts', 'src/x/y.js'));
    expect(got).toEqual(['test/x-y.test.ts']);
  });

  test('⭐ 대조 — 다른 모듈(경로 충돌)은 여전히 폐기된다', () => {
    const got = deriveRelatedTests(['src/x/y.ts'], has('test/x-y.test.ts', 'src/x-y.ts'));
    expect(got).toEqual([]);
  });

  test('⭐ 확장자 커버리지는 이미 완전하다 — 다른 pre-image 의 .js 도 충돌로 잡는다', () => {
    const got = deriveRelatedTests(['src/x/y.ts'], has('test/x-y.test.ts', 'src/x-y.js'));
    expect(got).toEqual([]);
  });
});

// ── elanous 런타임 산출물: 사용자 변경과 분리하되 경로 보존 ───────────────────────────────
describe('resolveGateScope — elanous 런타임 산출물은 미검증 사용자 변경이 아니다', () => {
  test('닫힌 상태 경로만 산출물로 판정하고 유사 사용자 경로는 제외한다', () => {
    for (const path of ['.elanous/debug/debug-x.log', '.elanous-child-liveness.hb', '.elanous-se/run.log', '.elanous-goal-grounding-build/x', '.elanous-session/x']) {
      expect(isElanousRuntimeArtifactPath(path)).toBe(true);
    }
    for (const path of ['src/.monaco/x.ts', 'elanous/debug/debug-x.log', '.elanousish/x', 'package.json']) {
      expect(isElanousRuntimeArtifactPath(path)).toBe(false);
    }
  });

  test('런타임 산출물은 보존하면서 unverified 에서 제외하고 사용자 변경은 남긴다', () => {
    const s = resolveGateScope(['.elanous/debug/debug-x.log', '.elanous-child-liveness.hb', 'src/greet.ts', 'package.json', 'src/.monaco/x.ts'], none);
    expect(s.elanousRuntimeArtifacts).toEqual(['.elanous/debug/debug-x.log', '.elanous-child-liveness.hb']);
    expect(s.unverified).toEqual(['src/greet.ts', 'package.json', 'src/.monaco/x.ts']);
    expect(s.reason).toBe('no-related-tests');
  });

  test('산출물만 바뀌면 경로를 보존하고 사용자 변경 없음으로 판정한다', () => {
    const s = resolveGateScope(['.elanous/debug/chat-x.log', '.elanous-child-liveness.hb'], none);
    expect(s.elanousRuntimeArtifacts).toEqual(['.elanous/debug/chat-x.log', '.elanous-child-liveness.hb']);
    expect(s.unverified).toEqual([]);
    expect(s.reason).toBe('no-changes');
    expect(s.skipTestStep).toBe(true);
  });

  test('혼합 입력에서도 기존 changed-tests와 derived 판정을 보존한다', () => {
    const changedTests = resolveGateScope(['.elanous/debug/debug-x.log', 'src/a.ts', 'src/a.test.ts'], has('src/a.test.ts'));
    expect(changedTests.reason).toBe('changed-tests');
    expect(changedTests.testArgs).toEqual(['src/a.test.ts']);
    expect(changedTests.elanousRuntimeArtifacts).toEqual(['.elanous/debug/debug-x.log']);

    const derived = resolveGateScope(['.elanous-child-liveness.hb', 'src/a.ts'], has('src/a.test.ts'));
    expect(derived.reason).toBe('derived');
    expect(derived.testArgs).toEqual(['src/a.test.ts']);
    expect(derived.elanousRuntimeArtifacts).toEqual(['.elanous-child-liveness.hb']);
  });
});

// ── docs-only 판별: 문서 allowlist (2026-07-27 · **사후 리뷰**가 찾은 결함 · 매뉴얼 §6a) ──────────
//
// 종전 판별은 "소스 확장자가 하나도 없으면 docs-only" 라는 **부재 판정**이라, 비문서·비소스 변경을
// 전부 docs-only 로 오분류했다 — `package.json`(의존성!)·lockfile·`tsconfig.json`·CI 설정·`Dockerfile`·
// `.py`·`.sh` 가 모두 "정상"이라며 test 스킵으로 떨어졌다. 존재 판정("모든 변경이 문서인가")으로 뒤집었다.
describe('resolveGateScope — docs-only 는 문서 allowlist 로 판정한다', () => {
  const DOCS = ['docs/A.md', 'README.md', 'AGENTS.md', 'x.mdx', 'z.rst', 'w.adoc', 'docs/guide/a.markdown'];
  const NON_DOCS = ['package.json', 'bun.lock', 'tsconfig.json', '.github/workflows/ci.yml',
    'Dockerfile', 'x.py', 'scripts/deploy.sh', '.zshrc', 'Makefile',
    // ⚠️ 경로 축으로 결함이 부활하지 않게(리뷰 should-fix) — `docs/` 안이어도 확장자가 문서가 아니면 비문서.
    'docs/package.json', 'docs/scripts/build.sh', 'docs/img/a.png',
    // `.txt` 는 런타임 fixture 로 널리 쓰여 문서로 단정하지 않는다.
    'test/fixtures/input.txt', 'y.txt'];

  test('문서만 바뀌면 docs-only', () => {
    for (const f of DOCS) {
      const s = resolveGateScope([f], none);
      expect(s.reason).toBe('docs-only');
      expect(s.unverified).toEqual([]);
    }
  });

  test('⭐⭐ 비문서 변경은 docs-only 가 **아니다** — 종전엔 전부 오분류됐다', () => {
    for (const f of NON_DOCS) {
      const s = resolveGateScope([f], none);
      expect(s.reason).not.toBe('docs-only');
      expect(s.reason).toBe('no-related-tests');
      expect(s.unverified).toContain(f);          // note 가 실제 미검증 파일을 실을 수 있게
    }
  });

  test('⭐ 문서 + 비문서 혼합은 docs-only 가 아니고, 비문서만 unverified 에 담긴다', () => {
    const s = resolveGateScope(['docs/A.md', 'package.json'], none);
    expect(s.reason).toBe('no-related-tests');
    expect(s.unverified).toEqual(['package.json']);
  });

  test('문서와 소스 혼합은 기존 유도를 보존하면서 문서의 시험 비기여를 드러낸다', () => {
    const sourceOnly = resolveGateScope(['src/a.ts'], has('src/a.test.ts'));
    const mixed = resolveGateScope(['AGENTS.md', 'src/a.ts'], has('src/a.test.ts'));

    expect(mixed.reason).toBe('derived');
    expect(mixed.skipTestStep).toBe(false);
    expect(mixed.testArgs).toEqual(sourceOnly.testArgs);
    expect(mixed.documentPaths).toEqual(['AGENTS.md']);
    expect(mixed.documentsWithoutDerivedTests).toEqual(['AGENTS.md']);
  });

  test('미지의 확장자는 문서가 아니다(fail-safe 방향 — 새 파일종류가 조용히 스킵되지 않는다)', () => {
    const s = resolveGateScope(['weird.qqq'], none);
    expect(s.reason).toBe('no-related-tests');
    expect(s.unverified).toEqual(['weird.qqq']);
  });

  test('빈 변경 목록은 docs-only가 아닌 no-changes다', () => {
    expect(resolveGateScope([], none).reason).toBe('no-changes');
  });

  test('postsync 빈 범위는 기존 no-changes를 유지하지 않고 unmeasured로 판정한다', () => {
    const s = resolveGateScope([], none, undefined, { mode: 'postsync' });
    expect(s.reason).toBe('unmeasured');
    expect(s.skipTestStep).toBe(true);
    expect(s.testArgs).toBeUndefined();
  });

  test('postsync가 아니면 빈 범위 reason은 계속 no-changes다', () => {
    expect(resolveGateScope([], none).reason).toBe('no-changes');
    expect(resolveGateScope([], none, undefined, { mode: 'worktree' }).reason).toBe('no-changes');
  });

  test('소스 변경은 종전대로 derived/no-related-tests 로 간다(무회귀)', () => {
    expect(resolveGateScope(['src/a/b.ts'], has('test/a-b.test.ts')).reason).toBe('derived');
    expect(resolveGateScope(['src/a/b.ts'], none).reason).toBe('no-related-tests');
  });
});

// ── 커버 판정은 **실행 집합** 기준이다 (리뷰 must-fix 2R · #5500) ──────────────────────
//
// ⚠️ 직전 판본은 "연관 테스트가 **존재하기만** 하면 커버"로 봤다. `changed-tests` 는 **변경된 테스트만**
// 돌리므로 그건 틀렸다 — 실행되지 않은 테스트는 검증이 아니다.
describe('resolveGateScope — 커버 여부는 실제 실행 집합으로 판정한다', () => {
  test('⭐ 측정 사례: src 소스 + 새 test/ 테스트 → co-located sibling도 함께 실행한다', () => {
    const s = resolveGateScope(['src/a.ts', 'test/a.test.ts'], has('src/a.test.ts', 'test/a.test.ts'));
    expect(s.reason).toBe('changed-tests');
    expect(s.testArgs).toEqual(['test/a.test.ts', 'src/a.test.ts']);
    // 편집된 것은 test/ 쪽뿐이었다 — sibling 은 합집합이 구제했고, 그 사실이 관측에 남아야 한다.
    expect(s.pulledInRelatedTests).toEqual(['src/a.test.ts']);
    expect(s.unverified).toEqual([]);
  });

  test('scripts 소스와 co-located 짝만 변경돼도 실행 집합이 소스를 커버한다', () => {
    const s = resolveGateScope(['scripts/x.ts', 'scripts/x.test.ts'], has('scripts/x.test.ts'));
    expect(s.reason).toBe('changed-tests');
    expect(s.testArgs).toEqual(['scripts/x.test.ts']);
    expect(s.pulledInRelatedTests).toEqual([]);
    expect(s.unverified).toEqual([]);
  });

  test('유일한 연관 테스트가 편집됐으면 구제된 것이 없다', () => {
    const s = resolveGateScope(['src/a.ts', 'src/a.test.ts'], has('src/a.test.ts'));
    expect(s.testArgs).toEqual(['src/a.test.ts']);
    expect(s.pulledInRelatedTests).toEqual([]);   // 합집합이 더 끌어온 것이 없다
    expect(s.unverified).toEqual([]);
  });

  test('연관 테스트가 전혀 없는 소스는 changed-tests에서도 unverified다', () => {
    const s = resolveGateScope(['src/a.ts', 'src/b.test.ts'], has('src/b.test.ts'));
    expect(s.testArgs).toEqual(['src/b.test.ts']);
    expect(s.pulledInRelatedTests).toEqual([]);
    expect(s.unverified).toEqual(['src/a.ts']);
  });

  test('삭제된 테스트 경로는 run set 과 구제 목록 양쪽에서 제외된다', () => {
    const s = resolveGateScope(['src/a.ts', 'src/a.test.ts'], none);
    expect(s.testArgs).toBeUndefined();
    expect(s.pulledInRelatedTests).toEqual([]);
    expect(s.missingTestFiles).toBe(1);
  });

  test('평탄화가 모호하면 changed-tests에서도 관련 테스트를 유도하지 않는다', () => {
    const s = resolveGateScope(['src/a/b.ts', 'src/z.test.ts'], has('src/z.test.ts', 'test/a-b.test.ts', 'src/a-b.ts'));
    expect(s.testArgs).toEqual(['src/z.test.ts']);
    expect(s.pulledInRelatedTests).toEqual([]);
    expect(s.unverified).toEqual(['src/a/b.ts']);
  });

  test('derived 경로도 실행 집합 기준 — 유도된 테스트가 그 소스를 덮으면 커버', () => {
    const s = resolveGateScope(['src/a.ts'], has('src/a.test.ts'));
    expect(s.reason).toBe('derived');
    expect(s.unverified).toEqual([]);
  });

  test('derived 경로에서 유도 안 된 비문서는 남는다', () => {
    const s = resolveGateScope(['src/a.ts', 'package.json'], has('src/a.test.ts'));
    expect(s.reason).toBe('derived');
    expect(s.unverified).toEqual(['package.json']);
  });

  test('테스트 파일 자신은 실행 집합에 있으면 커버로 본다', () => {
    const s = resolveGateScope(['src/a.test.ts'], has('src/a.test.ts'));
    expect(s.unverified).toEqual([]);
  });
});
