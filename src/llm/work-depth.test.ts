import { describe, expect, test } from 'bun:test';
import {
  classifyWorkDifficulty,
  requiredOutputFormat,
  checkDepthRequirement,
  escalateDifficulty,
  buildDepthGateLine,
  buildMiniRetroLine,
  depthGateSupplementLines,
  injectDepthGateIntoSupplement,
  type WorkDifficulty,
} from './work-depth.js';

/**
 * ELN-DEPTH-BY-DIFFICULTY-AND-RETRO (OP #143390 · 지시서 ⑨) — RED 먼저 시험.
 * 계약: 일감 시작 시 난이도 D1/D2/D3 결정적 1차 판정 → 산출 형식 강제
 * (D2 «원인·근거·가설» 3줄 · D3 «선택지 3 표 + 채택 + 되돌리기 + 판정식») ·
 * 실패 2회 자동 승급 · 턴 끝 관문(CX-6 과 같은 관문 코드·인터페이스)이
 * 깊이 부족을 되돌림 · 일감 끝 미니 회고 1줄.
 */

describe('난이도 판정 — 결정적 1차 (일감 시작 시)', () => {
  test('D1 일상: 알려진 꼴·명령 있음·되돌리기 쉬움', () => {
    expect(classifyWorkDifficulty({ knownPattern: true, commandProvided: true, easyRevert: true })).toBe('D1');
  });

  test('D2 복합: 원인 둘 이상 또는 처음 보는 조합', () => {
    expect(classifyWorkDifficulty({ knownPattern: false, causes: 2 })).toBe('D2');
    expect(classifyWorkDifficulty({ knownPattern: false, firstSeenCombination: true })).toBe('D2');
  });

  test('D3 구조: 같은 꼴 2회↑ · 목표 미달 지속 · 돈/보안', () => {
    expect(classifyWorkDifficulty({ knownPattern: false, repeatedShapeCount: 2 })).toBe('D3');
    expect(classifyWorkDifficulty({ knownPattern: false, goalMissStreak: 2 })).toBe('D3');
    expect(classifyWorkDifficulty({ knownPattern: true, securityOrMoney: true })).toBe('D3');
  });

  test('신호 없음은 D1 기본값이 아니라 D2 보수 판정 — 깊이 부족 방지', () => {
    expect(classifyWorkDifficulty({})).toBe('D2');
  });
});

describe('산출 형식 강제 — 난이도별 필수 줄', () => {
  test('D1 = 형식 없음(바로 실행) · D2 = 원인·근거·가설 · D3 = 선택지 3 표·채택·되돌리기·판정식', () => {
    expect(requiredOutputFormat('D1').requiredMarkers).toEqual([]);
    expect(requiredOutputFormat('D2').requiredMarkers).toEqual(['원인', '근거', '가설']);
    expect(requiredOutputFormat('D3').requiredMarkers).toEqual(['선택지', '채택', '되돌리기', '판정식']);
  });

  test('형식 검사 — D2 최종 답이 원인·근거·가설을 갖추면 통과, 빠지면 missing 목록', () => {
    const ok = checkDepthRequirement('D2', '원인: A\n근거: path:12\n가설: B');
    expect(ok.ok).toBe(true);
    expect(ok.missing).toEqual([]);
    const miss = checkDepthRequirement('D2', '그냥 결과 보고입니다.');
    expect(miss.ok).toBe(false);
    expect(miss.missing).toEqual(['원인', '근거', '가설']);
  });

  test('형식 검사 — D3 선택지 3 표(3줄) · 채택 · 되돌리기 · 판정식', () => {
    const d3ok = checkDepthRequirement('D3', '선택지 1 …\n선택지 2 …\n선택지 3 …\n채택: 2번\n되돌리기: 새 가지\n판정식: X');
    expect(d3ok.ok).toBe(true);
    const d3miss = checkDepthRequirement('D3', '선택지 1 …\n선택지 2 …\n채택: 1번');
    expect(d3miss.ok).toBe(false);
    expect(d3miss.missing).toContain('선택지');
    expect(d3miss.missing).toContain('되돌리기');
    expect(d3miss.missing).toContain('판정식');
  });
});

describe('실패 2회 자동 승급', () => {
  test('D1 실패 2회 → D2 · D2 가설 전멸 → D3 · 1회는 유지', () => {
    expect(escalateDifficulty('D1', { failureCount: 1 })).toBe('D1');
    expect(escalateDifficulty('D1', { failureCount: 2 })).toBe('D2');
    expect(escalateDifficulty('D2', { hypothesesAllWrong: true })).toBe('D3');
    expect(escalateDifficulty('D2', { failureCount: 1 })).toBe('D2');
    expect(escalateDifficulty('D3', { failureCount: 9 })).toBe('D3');
  });
});

describe('턴 끝 관문 — CX-6 과 같은 supplement 줄 인터페이스', () => {
  test('깊이 부족이면 관문 줄이 붙고 ok면 null', () => {
    const line = buildDepthGateLine('D2', { ok: false, missing: ['원인', '근거', '가설'] });
    expect(line).toContain('D2');
    expect(line).toContain('원인');
    expect(buildDepthGateLine('D2', { ok: true, missing: [] })).toBeNull();
    expect(buildDepthGateLine('D1', { ok: true, missing: [] })).toBeNull();
  });

  test('supplement 줄 조립 — 깊이 관문 줄이 루프 마감 줄 앞에 온다', () => {
    const lines = depthGateSupplementLines('D3', '결과만 적은 답변', ['루프 마감 상태: 정리가 맞습니다.']);
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('D3');
    expect(lines[1]).toContain('루프 마감 상태');
    const passLines = depthGateSupplementLines('D1', '실행 결과', ['루프 마감 상태: 정리가 맞습니다.']);
    expect(passLines).toEqual(['루프 마감 상태: 정리가 맞습니다.']);
  });
});

describe('일감 끝 미니 회고 1줄 → 자리 기억 후보', () => {
  test('무엇을 했나·예상과 달랐던 것·다음에 다르게 할 것 1줄', () => {
    const line = buildMiniRetroLine({ did: '승인 원장행 수리', unexpected: 'flush 지연', next: 'settle 대기 추가' });
    expect(line).toContain('미니 회고');
    expect(line).toContain('승인 원장행 수리');
    expect(line).toContain('flush 지연');
    expect(line).toContain('settle 대기 추가');
    const parts = line.split('\n');
    expect(parts.length).toBe(1); // 1줄 계약
  });
});

describe('턴 끝 관문 배선 — supplement 주입(inject)', () => {
  test('깊이 부족이면 루프 마감 줄 «앞»에 관문 줄이 들어가고 · ok면 supplement 그대로', () => {
    const supplement = '변경 파일: /tmp/a.ts\n루프 마감 상태: 정리가 맞습니다.';
    const gated = injectDepthGateIntoSupplement('D2', '결과만 적은 답변', supplement);
    expect(gated).toContain('난이도 관문');
    expect(gated!.indexOf('난이도 관문')).toBeLessThan(gated!.indexOf('루프 마감 상태'));
    expect(injectDepthGateIntoSupplement('D2', '원인: A\n근거: b\n가설: C', supplement)).toBe(supplement);
    expect(injectDepthGateIntoSupplement('D1', '실행 결과', supplement)).toBe(supplement);
  });

  test('supplement 없어도 관문 줄을 단독 생성 — 관문은 되돌림을 놓치지 않는다', () => {
    const solo = injectDepthGateIntoSupplement('D2', '답만 있음', null);
    expect(solo).toContain('난이도 관문');
    expect(injectDepthGateIntoSupplement('D1', '답만 있음', null)).toBeNull();
  });
});

describe('시뮬 판정식 — 같은 엔진 D1/D2/D3 일감', () => {
  test('D1은 실행형 통과 · D2는 형식 강제 · D3은 3표 강제 · 깊이 부족은 관문 되돌림', () => {
    const d1 = classifyWorkDifficulty({ knownPattern: true, commandProvided: true, easyRevert: true });
    const d2 = classifyWorkDifficulty({ knownPattern: false, causes: 2 });
    const d3 = classifyWorkDifficulty({ knownPattern: false, repeatedShapeCount: 2 });
    expect(d1).toBe('D1' as WorkDifficulty);
    expect(d2).toBe('D2' as WorkDifficulty);
    expect(d3).toBe('D3' as WorkDifficulty);
    // 깊이 부족 답변은 관문이 되돌림 — supplement 줄이 비지 않는다.
    expect(depthGateSupplementLines(d2, '답만 있음', [])).not.toEqual([]);
    expect(depthGateSupplementLines(d3, '답만 있음', [])).not.toEqual([]);
    // D1 실행형은 관문이 조용하다.
    expect(depthGateSupplementLines(d1, '실행 완료', [])).toEqual([]);
  });
});
