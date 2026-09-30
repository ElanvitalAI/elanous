import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  androidFilesIn,
  androidKotlinSourcesetTestTsFiles,
  classifyUnmeasurable,
  compareFailedTestIdentifiers,
  DEFAULT_FAILED_TEST_BASELINE_PATH,
  defaultFailedTestBaseline,
  defaultFailedTestBaselineSource,
  loadFailedTestBaselineFile,
  parseBaselineUpdateRequest,
  resolveJdk21Home,
  runAndroidUnitTestGate,
  serializeFailedTestBaseline,
  tallyJunitXml,
  parseChangedFiles,
  writeFailedTestBaseline,
} from './ci-android-unit-tests.js';

/** gradlew 가 «있는» 가짜 저장소 — 게이트가 「없어서 통과」로 새지 않는지 가르기 위해. */
function rootWithGradlew(): string {
  const root = mkdtempSync(join(tmpdir(), 'android-gate-'));
  mkdirSync(join(root, 'apps', 'android'), { recursive: true });
  writeFileSync(join(root, 'apps', 'android', 'gradlew'), '#!/bin/sh\n');
  return root;
}

function capture() {
  const out: string[] = [], err: string[] = [];
  return { out, err, log: (l: string) => out.push(l), error: (l: string) => err.push(l) };
}

describe('androidFilesIn', () => {
  test('apps/android 아래 Kotlin·Gradle 변경만 게이트를 깨운다', () => {
    expect(androidFilesIn([
      'apps/android/app/src/main/kotlin/A.kt',
      'apps/android/gradle/libs.versions.toml',
      'src/cli/pr-cli.ts',
      'docs/x.md',
    ])).toEqual(['apps/android/app/src/main/kotlin/A.kt', 'apps/android/gradle/libs.versions.toml']);
  });

  test('⭐ apps/android 아래 .test.ts 도 깨운다 — 그것이 Kotlin 계약을 문면으로 잰다', () => {
    expect(androidFilesIn(['apps/android/app/src/test/kotlin/x/ChatAttachPolicy.test.ts']))
      .toHaveLength(1);
  });

  test('apps/android 밖의 .kt 는 이 게이트 소관이 아니다', () => {
    expect(androidFilesIn(['tools/other/A.kt'])).toEqual([]);
  });
});

describe('androidKotlinSourcesetTestTsFiles — Kotlin 소스셋 안의 .test.ts 만', () => {
  const attach = 'apps/android/app/src/test/kotlin/x/ChatAttachPolicy.test.ts';
  const bubble = 'apps/android/app/src/test/kotlin/x/ChatHarnessBubble.test.ts';

  test('일치 경로를 남긴다', () => {
    expect(androidKotlinSourcesetTestTsFiles([attach, bubble])).toEqual([attach, bubble]);
  });

  test('불일치 경로는 버린다 — 소스셋 밖 · 확장자 다름 · 안드로이드 밖', () => {
    expect(androidKotlinSourcesetTestTsFiles([
      'apps/android/app/src/test/kotlin/x/ChatAttachPolicy.kt',
      'apps/android/scripts/foo.test.ts',
      'scripts/ci-android-unit-tests.test.ts',
      'apps/android/app/src/main/kotlin/A.kt',
    ])).toEqual([]);
  });

  test('하나도 없으면 길이 0 이다', () => {
    expect(androidKotlinSourcesetTestTsFiles([])).toHaveLength(0);
    expect(androidKotlinSourcesetTestTsFiles(['src/a.ts', 'docs/b.md'])).toHaveLength(0);
  });
});

describe('tallyJunitXml — 실제로 «돈» 수를 센다', () => {
  test('자기닫힘·본문 있는 testcase 를 모두 세고 실패·건너뜀을 가른다', () => {
    const xml = `<testsuite>
      <testcase name="a"/>
      <testcase name="b"><failure message="x"/></testcase>
      <testcase name="c"><skipped/></testcase>
      <testcase name="d"><error message="y"/></testcase>
    </testsuite>`;
    expect(tallyJunitXml([{ path: 'p', xml }])).toEqual({
      ran: 4,
      failed: 2,
      skipped: 1,
      failedTestIdentifiers: ['<missing-classname>#b', '<missing-classname>#d'],
      passedTestIdentifiers: ['<missing-classname>#a'],
    });
  });

  test('XML 이 «없으면» ran=0 이다 — 「못 셌음」이 0 으로 «분명히» 나온다', () => {
    expect(tallyJunitXml([])).toEqual({
      ran: 0, failed: 0, skipped: 0, failedTestIdentifiers: [], passedTestIdentifiers: [],
    });
  });

  test('실패 testcase 전체를 classname과 name으로 안정 식별한다 — 누락 속성도 버리지 않는다', () => {
    const xml = `<testsuite>
      <testcase name="passes" classname="example.WidgetTest"/>
      <testcase classname='example.WidgetTest' name='fails'><failure/></testcase>
      <testcase name="errors" classname="example.OtherTest"><error/></testcase>
      <testcase name="missing-classname"><failure/></testcase>
    </testsuite>`;
    expect(tallyJunitXml([{ path: 'p', xml }])).toEqual({
      ran: 4,
      failed: 3,
      skipped: 0,
      failedTestIdentifiers: ['example.WidgetTest#fails', 'example.OtherTest#errors', '<missing-classname>#missing-classname'],
      passedTestIdentifiers: ['example.WidgetTest#passes'],
    });
  });

  test('XML 속성 엔티티의 명명·십진·16진 표현을 같은 식별자로 디코딩한다', () => {
    const named = '<testsuite><testcase classname="example.A&amp;B" name="fails&lt;now"><failure/></testcase></testsuite>';
    const decimal = '<testsuite><testcase classname="example.A&#38;B" name="fails&#60;now"><failure/></testcase></testsuite>';
    const hexadecimal = '<testsuite><testcase classname="example.A&#x26;B" name="fails&#x3c;now"><failure/></testcase></testsuite>';
    const expected = ['example.A&B#fails<now'];
    expect(tallyJunitXml([{ path: 'named', xml: named }]).failedTestIdentifiers).toEqual(expected);
    expect(tallyJunitXml([{ path: 'decimal', xml: decimal }]).failedTestIdentifiers).toEqual(expected);
    expect(tallyJunitXml([{ path: 'hexadecimal', xml: hexadecimal }]).failedTestIdentifiers).toEqual(expected);
  });

  test('XML 속성은 한 번만 디코딩해 실제 텍스트의 엔티티 표기를 보존한다', () => {
    const xml = '<testsuite><testcase classname="example.A&amp;amp;B" name="fails"><failure/></testcase></testsuite>';
    expect(tallyJunitXml([{ path: 'p', xml }]).failedTestIdentifiers).toEqual(['example.A&amp;B#fails']);
  });

  test('따옴표 안의 > 및 다른 속성값 속 fake name을 실제 classname/name으로 파싱한다', () => {
    const xml = `<testsuite>
      <testcase detail="contains name='fake'" classname="example.Greater&gt;Test" name="a>b"><failure/></testcase>
      <testcase detail='contains name="fake"' name='single>quoted' classname='example.Single'><error/></testcase>
    </testsuite>`;
    expect(tallyJunitXml([{ path: 'p', xml }]).failedTestIdentifiers).toEqual([
      'example.Greater>Test#a>b',
      'example.Single#single>quoted',
    ]);
  });
});

describe('defaultFailedTestBaseline', () => {
  test('환경 변수 미설정은 빈 baseline이 아니라 비교 불가(undefined)다', () => {
    const saved = process.env.ANDROID_FAILED_TEST_BASELINE;
    const savedFile = process.env.ANDROID_FAILED_TEST_BASELINE_FILE;
    try {
      delete process.env.ANDROID_FAILED_TEST_BASELINE;
      process.env.ANDROID_FAILED_TEST_BASELINE_FILE = '/tmp/elanous-missing-android-baseline.txt';
      expect(defaultFailedTestBaseline()).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.ANDROID_FAILED_TEST_BASELINE;
      else process.env.ANDROID_FAILED_TEST_BASELINE = saved;
      if (savedFile === undefined) delete process.env.ANDROID_FAILED_TEST_BASELINE_FILE;
      else process.env.ANDROID_FAILED_TEST_BASELINE_FILE = savedFile;
    }
  });

  test('명시적 빈 환경 변수는 알려진 빈 baseline이다', () => {
    const saved = process.env.ANDROID_FAILED_TEST_BASELINE;
    try {
      process.env.ANDROID_FAILED_TEST_BASELINE = '';
      expect(defaultFailedTestBaseline()).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.ANDROID_FAILED_TEST_BASELINE;
      else process.env.ANDROID_FAILED_TEST_BASELINE = saved;
    }
  });

  test('비어 있지 않은 환경 변수는 줄 단위 식별자를 읽는다', () => {
    const saved = process.env.ANDROID_FAILED_TEST_BASELINE;
    try {
      process.env.ANDROID_FAILED_TEST_BASELINE = 'example.Known#first\n example.Known#second ';
      expect(defaultFailedTestBaseline()).toEqual(['example.Known#first', 'example.Known#second']);
    } finally {
      if (saved === undefined) delete process.env.ANDROID_FAILED_TEST_BASELINE;
      else process.env.ANDROID_FAILED_TEST_BASELINE = saved;
    }
  });

  test('비교 불가 산출은 baseline 출처를 환경값 우선으로 재현 가능하게 말한다', () => {
    const savedInline = process.env.ANDROID_FAILED_TEST_BASELINE;
    const savedFile = process.env.ANDROID_FAILED_TEST_BASELINE_FILE;
    try {
      process.env.ANDROID_FAILED_TEST_BASELINE = 'example.Known#old';
      process.env.ANDROID_FAILED_TEST_BASELINE_FILE = '/ignored/baseline.txt';
      expect(defaultFailedTestBaselineSource()).toBe('ANDROID_FAILED_TEST_BASELINE');
      delete process.env.ANDROID_FAILED_TEST_BASELINE;
      expect(defaultFailedTestBaselineSource()).toBe('/ignored/baseline.txt');
    } finally {
      if (savedInline === undefined) delete process.env.ANDROID_FAILED_TEST_BASELINE;
      else process.env.ANDROID_FAILED_TEST_BASELINE = savedInline;
      if (savedFile === undefined) delete process.env.ANDROID_FAILED_TEST_BASELINE_FILE;
      else process.env.ANDROID_FAILED_TEST_BASELINE_FILE = savedFile;
    }
  });
});

describe('file baseline helpers', () => {
  test('결정적으로 정렬·중복 제거한 trailing-newline 형식으로 직렬화한다', () => {
    expect(serializeFailedTestBaseline([' z#two ', 'a#one', 'z#two', ''])).toBe('a#one\nz#two\n');
    expect(serializeFailedTestBaseline([])).toBe('');
  });

  test('명시적 쓰기와 로드는 같은 안정 목록을 왕복하고 없는 파일은 비교 불가다', () => {
    const root = mkdtempSync(join(tmpdir(), 'android-baseline-'));
    const path = join(root, 'baseline.txt');
    expect(loadFailedTestBaselineFile(path)).toBeUndefined();
    writeFailedTestBaseline(path, ['z#two', 'a#one', 'z#two']);
    expect(readFileSync(path, 'utf8')).toBe('a#one\nz#two\n');
    expect(loadFailedTestBaselineFile(path)).toEqual(['a#one', 'z#two']);
  });
});

describe('compareFailedTestIdentifiers', () => {
  test('baseline에 없던 실패만 정렬·중복 제거해 반환한다', () => {
    expect(compareFailedTestIdentifiers(
      ['example.NewTest#breaks', 'example.KnownTest#stillBroken', 'example.NewTest#breaks'],
      ['example.KnownTest#stillBroken'],
    )).toEqual(['example.NewTest#breaks']);
  });

  test('현재 실패가 모두 baseline에 있으면 빈 배열이다', () => {
    expect(compareFailedTestIdentifiers(['example.KnownTest#stillBroken'], ['example.KnownTest#stillBroken']))
      .toEqual([]);
  });
});

describe('classifyUnmeasurable', () => {
  test('JDK 판 부족을 「측정 불가」로 이름 붙이고 «설치 명령»을 준다', () => {
    const r = classifyUnmeasurable('java.lang.UnsupportedClassVersionError: com/x has been compiled by');
    expect(r).toContain('JDK 21');
    expect(r).toContain('temurin@21');
  });

  test('평범한 단언 실패는 «측정 불가가 아니다» — 그건 진짜 빨강이다', () => {
    expect(classifyUnmeasurable('java.lang.AssertionError: Assert failed')).toBeNull();
  });
});

describe('runAndroidUnitTestGate', () => {
  test('⛔ 돈 시험이 0개면 «통과가 아니다» — 이 게이트의 존재 이유', () => {
    const c = capture();
    const code = runAndroidUnitTestGate({
      args: [], cwd: rootWithGradlew(), log: c.log, error: c.error,
      runGradle: () => ({ status: 1, output: "e: file:///A.kt:1:1 Unresolved reference 'ATTACH_BUTTON'.\n" }),
      readResults: () => [],
    });
    expect(code).toBe(1);
    expect(c.err.join('\n')).toContain('돈 시험이 «0개»');
    // ⭐ 컴파일러 줄을 «그대로» 보여 줘야 고칠 수 있다
    expect(c.err.join('\n')).toContain("Unresolved reference 'ATTACH_BUTTON'");
  });

  test('⛔ 「측정 불가」를 «통과로 접지 않는다»', () => {
    const c = capture();
    const code = runAndroidUnitTestGate({
      args: [], cwd: rootWithGradlew(), log: c.log, error: c.error,
      runGradle: () => ({ status: 1, output: 'java.lang.UnsupportedClassVersionError: x' }),
      readResults: () => [{ path: 'p', xml: '<testsuite><testcase name="a"/></testsuite>' }],
    });
    expect(code).toBe(1);
    expect(c.err.join('\n')).toContain('측정 불가');
  });

  test('시험이 돌고 전부 통과하면 «몇 개 돌았는지»를 말하고 0 을 낸다', () => {
    const c = capture();
    const code = runAndroidUnitTestGate({
      args: [], cwd: rootWithGradlew(), log: c.log, error: c.error,
      runGradle: () => ({ status: 0, output: 'BUILD SUCCESSFUL' }),
      readResults: () => [{ path: 'p', xml: '<testsuite><testcase name="a"/><testcase name="b"/></testsuite>' }],
    });
    expect(code).toBe(0);
    expect(c.out.join('\n')).toContain('testcase 2개');
  });

  test('⭐ Kotlin 소스셋 안의 .test.ts 가 있으면 개수와 경로를 말하고 종료 코드는 그대로 0', () => {
    const c = capture();
    const attach = 'apps/android/app/src/test/kotlin/x/ChatAttachPolicy.test.ts';
    const bubble = 'apps/android/app/src/test/kotlin/x/ChatHarnessBubble.test.ts';
    const code = runAndroidUnitTestGate({
      args: [], cwd: rootWithGradlew(), log: c.log, error: c.error,
      runGradle: () => ({ status: 0, output: 'BUILD SUCCESSFUL' }),
      readResults: () => [{ path: 'p', xml: '<testsuite><testcase name="a"/><testcase name="b"/></testsuite>' }],
      listSourceFiles: () => [attach, bubble, 'apps/android/app/src/main/kotlin/A.kt'],
    });
    expect(code).toBe(0);
    const said = c.out.join('\n');
    expect(said).toContain('testcase 2개 돌았고 실패 0');
    expect(said).toContain('.test.ts 2개');
    expect(said).toContain(attach);
    expect(said).toContain(bubble);
  });

  test('⭐ .test.ts 가 0개여도 그 줄을 «0개»로 말하고 종료 코드는 그대로 0', () => {
    const c = capture();
    const code = runAndroidUnitTestGate({
      args: [], cwd: rootWithGradlew(), log: c.log, error: c.error,
      runGradle: () => ({ status: 0, output: 'BUILD SUCCESSFUL' }),
      readResults: () => [{ path: 'p', xml: '<testsuite><testcase name="a"/></testsuite>' }],
      listSourceFiles: () => ['apps/android/app/src/main/kotlin/A.kt'],
    });
    expect(code).toBe(0);
    expect(c.out.join('\n')).toContain('.test.ts 0개');
  });

  test('⛔ .test.ts 존재만으로 실패하지 않는다 — 실패 판정은 기존 규칙', () => {
    const c = capture();
    const code = runAndroidUnitTestGate({
      args: [], cwd: rootWithGradlew(), log: c.log, error: c.error,
      runGradle: () => ({ status: 1, output: 'BUILD FAILED' }),
      readResults: () => [{ path: 'p', xml: '<testsuite><testcase name="a"><failure message="m"/></testcase></testsuite>' }],
      listSourceFiles: () => ['apps/android/app/src/test/kotlin/x/ChatAttachPolicy.test.ts'],
    });
    expect(code).toBe(1);
    expect(c.err.join('\n')).toContain('1개 실패');
    expect(c.out.join('\n')).not.toContain('.test.ts');
  });

  test('디스크 소스셋에 .test.ts 가 있으면 기본 목록기가 경로를 산출에 낸다', () => {
    const root = rootWithGradlew();
    const rel = 'apps/android/app/src/test/kotlin/com/x/ChatAttachPolicy.test.ts';
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), 'export {}\n');
    const c = capture();
    const code = runAndroidUnitTestGate({
      args: [], cwd: root, log: c.log, error: c.error,
      runGradle: () => ({ status: 0, output: 'BUILD SUCCESSFUL' }),
      readResults: () => [{ path: 'p', xml: '<testsuite><testcase name="a"/></testsuite>' }],
    });
    expect(code).toBe(0);
    const said = c.out.join('\n');
    expect(said).toContain('[android-gate] PASS — testcase 1개 돌았고 실패 0 (건너뜀 0).');
    expect(said).toContain('.test.ts 1개');
    expect(said).toContain(rel);
  });

  test('업데이트 요청은 parsed JUnit의 전체 실패 목록을 결정적 baseline writer에 넘긴다', () => {
    const c = capture();
    const root = rootWithGradlew();
    let written: { path: string; identifiers: readonly string[] } | undefined;
    const code = runAndroidUnitTestGate({
      args: ['--update-failed-test-baseline', 'tmp/android-baseline.txt'], cwd: root, log: c.log, error: c.error,
      runGradle: () => ({ status: 1, output: 'BUILD FAILED' }),
      readResults: () => [{ path: 'p', xml: '<testsuite><testcase classname="z.Test" name="two"><failure/></testcase><testcase name="missing"><error/></testcase></testsuite>' }],
      writeFailedTestBaseline: (path, identifiers) => { written = { path, identifiers }; },
    });
    expect(code).toBe(1);
    expect(written).toEqual({
      path: resolve(root, 'tmp/android-baseline.txt'),
      identifiers: ['z.Test#two', '<missing-classname>#missing'],
    });
    expect(c.out.join('\n')).toContain('baseline 갱신 — 실패 식별자 2개');
  });

  test('0개 실행이면 업데이트 요청이 기존 baseline 파일을 바이트 단위로 보존한다', () => {
    const c = capture();
    const root = rootWithGradlew();
    const baseline = join(root, 'tmp', 'android-baseline.txt');
    mkdirSync(join(root, 'tmp'), { recursive: true });
    writeFileSync(baseline, 'known.Test#existing\n');

    const code = runAndroidUnitTestGate({
      args: ['--update-failed-test-baseline', 'tmp/android-baseline.txt'], cwd: root, log: c.log, error: c.error,
      runGradle: () => ({ status: 1, output: 'BUILD FAILED before tests' }),
      readResults: () => [],
    });

    expect(code).toBe(1);
    expect(readFileSync(baseline, 'utf8')).toBe('known.Test#existing\n');
    expect(c.out.join('\n')).not.toContain('baseline 갱신');
  });

  test('업데이트 요청의 상대 경로는 root 기준, 절대 경로는 지정 위치에 baseline을 쓴다', () => {
    const root = rootWithGradlew();
    const relative = 'tmp/relative-baseline.txt';
    const absoluteRoot = mkdtempSync(join(tmpdir(), 'android-baseline-absolute-'));
    const absolute = join(absoluteRoot, 'baseline.txt');
    mkdirSync(join(root, 'tmp'), { recursive: true });
    const results = () => [{
      path: 'p',
      xml: '<testsuite><testcase classname="z.Test" name="two"><failure/></testcase><testcase classname="a.Test" name="one"><error/></testcase></testsuite>',
    }];

    const relativeCode = runAndroidUnitTestGate({
      args: ['--update-failed-test-baseline', relative], cwd: root, log: () => {}, error: () => {},
      runGradle: () => ({ status: 1, output: 'BUILD FAILED' }), readResults: results,
    });
    const absoluteCode = runAndroidUnitTestGate({
      args: ['--update-failed-test-baseline', absolute], cwd: root, log: () => {}, error: () => {},
      runGradle: () => ({ status: 1, output: 'BUILD FAILED' }), readResults: results,
    });

    expect(relativeCode).toBe(1);
    expect(absoluteCode).toBe(1);
    expect(readFileSync(resolve(root, relative), 'utf8')).toBe('a.Test#one\nz.Test#two\n');
    expect(readFileSync(absolute, 'utf8')).toBe('a.Test#one\nz.Test#two\n');
  });

  test('모든 시험이 성공해도 실제로 회복된 baseline 시험을 말하고 통과한다', () => {
    const c = capture();
    const code = runAndroidUnitTestGate({
      args: [], cwd: rootWithGradlew(), log: c.log, error: c.error,
      runGradle: () => ({ status: 0, output: 'BUILD SUCCESSFUL' }),
      readResults: () => [{
        path: 'p',
        xml: '<testsuite><testcase classname="example.Known" name="resolved"/></testsuite>',
      }],
      loadFailedTestBaseline: () => ['example.Known#resolved'],
    });
    expect(code).toBe(0);
    expect(c.out.join('\n')).toContain('이제 통과한 시험 1개');
    expect(c.out.join('\n')).toContain('example.Known#resolved');
  });

  test('회복과 신규 실패가 함께 있으면 회복과 신규 실패 이름을 모두 말하고 막는다', () => {
    const c = capture();
    const code = runAndroidUnitTestGate({
      args: [], cwd: rootWithGradlew(), log: c.log, error: c.error,
      runGradle: () => ({ status: 1, output: 'BUILD FAILED' }),
      readResults: () => [{
        path: 'p',
        xml: '<testsuite><testcase classname="example.Known" name="resolved"/><testcase classname="example.New" name="fresh"><failure/></testcase></testsuite>',
      }],
      loadFailedTestBaseline: () => ['example.Known#resolved'],
    });
    expect(code).toBe(1);
    expect(c.out.join('\n')).toContain('이제 통과한 시험 1개');
    expect(c.out.join('\n')).toContain('example.Known#resolved');
    expect(c.err.join('\n')).toContain('baseline에 없던 실패 1개');
    expect(c.err.join('\n')).toContain('example.New#fresh');
  });

  test('여러 XML에서 같은 baseline 시험의 성공과 실패가 섞이면 회복으로 오보고하지 않는다', () => {
    const c = capture();
    const code = runAndroidUnitTestGate({
      args: [], cwd: rootWithGradlew(), log: c.log, error: c.error,
      runGradle: () => ({ status: 1, output: 'BUILD FAILED' }),
      readResults: () => [
        { path: 'pass.xml', xml: '<testsuite><testcase classname="example.Known" name="mixed"/></testsuite>' },
        { path: 'fail.xml', xml: '<testsuite><testcase classname="example.Known" name="mixed"><failure/></testcase></testsuite>' },
      ],
      loadFailedTestBaseline: () => ['example.Known#mixed'],
    });
    expect(code).toBe(0);
    expect(c.out.join('\n')).not.toContain('이제 통과한 시험');
    expect(c.out.join('\n')).not.toContain('example.Known#mixed');
  });

  test('실패가 모두 baseline 안에 있으면 선행 실패 수를 말하고 통과한다', () => {
    const c = capture();
    const code = runAndroidUnitTestGate({
      args: [], cwd: rootWithGradlew(), log: c.log, error: c.error,
      runGradle: () => ({ status: 1, output: 'BUILD FAILED' }),
      readResults: () => [{
        path: 'p',
        xml: '<testsuite><testcase classname="example.Known" name="first"><failure/></testcase><testcase classname="example.Known" name="second"><error/></testcase></testsuite>',
      }],
      loadFailedTestBaseline: () => ['example.Known#first', 'example.Known#second'],
    });
    expect(code).toBe(0);
    expect(c.out.join('\n')).toContain('선행 실패 2개');
    expect(c.out.join('\n')).toContain('baseline에 없던 실패 0개');
  });

  test('baseline에 있는데 실제로 성공한 시험만 회복으로 알리되 막지 않는다', () => {
    const c = capture();
    const code = runAndroidUnitTestGate({
      args: [], cwd: rootWithGradlew(), log: c.log, error: c.error,
      runGradle: () => ({ status: 1, output: 'BUILD FAILED' }),
      readResults: () => [{
        path: 'p',
        xml: '<testsuite><testcase classname="example.Known" name="resolved"/><testcase classname="example.Known" name="stillBroken"><failure/></testcase></testsuite>',
      }],
      loadFailedTestBaseline: () => ['example.Known#resolved', 'example.Known#stillBroken'],
    });
    expect(code).toBe(0);
    expect(c.out.join('\n')).toContain('이제 통과한 시험 1개');
    expect(c.out.join('\n')).toContain('example.Known#resolved');
  });

  test('누락·skipped baseline 시험은 회복으로 보고하지 않는다', () => {
    const c = capture();
    const code = runAndroidUnitTestGate({
      args: [], cwd: rootWithGradlew(), log: c.log, error: c.error,
      runGradle: () => ({ status: 1, output: 'BUILD FAILED' }),
      readResults: () => [{
        path: 'p',
        xml: '<testsuite><testcase classname="example.Known" name="skipped"><skipped/></testcase><testcase classname="example.Known" name="stillBroken"><failure/></testcase></testsuite>',
      }],
      loadFailedTestBaseline: () => ['example.Known#missing', 'example.Known#skipped', 'example.Known#stillBroken'],
    });
    expect(code).toBe(0);
    expect(c.out.join('\n')).not.toContain('이제 통과한 시험');
    expect(c.out.join('\n')).not.toContain('example.Known#missing');
    expect(c.out.join('\n')).not.toContain('example.Known#skipped');
  });

  test('실패가 있으면 baseline 밖 식별자와 함께 막는다', () => {
    const c = capture();
    const code = runAndroidUnitTestGate({
      args: [], cwd: rootWithGradlew(), log: c.log, error: c.error,
      runGradle: () => ({ status: 1, output: 'BUILD FAILED' }),
      readResults: () => [{
        path: 'p',
        xml: '<testsuite><testcase classname="example.Known" name="old"><failure/></testcase><testcase classname="example.New" name="fresh"><error/></testcase></testsuite>',
      }],
      loadFailedTestBaseline: () => ['example.Known#old'],
    });
    expect(code).toBe(1);
    expect(c.err.join('\n')).toContain('baseline에 없던 실패 1개');
    expect(c.err.join('\n')).toContain('example.New#fresh');
  });

  test('기본 baseline이 미설정이면 신규 실패를 단정하지 않고 비교 불가를 출력한다', () => {
    const saved = process.env.ANDROID_FAILED_TEST_BASELINE;
    const savedFile = process.env.ANDROID_FAILED_TEST_BASELINE_FILE;
    const c = capture();
    try {
      delete process.env.ANDROID_FAILED_TEST_BASELINE;
      process.env.ANDROID_FAILED_TEST_BASELINE_FILE = '/tmp/elanous-missing-android-baseline.txt';
      const code = runAndroidUnitTestGate({
        args: [], cwd: rootWithGradlew(), log: c.log, error: c.error,
        runGradle: () => ({ status: 1, output: 'BUILD FAILED' }),
        readResults: () => [{
          path: 'p', xml: '<testsuite><testcase classname="example.New" name="fresh"><failure/></testcase></testsuite>',
        }],
      });
      expect(code).toBe(1);
      expect(c.err.join('\n')).toContain('baseline 비교 불가');
      expect(c.err.join('\n')).not.toContain('baseline에 없던 실패');
    } finally {
      if (saved === undefined) delete process.env.ANDROID_FAILED_TEST_BASELINE;
      else process.env.ANDROID_FAILED_TEST_BASELINE = saved;
      if (savedFile === undefined) delete process.env.ANDROID_FAILED_TEST_BASELINE_FILE;
      else process.env.ANDROID_FAILED_TEST_BASELINE_FILE = savedFile;
    }
  });

  test('baseline을 읽지 못하면 비교 불가와 실제 baseline 출처를 함께 출력한다', () => {
    const c = capture();
    const code = runAndroidUnitTestGate({
      args: [], cwd: rootWithGradlew(), log: c.log, error: c.error,
      runGradle: () => ({ status: 1, output: 'BUILD FAILED' }),
      readResults: () => [{
        path: 'p', xml: '<testsuite><testcase classname="example.New" name="fresh"><failure/></testcase></testsuite>',
      }],
      loadFailedTestBaseline: () => undefined,
      failedTestBaselineSource: () => 'tmp/android-failed-test-baseline.txt',
    });
    expect(code).toBe(1);
    expect(c.err.join('\n')).toContain('baseline 비교 불가');
    expect(c.err.join('\n')).toContain('tmp/android-failed-test-baseline.txt');
  });

  test('출처 없는 사용자 지정 baseline 로더는 환경변수·기본 경로 대신 출처 미상으로 출력한다', () => {
    const saved = process.env.ANDROID_FAILED_TEST_BASELINE;
    const c = capture();
    try {
      process.env.ANDROID_FAILED_TEST_BASELINE = 'unrelated.Environment#baseline';
      const code = runAndroidUnitTestGate({
        args: [], cwd: rootWithGradlew(), log: c.log, error: c.error,
        runGradle: () => ({ status: 1, output: 'BUILD FAILED' }),
        readResults: () => [{
          path: 'p', xml: '<testsuite><testcase classname="example.New" name="fresh"><failure/></testcase></testsuite>',
        }],
        loadFailedTestBaseline: () => undefined,
      });
      expect(code).toBe(1);
      expect(c.err.join('\n')).toContain('baseline 비교 불가');
      expect(c.err.join('\n')).toContain('출처 미상');
      expect(c.err.join('\n')).not.toContain('ANDROID_FAILED_TEST_BASELINE');
      expect(c.err.join('\n')).not.toContain(DEFAULT_FAILED_TEST_BASELINE_PATH);
    } finally {
      if (saved === undefined) delete process.env.ANDROID_FAILED_TEST_BASELINE;
      else process.env.ANDROID_FAILED_TEST_BASELINE = saved;
    }
  });

  test('명시적 빈 baseline은 모든 식별 가능 실패를 신규 실패로 출력한다', () => {
    const c = capture();
    const code = runAndroidUnitTestGate({
      args: [], cwd: rootWithGradlew(), log: c.log, error: c.error,
      runGradle: () => ({ status: 1, output: 'BUILD FAILED' }),
      readResults: () => [{
        path: 'p', xml: '<testsuite><testcase classname="example.New" name="fresh"><failure/></testcase></testsuite>',
      }],
      loadFailedTestBaseline: () => [],
    });
    expect(code).toBe(1);
    expect(c.err.join('\n')).toContain('baseline에 없던 실패 1개');
    expect(c.err.join('\n')).toContain('example.New#fresh');
  });

  test('실행 게이트가 baseline과 비교해 신규 실패 식별자를 오류 산출에 소비한다', () => {
    const c = capture();
    const code = runAndroidUnitTestGate({
      args: [], cwd: rootWithGradlew(), log: c.log, error: c.error,
      runGradle: () => ({ status: 1, output: 'BUILD FAILED' }),
      readResults: () => [{
        path: 'p',
        xml: '<testsuite><testcase classname="example.Known" name="old"><failure/></testcase><testcase classname="example.New" name="fresh&amp;case"><failure/></testcase></testsuite>',
      }],
      loadFailedTestBaseline: () => ['example.Known#old'],
    });
    expect(code).toBe(1);
    expect(c.err.join('\n')).toContain('baseline에 없던 실패 1개');
    expect(c.err.join('\n')).toContain('example.New#fresh&case');
    expect(c.err.join('\n')).not.toContain('example.Known#old');
  });

  test('⭐ 시험은 다 통과했는데 gradle 이 죽으면 «삼키지 않는다»', () => {
    const c = capture();
    const code = runAndroidUnitTestGate({
      args: [], cwd: rootWithGradlew(), log: c.log, error: c.error,
      runGradle: () => ({ status: 1, output: 'lint failed outside tests' }),
      readResults: () => [{ path: 'p', xml: '<testsuite><testcase name="a"/></testsuite>' }],
    });
    expect(code).toBe(1);
    // ⛔ «문면»이 아니라 «행동»을 잰다 — 이 시험이 문구 한 줄에 깨졌던 자리다.
    //    요구는 「막는다 ⊕ 이유가 되는 산출을 보여 준다」이지 특정 낱말이 아니다.
    expect(c.err.join('\n')).toContain('lint failed outside tests');
  });

  test('안드로이드 변경이 없으면 «해당 없음»을 말하고 gradle 을 부르지 않는다', () => {
    const c = capture();
    let called = 0;
    const code = runAndroidUnitTestGate({
      args: ['--changed-files', 'src/a.ts,docs/b.md'], cwd: rootWithGradlew(), log: c.log, error: c.error,
      runGradle: () => { called += 1; return { status: 0, output: '' }; },
      readResults: () => [],
    });
    expect(code).toBe(0);
    expect(called).toBe(0);
    expect(c.out.join('\n')).toContain('해당 없음');
  });

  test('⛔ gradlew 가 «없으면» 통과가 아니다', () => {
    const c = capture();
    const code = runAndroidUnitTestGate({
      args: [], cwd: mkdtempSync(join(tmpdir(), 'no-gradlew-')), log: c.log, error: c.error,
      runGradle: () => ({ status: 0, output: '' }), readResults: () => [],
    });
    expect(code).toBe(1);
    expect(c.err.join('\n')).toContain('없어서 통과');
  });
});

describe('parseChangedFiles — 형제 게이트와 «같은 관례»', () => {
  test('⭐ 공백 구분으로 «전부» 읽는다 — runAdditionalGate 가 그렇게 넘긴다', () => {
    expect(parseChangedFiles(['--changed-files', 'a.kt', 'b.kt', 'c.kt']))
      .toEqual(['a.kt', 'b.kt', 'c.kt']);
  });

  test('⛔ 콤마만 기대하면 «첫 파일만» 보게 된다 — 콤마도 함께 받는다', () => {
    expect(parseChangedFiles(['--changed-files', 'a.kt,b.kt'])).toEqual(['a.kt', 'b.kt']);
  });

  test('다음 플래그에서 멈춘다', () => {
    expect(parseChangedFiles(['--changed-files', 'a.kt', '--other', 'b.kt'])).toEqual(['a.kt']);
  });

  test('플래그가 없으면 null — 「전체 검사」와 「변경 0건」은 다른 값이다', () => {
    expect(parseChangedFiles([])).toBeNull();
    expect(parseChangedFiles(['--changed-files'])).toEqual([]);
  });
});

describe('parseBaselineUpdateRequest', () => {
  test('플래그·선택 경로를 읽고 경로 생략 시 표준 baseline 경로를 쓴다', () => {
    expect(parseBaselineUpdateRequest([])).toBeNull();
    expect(parseBaselineUpdateRequest(['--update-failed-test-baseline'])).toEqual({
      path: 'apps/android/failed-test-baseline.txt',
    });
    expect(parseBaselineUpdateRequest(['--update-failed-test-baseline', 'tmp/failures.txt', '--changed-files', 'a.kt']))
      .toEqual({ path: 'tmp/failures.txt' });
  });
});

describe('🚨 이 게이트가 «고치려는 병»을 스스로 앓지 않는지', () => {
  test('⛔ 「해당 없음」은 「돌았다」가 아니다 — 산출이 둘을 «다른 말»로 낸다', () => {
    const c = capture();
    runAndroidUnitTestGate({
      args: ['--changed-files', 'docs/a.md'], cwd: rootWithGradlew(), log: c.log, error: c.error,
      runGradle: () => ({ status: 0, output: '' }), readResults: () => [],
    });
    const said = c.out.join('\n');
    expect(said).toContain('해당 없음');
    // ⭐ 「돌았다」를 «주장하지 않는다» — 안 돌았기 때문이다.
    expect(said).not.toContain('돌았고');
    expect(said).not.toContain('PASS');
  });

  test('⭐ 실제로 돌았을 때만 «몇 개 돌았는지»를 말한다', () => {
    const c = capture();
    runAndroidUnitTestGate({
      args: ['--changed-files', 'apps/android/app/src/main/kotlin/A.kt'],
      cwd: rootWithGradlew(), log: c.log, error: c.error,
      runGradle: () => ({ status: 0, output: 'BUILD SUCCESSFUL' }),
      readResults: () => [{ path: 'p', xml: '<testsuite><testcase name="a"/></testsuite>' }],
    });
    expect(c.out.join('\n')).toContain('testcase 1개 돌았고');
  });

  test('⛔ 안드로이드가 «깨어나면» 변경 범위가 아니라 «전부»를 돌린다 — 안 만진 파일이 이미 깨져 있을 수 있다', () => {
    // 실측 근거(2026-09-07): 내가 만지지 않은 ChatInputBarTest.kt 가 이미 컴파일 불가였다.
    let gradleArgsSeen = 0;
    runAndroidUnitTestGate({
      args: ['--changed-files', 'apps/android/gradle/libs.versions.toml'],
      cwd: rootWithGradlew(), log: () => {}, error: () => {},
      runGradle: () => { gradleArgsSeen += 1; return { status: 0, output: '' }; },
      readResults: () => [{ path: 'p', xml: '<testsuite><testcase name="a"/></testsuite>' }],
    });
    // 변경 파일을 «필터로 넘기지 않는다» — 러너는 인자 없이 한 번 불린다.
    expect(gradleArgsSeen).toBe(1);
  });
});

describe('⛔ 재발명 방지 — 기존 러너를 «부른다»', () => {
  test('게이트 소스가 gradlew 를 «직접» 부르지 않는다 — run-android-unit-tests.ts 에 위임한다', () => {
    // 🩸 첫 판은 직접 gradlew 를 불러 debug «만» 돌렸고, 그러면 release 변형의
    //    Assume 게이트 보안 시험이 «조용히 건너뛰고도 초록»이 된다(#15878 이 잡으려던 그것).
    const src = readFileSync(new URL('./ci-android-unit-tests.ts', import.meta.url), 'utf8');
    expect(src).toContain('run-android-unit-tests.ts');
    // ⛔ 「직접 호출」의 흔적이 남아 있으면 안 된다
    expect(src).not.toContain("':app:testDebugUnitTest'");
  });
});

describe('⛔ 「무언가 실패했다」로 끝내지 않는다', () => {
  test('러너가 시험 밖에서 죽으면 «컴파일러 줄»을 보여 준다', () => {
    const c = capture();
    const code = runAndroidUnitTestGate({
      args: [], cwd: rootWithGradlew(), log: c.log, error: c.error,
      runGradle: () => ({ status: 1, output: "e: X.kt:1:1 Unresolved reference 'ChatScreenHostActivity'.\n" }),
      readResults: () => [{ path: 'p', xml: '<testsuite><testcase name="a"/></testsuite>' }],
    });
    expect(code).toBe(1);
    // 🩸 첫 판은 이유를 «안 보여 줘서» 고칠 수가 없었다(실제로 한 번 막혔다).
    expect(c.err.join('\n')).toContain("Unresolved reference 'ChatScreenHostActivity'");
  });

  test('컴파일 오류가 아니면 «산출 꼬리»라도 보여 준다', () => {
    const c = capture();
    runAndroidUnitTestGate({
      args: [], cwd: rootWithGradlew(), log: c.log, error: c.error,
      runGradle: () => ({ status: 1, output: 'lint task failed\nsome detail line' }),
      readResults: () => [{ path: 'p', xml: '<testsuite><testcase name="a"/></testsuite>' }],
    });
    expect(c.err.join('\n')).toContain('some detail line');
  });
});

describe('resolveJdk21Home — ⛔ 사람이 매번 JAVA_HOME 을 붙여야 하는 관문은 «꺼진다»', () => {
  test('21 이상을 «순서대로» 찾아 첫 성공을 쓴다', () => {
    const asked: string[] = [];
    const home = resolveJdk21Home((v) => { asked.push(v); return v === '23' ? '/jdk23' : null; });
    expect(home).toBe('/jdk23');
    expect(asked.slice(0, 3)).toEqual(['21', '22', '23']);
  });

  test('⛔ 못 찾으면 «지어내지 않고» null 을 낸다 — 그래야 「왜 안 되는지」가 산출에 남는다', () => {
    expect(resolveJdk21Home(() => null)).toBeNull();
  });
});

describe('⛔ 게이트가 «이 커밋»을 잰다 — Gradle 캐시를 끈다', () => {
  test('러너가 build·configuration 캐시를 끄고 과제를 다시 돌린다', () => {
    // 🩸 09-30(UX · #22211 · #22218): gradle.properties 가 두 캐시를 켜 두어, 고친 뒤에도 고치기 전 클래스로 시험이 돌았다.
    const src = readFileSync(new URL('./run-android-unit-tests.ts', import.meta.url), 'utf8');
    for (const flag of ['--no-configuration-cache', '--no-build-cache', '--rerun-tasks']) expect(src).toContain(`"${flag}"`);
  });
});
