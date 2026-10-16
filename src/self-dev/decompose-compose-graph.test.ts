import { describe, expect, test } from 'bun:test';
import { analyzeComposeConcurrency, composeConcurrencyVerdict, composeGraphFromPieces, COMPOSE_DONE, COMPOSE_START } from './decompose-compose-graph.js';
import type { DecomposePiece } from './decompose-proposal.js';

const piece = (id: string, hotPaths: string[], dependsOn: string[] = []): DecomposePiece =>
  ({ id, feature: id.toUpperCase(), dependsOn, hotPaths }) as DecomposePiece;

describe('RFC §5 5단계 — compose 부모 그래프', () => {
  test('진입점이 «여럿»인 조각들을 합성 노드 둘로 한 진입점에 모은다', () => {
    const built = composeGraphFromPieces([piece('a', ['src/x.ts']), piece('c', ['src/y.ts'])]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.template.entryNode).toBe(COMPOSE_START);
    expect(built.template.terminalNodes).toEqual([COMPOSE_DONE]);
    expect(built.template.edges[COMPOSE_START]).toEqual(['a', 'c']);
    // ⭐ 그리고 2단계 위상 검사가 «그대로» 성립한다 — 그것이 합성 노드를 세운 이유다.
    expect(built.defects).toEqual([]);
  });

  test('같은 파일을 만져도 순서 간선이 «없다» — 겹침은 직렬하지 않는다 (2026-10-16 새 계약)', () => {
    // 옛 계약은 edges['a']===['b'] (앞선 것 먼저 강제 간선) 을 기대했다 — 겹침 간선 제거(대표 10-11 «겹침이라 미루는 현상 제거»)로 고쳤다.
    const built = composeGraphFromPieces([piece('a', ['src/x.ts']), piece('b', ['src/x.ts'])]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.template.edges['a']).toEqual([COMPOSE_DONE]);   // 간선 없음 → 종결 노드로
    expect(built.defects).toEqual([]);
  });

  test('«hot path overlap no edge» — 같은 파일을 만지는 의존 없는 두 조각은 둘 다 COMPOSE_START 에서 바로 시작한다', () => {
    const built = composeGraphFromPieces([piece('a', ['src/x.ts']), piece('b', ['src/x.ts'])]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.template.edges[COMPOSE_START]).toEqual(['a', 'b']);   // 둘 다 바로 시작
    expect(built.template.edges['a']).toEqual([COMPOSE_DONE]);        // 서로를 잇는 간선이 없다
    expect(built.template.edges['b']).toEqual([COMPOSE_DONE]);
    expect(built.defects).toEqual([]);
  });

  test('순환이면 그래프를 «만들지 않고» 못 세웠음을 값으로 낸다', () => {
    const built = composeGraphFromPieces([piece('a', [], ['b']), piece('b', [], ['a'])]);
    expect(built).toEqual({ ok: false, reason: 'cycle', cycle: ['a', 'b'] });
  });

  test('조각이 없으면 no-pieces 다 — 빈 그래프를 내지 않는다', () => {
    expect(composeGraphFromPieces([])).toEqual({ ok: false, reason: 'no-pieces' });
  });

  test('⭐ 두 분모가 «둘 다» 있어야 pass 다', () => {
    const report = analyzeComposeConcurrency([piece('a', ['src/x.ts']), piece('b', ['src/x.ts']), piece('c', ['src/y.ts'])]);
    expect(report).toEqual({
      overlappingPairs: 1, overlappingSerialized: 0,
      nonOverlappingPairs: 2, nonOverlappingConcurrent: 2, verdict: 'pass',
    });
  });

  test('⛔ 겹치는 쌍이 0이면 «통과가 아니라» unmeasured 다', () => {
    const report = analyzeComposeConcurrency([piece('a', ['src/x.ts']), piece('c', ['src/y.ts'])]);
    expect(report.overlappingPairs).toBe(0);
    expect(report.verdict).toBe('unmeasured');
  });

  test('⛔ 겹치지 않는 쌍이 0이면 «통과가 아니라» unmeasured 다', () => {
    const report = analyzeComposeConcurrency([piece('a', ['src/x.ts']), piece('b', ['src/x.ts'])]);
    expect(report.nonOverlappingPairs).toBe(0);
    expect(report.verdict).toBe('unmeasured');
  });

  test('⭐ 파생 그래프에서는 겹치는 쌍의 «선언 외 직렬»이 «구조적으로» 안 나온다', () => {
    // ⛔ 이것이 이 축의 진짜 불변식이다 — 겹침 간선이 사라진(2026-10-16) 그래프에서 남는 직렬은
    //    전부 «선언된 의존»에서 오므로, overlappingSerialized(선언 외 직렬)는 0 이다.
    //    0 이 아니면 새 간선 원천이 생겼다는 방어 관측이고, fail 은 파생기를 거치면 도달할 수 없는 값이다.
    const shapes: DecomposePiece[][] = [
      [piece('a', ['x']), piece('b', ['x']), piece('c', ['x'])],
      [piece('a', ['x', 'y']), piece('b', ['y']), piece('c', ['z']), piece('d', ['x'])],
      [piece('a', ['x']), piece('b', ['y'], ['a']), piece('c', ['x'], ['b'])],
      [piece('a', ['x']), piece('b', ['x'], ['a']), piece('c', ['y']), piece('d', ['y'], ['c'])],
    ];
    for (const pieces of shapes) {
      const report = analyzeComposeConcurrency(pieces);
      expect({ shape: pieces.map((p) => p.id).join(''), verdict: report.verdict }).not.toEqual(
        { shape: pieces.map((p) => p.id).join(''), verdict: 'fail' },
      );
      expect(report.overlappingSerialized).toBe(0);
    }
  });

  test('⛔ 그래도 fail 은 «죽은 가지가 아니다» — 판정식은 «선언 외 직렬»을 보고 있다', () => {
    // 겹침 간선 제거(2026-10-16) 후 파생 그래프에서 선언 외 직렬은 «구조적으로» 0 이다 —
    //   그래서 fail 은 실제 판정식 composeConcurrencyVerdict 를 호출해 확인한다:
    //   겹침 쌍이 있고 나란히 갈 쌍도 있어도, overlappingSerialized=1 이면 verdict === 'fail' 이다.
    const report = analyzeComposeConcurrency([piece('a', ['x']), piece('b', ['x']), piece('c', ['y'])]);
    expect(report.verdict).toBe('pass');
    expect(composeConcurrencyVerdict({ ...report, overlappingSerialized: 1 })).toBe('fail');
  });

});
