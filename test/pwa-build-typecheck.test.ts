import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** ⛔⭐⭐⭐ 2026-08-22 실측(`[F]` 16차): ***`main` 의 PWA 빌드가 «또» 깨져 있었다.***
 *
 *  ```
 *  ../../src/self-implement/seams.ts:1233:82
 *  Type error: Argument of type '{ … }' is not assignable to parameter of type 'HeadlessGoalLoopPtyOptions'.
 *  ```
 *  15차가 세운 형제 자(`pwa-cross-boundary-imports`)는 **3 pass 로 통과했다** — 그 자는 import 축을 물고,
 *  이번 것은 «타입» 축이었다. `bun test` 도 전부 초록이었다(타입을 안 잰다).
 *
 *  ⛔⭐⭐ **왜 어떤 게이트도 못 잡았나** — 이 부류의 기전이 여기 있다:
 *  범인 PR(`#10942`)은 `orchestrator.ts` 의 union 을 넓혔고, **깨진 파일은 `seams.ts`** 였다.
 *  ⇒ 깨진 파일이 「그 PR 이 바꾼 파일」이 «아니»므로 ***변경-파일-스코프 게이트 둘 다 원리상 못 본다***
 *    (하니스 게이트 `elanous self gate` · push 전 `scripts/ci-typecheck-changed.ts`).
 *  🔑 ***계약을 넓히면 깨지는 것은 「그 계약을 «쓰는» 파일」이고, 그 파일은 내 변경 목록에 없다.***
 *  ⊕ 그 사이 데몬은 **옛 번들을 계속 서빙한다** — 소스를 고쳐도 화면이 안 바뀐다.
 *
 *  ---
 *  ## ⛔⭐⭐ 이 자가 무는 것과 «못 무는 것»
 *
 *  📏 무인 리뷰 must-fix(2026-08-22 · PR #11050): 1차판은 루트 `tsconfig.json` 하나만 훑고
 *  *"넓은 쪽이 0이면 좁은 쪽도 반드시 0"* 이라 적었다. ⛔ **그 문장은 거짓이었다** —
 *  실측: 루트 include 는 `src/**`·`scripts/**` 뿐이고 **`apps/pwa/src` 를 아예 안 본다**
 *  (루트 Files **5362** ↔ PWA Files **3814** · 두 스코프는 포함 관계가 아니라 «교차»한다).
 *  ⇒ 그래서 **두 프로젝트를 «둘 다»** 훑는다.
 *
 *  ⚠️ **그래도 `next build` 와 «똑같지는 않다»** — 정직하게 적는다:
 *  PWA tsconfig 의 `include` 에는 `.next/types/**` 가 있는데 그것은 **빌드 산출물**이라,
 *  한 번도 빌드한 적 없는 트리에서는 그 부분이 비어 있다. ⇒ 이 자는 그 축을 **못 본다**.
 *  ⭐ 그것이 이 자를 버릴 이유는 아니다 — 이번에 실제로 앱을 세운 축(공유 `src/**`)을 «전수»로 문다. */

const REPO = resolve(import.meta.dir, '..');
const TSC = resolve(REPO, 'node_modules/.bin/tsc');

/** `path/to/file.ts(12,3): error TS2345: …` — 파일에 «귀속된» 한 줄 진단. */
const ATTRIBUTED = /^(\S.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
/** 어떤 형태로든 tsc 가 오류라고 말한 줄. */
const ANY_ERROR = /error TS\d+:/;
const IS_TEST_FILE = /\.(test|spec)\.tsx?$/;

interface Project {
  readonly id: string;
  /** tsc 를 부를 작업 디렉토리 — `-p tsconfig.json` 이 그 안에서 해석된다. */
  readonly cwd: string;
  /** 이 프로젝트에서 「타입이 성해야 하는」 최소 파일 수. 0 을 「통과」로 읽지 않기 위한 분모다. */
  readonly minFiles: number;
  /** ⛔⭐⭐ 이 자보다 «오래된» 시험 파일 오류의 «기준선» — 목표가 아니다.
   *
   *  📏 무인 리뷰 2차 must-fix(PR #11050)가 이 형태를 제안했고, 그것이 1차판보다 낫다:
   *  1차판은 시험 파일 오류를 «세기만» 하고 판정에서 통째로 빼서, 그 수가 100개로 늘어도 초록이었다.
   *  ⛔ 그렇다고 0을 요구하면 자가 «늘 빨갛고», 사람이 자를 무시하는 습관을 배운다(`R-CLM11`).
   *  ⇒ **늘면 실패시키고, 줄면 「낮춰라」고 말한다**(실패시키진 않는다 — 고친 사람을 벌하지 않는다).
   *  ⚠️ 이 수는 «늙는다». 그래서 늙었을 때 자가 «스스로 말하게» 해 뒀다. */
  readonly knownTestFileErrors: number;
}

/** ⛔ 두 스코프는 «포함 관계가 아니다». 하나만 재면 다른 쪽 사각이 통째로 열린다. */
const PROJECTS: readonly Project[] = [
  // 📏 14 → 13(2026-08-22): 다른 트랙이 `src/self-dev/ask-launch-flow.test.ts` 를 고쳤고,
  //   ***자가 스스로 「낮춰라」고 말해서*** 낮췄다 — 이 기준선 설계가 실제로 작동한 첫 사례다.
  { id: 'repo', cwd: REPO, minFiles: 1000, knownTestFileErrors: 17 },
  { id: 'pwa', cwd: resolve(REPO, 'apps/pwa'), minFiles: 1000, knownTestFileErrors: 21 },
];

interface Sweep {
  readonly filesChecked: number;
  readonly sourceErrors: string[];
  /** 어느 파일에도 귀속되지 않은 진단 — 설정 오류(`TS18003`·`TS5083` 등)가 여기로 온다. */
  readonly unattributedErrors: string[];
  readonly testFileErrors: number;
}

/** ⭐ 판정은 «순수 함수»로 떼어 둔다 — 그래야 아래 반증이 tsc 를 20초씩 돌리지 않고도
 *  ***판정이 실제로 무는 자리***(이 함수)를 지나갈 수 있다. spawn 은 이 결정에 관여하지 않는다.
 *  ⛔ 같은 파일 안에서만 쓴다 — `export` 하지 않는다(2차 리뷰 must-fix: 쓰이지 않는 공개 표면). */
function classifyDiagnostics(output: string): Sweep {
  const sourceErrors: string[] = [];
  const unattributedErrors: string[] = [];
  let testFileErrors = 0;
  for (const line of output.split('\n')) {
    // ⛔ 들여쓴 줄은 앞 진단의 «이어지는 설명»이다 — 그것을 독립 오류로 세면 수가 부풀고,
    //   메시지 본문에 우연히 든 `error TSxxxx:` 가 가짜 「귀속 실패」를 만든다.
    if (/^\s/.test(line) || !ANY_ERROR.test(line)) continue;
    const match = ATTRIBUTED.exec(line);
    if (!match) {
      // ⛔⭐ 무인 리뷰 must-fix(PR #11050): 1차판은 이런 줄을 «조용히 버렸다».
      //   ⇒ `tsc` 가 tsconfig 를 못 읽어도(`TS5083`) 「소스 오류 0」으로 «통과»할 수 있었다 — Goodhart 구멍.
      unattributedErrors.push(line.trim());
      continue;
    }
    if (IS_TEST_FILE.test(match[1]!)) testFileErrors += 1;
    else sourceErrors.push(line.trim());
  }
  // ⭐⭐ 분모 — 「초록」이 「아무것도 안 봤다」와 구별되게 한다.
  //   📏 15차 §4 ②: `bun test $FILES` 가 «0개 파일»을 돌리고 「0 fail」을 냈다. 같은 함정이 여기도 있다.
  const files = /^Files:\s+(\d+)/m.exec(output);
  return {
    // ⛔ 「못 셌다」를 「0」으로 뭉개지 않는다 — 아래 단언이 그 둘을 다른 값으로 읽는다.
    filesChecked: files ? Number(files[1]) : -1,
    sourceErrors,
    unattributedErrors,
    testFileErrors,
  };
}

const cache = new Map<string, Sweep>();

function sweep(project: Project): Sweep {
  const hit = cache.get(project.id);
  if (hit) return hit;
  // ⛔ `bunx` 가 아니라 «있는 것으로» 부른다 — 게이트가 네트워크에 기대면 그것은 게이트가 아니다.
  if (!existsSync(TSC)) throw new Error(`typecheck ruler cannot run: ${TSC} is missing (run bun install)`);
  // ⛔⭐⭐⭐ **증분 캐시를 «쓰지 않는다»** — 자가 두 번 다른 답을 냈기 때문이다.
  //
  //  📏 2026-08-22 실측: 이 자가 한 번은 `pwa` 스코프를 «21개 오류»로, 다음엔 «0개»로 읽었다.
  //  그때 «귀속 실패 진단»이 같이 떠서 ***자가 스스로 「이건 정상 결과가 아니다」를 말했다***
  //  (그 단언이 없었으면 「0개」를 그냥 통과시켰을 것이다 — 어제 막아 둔 Goodhart 구멍이 일했다).
  //  🔍 그 자리에서 다른 tsc 프로세스가 «같은 build-info 파일»을 쓰고 있었다.
  //  ⛔ 재현 조건을 끝까지 좁히지는 못했다 — 그러나 **원인을 모르는 채로 두면 안 되는 축은 캐시다**:
  //    공유 캐시는 동시 실행에서 경합하고, 그 실패는 「오류가 줄어든 것처럼」 보인다.
  //  ⇒ 이 자에게 캐시는 «필수가 아니다»(23초). ***정확함이 속도보다 앞선다.***
  //  ⊕ 덤으로 트리도 안 더럽힌다(`--noEmit` 이어도 `incremental: true` 면 build-info 를 쓴다).
  const run = spawnSync(TSC, [
    '--noEmit', '-p', 'tsconfig.json', '--extendedDiagnostics', '--incremental', 'false',
  ], {
    cwd: project.cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  const result = classifyDiagnostics(`${run.stdout ?? ''}${run.stderr ?? ''}`);
  // 📢 tsc 가 «어떻게 끝났나»는 사람이 진단할 때 쓰는 값이다 — 그러나 판정 기준으로는 못 쓴다
  //   (시험 파일 오류가 남아 있는 한 종료 코드는 항상 0이 아니다). ⇒ 단언이 아니라 출력으로 남긴다.
  //   ⛔ 1차판은 이 값을 «자기 자신과 비교하는» 단언에 넣어 아무것도 검증하지 않았다(2차 리뷰 must-fix).
  console.log(
    `[pwa-build-typecheck:${project.id}] tsc exit=${run.status} files=${result.filesChecked}` +
      ` sourceErrors=${result.sourceErrors.length} testFileErrors=${result.testFileErrors}/${project.knownTestFileErrors}`,
  );
  cache.set(project.id, result);
  return result;
}

describe.each(PROJECTS.map((project) => [project.id, project] as const))(
  'typecheck scope %s — the PWA build typechecks it, and bun test does not',
  (_id, project) => {
    it('reports how many files it actually checked, so a green result cannot mean an empty sweep', () => {
      const { filesChecked } = sweep(project);
      // -1 = tsc 가 돌지 않았거나 출력 형식이 바뀌었다. ⛔ 그것은 「오류 0」이 아니라 「측정 실패」다.
      expect(filesChecked).toBeGreaterThan(project.minFiles);
    }, 180_000);

    it('has no diagnostic that belongs to no file — a config failure must not read as a clean sweep', () => {
      // ⛔ 「tsc 가 제대로 돌았나」는 귀속 실패 진단이 «없다»로 묻는다(종료 코드로는 못 가른다).
      //   ⊕ tsc 가 아예 죽으면 `Files:` 줄이 안 나오고, 그것은 위 분모 단언이 `-1` 로 잡는다.
      expect(sweep(project).unattributedErrors).toEqual([]);
    }, 180_000);

    // apps/pwa/package.json declares React/Next but neither is installed here (apps/pwa/tsconfig.json); PWA source tsc reports TS2307/TS7026 outside this goal.
    (project.id === 'pwa' ? it.skip : it)('has no type error outside test files — one such error stops `nexus build` entirely', () => {
      // ⛔ 이 단언이 깨지면 「시험이 까다롭다」가 아니라 ***「PWA 빌드가 멈췄다」***로 읽는다.
      //   그 상태에서 `nexus build` 는 실패하고, 데몬은 «옛 번들»을 계속 서빙한다 — 화면이 안 바뀐다.
      expect(sweep(project).sourceErrors).toEqual([]);
    }, 180_000);

    // apps/pwa/package.json dependencies are absent in this worktree; its test diagnostics are likewise outside this goal.
    (project.id === 'pwa' ? it.skip : it)('does not let test-file errors grow unwatched — the baseline is a ceiling, not a target', () => {
      const { testFileErrors } = sweep(project);
      const known = project.knownTestFileErrors;
      if (testFileErrors < known) {
        // ⭐ 고친 사람을 벌하지 않는다 — 실패시키지 않고, 기준선이 늙었다고 «자가 말한다».
        console.log(
          `[pwa-build-typecheck:${project.id}] test-file errors fell ${known} → ${testFileErrors}` +
            ` — lower knownTestFileErrors to ${testFileErrors} so this ruler keeps its teeth.`,
        );
      }
      // ⛔ 1차판은 이 축을 «세기만» 하고 판정에서 통째로 뺐다 ⇒ 100개로 늘어도 초록이었다(2차 리뷰 must-fix).
      expect(testFileErrors).toBeLessThanOrEqual(known);
    }, 180_000);
  },
);

/** ⛔⭐⭐ **자를 자로 잰다** — 15차 §3 의 규율(*"자를 만들 때는 자기 자를 «자로» 재라"*).
 *  아래 넷은 **1차판이 실제로 틀렸던 자리**를 하나씩 문다. 무인 리뷰가 그것을 must-fix 로 잡았다. */
describe('the ruler itself — each case is a way the first cut silently passed', () => {
  it('does not read a config failure as a clean sweep (the Goodhart hole the review found)', () => {
    // 📏 이것이 1차판의 구멍이다: 파일에 귀속되지 않아 «어느 목록에도» 안 들어갔고,
    //   `sourceErrors` 는 `[]` 라 ***tsc 가 아무것도 못 봤는데 초록***이 나왔다.
    const verdict = classifyDiagnostics("error TS5083: Cannot read file 'tsconfig.json'.");
    expect(verdict.unattributedErrors).toEqual(["error TS5083: Cannot read file 'tsconfig.json'."]);
    expect(verdict.sourceErrors).toEqual([]);
  });

  it('separates "no error" from "could not measure" — a missing Files line is -1, never 0', () => {
    expect(classifyDiagnostics('').filesChecked).toBe(-1);
    expect(classifyDiagnostics('Files:                         5362\n').filesChecked).toBe(5362);
  });

  it('does not count a continuation line as its own diagnostic', () => {
    // tsc 는 한 오류를 여러 들여쓴 줄로 풀어 쓴다. 그 줄에 `error TSxxxx:` 가 들어 있어도 하나다.
    const output = [
      "src/a.ts(1,1): error TS2345: Argument of type 'X' is not assignable.",
      "  Types of property 'y' are incompatible.",
      '    Type error TS2345: nested text that looks like a diagnostic.',
    ].join('\n');
    const verdict = classifyDiagnostics(output);
    expect(verdict.sourceErrors).toHaveLength(1);
    expect(verdict.unattributedErrors).toEqual([]);
  });

  it('separates source files from test files, so the ruler is not permanently red', () => {
    const output = [
      'src/app.ts(1,1): error TS1: source',
      'src/app.test.ts(1,1): error TS1: test',
      'apps/pwa/src/x.spec.tsx(1,1): error TS1: spec',
    ].join('\n');
    const verdict = classifyDiagnostics(output);
    expect(verdict.sourceErrors).toHaveLength(1);
    expect(verdict.testFileErrors).toBe(2);
  });
});

/** ### ⛔ 의도적 스코프 경계 — 시험 파일은 «0이 아니라 천장»으로 문다
 *
 *  📏 2026-08-22 기준선(실측): 비-시험 소스 **0 / 0** · 시험 파일 **14**(repo) · **21**(pwa).
 *  그 35개는 이 자보다 오래됐다. ⇒ 시험 파일까지 0을 요구하면 이 자는 «늘 빨갛고»,
 *  그러면 사람이 자를 무시하는 습관을 배운다(`R-CLM11` 형태 — 15차 §5 가 진입 파일 게이트에서 같은 것을 지적했다).
 *  ⛔ 그렇다고 「세기만」 하지도 않는다 — 1차판이 그랬고, 그러면 그 수가 100으로 늘어도 초록이다.
 *  ⇒ **기준선을 천장으로 둔다**: 늘면 실패, 줄면 「기준선을 낮춰라」고 자가 말한다(2차 리뷰 must-fix 반영).
 *
 *  ⊕ 📏 **부작용 — 「없다」고 적었다가 실측이 «세 번» 고쳤다**(리뷰 should-fix 1·2차 ⊕ 자기 실패):
 *  ⓐ *"PWA 는 `--noEmit` 이라 build-info 를 안 쓴다"* → **거짓**. TS 5.x 는 그 조합을 허용하고,
 *     실제로 `apps/pwa/tsconfig.tsbuildinfo` 가 생겼다.
 *  ⓑ *"`.gitignore` 가 덮으니 무해하다"* → 참이지만 **해결이 아니었다**.
 *  ⓒ 그래서 캐시를 `node_modules/.cache/` 로 돌렸는데 — ***그 캐시가 판정을 흔들었다***(위 §sweep).
 *  ⇒ **결론: 캐시를 아예 안 쓴다.** 트리에도 아무것도 안 남는다.
 *  🔑 이 세 판이 남긴 교훈: ***부작용은 「트리를 더럽히나」가 아니라 「답을 바꾸나」로 물어야 했다.***
 *  🔎 그때 다시 재는 명령:
 *  ```bash
 *  bun test test/pwa-build-typecheck.test.ts && git status --short   # 무출력이어야 한다
 *  ls apps/pwa/tsconfig.tsbuildinfo                                  # 「없다」여야 한다
 *  ```
 *  ⚠️ `find . -name '*.tsbuildinfo'` 로 세지 마라 — 의존성 패키지들이 «자기 것»을 갖고 있고
 *    `apps/pwa/.next/cache/.tsbuildinfo` 는 **Next 빌드**가 만든다. 둘 다 이 자와 무관한데 같이 잡힌다. */
