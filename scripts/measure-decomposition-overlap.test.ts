import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { overlapOf, proseFallbackWarning } from './measure-decomposition-overlap.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

describe('measure-decomposition-overlap · overlapOf', () => {
  test('두 조각이 같은 파일을 겨냥하면 그 파일과 «조각 이름»을 낸다', () => {
    // 2026-09-06 안드로이드 골(89b764c0…)의 실물 모양 — 이 겹침이 런을 죽였다.
    const r = overlapOf({ pieces: [
      { id: 'implement-prompt-transport', feature: 'apps/android/.../data/NexusClient.kt 에 스트림 전송을 넣는다' },
      { id: 'wire-backend-selection', feature: 'data/NexusClient.kt 의 라우팅을 설정에 잇는다' },
      { id: 'define-stream-models', feature: 'data/ChatModels.kt 에 모델을 정의한다' },
    ] });
    expect(r.shared).toHaveLength(1);
    // 대표는 «가장 긴» 표기다 — 사람이 읽을 때 어느 NexusClient.kt 인지 알 수 있어야 한다.
    expect(r.shared[0]!.file).toBe('apps/android/.../data/NexusClient.kt');
    expect(r.shared[0]!.pieces).toEqual(['implement-prompt-transport', 'wire-backend-selection']);
  });

  test('겹치지 않으면 «조용하다» — 자가 전부 양성을 내지 않는다', () => {
    const r = overlapOf({ pieces: [
      { id: 'a', feature: 'src/one.ts 를 고친다' },
      { id: 'b', feature: 'src/two.ts 를 고친다' },
    ] });
    expect(r.shared).toEqual([]);
    expect(r.fileCount).toBe(2);
  });

  test('한 조각이 같은 파일을 여러 번 말해도 «겹침»이 아니다', () => {
    const r = overlapOf({ pieces: [
      { id: 'a', feature: 'src/one.ts 를 읽고 src/one.ts 를 고친다' },
      { id: 'b', feature: 'src/two.ts' },
    ] });
    expect(r.shared).toEqual([]);
  });

  test('경로가 없는 조각은 파일 수에 기여하지 않는다 — «0» 은 「겹침 없음」이 아니다', () => {
    const r = overlapOf({ pieces: [
      { id: 'a', feature: '리팩터링한다' },
      { id: 'b', feature: '정리한다' },
    ] });
    expect(r.fileCount).toBe(0);
    expect(r.shared).toEqual([]);
  });

  test('경로가 셋 이상 조각에 걸리면 그 수만큼 낸다', () => {
    const r = overlapOf({ pieces: [
      { id: 'a', feature: 'scripts/botlab/heartbeat-stale-drill.ts' },
      { id: 'b', feature: 'scripts/botlab/heartbeat-stale-drill.ts' },
      { id: 'c', feature: 'scripts/botlab/heartbeat-stale-drill.ts' },
    ] });
    expect(r.shared[0]!.pieces).toEqual(['a', 'b', 'c']);
  });

  test('비어 있지 않은 hotPaths만 공유해도 값을 읽어 겹침으로 낸다', () => {
    const r = overlapOf({ pieces: [
      { id: 'a', feature: '산문에는 경로가 없다', hotPaths: ['src/structured-only.ts'] },
      { id: 'b', feature: '여기도 경로가 없다', hotPaths: ['src/structured-only.ts'] },
    ] });
    expect(r.shared).toEqual([{ file: 'src/structured-only.ts', pieces: ['a', 'b'] }]);
    expect(r).toMatchObject({ hotPathPieceCount: 2, proseFallbackPieceCount: 0 });
  });

  test('hotPaths를 지우면 옛 원장처럼 산문만 읽어 구조화 경로 겹침은 사라진다', () => {
    const r = overlapOf({ pieces: [
      { id: 'a', feature: '산문에는 경로가 없다' },
      { id: 'b', feature: '여기도 경로가 없다' },
    ] });
    expect(r.shared).toEqual([]);
    expect(r).toMatchObject({ hotPathPieceCount: 0, proseFallbackPieceCount: 2 });
  });

  test('한 조각은 hotPaths, 다른 조각은 산문으로 같은 파일을 가리킬 수 있다', () => {
    const r = overlapOf({ pieces: [
      { id: 'value', feature: '다른 파일 src/ignored.ts', hotPaths: ['src/shared.ts'] },
      { id: 'prose', feature: 'src/shared.ts 를 고친다' },
    ] });
    expect(r.shared).toEqual([{ file: 'src/shared.ts', pieces: ['prose', 'value'] }]);
    expect(r.fileCount).toBe(1); // value 조각의 산문 `src/ignored.ts`는 읽지 않는다.
    expect(r).toMatchObject({ hotPathPieceCount: 1, proseFallbackPieceCount: 1 });
  });

  test('빈 hotPaths 배열은 산문 폴백으로 센다', () => {
    const r = overlapOf({ pieces: [
      { id: 'a', feature: 'src/fallback.ts', hotPaths: [] },
      { id: 'b', feature: 'src/fallback.ts', hotPaths: [] },
    ] });
    expect(r.shared).toHaveLength(1);
    expect(r).toMatchObject({ hotPathPieceCount: 0, proseFallbackPieceCount: 2 });
  });

  test('산문 폴백이 없을 때만 산문 휴리스틱 경고를 생략한다', () => {
    expect(proseFallbackWarning(0)).toBeUndefined();
    expect(proseFallbackWarning(1)).toContain('미탐');
  });
});

describe('measure-decomposition-overlap · CLI 표본별 경고', () => {
  test('구조화-only 표본과 산문 폴백 표본을 함께 출력해도 경고는 폴백 표본에만 붙인다', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'overlap-ledger-'));
    const bunPath = join(binDir, 'bun');
    const records = [
      { ts: '2026-09-07T02:00:00Z', data: JSON.stringify({ goalId: 'structured', runId: 'r1', pieces: [
        { id: 'a', feature: '경로 없음', hotPaths: ['src/value.ts'] },
        { id: 'b', feature: '경로 없음', hotPaths: ['src/value.ts'] },
      ] }) },
      { ts: '2026-09-07T01:00:00Z', data: JSON.stringify({ goalId: 'legacy', runId: 'r2', pieces: [
        { id: 'a', feature: 'src/prose.ts' },
        { id: 'b', feature: 'src/prose.ts' },
      ] }) },
    ];
    writeFileSync(bunPath, `#!/bin/sh\nprintf '%s\\n' '${records.map((record) => JSON.stringify(record)).join("' '")}'\n`);
    chmodSync(bunPath, 0o755);
    try {
      const result = Bun.spawnSync({
        cmd: [process.execPath, 'scripts/measure-decomposition-overlap.ts'],
        cwd: process.cwd(),
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = result.stdout.toString();
      expect(result.exitCode).toBe(1);
      const structured = output.slice(output.indexOf('goal=structured'), output.indexOf('goal=legacy'));
      const legacy = output.slice(output.indexOf('goal=legacy'));
      expect(structured).toContain('값=2 산문=0');
      expect(structured).not.toContain('미탐');
      expect(legacy).toContain('값=0 산문=2');
      expect(legacy).toContain('미탐');
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe('samePathCandidate 의 «양쪽»', () => {
  test('깊이가 다른 같은 파일은 묶는다 — 이 자의 맹점이었다(2026-09-06 시험이 잡았다)', () => {
    const r = overlapOf({ pieces: [
      { id: 'a', feature: 'apps/android/app/src/main/kotlin/x/data/NexusClient.kt 를 고친다' },
      { id: 'b', feature: 'data/NexusClient.kt 의 라우팅' },
    ] });
    expect(r.shared).toHaveLength(1);
    expect(r.shared[0]!.file).toContain('apps/android');
  });

  test('⛔ 이름만 같은 다른 파일은 «묶지 않는다» — index.ts 로 전부 겹침이 되면 자가 죽는다', () => {
    const r = overlapOf({ pieces: [
      { id: 'a', feature: 'src/alpha/index.ts' },
      { id: 'b', feature: 'src/beta/index.ts' },
    ] });
    expect(r.shared).toEqual([]);
    expect(r.fileCount).toBe(2);
  });
});
