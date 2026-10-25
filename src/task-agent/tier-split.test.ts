/**
 * DEVICE-FIRST-FU-INHERITED-BOUNDARY-WORDING — 조각 hand 문면의 «물려받았다» 주장은
 * 부모 칸에서 실제로 물려받은 계약·경계 줄이 있을 때만 나간다.
 *
 * 완료 경계 실물 두 사례: 경계 있음(부모 줄이 있으면 상속 문구 ⊕ 그 줄) · 경계 없음(문구 없음).
 * 무대: in-process 단위 — 생산 함수 `composeSliceHandText` 를 그대로 부른다(소스 문자열 grep 아님).
 */
import { describe, expect, test } from 'bun:test';
import { composeSliceHandText } from './tier-split.js';

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
