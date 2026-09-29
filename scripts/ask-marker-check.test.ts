import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GOAL_TYPES } from '../src/self-implement/goal-author.js';
import {
  inspectNarrowedTestSignalWarnings, inspectAbsenceCountSignalWarnings, inspectUnportedIsolatedDaemonWarnings, inspectConditionObservationPairWarnings, inspectAskMarkers, inspectAskMarkersInRoot, inspectConsumerPathWarning, inspectDecisionObservations, inspectDecisionSignalKinds, inspectDecisionSignalObservations, inspectWrappedMarkerWarnings, bunTestFileLaunchesRepositoryExecutable, formatAxis, formatAxisObservations } from './ask-marker-check.js';

const script = fileURLToPath(new URL('./ask-marker-check.ts', import.meta.url));
const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

const HEADING_FORM = `대상 경로: scripts/x.ts

## 불변식

- 공용 심을 쓴다.

## 경계

- 다른 스크립트는 대상이 아니다.

판정 신호: 조건 = A; 관측 = B; 기대 = C 가 있다.
`;

const INLINE_FORM = `대상 경로: scripts/ask-marker-check.ts

불변식: scripts/ask-marker-check.ts 를 계속 쓴다.
경계: 다른 스크립트는 대상이 아니다.
판정 신호: 조건 = A; 관측 = B; 기대 = C 가 있다.
`;

const PATH_LIKE_TEXT_WITHOUT_TARGET_LABEL = `fix apps/android/app/src/main/kotlin/com/elanvitalai/elanous/android/ChatModels.kt typo

불변식: scripts/ask-marker-check.ts 를 계속 쓴다.
경계: src/dashboard/ 를 고치지 않는다.
판정 신호: 조건 = A; 관측 = B; 기대 = C 가 있다.
`;

const GOAL_TYPE_OUTSIDE_LEADING_METADATA = `대상 경로: scripts/ask-marker-check.ts

- GoalType: research
불변식: scripts/ask-marker-check.ts 를 계속 쓴다.
경계: 다른 스크립트는 대상이 아니다.
판정 신호: 조건 = A; 관측 = B; 기대 = C 가 있다.
`;

const GOAL_TYPE_IN_LEADING_METADATA = `대상 경로: scripts/ask-marker-check.ts
- GoalType: research
불변식: scripts/ask-marker-check.ts 를 계속 쓴다.
경계: 다른 스크립트는 대상이 아니다.
판정 신호: 조건 = A; 관측 = B; 기대 = C 가 있다.
`;

const INVALID_GOAL_TYPE_IN_LEADING_METADATA = `대상 경로: scripts/ask-marker-check.ts
- GoalType: fix
불변식: scripts/ask-marker-check.ts 를 계속 쓴다.
경계: 다른 스크립트는 대상이 아니다.
판정 신호: 조건 = A; 관측 = B; 기대 = C 가 있다.
`;

const PARTIALLY_GROUNDED_INVARIANTS = `대상 경로: scripts/ask-marker-check.ts

불변식: scripts/ask-marker-check.ts 를 계속 쓴다.
불변식: inspectAskInvariantMarker 를 계속 부른다.
경계: 다른 스크립트는 대상이 아니다.
판정 신호: 조건 = A; 관측 = B; 기대 = C 가 있다.
`;

const SYMBOL_ONLY_INVARIANTS = `대상 경로: scripts/ask-marker-check.ts

불변식: inspectAskInvariantMarker 를 계속 부른다.
불변식: parseAskTargetPathHints 를 계속 부른다.
경계: 다른 스크립트는 대상이 아니다.
판정 신호: 조건 = A; 관측 = B; 기대 = C 가 있다.
`;

const REAL_DERIVED_GREENFIELD = `대상 경로: scripts/botlab/not-yet-place.ts · scripts/botlab/not-yet-place.test.ts · scripts/botlab/bot-routine.ts

불변식: \`scripts/botlab/not-yet-place.ts\` 의 export 는 아무도 안 부르는 채로 남지 않는다 — \`scripts/botlab/bot-routine.ts\` 가 그것을 부르고, 그 사실을 관측이 보인다.
불변식: \`scripts/botlab/not-yet-place.test.ts\` 는 세 값과 null 을 전부 문다 — 값마다 적어도 하나의 시험이 있어야 한다.
경계: 단계 판정과 배달 경로를 바꾸지 않는다.
판정 신호: 조건 = A; 관측 = B; 기대 = C 가 있다.
`;

const GREENFIELD_INVARIANTS = `대상 경로: scripts/not-yet-created-place.ts, scripts/not-yet-created-place.test.ts

불변식: scripts/not-yet-created-place.ts 는 순수 함수만 갖는다.
불변식: scripts/not-yet-created-place.test.ts 가 세 값을 전부 문다.
경계: 배선을 하지 않는다.
판정 신호: 조건 = A; 관측 = B; 기대 = C 가 있다.
`;

const GREENFIELD_WITH_TYPO = `대상 경로: scripts/not-yet-created-place.ts, scripts/not-yet-created-place.test.ts

불변식: scripts/not-yet-created-place.ts 는 순수 함수만 갖는다.
불변식: scripts/not-yet-creatd-place.test.ts 가 세 값을 전부 문다.
경계: 배선을 하지 않는다.
판정 신호: 조건 = A; 관측 = B; 기대 = C 가 있다.
`;

const NONEXISTENT_PATH_INVARIANT = `대상 경로: scripts/ask-marker-check.ts

불변식: scripts/no-such-file.ts 를 계속 쓴다.
경계: 다른 스크립트는 대상이 아니다.
판정 신호: 조건 = A; 관측 = B; 기대 = C 가 있다.
`;

const DIRECTORY_ONLY_INVARIANT = `대상 경로: scripts/ask-marker-check.ts

불변식: scripts 를 계속 쓴다.
경계: 다른 스크립트는 대상이 아니다.
판정 신호: 조건 = A; 관측 = B; 기대 = C 가 있다.
`;

const OUTSIDE_TARGET_INVARIANT = `대상 경로: scripts/ask-marker-check.ts

불변식: src/self-dev/launch-preflight.ts 를 계속 부른다.
경계: 다른 스크립트는 대상이 아니다.
판정 신호: 조건 = A; 관측 = B; 기대 = C 가 있다.
`;

const ROOT_FILE_INVARIANT = `대상 경로: package.json

불변식: package.json 을 계속 쓴다.
경계: 다른 스크립트는 대상이 아니다.
판정 신호: 조건 = A; 관측 = B; 기대 = C 가 있다.
`;

const PUNCTUATED_ROOT_FILE_INVARIANT = `대상 경로: package.json

불변식: package.json.
경계: 다른 스크립트는 대상이 아니다.
판정 신호: 조건 = A; 관측 = B; 기대 = C 가 있다.
`;

const NO_TARGET_HINT_INVARIANT = `대상 경로:
불변식: package.json 을 계속 쓴다.
경계: 다른 스크립트는 대상이 아니다.
판정 신호: 조건 = A; 관측 = B; 기대 = C 가 있다.
`;

const PRESENT_BUT_UNEXTRACTED = `대상 경로: scripts/x.ts

불변식: 공용 심을 쓴다.
경계: 다른 스크립트는 대상이 아니다.
판정 신호: 그냥 잘 되면 된다.
`;

function runCli(ask: string, cwd?: string): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ask-marker-check-'));
  const file = join(dir, 'ask.md');
  try {
    writeFileSync(file, ask);
    const r = spawnSync(process.execPath, [script, file], { cwd, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function finalNonblankLine(output: string): string {
  return output.split(/\r?\n/).filter((line) => line.trim().length > 0).at(-1) ?? '';
}

function expectLinesInOrder(output: string, expected: readonly string[]): void {
  const lines = output.split(/\r?\n/);
  let previous = -1;
  for (const line of expected) {
    const index = lines.indexOf(line);
    expect(index).toBeGreaterThan(previous);
    previous = index;
  }
}

function runCliFiles(asks: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ask-marker-check-'));
  try {
    const files = asks.map((ask, index) => {
      const file = join(dir, `ask-${index}.md`);
      writeFileSync(file, ask);
      return file;
    });
    const r = spawnSync(process.execPath, [script, ...files], { encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 경고 줄이 쓰는 «짧은» 검사 루트 이름 — 구현과 «같은 규칙»(마지막 경로 조각 · 32자 상한). */
function shortRoot(root: string): string {
  const name = root.split(sep).filter(Boolean).pop() ?? root;
  return name.length > 32 ? `${name.slice(0, 31)}…` : name;
}

describe('ask marker check — inspector', () => {
  it('reports heading-form 불변식/경계 as absent markers, not as malformed ones', () => {
    const by = Object.fromEntries(inspectAskMarkers(HEADING_FORM).map((a) => [a.label, a]));

    expect(by['불변식']!.marker).toBe(false);
    expect(by['경계']!.marker).toBe(false);
    expect(by['판정 신호']!).toEqual({ label: '판정 신호', marker: true, extracted: true });
  });

  it('preserves the eight existing axes and accepts a 대상 경로 label without validating its value or position', () => {
    const axes = inspectAskMarkers(INLINE_FORM);

    expect(axes).toHaveLength(9);
    expect(axes.slice(0, 8)).toEqual([
      { label: '불변식', marker: true, extracted: true },
      { label: '경계', marker: true, extracted: true },
      { label: '판정 신호', marker: true, extracted: true },
      { label: 'GoalType 머리 블록', marker: true, extracted: true },
      expect.objectContaining({ label: '불변식 경로', marker: true, extracted: true }),
      expect.objectContaining({ label: '판정 신호 시험 경로', marker: true, extracted: true }),
      expect.objectContaining({ label: '판정 신호 관측', marker: true, extracted: true }),
      expect.objectContaining({ label: '판정 신호 종류', marker: true, extracted: true }),
    ]);
    expect(axes[8]).toEqual({ label: '대상 경로', marker: true, extracted: true });
  });

  it('blocks a missing 대상 경로 label without inferring a declaration from path-like text', () => {
    const axes = inspectAskMarkers(PATH_LIKE_TEXT_WITHOUT_TARGET_LABEL);

    expect(axes).toHaveLength(9);
    expect(axes.slice(0, 8).every((axis) => axis.marker && axis.extracted)).toBe(true);
    expect(axes[8]).toEqual({ label: '대상 경로', marker: false, extracted: false });
  });

  it('reports a GoalType declaration outside the authoritative leading metadata block', () => {
    const by = Object.fromEntries(inspectAskMarkers(GOAL_TYPE_OUTSIDE_LEADING_METADATA).map((a) => [a.label, a]));

    expect(by['GoalType 머리 블록']!).toEqual({ label: 'GoalType 머리 블록', marker: false, extracted: false });
  });

  it('accepts every authoritative GoalType declaration in the leading metadata block and its absence', () => {
    for (const goalType of GOAL_TYPES) {
      const ask = GOAL_TYPE_IN_LEADING_METADATA.replace('research', goalType);
      const by = Object.fromEntries(inspectAskMarkers(ask).map((a) => [a.label, a]));
      expect(by['GoalType 머리 블록']!).toEqual({ label: 'GoalType 머리 블록', marker: true, extracted: true });
    }
    const absent = Object.fromEntries(inspectAskMarkers(INLINE_FORM).map((a) => [a.label, a]));

    expect(absent['GoalType 머리 블록']!).toEqual({ label: 'GoalType 머리 블록', marker: true, extracted: true });
  });

  it('rejects an unknown leading GoalType and derives the diagnostic from the authoritative values', () => {
    const by = Object.fromEntries(inspectAskMarkers(INVALID_GOAL_TYPE_IN_LEADING_METADATA).map((a) => [a.label, a]));

    expect(by['GoalType 머리 블록']!).toMatchObject({ label: 'GoalType 머리 블록', marker: false, extracted: false, invalidValue: 'fix' });
    expect(formatAxis(by['GoalType 머리 블록']!)).toBe('❌ GoalType 머리 블록 — `fix`는 알 수 없는 GoalType이다; 유효값: implement, research, document, operate; 선언을 빼는 편이 낫다 — 생략하면 정식 기본값 `implement`를 쓴다');
  });

  it('produces a real present-but-unextracted marker from a 판정 신호 missing its three parts', () => {
    const by = Object.fromEntries(inspectAskMarkers(PRESENT_BUT_UNEXTRACTED).map((a) => [a.label, a]));

    expect(by['판정 신호']!).toEqual({ label: '판정 신호', marker: true, extracted: false });
    expect(by['불변식']!.extracted).toBe(true);
    expect(by['경계']!.extracted).toBe(true);
  });
});

describe('ask marker check — 감싼 마커 진단', () => {
  it('identifies invariant and decision-signal continuation prose with marker identity, line number, and discarded text', () => {
    const warnings = inspectWrappedMarkerWarnings(`대상 경로: scripts/ask-marker-check.ts
불변식: scripts/ask-marker-check.ts 를 계속 쓴다.
그리고 기존 추출은 줄 단위다.
경계: 다른 스크립트는 대상이 아니다.
판정 신호: 조건 = A;
관측 = bun test scripts/ask-marker-check.test.ts; 기대 = C`);

    expect(warnings).toEqual([
      '⚠️ 감싼 마커 — 불변식 2번째 줄 다음 3번째 줄의 버려지는 문면: 그리고 기존 추출은 줄 단위다.',
      '⚠️ 감싼 마커 — 판정 신호 5번째 줄 다음 6번째 줄의 버려지는 문면: 관측 = bun test scripts/ask-marker-check.test.ts; 기대 = C',
    ]);
  });

  it('excludes existing markers and blank-form structural lines while leaving one-line markers silent', () => {
    const warnings = inspectWrappedMarkerWarnings(`불변식: 대상 경로 마커 제외.
대상 경로: scripts/ask-marker-check.ts
경계: 다른 마커다.
판정 신호: 조건 = A; 관측 = B; 기대 = C
판정 신호: 한계 마커 제외.
한계: 자동 수정하지 않는다.
불변식: 빈 줄 제외.

경계: 제목 제외.
#
불변식: 목록 제외.
-
경계: 별표 목록 제외.
*
불변식: 더하기 목록 제외.
+
경계: 번호 목록 제외.
1.
불변식: 우괄호 번호 목록 제외.
1)
경계: 인용 제외.
>
불변식: 코드 제외.
\`\`\`
경계: 언어 지정 코드 제외.
\`\`\`ts
불변식: 네 개 코드펜스 제외.
\`\`\`\`
경계: 물결 코드 제외.
~~~
불변식: 언어 지정 물결 코드 제외.
~~~typescript
경계: 네 개 물결 코드펜스 제외.
~~~~
불변식: 표 제외.
|`);

    expect(warnings).toEqual([]);
  });

  it('renders the warning through the CLI without changing the successful exit code', () => {
    const r = runCli(`대상 경로: scripts/ask-marker-check.ts
불변식: scripts/ask-marker-check.ts 를 계속 쓴다.
이어진 본문이 버려진다.
경계: 다른 스크립트는 대상이 아니다.
판정 신호: 조건 = A; 관측 = bun test scripts/ask-marker-check.test.ts; 기대 = C`);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('⚠️ 감싼 마커 — 불변식 2번째 줄 다음 3번째 줄의 버려지는 문면: 이어진 본문이 버려진다.');
    expect(finalNonblankLine(r.stdout)).toBe('✅ 1개 파일이 마커를 온전히 갖고 있다 — 발사해도 된다.');
  });
});

describe('ask marker check — CLI 종료 경로', () => {
  it('exits 1 and names the fix for the shape that actually shipped with zero markers', () => {
    const r = runCli(HEADING_FORM);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('❌ 불변식 — 마커가 «없다»');
    expect(r.stdout).toContain('"불변식: <문장>"');
    expect(r.stdout).toContain('❌ 경계 — 마커가 «없다»');
    expect(r.stdout).toContain('✅ 판정 신호');
    expect(finalNonblankLine(r.stderr)).toBe('⛔ 1개 파일이 마커를 온전히 갖고 있지 않다 — 발사 전에 고쳐라.');
  });

  it('exits 0 with all three marker axes and a grounded invariant path for the corrected template', () => {
    const r = runCli(INLINE_FORM);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('✅ 불변식');
    expect(r.stdout).toContain('✅ 경계');
    expect(r.stdout).toContain('✅ 판정 신호');
    expect(r.stdout).not.toContain('맞는 형식: 판정 신호:');
    expectLinesInOrder(r.stdout, [
      '   ✅ 불변식',
      '   ✅ 경계',
      '   ✅ 판정 신호',
      '   ✅ GoalType 머리 블록',
      '   ✅ 불변식 경로 — 1/1개 불변식 줄이 저장소 파일 경로를 댄다',
      '   ℹ️ 판정 신호 시험 경로 — bun test 경로가 없다',
      '   ⚠️ 판정 신호 관측 — 판정 신호 1개: 단위 시험 실행 0개, 실물 관측 0개, 미결 관측 1개: B',
      '   ⚠️ 판정 신호 종류 — 1개 중 단위 시험 0 · 미결 1 (실물 관측 0) — 값이 «실행 경로»로 흘렀다는 것을 무엇이 증명하나',
    ]);
    expect(r.stdout).not.toContain('❌');
    expect(finalNonblankLine(r.stdout)).toBe('✅ 1개 파일이 마커를 온전히 갖고 있다 — 발사해도 된다.');
    expect(r.stderr).toBe('');
  });

  it('exits 1 and names the missing 대상 경로 marker without inferring path-like text', () => {
    const r = runCli(PATH_LIKE_TEXT_WITHOUT_TARGET_LABEL);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('❌ 대상 경로 — 마커가 «없다»');
    expect(r.stdout).toContain('"대상 경로: <문장>"');
    expect(r.stdout).not.toContain('발사해도 된다');
  });

  it('exits 1 and diagnoses a GoalType declaration outside the leading metadata block', () => {
    const r = runCli(GOAL_TYPE_OUTSIDE_LEADING_METADATA);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('❌ GoalType 머리 블록 — ask에는 `- GoalType:` 선언이 있지만 저작기의 머리 블록 밖에 있다');
  });

  it('keeps a leading GoalType declaration and an absent declaration non-diagnostic', () => {
    const declared = runCli(GOAL_TYPE_IN_LEADING_METADATA);
    const absent = runCli(INLINE_FORM);

    expect(declared.status).toBe(0);
    expect(declared.stdout).toContain('✅ GoalType 머리 블록');
    expect(absent.status).toBe(0);
    expect(absent.stdout).toContain('✅ GoalType 머리 블록');
  });

  it('exits nonzero and names an invalid leading GoalType with its remediation', () => {
    const r = runCli(INVALID_GOAL_TYPE_IN_LEADING_METADATA);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('❌ GoalType 머리 블록 — `fix`는 알 수 없는 GoalType이다');
    expect(r.stdout).toContain('유효값: implement, research, document, operate');
    expect(r.stdout).toContain('선언을 빼는 편이 낫다 — 생략하면 정식 기본값 `implement`를 쓴다');
    expect(r.stdout).not.toContain('발사해도 된다');
  });

  it('warns by name for an ungrounded invariant when another invariant names an existing file', () => {
    const r = runCli(PARTIALLY_GROUNDED_INVARIANTS);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('✅ 불변식 경로 — 1/2개 불변식 줄이 저장소 파일 경로를 댄다');
    expect(r.stdout).toContain(`⚠️ 불변식 경로 — 실재하지도 대상 경로로 선언되지도 않은 줄 («${shortRoot(repositoryRoot)}»): 불변식: inspectAskInvariantMarker 를 계속 부른다.`);
    expect(finalNonblankLine(r.stdout)).toBe('✅ 1개 파일이 마커를 온전히 갖고 있다 — 발사해도 된다.');
  });

  it.skipIf(!existsSync(join(repositoryRoot, 'scripts/botlab/bot-routine.ts')))('private botlab: separates planned invariant paths into an actionable warning while preserving the CLI summary and rc', () => {
    const r = runCli(REAL_DERIVED_GREENFIELD);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('✅ 불변식 경로 — 2/2개 불변식 줄이 저장소 파일 경로를 댄다');
    expect(r.stdout).not.toContain('✅ 불변식 경로 — 2/2개 불변식 줄이 저장소 파일 경로를 댄다 (그중 «이 골이 만들»');
    expect(r.stdout).toContain('⚠️ 불변식 경로 — 그중 «이 골이 만들» 경로: scripts/botlab/not-yet-place.ts, scripts/botlab/not-yet-place.test.ts; 같은 이름의 기존 모듈이 있는지 확인하라 — 자식이 새로 만들면 그 모듈이 비워질 수 있다');
    expect(r.stdout).toContain('ℹ️ 판정 신호 시험 경로 — bun test 경로가 없다');
  });

  // #21723 added the old src/oauth/codex-account-rotation.test.ts fixture path; keep an absent path with a real same-name test to verify suggestions.
  it('exports warning-grade axis observations without changing their CLI wording', () => {
    const testPathAxis = inspectAskMarkers('대상 경로: scripts/ask-marker-check.ts\n판정 신호: 조건 = 경로; 관측 = bun test src/oauth/codex-account-mirror.test.ts; 기대 = 경고')
      .find((axis) => axis.label === '판정 신호 시험 경로')!;

    expect(formatAxisObservations(testPathAxis)).toEqual([
      `⚠️ 판정 신호 시험 경로 — «${shortRoot(repositoryRoot)}»에서 0개 매치: src/oauth/codex-account-mirror.test.ts; 같은 파일 이름의 실제 경로: test/oauth/codex-account-mirror.test.ts`,
    ]);
  });

  it.skipIf(!existsSync(join(repositoryRoot, 'scripts/botlab/bot-routine.ts')))('private botlab: passes planned-path warnings through the launch-preflight formatAxis warning filter', () => {
    const launchPreflightWarnings = inspectAskMarkers(REAL_DERIVED_GREENFIELD)
      .flatMap((axis) => [formatAxis(axis), ...formatAxisObservations(axis)])
      .filter((detail) => detail.startsWith('⚠️') || detail.startsWith('❌'));

    expect(launchPreflightWarnings).toContain('⚠️ 불변식 경로 — 그중 «이 골이 만들» 경로: scripts/botlab/not-yet-place.ts, scripts/botlab/not-yet-place.test.ts; 같은 이름의 기존 모듈이 있는지 확인하라 — 자식이 새로 만들면 그 모듈이 비워질 수 있다');
  });

  it('emits no planned-path warning when all invariant paths already exist', () => {
    const r = runCli(INLINE_FORM);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('✅ 불변식 경로 — 1/1개 불변식 줄이 저장소 파일 경로를 댄다');
    expect(r.stdout).not.toContain('⚠️ 불변식 경로 — 그중 «이 골이 만들» 경로:');
  });

  it('still names a typo path that is neither existing nor declared as a target path', () => {
    const r = runCli(GREENFIELD_WITH_TYPO);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('✅ 불변식 경로 — 1/2개 불변식 줄이 저장소 파일 경로를 댄다');
    expect(r.stdout).toContain('실재하지도 대상 경로로 선언되지도 않은 줄');
    expect(r.stdout).toContain('not-yet-creatd-place.test.ts');
  });

  it('fails when invariant lines name symbols only', () => {
    const r = runCli(SYMBOL_ONLY_INVARIANTS);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('❌ 불변식 경로 — 2개 불변식 줄이 «실재하지도, 대상 경로로 선언되지도» 않은 경로만 댄다');
  });

  it('does not count a nonexistent path as invariant grounding', () => {
    const r = runCli(NONEXISTENT_PATH_INVARIANT);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('❌ 불변식 경로 — 1개 불변식 줄이 «실재하지도, 대상 경로로 선언되지도» 않은 경로만 댄다');
  });

  it('does not count a directory-only invariant as file grounding', () => {
    const r = runCli(DIRECTORY_ONLY_INVARIANT);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('❌ 불변식 경로 — 1개 불변식 줄이 «실재하지도, 대상 경로로 선언되지도» 않은 경로만 댄다');
  });

  it('counts a repository-root file from a different working directory', () => {
    const r = runCli(ROOT_FILE_INVARIANT, tmpdir());

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('✅ 불변식 경로 — 1/1개 불변식 줄이 저장소 파일 경로를 댄다');
  });

  it('counts an existing file when sentence punctuation follows its path', () => {
    const r = runCli(PUNCTUATED_ROOT_FILE_INVARIANT);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('✅ 불변식 경로 — 1/1개 불변식 줄이 저장소 파일 경로를 댄다');
  });

  it('does not claim a grounded path is outside targets when target hints are absent', () => {
    const r = runCli(NO_TARGET_HINT_INVARIANT);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('✅ 불변식 경로 — 1/1개 불변식 줄이 저장소 파일 경로를 댄다');
    expect(r.stdout).not.toContain('대상 경로 밖의 실재 파일');
  });

  it('does not count an existing path outside the repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-marker-outside-'));
    try {
      const outsideFile = join(dir, 'outside-proof.txt');
      writeFileSync(outsideFile, 'outside');
      const outsidePath = relative(repositoryRoot, outsideFile);
      const ask = `대상 경로: scripts/ask-marker-check.ts

불변식: ${outsidePath} 을 계속 쓴다.
경계: 다른 스크립트는 대상이 아니다.
판정 신호: 조건 = A; 관측 = B; 기대 = C 가 있다.
`;
      const r = runCli(ask, repositoryRoot);

      expect(r.status).toBe(1);
      expect(r.stdout).toContain('❌ 불변식 경로 — 1개 불변식 줄이 «실재하지도, 대상 경로로 선언되지도» 않은 경로만 댄다');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a grounded path outside target hints without changing exit status', () => {
    const r = runCli(OUTSIDE_TARGET_INVARIANT);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`ℹ️ 불변식 경로 — 대상 경로 밖의 실재 파일 («${shortRoot(repositoryRoot)}»): src/self-dev/launch-preflight.ts`);
  });

  it('does not let the new axis override the existing absent-invariant marker failure', () => {
    const r = runCli(HEADING_FORM);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('❌ 불변식 — 마커가 «없다»');
    expect(r.stdout).toContain('✅ 불변식 경로 — 불변식 줄이 없다 (기존 불변식 마커 판정이 담당)');
  });

  it('separates present-but-unextracted from absent in CLI output', () => {
    const r = runCli(PRESENT_BUT_UNEXTRACTED);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('⚠️ 판정 신호 — 마커는 있는데 «형식이 안 맞아» 못 읽었다');
    expect(r.stdout).toContain('맞는 형식: 판정 신호: 조건 = malformed marker exists; 관측 = bun test src/example.test.ts; 기대 = diagnostic is rendered.');
    expect(r.stdout).not.toContain('❌ 판정 신호');
    expect(r.stdout).toContain('✅ 불변식');
    expect(r.stdout).toContain('✅ 경계');
  });

  it('uses an injected inspection root for decision and invariant paths, and names that root in unmatched diagnostics', () => {
    const root = mkdtempSync(join(tmpdir(), 'ask-marker-root-'));
    const ask = `대상 경로: scripts/ask-marker-check.ts

불변식: tools/judge.test.ts 를 계속 쓴다.
경계: 다른 스크립트는 대상이 아니다.
판정 신호: 조건 = 경로를 본다; 관측 = bun test tools/judge.test.ts; 기대 = 경고를 낸다.
`;
    try {
      const missing = Object.fromEntries(inspectAskMarkersInRoot(ask, root).map((axis) => [axis.label, axis]));
      expect(formatAxis(missing['판정 신호 시험 경로']!)).toContain(`«${shortRoot(root)}»의 파일을 못 문다`);
      expect(formatAxis(missing['불변식 경로']!)).toContain(`«${shortRoot(root)}»`);

      mkdirSync(join(root, 'tools'));
      writeFileSync(join(root, 'tools/judge.test.ts'), '');
      const injected = Object.fromEntries(inspectAskMarkersInRoot(ask, root).map((axis) => [axis.label, axis]));
      expect(formatAxis(injected['판정 신호 시험 경로']!)).toBe(`✅ 판정 신호 시험 경로 — 1/1개 경로가 «${shortRoot(root)}»의 파일 1개를 문다`);
      expect(formatAxis(injected['불변식 경로']!)).toBe('✅ 불변식 경로 — 1/1개 불변식 줄이 저장소 파일 경로를 댄다');

      const defaultRoot = Object.fromEntries(inspectAskMarkers(ROOT_FILE_INVARIANT).map((axis) => [axis.label, axis]));
      expect(formatAxis(defaultRoot['불변식 경로']!)).toBe('✅ 불변식 경로 — 1/1개 불변식 줄이 저장소 파일 경로를 댄다');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a 판정 신호 시험 경로 warning before the final success verdict', () => {
    const r = runCli(`대상 경로: scripts/ask-marker-check.ts

불변식: scripts/ask-marker-check.ts 를 계속 쓴다.
경계: 다른 스크립트는 대상이 아니다.
판정 신호: 조건 = 경로를 본다; 관측 = bun test src/oauth/codex-account-mirror.test.ts; 기대 = 경고를 낸다.
`);

    expect(r.status).toBe(0);
    expectLinesInOrder(r.stdout, [
      `   ⚠️ 판정 신호 시험 경로 — 1개 경로가 «${shortRoot(repositoryRoot)}»의 파일을 못 문다 (0/1개 경로가 파일 0개를 문다)`,
      `   ⚠️ 판정 신호 시험 경로 — «${shortRoot(repositoryRoot)}»에서 0개 매치: src/oauth/codex-account-mirror.test.ts; 같은 파일 이름의 실제 경로: test/oauth/codex-account-mirror.test.ts`,
      '   ⚠️ 판정 신호 종류 — 1개가 «전부» 단위 시험이다 (실물 관측 0) — 값이 «실행 경로»로 흘렀다는 것을 무엇이 증명하나',
      '✅ 1개 파일이 마커를 온전히 갖고 있다 — 발사해도 된다.',
    ]);
    expect(finalNonblankLine(r.stdout)).toBe('✅ 1개 파일이 마커를 온전히 갖고 있다 — 발사해도 된다.');
    expect(r.stderr).toBe('');
  });

  it('ends a mixed multi-file run with the preserved failure verdict after ordered diagnostics', () => {
    const r = runCliFiles([INLINE_FORM, HEADING_FORM]);

    expect(r.status).toBe(1);
    const lines = r.stdout.split(/\r?\n/);
    const successFile = lines.findIndex((line) => line.startsWith('✅ '));
    const failureFile = lines.findIndex((line) => line.startsWith('⛔ '));

    expect(successFile).toBeGreaterThanOrEqual(0);
    expect(failureFile).toBeGreaterThan(successFile);
    expect(lines.slice(successFile, failureFile)).toContain('   ✅ 판정 신호');
    expect(lines.slice(failureFile)).toContain('   ❌ 불변식 — 마커가 «없다» (제목형 "## 불변식" 은 마커가 아니다 ⇒ "불변식: <문장>" 줄로 쓴다)');
    expect(finalNonblankLine(r.stderr)).toBe('⛔ 1개 파일이 마커를 온전히 갖고 있지 않다 — 발사 전에 고쳐라.');
  });

  it('ends a multi-file successful run with the range-neutral verdict after each file diagnostics', () => {
    const r = runCliFiles([INLINE_FORM, GOAL_TYPE_IN_LEADING_METADATA]);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('✅ 판정 신호');
    expect(finalNonblankLine(r.stdout)).toBe('✅ 2개 파일이 마커를 온전히 갖고 있다 — 발사해도 된다.');
    expect(r.stderr).toBe('');
  });

  it('exits 2 and says how to use it when given no file', () => {
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });

    expect(r.status).toBe(2);
    expect(r.stderr).toContain('쓰는 법');
  });
});

describe('ask marker check — 읽기 실패', () => {
  it('reports an unreadable file in exactly one clean line with no stack frames', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-marker-missing-'));
    try {
      const r = spawnSync(process.execPath, [script, join(dir, 'no-such-ask.md')], { encoding: 'utf8' });
      const lines = r.stderr.split('\n').filter((line) => line.trim().length > 0);
      const diagnostic = lines.filter((line) => !line.includes('경로를 확인하라') && !line.includes('마커를 온전히'));

      expect(r.status).toBe(1);
      expect(diagnostic).toHaveLength(1);
      expect(diagnostic[0]).toContain('no-such-ask.md');
      expect(diagnostic[0]).toContain('읽지 못했다');
      expect(r.stderr).not.toMatch(/^\s*at /m);
      expect(r.stderr).not.toMatch(/^\s*\d+ \|/m);
      expect(r.stderr).toContain('«읽지 못했다» — 경로를 확인하라');
      expect(r.stderr).not.toContain('마커를 온전히 갖고 있지 않다');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('suppresses stack and source lines for a directory argument too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-marker-dir-'));
    try {
      const r = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
      const diagnostic = r.stderr.split('\n')
        .filter((line) => line.trim().length > 0)
        .filter((line) => !line.includes('경로를 확인하라') && !line.includes('마커를 온전히'));

      expect(r.status).toBe(1);
      expect(diagnostic).toHaveLength(1);
      expect(diagnostic[0]).toContain('읽지 못했다');
      expect(r.stderr).not.toMatch(/^\s*at /m);
      expect(r.stderr).not.toMatch(/^\s*\d+ \|/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits both summary lines when one file is unreadable and another lacks markers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-marker-mixed-'));
    try {
      const empty = join(dir, 'empty.md');
      writeFileSync(empty, '');
      const r = spawnSync(process.execPath, [script, join(dir, 'no-such.md'), empty], { encoding: 'utf8' });

      expect(r.status).toBe(1);
      expect(r.stderr).toContain('1개 파일을 «읽지 못했다» — 경로를 확인하라');
      expect(r.stderr).toContain('1개 파일이 마커를 온전히 갖고 있지 않다');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('separates an unreadable file from a readable file that simply has no markers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-marker-empty-'));
    try {
      const empty = join(dir, 'empty.md');
      writeFileSync(empty, '');
      const r = spawnSync(process.execPath, [script, empty], { encoding: 'utf8' });

      expect(r.status).toBe(1);
      expect(r.stdout).toContain('마커가 «없다»');
      expect(`${r.stdout}${r.stderr}`).not.toContain('읽지 못했다');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ask marker check — 문면', () => {
  it('warns by unresolved command name without blocking the existing CLI launch verdict', () => {
    const observationAxis = inspectAskMarkers(INLINE_FORM).find((axis) => axis.label === '판정 신호 관측')!;
    const r = runCli(INLINE_FORM);

    expect(formatAxis(observationAxis)).toBe('⚠️ 판정 신호 관측 — 판정 신호 1개: 단위 시험 실행 0개, 실물 관측 0개, 미결 관측 1개: B');
    expect(r.status).toBe(0);
    expect(finalNonblankLine(r.stdout)).toBe('✅ 1개 파일이 마커를 온전히 갖고 있다 — 발사해도 된다.');
  });

  it('preserves the exact information rendering when every observation is resolved', () => {
    const observationAxis = inspectAskMarkers(`대상 경로: scripts/ask-marker-check.ts

불변식: scripts/ask-marker-check.ts 를 계속 쓴다.
경계: 다른 경계는 없다.
판정 신호: 조건 = A; 관측 = bun test scripts/ask-marker-check.test.ts; 기대 = C 가 있다.
`).find((axis) => axis.label === '판정 신호 관측')!;

    expect(formatAxis(observationAxis)).toBe('ℹ️ 판정 신호 관측 — 판정 신호 1개: 단위 시험 실행 0개, 실물 관측 1개');
  });

  it('names the fix in the absent-marker message so the reader does not have to guess', () => {
    const message = formatAxis({ label: '불변식', marker: false, extracted: false });

    expect(message).toContain('마커가 «없다»');
    expect(message).toContain('"불변식: <문장>"');
    expect(message).not.toContain('형식이 안 맞아');
  });

  it('keeps non-decision malformed-marker warnings unchanged', () => {
    expect(formatAxis({ label: '경계', marker: true, extracted: false }))
      .toBe('⚠️ 경계 — 마커는 있는데 «형식이 안 맞아» 못 읽었다');
  });
});

describe('소비 경로 관측 경고 — 구현을 문다', () => {
  const HEAD = ['대상 경로: scripts/ask-marker-check.ts', '불변식: scripts/ask-marker-check.ts 를 그대로 둔다.'];
  const ask = (boundary: string, signal: string) => [...HEAD, `경계: ${boundary}`, `판정 신호: 조건 = 새 값을 만든다; 관측 = ${signal}; 기대 = 지금은 없다`].join('\n');

  it('저자 부재 선언과 관측되지 않은 실재 경계가 함께 있을 때만 모든 경로를 이름으로 경고한다', () => {
    const source = `${HEAD.join('\n')}\n경계: src/ 와 scripts/ 를 고치지 않는다.\n판정 신호: 조건 = 새 값을 만든다; 관측 = bun test test/ask-marker-check.test.ts; 기대 = 지금은 0건이다`;

    expect(inspectConsumerPathWarning(source)).toBe('⚠️ 어디까지 사나 — src/, scripts/: 판정 신호가 이 경계를 관측하지 않아 한 단계까지만 산다');
    const r = runCli(source);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('⚠️ 어디까지 사나 — src/, scripts/: 판정 신호가 이 경계를 관측하지 않아 한 단계까지만 산다');
    expect(finalNonblankLine(r.stdout)).toBe('✅ 1개 파일이 마커를 온전히 갖고 있다 — 발사해도 된다.');
  });

  // ⭐ 인수 정합 뒤 리뷰 must-fix 둘(2026-09-17) — «거짓 경고» 두 자리를 각각 문다.
  //   ⛔ 이 둘은 «자립»한다(공용 HEAD 를 안 쓴다) — CLI 로 실제 눌러 확인한 문면 그대로다.
  const countAsk = (condition: string, observation: string, expectation: string): string => [
    '대상 경로: src/a.ts',
    '- GoalType: implement',
    '',
    '## 불변식',
    '',
    '불변식: bun test src/a.test.ts → 0 fail.',
    '',
    '## 경계 — 의도적 결정이다',
    '',
    '경계: 다른 파일은 안 건드린다.',
    '',
    '## 판정 신호',
    '',
    `판정 신호: 조건 = ${condition} ; 관측 = ${observation} ; 기대 = ${expectation}`,
    '',
    '## 관측',
    '',
    'bun test src/a.test.ts',
    '',
  ].join('\n');
  const warnsAbsenceCount = (source: string): boolean => inspectAbsenceCountSignalWarnings(source).length > 0;

  // ⭐ 리뷰가 «다섯 라운드 연속» 표의 구멍을 찾아냈다(-ie · --iglob · grep -Ec · -v · --files-without-match · grep --color).
  //   ⇒ denylist→allowlist 로 뒤집어도 «표는 여전히 열거»라 다시 샜다. 그래서 ***열거를 없앴다***:
  //     ***`-c`/`--count` 말고 다른 옵션이 «하나라도» 있으면 판정을 포기한다***(`--이름=값` 꼴도 마찬가지다).
  //     ⛔ 옵션을 «읽지 않으므로» 인자 수·뒤집기·선택 인자·유효성을 알 필요가 없다.
  it('`-c` 말고 다른 옵션이 있으면 «판정하지 않는다» — 옵션을 읽지 않으므로 알 필요가 없다', () => {
    // `-c` 하나뿐일 때만 ⇒ 센다
    expect(warnsAbsenceCount(countAsk('센다', 'rg -c pattern src/a.ts', '0 이다'))).toBe(true);
    // 다른 옵션이 «하나라도» 있으면 ⇒ 판정 안 함 (`=값` 꼴도 «거절»한다 — 옵션을 읽지 않는다)
    for (const observation of ['rg -ie -c src/a.ts', 'rg --iglob -c p src/a.ts', 'grep -Ec pattern src/a.ts', 'rg --glob=*.ts -c p src/a.ts', 'rg -uu -c p src/a.ts']) {
      expect(warnsAbsenceCount(countAsk('센다', observation, '0 이다'))).toBe(false);
    }
  // ⛔ CLI 자식이 «일곱»(양성 2 ⊕ 음성 5) — 한 번이 ~1s 라 러너 기본 5s 를 넘긴다(실측 6.17s 로 timed out).
  //    ⇒ 바깥 예산 = 최악(7s) + 여유. 표본은 «줄이지 않는다» — 구멍은 표본에서 나왔다.
  }, 20_000);

  // ⭐ 4라운드 리뷰 must-fix — 「없다」가 «무엇의» 부재인지를 안 봐서 정상 신호에 빨강이 났다.
  it('부재가 «매치 수»가 아니라 «다른 주어»를 가리키면 판정하지 않는다', () => {
    expect(warnsAbsenceCount(countAsk('센다', 'rg -c p src/a.ts', '2건이며 오류가 없다'))).toBe(false);
    expect(warnsAbsenceCount(countAsk('센다', 'rg -c p src/a.ts', '종료 코드 0이고 오류가 없다'))).toBe(false);
    // ⊕ 대조군 — «세는 주어»이거나 주어가 «없으면» 여전히 잡힌다
    expect(warnsAbsenceCount(countAsk('센다', 'rg -c p src/a.ts', '매치가 없다'))).toBe(true);
    expect(warnsAbsenceCount(countAsk('센다', 'rg -c p src/a.ts', '결과는 0건이다'))).toBe(true);
  });

  // ⭐ 5라운드 리뷰 must-fix 둘 — 「반전 검색은 전제가 깨진다」 ⊕ 「주어를 «접미»로만 봤다」
  // ⭐ 「찾음/못 찾음의 «뜻»을 뒤집는 모드」는 «계급»이다 — 리뷰가 -v 다음 --files-without-match 를 찾았다.
  it('부재를 «성공»으로 만드는 모드들은 판정하지 않는다', () => {
    // 반전 매치가 잡혀 rc=0 이다
    expect(warnsAbsenceCount(countAsk('센다', 'grep -c -v pattern file', '패턴이 없다'))).toBe(false);
    // 패턴이 «없는» 파일을 찾으면 rc=0 이다
    expect(warnsAbsenceCount(countAsk('센다', 'rg -c --files-without-match pattern file', '패턴이 없다'))).toBe(false);
    expect(warnsAbsenceCount(countAsk('센다', 'grep -c -L pattern file', '패턴이 없다'))).toBe(false);
    // 인자가 «선택»인 옵션이 뒤집는 모드를 «삼켜» 숨기는 판도 판정하지 않는다
    expect(warnsAbsenceCount(countAsk('센다', 'grep -c --color -v pattern file', '패턴이 없다'))).toBe(false);
    // `=값` 꼴도 거절한다 — 옵션을 읽지 않으므로 그 값이 무엇을 바꾸는지 알 필요가 없다
    expect(warnsAbsenceCount(countAsk('센다', 'grep -c --binary-files=without-match p file', '패턴이 없다'))).toBe(false);
  }, 20_000);

  // ⭐ 10·12·13·14라운드 — 「이 명령의 rc」를 말하려면 «한 명령»이어야 하고, 셸을 거치며 «안 바뀌어야» 한다.
  //   리뷰가 이 자리에서 «세 번» 잡았고 셋 다 「우리가 셸 규칙을 흉내 내다 틀린 것」이었다
  //   (큰따옴표 안의 `\"` · 큰따옴표 안의 `$()` · ***글로브 확장이 «옵션»을 집어넣는다***).
  //   ⇒ 낱말을 «해석»하지 않고 ***셸이 손댈 수 있는 글자를 아예 안 받는다*** —
  //     작은따옴표 «안»은 무엇이든 허용하고, 그 «밖»은 안전한 글자만 허용한다(열거가 아니라 «여집합»).
  it('셸이 «손댈 수 있는» 글자가 하나라도 있으면 판정하지 않는다', () => {
    for (const observation of [
      'rg -c pattern file || true',        // 합성이 rc 를 갈아치운다
      'rg -c pattern file | wc -l',
      'grep -c "$(printf %s -v)" p file',  // 큰따옴표 «안»에서도 치환은 펼쳐진다
      'rg -c "a b" file',                  // 큰따옴표는 «글자 그대로»가 아니다
      'grep -c * p file',                  // 글로브 확장이 «옵션»을 집어넣을 수 있다(-v 라는 파일)
      'rg -c ^export src/a.ts',            // zsh EXTENDED_GLOB 에서 ^ 는 글로브 연산자다
      "rg -c 'unclosed file",              // 짝이 안 맞는 따옴표
    ]) {
      expect(warnsAbsenceCount(countAsk('센다', observation, '패턴이 없다'))).toBe(false);
    }
    // ⊕ 대조군 — 작은따옴표 «안»은 셸이 아무것도 하지 않는다(메타문자도 패턴의 일부다)
    expect(warnsAbsenceCount(countAsk('센다', "grep -c 'a|b' file", '패턴이 없다'))).toBe(true);
    expect(warnsAbsenceCount(countAsk('센다', "grep -c '^export' src/a.ts", '패턴이 없다'))).toBe(true);
  // ⛔ CLI 자식 «아홉» — 러너 기본 5s 를 넘긴다 ⇒ 최악(9s) + 여유
  }, 20_000);

  it('주어를 «접미»가 아니라 «절 전체»로 본다 — 「오류 수는 0」은 매치 수가 아니다', () => {
    expect(warnsAbsenceCount(countAsk('센다', 'rg -c p src/a.ts', '2건이며 오류 수는 0이다'))).toBe(false);
    // ⭐ 9라운드 — 관형어를 «모양»으로 허용하던 와일드카드가 「누락된 항목이 0」을 통과시켰다.
    //   ⇒ 없앴다. 이제 낱말은 «전부» 닫힌 표 안에 있어야 한다(대가는 놓침이다).
    expect(warnsAbsenceCount(countAsk('센다', 'rg -c p src/a.ts', '누락된 항목이 0'))).toBe(false);
    expect(warnsAbsenceCount(countAsk('센다', 'rg -c p src/a.ts', '일치하는 줄이 0'))).toBe(false);
    // ⊕ 대조군 — 절이 «전부» 세는 말이면 여전히 잡힌다
    expect(warnsAbsenceCount(countAsk('센다', 'rg -c p src/a.ts', '매치 수가 0이다'))).toBe(true);
  });

  // ⭐ 6라운드 리뷰 must-fix — 「부재처럼 «보이는» 조각」을 찾는 방식은 그 조각을 «뒤집는 말»을 못 센다.
  //   ⇒ 기대 쪽도 관측 쪽(옵션 표)과 같은 방향으로 뒤집었다 — «형태 허용 목록».
  it('비교식과 부정 표현은 부재 기대가 «아니다»', () => {
    expect(warnsAbsenceCount(countAsk('센다', 'rg -c p src/a.ts', '0 < 매치 수'))).toBe(false);
    expect(warnsAbsenceCount(countAsk('센다', 'rg -c p src/a.ts', '부재가 아니라 2건이다'))).toBe(false);
    expect(warnsAbsenceCount(countAsk('센다', 'rg -c p src/a.ts', '0보다 크다'))).toBe(false);
    // ⊕ 대조군 — 「세는 주어 ⊕ 0/부재 ⊕ 맺는 말」만으로 된 기대는 여전히 잡힌다
    expect(warnsAbsenceCount(countAsk('센다', 'rg -c p src/a.ts', '매치가 없다'))).toBe(true);
  });

  it('「종료 코드 0」의 0 은 «매치 수»가 아니다 — 정상 신호에 거짓 경고가 안 난다', () => {
    expect(warnsAbsenceCount(countAsk('매치가 있다', 'rg -c pattern src/a.ts', '종료 코드 0 이고 매치가 존재한다'))).toBe(false);
    // ⊕ 대조군 — «매치 수»가 0이면 여전히 잡힌다
    expect(warnsAbsenceCount(countAsk('매치가 없다', 'rg -c pattern src/a.ts', '0 이다'))).toBe(true);
  });

  it('「0 이 아니다」류는 «양수 기대»다 — 단위·조사가 끼어도 부재가 아니다', () => {
    expect(warnsAbsenceCount(countAsk('센다', 'rg -c p src/a.ts', '0건은 아니다'))).toBe(false);
    expect(warnsAbsenceCount(countAsk('센다', 'rg -c p src/a.ts', '0건이 아니다'))).toBe(false);
    // ⊕ 대조군 — 진짜 부재는 여전히 잡힌다
    expect(warnsAbsenceCount(countAsk('센다', 'rg -c p src/a.ts', '0건이다'))).toBe(true);
    expect(warnsAbsenceCount(countAsk('센다', 'rg -c p src/a.ts', '없다'))).toBe(true);
  });

  it('네 조건 조합의 CLI는 둘 다 참일 때만 경고하고 항상 rc와 기존 축 계약을 보존한다', () => {
    const bothTrue = ask('src/ 를 고치지 않는다.', 'bun test scripts/ask-marker-check.test.ts');
    const absenceOnly = ask('새 경계는 없다.', 'bun test scripts/ask-marker-check.test.ts');
    const unobservedOnly = `${HEAD.join('\n')}\n경계: src/ 를 고치지 않는다.\n판정 신호: 조건 = 기존 값을 본다; 관측 = bun test scripts/ask-marker-check.test.ts; 기대 = 통과한다`;
    const neither = `${HEAD.join('\n')}\n경계: scripts/ 를 고치지 않는다.\n판정 신호: 조건 = 기존 값을 본다; 관측 = bun test scripts/ask-marker-check.test.ts; 기대 = 통과한다`;

    for (const [source, warns] of [[bothTrue, true], [absenceOnly, false], [unobservedOnly, false], [neither, false]] as const) {
      const r = runCli(source);
      expect(r.status).toBe(0);
      expect(r.stdout.includes('⚠️ 어디까지 사나')).toBe(warns);
      expect(r.stdout).toContain('✅ 불변식');
      expect(r.stdout).toContain('✅ 경계');
      expect(r.stdout).toContain('✅ 판정 신호');
      expect(finalNonblankLine(r.stdout)).toBe('✅ 1개 파일이 마커를 온전히 갖고 있다 — 발사해도 된다.');
    }
  }, 15_000);

  it('실재하지 않는 경계는 무시하고 판정 신호가 실재 경계를 관측하면 경고하지 않는다', () => {
    const nonexistent = ask('no/such/repository-path/ 를 고치지 않는다.', 'bun test scripts/ask-marker-check.test.ts');
    const observed = ask('scripts/ 를 고치지 않는다.', 'bun test scripts/ask-marker-check.test.ts');
    const separatelyBackticked = ask('src/ 를 고치지 않는다.', '`rg pattern` `src/`');

    expect(inspectConsumerPathWarning(nonexistent)).toBeUndefined();
    expect(inspectConsumerPathWarning(observed)).toBeUndefined();
    expect(inspectConsumerPathWarning(separatelyBackticked)).toBeUndefined();
    expect(runCli(separatelyBackticked).stdout).not.toContain('어디까지 사나');
  });

  it('셸 명령 안의 세미콜론 뒤에 든 경계 관측은 CLI 경고를 내지 않는다', () => {
    const source = ask('src/ 를 고치지 않는다.', "sh -c 'rg foo scripts/; rg bar src/'");
    const r = runCli(source);

    expect(inspectConsumerPathWarning(source)).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('⚠️ 어디까지 사나');
    expect(r.stdout).toContain('✅ 불변식');
    expect(r.stdout).toContain('✅ 경계');
    expect(r.stdout).toContain('✅ 판정 신호');
    expect(finalNonblankLine(r.stdout)).toBe('✅ 1개 파일이 마커를 온전히 갖고 있다 — 발사해도 된다.');
  });

  it('관측 명령 안의 인용된 세미콜론과 기대 문자열을 저자 부재 선언으로 오인하지 않는다', () => {
    const source = `${HEAD.join('\n')}\n경계: scripts/ 를 고치지 않는다.\n판정 신호: 조건 = 확인; 관측 = rg '; 기대 = 지금은 없다' src/; 기대 = 통과한다`;
    const r = runCli(source);

    expect(inspectConsumerPathWarning(source)).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('⚠️ 어디까지 사나');
    expect(finalNonblankLine(r.stdout)).toBe('✅ 1개 파일이 마커를 온전히 갖고 있다 — 발사해도 된다.');
  });

  it('인용된 가짜 기대 필드만 있어도 저자 부재 선언으로 오인하지 않는다', () => {
    const source = `${HEAD.join('\n')}\n경계: scripts/ 를 고치지 않는다.\n판정 신호: 조건 = 확인; 관측 = rg '; 기대 = 지금은 없다' src/`;
    const r = runCli(source);

    expect(inspectConsumerPathWarning(source)).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('⚠️ 어디까지 사나');
  });

  it('이스케이프된 세미콜론 뒤 가짜 기대 필드를 저자 부재 선언으로 오인하지 않는다', () => {
    const source = `${HEAD.join('\n')}\n경계: scripts/ 를 고치지 않는다.\n판정 신호: 조건 = 확인; 관측 = rg -F \\;기대=지금은 없다 src/`;
    const r = runCli(source);

    expect(inspectConsumerPathWarning(source)).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('⚠️ 어디까지 사나');
    expect(finalNonblankLine(r.stdout)).toBe('✅ 1개 파일이 마커를 온전히 갖고 있다 — 발사해도 된다.');
  });

  it('작은따옴표 안의 백슬래시 뒤 닫는 따옴표를 실제 기대 필드보다 앞서 닫아 경고한다', () => {
    const source = `${HEAD.join('\n')}\n경계: scripts/ 를 고치지 않는다.\n판정 신호: 조건 = 확인; 관측 = rg -F '\\' src/; 기대 = 지금은 없다`;
    const r = runCli(source);

    expect(inspectConsumerPathWarning(source)).toBe('⚠️ 어디까지 사나 — scripts/: 판정 신호가 이 경계를 관측하지 않아 한 단계까지만 산다');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('⚠️ 어디까지 사나 — scripts/: 판정 신호가 이 경계를 관측하지 않아 한 단계까지만 산다');
    expect(finalNonblankLine(r.stdout)).toBe('✅ 1개 파일이 마커를 온전히 갖고 있다 — 발사해도 된다.');
  });

  it('저장소 루트 . 또는 ./ 관측은 하위 경계를 관측한 것으로 보고 CLI 경고를 내지 않는다', () => {
    for (const rootObservation of ['rg pattern .', 'rg pattern ./']) {
      const source = ask('src/ 를 고치지 않는다.', rootObservation);
      const r = runCli(source);

      expect(inspectConsumerPathWarning(source)).toBeUndefined();
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain('⚠️ 어디까지 사나');
      expect(r.stdout).toContain('✅ 불변식');
      expect(r.stdout).toContain('✅ 경계');
      expect(r.stdout).toContain('✅ 판정 신호');
      expect(finalNonblankLine(r.stdout)).toBe('✅ 1개 파일이 마커를 온전히 갖고 있다 — 발사해도 된다.');
    }
  });
});

describe('판정 신호 종류 — 구현을 문다', () => {
  const HEAD = ['대상 경로: a/b.ts', '불변식: a/b.ts 를 그대로 둔다.', '경계: c/d.ts 는 대상이 아니다.'];
  const ask = (...signals: string[]) => [...HEAD, ...signals].join('\n');
  const UNIT = '판정 신호: 조건 = X; 관측 = bun test a/b.test.ts; 기대 = 통과한다';
  const SAME = '판정 신호: 조건 = Y; 관측 = 같은 시험; 기대 = 유지된다';
  const REAL = '판정 신호: 조건 = 실물 CLI 를 돌린다; 관측 = 그 산출의 종료 코드; 기대 = 0 이다';

  it('관측이 전부 단위 시험이면 실물이 0이다', () => {
    const axis = inspectDecisionSignalKinds(ask(UNIT, SAME));
    expect({ total: axis.total, unitTestOnly: axis.unitTestOnly, realWorld: axis.realWorld })
      .toEqual({ total: 2, unitTestOnly: 2, realWorld: 0 });
    expect(formatAxis(axis)).toContain('실물 관측 0');
  });

  it('실물 관측이 섞이면 두 수가 갈린다', () => {
    const axis = inspectDecisionSignalKinds(ask(UNIT, REAL));
    expect({ unitTestOnly: axis.unitTestOnly, realWorld: axis.realWorld }).toEqual({ unitTestOnly: 1, realWorld: 1 });
  });

  it('다섯 관측 모양을 관측 축과 같은 분류로 세고 CLI의 연속 출력이 실물 수를 일치시킨다', () => {
    const signals = [
      '판정 신호: 조건 = direct; 관측 = bun test src/a.test.ts; 기대 = unit',
      '판정 신호: 조건 = env; 관측 = env ELANOUS_X=1 bun test src/a.test.ts; 기대 = unit',
      '판정 신호: 조건 = time; 관측 = time bun test src/a.test.ts; 기대 = unit',
      '판정 신호: 조건 = prose; 관측 = bun is worth investigating tomorrow; 기대 = unresolved',
      '판정 신호: 조건 = logs; 관측 = bun bin/elanous.mjs logs --since 1h; 기대 = real',
    ];
    const source = ask(...signals);
    const observationAxis = inspectDecisionObservations(source);
    const kindAxis = inspectDecisionSignalKinds(source);
    const r = runCli(source);

    expect(inspectDecisionSignalObservations(source).map(({ kind }) => kind))
      .toEqual(['unit-test', 'unit-test', 'unit-test', 'unresolved', 'real']);
    expect({
      unitTestOnly: kindAxis.unitTestOnly,
      realWorld: kindAxis.realWorld,
    }).toEqual({
      unitTestOnly: observationAxis.unitTestObservationCount,
      realWorld: observationAxis.realObservationCount,
    });
    expect(r.status).toBe(0);
    expectLinesInOrder(r.stdout, [
      '   ⚠️ 판정 신호 관측 — 판정 신호 5개: 단위 시험 실행 3개, 실물 관측 1개, 미결 관측 1개: bun is worth investigating tomorrow',
      '   ✅ 판정 신호 종류 — 5개 중 단위 시험 3 · 실물 1',
    ]);
  });

  it('판정 신호가 없으면 셋째 값으로 갈린다 — 「전부 단위 시험」과 «다른» 문면', () => {
    const axis = inspectDecisionSignalKinds(ask());
    expect(axis.total).toBe(0);
    expect(formatAxis(axis)).toContain('판정 신호가 없다');
  });

  it('⛔ 이 축은 «막지 않는다» — marker/extracted 가 항상 참이라 종료 코드를 안 바꾼다', () => {
    for (const axis of [inspectDecisionSignalKinds(ask()), inspectDecisionSignalKinds(ask(UNIT))]) {
      expect({ marker: axis.marker, extracted: axis.extracted }).toEqual({ marker: true, extracted: true });
    }
  });

  it('첫 낱말 명령꼴과 인자로 실물 관측을 분류하면서 기존 경계를 보존한다', () => {
    const observations = inspectDecisionSignalObservations(ask(
      '판정 신호: 조건 = rg; 관측 = `rg -n "pat" src/a.ts`; 기대 = real',
      '판정 신호: 조건 = rg; 관측 = `rg -o "pat" src/a.ts`; 기대 = real',
      '판정 신호: 조건 = rg Korean argument; 관측 = `rg 결과 src/`; 기대 = real',
      '판정 신호: 조건 = printf Korean argument; 관측 = `printf 개수`; 기대 = real',
      '판정 신호: 조건 = unknown; 관측 = `ffmpeg -version`; 기대 = real',
      '판정 신호: 조건 = pipe; 관측 = `git diff --name-only origin/main...HEAD -- src/ | wc -l`; 기대 = real',
      '판정 신호: 조건 = time; 관측 = `time bun test src/a.test.ts`; 기대 = unit-test',
      "판정 신호: 조건 = redirect; 관측 = `printf 'x' > /tmp/a`; 기대 = real",
      '판정 신호: 조건 = unit; 관측 = `bun test test/a.test.ts`; 기대 = unit-test',
      '판정 신호: 조건 = identifier; 관측 = dashboardDefaultShootRunOptions.maxPollsPerJob; 기대 = unresolved',
      '판정 신호: 조건 = identifier; 관측 = plan; 기대 = unresolved',
      '판정 신호: 조건 = identifier; 관측 = inspectAskMarkers; 기대 = unresolved',
      '판정 신호: 조건 = Korean; 관측 = 그 인자를 지우고 다시 돌린다; 기대 = unresolved',
      '판정 신호: 조건 = narrative; 관측 = 그 명령의 종료 코드; 기대 = real',
    ));

    expect(observations.map(({ kind }) => kind)).toEqual([
      'real', 'real', 'real', 'real', 'real', 'real', 'unit-test', 'real', 'unit-test',
      'unresolved', 'unresolved', 'unresolved', 'unresolved', 'real',
    ]);
  });

  it('추가 실행기 명령은 실물로 넓히되 단위 시험 우선과 비명령 접두사의 미결을 보존한다', () => {
    const observations = inspectDecisionSignalObservations(ask(
      '판정 신호: 조건 = bun-run; 관측 = `bun run build`; 기대 = real',
      '판정 신호: 조건 = bun-e; 관측 = `bun -e "console.log(1)"`; 기대 = real',
      '판정 신호: 조건 = bun-script; 관측 = `bun scripts/ux-sim.ts --esc 3`; 기대 = real',
      '판정 신호: 조건 = python; 관측 = `python3 scripts/check.py`; 기대 = real',
      '판정 신호: 조건 = python-bare; 관측 = `python3 scripts/tool`; 기대 = real',
      '판정 신호: 조건 = shell; 관측 = `bash scripts/check.sh`; 기대 = real',
      '판정 신호: 조건 = shell-bare; 관측 = `bash scripts/check`; 기대 = real',
      '판정 신호: 조건 = shell; 관측 = `sh scripts/check.sh`; 기대 = real',
      '판정 신호: 조건 = shell-relative; 관측 = `sh ./deploy`; 기대 = real',
      '판정 신호: 조건 = curl; 관측 = `curl -s https://example.test`; 기대 = real',
      '판정 신호: 조건 = curl-local; 관측 = `curl localhost:8080`; 기대 = real',
      '판정 신호: 조건 = local; 관측 = `./gradlew test`; 기대 = real',
      '판정 신호: 조건 = unit-run; 관측 = `bun run test:deterministic`; 기대 = unit-test',
      '판정 신호: 조건 = identifier; 관측 = fail 개수; 기대 = unresolved',
      '판정 신호: 조건 = identifier; 관측 = 산출; 기대 = unresolved',
      '판정 신호: 조건 = identifier; 관측 = 그 수; 기대 = unresolved',
      '판정 신호: 조건 = identifier; 관측 = git-status 개수; 기대 = unresolved',
      '판정 신호: 조건 = identifier; 관측 = curl.result; 기대 = unresolved',
      '판정 신호: 조건 = identifier; 관측 = python3_count; 기대 = unresolved',
      '판정 신호: 조건 = identifier; 관측 = python3 결과; 기대 = unresolved',
      '판정 신호: 조건 = identifier; 관측 = bash_result; 기대 = unresolved',
      '판정 신호: 조건 = identifier; 관측 = sh 결과; 기대 = unresolved',
      '판정 신호: 조건 = identifier; 관측 = curl 결과; 기대 = unresolved',
    ));

    expect(observations.map(({ kind }) => kind)).toEqual([
      'real', 'real', 'real', 'real', 'real', 'real', 'real', 'real', 'real', 'real', 'real', 'real',
      'unit-test', 'unresolved', 'unresolved', 'unresolved', 'unresolved', 'unresolved', 'unresolved', 'unresolved',
      'unresolved', 'unresolved', 'unresolved',
    ]);
  });

  it('실물 없이 단위 시험과 미결이 섞이면 종류 문면이 두 수를 정직하게 말한다', () => {
    const axis = inspectDecisionSignalKinds(ask(
      ...Array.from({ length: 6 }, (_, index) => `판정 신호: 조건 = unit-${index}; 관측 = bun test a/${index}.test.ts; 기대 = 통과한다`),
      '판정 신호: 조건 = unresolved; 관측 = fail 개수; 기대 = 0',
    ));

    expect(formatAxis(axis).split('\n')[0]).toBe('⚠️ 판정 신호 종류 — 7개 중 단위 시험 6 · 미결 1 (실물 관측 0) — 값이 «실행 경로»로 흘렀다는 것을 무엇이 증명하나');
  });

  it('단위 시험이 없는 미결 관측도 CLI에서 전부 단위 시험이라고 부르지 않는다', () => {
    const source = ask(
      '판정 신호: 조건 = first; 관측 = fail 개수; 기대 = 0',
      '판정 신호: 조건 = second; 관측 = 산출; 기대 = 있다',
    );
    const r = runCli(source);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('⚠️ 판정 신호 종류 — 2개 중 단위 시험 0 · 미결 2 (실물 관측 0) — 값이 «실행 경로»로 흘렀다는 것을 무엇이 증명하나');
    expect(r.stdout).not.toContain('2개가 «전부» 단위 시험이다');
  });

  it('🩸 없는 뿌리에서는 던지지 않고 판정 신호 시험 경로를 «안 쟀다»로 낸다 — «0개 매치»가 아니다', () => {
    const missingRoot = join(tmpdir(), `ask-marker-missing-root-${process.pid}-${Date.now()}`);
    let axes: ReturnType<typeof inspectAskMarkersInRoot> | undefined;
    expect(() => { axes = inspectAskMarkersInRoot(ask('판정 신호: 조건 = x; 관측 = bun test src/a.test.ts; 기대 = 통과'), missingRoot); }).not.toThrow();
    const axis = axes!.find((a) => a.label === '판정 신호 시험 경로')!;
    const line = formatAxis(axis);
    expect(line).toContain('못 훑었다');
    expect(line).toContain('안 쟀다');
    expect(line).not.toContain('못 문다');
    expect(formatAxisObservations(axis)).toEqual([]);
  });

  it('기존 여덟 축 순서를 보존하고 대상 경로 축을 그 뒤에 더한다', () => {
    expect(inspectAskMarkers(ask(UNIT)).map((axis) => axis.label))
      .toEqual(['불변식', '경계', '판정 신호', 'GoalType 머리 블록', '불변식 경로', '판정 신호 시험 경로', '판정 신호 관측', '판정 신호 종류', '대상 경로']);
  });

  it('🅕 2026-09-23 — 시험 디렉토리에서 join 한 «실제 스크립트»를 spawn 하면 real (한 단계 간접까지) · 임시 픽스처와 없는 파일은 아니다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-marker-join-'));
    try {
      writeFileSync(join(dir, 'tool.sh'), '#!/bin/sh\necho ok\n');
      const cases: Array<[string, string, boolean]> = [
        ['alias.test.ts', "import { join } from 'node:path';\nconst ROOT = import.meta.dir;\nconst SCRIPT = join(ROOT, 'tool.sh');\nBun.spawnSync(['zsh', SCRIPT]);\n", true],
        ['direct.test.ts', "import { join } from 'node:path';\nconst SCRIPT = join(import.meta.dir, 'tool.sh');\nBun.spawnSync(['sh', SCRIPT]);\n", true],
        ['dirname.test.ts', "import { dirname, resolve } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nconst HERE = dirname(fileURLToPath(import.meta.url));\nconst SCRIPT = resolve(HERE, 'tool.sh');\nBun.spawnSync(['sh', SCRIPT]);\n", true],
        ['tmpfixture.test.ts', "import { join } from 'node:path';\nconst tmp = mkdtempSync('x');\nconst SCRIPT = join(tmp, 'tool.sh');\nBun.spawnSync(['sh', SCRIPT]);\n", false],
        ['missing.test.ts', "import { join } from 'node:path';\nconst SCRIPT = join(import.meta.dir, 'nope.sh');\nBun.spawnSync(['sh', SCRIPT]);\n", false],
        ['nospawn.test.ts', "import { join } from 'node:path';\nconst SCRIPT = join(import.meta.dir, 'tool.sh');\nconsole.log(SCRIPT);\n", false],
      ];
      for (const [name, source, expected] of cases) {
        writeFileSync(join(dir, name), source);
        expect({ name, real: bunTestFileLaunchesRepositoryExecutable(join(dir, name)) }).toEqual({ name, real: expected });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!existsSync(join(repositoryRoot, 'scripts/webclone/loop/ruler-stability.test.ts')))('🅕 private webclone 실물 표본 — ruler-stability.test.ts 는 실물 셸 스크립트를 spawn 한다', () => {
    expect(bunTestFileLaunchesRepositoryExecutable('scripts/webclone/loop/ruler-stability.test.ts')).toBe(true);
  });

  it('실물 관측 0 경고는 «흔들리는 기존 파일로 옮기지 말고 결정적인 실물 시험을 만들라»까지 말한다', () => {
    const r = runCli(ask('판정 신호: 조건 = first; 관측 = fail 개수; 기대 = 0'));
    expect(r.stdout).toContain('빨강 조합이 흔들리는 파일로 옮기면 착지가 막힌다');
    expect(r.stdout).toContain('결정적이면서 실물을 무는 시험을 «만든다»');
  });

  it('저장소 실행물을 spawn 하는 bun test 파일은 real 이고 순수 픽스처와 없는 파일은 unit-test 다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-marker-harness-'));
    const harness = join(dir, 'harness.test.ts');
    const fixture = join(dir, 'fixture.test.ts');
    const missing = join(dir, 'missing.test.ts');
    try {
      writeFileSync(harness, "import { spawnSync } from 'node:child_process';\nspawnSync('/bin/bash', ['scripts/install.sh']);\n");
      writeFileSync(fixture, "import { expect, it } from 'bun:test';\nit('pure', () => expect(1).toBe(1));\n");
      expect(bunTestFileLaunchesRepositoryExecutable(harness)).toBe(true);
      expect(bunTestFileLaunchesRepositoryExecutable(fixture)).toBe(false);
      expect(bunTestFileLaunchesRepositoryExecutable(missing)).toBe(false);
      expect(() => bunTestFileLaunchesRepositoryExecutable(missing)).not.toThrow();

      const kinds = inspectDecisionSignalObservations(ask(
        `판정 신호: 조건 = harness; 관측 = bun test ${harness}; 기대 = real`,
        `판정 신호: 조건 = fixture; 관측 = bun test ${fixture}; 기대 = unit-test`,
        `판정 신호: 조건 = missing; 관측 = bun test ${missing}; 기대 = unit-test`,
        '판정 신호: 조건 = logs; 관측 = bun bin/elanous.mjs logs --since 1h; 기대 = real',
        '판정 신호: 조건 = prose; 관측 = bun is worth investigating tomorrow; 기대 = unresolved',
      )).map(({ kind }) => kind);
      expect(kinds).toEqual(['real', 'unit-test', 'unit-test', 'real', 'unresolved']);
      expect(kinds[0]).not.toBe('unit-test');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('변수에 묶인 저장소 실행물을 spawn 하는 시험도 real 이고 픽스처 바인딩은 아니다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-marker-bound-'));
    const relativePrefix = join(dir, 'relative-prefix.test.ts');
    const installBound = join(dir, 'install-bound.test.ts');
    const fixtureBound = join(dir, 'fixture-bound.test.ts');
    try {
      writeFileSync(relativePrefix, [
        "import { spawnSync } from 'node:child_process';",
        "spawnSync('./install.sh', []);",
        "Bun.spawn(['./bin/elanous.mjs']);",
        "execFileSync('./scripts/check.ts');",
        '',
      ].join('\n'));
      writeFileSync(installBound, [
        "import { spawnSync } from 'node:child_process';",
        "import { resolve } from 'node:path';",
        "const installer = resolve(import.meta.dir, 'install.sh');",
        'spawnSync(process.execPath, [installer]);',
        '',
      ].join('\n'));
      writeFileSync(fixtureBound, [
        "import { spawnSync } from 'node:child_process';",
        "import { resolve } from 'node:path';",
        "const fixture = resolve(import.meta.dir, 'fixture.ts');",
        'spawnSync(process.execPath, [fixture]);',
        '',
      ].join('\n'));
      expect(bunTestFileLaunchesRepositoryExecutable(relativePrefix)).toBe(true);
      expect(bunTestFileLaunchesRepositoryExecutable(installBound)).toBe(true);
      expect(bunTestFileLaunchesRepositoryExecutable(fixtureBound)).toBe(false);
      expect(inspectDecisionSignalObservations(ask(
        `판정 신호: 조건 = bound; 관측 = bun test ${installBound}; 기대 = real`,
        `판정 신호: 조건 = fixture-bound; 관측 = bun test ${fixtureBound}; 기대 = unit-test`,
      )).map(({ kind }) => kind)).toEqual(['real', 'unit-test']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('이 시험 파일을 가리키는 bun test 관측은 실물 하니스로 real 이다', () => {
    const self = relative(repositoryRoot, fileURLToPath(import.meta.url));
    const observations = inspectDecisionSignalObservations(ask(
      `판정 신호: 조건 = self; 관측 = bun test ${self}; 기대 = real`,
    ));
    expect(observations.map(({ kind }) => kind)).toEqual(['real']);
    expect(bunTestFileLaunchesRepositoryExecutable(self)).toBe(true);
  });
});

describe('판정 신호 시험 경로 — CLI 배선', () => {
  const HEAD = ['대상 경로: scripts/ask-marker-check.ts', '불변식: scripts/ask-marker-check.ts 를 그대로 둔다.', '경계: 다른 파일은 대상이 아니다.'];
  const ask = (observation: string) => [...HEAD, `판정 신호: 조건 = 경로를 본다; 관측 = ${observation}; 기대 = 출력한다`].join('\n');

  it('전부 못 무는 경로는 경고 요약과 기존 개별 진단을 내면서 exit 0을 유지한다', () => {
    const r = runCli(ask('bun test src/oauth/codex-account-mirror.test.ts'));

    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`⚠️ 판정 신호 시험 경로 — 1개 경로가 «${shortRoot(repositoryRoot)}»의 파일을 못 문다 (0/1개 경로가 파일 0개를 문다)`);
    expect(r.stdout).toContain(`⚠️ 판정 신호 시험 경로 — «${shortRoot(repositoryRoot)}»에서 0개 매치: src/oauth/codex-account-mirror.test.ts`);
    expect(r.stdout).toContain('test/oauth/codex-account-mirror.test.ts');
  });

  it('일부만 못 무는 경로는 그 수를 경고 요약으로 낸다', () => {
    const r = runCli(ask('bun test scripts/ask-marker-check.test.ts src/oauth/codex-account-mirror.test.ts'));

    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`⚠️ 판정 신호 시험 경로 — 1개 경로가 «${shortRoot(repositoryRoot)}»의 파일을 못 문다 (1/2개 경로가 파일 1개를 문다)`);
    expect(r.stdout).toContain(`ℹ️ 판정 신호 시험 경로 — «${shortRoot(repositoryRoot)}»에서 scripts/ask-marker-check.test.ts: 1개 파일 매치`);
    expect(r.stdout).toContain(`⚠️ 판정 신호 시험 경로 — «${shortRoot(repositoryRoot)}»에서 0개 매치: src/oauth/codex-account-mirror.test.ts; 같은 파일 이름의 실제 경로: test/oauth/codex-account-mirror.test.ts`);
  });

  it('어디에도 없는 파일은 경고가 아닌 만들 파일 정보로 내되 요약은 못 무는 수를 경고한다', () => {
    const r = runCli(ask('bun test test/brand-new-thing.test.ts'));

    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`⚠️ 판정 신호 시험 경로 — 1개 경로가 «${shortRoot(repositoryRoot)}»의 파일을 못 문다 (0/1개 경로가 파일 0개를 문다)`);
    expect(r.stdout).toContain(`ℹ️ 판정 신호 시험 경로 — «${shortRoot(repositoryRoot)}»에서 0개 매치: test/brand-new-thing.test.ts; 이 골이 만들 파일로 읽는다`);
    expect(r.stdout).not.toContain(`⚠️ 판정 신호 시험 경로 — «${shortRoot(repositoryRoot)}»에서 0개 매치: test/brand-new-thing.test.ts`);
  });

  it('bun test 경로가 없으면 기존 정보 요약과 exit 0을 유지한다', () => {
    const r = runCli(ask('실물 CLI를 실행한다'));

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ℹ️ 판정 신호 시험 경로 — bun test 경로가 없다');
  });

  it('별표와 중괄호 글롭을 확장해 실제 매치를 0개로 오분류하지 않는다', () => {
    const r = runCli(ask('bun test scripts/{ask-marker-check,ask-marker-check}.test.ts scripts/ask-marker-*.test.ts'));

    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`✅ 판정 신호 시험 경로 — 2/2개 경로가 «${shortRoot(repositoryRoot)}»의 파일 2개를 문다`);
    expect(r.stdout).toContain(`ℹ️ 판정 신호 시험 경로 — «${shortRoot(repositoryRoot)}»에서 scripts/{ask-marker-check,ask-marker-check}.test.ts: 1개 파일 매치`);
    expect(r.stdout).toContain(`ℹ️ 판정 신호 시험 경로 — «${shortRoot(repositoryRoot)}»에서 scripts/ask-marker-*.test.ts: 1개 파일 매치`);
    expect(r.stdout).not.toContain('0개 매치');
  });

  it('값을 받는 긴·짧은 bun test 옵션은 경로로 오인하지 않는다', () => {
    const r = runCli(ask('bun test --test-name-pattern rotation -t rotation scripts/ask-marker-check.test.ts'));

    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`✅ 판정 신호 시험 경로 — 1/1개 경로가 «${shortRoot(repositoryRoot)}»의 파일 1개를 문다`);
    expect(r.stdout).not.toContain('rotation; 이 골이 만들 파일');
  });

  it('--preload의 값은 시험 경로와 파일 매치 수에서 제외한다', () => {
    const r = runCli(ask('bun test --preload ./setup.ts scripts/ask-marker-check.test.ts'));

    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`✅ 판정 신호 시험 경로 — 1/1개 경로가 «${shortRoot(repositoryRoot)}»의 파일 1개를 문다`);
    expect(r.stdout).not.toContain('./setup.ts');
  });

  it('셸 명령 경계 뒤의 후속 명령을 시험 경로로 오인하지 않는다', () => {
    const r = runCli(ask('bun test scripts/ask-marker-check.test.ts && echo done'));

    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`✅ 판정 신호 시험 경로 — 1/1개 경로가 «${shortRoot(repositoryRoot)}»의 파일 1개를 문다`);
    expect(r.stdout).not.toContain('echo; 이 골이 만들 파일');
    expect(r.stdout).not.toContain('done; 이 골이 만들 파일');
  });

  it('새 축이 기존 마커 실패 exit 1 계약을 바꾸지 않는다', () => {
    const r = runCli(`${HEADING_FORM}\n판정 신호: 조건 = 경로를 본다; 관측 = bun test test/brand-new-thing.test.ts; 기대 = 정보다`);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`ℹ️ 판정 신호 시험 경로 — «${shortRoot(repositoryRoot)}»에서 0개 매치: test/brand-new-thing.test.ts; 이 골이 만들 파일로 읽는다`);
  });
});

describe('좁힌 시험 신호 — 비차단 경고', () => {
  const HEAD = ['대상 경로: scripts/ask-marker-check.ts', '불변식: scripts/ask-marker-check.ts 를 그대로 둔다.', '경계: 다른 파일은 대상이 아니다.'];
  const ask = (...signals: string[]) => [...HEAD, ...signals].join('\n');
  const narrowAsk = (observation: string) => ask(`판정 신호: 조건 = x; 관측 = ${observation}; 기대 = 0 fail`);
  const warns = (source: string): boolean => runCli(source).stdout.includes('⚠️ 좁힌 시험 신호');

  // ⛔ 이 축은 «세지 않는다» — 세려면 Bun 의 시험 이름 의미를 재현해야 하고, 그래도 skip 은 못 가른다.
  //   📏 실측: 이름이 0건을 물어도 · skip 이어도 · 실재해도 «셋 다 rc=0» 이다.
  it('`-t` 와 `--test-name-pattern` 을 알아본다 — 붙임형도', () => {
    // ⚠️ 짧은 옵션은 «붙여» 쓸 수 있다 — `-tname` 도 `-t name` 과 같다(리뷰 지적).
    // ⛔ 여덟 사례를 «전부» 넣는다 — 앞 판은 넷만 넣어 `-t=name` 과 `--test-name-pattern name` 이 빠졌다(리뷰 지적).
    for (const observation of [
      "bun test src/a.test.ts -t 'name'",
      'bun test src/a.test.ts -tname',
      'bun test src/a.test.ts -t=name',
      'bun test src/a.test.ts --test-name-pattern name',
      'bun test src/a.test.ts --test-name-pattern=name',
    ]) {
      expect(warns(narrowAsk(observation))).toBe(true);
    }
  // ⛔ CLI 자식 셋 — 러너 기본 5s 를 넘길 수 있다
  }, 15_000);

  it('좁히지 «않은» 신호에는 안 뜬다 — 대조군', () => {
    // ⊕ `--timeout` 은 «이름 좁힘이 아니다» — 접두로 넓게 잡아도 긴 옵션은 안 문다
    for (const observation of ['bun test src/a.test.ts', 'bun test src/a.test.ts --timeout 5000', 'rg -c pattern src/a.ts']) {
      expect(warns(narrowAsk(observation))).toBe(false);
    }
  }, 15_000);

  it('순번을 말하고, 종료 코드를 바꾸지 «않는다»', () => {
    const source = ask('판정 신호: 조건 = a; 관측 = bun test src/a.test.ts; 기대 = 0 fail', "판정 신호: 조건 = b; 관측 = bun test src/b.test.ts -t 'x'; 기대 = 0 fail");
    const r = runCli(source);
    expect(inspectNarrowedTestSignalWarnings(source)).toEqual([
      '⚠️ 좁힌 시험 신호 — 2번째 신호는 이름이 하나도 안 맞아도 종료 코드가 0이다; 발사 전에 그 명령을 한 번 돌려 N pass의 N ≥ 1을 확인하라.',
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('2번째 신호는 이름이 하나도 안 맞아도 종료 코드가 0이다');
  });
});

describe('부재 count 신호 — 비차단 경고', () => {
  const HEAD = ['대상 경로: scripts/ask-marker-check.ts', '불변식: scripts/ask-marker-check.ts 를 그대로 둔다.', '경계: 다른 파일은 대상이 아니다.'];
  const ask = (...signals: string[]) => [...HEAD, ...signals].join('\n');

  it('rg -c와 grep -c의 0·부재·사라짐 기대를 순번, 빨강 원인, bun test 래칫 처방과 함께 경고하지만 발사를 막지 않는다', () => {
    const source = ask(
      '판정 신호: 조건 = 있다; 관측 = rg -c pattern src/present.ts; 기대 = 1 이상이다',
      '판정 신호: 조건 = 없다; 관측 = rg -c pattern src/a.ts; 기대 = 0 이다',
      '판정 신호: 조건 = 없음; 관측 = rg -c pattern src/none.ts; 기대 = 없음',
      '판정 신호: 조건 = 부재; 관측 = grep -c pattern src/absent.ts; 기대 = 패턴이 없어야 한다',
      '판정 신호: 조건 = 사라짐; 관측 = grep -c pattern src/b.ts; 기대 = 패턴이 사라진다',
      '판정 신호: 조건 = 사라져야 함; 관측 = rg -c pattern src/c.ts; 기대 = 패턴이 사라져야 한다',
    );
    const r = runCli(source);

    expect(inspectAbsenceCountSignalWarnings(source)).toEqual([
      '⚠️ 부재 count 신호 — 2번째 신호는 원하는 결과에서 종료 코드 1이 되어 빨강이 된다; 부재는 bun test로 단언하라(래칫).',
      '⚠️ 부재 count 신호 — 3번째 신호는 원하는 결과에서 종료 코드 1이 되어 빨강이 된다; 부재는 bun test로 단언하라(래칫).',
      '⚠️ 부재 count 신호 — 4번째 신호는 원하는 결과에서 종료 코드 1이 되어 빨강이 된다; 부재는 bun test로 단언하라(래칫).',
      '⚠️ 부재 count 신호 — 5번째 신호는 원하는 결과에서 종료 코드 1이 되어 빨강이 된다; 부재는 bun test로 단언하라(래칫).',
      '⚠️ 부재 count 신호 — 6번째 신호는 원하는 결과에서 종료 코드 1이 되어 빨강이 된다; 부재는 bun test로 단언하라(래칫).',
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('⚠️ 부재 count 신호 — 2번째 신호는 원하는 결과에서 종료 코드 1이 되어 빨강이 된다; 부재는 bun test로 단언하라(래칫).');
    expect(r.stdout).toContain('⚠️ 부재 count 신호 — 3번째 신호는 원하는 결과에서 종료 코드 1이 되어 빨강이 된다; 부재는 bun test로 단언하라(래칫).');
    expect(finalNonblankLine(r.stdout)).toBe('✅ 1개 파일이 마커를 온전히 갖고 있다 — 발사해도 된다.');
  });

  it('1 이상 기대와 bun test 관측에는 부재 count 거짓 경고를 내지 않는다', () => {
    const source = ask(
      '판정 신호: 조건 = 있다; 관측 = rg -c pattern src/a.ts; 기대 = 1 이상이다',
      '판정 신호: 조건 = 양수; 관측 = grep -c pattern src/positive.ts; 기대 = 0보다 크다(1 이상)',
      '판정 신호: 조건 = 음성 양수; 관측 = rg -c pattern src/nonzero.ts; 기대 = 0이 아닌 양수',
      '판정 신호: 조건 = 부정 0; 관측 = grep -c pattern src/not-zero.ts; 기대 = 0이 아니다',
      '판정 신호: 조건 = 부정 0; 관측 = rg -c pattern src/must-not-zero.ts; 기대 = 0은 아니어야 한다',
      '판정 신호: 조건 = 음성 양수; 관측 = grep -c pattern src/positive-count.ts; 기대 = 0보다 큰 양수',
      '판정 신호: 조건 = 소수 양수; 관측 = rg -c pattern src/decimal.ts; 기대 = 1.0 이상',
      '판정 신호: 조건 = 시험; 관측 = bun test scripts/ask-marker-check.test.ts; 기대 = 0 fail',
    );
    const r = runCli(source);

    expect(inspectAbsenceCountSignalWarnings(source)).toEqual([]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('⚠️ 부재 count 신호');
  });

  it('옵션 종료자 뒤의 -c 패턴과 값 옵션의 -c 및 붙임 인자를 count 관측으로 오인하지 않는다', () => {
    const source = ask(
      '판정 신호: 조건 = 패턴; 관측 = rg -- -c src/a.ts; 기대 = 0',
      '판정 신호: 조건 = 정규식; 관측 = grep -e -c src/a.ts; 기대 = 없음',
      '판정 신호: 조건 = 붙임 정규식; 관측 = rg -eabc src/a.ts; 기대 = 0',
      '판정 신호: 조건 = 파일; 관측 = rg -f -c src/a.ts; 기대 = 0',
      '판정 신호: 조건 = 정상; 관측 = rg -c pattern src/a.ts; 기대 = 0',
    );
    const r = runCli(source);

    expect(inspectAbsenceCountSignalWarnings(source)).toEqual([
      '⚠️ 부재 count 신호 — 5번째 신호는 원하는 결과에서 종료 코드 1이 되어 빨강이 된다; 부재는 bun test로 단언하라(래칫).',
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('⚠️ 부재 count 신호 — 5번째 신호는 원하는 결과에서 종료 코드 1이 되어 빨강이 된다; 부재는 bun test로 단언하라(래칫).');
  });
});

describe('안 눌릴 신호 — canonical parser CLI 배선', () => {
  const HEAD = ['대상 경로: scripts/ask-marker-check.ts', '불변식: scripts/ask-marker-check.ts 를 그대로 둔다.', '경계: 다른 파일은 대상이 아니다.'];
  const ask = (...signals: string[]) => [...HEAD, ...signals].join('\n');

  it('같은 시험은 순번과 원문을 경고하지만 발사를 막지 않는다', () => {
    const r = runCli(ask('판정 신호: 조건 = 축약; 관측 = 같은 시험; 기대 = 유지된다'));

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('⚠️ 안 눌릴 신호 — 안 눌릴 신호 1개 / 전체 1개');
    expect(r.stdout).toContain('⚠️ 안 눌릴 신호 — 1번째 신호는 안전하게 읽을 수 없다: 같은 시험');
  });

  it('축약 거절에는 명령 전체 반복 처방을 낸다', () => {
    const r = runCli(ask('판정 신호: 조건 = 축약; 관측 = 위와 같다; 기대 = 유지된다'));

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('⚠️ 안 눌릴 신호 — 1번째 신호는 안전하게 읽을 수 없다: 위와 같다');
    expect(r.stdout).toContain('ℹ️ 안 눌릴 신호 — 1번째 신호 처방: 축약하지 말고 명령을 통째로 반복하라');
  });

  it('자리표시자 거절에는 실제 경로 명시 처방을 낸다', () => {
    const r = runCli(ask('판정 신호: 조건 = 자리표시자; 관측 = bun test <그 파일>; 기대 = 유지된다'));

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('⚠️ 안 눌릴 신호 — 1번째 신호는 안전하게 읽을 수 없다: bun test <그 파일>');
    expect(r.stdout).toContain('ℹ️ 안 눌릴 신호 — 1번째 신호 처방: 자리표시자 대신 실제 경로를 명시하라');
  });

  it('전역 elanous 거절에는 작업 트리 elanous 진입을 이름으로 처방한다', () => {
    const r = runCli(ask('판정 신호: 조건 = 전역 elanous; 관측 = elanous logs --category harness --json; 기대 = 유지된다'));

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ℹ️ 안 눌릴 신호 — 1번째 신호 거부 이유: not-allowlisted; 전역 elanous 대신 bun bin/elanous.mjs …로 바꿔라');
  });

  it('환경 변수 접두 거절에는 접두를 이름으로 처방한다', () => {
    const r = runCli(ask('판정 신호: 조건 = 환경 변수; 관측 = ELANOUS_STATE_DIR=/tmp/elanous bun bin/elanous.mjs self send x; 기대 = 유지된다'));

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ℹ️ 안 눌릴 신호 — 1번째 신호 거부 이유: not-allowlisted; 환경 변수 접두를 떼거나 그 값이 꼭 필요하면 이 신호에서 실행할 수 없다고 적어라');
  });

  it('일반 허용 목록 밖 신호에는 통과 명령 예를 내고 처방을 지어내지 않는다', () => {
    const r = runCli(ask('판정 신호: 조건 = 미분류; 관측 = apps/android/gradlew test; 기대 = 유지된다'));

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('⚠️ 안 눌릴 신호 — 1번째 신호는 안전하게 읽을 수 없다: apps/android/gradlew test');
    expect(r.stdout).toContain("ℹ️ 안 눌릴 신호 — 1번째 신호 거부 이유: not-allowlisted; 통과 예: bun test <실제 시험 경로> 또는 rg -c '패턴' <실제 파일 경로>");
    expect(r.stdout).not.toContain('분류 못 함');
    expect(r.stdout).not.toContain('명령을 통째로 반복하라');
    expect(r.stdout).not.toContain('실제 경로를 명시하라');
  });

  it('안전한 bun test 및 rg 관측은 0개를 수로 내고 거짓 경고를 내지 않는다', () => {
    const r = runCli(ask(
      '판정 신호: 조건 = 시험; 관측 = bun test scripts/ask-marker-check.test.ts; 기대 = 통과한다',
      "판정 신호: 조건 = 검색; 관측 = rg -c 'console.log' src/index.ts; 기대 = 통과한다",
    ));

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('✅ 안 눌릴 신호 — 안 눌릴 신호 0개 / 전체 2개');
    expect(r.stdout).not.toContain('⚠️ 안 눌릴 신호 — 1번째 신호');
  });

  it('판정 신호가 없으면 0개와 다른 미계산 문면을 내면서 기존 marker exit 1을 보존한다', () => {
    const r = runCli(ask());

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('ℹ️ 안 눌릴 신호 — 판정 신호가 없어 수를 낼 수 없다');
    expect(r.stdout).not.toContain('안 눌릴 신호 0개 / 전체 0개');
  });

  it('누락과 빈 관측은 안전한 관측과 섞여도 미계산 경고와 집계를 내며 발사를 막지 않는다', () => {
    const r = runCli(ask(
      '판정 신호: 조건 = 누락; 기대 = 문면을 유지한다',
      '판정 신호: 조건 = 빈 관측; 관측 = ; 기대 = 문면을 유지한다',
      '판정 신호: 조건 = 안전; 관측 = bun test scripts/ask-marker-check.test.ts; 기대 = 통과한다',
    ));

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('⚠️ 안 눌릴 신호 — 안 눌릴 신호 0개 / 전체 3개; 미계산 2개');
    expect(r.stdout).toContain('⚠️ 안 눌릴 신호 — 1번째 신호는 관측 명령이 없어 미계산이다: 판정 신호: 조건 = 누락; 기대 = 문면을 유지한다');
    expect(r.stdout).toContain('⚠️ 안 눌릴 신호 — 2번째 신호는 관측 명령이 없어 미계산이다: 판정 신호: 조건 = 빈 관측; 관측 = ; 기대 = 문면을 유지한다');
  });
});

describe('무포트 격리 데몬 — 비차단 경고', () => {
  const HEAD = ['대상 경로: scripts/ask-marker-check.ts', '불변식: scripts/ask-marker-check.ts 를 그대로 둔다.', '경계: 다른 파일은 대상이 아니다.'];
  const ask = (...signals: string[]) => [...HEAD, ...signals].join('\n');
  const UNPORTED = 'bun bin/elanous.mjs --test nexus run';
  const PORTED = 'bun bin/elanous.mjs --test nexus run --http-port 47101';
  const PORTED_EQUALS = 'bun bin/elanous.mjs --test --http-port=47101 nexus run';
  const warning = (ordinal: number) =>
    `⚠️ 무포트 격리 데몬 — ${ordinal}번째 신호는 bun bin/elanous.mjs --test nexus run 을 포트 없이 띄워 운영 포트를 가린다; --http-port 로 포트를 명시하라.`;

  it('관측 명령의 무포트 격리 데몬만 순번과 함께 경고한다', () => {
    const source = ask(
      `판정 신호: 조건 = 격리 데몬; 관측 = ${UNPORTED}; 기대 = 경고 한 줄`,
      `판정 신호: 조건 = 시험; 관측 = bun test scripts/ask-marker-check.test.ts; 기대 = 통과한다`,
    );

    expect(inspectUnportedIsolatedDaemonWarnings(source)).toEqual([warning(1)]);
  });

  it('--http-port 를 명시한 격리 데몬에는 이 경고가 0건이다', () => {
    const source = ask(
      `판정 신호: 조건 = 명시 포트; 관측 = ${PORTED}; 기대 = 경고 0건`,
      `판정 신호: 조건 = 붙임 포트; 관측 = ${PORTED_EQUALS}; 기대 = 경고 0건`,
    );

    expect(inspectUnportedIsolatedDaemonWarnings(source)).toEqual([]);
  });

  it('판정 신호가 없으면 이 축은 빈 배열을 내고 죽지 않는다', () => {
    expect(inspectUnportedIsolatedDaemonWarnings(ask())).toEqual([]);
    expect(inspectUnportedIsolatedDaemonWarnings('')).toEqual([]);
  });

  it('무포트 명령은 경고 한 줄과 rc 0 이고 기존 축 산출을 바꾸지 않는다', () => {
    const source = ask(`판정 신호: 조건 = 격리 데몬; 관측 = ${UNPORTED}; 기대 = 경고 한 줄`);
    const r = runCli(source);
    const daemonWarnings = r.stdout.split(/\r?\n/).filter((line) => line.includes('⚠️ 무포트 격리 데몬'));

    expect(inspectUnportedIsolatedDaemonWarnings(source)).toEqual([warning(1)]);
    expect(r.status).toBe(0);
    expect(daemonWarnings).toEqual([`   ${warning(1)}`]);
    expect(r.stdout).toContain('✅ 불변식');
    expect(r.stdout).toContain('✅ 경계');
    expect(r.stdout).toContain('✅ 판정 신호');
    expect(r.stdout).toContain('✅ 불변식 경로 — 1/1개 불변식 줄이 저장소 파일 경로를 댄다');
    expect(finalNonblankLine(r.stdout)).toBe('✅ 1개 파일이 마커를 온전히 갖고 있다 — 발사해도 된다.');
  });

  it('--http-port 명령은 해당 경고 0건이고 rc 0 이다', () => {
    const source = ask(`판정 신호: 조건 = 명시 포트; 관측 = ${PORTED}; 기대 = 경고 0건`);
    const r = runCli(source);

    expect(inspectUnportedIsolatedDaemonWarnings(source)).toEqual([]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('⚠️ 무포트 격리 데몬');
    expect(finalNonblankLine(r.stdout)).toBe('✅ 1개 파일이 마커를 온전히 갖고 있다 — 발사해도 된다.');
  });

  it('셸 뒤 명령의 --http-port 는 데몬 포트를 명시한 것으로 보지 않는다', () => {
    const source = ask('판정 신호: 조건 = 합성; 관측 = bun bin/elanous.mjs --test nexus run && curl --http-port 9; 기대 = 경고');

    expect(inspectUnportedIsolatedDaemonWarnings(source)).toEqual([warning(1)]);
  });

  it('echo 인자로만 적힌 문면은 무경고이고 실제 무포트 기동은 경고한다', () => {
    const echoed = ask(`판정 신호: 조건 = 출력; 관측 = echo bun bin/elanous.mjs --test nexus run; 기대 = 무경고`);
    const launched = ask(`판정 신호: 조건 = 기동; 관측 = ${UNPORTED}; 기대 = 경고`);
    const echoedCli = runCli(echoed);
    const launchedCli = runCli(launched);

    expect(inspectUnportedIsolatedDaemonWarnings(echoed)).toEqual([]);
    expect(inspectUnportedIsolatedDaemonWarnings(launched)).toEqual([warning(1)]);
    expect(echoedCli.status).toBe(0);
    expect(echoedCli.stdout).not.toContain('⚠️ 무포트 격리 데몬');
    expect(launchedCli.status).toBe(0);
    expect(launchedCli.stdout.split(/\r?\n/).filter((line) => line.includes('⚠️ 무포트 격리 데몬'))).toEqual([`   ${warning(1)}`]);
  });

  it('env 래퍼 뒤의 무포트 격리 데몬은 경고하고 rc 는 0 이다', () => {
    const source = ask('판정 신호: 조건 = env 래퍼; 관측 = env bun bin/elanous.mjs --test nexus run; 기대 = 경고');
    const r = runCli(source);

    expect(inspectUnportedIsolatedDaemonWarnings(source)).toEqual([warning(1)]);
    expect(r.status).toBe(0);
    expect(r.stdout.split(/\r?\n/).filter((line) => line.includes('⚠️ 무포트 격리 데몬'))).toEqual([`   ${warning(1)}`]);
  });

  it('env -S 실행 문자열의 env 옵션 뒤 무포트 격리 데몬은 경고하고 명시 포트에는 무경고다', () => {
    const unported = ask("판정 신호: 조건 = split-string; 관측 = env -S '-i bun bin/elanous.mjs --test nexus run'; 기대 = 경고");
    const ported = ask("판정 신호: 조건 = split-string 포트; 관측 = env --split-string '-i bun bin/elanous.mjs --test nexus run --http-port 47101'; 기대 = 무경고");

    expect(inspectUnportedIsolatedDaemonWarnings(unported)).toEqual([warning(1)]);
    expect(inspectUnportedIsolatedDaemonWarnings(ported)).toEqual([]);
  });

  it("env -S 'bun bin/elanous.mjs --test nexus run' 은 무포트 경고를 내고 --split-string 명시 포트에는 무경고다", () => {
    const unported = ask("판정 신호: 조건 = split-string 인용; 관측 = env -S 'bun bin/elanous.mjs --test nexus run'; 기대 = 경고");
    const ported = ask("판정 신호: 조건 = split-string 인용 포트; 관측 = env --split-string 'bun bin/elanous.mjs --test nexus run --http-port 47101'; 기대 = 무경고");
    const unportedCli = runCli(unported);
    const portedCli = runCli(ported);

    expect(inspectUnportedIsolatedDaemonWarnings(unported)).toEqual([warning(1)]);
    expect(inspectUnportedIsolatedDaemonWarnings(ported)).toEqual([]);
    expect(unportedCli.status).toBe(0);
    expect(unportedCli.stdout.split(/\r?\n/).filter((line) => line.includes('⚠️ 무포트 격리 데몬'))).toEqual([`   ${warning(1)}`]);
    expect(portedCli.status).toBe(0);
    expect(portedCli.stdout).not.toContain('⚠️ 무포트 격리 데몬');
  });

  it('--tool-cwd 값의 nexus 는 서브커맨드가 아니므로 무경고이고 실제 무포트 기동은 경고한다', () => {
    const optionValue = ask('판정 신호: 조건 = 옵션 값; 관측 = bun bin/elanous.mjs --test --tool-cwd nexus run; 기대 = 무경고');
    const launched = ask(`판정 신호: 조건 = 기동; 관측 = ${UNPORTED}; 기대 = 경고`);
    const optionValueCli = runCli(optionValue);
    const launchedCli = runCli(launched);

    expect(inspectUnportedIsolatedDaemonWarnings(optionValue)).toEqual([]);
    expect(inspectUnportedIsolatedDaemonWarnings(launched)).toEqual([warning(1)]);
    expect(optionValueCli.status).toBe(0);
    expect(optionValueCli.stdout).not.toContain('⚠️ 무포트 격리 데몬');
    expect(launchedCli.status).toBe(0);
    expect(launchedCli.stdout.split(/\r?\n/).filter((line) => line.includes('⚠️ 무포트 격리 데몬'))).toEqual([`   ${warning(1)}`]);
  });

  it('bun run bin/elanous.mjs --test nexus run 은 무포트 경고를 내고 --http-port 가 있으면 무경고다', () => {
    const runUnported = ask('판정 신호: 조건 = bun run; 관측 = bun run bin/elanous.mjs --test nexus run; 기대 = 경고');
    const runPorted = ask('판정 신호: 조건 = bun run 포트; 관측 = bun run bin/elanous.mjs --test nexus run --http-port 47101; 기대 = 무경고');
    const runUnportedCli = runCli(runUnported);
    const runPortedCli = runCli(runPorted);

    expect(inspectUnportedIsolatedDaemonWarnings(runUnported)).toEqual([warning(1)]);
    expect(inspectUnportedIsolatedDaemonWarnings(runPorted)).toEqual([]);
    expect(runUnportedCli.status).toBe(0);
    expect(runUnportedCli.stdout.split(/\r?\n/).filter((line) => line.includes('⚠️ 무포트 격리 데몬'))).toEqual([`   ${warning(1)}`]);
    expect(runPortedCli.status).toBe(0);
    expect(runPortedCli.stdout).not.toContain('⚠️ 무포트 격리 데몬');
  });

  it('elanous 직접 실행은 무포트 경고를 내고 --http-port 가 있으면 무경고다', () => {
    const directUnported = ask('판정 신호: 조건 = 직접 실행; 관측 = elanous --test nexus run; 기대 = 경고');
    const directPorted = ask('판정 신호: 조건 = 직접 실행 포트; 관측 = elanous --test nexus run --http-port 47101; 기대 = 무경고');
    const directUnportedCli = runCli(directUnported);
    const directPortedCli = runCli(directPorted);

    expect(inspectUnportedIsolatedDaemonWarnings(directUnported)).toEqual([warning(1)]);
    expect(inspectUnportedIsolatedDaemonWarnings(directPorted)).toEqual([]);
    expect(directUnportedCli.status).toBe(0);
    expect(directUnportedCli.stdout.split(/\r?\n/).filter((line) => line.includes('⚠️ 무포트 격리 데몬'))).toEqual([`   ${warning(1)}`]);
    expect(directPortedCli.status).toBe(0);
    expect(directPortedCli.stdout).not.toContain('⚠️ 무포트 격리 데몬');
  });

  it('--http-port 값 누락·빈 값은 경고하고 비어 있지 않은 포트는 무경고다', () => {
    const missing = ask('판정 신호: 조건 = 값 누락; 관측 = elanous --test nexus run --http-port; 기대 = 경고');
    const emptyEquals = ask('판정 신호: 조건 = 빈 값; 관측 = elanous --test nexus run --http-port=; 기대 = 경고');
    const bunMissing = ask('판정 신호: 조건 = bun 값 누락; 관측 = bun bin/elanous.mjs --test nexus run --http-port; 기대 = 경고');
    const bunEmpty = ask('판정 신호: 조건 = bun 빈 값; 관측 = bun bin/elanous.mjs --test nexus run --http-port=; 기대 = 경고');
    const nextOption = ask('판정 신호: 조건 = 다음 옵션; 관측 = elanous --test nexus run --http-port --http-host 127.0.0.1; 기대 = 경고');
    const ported = ask('판정 신호: 조건 = 명시 포트; 관측 = elanous --test nexus run --http-port 47101; 기대 = 무경고');
    const missingCli = runCli(missing);

    expect(inspectUnportedIsolatedDaemonWarnings(missing)).toEqual([warning(1)]);
    expect(inspectUnportedIsolatedDaemonWarnings(emptyEquals)).toEqual([warning(1)]);
    expect(inspectUnportedIsolatedDaemonWarnings(bunMissing)).toEqual([warning(1)]);
    expect(inspectUnportedIsolatedDaemonWarnings(bunEmpty)).toEqual([warning(1)]);
    expect(inspectUnportedIsolatedDaemonWarnings(nextOption)).toEqual([warning(1)]);
    expect(inspectUnportedIsolatedDaemonWarnings(ported)).toEqual([]);
    expect(missingCli.status).toBe(0);
    expect(missingCli.stdout.split(/\r?\n/).filter((line) => line.includes('⚠️ 무포트 격리 데몬'))).toEqual([`   ${warning(1)}`]);
  });

  it('현재 저장소 CLI의 절대 경로는 무포트 경고를 내고 --http-port 가 있으면 무경고다', () => {
    const absoluteCli = join(repositoryRoot, 'bin/elanous.mjs');
    const absoluteUnported = ask(`판정 신호: 조건 = 절대 경로; 관측 = bun ${absoluteCli} --test nexus run; 기대 = 경고`);
    const absolutePorted = ask(`판정 신호: 조건 = 절대 경로 포트; 관측 = bun ${absoluteCli} --test nexus run --http-port 47101; 기대 = 무경고`);
    const unportedCli = runCli(absoluteUnported);
    const portedCli = runCli(absolutePorted);

    expect(inspectUnportedIsolatedDaemonWarnings(absoluteUnported)).toEqual([warning(1)]);
    expect(inspectUnportedIsolatedDaemonWarnings(absolutePorted)).toEqual([]);
    expect(unportedCli.status).toBe(0);
    expect(unportedCli.stdout.split(/\r?\n/).filter((line) => line.includes('⚠️ 무포트 격리 데몬'))).toEqual([`   ${warning(1)}`]);
    expect(portedCli.status).toBe(0);
    expect(portedCli.stdout).not.toContain('⚠️ 무포트 격리 데몬');
  });

  it('bun ./bin/elanous.mjs --test nexus run 은 무포트 경고를 내고 --http-port 가 있으면 무경고다', () => {
    const dottedUnported = ask('판정 신호: 조건 = 점 경로; 관측 = bun ./bin/elanous.mjs --test nexus run; 기대 = 경고');
    const dottedPorted = ask('판정 신호: 조건 = 점 경로 포트; 관측 = bun ./bin/elanous.mjs --test nexus run --http-port 47101; 기대 = 무경고');
    const otherDir = ask('판정 신호: 조건 = 다른 디렉터리; 관측 = bun scripts/bin/elanous.mjs --test nexus run; 기대 = 무경고');
    const dottedUnportedCli = runCli(dottedUnported);
    const dottedPortedCli = runCli(dottedPorted);

    expect(inspectUnportedIsolatedDaemonWarnings(dottedUnported)).toEqual([warning(1)]);
    expect(inspectUnportedIsolatedDaemonWarnings(dottedPorted)).toEqual([]);
    expect(inspectUnportedIsolatedDaemonWarnings(otherDir)).toEqual([]);
    expect(dottedUnportedCli.status).toBe(0);
    expect(dottedUnportedCli.stdout.split(/\r?\n/).filter((line) => line.includes('⚠️ 무포트 격리 데몬'))).toEqual([`   ${warning(1)}`]);
    expect(dottedPortedCli.status).toBe(0);
    expect(dottedPortedCli.stdout).not.toContain('⚠️ 무포트 격리 데몬');
  });

  it('맨 명령·셸 경계 뒤·한국어 산문 명령은 무포트만 경고하고 --http-port/--port 는 무경고다', () => {
    const forms = (command: string) => [
      command,
      `… && ${command}`,
      `격리 데몬을 ${command} 으로 띄우고 curl 로`,
    ];
    for (const observation of forms(UNPORTED)) {
      expect(inspectUnportedIsolatedDaemonWarnings(ask(`판정 신호: 조건 = 무포트; 관측 = ${observation}; 기대 = 경고`))).toEqual([warning(1)]);
    }
    for (const ported of [`${UNPORTED} --http-port 31420`, `${UNPORTED} --port 31420`]) {
      for (const observation of forms(ported)) {
        expect(inspectUnportedIsolatedDaemonWarnings(ask(`판정 신호: 조건 = 포트; 관측 = ${observation}; 기대 = 무경고`))).toEqual([]);
      }
    }
  });

  it('한국어 산문 속 무포트 기동은 경고 1건·rc 0 이고 --http-port 가 있으면 무경고다', () => {
    const prose = '격리 데몬을 bun bin/elanous.mjs --test nexus run 으로 띄우고';
    const unported = ask(`판정 신호: 조건 = 산문; 관측 = ${prose}; 기대 = 경고 한 줄`);
    const portedHttp = ask('판정 신호: 조건 = 산문 포트; 관측 = 격리 데몬을 bun bin/elanous.mjs --test nexus run --http-port 31420 으로 띄우고; 기대 = 무경고');
    const portedPort = ask('판정 신호: 조건 = 산문 포트 별칭; 관측 = 격리 데몬을 bun bin/elanous.mjs --test nexus run --port 31420 으로 띄우고; 기대 = 무경고');
    const unportedCli = runCli(unported);
    const portedHttpCli = runCli(portedHttp);
    const portedPortCli = runCli(portedPort);

    expect(inspectUnportedIsolatedDaemonWarnings(unported)).toEqual([warning(1)]);
    expect(inspectUnportedIsolatedDaemonWarnings(portedHttp)).toEqual([]);
    expect(inspectUnportedIsolatedDaemonWarnings(portedPort)).toEqual([]);
    expect(unportedCli.status).toBe(0);
    expect(unportedCli.stdout.split(/\r?\n/).filter((line) => line.includes('⚠️ 무포트 격리 데몬'))).toEqual([`   ${warning(1)}`]);
    expect(portedHttpCli.status).toBe(0);
    expect(portedHttpCli.stdout).not.toContain('⚠️ 무포트 격리 데몬');
    expect(portedPortCli.status).toBe(0);
    expect(portedPortCli.stdout).not.toContain('⚠️ 무포트 격리 데몬');
  });

  it('관측이 포트 지정 기동이어도 조건의 무포트 기동은 경고 1건이고 rc 는 0 이다', () => {
    const mixedHttp = ask('판정 신호: 조건 = bun bin/elanous.mjs --test nexus run; 관측 = bun bin/elanous.mjs --test nexus run --http-port 31420; 기대 = 정상');
    const mixedPort = ask('판정 신호: 조건 = bun bin/elanous.mjs --test nexus run; 관측 = bun bin/elanous.mjs --test nexus run --port 31420; 기대 = 정상');
    const mixedHttpCli = runCli(mixedHttp);
    const mixedPortCli = runCli(mixedPort);

    expect(inspectUnportedIsolatedDaemonWarnings(mixedHttp)).toEqual([warning(1)]);
    expect(inspectUnportedIsolatedDaemonWarnings(mixedPort)).toEqual([warning(1)]);
    expect(mixedHttpCli.status).toBe(0);
    expect(mixedHttpCli.stdout.split(/\r?\n/).filter((line) => line.includes('⚠️ 무포트 격리 데몬'))).toEqual([`   ${warning(1)}`]);
    expect(mixedPortCli.status).toBe(0);
    expect(mixedPortCli.stdout.split(/\r?\n/).filter((line) => line.includes('⚠️ 무포트 격리 데몬'))).toEqual([`   ${warning(1)}`]);
  });

  it('조건 칸에만 있는 무포트 기동이 경고 1건을 내고 rc 는 0 이다', () => {
    const source = ask('판정 신호: 조건 = 격리 데몬을 bun bin/elanous.mjs --test nexus run 으로 띄운다; 관측 = bun test x.test.ts; 기대 = 경고 1건');
    const r = runCli(source);

    expect(inspectUnportedIsolatedDaemonWarnings(source)).toEqual([warning(1)]);
    expect(r.status).toBe(0);
    expect(r.stdout.split(/\r?\n/).filter((line) => line.includes('⚠️ 무포트 격리 데몬'))).toEqual([`   ${warning(1)}`]);
  });

  it('조건에만 무포트 기동이 있고 관측은 curl 결과이면 경고 1건이다', () => {
    const source = ask('판정 신호: 조건 = 격리 데몬을 bun bin/elanous.mjs --test nexus run 으로 띄우고 curl 로; 관측 = 그 curl 이 받은 줄; 기대 = 1건');

    expect(inspectUnportedIsolatedDaemonWarnings(source)).toEqual([warning(1)]);
  });

  it.skipIf(!existsSync(join(repositoryRoot, 'docs/goals/ASK-the-slash-harness-path-emits-no-envelope-at-all-2026-09-12.md')))('private docs/goals 실물 두 건을 읽어 각각 경고 1건 이상을 낸다', () => {
    const phrase = '격리 데몬을 bun bin/elanous.mjs --test nexus run';
    const files = [
      'docs/goals/ASK-the-slash-harness-path-emits-no-envelope-at-all-2026-09-12.md',
      'docs/goals/ASK-harness-progress-must-outlive-the-turn-2026-09-12.md',
    ];
    for (const relativePath of files) {
      const text = readFileSync(join(repositoryRoot, relativePath), 'utf8');
      expect(text).toContain(phrase);
      const warnings = inspectUnportedIsolatedDaemonWarnings(text);
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      const signal = text.split(/\r?\n/).map((line) => line.trim())
        .find((line) => /^판정 신호\s*[:：]/u.test(line) && line.includes(phrase));
      expect(signal).toBeDefined();
      const condition = signal!.replace(/^판정 신호\s*[:：]\s*/u, '')
        .match(/조건\s*=\s*([\s\S]*?);\s*관측\s*=/u)?.[1]?.trim();
      expect(condition).toContain(phrase);
    }
  });

  it('한 신호에서 조건·관측 양쪽에 같은 무포트 기동이 있어도 경고는 정확히 1건이다', () => {
    const source = ask(`판정 신호: 조건 = ${UNPORTED}; 관측 = ${UNPORTED}; 기대 = 경고 한 줄`);
    const r = runCli(source);

    expect(inspectUnportedIsolatedDaemonWarnings(source)).toEqual([warning(1)]);
    expect(r.status).toBe(0);
    expect(r.stdout.split(/\r?\n/).filter((line) => line.includes('⚠️ 무포트 격리 데몬'))).toEqual([`   ${warning(1)}`]);
  });

  it('조건 칸에 --http-port 31420 을 넣은 판은 경고 0건이다', () => {
    const source = ask('판정 신호: 조건 = bun bin/elanous.mjs --test nexus run --http-port 31420; 관측 = bun test x.test.ts; 기대 = 무경고');
    const r = runCli(source);

    expect(inspectUnportedIsolatedDaemonWarnings(source)).toEqual([]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('⚠️ 무포트 격리 데몬');
  });

  it('기대 칸의 무포트 기동은 읽지 않아 경고 0건이다', () => {
    const source = ask(`판정 신호: 조건 = 시험; 관측 = bun test x.test.ts; 기대 = ${UNPORTED}`);

    expect(inspectUnportedIsolatedDaemonWarnings(source)).toEqual([]);
  });
});

describe('조건↔관측 짝 — 비차단 경고', () => {
  const HEAD = ['대상 경로: scripts/ask-marker-check.ts', '불변식: scripts/ask-marker-check.ts 를 그대로 둔다.', '경계: 다른 파일은 대상이 아니다.'];
  const ask = (...signals: string[]) => [...HEAD, ...signals].join('\n');
  const warning = (ordinal: number) =>
    `⚠️ 조건↔관측 짝 — ${ordinal}번째 신호: 조건이 「돈다」인데 관측이 «문면 세기»다`;

  it('조건에 돈다가 있고 관측이 rg -c 이면 경고한다', () => {
    const source = ask("판정 신호: 조건 = 실물에서 돈다; 관측 = rg -c 'company-only' scripts/domain-boundary-check.ts; 기대 = 1 이상");
    const r = runCli(source);

    expect(inspectConditionObservationPairWarnings(source)).toEqual([warning(1)]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`   ${warning(1)}`);
  });

  it('완주·동작·실행 조건에 문면 세기 관측이면 경고한다', () => {
    for (const condition of ['완주한다', '동작한다', '실제로 실행된다']) {
      expect(inspectConditionObservationPairWarnings(ask(`판정 신호: 조건 = ${condition}; 관측 = grep -c x scripts/a.ts; 기대 = 1`))).toEqual([warning(1)]);
    }
  });

  /** ⛔⭐ 「실행 «경로/축»」만 말하는 조건은 «정적»이라 문면 세기가 «옳은 자»다 — 경고하지 않는다.
   *  📏 실측(2026-09-22 · docs/goals ASK⊕GOAL 전수): 「조건에 실행류 낱말 ⊕ 관측이 문면 세기」 28건이
   *    ***전부 이 모양***이었고(「새 낱말이 실행 경로에 있다」 꼴), 「실행 경로에서 «돈다»」는 ***0건***이었다.
   *    ⇒ 그 28건에 경고를 뿌리면 이 축은 «결함 탐지기»가 아니라 ***소음***이 된다. */
  it('실행 «경로/축»만 말하는 조건은 정적이라 경고하지 않는다', () => {
    for (const condition of ['새 낱말이 실행 경로에 있다', '실행 축을 본다', '값이 실행 경로로 흘렀다']) {
      expect(inspectConditionObservationPairWarnings(ask(`판정 신호: 조건 = ${condition}; 관측 = grep -c x scripts/a.ts; 기대 = 1`))).toEqual([]);
    }
  });

  it('실행 «경로»를 말해도 «돈다»가 붙으면 경고한다', () => {
    expect(inspectConditionObservationPairWarnings(ask('판정 신호: 조건 = 실행 경로에서 돈다; 관측 = grep -c x scripts/a.ts; 기대 = 1'))).toEqual([warning(1)]);
  });

  it('꺾쇠가 낀 정적 실행 경로는 경고하지 않는다', () => {
    expect(inspectConditionObservationPairWarnings(ask('판정 신호: 조건 = 그 필터가 실행 «경로»에 배선된다; 관측 = rg -c x scripts/a.ts; 기대 = 1'))).toEqual([]);
  });

  it('꺾쇠가 없는 기존 실행 경로 표기도 경고하지 않는다', () => {
    expect(inspectConditionObservationPairWarnings(ask('판정 신호: 조건 = 실행 경로에 배선된다; 관측 = rg -c x scripts/a.ts; 기대 = 1'))).toEqual([]);
  });

  it('실행과 경로 사이 저장소 강조 기호는 정적 조건으로 지나간다', () => {
    for (const condition of [
      '실행「경로」에 배선된다',
      "실행 '경로'에 배선된다",
      '실행 "경로"에 배선된다',
      '실행 *경로*에 배선된다',
      '실행 `경로`에 배선된다',
      '실행 »축에 배선된다',
    ]) {
      expect(inspectConditionObservationPairWarnings(ask(`판정 신호: 조건 = ${condition}; 관측 = rg -c x scripts/a.ts; 기대 = 1`))).toEqual([]);
    }
  });

  it('실물에서 돈다는 문면 세기면 경고한다', () => {
    expect(inspectConditionObservationPairWarnings(ask('판정 신호: 조건 = 실물에서 돈다; 관측 = rg -c x scripts/a.ts; 기대 = 1')).length).toBeGreaterThanOrEqual(1);
  });

  it('꺾쇠가 낀 실행 경로에 돈다가 붙으면 경고한다', () => {
    expect(inspectConditionObservationPairWarnings(ask('판정 신호: 조건 = 실행 «경로»에서 돈다; 관측 = rg -c x scripts/a.ts; 기대 = 1')).length).toBeGreaterThanOrEqual(1);
  });

  it('조건에 실행한다가 있고 관측이 rg -c 이면 경고하고 rc=0 이다', () => {
    const source = ask("판정 신호: 조건 = 실행한다; 관측 = rg -c 'company-only' scripts/domain-boundary-check.ts; 기대 = 1 이상");
    const r = runCli(source);

    expect(inspectConditionObservationPairWarnings(source)).toEqual([warning(1)]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`   ${warning(1)}`);
  });

  it('조건에 실행 경로에서 돈다가 있고 관측이 rg -c 이면 경고하고 rc=0 이다', () => {
    const source = ask("판정 신호: 조건 = 실행 경로에서 돈다; 관측 = rg -c 'company-only' scripts/domain-boundary-check.ts; 기대 = 1 이상");
    const r = runCli(source);

    expect(inspectConditionObservationPairWarnings(source)).toEqual([warning(1)]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`   ${warning(1)}`);
  });

  it('조건에 돈다가 있고 관측이 bun test 이면 경고하지 않는다', () => {
    const source = ask('판정 신호: 조건 = 실물에서 돈다; 관측 = bun test scripts/ask-marker-check.test.ts; 기대 = 통과');
    const r = runCli(source);

    expect(inspectConditionObservationPairWarnings(source)).toEqual([]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('⚠️ 조건↔관측 짝');
  });

  it('bun <파일> 과 elanous 관측은 실행 약속이 있어도 경고하지 않는다', () => {
    expect(inspectConditionObservationPairWarnings(ask('판정 신호: 조건 = 실물에서 돈다; 관측 = bun scripts/ask-marker-check.ts; 기대 = 산출'))).toEqual([]);
    expect(inspectConditionObservationPairWarnings(ask('판정 신호: 조건 = 실물에서 돈다; 관측 = elanous logs --limit 1; 기대 = 줄'))).toEqual([]);
  });

  it('조건이 배선됐다 이고 관측이 rg -c 이면 경고하지 않는다', () => {
    const source = ask("판정 신호: 조건 = 배선됐다; 관측 = rg -c 'inspectAskMarkers' scripts/ask-marker-check.ts; 기대 = 1 이상");
    const r = runCli(source);

    expect(inspectConditionObservationPairWarnings(source)).toEqual([]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('⚠️ 조건↔관측 짝');
  });

  it('그 경고만 있는 ask 의 종료 코드가 0 이다', () => {
    const source = ask("판정 신호: 조건 = 실물에서 돈다; 관측 = rg -c 'company-only' scripts/domain-boundary-check.ts; 기대 = 1 이상");
    const r = runCli(source);

    expect(inspectConditionObservationPairWarnings(source)).toEqual([warning(1)]);
    expect(r.status).toBe(0);
    expect(finalNonblankLine(r.stdout)).toBe('✅ 1개 파일이 마커를 온전히 갖고 있다 — 발사해도 된다.');
  });

  it('wc·cat·sed·head·tail 첫 낱말도 문면 세기로 경고하고 기존 아홉 축 길이는 유지한다', () => {
    for (const observation of ['wc -l scripts/a.ts', 'cat scripts/a.ts', 'sed -n 1p scripts/a.ts', 'head -1 scripts/a.ts', 'tail -1 scripts/a.ts']) {
      expect(inspectConditionObservationPairWarnings(ask(`판정 신호: 조건 = 실물에서 돈다; 관측 = ${observation}; 기대 = 줄`))).toEqual([warning(1)]);
    }
    expect(inspectAskMarkers(ask("판정 신호: 조건 = 실물에서 돈다; 관측 = rg -c x scripts/a.ts; 기대 = 1"))).toHaveLength(9);
  });
});
