import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatGateTiming, formatGateTimingScan, gateTiming, resolveGateLogDir, scanGateTiming } from './gate-timing';

const dirs: string[] = [];
function fixture(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-timing-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  return dir;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const min = (m: number) => m * 60_000;

describe('gateTiming', () => {
  test('첫 판(pod-<n>.json)과 재시도(-c·-r·-retry)를 가르고 합·중앙·최대·비중을 낸다', () => {
    const dir = fixture({
      'pod-0.json': { durationMs: min(10), rc: 0, files: ['a', 'b'], plannedSeconds: 120 },
      'pod-1.json': { durationMs: min(30), rc: 1, files: ['c'], plannedSeconds: 60 },
      'pod-2.json': { durationMs: min(20), rc: 0, files: [], jobFailed: true },
      'pod-1-c0.json': { durationMs: min(5), rc: 0 },
      'pod-1-c1-file-0.json': { durationMs: min(15), rc: 1 },
      'pod-2-r0.json': { durationMs: min(10), rc: 0 },
      'pod-0.junit.xml': '<x/>',
      'pod-0.log': 'log',
    });
    const r = gateTiming(dir);
    expect(r.measured).toBe(true);
    expect(r.firstPass).toEqual({ shards: 3, sumMin: 60, medianMin: 20, maxMin: 30, failedShards: ['pod-1', 'pod-2'] });
    expect(r.retries).toEqual({ runs: 3, sumMin: 30, medianMin: 10 });
    expect(r.retryShare).toBeCloseTo(30 / 90, 3);
    expect(r.slowestShards.map((s) => s.name)).toEqual(['pod-1', 'pod-2', 'pod-0']);
    expect(r.slowestShards[0]).toEqual({ name: 'pod-1', min: 30, files: 1, plannedMin: 1 });
    expect(r.slowestShards[1]!.plannedMin).toBeNull();
  });

  test('짝수 개 중앙값 · 상위 5 로 자른다 · 읽지 못한 파일은 따로 센다', () => {
    const files: Record<string, unknown> = {};
    for (let i = 0; i < 6; i++) files[`pod-${i}.json`] = { durationMs: min(i + 1), rc: 0, files: [] };
    files['pod-9.json'] = '{not json';
    files['pod-8.json'] = { rc: 0 };
    files['pod-7-c0.json'] = 'null';
    const r = gateTiming(fixture(files));
    expect(r.firstPass.shards).toBe(6);
    expect(r.firstPass.medianMin).toBe(3.5);
    expect(r.slowestShards).toHaveLength(5);
    expect([...r.unreadable].sort()).toEqual(['pod-7-c0.json', 'pod-8.json', 'pod-9.json']);
    expect(r.retries.runs).toBe(0);
    expect(r.retryShare).toBe(0);
  });

  test('빈 디렉토리 · 없는 디렉토리 → 0 이지만 «측정 없음»으로 표시한다', () => {
    for (const dir of [fixture({}), join(tmpdir(), 'gate-timing-does-not-exist-xyz')]) {
      const r = gateTiming(dir);
      expect(r.measured).toBe(false);
      expect(r.firstPass.shards).toBe(0);
      expect(r.firstPass.sumMin).toBe(0);
      expect(r.retries.runs).toBe(0);
      expect(r.retryShare).toBeNull();
      expect(formatGateTiming(r)).toContain('측정 없음');
    }
  });
});

describe('resolveGateLogDir', () => {
  test('버전이면 원장 루트 아래 cut 로그 · 경로면 그대로', () => {
    expect(resolveGateLogDir('0.2.18', '/L')).toBe('/L/release/0.2.18/gate-logs/cut');
    expect(resolveGateLogDir('/x/y', '/L')).toBe('/x/y');
    expect(resolveGateLogDir('./rel', '/L')).toBe('./rel');
  });
});

// ── LOGS-DEFAULT-ALL (0.2.20) — 기본 = 전 우주 ─────────────────────────────
// 실측 사건(0.2.19): 게이트 로그가 ⟨test:wt-release⟩ 의 `.elanous-test/release/0.2.19/gate-logs/cut` 에만
// 있었고, 운영 원장만 보는 도구가 «측정 없음»을 냈다. 옵션 없이 시험 우주가 보여야 한다.
function universe(version: string, pods: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'gate-timing-universe-'));
  dirs.push(root);
  const cut = join(root, 'release', version, 'gate-logs', 'cut');
  mkdirSync(cut, { recursive: true });
  for (const [name, body] of Object.entries(pods)) writeFileSync(join(cut, name), JSON.stringify(body));
  return root;
}
function emptyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gate-timing-prod-'));
  dirs.push(root);
  return root;
}

describe('scanGateTiming — 기본 = 전 우주', () => {
  test('시험 우주에만 있는 게이트 로그가 옵션 없이 보인다', () => {
    const prod = emptyRoot();
    const wt = universe('0.2.19', { 'pod-0.json': { durationMs: min(12), rc: 0, files: ['a'] } });
    const scan = scanGateTiming('0.2.19', {}, {
      ledgerRoot: prod,
      readInstances: () => ({ instances: [{ name: 'test:wt-release', stateDir: wt }], queryStatus: { registeredStores: true } }),
    });
    expect(scan.scope).toEqual({ roots: 2, registry: 'read', prodOnly: false, found: 1 });
    expect(scan.reports.map((r) => [r.universe, r.measured, r.firstPass.sumMin])).toEqual([['test:wt-release', true, 12]]);
    expect(formatGateTimingScan(scan)).toContain('⟨test:wt-release⟩ 게이트 시간');
  });

  test('--prod-only 는 운영 원장만 본다 — 시험 우주의 로그는 숨고 레지스트리도 안 읽는다', () => {
    const prod = emptyRoot();
    const wt = universe('0.2.19', { 'pod-0.json': { durationMs: min(12), rc: 0 } });
    let read = 0;
    const scan = scanGateTiming('0.2.19', { prodOnly: true }, {
      ledgerRoot: prod,
      readInstances: () => { read += 1; return { instances: [{ name: 'test:wt-release', stateDir: wt }], queryStatus: { registeredStores: true } }; },
    });
    expect(read).toBe(0);
    expect(scan.scope.registry).toBe('skipped');
    expect(scan.reports).toEqual([]);
    expect(formatGateTimingScan(scan)).toContain('측정 없음');
  });

  test('운영과 시험 둘 다 있으면 판마다 따로 낸다 · 같은 물리 루트(심링크)는 한 번만 센다', () => {
    const prod = universe('0.2.19', { 'pod-0.json': { durationMs: min(3), rc: 0 } });
    const alias = join(tmpdir(), `gate-timing-alias-${process.pid}-${Date.now()}`);
    symlinkSync(prod, alias);
    dirs.push(alias);
    const wt = universe('0.2.19', { 'pod-0.json': { durationMs: min(7), rc: 0 } });
    const scan = scanGateTiming('0.2.19', {}, {
      ledgerRoot: prod,
      readInstances: () => ({ instances: [
        { name: 'prod', stateDir: alias },
        { name: 'test:wt-release', stateDir: wt },
      ], queryStatus: { registeredStores: true } }),
    });
    expect(scan.scope.roots).toBe(2);
    expect(scan.reports.map((r) => [r.universe, r.firstPass.sumMin])).toEqual([['prod', 3], ['test:wt-release', 7]]);
  });

  test('레지스트리를 못 읽으면 «없다»가 아니라 «못 셈»으로 표시한다', () => {
    const partial = universe('0.2.19', { 'pod-0.json': { durationMs: min(1), rc: 0 } });
    const scan = scanGateTiming('0.2.19', {}, {
      ledgerRoot: emptyRoot(),
      // 못 읽은 판이 부분 목록을 돌려줘도 쓰지 않는다(표시 = 실제 본 범위)
      readInstances: () => ({ instances: [{ name: 'test:partial', stateDir: partial }], queryStatus: { registeredStores: false } }),
    });
    expect(scan.scope.registry).toBe('unreadable');
    expect(scan.scope.roots).toBe(1);
    expect(scan.reports).toEqual([]);
    const text = formatGateTimingScan(scan);
    expect(text).toContain('못 셈');
    expect(text).toContain('시험 우주는 못 셌다');
    // 못 센 상태에서 «어디에도 없다»고 단정하지 않는다
    expect(text).not.toContain('어디에도');
  });
});

describe('gate-timing CLI', () => {
  const script = join(import.meta.dir, 'gate-timing.ts');
  const run = (args: string[], home: string) => spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 30_000,
  });

  test('--help 첫 줄 = «기본 = 전 우주»', () => {
    const r = run(['--help'], emptyRoot());
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n')[0]).toContain('기본 = 전 우주');
  });

  test('옵션 없이 시험 우주(레지스트리 등록)의 게이트 로그를 읽는다 · --prod-only 면 숨는다', () => {
    const home = emptyRoot();
    const wt = universe('0.2.19', { 'pod-0.json': { durationMs: min(12), rc: 0 } });
    mkdirSync(join(home, '.elanous', 'logs'), { recursive: true });
    writeFileSync(join(home, '.elanous', 'logs', 'instances.json'), JSON.stringify({ instances: [
      { name: 'test:wt-release', stateDir: wt, pid: 999999, startedAt: '2026-10-07T00:00:00Z', kind: 'test' },
    ] }));
    const all = run(['0.2.19', '--json'], home);
    expect(all.status).toBe(0);
    const scan = JSON.parse(all.stdout) as { reports: Array<{ universe: string; measured: boolean }> };
    expect(scan.reports.map((r) => [r.universe, r.measured])).toEqual([['test:wt-release', true]]);
    const text = run(['0.2.19'], home);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('⟨test:wt-release⟩ 게이트 시간');
    const narrow = run(['0.2.19', '--prod-only'], home);
    expect(narrow.status).toBe(1);
    expect(narrow.stdout).toContain('측정 없음');
  });

  test('모르는 옵션은 삼키지 않고 거부한다', () => {
    const r = run(['0.2.19', '--prod'], emptyRoot());
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('알 수 없는 옵션');
  });
});
