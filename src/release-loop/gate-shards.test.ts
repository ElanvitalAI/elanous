import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateShardsPath, readGateShards, recordGateShardsVerdict, shardsLine, summarizeShards, writeGateShards, type GateShardsFile } from './gate-shards.js';

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
    expect(shardsLine(s)).toBe('조각 24 · 돌기 5 · 대기 8(CPU 부족 31.2/32 8) · 잘림 2 · 끝 9 · 남은 약 34분');
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
    expect(shardsLine(s)).toBe('조각 1 · 끝 1 · 남은 약 0분 · ⚠️ 30분째 갱신 없음');
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
  expect(shardsLine(s)).toBe('조각 2 · 돌기 1 · 끝 1 · 계획보다 19분 넘게 도는 중 — 남은 시간 추정 불가');
  expect(summarizeShards(file(), NOW).overrunMin).toBe(0);
});

test('a finished shard with rc≠0 is never «통과» — before the verdict it is «rc≠0 · 판정 전» (0.2.20 cut: four done shards were all rc 1)', () => {
  const f: GateShardsFile = { v: 1, version: '0.2.20', updatedAt: ago(0), shards: [
    { id: 'pod-20', state: 'done', rc: 1, plannedMin: 3.9, startedAt: ago(14), endedAt: ago(1) },
    { id: 'pod-21', state: 'done', rc: 0, plannedMin: 3.9, startedAt: ago(14), endedAt: ago(1) },
    { id: 'pod-22', state: 'running', plannedMin: 30, startedAt: ago(14) },
  ] };
  const s = summarizeShards(f, NOW);
  expect(s.doneWithFailures).toBe(1);
  expect(s.verdict).toBeNull();
  expect(shardsLine(s)).toBe('조각 3 · 돌기 1 · 끝 2(rc≠0 1 · 기존 실패 포함 · 판정 전) · 남은 약 16분');
});

describe('GATE-LIVE-OBS-RC-WORDING — the done tail splits before/after the gate verdict', () => {
  const done = (verdict?: GateShardsFile['verdict']): GateShardsFile => ({
    v: 1, version: '0.2.21', updatedAt: ago(0), shards: [
      { id: 'pod-0', state: 'done', rc: 1 },
      { id: 'pod-1', state: 'done', rc: 1 },
      { id: 'pod-2', state: 'done', rc: 0 },
    ],
    ...(verdict ? { verdict } : {}),
  });

  test('without a verdict, rc≠0 shards are «판정 전», not «실패 보고» (0.2.21 cut alarmed 24/24 on pre-existing failures)', () => {
    const line = shardsLine(summarizeShards(done(), NOW));
    expect(line).toContain('rc≠0 2 · 기존 실패 포함 · 판정 전');
    expect(line).not.toContain('실패 보고');
  });

  test('with a verdict, only introduced failures are shown; pre-existing ones are not', () => {
    const clean = shardsLine(summarizeShards(done({ introduced: 0, preexisting: 2 }), NOW));
    expect(clean).not.toContain('rc≠0');
    expect(clean).not.toContain('새 실패');
    expect(clean).toBe('조각 3 · 끝 3 · 남은 약 0분');
    expect(shardsLine(summarizeShards(done({ introduced: 1, preexisting: 1 }), NOW))).toContain('끝 3(새 실패 1)');
  });

  test('readGateShards keeps a numeric verdict, drops a broken one without dropping the file, and still reads old files', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-verdict-'));
    try {
      const path = join(root, 'shards.json');
      writeGateShards(path, done({ introduced: 1, preexisting: 3 }));
      expect(readGateShards(path)?.verdict).toEqual({ introduced: 1, preexisting: 3 });
      writeFileSync(path, JSON.stringify({ ...done(), verdict: { introduced: 'x', preexisting: 2 } }));
      const broken = readGateShards(path);
      expect(broken?.shards).toHaveLength(3);
      expect(broken && 'verdict' in broken).toBe(false);
      writeFileSync(path, JSON.stringify(done()));
      expect(summarizeShards(readGateShards(path)!, NOW).verdict).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test('GATE-LIVE-OBS-RC-WORDING ⓒ: recordGateShardsVerdict writes the verdict into an existing board only', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-verdict-write-'));
  try {
    const path = join(root, 'shards.json');
    expect(recordGateShardsVerdict(path, { introduced: 1, preexisting: 2 })).toBe(false);
    expect(readdirSync(root)).toEqual([]);
    writeGateShards(path, { v: 1, version: '0.2.23', updatedAt: ago(5), shards: [{ id: 'pod-0', state: 'done', rc: 1 }, { id: 'pod-1', state: 'done', rc: 1 }] });
    expect(shardsLine(summarizeShards(readGateShards(path)!, NOW))).toContain('판정 전');
    expect(recordGateShardsVerdict(path, { introduced: 0, preexisting: 2 }, new Date(NOW))).toBe(true);
    const after = readGateShards(path)!;
    expect(after.verdict).toEqual({ introduced: 0, preexisting: 2 });
    expect(after.shards).toHaveLength(2);
    expect(after.updatedAt).toBe(new Date(NOW).toISOString());
    expect(shardsLine(summarizeShards(after, NOW))).toBe('조각 2 · 끝 2 · 남은 약 0분');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
