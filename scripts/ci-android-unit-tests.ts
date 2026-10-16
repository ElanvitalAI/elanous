/**
 * 안드로이드 단위 시험 게이트 — ⛔ 「돌지 않았다」를 「통과」로 읽지 않는다.
 *
 * 🚨 왜 이것이 있나 (2026-09-07 실측):
 *   `origin/main` 의 안드로이드 시험이 ***컴파일조차 안 된 채로 착지해 있었다.***
 *   `ChatInputBarTest.kt` 가 `ChatLayoutTags.ATTACH_BUTTON` 을 부르는데 소스는
 *   `ATTACH_ENTRY` 로 정의했고, 아무도 몰랐다 — 돈 시험이 **0개**였기 때문이다.
 *
 *   ⛔ 근본은 하니스 게이트가 안드로이드를 «보지 못한다»는 것이었다. 세 겹으로 안 보였다:
 *     gate-scope 의 TEST_RE   = /\.(test|spec)\.[cm]?[tj]sx?$/   ← .kt 는 «시험이 아니다»
 *     gate-scope 의 SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/     ← .kt 는 «소스도 아니다»
 *     러너                     = bun test <files>                 ← 설령 골라도 «못 돌린다»
 *   ⇒ Kotlin 만 바꾼 PR 은 «검사 없이» 리뷰 PASS ⊕ 무인 병합으로 들어갔다(#15941).
 *
 * 🔑 그래서 이 게이트의 1급 판정은 「실패가 있나」가 아니라 ***「몇 개가 «돌았나»」***다.
 *    ⛔ **0개는 통과가 아니다.** 그것이 오늘 놓친 바로 그 상태다.
 *
 * ⚠️ 그리고 「잴 수 없었다」를 「통과」로 접지 않는다(`R-OBS` 계열 · 대표 상시지시):
 *    JDK 가 모자라 시험이 못 돌면 **exit 1** 이고, 산출이 «무엇을 설치해야 하는지» 말한다.
 *    ⇒ 오늘의 교훈이 정확히 이것이다 — 「못 쟀다」가 조용히 「초록」이 되어 있었다.
 *
 * 사용:
 *   bun run scripts/ci-android-unit-tests.ts                          # 전체 검사
 *   bun run scripts/ci-android-unit-tests.ts --changed-files a.kt,b.kt # 변경 범위 판정
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { androidToolchainMissing } from './lib/android-toolchain.js';

const ROOT = join(import.meta.dir, '..');

/** 이 게이트가 책임지는 구역. 여기 밖의 변경만 있으면 게이트는 «해당 없음»이다. */
export const ANDROID_PREFIX = 'apps/android/';

/** 게이트를 깨우는 확장자. ⭐ `.test.ts` 도 포함한다 — `apps/android/` 밑에 «소스를 텍스트로 읽는»
 *  `.test.ts` 가 실재하고(ChatAttachPolicy.test.ts), 그것만 바뀌어도 Kotlin 계약이 흔들릴 수 있다. */
const TRIGGER_RE = /\.(kt|kts|java|gradle|toml|xml|pro|ts)$/;

/** Android Kotlin 소스셋(`src/<name>/kotlin/`) 안의 `.test.ts`. 경로는 `/` 로 정규화해서 본다. */
const KOTLIN_SOURCESET_TEST_TS_RE = /(?:^|\/)src\/[^/]+\/kotlin\/.+\.test\.ts$/;

export function androidFilesIn(changed: readonly string[]): string[] {
  return changed.filter((f) => f.startsWith(ANDROID_PREFIX) && TRIGGER_RE.test(f));
}

function posixPath(file: string): string {
  return file.replaceAll('\\', '/');
}

/** 산출에 쓸 저장소 상대 경로 — `apps/android/…` 부터. */
export function displayAndroidPath(file: string): string {
  const n = posixPath(file);
  const i = n.indexOf(ANDROID_PREFIX);
  return i >= 0 ? n.slice(i) : n;
}

/**
 * 파일 목록에서 «안드로이드 Kotlin 소스셋 안의 `.test.ts`» 만 남긴다.
 * ⛔ 존재만으로 실패를 만들지 않는다 — 세어서 말할 목록이다.
 */
export function androidKotlinSourcesetTestTsFiles(files: readonly string[]): string[] {
  return files.filter((f) => {
    const n = posixPath(f);
    return n.includes(ANDROID_PREFIX) && KOTLIN_SOURCESET_TEST_TS_RE.test(n);
  });
}

export type AndroidTestTally = {
  /** 실제로 «돈» testcase 수. ⛔ 0 은 통과가 아니다. */
  readonly ran: number;
  readonly failed: number;
  readonly skipped: number;
  /** 실패한 testcase의 안정 식별자 (`classname#name`). */
  readonly failedTestIdentifiers: readonly string[];
  /** 실제로 실행되어 실패·건너뜀이 아닌 testcase의 안정 식별자 (`classname#name`). */
  readonly passedTestIdentifiers: readonly string[];
};

function decodeXmlAttribute(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity) => {
    switch (entity.toLowerCase()) {
      case '&amp;': return '&';
      case '&lt;': return '<';
      case '&gt;': return '>';
      case '&quot;': return '"';
      case '&apos;': return "'";
      default: {
        const hexadecimal = entity[2]?.toLowerCase() === 'x';
        const numeric = entity.slice(hexadecimal ? 3 : 2, -1);
        const codePoint = Number.parseInt(numeric, hexadecimal ? 16 : 10);
        const validCodePoint = Number.isInteger(codePoint)
          && codePoint >= 0
          && codePoint <= 0x10ffff
          && (codePoint < 0xd800 || codePoint > 0xdfff);
        return validCodePoint ? String.fromCodePoint(codePoint) : entity;
      }
    }
  });
}

function junitAttribute(openingTag: string, soughtName: string): string | null {
  const end = openingTag.endsWith('/>') ? openingTag.length - 2 : openingTag.length - 1;
  let index = '<testcase'.length;
  while (index < end) {
    while (index < end && /\s/.test(openingTag[index]!)) index += 1;
    const nameStart = index;
    while (index < end && !/[\s=]/.test(openingTag[index]!)) index += 1;
    const name = openingTag.slice(nameStart, index);
    while (index < end && /\s/.test(openingTag[index]!)) index += 1;
    if (openingTag[index] !== '=') return null;
    index += 1;
    while (index < end && /\s/.test(openingTag[index]!)) index += 1;
    const quote = openingTag[index];
    if (quote !== '"' && quote !== "'") return null;
    const valueStart = ++index;
    while (index < end && openingTag[index] !== quote) index += 1;
    if (index >= end) return null;
    const value = openingTag.slice(valueStart, index);
    index += 1;
    if (name === soughtName) return decodeXmlAttribute(value);
  }
  return null;
}

function testcaseOpeningTags(xml: string): { readonly tag: string; readonly end: number }[] {
  const tags: { tag: string; end: number }[] = [];
  for (let start = xml.indexOf('<testcase'); start >= 0; start = xml.indexOf('<testcase', start + 1)) {
    const boundary = xml[start + '<testcase'.length];
    if (boundary && !/[\s/>]/.test(boundary)) continue;
    let quote: string | null = null;
    for (let end = start + '<testcase'.length; end < xml.length; end += 1) {
      const character = xml[end]!;
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        tags.push({ tag: xml.slice(start, end + 1), end: end + 1 });
        break;
      }
    }
  }
  return tags;
}

function failedTestIdentifier(openingTag: string): string {
  const classname = junitAttribute(openingTag, 'classname') ?? '<missing-classname>';
  const name = junitAttribute(openingTag, 'name') ?? '<missing-name>';
  return `${classname}#${name}`;
}

/** 목록 파일과 비교에 쓰는 안정 순서: 빈 항목 제거 ⊕ 중복 제거 ⊕ 사전순 정렬. */
export function serializeFailedTestBaseline(identifiers: readonly string[]): string {
  const normalized = [...new Set(identifiers.map((identifier) => identifier.trim()).filter(Boolean))].sort();
  return normalized.length === 0 ? '' : `${normalized.join('\n')}\n`;
}

/** 명시한 baseline 파일을 읽는다. 파일이 없으면 비교 불가(undefined)다. */
export function loadFailedTestBaselineFile(path: string): readonly string[] | undefined {
  if (!existsSync(path)) return undefined;
  return serializeFailedTestBaseline(readFileSync(path, 'utf8').split(/\r?\n/)).trimEnd().split('\n').filter(Boolean);
}

/** 현재 JUnit 실패 목록을 결정적 baseline 파일로 쓴다. */
export function writeFailedTestBaseline(path: string, identifiers: readonly string[]): void {
  writeFileSync(path, serializeFailedTestBaseline(identifiers), 'utf8');
}

/** 현재 실패 중 baseline에 없던 안정 식별자를 정렬·중복 제거해 돌려준다. */
export function compareFailedTestIdentifiers(
  current: readonly string[],
  baseline: readonly string[],
): string[] {
  const baselineIdentifiers = new Set(baseline);
  return [...new Set(current.filter((identifier) => !baselineIdentifiers.has(identifier)))].sort();
}

/**
 * Gradle 이 낸 JUnit XML 에서 «실제 testcase 수»와 실패 식별자를 센다.
 * ⛔ stdout 의 "N tests completed" 를 쓰지 않는다 — 컴파일이 죽으면 그 줄이 «아예 안 나오고»,
 *    그러면 「0건」과 「못 셌음」이 같은 값이 된다. XML 은 파일이 없으면 «없다»고 분명히 말한다.
 */
export function tallyJunitXml(files: readonly { readonly path: string; readonly xml: string }[]): AndroidTestTally {
  let ran = 0, failed = 0, skipped = 0;
  const failedTestIdentifiers: string[] = [];
  const passedTestIdentifiers: string[] = [];
  for (const { xml } of files) {
    for (const { tag: openingTag, end: openingTagEnd } of testcaseOpeningTags(xml)) {
      ran += 1;
      const identifier = failedTestIdentifier(openingTag);
      if (openingTag.endsWith('/>')) {
        passedTestIdentifiers.push(identifier);
        continue;
      }
      const rest = xml.slice(openingTagEnd);
      const end = rest.indexOf('</testcase>');
      const body = end >= 0 ? rest.slice(0, end) : '';
      if (/<(failure|error)\b/.test(body)) {
        failed += 1;
        failedTestIdentifiers.push(identifier);
      } else if (/<skipped\b/.test(body)) {
        skipped += 1;
      } else {
        passedTestIdentifiers.push(identifier);
      }
    }
  }
  return { ran, failed, skipped, failedTestIdentifiers, passedTestIdentifiers };
}

/** 산출에서 「잴 수 없었다」를 가려낸다 — ⛔ 이것을 실패와 «같은 칸»에 두지 않는다. */
export function classifyUnmeasurable(output: string): string | null {
  if (output.includes('UnsupportedClassVersionError')) {
    return 'JDK 판이 모자라 시험이 «돌지 못했다» — 의존성이 더 높은 class file 판을 요구한다.\n'
      + '   조치: JDK 21 이상을 설치하고 JAVA_HOME 을 그것으로 두십시오 (macOS: brew install --cask temurin@21).';
  }
  if (/Could not (find|resolve) .*(gradle|Gradle)/.test(output) || output.includes('gradlew: No such file')) {
    return 'Gradle 래퍼를 찾지 못해 시험이 «돌지 못했다».';
  }
  return null;
}

export type AndroidGateIo = {
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly log?: (line: string) => void;
  readonly error?: (line: string) => void;
  /** 툴체인 판정 심 — 기본은 bun 시험의 skip 관문과 «같은» `androidToolchainMissing()`. 다 있으면 null. */
  readonly toolchainMissing?: () => string | null;
  /** 시험 실행 심 — 시험에서 주입한다. */
  readonly runGradle?: (androidDir: string) => { readonly status: number | null; readonly output: string };
  /** 결과 XML 읽기 심. */
  readonly readResults?: (androidDir: string) => { readonly path: string; readonly xml: string }[];
  /** 소스 파일 목록 심 — 순수 필터 `androidKotlinSourcesetTestTsFiles` 의 입력. */
  readonly listSourceFiles?: (androidDir: string) => string[];
  /** 알려진 실패 식별자 baseline 심. 환경 변수·기본 파일이 없으면 비교 불가(undefined)다. */
  readonly loadFailedTestBaseline?: () => readonly string[] | undefined;
  /** baseline 비교의 실제 출처를 산출에 남기는 심. */
  readonly failedTestBaselineSource?: () => string;
  /** baseline 갱신을 위한 명시적 쓰기 심. */
  readonly writeFailedTestBaseline?: (path: string, identifiers: readonly string[]) => void;
};

export const DEFAULT_FAILED_TEST_BASELINE_PATH = 'apps/android/failed-test-baseline.txt';

export function defaultFailedTestBaselineSource(): string {
  if (process.env.ANDROID_FAILED_TEST_BASELINE !== undefined) return 'ANDROID_FAILED_TEST_BASELINE';
  return process.env.ANDROID_FAILED_TEST_BASELINE_FILE ?? join(ROOT, DEFAULT_FAILED_TEST_BASELINE_PATH);
}

export function defaultFailedTestBaseline(): readonly string[] | undefined {
  const baseline = process.env.ANDROID_FAILED_TEST_BASELINE;
  if (baseline !== undefined) return baseline.split(/\r?\n/).map((identifier) => identifier.trim()).filter(Boolean);
  return loadFailedTestBaselineFile(defaultFailedTestBaselineSource());
}

export type BaselineUpdateRequest = { readonly path: string };

/** `--update-failed-test-baseline [path]` 요청을 읽고, 없으면 null을 돌려준다. */
export function parseBaselineUpdateRequest(args: readonly string[]): BaselineUpdateRequest | null {
  const at = args.indexOf('--update-failed-test-baseline');
  if (at < 0) return null;
  const candidate = args[at + 1];
  return { path: candidate && !candidate.startsWith('--') ? candidate : DEFAULT_FAILED_TEST_BASELINE_PATH };
}

/**
 * ⭐ 형제 게이트(`ci-isolation-hardcode-gate`)와 «같은 관례»로 읽는다 — 공백 구분이다.
 *    `runAdditionalGate` 가 `['--changed-files', ...files]` 로 «각각» 넘기기 때문이고,
 *    ⛔ 콤마 하나만 기대하면 «첫 파일만» 보고 나머지를 조용히 버린다.
 *    ⊕ 사람이 손으로 칠 때를 위해 콤마도 받는다(한 칸 안에 콤마가 있으면 쪼갠다).
 */
export function parseChangedFiles(args: readonly string[]): string[] | null {
  const at = args.indexOf('--changed-files');
  if (at < 0) return null;
  const files: string[] = [];
  for (const arg of args.slice(at + 1)) {
    if (arg.startsWith('--')) break;
    for (const part of arg.split(',')) {
      const t = part.trim();
      if (t) files.push(t);
    }
  }
  return files;
}

/**
 * ⛔⭐⭐ **재발명하지 않는다 — `scripts/run-android-unit-tests.ts` 가 «이미 있다».**
 *
 * 🩸 이 게이트의 첫 판은 `./gradlew :app:testDebugUnitTest` 를 «직접» 불렀다. 그러면 이 게이트가
 *    ***기존 러너보다 약해진다*** — 그 러너는 debug ⊕ release **두 변형**을 돌리고,
 *    `Assume.assumeFalse(BuildConfig.DEBUG)` 로 게이트된 **릴리스 보안 시험이 «실제로 돌았는지»**까지
 *    이름별로 판정한다(`android-unit-test-evidence.sh`). debug 만 돌리면 그 시험은
 *    ***조용히 건너뛰고도 초록***이다 — `#15878` 이 그것을 잡으려고 만든 장치다.
 *
 * 🔑 ⇒ 그래서 이 게이트가 «새로 하는 일»은 **실행이 아니라 «문»이다**:
 *      기존 러너를 부르고, 그 결과를 ***「몇 개가 돌았나」로 판정***해 self gate·pr land 에 물린다.
 *      (그 러너는 `package.json` 의 `test:android` 에서만 불렸다 — 즉 «사람이 칠 때만» 돌았다.)
 */
/**
 * ⭐ **JDK 21 이상을 «스스로» 찾는다** — ⛔ 사람이 매번 `JAVA_HOME` 을 앞에 붙여야 하는 관문은
 *    결국 «꺼진다». 실측(2026-09-07): `pr land` 가 `JAVA_HOME` 없이 도는 바람에 JDK 17 을 잡아
 *    이 게이트가 «자기 착지»를 「측정 불가」로 막았다 — 판정은 옳았고, 불편이 근본이었다.
 * ⚠️ 못 찾으면 «조용히 넘어가지 않는다» — 그대로 돌려서 `classifyUnmeasurable` 이 말하게 둔다.
 *    (여기서 지어낸 값을 넣으면 「왜 안 되는지」가 사라진다.)
 */
export function resolveJdk21Home(
  probe: (v: string) => string | null = (v) => {
    const r = spawnSync('/usr/libexec/java_home', ['-v', v], { encoding: 'utf8' });
    return r.status === 0 ? (r.stdout ?? '').trim() || null : null;
  },
  versions: readonly string[] = ['21', '22', '23', '24', '25'],
): string | null {
  for (const v of versions) {
    const home = probe(v);
    if (home) return home;
  }
  return null;
}

function defaultRunGradle(androidDir: string) {
  const repoRoot = join(androidDir, '..', '..');
  const jdk = resolveJdk21Home();
  const env = jdk ? { ...process.env, JAVA_HOME: jdk } : process.env;
  const r = spawnSync('bun', ['run', join('scripts', 'run-android-unit-tests.ts')], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env,
  });
  return { status: r.status, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

function defaultReadResults(androidDir: string) {
  const dir = join(androidDir, 'app', 'build', 'test-results');
  if (!existsSync(dir)) return [];
  const out: { path: string; xml: string }[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.xml')) out.push({ path: p, xml: readFileSync(p, 'utf8') });
    }
  };
  walk(dir);
  return out;
}

const SKIP_WALK_DIRS = new Set(['build', '.gradle', 'node_modules']);

/** 게이트가 순수 필터에 넘길 파일 목록 — 빌드 산출은 건너뛴다. */
function defaultListSourceFiles(androidDir: string): string[] {
  if (!existsSync(androidDir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_WALK_DIRS.has(e.name)) continue;
        walk(join(d, e.name));
      } else {
        out.push(join(d, e.name));
      }
    }
  };
  walk(androidDir);
  return out;
}

export function runAndroidUnitTestGate(io: AndroidGateIo = {}): number {
  const args = io.args ?? process.argv.slice(2);
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const root = io.cwd ?? ROOT;
  const changed = parseChangedFiles(args);
  const baselineUpdate = parseBaselineUpdateRequest(args);

  if (changed !== null) {
    const hits = androidFilesIn(changed);
    if (hits.length === 0) {
      // ⭐ 「해당 없음」을 «말한다» — 조용한 통과는 오늘 우리가 당한 그것이다.
      log(`[android-gate] 해당 없음 — 변경 ${changed.length}개 중 ${ANDROID_PREFIX} 아래 파일 0개.`);
      return 0;
    }
    // ⭐ R5a(0.2.31 · OP #8961): 바뀐 안드로이드 파일이 «전부» bun 시험(.test.ts)이고 이 호스트에 툴체인이 없으면
    //    Gradle 축은 «측정 대상 아님»이다 — 그 파일들은 Kotlin 컴파일러가 안 읽어 Gradle 결과를 못 바꾸고,
    //    그 자체는 bun 러너가 잰다(툴체인이 없으면 시험이 «전제 없음» 이유를 찍고 skip).
    //    ⛔ 「Gradle 통과」로 말하지 않는다. Kotlin·Gradle 설정이 하나라도 바뀌었으면 아래 기존 판정(0 = 실패) 그대로다.
    //    면제는 «Kotlin 소스셋 안»의 bun 시험만이다(`androidKotlinSourcesetTestTsFiles` · r2 리뷰) — 그 밖의 .test.ts 는 기존 판정.
    if (androidKotlinSourcesetTestTsFiles(hits).length === hits.length) {
      const missing = (io.toolchainMissing ?? androidToolchainMissing)();
      if (missing) {
        log(`[android-gate] 측정 대상 아님 — 이 호스트에 안드로이드 툴체인이 없다: ${missing}`);
        log(`   바뀐 안드로이드 파일 ${hits.length}개가 전부 bun 시험(.test.ts)이라 Gradle 결과를 바꾸지 못한다 — 그 시험은 bun 러너가 잰다. ⛔ 「Gradle 통과」가 아니라 「Gradle 안 잼」이다.`);
        return 0;
      }
    }
    log(`[android-gate] 대상 ${hits.length}개 (변경 ${changed.length}개 중) — 시험을 돌린다.`);
  }

  const androidDir = join(root, 'apps', 'android');
  if (!existsSync(join(androidDir, 'gradlew'))) {
    error(`[android-gate] FAIL — ${androidDir}/gradlew 가 없다. 「없어서 통과」로 두지 않는다.`);
    return 1;
  }

  const run = (io.runGradle ?? defaultRunGradle)(androidDir);
  const unmeasurable = classifyUnmeasurable(run.output);
  if (unmeasurable) {
    // ⛔ 「잴 수 없었다」는 「통과」가 아니다 — 오늘의 교훈 그 자체다.
    error(`[android-gate] ⛔ 측정 불가 — ${unmeasurable}`);
    return 1;
  }

  const tally = tallyJunitXml((io.readResults ?? defaultReadResults)(androidDir));

  if (tally.ran === 0) {
    // 🔑 이 분기가 이 게이트의 «존재 이유»다.
    error('[android-gate] ⛔ FAIL — 돈 시험이 «0개»다. ⛔ 0 은 통과가 아니다.');
    error('   대개 원인은 «컴파일 실패»다 — 아래 컴파일러 줄을 읽어라:');
    for (const line of run.output.split('\n').filter((l) => l.startsWith('e: '))) error(`   ${line}`);
    return 1;
  }

  if (baselineUpdate) {
    const path = resolve(root, baselineUpdate.path);
    (io.writeFailedTestBaseline ?? writeFailedTestBaseline)(path, tally.failedTestIdentifiers);
    log(`[android-gate] baseline 갱신 — 실패 식별자 ${new Set(tally.failedTestIdentifiers).size}개를 ${baselineUpdate.path}에 썼다.`);
  }

  const usesDefaultBaselineLoader = io.loadFailedTestBaseline === undefined;
  const baseline = (io.loadFailedTestBaseline ?? defaultFailedTestBaseline)();
  const failedTests = new Set(tally.failedTestIdentifiers);
  const resolvedFailures = baseline === undefined
    ? []
    : [...new Set(baseline.filter((identifier) => (
      tally.passedTestIdentifiers.includes(identifier) && !failedTests.has(identifier)
    )))].sort();

  if (resolvedFailures.length > 0) {
    log(`[android-gate] baseline에 있었지만 이제 통과한 시험 ${resolvedFailures.length}개:`);
    for (const identifier of resolvedFailures) log(`   ${identifier}`);
  }

  if (tally.failed > 0) {
    const failureSummary = `[android-gate] FAIL — testcase ${tally.ran}개 중 ${tally.failed}개 실패 (건너뜀 ${tally.skipped}).`;
    if (baseline === undefined) {
      const source = io.failedTestBaselineSource?.()
        ?? (usesDefaultBaselineLoader ? defaultFailedTestBaselineSource() : '출처 미상');
      error(failureSummary);
      error(`[android-gate] baseline 비교 불가 — baseline을 읽지 못했다: ${source}`);
      return 1;
    }
    const newFailures = compareFailedTestIdentifiers(tally.failedTestIdentifiers, baseline);
    if (newFailures.length > 0) {
      error(failureSummary);
      error(`[android-gate] baseline에 없던 실패 ${newFailures.length}개:`);
      for (const identifier of newFailures) error(`   ${identifier}`);
      return 1;
    }
    log(`[android-gate] PASS — testcase ${tally.ran}개 중 선행 실패 ${tally.failed}개 (건너뜀 ${tally.skipped}); baseline에 없던 실패 0개.`);
    return 0;
  }

  log(`[android-gate] PASS — testcase ${tally.ran}개 돌았고 실패 0 (건너뜀 ${tally.skipped}).`);
  // ⭐ 막지 않고 말한다 — Kotlin 소스셋 안의 `.test.ts` 는 존재만으로 실패가 아니다.
  const listed = (io.listSourceFiles ?? defaultListSourceFiles)(androidDir);
  const tsHits = androidKotlinSourcesetTestTsFiles(listed);
  log(`[android-gate] 안드로이드 소스셋 안에 .test.ts ${tsHits.length}개`);
  for (const p of tsHits) log(`   ${displayAndroidPath(p)}`);
  if (run.status !== 0) {
    // 시험은 다 통과했는데 러너가 죽었다 = 시험 «밖»의 문제다. 삼키지 않는다.
    // ⛔ 「무언가 실패했다」로만 끝내면 «고칠 수가 없다» — 실제로 그렇게 만들었다가 한 번 막혔다.
    //    ⇒ 컴파일러 줄과 산출 꼬리를 «보여 준다». 대표적 원인: 릴리스 변형 컴파일 실패
    //      (debug 전용 심볼을 `src/test/` 에서 쓰면 릴리스가 죽는다 — `src/testDebug/` 로 옮겨라).
    error(`[android-gate] ⚠️ testcase 는 다 통과했는데 러너 종료 코드가 ${run.status} 다 — 시험 «밖»에서 실패했다.`);
    const compileErrors = run.output.split('\n').filter((l) => l.startsWith('e: '));
    if (compileErrors.length > 0) {
      error(`   컴파일 오류 ${compileErrors.length}줄 (앞 10줄):`);
      for (const line of compileErrors.slice(0, 10)) error(`   ${line}`);
    } else {
      error('   산출 꼬리 20줄:');
      for (const line of run.output.trimEnd().split('\n').slice(-20)) error(`   ${line}`);
    }
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exit(runAndroidUnitTestGate());
