import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatGateWall, gateWall } from './gate-wall';

const dirs: string[] = [];
const min = (value: number) => value * 60_000;
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-wall-'));
  dirs.push(dir);
  return dir;
}
function pod(dir: string, name: string, commit: string, endMin: number, durationMin: number): void {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ commit, durationMs: min(durationMin) }));
  const end = new Date(Date.UTC(2026, 9, 9) + min(endMin));
  utimesSync(path, end, end);
}
function run(args: string[], home?: string) {
  return spawnSync(process.execPath, [join(import.meta.dir, 'gate-wall.ts'), ...args], {
    encoding: 'utf8', timeout: 30_000, env: home ? { ...process.env, HOME: home } : process.env,
  });
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('gateWall', () => {
  test('커밋 A 재시도만 셋을 B 루트 둘·재시도 하나에 섞지 않고 B 의 벽시계·루트·꼬리를 잰다', () => {
    const dir = fixture();
    pod(dir, 'pod-0-c0.json', 'aaaa1111', 190, 8);
    pod(dir, 'pod-1-c0.json', 'aaaa1111', 196, 6);
    pod(dir, 'pod-2-c0.json', 'aaaa1111', 200, 5);
    pod(dir, 'pod-0.json', 'bbbb2222', 116, 16); // start 100
    pod(dir, 'pod-1.json', 'bbbb2222', 121, 11); // start 110: roots 21
    pod(dir, 'pod-1-c1.json', 'bbbb2222', 138, 10); // start 128: wall 38, tail 17
    const report = gateWall(dir);
    expect(report).toMatchObject({ measured: true, commit: 'bbbb2222', records: 3, roots: 2, retries: 1,
      wallMin: 38, rootWallMin: 21, retryTailMin: 17, retryOnlyAttempts: 1, wallSource: 'pod-records' });
    writeFileSync(join(dir, 'shards.json'), JSON.stringify({ shards: [
      { id: 'pod-0', startedAt: '2026-10-09T01:40:00.000Z', endedAt: '2026-10-09T02:18:00.000Z' },
    ] }));
    expect(gateWall(dir)).toMatchObject({ commit: 'bbbb2222', shardsWallMin: null, disagree: false });
    expect(report.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ commit: 'aaaa1111', records: 3, roots: 0, retries: 3, rootWallMin: null }),
      expect.objectContaining({ commit: 'bbbb2222', records: 3, roots: 2, retries: 1 }),
    ]));
    expect(formatGateWall(report).split('\n')[0]).toBe('게이트 벽시계 38.0분(pod-records · 커밋 bbbb2222) · 목표 ≤30분 ✗ · 루트 21.0분 · 재시도 꼬리 17.0분 · 조각 준비 중앙 못 잼');
    expect(gateWall(dir, { commit: 'bbbb' }).commit).toBe('bbbb2222');
    expect(gateWall(dir, { commit: 'aaaa' }).measured).toBe(false);
    expect(gateWall(dir, { commit: 'cccc' }).measured).toBe(false);
  });

  test('가장 최근 루트 있는 커밋을 고르고 SHA 앞자리는 옛 루트 시도를 선택한다', () => {
    const dir = fixture();
    pod(dir, 'pod-0.json', 'old123', 10, 10);
    pod(dir, 'pod-1.json', 'new456', 30, 10);
    expect(gateWall(dir).commit).toBe('new456');
    expect(gateWall(dir, { commit: 'old' })).toMatchObject({ commit: 'old123', wallMin: 10, shardsWallMin: null });
    expect(gateWall(dir, { commit: 'n' }).commit).toBe('new456');
    expect(() => gateWall(dir, { commit: '' })).toThrow('모호한 커밋');
  });

  test('최신 시도에 루트가 없으면 이전 루트 시도에 shards.json 을 귀속하지 않는다', () => {
    const dir = fixture();
    pod(dir, 'pod-0.json', 'old', 31, 31);
    writeFileSync(join(dir, 'shards.json'), JSON.stringify({ shards: [
      { id: 'pod-0', startedAt: '2026-10-09T00:00:00.000Z', endedAt: '2026-10-09T00:38:00.000Z' },
    ] }));
    expect(gateWall(dir)).toMatchObject({ commit: 'old', shardsWallMin: 38, disagree: true });
    pod(dir, 'pod-0-c0.json', 'new', 40, 4);
    expect(gateWall(dir)).toMatchObject({ commit: 'old', retryOnlyAttempts: 1, shardsWallMin: null, disagree: false });
    expect(gateWall(dir, { commit: 'old' })).toMatchObject({ commit: 'old', shardsWallMin: null, disagree: false });
  });

  test('shards.json 행의 루트 ID 를 현재 커밋에서 확인할 수 없으면 비교를 생략한다', () => {
    const dir = fixture();
    pod(dir, 'pod-0.json', 'old', 10, 10);
    pod(dir, 'pod-1.json', 'new', 31, 31);
    writeFileSync(join(dir, 'shards.json'), JSON.stringify({ shards: [
      { id: 'pod-0', startedAt: '2026-10-09T00:00:00.000Z', endedAt: '2026-10-09T00:38:00.000Z' },
    ] }));
    expect(gateWall(dir)).toMatchObject({ commit: 'new', shardsWallMin: null, disagree: false });
  });

  test('이어 붙인 junit 부분에서 파일별 초를 합산하고 누락·읽지 못하는 루트는 제외한다', () => {
    const dir = fixture();
    pod(dir, 'pod-0.json', 'b', 20, 20);
    pod(dir, 'pod-1.json', 'b', 20, 20);
    pod(dir, 'pod-2.json', 'b', 20, 20);
    writeFileSync(join(dir, 'pod-0.junit.xml'), '<testsuite file="a.test.ts" time="300"><testsuite file="nested" time="999"/></testsuite>\n'
      + '<testsuite file="b.test.ts" time="420"></testsuite>');
    writeFileSync(join(dir, 'pod-2.junit.xml'), '<not-junit/>');
    const report = gateWall(dir);
    expect(report.overhead).toEqual({ medianMin: 8, p90Min: 8, unmeasuredRoots: 2 });
    expect(formatGateWall(report)).toContain('조각 준비 중앙 8.0분');
    expect(report.wallMin).toBe(20);
  });

  test('20분 루트의 이어 붙인 파일 시간 12분은 준비 8분, junit 없는 두 번째 루트는 못 잰다', () => {
    const dir = fixture();
    pod(dir, 'pod-0.json', 'cut', 20, 20);
    pod(dir, 'pod-1.json', 'cut', 20, 20);
    writeFileSync(join(dir, 'pod-0.junit.xml'), '<testsuite file="a.test.ts" time="300"/>\n'
      + '<testsuite file="b.test.ts" time="420"/>');
    expect(gateWall(dir).overhead).toEqual({ medianMin: 8, p90Min: 8, unmeasuredRoots: 1 });
  });

  test('중앙·p90 은 측정된 루트만 쓰며 p90 은 최근접 순위', () => {
    const dir = fixture();
    for (let i = 0; i < 4; i++) {
      pod(dir, `pod-${i}.json`, 'commit', 30, 20);
      writeFileSync(join(dir, `pod-${i}.junit.xml`), `<testsuite file="a${i}" time="${(20 - (i + 1) * 2) * 60}"/>`);
    }
    expect(gateWall(dir).overhead).toEqual({ medianMin: 5, p90Min: 8, unmeasuredRoots: 0 });
  });

  test('빈·없는 디렉토리와 루트가 없는 시도는 측정 없음이지 0분이 아니다', () => {
    const empty = fixture();
    for (const dir of [empty, join(empty, 'missing')]) {
      const report = gateWall(dir);
      expect(report).toMatchObject({ measured: false, wallMin: null, rootWallMin: null, retryTailMin: null,
        shardsWallMin: null, disagree: false, overhead: { medianMin: null, p90Min: null } });
      expect(formatGateWall(report).split('\n')[0]).toContain('게이트 벽시계 못 잼');
      expect(formatGateWall(report)).not.toContain('0.0분');
    }
  });

  test('31분과 표시상 30.0분인 30.01분은 모두 원래 시간으로 판정한다', () => {
    const dir = fixture();
    pod(dir, 'pod-0.json', 'cut', 31, 31);
    expect(formatGateWall(gateWall(dir))).toContain('목표 ≤30분 ✗');
    expect(formatGateWall(gateWall(dir, { targetMin: 31 }))).toContain('목표 ≤31분 ✓');
    pod(dir, 'pod-0.json', 'cut', 30.01, 30.01);
    expect(gateWall(dir).wallMin).toBeCloseTo(30.01, 6);
    expect(formatGateWall(gateWall(dir)).split('\n')[0]).toContain('벽시계 30.0분(pod-records · 커밋 cut) · 목표 ≤30분 ✗');
    expect(formatGateWall(gateWall(dir, { targetMin: 30.01 }))).toContain('목표 ≤30.01분 ✓');
  });

  test('shards.json 의 차이 7분을 두 값으로 보존하고 5분 이하 차이는 불일치가 아니다', () => {
    const dir = fixture();
    pod(dir, 'pod-0.json', 'cut', 31, 31);
    const shards = (end: string) => writeFileSync(join(dir, 'shards.json'), JSON.stringify({ shards: [
      { id: 'pod-0', startedAt: '2026-10-09T00:00:00.000Z', endedAt: end },
    ] }));
    shards('2026-10-09T00:38:00.000Z');
    expect(gateWall(dir)).toMatchObject({ wallMin: 31, shardsWallMin: 38, disagree: true });
    expect(formatGateWall(gateWall(dir))).toContain('shards.json 벽시계 38.0분 · 기록 추정 31.0분 · ⚠ 5분 초과 불일치');
    shards('2026-10-09T00:36:00.000Z');
    expect(gateWall(dir)).toMatchObject({ wallMin: 31, shardsWallMin: 36, disagree: false });
  });

  test('못 읽은 기록이 있으면 ≤목표를 ✓로 확정하지 않고, 이미 넘은 값은 ✗로 남긴다', () => {
    const dir = fixture();
    pod(dir, 'pod-0.json', 'cut', 10, 10);
    writeFileSync(join(dir, 'pod-0-c0.json'), '{');
    const held = gateWall(dir);
    expect(held).toMatchObject({ wallMin: 10, verdict: 'undetermined', unreadable: ['pod-0-c0.json'] });
    const text = formatGateWall(held);
    expect(text.split('\n')[0]).toContain('목표 ≤30분 판정 보류(못 읽은 기록 1)');
    expect(text).not.toContain('✓');
    expect(text).toContain('⚠ 못 읽은 기록 1: pod-0-c0.json');
    pod(dir, 'pod-0.json', 'cut', 40, 40);
    expect(gateWall(dir).verdict).toBe('fail');
    expect(formatGateWall(gateWall(dir)).split('\n')[0]).toContain('목표 ≤30분 ✗');
  });

  test('이전 시도가 같은 pod-0 ID 로 남긴 shards.json 은 대조하지 않고 생략을 드러낸다', () => {
    const dir = fixture();
    pod(dir, 'pod-0.json', 'cut', 100, 20); // this attempt: 80 → 100 min
    writeFileSync(join(dir, 'shards.json'), JSON.stringify({ shards: [
      { id: 'pod-0', startedAt: '2026-10-09T00:10:00.000Z', endedAt: '2026-10-09T00:30:00.000Z' }, // an earlier attempt
    ] }));
    const report = gateWall(dir);
    expect(report).toMatchObject({ shardsWallMin: null, disagree: false, shardsSkipped: 'outside-attempt-window', verdict: 'pass' });
    expect(formatGateWall(report)).toContain('shards.json 대조 생략 — 이 시도의 것인지 확인 못 함(outside-attempt-window)');
  });

  test('읽지 못하는 기록을 건너뛰고 측정 전후 원장 파일의 내용·mtime 을 변경하지 않는다', () => {
    const dir = fixture();
    pod(dir, 'pod-0.json', 'cut', 20, 10);
    writeFileSync(join(dir, 'pod-1.json'), '{');
    const before = readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8'), statSync(join(dir, name)).mtimeMs]);
    expect(gateWall(dir)).toMatchObject({ measured: true, unreadable: ['pod-1.json'] });
    const after = readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8'), statSync(join(dir, name)).mtimeMs]);
    expect(after).toEqual(before);
  });
});

describe('gate-wall CLI', () => {
  test('버전은 기존 원장 해석기로 읽고 JSON·--commit·--target-min 을 적용한다', () => {
    const home = fixture();
    const cut = join(home, '.elanous', 'release', '0.2.23', 'gate-logs', 'cut');
    mkdirSync(cut, { recursive: true });
    pod(cut, 'pod-0.json', 'abc123', 31, 31);
    const r = run(['0.2.23', '--commit', 'abc', '--target-min', '31', '--json'], home);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ measured: true, commit: 'abc123', wallMin: 31, targetMin: 31 });
    expect(run([cut], home).stdout.split('\n')[0]).toContain('목표 ≤30분 ✗');
  });

  test('모르는 옵션과 잘못된 값을 exit 2로 거부하고 없는 경로를 못 잼으로 낸다', () => {
    const dir = fixture();
    for (const args of [[dir, '--bogus'], [dir, '--commit'], [dir, '--target-min', 'zero'], [dir, '--target-min', '0'], [dir, '--commit', '--bogus'], [dir, '--target-min', '-1'], [dir, 'extra']]) {
      expect(run(args).status).toBe(2);
    }
    const missing = run([join(dir, 'missing')]);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain('못 잼');
  });
});
