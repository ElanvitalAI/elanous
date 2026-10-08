import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateShardsPath, readGateShards, shardsLine, summarizeShards, writeGateShards, type GateShardsFile } from './gate-shards.js';

const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

/** 0.2.19 실측 모양: 24 조각 · 대기 8(CPU 부족) · 잘림 2 · 돌기 5 · 통과 9. */
function file(): GateShardsFile {
  const shards: GateShardsFile['shards'] = [];
  for (let i = 0; i < 9; i++) shards.push({ id: `pod-${i}`, state: 'done', startedAt: ago(40), endedAt: ago(20), rc: 0, plannedMin: 18 });
  for (let i = 9; i < 14; i++) shards.push({ id: `pod-${i}`, state: 'running', startedAt: ago(10), installSec: 95, plannedMin: 20 });
  for (let i = 14; i < 22; i++) shards.push({ id: `pod-${i}`, state: 'pending', waitReason: 'CPU 부족 31.2/32', plannedMin: 15 });
  shards.push({ id: 'pod-22', state: 'timeout', startedAt: ago(45), endedAt: ago(25), rc: 124, plannedMin: 20 });
  shards.push({ id: 'pod-23', state: 'timeout', startedAt: ago(45), endedAt: ago(25), rc: 124, plannedMin: 20 });
  return { v: 1, version: '0.2.20', updatedAt: ago(1), shards };
}

describe('gate shards — 조각 상태 표', () => {
  test('조각 24 의 상태별 수 · 대기 이유 · 남은 시간 추정', () => {
    const s = summarizeShards(file(), NOW);
    expect(s.total).toBe(24);
    expect(s.counts).toEqual({ pending: 8, running: 5, done: 9, retry: 0, timeout: 2, failed: 0 });
    expect(s.waitReasons).toEqual([{ reason: 'CPU 부족 31.2/32', count: 8 }]);
    // 도는 조각 남은 최대 10분 + 대기 8×15분 ÷ 자리 5 = 24 → 34분
    expect(s.etaMin).toBe(34);
    expect(s.staleMin).toBe(1);
    expect(shardsLine(s)).toBe('조각 24 · 돌기 5 · 대기 8(CPU 부족 31.2/32 8) · 잘림 2 · 통과 9 · 남은 약 34분');
  });

  test('계획 분이 없는 조각이 남아 있으면 추정하지 않는다(0 으로 꾸미지 않는다)', () => {
    const f = file();
    delete f.shards[15]!.plannedMin;
    const s = summarizeShards(f, NOW);
    expect(s.etaMin).toBeNull();
    expect(shardsLine(s)).toContain('남은 시간 추정 불가');
  });

  test('다 끝났으면 남은 0분 · 오래 안 바뀌면 경고', () => {
    const f: GateShardsFile = { v: 1, version: '0.2.20', updatedAt: ago(30), shards: [{ id: 'pod-0', state: 'done' }] };
    const s = summarizeShards(f, NOW);
    expect(s.etaMin).toBe(0);
    expect(shardsLine(s)).toBe('조각 1 · 통과 1 · 남은 약 0분 · ⚠️ 30분째 갱신 없음');
  });

  test('쓰기→읽기 왕복 · 임시 파일을 남기지 않는다 · 깨진 파일은 null', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-shards-'));
    try {
      const path = gateShardsPath('0.2.20', root);
      expect(path).toBe(join(root, 'release', '0.2.20', 'gate-logs', 'cut', 'shards.json'));
      expect(readGateShards(path)).toBeNull();
      writeGateShards(path, file());
      expect(readGateShards(path)).toEqual(file());
      expect(readdirSync(join(root, 'release', '0.2.20', 'gate-logs', 'cut'))).toEqual(['shards.json']);
      writeFileSync(path, '{"v":1,"version":"0.2.20"');
      expect(readGateShards(path)).toBeNull();
      writeFileSync(path, JSON.stringify({ v: 1, version: '0.2.20', updatedAt: ago(0), shards: [{ id: 'a', state: 'weird' }, { id: 'b', state: 'running' }] }));
      expect(readGateShards(path)?.shards).toEqual([{ id: 'b', state: 'running' }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test('a running shard past its plan says so instead of «남은 약 0분» (canary 10-07: planned 0.1 min · ran 22 min)', () => {
  const f: GateShardsFile = { v: 1, version: '0.2.20-alpha.901', updatedAt: ago(0), shards: [
    { id: 'pod-0', state: 'running', plannedMin: 0.1, startedAt: ago(20) },
    { id: 'pod-1', state: 'done', plannedMin: 0.1, startedAt: ago(20), endedAt: ago(1) },
  ] };
  const s = summarizeShards(f, NOW);
  expect(s.overrunMin).toBe(19);
  expect(shardsLine(s)).toBe('조각 2 · 돌기 1 · 통과 1 · 계획보다 19분 넘게 도는 중 — 남은 시간 추정 불가');
  expect(summarizeShards(file(), NOW).overrunMin).toBe(0);
});
