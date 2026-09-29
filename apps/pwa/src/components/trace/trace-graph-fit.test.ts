import { describe, expect, test } from 'bun:test';
import { fitTransform, graphSignature } from './TraceGraph';

describe('fitTransform — 노드 전부가 첫 화면에 들어온다', () => {
  const apply = (t: { x: number; y: number; k: number }, p: { x: number; y: number }) => ({ x: p.x * t.k + t.x, y: p.y * t.k + t.y });
  test('화면 밖까지 퍼진 배치를 줄여 넣는다', () => {
    const nodes = [{ x: -800, y: -500, r: 10 }, { x: 1900, y: 1300, r: 10 }];
    const t = fitTransform(nodes, 900, 560);
    expect(t.k).toBeLessThan(1);
    for (const n of nodes) {
      const a = apply(t, { x: n.x - n.r, y: n.y - n.r }); const b = apply(t, { x: n.x + n.r + 90, y: n.y + n.r });
      expect(a.x).toBeGreaterThanOrEqual(0); expect(a.y).toBeGreaterThanOrEqual(0);
      expect(b.x).toBeLessThanOrEqual(900); expect(b.y).toBeLessThanOrEqual(560);
    }
  });
  test('작은 배치를 너무 키우지 않는다(최대 1.5) · 빈 목록은 그대로', () => {
    expect(fitTransform([{ x: 0, y: 0, r: 5 }], 900, 560).k).toBe(1.5);
    expect(fitTransform([], 900, 560)).toEqual({ x: 0, y: 0, k: 1 });
  });
});

describe('graphSignature — 같은 구조면 다시 배치하지 않는다', () => {
  const n = (id: string, status?: 'running' | 'landed') => ({ id, kind: 'run' as const, label: id, weight: 3, ...(status ? { status } : {}) });
  test('배열이 새것이어도 내용이 같으면 같은 서명', () => {
    expect(graphSignature([n('a'), n('b')], [{ source: 'a', target: 'b', kind: 'parent' }]))
      .toBe(graphSignature([n('a'), n('b')], [{ source: 'a', target: 'b', kind: 'parent' }]));
  });
  test('노드·상태·간선이 바뀌면 다른 서명', () => {
    const base = graphSignature([n('a')], []);
    expect(graphSignature([n('a'), n('b')], [])).not.toBe(base);
    expect(graphSignature([n('a', 'landed')], [])).not.toBe(base);
    expect(graphSignature([n('a')], [{ source: 'a', target: 'a2', kind: 'contains' }])).not.toBe(base);
  });
});
