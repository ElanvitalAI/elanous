/**
 * `test:deterministic` 이 CDP(실제 브라우저) 시험을 «파생으로» 빼는가.
 *
 * 🩸 왜 (🅕 실측 2026-09-24 · 브라우저가 «떠 있는» 상태):
 *   check-layout-landmark 19.7초/건 · check-layout 11.8초/건 ↔ CDP 를 «안» 타는 nav-signature 0.2초/건.
 *   CDP 시험 123~199건 × 약 14초 ⇒ 29~46분. 그리고 그 결과가 «브라우저 유무·부하»에 따라 달라져
 *   `deterministic` 이라는 이름에 안 맞았다(인계 §38-i: 로드 216 에서 「재서 틀린 값」).
 * 🅢 조건①: ***목록을 손으로 적지 않는다*** — 새 CDP 시험이 자동으로 따라와야 한다.
 * ⇒ 그래서 이 시험은 「목록이 맞나」가 아니라 ***「파생이 새 파일을 «자동으로» 무나」***를 묻는다.
 */
import { describe, expect, test } from 'bun:test';
import { deriveCdpTestPatterns, runDeterministicTests } from '../scripts/test-deterministic.js';

/** 자식을 안 띄우고 «넘어간 cmd» 만 붙잡는다. */
function captureCmd(argv: string[], patterns: string[]): Promise<string[]> {
  let seen: string[] = [];
  const spawn = ((opts: { cmd: string[] }) => {
    seen = opts.cmd;
    return { exited: Promise.resolve(0), kill: () => {}, pid: 1 };
  }) as never;
  return runDeterministicTests({
    argv,
    deriveCdpPatterns: () => patterns,
    // This fixture observes CDP forwarding. Mock-module child splitting has
    // its own contract in scripts/test-deterministic.test.ts.
    deriveMockModuleFiles: () => [],
    spawn,
    report: () => {},
    waitForSignal: () => new Promise<never>(() => {}),
  }).then(() => seen);
}

/** 주입된 rg 를 흉내낸다 — 실물 rg 를 부르지 않고 «파생 규칙»만 문다. */
function fakeRg(lines: string[]): typeof Bun.spawnSync {
  return (() => ({ stdout: new TextEncoder().encode(lines.join('\n')) })) as unknown as typeof Bun.spawnSync;
}

describe('CDP 레인 파생', () => {
  test('rg 가 낸 시험 파일을 그대로 «정렬해» 돌려준다', () => {
    const got = deriveCdpTestPatterns({
      spawnSync: fakeRg(['scripts/webclone/b.test.ts', 'test/a.test.ts', '']),
    });
    expect(got).toEqual(['scripts/webclone/b.test.ts', 'test/a.test.ts']);
  });

  /** ⭐ 🅢 조건①의 핵심 — 「새 CDP 시험이 «자동으로» 따라오나」. */
  test('새 CDP 시험 파일이 생기면 «손대지 않아도» 목록에 들어온다', () => {
    const before = deriveCdpTestPatterns({ spawnSync: fakeRg(['test/a.test.ts']) });
    const after = deriveCdpTestPatterns({
      spawnSync: fakeRg(['test/a.test.ts', 'test/zz-brand-new-cdp.test.ts']),
    });
    expect(before).not.toContain('test/zz-brand-new-cdp.test.ts');
    expect(after).toContain('test/zz-brand-new-cdp.test.ts');
    expect(after.length).toBe(before.length + 1);
  });

  test('시험 파일이 아닌 줄은 버린다 — rg 가 무엇을 내든 목록은 시험 파일뿐이다', () => {
    const got = deriveCdpTestPatterns({
      spawnSync: fakeRg(['scripts/webclone/test-cdp.ts', 'README.md', 'test/a.test.ts']),
    });
    expect(got).toEqual(['test/a.test.ts']);
  });

  /** ⛔ 음성 대조 — 파생이 «아무것도 못 찾으면» 빈 목록이어야 한다(조용히 전부를 빼면 안 된다).
   *  📏 돌려서 확인: 이 칸이 통과한다는 것은 「0개일 때 0개」이고, 호출부가 그때 «아무것도 안 뺀다».  */
  test('아무것도 못 찾으면 빈 목록 — 조용히 전부를 빼지 않는다', () => {
    expect(deriveCdpTestPatterns({ spawnSync: fakeRg([]) })).toEqual([]);
    expect(deriveCdpTestPatterns({ spawnSync: fakeRg(['']) })).toEqual([]);
  });

  /** ⭐ 실물 — 이 저장소에서 «진짜로» 파생되나. ⛔ 수를 박지 않는다(새 시험이 늘면 늙는다). */
  test('실물 저장소에서 CDP 시험을 하나 이상 파생한다', () => {
    const got = deriveCdpTestPatterns();
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((path) => path.endsWith('.test.ts'))).toBe(true);
  });
});
/** ⭐⭐ 여기부터가 «호출부»를 문다.
 *  🩸 2026-09-24: 처음엔 파생 «함수»만 무는 칸만 있었고, 음성 대조로 파생을 꺼도
 *  ***아무 칸도 안 빨개졌다***. 함수가 옳아도 호출부가 그것을 안 쓰면 아무 일도 안 일어난다. */
describe('CDP 레인 — 호출부', () => {
  test('파생한 파일마다 --path-ignore-patterns 한 쌍이 bun test 에 간다', async () => {
    const cmd = await captureCmd(['--dots'], ['test/a.test.ts', 'test/b.test.ts']);
    expect(cmd.slice(0, 2)).toEqual(['bun', 'test']);
    expect(cmd.filter((arg) => arg === '--path-ignore-patterns').length).toBe(2);
    expect(cmd).toContain('test/a.test.ts');
    expect(cmd).toContain('test/b.test.ts');
    expect(cmd[cmd.length - 1]).toBe('--dots');
  });

  /** ⛔ 음성 대조 — 파생이 비면 «아무것도» 안 뺀다(조용히 전부를 빼거나 빈 패턴을 넣지 않는다). */
  test('파생이 0개면 제외 인자가 하나도 안 붙는다', async () => {
    const cmd = await captureCmd(['--dots'], []);
    expect(cmd).toEqual(['bun', 'test', '--dots']);
  });

  /** ⭐ 사람이 «경로»를 직접 준 창은 「이것만 돌려라」다 — 그때는 빼지 않는다. */
  test('경로를 직접 주면 파생을 아예 안 부른다', async () => {
    let called = 0;
    const spawn = ((opts: { cmd: string[] }) => {
      expect(opts.cmd).toEqual(['bun', 'test', 'scripts/webclone/check-layout.test.ts']);
      return { exited: Promise.resolve(0), kill: () => {}, pid: 1 };
    }) as never;
    await runDeterministicTests({
      argv: ['scripts/webclone/check-layout.test.ts'],
      deriveCdpPatterns: () => { called += 1; return ['test/a.test.ts']; },
      spawn,
      report: () => {},
      waitForSignal: () => new Promise<never>(() => {}),
    });
    expect(called).toBe(0);
  });
});
