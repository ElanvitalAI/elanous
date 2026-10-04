// ── self-dev 게이트 스코프 결정 (순수 · 2026-07-26) ────────────────────────────────────
//
// ⭐ 왜 이 모듈이 있나 — **"테스트 변경이 없으면 풀 `bun test` 폴백"** 이 시스템 오류였다.
//
// 종전 `seams.ts` 게이트: 변경에 테스트 파일이 없고 소스가 있으면 풀 스위트로 폴백했다. 주석의 의도는
// *"검증 스킵 방지"* 였는데, **base 가 깨끗하지 않으면 그 폴백은 정보량 0인 신호**가 된다. 실측(2026-07-26):
//
//   1. `test/telegram-acp-bridge.test.ts` 는 **hang** 한다(4분+ 출력 0바이트 → unix socket connect
//      스택에서 정지 · `ensureDaemon`/`isUnixSocketAlive` 경합). 풀 스위트는 실패가 아니라 **정지**다.
//   2. 그래서 "소스만 바꾼" 라운드는 **항상** 게이트 실패했다 — doc-polish 2회(`srcChanged:1`) ·
//      S4 P2b round 0/1(`srcChanged:3`). rework 라운드가 통째로 낭비된다.
//   3. 더 나쁜 것은 **오귀속**이다. 자식 goal-loop 이 남긴 진단:
//      *"the gate cites a test failure in `src/telegram-acp-bridge.ts` — a code file I did not touch"*.
//      자식이 **자기가 건드리지 않은 파일**을 고치려 라운드를 태웠다.
//
// ⇒ 근본: 게이트는 **이 변경이 유발한 실패로만** 실패해야 한다. 항상 실패하는 게이트는 fail-safe 가
//    아니라 **fail-useless** 이고, 모든 증분을 막는다.
//
// ⭐ 수리 = **연관 테스트 유도(derive)**. 풀 폴백 경로를 **완전히 제거**하고, 변경 소스에서 실제 존재하는
//    연관 테스트를 찾아 그것만 돌린다. 없으면 test 스텝을 건너뛴다(tsc 게이트는 그대로 돈다).
//
// ⚠️ **정직성** — 이 변경은 명목 커버리지를 줄인다. 그러나 풀 폴백의 **실효 커버리지는 0이었다**
//    (항상 실패 = 신호 없음 = 판정 불가). 따라서 커버리지 축소가 아니라 **0 → 유효 신호**다.
//    "테스트를 추가해야 한다"는 압력은 게이트가 아니라 **리뷰**가 담당한다(이미 그렇게 동작한다).
//
// ⚠️ `integrity-gate.ts` 의 계약 2개를 반드시 지킨다(그래서 이 모듈이 `exists` 를 요구한다):
//    · `testArgs: []`(빈 배열)은 **필터 미적용 = 풀 실행**이다 → "빈 배열로 끄기"는 불가.
//    · 필터가 아무 파일도 매치하지 않으면 **의도적으로 FAIL** 한다("0 files ran … 거짓통과 차단")
//      → 유도 결과는 **반드시 존재하는 파일**이어야 한다.

import { importerTestsNotInRunSet, type ImporterTestIndex } from './importer-test-index.js';
import type { RouteConsumerTestIndex } from './route-consumer-test-index.js';
import { rankGateCallerCandidates } from './gate-candidate-ranking.js';

export const GATE_CALLER_TEST_LIMIT = 30;
export type GateCallerReason = 'import' | 'route';

/** 테스트 파일 판정(기존 `seams.ts` 정규식과 동일 — 어휘 분기 금지). */
const TEST_RE = /\.(test|spec)\.[cm]?[tj]sx?$/;
/** Kotlin 시험 파일 판정 — TypeScript `TEST_RE`와 별도 관례(`XTest.kt`)를 쓴다. */
const KOTLIN_TEST_RE = /Test\.kt$/;
/** TypeScript 또는 Kotlin 시험 파일인가. */
function isTestFile(f: string): boolean {
  return TEST_RE.test(f) || KOTLIN_TEST_RE.test(f);
}
/** 소스 파일 판정(테스트 파일도 포함된다 — 호출 순서로 분기한다).
 *  `.sh` 는 bun 이 직접 실행하지 않지만, 같은 stem 의 co-located `*.test.ts` 가
 *  `Bun.spawnSync` 로 그 스크립트를 띄우면 그 테스트가 커버다. 없으면 종전처럼 unverified. */
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|kt|sh)$/;
/** 모호성 판정용 소스 확장자(SOURCE_RE 와 동일 집합 · 경로 조립에 쓰므로 리터럴 필요). */
const SOURCE_SUFFIXES = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.kt', '.sh'] as const;

/** ⭐ **문서 allowlist**(2026-07-27 · **사후 리뷰가 찾은 결함** 수리) — **문서 확장자만**(경로 prefix 미사용).
 *
 *  ⚠️ 종전 판별은 *"소스 확장자(`SOURCE_RE`)가 하나도 없으면 docs-only"* 라는 **소스 부재**였다.
 *  그건 **비문서·비소스 변경을 전부 docs-only 로 오분류**한다 — 실측(2026-07-27):
 *  `package.json` · `bun.lock` · `tsconfig.json` · `.github/workflows/ci.yml` · `Dockerfile` · `x.py` ·
 *  `scripts/deploy.sh` **전부** `reason:'docs-only'` 로 떨어져 test 스텝이 **"정상"이라며** 건너뛰어졌다.
 *  `package.json`(의존성) 변경이 조용히 미검증으로 통과하는 것은 실질 위험이다.
 *
 *  ⇒ **부재 판정을 존재 판정으로 뒤집는다**: *"모든 변경이 문서인가"*(⚠️ **확장자 축만** — `docs/`
 *  경로 prefix 는 쓰지 않는다·아래 `isDocPath` 참조). 미지의 확장자는 문서가 아니므로
 *  자동으로 비-docs 쪽에 떨어진다(**fail-safe 방향** — 새 파일종류가 생겨도 조용히 스킵되지 않는다).
 *
 *  ⚠️ 출처: 이미 머지된 #5490 에 **사후 리뷰**를 돌려 발견했다(매뉴얼 §6a) — 머지가 검증의 끝이 아니다. */
const DOC_RE = /\.(md|mdx|markdown|rst|adoc)$/i;

/**
 * 이 경로가 문서인가 — **확장자 allowlist**로만 판정한다.
 *
 * ⚠️ **`docs/` 트리 전체와 `.txt` 를 문서로 보지 않는다**(2026-07-27 리뷰 should-fix로 좁힘):
 *   · `docs/` prefix 만으로 통과시키면 `docs/package.json`·`docs/scripts/x.sh` 같은 **실행/설정
 *     파일이 다시 docs-only 로 오분류**된다 — 이 PR 이 없애려던 결함이 경로 축으로 부활한다.
 *   · `.txt` 는 **런타임 fixture** 로 널리 쓰여(테스트 입력·스냅샷) 문서로 단정할 수 없다.
 * ⇒ 확장자 축만 남긴다. 문서 트리 안의 비-마크다운 자산(`docs/img/a.png` 등)은 문서로 **안 보고**
 *   `no-related-tests` 로 떨어진다 — **보수적 방향**이라 안전하다(스킵을 조용히 넓히지 않는다).
 */
function isDocPath(f: string): boolean {
  return DOC_RE.test(f);
}

/** elanous 가 «대상 저장소»에 남기는 런타임 상태 경로 — ***하나의 출처***.
 *
 *  ⛔ 이 목록을 «다른 곳에 다시» 나열하지 마라. 2026-09-21 실측으로 그 나열이 세 군데로 갈렸고
 *  그때마다 «다른 부분집합»이었다:
 *    ① `commitWorktree`            다섯 을 안다 (`#19300`)
 *    ② `pr-manager` 의 스테이징   아무것도 안 알았다 → 빈 저장소 PR 에 누출 (`#19302`)
 *    ③ `repo-provision` 의 .gitignore  ***다섯 중 둘***만 썼다 → 나머지 셋은 여전히 untracked
 *  ⇒ 그래서 목록을 여기 한 군데 두고, 쓰는 쪽은 전부 이것을 임포트한다.
 */
export const ELANOUS_RUNTIME_ARTIFACT_PATHS = ['.elanous-child-liveness.hb'] as const;
/** 끝에 슬래시를 두어 «디렉토리»임을 분명히 한다 — gitignore 문면과 그대로 맞춘다. */
export const ELANOUS_RUNTIME_ARTIFACT_DIRS = [
  '.elanous/',
  '.elanous-se/',
  '.elanous-goal-grounding-build/',
  '.elanous-session/',
] as const;

/** elanous가 대상 저장소에 남기는 런타임 상태 경로인가. 사용자 경로와 혼동하지 않도록 알려진 상태 루트만 허용한다. */
export function isElanousRuntimeArtifactPath(path: string): boolean {
  return (ELANOUS_RUNTIME_ARTIFACT_PATHS as readonly string[]).includes(path)
    || ELANOUS_RUNTIME_ARTIFACT_DIRS.some((dir) => path.startsWith(dir));
}

/** ⭐ 유도 접미사 — `TEST_RE` **탐지**와 **완전 대칭**이어야 한다(리뷰 must-fix 2R·3R).
 *
 *  1R 수정은 손으로 6종을 나열했는데 `TEST_RE`(`/\.(test|spec)\.[cm]?[tj]sx?$/`)가 받아주는
 *  `.spec.js`/`.spec.jsx` 와 모든 `[cm]` 변형(`.mts`/`.cts`/`.mjs`/`.cjs`…)을 **누락**했다 —
 *  실존 연관 테스트가 있어도 `no-related-tests` 로 오판·스킵한다. **손 나열이 근본 문제**였다.
 *
 *  ⇒ 이제 **같은 문법에서 생성**한다(2×3×2×2 = 24종). 손 나열이 없으니 드리프트가 구조적으로 불가능하고,
 *  `gate-scope.test.ts` 의 대칭 테스트가 `TEST_RE` 와의 일치를 매 실행 확인한다.
 *
 *  ⚠️ 정직 표기: 실측 시점(2026-07-26) 레포엔 `.ts` 이외 변종이 **0개**다 — 라이브 버그가 아니라
 *  **비대칭 제거(하드닝)** 다. 변종 하나가 생기는 순간 오판이 되므로 지금 맞춰 둔다. */
const TEST_SUFFIXES: readonly string[] = (['test', 'spec'] as const).flatMap((kind) =>
  ['', 'c', 'm'].flatMap((pre) =>
    ['t', 'j'].flatMap((lang) => ['s', 'sx'].map((tail) => `.${kind}.${pre}${lang}${tail}`))));

/** 평탄화 이름의 **pre-image 전수** — `a-b-c` → `[a-b-c, a/b-c, a-b/c, a/b/c]`(2^(n-1)).
 *  `test/<flat>` 로 접힐 수 있는 모든 `src/<rel>` 후보다. 세그먼트 상한을 넘으면 `null`(조합 폭발 방지).
 *
 *  ⭐ **비용 실측**(리뷰 should-fix 5R "게이트 지연 모니터링" · 2026-07-26) — 상한은 소스당
 *  `2^7 × 6(확장자) + 6 × 24(접미사)` ≈ **912 `statSync`**. 실측:
 *    · 이 PR 의 실제 변경(3파일) = **156회 · 1ms**
 *    · 최악 합성(20파일 × 7세그먼트) = **8520회 · 9ms**
 *  게이트 본체(`bun test`+tsc)가 수십 초~분이므로 **무시할 수준**이다. 상한이 있어 무한 증가도 없다.
 *  ⇒ 지금 최적화(메모이제이션 등)를 넣지 않는다 — 측정된 병목이 아닌 곳의 복잡도는 부채다. */
function flattenPreimages(flat: string, maxSegments = 8): string[] | null {
  const segs = flat.split('-');
  if (segs.length > maxSegments) return null;
  let acc: string[] = [segs[0] ?? ''];
  for (let i = 1; i < segs.length; i += 1) {
    const next: string[] = [];
    for (const a of acc) { next.push(`${a}-${segs[i]}`); next.push(`${a}/${segs[i]}`); }
    acc = next;
  }
  return acc;
}

/** ⭐ 이 평탄 이름이 **호출자 소스에만** 대응하나(리뷰 must-fix 4R — 3R 은 `src/<flat>.*` 한 형태만 봐서
 *  `src/a/b-c.ts` ↔ `src/a-b/c.ts` 같은 **다단 충돌을 그대로 오귀속**했다).
 *  pre-image 를 **전수 열거**하고 **자신(`ownRel`)을 제외한** 실존 소스가 하나도 없을 때만 채택한다.
 *  ⚠️ 자신의 disk 실존은 묻지 않는다 — 변경 목록에 있다는 사실로 충분하고, 삭제된 소스라면 애초에
 *  유도할 이유가 없다(그 경우 후보가 실존하지 않아 자연히 걸러진다).
 *  세그먼트 상한 초과는 **보수적으로 폐기**(오귀속 0 우선). */
function flattenIsUnambiguous(flat: string, ownRel: string, exists: (p: string) => boolean): boolean {
  const pre = flattenPreimages(flat);
  if (pre === null) return false;
  for (const rel of pre) {
    if (rel === ownRel) continue;
    if (SOURCE_SUFFIXES.some((ext) => exists(`src/${rel}${ext}`))) return false; // 다른 소스도 접힌다 = 모호
  }
  return true;
}

/**
 * ⭐ 변경 소스 → 존재하는 연관 테스트 경로. **순수**(파일시스템은 주입된 `exists` 로만).
 *
 * 실측된 레포 관례 3종(2026-07-26·2026-08-09 · 모두 실재):
 *   · **co-located** (571개): `src/a/b.ts` → `src/a/b.test.ts`
 *   · **`test/` 평탄화** (2488개): `src/a/b.ts` → `test/a-b.test.ts` (경로의 `/` 를 `-` 로)
 *   · **`test/` 중첩** (434개): `src/a/b.ts` → `test/a/b.test.ts`
 *
 * `.test.ts` 자체인 변경은 제외한다(그건 호출부의 `changed-tests` 분기 소관).
 * `src/` 밖 소스는 같은 경로의 co-located 테스트만 유도한다. `test/` 평탄·중첩 관례는 `src/`에만
 * 적용해, scripts/ 등에 존재하지 않는 관례를 추측하지 않는다(호출부는 밖 소스 개수를 계속 관측).
 * `.sh` 도 같은 stem 의 co-located `*.test.ts` 만 본다 — 그 테스트가 스크립트를 spawn 하면 커버다.
 *
 * ⭐ **의도된 계약(리뷰 5R must-fix 에 대한 반론 · 근거 명시)** — 같은 stem 의 다른 확장자
 * (`src/a.ts` ⊕ `src/a.js`)는 **충돌로 보지 않는다.** 근거 2가지:
 *   ① **성질이 다르다.** 평탄화 충돌(`src/a/b.ts` ↔ `src/a-b.ts`)은 **서로 다른 모듈**이 같은 테스트
 *      이름으로 접히는 것이라 오귀속이다. 반면 같은 stem 의 확장자 변형은 **같은 논리 모듈**의 변종
 *      (마이그레이션·빌드 산출)이고, `a.test.ts` 는 그 모듈의 테스트다 — 실행이 **옳은 동작**이다.
 *   ② **실측**(2026-07-26): `src/` 의 `.js`/`.jsx`/`.mjs`/`.cjs` 파일 수 = **0**. 공존 사례도 0이라
 *      현 레포에선 발생조차 하지 않는다.
 * ⇒ 확장자 변형은 **그대로 유도한다**(아래 회귀 테스트가 이 계약을 고정한다). 확장자 커버리지 자체는
 *   이미 완전하다 — `flattenIsUnambiguous` 가 **다른** pre-image 에 대해 `SOURCE_SUFFIXES` 전수를 본다.
 */
export function deriveRelatedTests(
  changed: readonly string[],
  exists: (path: string) => boolean,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of changed) {
    if (isTestFile(f) || !SOURCE_RE.test(f)) continue;
    if (f.endsWith('.kt')) {
      const kotlinTestRoot = f.replace('/src/main/kotlin/', '/src/test/kotlin/');
      if (kotlinTestRoot === f) continue;
      const kotlinTest = kotlinTestRoot.replace(/\.kt$/, 'Test.kt');
      if (!seen.has(kotlinTest)) {
        seen.add(kotlinTest);
        if (exists(kotlinTest)) out.push(kotlinTest);
      }
      continue;
    }
    const stem = f.replace(SOURCE_RE, '');
    // ⭐ 순서 계약(리뷰 should-fix 3R·5R) — **소스별로** co-located 전부 → `test/` 전부.
    //   3R 이 "접미사-우선"을 고쳤고, 5R 이 "전역 우선순위"로 읽히는 문구를 지적했다. 실제는 **소스별
    //   그룹**이며 그게 의도다(한 소스의 연관 테스트가 인접해 로그·디버깅이 읽기 쉽다).
    const cands = [...TEST_SUFFIXES.map((sfx) => `${stem}${sfx}`)];
    if (f.startsWith('src/')) {
      const rel = f.slice('src/'.length).replace(SOURCE_RE, '');
      // ⚠️ **평탄화 모호성 방어** — `test/` 관례는 `/`→`-` 라 여러 소스가 **같은** 평탄 이름으로 접힌다.
      //   그대로 두면 무관 테스트를 유도해 **이 PR 이 없애려는 오귀속이 되살아난다.**
      //   `flattenIsUnambiguous` 가 **모든 pre-image 를 열거**해 판정한다(3R 의 한-형태 검사 → 4R 전수).
      const flat = rel.replace(/\//g, '-');
      if (flattenIsUnambiguous(flat, rel, exists)) {
        cands.push(...TEST_SUFFIXES.map((sfx) => `test/${flat}${sfx}`));
      }
      // 중첩 경로는 subpath를 보존하므로 평탄화 충돌이 없다.
      cands.push(...TEST_SUFFIXES.map((sfx) => `test/${rel}${sfx}`));
    }
    for (const cand of cands) {
      if (seen.has(cand)) continue;
      seen.add(cand);
      if (exists(cand)) out.push(cand);
    }
  }
  return out;
}

/** 왜 이 범위로 돌았나 — 로그만으로 답할 수 있게 하는 관측 필드(제1원칙).
 *  ⚠️ 비-export 유지(리뷰 must-fix) — 소비처가 이 모듈 안뿐이다. 구조적 사용(호출부의 `scope.reason`)은
 *  export 없이도 성립하므로 불필요한 공개 surface 를 만들지 않는다. */
type GateScopeReason = 'changed-tests' | 'derived' | 'no-changes' | 'docs-only' | 'no-related-tests' | 'unmeasured';

export type GateScopeMode = 'worktree' | 'postsync';

interface GateScopeDecision {
  /** integrity-gate 에 넘길 필터. **비어있지 않을 때만** 존재한다(빈 배열=풀 실행이라). */
  readonly testArgs?: readonly string[];
  /** test 스텝을 steps 에서 빼야 하나. */
  readonly skipTestStep: boolean;
  readonly reason: GateScopeReason;
  readonly sourceFiles: readonly string[];
  readonly derived: readonly string[];
  /** 기존 docs-only 판정 기준에 맞는 변경 문서 경로. */
  readonly documentPaths: readonly string[];
  /** 유도된 테스트 실행 집합에 기여하지 않은 변경 문서 경로. */
  readonly documentsWithoutDerivedTests: readonly string[];
  /** `src/` 밖이라 유도 대상에서 제외한 소스 개수(무시했다는 사실을 관측에 남기기 위함). */
  readonly ignoredOutsideSrc: number;
  /** 변경 목록엔 있으나 **실존하지 않는** 테스트 경로 수(삭제·rename 前). 0 이 아니면 관측에 남긴다. */
  readonly missingTestFiles: number;
  /** ⭐ **동작 검증을 못 한 비문서 파일**들(`package.json`·설정·스크립트 포함). **분기 무관**으로 계산돼
   *  `derived`/`changed-tests` 로 테스트가 **돌더라도** 커버되지 않은 파일이 여기 남는다(은폐 방지). */
  readonly unverified: readonly string[];
  /** elanous 자체가 남긴 런타임 산출물. 미검증 사용자 변경에서 제외하되 경로를 보존한다. */
  readonly elanousRuntimeArtifacts: readonly string[];
  /** ⭐ 편집되지 않았는데 함께 끌어와 돌린 연관 테스트(`changed-tests` 분기) — 합집합이 실제로 구제한 파일들. */
  readonly pulledInRelatedTests: readonly string[];
  /** 실행 집합에 없는, 변경 소스를 상대 import 하는 테스트. 색인이 주입되지 않으면 null. */
  readonly importerTestsNotRun: {
    readonly total: number;
    readonly files: readonly string[];
    readonly truncated: boolean;
    readonly unresolvedRelativeSpecifiers: number;
  } | null;
  /** Selected reverse-dependent tests and why they were pulled into the gate. */
  readonly callerTests: readonly { readonly file: string; readonly reasons: readonly GateCallerReason[] }[];
  /** Caller tests exceeding the cap, retained in full for warning and diagnosis. */
  readonly callerTestsOverflow: readonly { readonly file: string; readonly reasons: readonly GateCallerReason[] }[];
}

/**
 * ⭐ 게이트 스코프 결정(순수). 5경로 — **풀 폴백은 없다**.
 *
 *   changed-tests     : 변경에 테스트 파일이 있다 → 편집 테스트와 변경 소스의 모든 연관 테스트를 함께 돌린다
 *   no-changes        : 이 스코프가 관측한 변경이 없다 → test 스텝 제외
 *   unmeasured        : postsync 빈 범위 — 「깨끗하다」가 아니라 「못 쟀다」
 *   docs-only         : 문서만 변경됐다 → test 스텝 제외(#5490)
 *   derived           : 소스는 바뀌었고 연관 테스트가 **존재** → 그것만 돌린다  ← 신규
 *   no-related-tests  : 소스는 바뀌었으나 연관 테스트가 **없다** → test 스텝 제외 ← 신규
 */
export function resolveGateScope(
  changed: readonly string[],
  exists: (path: string) => boolean,
  importerTestIndex?: ImporterTestIndex,
  opts?: { mode?: GateScopeMode; isDeleted?: (path: string) => boolean; routeConsumerTestIndex?: RouteConsumerTestIndex },
): GateScopeDecision {
  // ⚠️ **실존 검증(리뷰 must-fix 4R)** — `gitChangedFiles` 는 `git diff --name-only HEAD` 라
  //   **삭제·rename 前 경로도 포함**한다. 그걸 그대로 `testArgs` 로 넘기면 필터가 아무것도 매치하지
  //   못해 integrity-gate 가 "0 files ran … 거짓통과 차단"으로 **부당하게 FAIL** 한다(테스트를 지우는
  //   정당한 변경이 게이트에 막힌다). ⇒ 실존하는 것만 쓴다.
  const elanousRuntimeArtifacts = changed.filter(isElanousRuntimeArtifactPath);
  const userChanged = changed.filter((f) => !isElanousRuntimeArtifactPath(f));
  const changedTests = userChanged.filter(isTestFile);
  const testFiles = changedTests.filter((f) => exists(f));
  const missingTestFiles = changedTests.length - testFiles.length;
  const sourceFiles = userChanged.filter((f) => SOURCE_RE.test(f));
  const ignoredOutsideSrc = sourceFiles.filter((f) => !isTestFile(f) && !f.startsWith('src/')).length;
  /** ⭐ **문서가 아닌 사용자 변경** — 이게 비어야 docs-only 다(소스 부재가 아니라 **문서 전부**여야 한다). */
  const documentPaths = userChanged.filter(isDocPath);
  const nonDoc = userChanged.filter((f) => !isDocPath(f));
  /**
   * ⭐ **이 변경 중 무엇이 검증되지 않나** — 분기와 **무관하게** 계산한다(리뷰 must-fix 2026-07-27).
   *
   * ⚠️ 종전엔 `no-related-tests` 분기에서만 채웠다. 그래서 `src/a.ts`(연관 테스트 있음) **+
   * `package.json`** 처럼 섞이면 `derived` 로 **조기 반환**돼 `package.json` 이 `unverified`·warn·note
   * 에서 **통째로 사라졌다** — "테스트가 돌았으니 안전"으로 읽히지만 config 변경은 검증되지 않았다.
   * `changed-tests` 분기도 같은 구멍이었다.
   *
   * 판정: 비문서 파일 중 **자기 자신이 테스트도 아니고 연관 테스트도 없는** 것.
   * ⇒ `package.json`·lockfile·설정·스크립트는 **어느 분기에서도** 미검증으로 드러난다.
   */
  /**
   * ⭐ **실제 실행 집합(`runSet`) 기준**으로 커버 여부를 판정한다(리뷰 must-fix 2026-07-27 2R).
   *
   * ⚠️ 직전 판본은 *"연관 테스트가 **존재하기만** 하면 커버"* 로 봤다. 그건 틀렸다 —
   * `changed-tests` 분기는 **변경된 테스트만** 돌린다. 예: `src/a.ts` + `src/b.test.ts` 변경(`src/a.test.ts`
   * 는 존재하나 **미변경**) ⇒ 실행되는 건 `b.test.ts` 뿐인데 `a.ts` 가 "연관 테스트 존재"를 이유로
   * unverified 에서 빠졌다. **실행되지 않은 테스트는 검증이 아니다.**
   */
  const relatedFor = (f: string): readonly string[] => deriveRelatedTests([f], exists);
  // 🩸 2026-09-26 실물(run-7dd4cce6): 실패 시험 0 인데 게이트가 두 라운드 «미검증 2»로 실패했다 —
  //   ① 지운 시험 파일(없는 파일은 돌릴 수 없다 · 자식이 무엇을 해도 «검증»될 수 없다)
  //   ② 함수만 지운 소스 — 그 파일을 import 하는 시험이 «실제로 돌았는데» 이름 짝(`x.ts`↔`x.test.ts`)만 봐서 커버로 안 셌다.
  //   ⇒ «지운» 파일은 미검증이 아니다(호출자가 `opts.isDeleted` 로 알린다 · 남은 참조는 tsc·남은 시험이 문다) · 실행 집합의 시험이 import 하면 커버다(importer 색인).
  const coveredBy = (runSet: readonly string[]) => (f: string): boolean => {
    if (runSet.includes(f)) return true;
    if (opts?.isDeleted?.(f)) return true;
    if (importerTestIndex && (importerTestIndex.testsBySource.get(f) ?? []).some((t) => runSet.includes(t))) return true;
    const related = relatedFor(f);
    return related.length > 0 && related.every((t) => runSet.includes(t));
  };
  const unverifiedFor = (runSet: readonly string[]): string[] => nonDoc.filter((f) => !coveredBy(runSet)(f));
  const documentsWithoutDerivedTestsFor = (runSet: readonly string[]): string[] => documentPaths
    .filter((f) => !coveredBy(runSet)(f));

  const observationFor = (runSet: readonly string[]) => importerTestIndex
    ? importerTestsNotInRunSet(importerTestIndex, userChanged, runSet)
    : null;
  const conventional = deriveRelatedTests(userChanged, exists);
  const alreadySelected = new Set([...testFiles, ...conventional]);
  const callers = new Map<string, Set<GateCallerReason>>();
  for (const source of userChanged) {
    for (const [reason, tests] of [
      ['import', importerTestIndex?.testsBySource.get(source) ?? []],
      ['route', opts?.routeConsumerTestIndex?.testsBySource.get(source) ?? []],
    ] as const) {
      for (const test of tests) {
        if (!exists(test) || alreadySelected.has(test)) continue;
        const reasons = callers.get(test) ?? new Set<GateCallerReason>();
        reasons.add(reason);
        callers.set(test, reasons);
      }
    }
  }
  // GATE-CALLERS2 — the cap keeps the candidates closest to the change, not the alphabetically first.
  const candidates = rankGateCallerCandidates(userChanged, [...callers].map(([file, reasons]) => ({ file, reasons: [...reasons] })),
    importerTestIndex?.testsBySource ?? new Map());
  const callerTests = candidates.slice(0, GATE_CALLER_TEST_LIMIT);
  const callerTestsOverflow = candidates.slice(GATE_CALLER_TEST_LIMIT);
  const runWithCallers = (tests: readonly string[]) => [...new Set([...tests, ...callerTests.map(({ file }) => file)])];
  const base = { sourceFiles, documentPaths, ignoredOutsideSrc, missingTestFiles, elanousRuntimeArtifacts, callerTests, callerTestsOverflow,
    unverified: [] as readonly string[], derived: [] as readonly string[], pulledInRelatedTests: [] as readonly string[] };
  const withDocumentNonContribution = (runSet: readonly string[]) => ({
    documentsWithoutDerivedTests: documentsWithoutDerivedTestsFor(runSet),
  });

  if (testFiles.length > 0) {
    // Edited tests ⊕ every related test of the changed sources ⊕ capped callers (restored 10-04: #23467 narrowed this
    // to edited tests only, so a co-located sibling of a changed source stopped running — 0.2.12 gate introduced).
    const allRelatedTests = conventional;
    const runSet = runWithCallers([...testFiles, ...allRelatedTests]);
    // 편집된 테스트만 돌렸다면 빠졌을 것들 — 이 목록이 비어있지 않다는 것은 합집합이 실제로 구제했다는 뜻이다.
    const pulledInRelatedTests = allRelatedTests.filter((f) => !testFiles.includes(f));
    return { ...base, ...withDocumentNonContribution(runSet), testArgs: runSet, unverified: unverifiedFor(runSet), pulledInRelatedTests,
      importerTestsNotRun: observationFor(runSet), skipTestStep: false, reason: 'changed-tests' };
  }
  if (userChanged.length === 0) {
    // postsync 빈 범위는 기존 no-changes(깨끗함)와 다른 값이다. 일반 호출자는 계속 no-changes를 읽는다.
    return { ...base, ...withDocumentNonContribution([]), importerTestsNotRun: observationFor([]), skipTestStep: true, reason: opts?.mode === 'postsync' ? 'unmeasured' : 'no-changes' };
  }
  if (nonDoc.length === 0) {
    return { ...base, ...withDocumentNonContribution([]), importerTestsNotRun: observationFor([]), skipTestStep: true, reason: 'docs-only' };
  }
  const derived = conventional;
  const runSet = runWithCallers(derived);
  if (runSet.length > 0) {
    return { ...base, ...withDocumentNonContribution(runSet), derived, testArgs: runSet, unverified: unverifiedFor(runSet), importerTestsNotRun: observationFor(runSet), skipTestStep: false, reason: 'derived' };
  }
  // 실행 집합이 비었으므로 비문서 전부가 미검증이다.
  return { ...base, ...withDocumentNonContribution([]), unverified: unverifiedFor([]), importerTestsNotRun: observationFor([]), skipTestStep: true, reason: 'no-related-tests' };
}
