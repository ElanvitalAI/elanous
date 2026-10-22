import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';
import {
  EXEMPT_MARKER,
  GIT_SEAM_PREFIXES,
  compareToBaseline,
  countsByFile,
  findGitSpawnSites,
  gitSpawnExitCode,
  lintGitSpawnSites,
  renderGitSpawnDiscipline,
  runGitSpawnDiscipline,
  scanGitSpawnDiscipline,
} from './spawn-discipline.js';
import { GIT_SPAWN_BASELINE } from './spawn-discipline-baseline.js';

/** `man git-status` 의 NAME 줄 — git 산출이 아니라 **호스트 매뉴얼 페이지 자산**이 내는 문면이다. */
const GIT_STATUS_MANUAL_TITLE = 'git-status - Show the working tree status';

describe('findGitSpawnSites — 네 형태를 각각 문다', () => {
  // ⛔ 한 픽스처에 다 넣고 "N건" 만 세면 **한 패턴을 지워도 통과한다**(Goodhart).
  //    형태마다 따로 단언해 패턴 하나를 지우면 그 케이스가 반드시 깨지게 한다.
  const cases: [string, string][] = [
    ['child_process 배열형', `const r = spawnSync('git', ['status']);`],
    ['child_process 문자열형', `execSync('git status --porcelain');`],
    ['Bun.spawnSync', `Bun.spawnSync(['git', 'rev-parse', 'HEAD']);`],
    ['Bun shell 템플릿', 'await $`git status`;'],
  ];
  for (const [label, line] of cases) {
    test(label, () => {
      expect(findGitSpawnSites('src/x.ts', line).map((s) => s.line)).toEqual([1]);
    });
  }

  test('⛔ 여러 줄 호출도 문다 — 줄바꿈 하나로 우회되면 관문이 아니다', () => {
    // 리뷰 must-fix(2026-08-03): 줄 단위 정규식은 이 형태를 통째로 놓쳤다.
    const multiline = [
      'const r = spawnSync(',
      `  'git',`,
      `  ['status'],`,
      ');',
    ].join('\n');
    expect(findGitSpawnSites('src/x.ts', multiline).map((s) => s.line)).toEqual([1]);
    expect(findGitSpawnSites('src/x.ts', `Bun.spawnSync(\n  ['git', 'log'],\n);`).map((s) => s.line)).toEqual([1]);
  });

  test('한 자리가 여러 패턴에 걸려도 한 번만 센다', () => {
    expect(findGitSpawnSites('src/x.ts', `spawnSync('git', ['status']);`)).toHaveLength(1);
  });

  test('⛔ 같은 줄의 서로 다른 호출은 각각 센다 — 줄로 접으면 우회로가 된다', () => {
    // 리뷰 must-fix(2라운드): 줄 단위 dedupe 면 기존 호출 옆에 하나 더 얹어도 기준선이 안 는다.
    expect(findGitSpawnSites('src/x.ts', `spawnSync('git',['a']); spawnSync('git',['b']);`)).toHaveLength(2);
  });

  test('⛔ 블록 주석 안의 예시는 안 세고, 같은 줄 뒤의 진짜 호출은 센다', () => {
    const source = `/* 예시: spawnSync('git', ['x']) */ const r = spawnSync('git', ['status']);`;
    const sites = findGitSpawnSites('src/x.ts', source);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.line).toBe(1);
  });

  test('⛔ 여러 줄 블록 주석 안쪽은 줄머리가 * 가 아니어도 안 센다', () => {
    const source = `/*\n예시로 적는다\nspawnSync('git', ['x'])\n*/\nconst r = spawnSync('git', ['y']);`;
    expect(findGitSpawnSites('src/x.ts', source).map((s) => s.line)).toEqual([5]);
  });

  test('⛔ 인자 없는 execSync·객체형 Bun.spawn·공백 없는 $`git` 도 문다', () => {
    // 리뷰 must-fix(3라운드): 초판이 놓치던 세 형태.
    expect(findGitSpawnSites('src/x.ts', `execSync('git');`)).toHaveLength(1);
    expect(findGitSpawnSites('src/x.ts', `Bun.spawn({ cmd: ['git', 'status'] });`)).toHaveLength(1);
    expect(findGitSpawnSites('src/x.ts', 'await $`git`;')).toHaveLength(1);
  });

  test('⭐ 저장소에 실재하는 두 문면을 문다 (회귀 가드)', () => {
    // ⛔ 이 둘은 3라운드에 「문자열 안쪽 배제」를 넣었다가 **놓쳤던** 진짜 호출이다.
    //    자를 오탐 쪽으로 되돌린 판단을 이 테스트가 고정한다.
    expect(findGitSpawnSites('src/a.ts', `const add = spawnSync('git', ['worktree', 'add', '--detach', d, ref], { cwd });`)).toHaveLength(1);
    expect(findGitSpawnSites('src/b.ts', 'return execSync(`git ${args}`, { encoding: "utf8" });')).toHaveLength(1);
  });

  test('git 이 아닌 스폰은 안 문다', () => {
    expect(findGitSpawnSites('src/x.ts', `spawnSync('gh', ['pr', 'list']);`)).toEqual([]);
    expect(findGitSpawnSites('src/x.ts', `spawnSync('gitleaks', ['detect']);`)).toEqual([]);
  });

  test('주석 줄은 안 센다', () => {
    // ⚠️ ` * …` 는 `/*` 없이는 **주석이 아니다** — 초판 픽스처가 그것을 주석으로 뒀고,
    //    줄머리 휴리스틱이 그 오해를 그대로 통과시켰다. 진짜 블록 주석으로 쓴다.
    const source = [
      `// spawnSync('git', ['status'])  ← 설명`,
      `/** JSDoc`,
      ` * execSync('git log')`,
      ` */`,
      `const r = spawnSync('git', ['status']);`,
    ].join('\n');
    expect(findGitSpawnSites('src/x.ts', source).map((s) => s.line)).toEqual([5]);
  });
});

describe('면제 표식', () => {
  test('같은 줄 표식이 이유와 함께 잡힌다', () => {
    const line = `spawnSync('git', ['status']); // ${EXEMPT_MARKER} 부팅 전이라 심을 못 쓴다`;
    expect(findGitSpawnSites('src/x.ts', line)[0]?.exemptReason).toBe('부팅 전이라 심을 못 쓴다');
  });

  test('바로 윗줄 표식도 잡힌다', () => {
    const source = `// ${EXEMPT_MARKER} 이유\nspawnSync('git', ['status']);`;
    expect(findGitSpawnSites('src/x.ts', source)[0]?.exemptReason).toBe('이유');
  });

  test('⛔ 문자열 리터럴은 표식이 아니다 — 데이터가 규율을 끄면 안 된다', () => {
    // 리뷰 must-fix(2라운드): 바로 윗줄의 일반 문자열만으로 면제되던 것.
    const source = `const label = "${EXEMPT_MARKER} 이건 그냥 문자열";\nspawnSync('git', ['status']);`;
    expect(findGitSpawnSites('src/x.ts', source)[0]?.exemptReason).toBeUndefined();
  });

  test('⛔ 두 줄 위 표식은 번지지 않는다', () => {
    // 면제가 멀리서 번지면 이 린트도 "0을 보면서 깨끗하다" 가 된다.
    const source = `// ${EXEMPT_MARKER} 이유\nconst x = 1;\nspawnSync('git', ['status']);`;
    expect(findGitSpawnSites('src/x.ts', source)[0]?.exemptReason).toBeUndefined();
  });
});

describe('lintGitSpawnSites — 관문 안/밖/면제로 가른다', () => {
  const sites = [
    { file: 'src/git-fs/worktree.ts', line: 1, text: '' },
    { file: 'src/autopilot/x.ts', line: 2, text: '' },
    { file: 'src/autopilot/y.ts', line: 3, text: '', exemptReason: '이유' },
  ];

  test('src/git-fs 안쪽은 위반이 아니다', () => {
    const result = lintGitSpawnSites(sites);
    expect(result.counts).toMatchObject({ total: 3, inSeam: 1, outsideSeam: 1, exempt: 1 });
    expect(result.outsideSeam.map((s) => s.file)).toEqual(['src/autopilot/x.ts']);
  });

  test('countsByFile 은 관문 밖만 센다', () => {
    expect(countsByFile(lintGitSpawnSites(sites))).toEqual({ 'src/autopilot/x.ts': 1 });
  });
});

describe('compareToBaseline — 래칫', () => {
  test('늘면 회귀, 줄면 진전, 사라지면 낡은 기준선', () => {
    const comparison = compareToBaseline(
      { 'a.ts': 2, 'b.ts': 1, 'new.ts': 1 },
      { 'a.ts': 1, 'b.ts': 3, 'gone.ts': 2 },
    );
    expect(comparison.unbaselined).toEqual([{ file: 'new.ts', current: 1 }]);
    expect(comparison.deferred).toEqual([]);
    expect(comparison.regressions).toEqual([{ file: 'a.ts', baseline: 1, current: 2 }]);
    expect(comparison.improvements).toEqual([{ file: 'b.ts', baseline: 3, current: 1 }]);
    expect(comparison.stale).toEqual(['gone.ts']);
  });

  // ⛔ 아래 둘은 **저장소를 안 읽는다** — 규칙을 시험하는 것이지 그때의 저장소를 시험하는 게 아니다.
  test('기준선 미설정과 명시적 0은 다른 문면과 판정이다', () => {
    const comparison = compareToBaseline({ 'missing.ts': 1, 'zero.ts': 1 }, { 'zero.ts': 0 });
    const result = lintGitSpawnSites([
      { file: 'missing.ts', line: 1, text: '' },
      { file: 'zero.ts', line: 1, text: '' },
    ]);
    const output = renderGitSpawnDiscipline(result, comparison);
    expect(comparison.unbaselined).toEqual([{ file: 'missing.ts', current: 1 }]);
    expect(comparison.regressions).toEqual([{ file: 'zero.ts', baseline: 0, current: 1 }]);
    expect(output).toContain('⚠️ unbaselined missing.ts current=1');
    expect(output).toContain('⛔ regression zero.ts baseline=0 current=1');
    expect(gitSpawnExitCode(comparison, true)).toBe(1);
  });

  test('미기준선 호출만 있어도 strict 는 종료코드 1과 unbaselined 문면을 낸다', () => {
    const comparison = compareToBaseline({ 'missing.ts': 1 }, {});
    const result = lintGitSpawnSites([{ file: 'missing.ts', line: 1, text: '' }]);
    expect(comparison.regressions).toEqual([]);
    expect(comparison.unbaselined).toEqual([{ file: 'missing.ts', current: 1 }]);
    expect(renderGitSpawnDiscipline(result, comparison)).toContain('⚠️ unbaselined missing.ts current=1');
    expect(gitSpawnExitCode(comparison, true)).toBe(1);
    expect(gitSpawnExitCode(comparison, false)).toBe(0);
  });

  test('진전·낡은 기준선은 strict 에서도 실패가 아니다 (유예분은 판정 입력이 아니다)', () => {
    const comparison = compareToBaseline({ 'a.ts': 1 }, { 'a.ts': 3, 'gone.ts': 2 });
    expect(comparison.improvements.length).toBeGreaterThan(0);
    expect(comparison.stale.length).toBeGreaterThan(0);
    expect(gitSpawnExitCode(comparison, true)).toBe(0);
  });

  test('회귀는 strict 에서만 종료코드 1', () => {
    const comparison = compareToBaseline({ 'a.ts': 2 }, { 'a.ts': 1 });
    expect(gitSpawnExitCode(comparison, true)).toBe(1);
    expect(gitSpawnExitCode(comparison, false)).toBe(0);
  });

  // ⛔⭐⭐⭐ **저장소 상태에 기대지 않는다**(2026-08-03 두 번째 사례).
  //    초판은 `runGitSpawnDiscipline('src', {}, true)` 로 **빈 기준선이면 회귀가 있다**를 전제했는데,
  //    관문 이관이 **끝나서 관문 밖이 0이 되자** 그 전제가 깨져 테스트가 울렸다.
  //    ⇒ ***일이 완성되면 울리는 테스트***는 가드가 아니다. 문면 계약은 **픽스처로** 고정한다.
  test('회귀 문면이 어느 파일이 몇에서 몇으로 늘었는지 말한다', () => {
    const comparison = compareToBaseline({ 'src/x.ts': 2 }, { 'src/x.ts': 0 });
    const result = lintGitSpawnSites([{ file: 'src/x.ts', line: 1, text: '' }, { file: 'src/x.ts', line: 2, text: '' }]);
    const output = renderGitSpawnDiscipline(result, comparison);
    expect(comparison.regressions).toEqual([{ file: 'src/x.ts', baseline: 0, current: 2 }]);
    expect(output).toContain('⛔ regression src/x.ts');
    expect(output).toMatch(/baseline=0 current=2/);
    expect(gitSpawnExitCode(comparison, true)).toBe(1);
  });
});

describe('실제 저장소 — 이 게이트가 지키는 것', () => {
  const result = scanGitSpawnDiscipline();

  test('기본 스코프는 src와 scripts를 모두 보며 scripts의 관문 밖 호출을 누락하지 않는다', () => {
    const scripts = result.outsideSeam.filter((site) => site.file.startsWith('scripts/'));
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.some((site) => site.file === 'scripts/run-mission.ts')).toBe(true);
    expect(result.exempt).toContainEqual(expect.objectContaining({
      file: 'scripts/cli-doc-coverage.ts',
      exemptReason: '최근 CLI 등록 관측의 주입 가능한 git log 입력이다.',
    }));
  });

  test('⛔ 관문 밖 git 스폰이 기준선보다 늘지 않았다', () => {
    const comparison = compareToBaseline(countsByFile(result), GIT_SPAWN_BASELINE);
    const detail = comparison.regressions
      .map(({ file, baseline, current }) => `${file} ${baseline}→${current}`)
      .join(' · ');
    // ⭐ 늘었다면 그 자리는 `src/git-fs/` 심을 거치게 하거나, 못 거치는 이유를
    //    `git-spawn-allow: <이유>` 로 남긴다. 기준선을 올려서 통과시키지 마라.
    expect(`관문 밖 git 스폰 증가: ${detail}`).toBe('관문 밖 git 스폰 증가: ');
  });

  test('⛔ 래칫에서 뺀 테스트 파일을 요약이 말한다 (조용한 스코프 축소 금지)', () => {
    // 리뷰 지적(3라운드): `.test.ts` 제외가 우회로다. ⇒ 제외는 유지하되 **세어서 말한다**.
    expect(result.skippedTests?.files).toBeGreaterThan(0);
    expect(result.skippedTests?.spawns).toBeGreaterThan(0);
    expect(renderGitSpawnDiscipline(result)).toMatch(/test-files=\d+ spawns-in-tests=\d+/);
  });

  test('관문은 src/git-fs 다', () => {
    expect(GIT_SEAM_PREFIXES).toContain('src/git-fs/');
    expect(result.inSeam.every((site) => site.file.startsWith('src/git-fs/'))).toBe(true);
  });

  test('자가 대상을 실제로 보고 있다 (0을 보면서 깨끗하다고 말하지 않는다)', () => {
    // ⛔ 36차 `harness clean` 이 0개를 보면서 "정리 대상 없음" 이라 말했다. 같은 결함을 막는다.
    // ⛔⭐⭐⭐ **상수 임계로 쓰지 않는다**(2026-08-03 실측): 초판은 `total > 50`·`files > 20` 이었는데,
    //    관문 이관이 **성공할수록** 그 수가 내려가 **일이 잘 될 때 울리는 가드**가 됐다(실제로 울렸다).
    //    ⇒ 재야 할 것은 「수가 큰가」가 아니라 ***「자가 저장소를 실제로 보고 있나」*** 다.
    //    ⇒ 그래서 **반드시 있는 자리**를 이름으로 확인한다 — 관문 자신은 git 을 띄우는 것이 본분이다.
    expect(result.counts.total).toBeGreaterThan(0);
    expect(result.counts.inSeam).toBeGreaterThan(0);
    expect(result.inSeam.some((site) => site.file === 'src/git-fs/worktree.ts')).toBe(true);
    expect(result.skippedTests?.files).toBeGreaterThan(0);
  });

  // ⛔ 「낡은 기준선 항목」에 **저장소 수준 단언을 걸지 않는다**(리뷰 must-fix · 2026-08-03):
  //    그러면 관문 밖 호출을 **줄인 변경이 게이트를 깨서**, *"진전은 실패가 아니다"* 라는
  //    이 게이트의 계약을 게이트 자신이 어긴다. 낡음은 **보고**하고, 판정은 회귀에만 건다.
  test('낡은 기준선 항목은 보고되지만 게이트를 깨지 않는다', () => {
    const comparison = compareToBaseline(
      { 'src/current.ts': 1 },
      { 'src/current.ts': 1, 'src/__gone__.ts': 3 },
    );
    expect(comparison.stale).toContain('src/__gone__.ts');
    expect(gitSpawnExitCode(comparison, true)).toBe(0);
  });

  // ⛔⭐⭐⭐ 실물 진입점 회귀(리뷰 should-fix · 2026-08-03) — **in-process import 로는 원리상 못 답한다.**
  //    `#6701` 이 테스트 3 pass·리뷰 PASS 로 머지되고 실물 `elanous` 전 명령이 죽었던 자리가 이것이다.
  //    ⚠️ 실물 spawn 은 ~7초라 bun 기본 5초면 **타임아웃이 곧 무출력**이 된다 ⇒ per-test 타임아웃 명시.
  test('실물 진입점에서 scripts 유예와 요약을 산출한다', () => {
    const spawned = spawnSync('bun', ['bin/elanous.mjs', 'self', 'git-discipline'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    const output = `${spawned.stdout ?? ''}${spawned.stderr ?? ''}`;
    expect(output).toContain('⏸️ deferred scripts/run-mission.ts baseline=6 current=6');
    expect(output).toContain('outside-seam=');
    expect(output).toContain('regressions=0');
    expect(spawned.status).toBe(0);
  }, 90_000);

  // ⛔⭐⭐⭐ 원인 확정(0.2.35 GATE-PREEXISTING-ZERO · 0.2.34 gate preexisting 1건):
  //    기대 문면 `git-status - Show the working tree status` 는 git 의 산출이 아니라 **`man git-status` 의 NAME 줄**이다.
  //    ⇒ 그 문면을 내는 것은 *호스트의 매뉴얼 페이지 자산*이고, git 도 프론트도어도 아니다.
  //    최소 이미지(Ubuntu minimized)의 `/usr/bin/man` 은 **실패하지 않는 스텁**이다 — 안내문만 stdout 에 쓰고 0 으로 끝난다.
  //    그래서 git 은 --help 경로를 정상 수행하고 0 으로 끝나며, 프론트도어도 세 불변식을 다 지켰는데도
  //    «문면만» 사라져 이 시험만 preexisting 으로 울었다(실측: 나머지 34 pass · 이 1건 fail).
  //    ⇒ 기대값을 호스트 자산에 걸지 않는다. **같은 호스트의 실물 git**을 기준선으로 삼아 바이트로 대조한다.
  //      `--help` 를 삼키면(elanous 자기 help) · 떨어뜨리면(진짜 `git status` 실행) stdout 이 즉시 갈린다.
  //    ⇒ 매뉴얼 페이지가 «실재하는» 호스트에서는 본문 단언을 그대로 건다(호스트에 맞춘 조건부 유지 · 약화 아님).
  test('실물 git 프론트도어는 --help를 git argv로 전달하고 상태 줄과 git 종료 코드를 보존한다', () => {
    const direct = spawnSync('git', ['status', '--help'], { encoding: 'utf8', timeout: 60_000 });
    // 기준선이 무효면(타임아웃·미실행) 아래 대조가 «우연히» 맞을 수 있다 ⇒ 먼저 기준선의 유효성을 잰다.
    expect(direct.status).not.toBeNull();
    const directOut = direct.stdout ?? '';
    const directErr = direct.stderr ?? '';

    const spawned = spawnSync('bun', ['bin/elanous.mjs', 'git', 'status', '--help'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    const stdout = spawned.stdout ?? '';
    const stderr = spawned.stderr ?? '';

    // ① --help 전달: 프론트도어의 stdout 은 git 이 낸 바이트 «그대로» 다(상태 줄은 stderr 로 가기로 한 결정).
    expect(stdout).toBe(directOut);
    // man/mandoc 의 진단 stderr 는 직접 호출과 래퍼 호출 사이에도 달라질 수 있다.
    // stdout 바이트·종료 코드·상태 줄로 argv 전달과 프론트도어 계약을 판정한다.
    // ② 상태 줄: 마지막 줄이 «실제» git 종료 코드를 말한다(0 을 상수로 박지 않는다).
    //    ⛔ 상태 «단어» 도 종료 코드를 따라야 한다(프론트도어 규약 · git-cli.ts: rc=0 → ok, 0이 아니면 FAILED).
    //    리뷰 must-fix: `--help` 가 0이 아닌 호스트에서도 프론트도어가 종료 코드를 올바르게 보존하면
    //    상태 줄은 «FAILED» 다 — `ok` 를 무조건 요구하면 매뉴얼 자산 차이로 정상 동작을 실패로 판정하는
    //    문제가 다시 생긴다. 기대 상태 줄 전체를 실제 종료 코드에 맞춘다.
    expect(stderr.trimEnd().split('\n').at(-1))
      .toBe(`[git] status ${direct.status === 0 ? 'ok' : 'FAILED'} rc=${direct.status}`);
    // ③ 종료 코드 보존.
    expect(spawned.status).toBe(direct.status);
    // 매뉴얼 페이지가 실재하는 호스트에서만 본문까지 확인한다.
    if (`${directOut}${directErr}`.includes(GIT_STATUS_MANUAL_TITLE)) {
      expect(`${stdout}${stderr}`).toContain(GIT_STATUS_MANUAL_TITLE);
    }
  }, 90_000);

  test('실물 git 프론트도어는 성공·실패·파이프에 상태 줄과 실제 종료 코드를 남긴다', () => {
    const status = spawnSync('bun', ['bin/elanous.mjs', 'git', 'status', '--porcelain'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    // Status is stderr by decision so stdout remains byte-preserving for JSON pipelines.
    expect((status.stderr ?? '').trimEnd().split('\n').at(-1)).toBe('[git] status ok rc=0');
    expect(status.status).toBe(0);

    const failed = spawnSync('bun', ['bin/elanous.mjs', 'git', 'no-such-subcommand'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(`${failed.stderr ?? ''}${failed.stdout ?? ''}`.trimEnd().split('\n').at(-1)).toMatch(/^\[git] no-such-subcommand FAILED rc=\d+$/);
    expect(failed.status).not.toBe(0);

    const piped = spawnSync('sh', ['-c', 'bun bin/elanous.mjs git no-such-subcommand 2>&1 | tail -1'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect((piped.stdout ?? '').trim()).toMatch(/^\[git] no-such-subcommand FAILED rc=\d+$/);
    expect(piped.status).toBe(0);
  }, 90_000);

  test('요약 문면이 수를 다 말한다', () => {
    const output = renderGitSpawnDiscipline(result, compareToBaseline(countsByFile(result), GIT_SPAWN_BASELINE));
    expect(output).toContain(`outside-seam=${result.counts.outsideSeam}`);
    expect(output).toContain(`in-seam=${result.counts.inSeam}`);
    expect(output).toContain('regressions=0');
  });
});
