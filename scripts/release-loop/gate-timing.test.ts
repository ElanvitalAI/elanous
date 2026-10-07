import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatGateTiming, gateTiming, resolveGateLogDir } from './gate-timing';

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
