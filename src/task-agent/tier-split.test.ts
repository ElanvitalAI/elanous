/**
 * DEVICE-FIRST-FU-INHERITED-BOUNDARY-WORDING — 조각 hand 문면의 «물려받았다» 주장은
 * 부모 칸에서 실제로 물려받은 계약·경계 줄이 있을 때만 나간다.
 *
 * 완료 경계 실물 두 사례: 경계 있음(부모 줄이 있으면 상속 문구 ⊕ 그 줄) · 경계 없음(문구 없음).
 * 무대: in-process 단위 — 생산 함수 `composeSliceHandText` 를 그대로 부른다(소스 문자열 grep 아님).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { composeSliceHandText } from './tier-split.js';
import { handTaskWithTierSplit, type SizedSlice } from './tier-split.js';

const marker = { index: 1, total: 2, fromTier: '상', cid: 'CELL' } as const;

const deviceSlice = (extra = ''): string => [
  '대상 경로: src/ux-sim/device.ts',
  '동작: DEVICE-FIRST-STAGE mock 무대 시험 RED를 기록한다. 운영 코드 변경 0.',
  '완료 경계 코드: 장치 시험 1건이 먼저 빨개진다',
  extra,
].filter(Boolean).join('\n');

describe('composeSliceHandText — 상속 문구는 상속된 줄이 있을 때만', () => {
  test('경계 없음: device-first 조각은 표지만 받고 상속 문구는 받지 않는다', () => {
    const parent = '대상 경로: src/ux-sim/device.ts\n판정: 장치 시험으로 증명';
    const text = composeSliceHandText(deviceSlice(), parent, marker);
    expect(text).toContain('조각 1/2 — 부모 CELL(상)');
    expect(text).not.toContain('물려받았다');
  });

  test('경계 있음: 부모에 완료 경계·현재 계약 줄이 있으면 상속 문구 ⊕ 그 줄이 붙는다', () => {
    const parent = [
      '대상 경로: src/ux-sim/device.ts',
      '현재 계약: 다른 명령의 기본 동작은 그대로',
      '완료 경계 코드: 장치 시험 1건이 빨개졌다가 초록',
      '완료 경계 실물: 두 사례',
      '완료 경계 증거 명령: bun test src/ux-sim/device.test.ts',
    ].join('\n');
    const text = composeSliceHandText(deviceSlice(), parent, marker);
    expect(text).toContain('물려받았다');
    expect(text).toContain('완료 경계 증거 명령: bun test src/ux-sim/device.test.ts');
    expect(text).toContain('현재 계약: 다른 명령의 기본 동작은 그대로');
  });

  test('경계 없음: device-first 가 아닌 조각은 종전처럼 조각 골 그대로다', () => {
    const slice = '대상 경로: src/ux-sim/device.ts\n완료 경계 코드: 시험 1건';
    const text = composeSliceHandText(slice, '판정: 장치 시험으로 증명', marker);
    expect(text).toBe(slice);
  });

  test('조각이 이미 가진 라벨은 부모에서 다시 물려받지 않고 문구도 붙지 않는다', () => {
    const slice = '대상 경로: src/ux-sim/device.ts\n완료 경계 코드: 조각 자체 경계';
    const parent = '완료 경계 코드: 부모 경계';
    const text = composeSliceHandText(slice, parent, marker);
    expect(text).toBe(slice);
    expect(text).not.toContain('물려받았다');
  });

  test('표지 없는 단일 조각(total < 2)은 device-first 여도 문면 불변', () => {
    const slice = deviceSlice();
    const text = composeSliceHandText(slice, '판정: 장치 시험으로 증명', { index: 1, total: 1, fromTier: '상', cid: 'CELL' });
    expect(text).toBe(slice);
  });
});

test('tier-split 생산 경로는 누락 acceptance를 한 번 재분할하고 통합 조각을 자동 발사한다', async () => {
  const parent = [
    '대상 경로: src/release-path-shadow.ts · src/release-path-shadow.test.ts',
    '동작: RELEASE-PATH-SHADOW main↔PR head 노드별 비교',
    '수용선: RELEASE-PATH-SHADOW 결과가 모든 노드에서 main과 PR head를 비교한다',
    '완료 경계 코드: 노드별 비교 결과를 검증한다',
    '완료 경계 실물: 두 노드 fixture에서 동등·차이를 각각 잡는다',
    '완료 경계 증거 명령: bun test src/release-path-shadow.test.ts',
  ].join('\n');
  const bare = (name: string): SizedSlice => ({ goal: `대상 경로: src/${name}.ts\n동작: ${name} 조각`, files: 1, behaviours: 1, newFiles: 0, tier: '하' });
  const calls: string[] = [];
  const launched: string[] = [];
  const coverageLogs: Array<Record<string, unknown>> = [];
  const off = debug.registerSink({ name: `tier-split-acceptance-${Math.random()}`, emit: (rec) => {
    if (rec.category === 'tier-split' && rec.event === 'slice-acceptance-coverage') coverageLogs.push(rec.data as Record<string, unknown>);
  } });
  const temp = mkdtempSync(join(tmpdir(), 'tier-split-acceptance-'));
  try {
    const out = await handTaskWithTierSplit({
      text: parent, tier: '상', live: true, checklistId: 'RELEASE-PATH-SHADOW', statePath: join(temp, 'cards.json'),
      launcher: (_args, _cwd, context) => { launched.push(context?.launchUtterance ?? ''); return { runId: context!.runId }; },
      decompose: async (goal) => {
        calls.push(goal);
        return { ok: true, redecomposed: 0, slices: [bare('workflow'), bare('ux-sim')] };
      },
    });

    expect(out.kind).toBe('split');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('수용선: RELEASE-PATH-SHADOW 결과가 모든 노드에서 main과 PR head를 비교한다');
    expect(launched).toHaveLength(3);
    expect(launched[0]).toContain('부모 수용선 몫: 없음 — 누락 수용선은 자동 통합 조각이 담당한다.');
    expect(launched.at(-1)).toContain('부모 수용선 몫(자동 통합 조각):');
    expect(launched.at(-1)!.match(/부모 수용선 몫/g)).toHaveLength(1);
    expect(launched.at(-1)).toContain('수용선: RELEASE-PATH-SHADOW 결과가 모든 노드에서 main과 PR head를 비교한다');
    expect(launched.at(-1)).toContain('완료 경계 실물: 두 노드 fixture에서 동등·차이를 각각 잡는다');
    expect(launched.at(-1)!.match(/완료 경계 실물:/g)).toHaveLength(1);
    expect(launched.map((text) => text.match(/조각 \d+\/\d+/)?.[0])).toEqual(['조각 1/3', '조각 2/3', '조각 3/3']);
    expect(coverageLogs).toContainEqual(expect.objectContaining({ attempt: 1, missing: expect.arrayContaining([
      '수용선: RELEASE-PATH-SHADOW 결과가 모든 노드에서 main과 PR head를 비교한다',
    ]) }));
    expect(coverageLogs.at(-1)).toMatchObject({ attempt: 'final', coverageMode: 'exact-parent-line', missing: [], integrated: true,
      inheritedByComposition: [
        '완료 경계 코드: 노드별 비교 결과를 검증한다',
        '완료 경계 실물: 두 노드 fixture에서 동등·차이를 각각 잡는다',
        '완료 경계 증거 명령: bun test src/release-path-shadow.test.ts',
      ] });
  } finally { off(); }
});

test('tier-split 재분할이 원 부모 수용선을 조각에 싣으면 통합 조각 없이 그 결과만 발사한다', async () => {
  const acceptance = '수용선: 결과가 모든 노드에서 main과 PR head를 비교한다';
  const parent = [
    '대상 경로: src/release-path-shadow.ts · src/release-path-shadow.test.ts',
    acceptance,
    '완료 경계 코드: 노드별 비교 결과를 검증한다',
    '완료 경계 실물: 두 노드 fixture에서 동등·차이를 각각 잡는다',
    '완료 경계 증거 명령: bun test src/release-path-shadow.test.ts',
  ].join('\n');
  const temp = mkdtempSync(join(tmpdir(), 'tier-split-acceptance-recovered-'));
  const launches: string[] = [];
  let decompositions = 0;
  const out = await handTaskWithTierSplit({
    text: parent, tier: '상', live: true, statePath: join(temp, 'cards.json'),
    launcher: (_args, _cwd, context) => { launches.push(context?.launchUtterance ?? ''); return { runId: context!.runId }; },
    decompose: async () => {
      decompositions++;
      const goal = decompositions === 1
        ? '대상 경로: src/partial.ts\n동작: 일부 수용선만 다룬다'
        : `대상 경로: src/release-path-shadow.ts\n동작: 통합 비교\n부모 수용선 몫:\n- ${acceptance}`;
      return { ok: true, redecomposed: 0, slices: [{ goal, files: 1, behaviours: 1, newFiles: 0, tier: '하' }] };
    },
  });

  expect(out.kind).toBe('split');
  expect(decompositions).toBe(2);
  expect(launches).toHaveLength(1);
  expect(launches[0]).toContain(acceptance);
  expect(launches[0]).not.toContain('자동 통합 조각');
  expect(launches[0]).not.toContain('누락 수용선은 자동 통합 조각이 담당한다.');
});

test('device-first 지연 경로에도 통합 조각이 수용선을 싣고 총 조각 표지가 다시 매겨진다', async () => {
  const acceptance = '수용선: 결과가 부모 기준을 만족한다';
  const parent = [
    '대상 경로: src/device.ts · src/feature.ts', acceptance,
    '완료 경계 코드: device-first가 먼저 돈다',
    '완료 경계 실물: device 카드가 먼저 발사되고 나머지는 지연된다',
    '완료 경계 증거 명령: bun test src/device.test.ts',
  ].join('\n');
  const temp = mkdtempSync(join(tmpdir(), 'tier-split-device-acceptance-'));
  const launches: string[] = [];
  let call = 0;
  const out = await handTaskWithTierSplit({
    text: parent, tier: '상', live: true, statePath: join(temp, 'cards.json'),
    launcher: (_args, _cwd, context) => { launches.push(context?.launchUtterance ?? ''); return { runId: context!.runId }; },
    decompose: async () => {
      call++;
      return { ok: true, redecomposed: 0, slices: [
        { goal: deviceSlice(), files: 1, behaviours: 1, newFiles: 0, tier: '하', deviceFirst: 'device-test' },
        { goal: '대상 경로: src/feature.ts\n동작: 기능 조각', files: 1, behaviours: 1, newFiles: 0, tier: '중', deviceFirst: 'feature' },
      ] };
    },
  });

  expect(out.kind).toBe('split');
  if (out.kind !== 'split') return;
  expect(call).toBe(2);
  expect(out.slices).toHaveLength(3);
  expect(launches).toHaveLength(1);
  expect(out.slices.map(({ result }) => result?.card.text.match(/조각 \d+\/\d+/)?.[0]))
    .toEqual(['조각 1/3', '조각 2/3', '조각 3/3']);
  expect(out.slices[2]?.result?.card.text).toContain(acceptance);
  expect(out.slices[2]?.result?.card.text.match(/완료 경계 실물:/g)).toHaveLength(1);
});
