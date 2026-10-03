/**
 * 🅢 70차 후속 — `dev --ask` 를 «실물 진입점»으로 검증한다 (🅣 리뷰 must-fix ① · 2026-08-11).
 *
 * ⛔ 왜 in-process 시험으로는 부족한가 — `CLAUDE.md`(2026-08-03 · #6701→#6710):
 *   ***반증 자기검증은 「테스트가 코드를 무는가」만 답하고 「그 코드가 실행 경로에 있는가」는
 *   구조적으로 못 답한다. 진입점을 바꾸는 변경은 진입점으로 검증한다.***
 *
 * 📏 그리고 이 PR 이 «그 병»을 실제로 앓았다: `--live-run-window` 에 Commander `parseInt` 변환기가
 *   달려 있어 검증기가 실행 경로 «밖»이었다. 단위 시험 27개가 그것을 못 봤고, 리뷰가 봤다.
 *
 * ⚠️ 비용 규율: 여기서 «저작(≈107초)까지 가는» 경우는 안 돈다. 인자 층에서 갈리는 것만 문다.
 */
import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isObviouslyLongAskPath } from '../index.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const REPO = resolve(import.meta.dir, '..', '..');
const BIN = resolve(REPO, 'bin', 'elanous.mjs');

function runDev(args: readonly string[]): { code: number | null; stderr: string } {
  const r = spawnSync('bun', [BIN, '--test', 'dev', ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY: '1' },
  });
  return { code: r.status, stderr: `${r.stderr ?? ''}${r.stdout ?? ''}` };
}

describe('dev --ask — 실물 진입점(spawn)에서 인자 계약이 서는가', () => {
  test('[substrate-selection] dev --ask exposes the substrate options and rejects an unsupported Pod target before authoring', () => {
    const help = spawnSync('bun', [BIN, '--test', 'dev', '--help-all'], { cwd: REPO, encoding: 'utf8', timeout: 60_000 });
    expect(help.stdout).toContain('--substrate <kind>');
    expect(help.stdout).toContain('--pod-pool <spec>');
    const local = runDev(['--ask', '/tmp/elanous-ask-does-not-exist.txt', '--substrate', 'local']);
    expect(local.stderr).toContain('ENOENT');
    const invalid = runDev(['--ask', '/tmp/elanous-ask-does-not-exist.txt', '--substrate', 'invalid']);
    expect(invalid.stderr).toContain('Allowed choices are local, pod');
    const target = runDev(['--ask', '/tmp/elanous-ask-does-not-exist.txt', '--substrate', 'pod', '--pod-pool', 'pool-test:1', '--target', '/tmp/target']);
    expect(target.stderr).toContain('`--target` 은 Pod 경로에서 아직 지원하지 않는다');
    expect(target.stderr).not.toContain('ENOENT');
  });

  test('[option-exists] `--ask` 가 도움말에 실제로 노출된다', () => {
    const r = spawnSync('bun', [BIN, '--test', 'dev', '--help'], { cwd: REPO, encoding: 'utf8', timeout: 60_000 });
    expect(r.stdout).toContain('--ask <path>');
    const all = spawnSync('bun', [BIN, '--test', 'dev', '--help-all'], { cwd: REPO, encoding: 'utf8', timeout: 60_000 });
    expect(all.stdout).toContain('--force-preflight');
    // ⛔ 2026-09-02: `--live-run-window` 는 «은퇴»했다(대표 지시 · #15264). 도움말에 «없는 것»이 맞다.
    //   이 단언이 지키던 것은 「그 축이 실물 진입점에 닿는가」이고, 그 자리는 이제 «은퇴 안내»다.
    expect(all.stdout).not.toContain('--live-run-window');
  });

  test('[window-rejected-at-cli] 잘못된 임계가 «실제 CLI»에서 거부된다 — 저작 전에', () => {
    // ⛔ 이것이 in-process 로는 못 잡던 자리다: Commander 변환기가 값을 먼저 깎으면 여기서 통과해 버린다.
    // ⛔ 2026-09-02: 그 옵션은 은퇴했다. 「임계 검증」이 아니라 «은퇴 안내»가 «저작 전에» 거부한다.
    //   ⭐ 지키는 것은 그대로다 — ***파일 없음(ENOENT)까지 가기 «전»에 멈춘다***.
    for (const bad of ['1.5', '1e2', '0', 'abc']) {
      const { code, stderr } = runDev(['--ask', '/tmp/elanous-ask-does-not-exist.txt', '--live-run-window', bad]);
      expect(code).toBe(1);
      expect(stderr).toContain('--live-run-window 은퇴');
      expect(stderr).toContain('적용 기본값');
      expect(stderr).not.toContain('ENOENT');
    }
  });

  test('[window-accepted-at-cli] 성한 임계는 통과해 «다음 단계»로 간다', () => {
    // ⛔ 2026-09-02: 성한 값이어도 그 옵션은 «없다» — 은퇴 안내가 먼저 멈춘다(기본값 30분이 그대로 적용된다).
    const { code, stderr } = runDev(['--ask', '/tmp/elanous-ask-does-not-exist.txt', '--live-run-window', '45']);
    expect(code).toBe(1);
    expect(stderr).toContain('--live-run-window 은퇴');
    // ⭐ 그리고 «무엇이 기본이 됐나»를 말한다 — 사람이 그 값을 못 바꾸게 됐으므로 더 중요하다.
    expect(stderr).toContain('적용 기본값');
  });

  // ⛔ 문면은 `#8177`(v34 · `--say` 입구)에서 「--ask 또는 --say 와 함께만」으로 «넓어졌는데»
  //   이 기대값이 `#8161` 것 그대로라 그날 오후부터 «계속 빨갰다». 빨간 시험은 새 회귀를 가린다.
  //   ⇒ 두 이름을 «둘 다» 문다 — 한쪽만 물면 다음에 입구가 늘 때 또 같은 자리가 조용히 깨진다.
  test('[dependent-options-rejected] `--ask`/`--say` 없이 종속 인자를 주면 실물 CLI 가 거부한다', () => {
    const { code, stderr } = runDev(['--force-preflight', 'some feature text']);
    expect(code).toBe(1);
    expect(stderr).toContain('--ask');
    expect(stderr).toContain('--say');
    expect(stderr).toContain('와 함께만');
  });

  test('[mutual-exclusion] `--ask` 와 `--file` 을 같이 주면 거부한다', () => {
    const { code, stderr } = runDev(['--ask', '/tmp/a.txt', '--file', '/tmp/b.md']);
    expect(code).toBe(1);
    expect(stderr).toContain('동시 사용 불가');
  });

  test('[long-ask-rejected] 명백히 긴 `--ask` 값은 파일 열기 전에 경로/`--say` 안내로 거부하고 한 줄이 1000자 미만이다', () => {
    const longValue = 'x'.repeat(5000);
    const { code, stderr } = runDev(['--ask', longValue]);
    expect(code).toBe(1);
    expect(stderr).toContain('--ask 는 파일 경로를 받는다');
    expect(stderr).toContain('--say');
    expect(stderr).toContain('은퇴 예정');
    expect(stderr).toContain('…');
    expect(stderr).not.toContain(longValue);
    expect(stderr).not.toContain('ENAMETOOLONG');
    const longest = Math.max(0, ...stderr.split('\n').map((line) => line.length));
    expect(longest).toBeLessThan(1000);
  });

  test('[long-ask-component-256-400] 256~400자 단일 구성요소는 파일 열기 전에 --ask/--say 안내로 거부한다', () => {
    const midLong = 'x'.repeat(300);
    expect(midLong.length).toBeGreaterThan(256);
    expect(midLong.length).toBeLessThanOrEqual(400);
    const { code, stderr } = runDev(['--ask', midLong]);
    expect(code).toBe(1);
    expect(stderr).toContain('--ask 는 파일 경로를 받는다');
    expect(stderr).toContain('--say');
    expect(stderr).toContain('은퇴 예정');
    expect(stderr).not.toContain('ENAMETOOLONG');
    const longest = Math.max(0, ...stderr.split('\n').map((line) => line.length));
    expect(longest).toBeLessThan(1000);
  });

  test.skipIf(process.platform === 'win32')('[long-ask-posix-backslash-component] POSIX에서 \\ 를 포함한 401바이트 단일 구성요소는 파일 열기 전에 --ask/--say 안내로 거부한다', () => {
    const longValue = `${'a'.repeat(200)}\\${'b'.repeat(200)}`;
    expect(Buffer.byteLength(longValue, 'utf8')).toBe(401);
    const { code, stderr } = runDev(['--ask', longValue]);
    expect(code).toBe(1);
    expect(stderr).toContain('--ask 는 파일 경로를 받는다');
    expect(stderr).toContain('--say');
    expect(stderr).toContain('은퇴 예정');
    expect(stderr).not.toContain('ENAMETOOLONG');
    const longest = Math.max(0, ...stderr.split('\n').map((line) => line.length));
    expect(longest).toBeLessThan(1000);
  });

  test('[long-ask-newline-normalized] 앞 400자에 개행이 있어도 은퇴 안내는 한 줄이고 --ask/--say 를 포함한다', () => {
    const withNewline = `hello\r\nworld\n${'x'.repeat(5000)}`;
    const { code, stderr } = runDev(['--ask', withNewline]);
    expect(code).toBe(1);
    expect(stderr).toContain('--ask 는 파일 경로를 받는다');
    expect(stderr).toContain('--say');
    expect(stderr).toContain('은퇴 예정');
    expect(stderr).toContain('…');
    expect(stderr).not.toContain('ENAMETOOLONG');
    const notice = stderr.split('\n').find((line) => line.includes('은퇴 예정'));
    expect(notice).toBeDefined();
    expect(notice).toContain('\\n');
    expect(notice).not.toMatch(/\r/);
    expect(notice!.includes('\n')).toBe(false);
    const longest = Math.max(0, ...stderr.split('\n').map((line) => line.length));
    expect(longest).toBeLessThan(1000);
  });

  // 판정 신호 ⑤: 긴 값 안내를 항상 내면 이 단언이 실패한다.
  test('[short-missing-path] 짧은 미존재 경로는 파일 오류를 내고 문장 안내를 붙이지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-ask-missing-'));
    const missing = join(dir, `does-not-exist-${process.pid}.txt`);
    try {
      const { code, stderr } = runDev(['--ask', missing]);
      expect(code).toBe(1);
      expect(stderr).toContain('ENOENT');
      expect(stderr).toContain('no such file');
      expect(stderr).toContain(missing);
      expect(stderr).not.toContain('…');
      expect(stderr).not.toContain('--ask 는 파일 경로를 받는다');
      expect(stderr).not.toContain('문장은 --say');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('[short-existing-path] 짧은 정상 경로는 은퇴 안내에 경로가 잘리지 않고 그대로 실린다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-ask-'));
    const file = join(dir, 'goal.txt');
    writeFileSync(file, '');
    try {
      const { code, stderr } = runDev(['--ask', file]);
      expect(code).toBe(1);
      const notice = stderr.split('\n').find((line) => line.includes('은퇴 예정'));
      expect(notice).toBeDefined();
      expect(notice).toContain(file);
      expect(notice).not.toContain('…');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 표시 절단과 경로 거부는 다른 자: PATH_MAX 아래·구성요소≤255 인 값은 문장 안내를 내지 않는다.
  // ENOENT 줄은 짧은 미존재 경로와 같이 경로 전문을 실을 수 있으므로 은퇴 안내 줄만 자름을 문다.
  test('[notice-truncates-display-only] 구성요소≤255·표시 한도 초과·플랫폼 PATH_MAX 미만 경로는 은퇴 안내만 자르고 문장 안내는 내지 않는다', () => {
    const longPlausible = `/tmp/${['a', 'b', 'c', 'd'].map((ch) => ch.repeat(200)).join('/')}.txt`;
    const bytes = Buffer.byteLength(longPlausible, 'utf8');
    expect(bytes).toBeGreaterThan(400);
    expect(bytes).toBeLessThan(1024);
    expect(longPlausible.split('/').every((part) => part.length <= 255)).toBe(true);
    const { code, stderr } = runDev(['--ask', longPlausible]);
    expect(code).toBe(1);
    expect(stderr).toContain('은퇴 예정');
    expect(stderr).not.toContain('--ask 는 파일 경로를 받는다');
    expect(stderr).not.toContain('문장은 --say');
    const notice = stderr.split('\n').find((line) => line.includes('은퇴 예정'));
    expect(notice).toBeDefined();
    expect(notice).toContain('…');
    expect(notice).not.toContain(longPlausible);
    expect(notice!.length).toBeLessThan(1000);
    const longest = Math.max(0, ...stderr.split('\n').map((line) => line.length));
    expect(longest).toBeLessThan(1000);
  });

  // 4096바이트 가드만 있으면 macOS 파일 열기가 ENAMETOOLONG 을 낸다. Darwin 상한(1024)에서만 사전 거부된다.
  test.skipIf(process.platform !== 'darwin')('[notice-truncates-plausible-long-path] macOS에서 1024~1200바이트 다중 구성요소 `--ask` 는 파일 열기 전에 --ask/--say 안내로 거부한다', () => {
    const longMacPath = `/tmp/${['a', 'b', 'c', 'd', 'e'].map((ch) => ch.repeat(200)).join('/')}/${'f'.repeat(180)}.txt`;
    const bytes = Buffer.byteLength(longMacPath, 'utf8');
    expect(bytes).toBeGreaterThanOrEqual(1024);
    expect(bytes).toBeLessThanOrEqual(1200);
    expect(longMacPath.split('/').every((part) => part.length <= 255)).toBe(true);
    const { code, stderr } = runDev(['--ask', longMacPath]);
    expect(code).toBe(1);
    expect(stderr).toContain('은퇴 예정');
    expect(stderr).toContain('…');
    expect(stderr).not.toContain(longMacPath);
    expect(stderr).toContain('--ask 는 파일 경로를 받는다');
    expect(stderr).toContain('--say');
    expect(stderr).not.toContain('ENAMETOOLONG');
    const notice = stderr.split('\n').find((line) => line.includes('은퇴 예정'));
    expect(notice).toBeDefined();
    expect(notice!.length).toBeLessThan(1000);
    const longest = Math.max(0, ...stderr.split('\n').map((line) => line.length));
    expect(longest).toBeLessThan(1000);
  });

  test.skipIf(process.platform === 'win32')('[long-ask-posix-emoji-component] POSIX에서 😀×100 구성요소는 파일 열기 전에 --ask/--say 안내로 거부한다', () => {
    const emoji100 = '😀'.repeat(100);
    expect(Buffer.byteLength(emoji100, 'utf8')).toBe(400);
    const { code, stderr } = runDev(['--ask', emoji100]);
    expect(code).toBe(1);
    expect(stderr).toContain('--ask 는 파일 경로를 받는다');
    expect(stderr).toContain('--say');
    expect(stderr).toContain('은퇴 예정');
    expect(stderr).not.toContain('ENAMETOOLONG');
    expect(stderr).not.toContain('\uFFFD');
    const notice = stderr.split('\n').find((line) => line.includes('은퇴 예정'));
    expect(notice).toBeDefined();
    expect(notice).toContain('😀');
    expect(notice).toContain('…');
    expect(notice).not.toContain('\uFFFD');
    // 고립 surrogate 가 UTF-8 왕복에서 U+FFFD 로 바뀌지 않았고, 잘린 앞부분의 😀 도 코드 포인트로 온전하다.
    expect(notice!.match(/😀/g)?.length ?? 0).toBeGreaterThan(0);
    expect([...notice!].some((ch) => ch === '\uFFFD' || (ch.length === 1 && ch >= '\uD800' && ch <= '\uDFFF'))).toBe(false);
    const longest = Math.max(0, ...stderr.split('\n').map((line) => line.length));
    expect(longest).toBeLessThan(1000);
  });

  test('[long-ask-control-chars-one-line] VT·FF·ESC/ANSI 가 긴 입력 앞부분에 있어도 은퇴 안내는 한 줄이고 제어문자는 가시적 escape 다', () => {
    const withControls = `hello\vworld\f\x1b[2J${'x'.repeat(5000)}`;
    const { code, stderr } = runDev(['--ask', withControls]);
    expect(code).toBe(1);
    expect(stderr).toContain('--ask 는 파일 경로를 받는다');
    expect(stderr).toContain('--say');
    expect(stderr).toContain('은퇴 예정');
    expect(stderr).toContain('…');
    expect(stderr).not.toContain('ENAMETOOLONG');
    const physicalLines = stderr.split(/\r\n|\r|\n|\u2028|\u2029|\v|\f/);
    const noticeLines = physicalLines.filter((line) => line.includes('은퇴 예정'));
    expect(noticeLines).toHaveLength(1);
    const notice = noticeLines[0]!;
    expect(notice).toContain('\\x0b');
    expect(notice).toContain('\\x0c');
    expect(notice).toContain('\\x1b');
    expect(notice).toContain('[2J');
    expect(notice).not.toMatch(/[\v\f\x1b]/);
    expect(notice).not.toMatch(/[\r\n\u2028\u2029]/);
    const longest = Math.max(0, ...physicalLines.map((line) => line.length));
    expect(longest).toBeLessThan(1000);
  });

  test('[long-ask-unicode-separators-one-line] U+2028·U+2029 가 긴 입력 앞부분에 있어도 은퇴 안내는 물리적으로 한 줄이다', () => {
    for (const sep of ['\u2028', '\u2029'] as const) {
      const withSep = `hello${sep}world${'x'.repeat(5000)}`;
      const { code, stderr } = runDev(['--ask', withSep]);
      expect(code).toBe(1);
      expect(stderr).toContain('--ask 는 파일 경로를 받는다');
      expect(stderr).toContain('--say');
      expect(stderr).toContain('은퇴 예정');
      expect(stderr).toContain('…');
      expect(stderr).not.toContain('ENAMETOOLONG');
      expect(stderr).not.toContain('\u2028');
      expect(stderr).not.toContain('\u2029');
      const escaped = sep === '\u2028' ? '\\u2028' : '\\u2029';
      const physicalLines = stderr.split(/\r\n|\r|\n|\u2028|\u2029/);
      const noticeLines = physicalLines.filter((line) => line.includes('은퇴 예정'));
      expect(noticeLines).toHaveLength(1);
      const notice = noticeLines[0]!;
      expect(notice).toContain(`hello${escaped}world`);
      expect(notice).not.toMatch(/[\r\n\u2028\u2029]/);
      const longest = Math.max(0, ...physicalLines.map((line) => line.length));
      expect(longest).toBeLessThan(1000);
    }
  });

  test.skipIf(process.platform !== 'win32')('[win32-emoji-100-kept-at-cli] Windows에서 😀×100 은 문장 안내를 내지 않는다', () => {
    const emoji100 = '😀'.repeat(100);
    expect(emoji100.length).toBe(200);
    const { code, stderr } = runDev(['--ask', emoji100]);
    expect(code).toBe(1);
    expect(stderr).not.toContain('--ask 는 파일 경로를 받는다');
    expect(stderr).not.toContain('문장은 --say');
  });
});

describe('isObviouslyLongAskPath — 플랫폼 단위·한계', () => {
  const emoji100 = '😀'.repeat(100);

  test('[win32-emoji-100-kept] Windows에서 😀×100 (UTF-16 200 · UTF-8 400)은 경로로 유지한다', () => {
    expect(emoji100.length).toBe(200);
    expect(Buffer.byteLength(emoji100, 'utf8')).toBe(400);
    expect(isObviouslyLongAskPath(emoji100, 'win32')).toBe(false);
    expect(isObviouslyLongAskPath(`${emoji100}.txt`, 'win32')).toBe(false);
  });

  test('[win32-emoji-128-rejected] Windows에서 😀×128 (UTF-16 256)은 안내 대상이다', () => {
    const emoji128 = '😀'.repeat(128);
    expect(emoji128.length).toBe(256);
    expect(isObviouslyLongAskPath(emoji128, 'win32')).toBe(true);
  });

  test('[posix-emoji-100-rejected] POSIX에서 😀×100 (UTF-8 400바이트)은 안내 대상이다', () => {
    expect(isObviouslyLongAskPath(emoji100, 'darwin')).toBe(true);
    expect(isObviouslyLongAskPath(emoji100, 'linux')).toBe(true);
  });

  test('[posix-path-max-by-platform] Linux 4096과 그 외 POSIX 1024을 갈라, FreeBSD/OpenBSD/SunOS 는 Linux 값으로 일반화하지 않는다', () => {
    const longPath = `/tmp/${['a', 'b', 'c', 'd', 'e'].map((ch) => ch.repeat(200)).join('/')}/${'f'.repeat(180)}.txt`;
    const bytes = Buffer.byteLength(longPath, 'utf8');
    expect(bytes).toBeGreaterThanOrEqual(1024);
    expect(bytes).toBeLessThan(4096);
    expect(longPath.split('/').every((part) => part.length <= 255)).toBe(true);
    expect(isObviouslyLongAskPath(longPath, 'linux')).toBe(false);
    expect(isObviouslyLongAskPath(longPath, 'android')).toBe(false);
    expect(isObviouslyLongAskPath(longPath, 'darwin')).toBe(true);
    expect(isObviouslyLongAskPath(longPath, 'freebsd')).toBe(true);
    expect(isObviouslyLongAskPath(longPath, 'openbsd')).toBe(true);
    expect(isObviouslyLongAskPath(longPath, 'netbsd')).toBe(true);
    expect(isObviouslyLongAskPath(longPath, 'sunos')).toBe(true);
    expect(isObviouslyLongAskPath(longPath, 'aix')).toBe(true);
    expect(isObviouslyLongAskPath(longPath, 'haiku')).toBe(true);
  });
});
