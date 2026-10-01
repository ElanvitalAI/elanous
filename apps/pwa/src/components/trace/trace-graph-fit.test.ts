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

describe('포커스 줌 — 선택한 노드로 부드럽게', () => {
  test('focusTransform 은 그 노드를 화면 가운데에 놓는다', async () => {
    const { focusTransform } = await import('./TraceGraph');
    const t = focusTransform({ x: 100, y: 50 }, 800, 600, 2);
    expect(100 * t.k + t.x).toBe(400);
    expect(50 * t.k + t.y).toBe(300);
  });
  test('lerpTransform 은 양 끝이 같고 배율은 기하로 옮긴다', async () => {
    const { lerpTransform, focusTransform } = await import('./TraceGraph');
    const a = focusTransform({ x: 0, y: 0 }, 800, 600, 1);
    const b = focusTransform({ x: 200, y: 100 }, 800, 600, 4);
    const at0 = lerpTransform(a, b, 0, 800, 600); const at1 = lerpTransform(a, b, 1, 800, 600);
    expect(at0).toEqual(a);
    expect(at1.k).toBeCloseTo(4); expect(at1.x).toBeCloseTo(b.x); expect(at1.y).toBeCloseTo(b.y);
    expect(lerpTransform(a, b, 0.5, 800, 600).k).toBeCloseTo(2);
  });
  test('easeInOutCubic 은 0·½·1 을 지난다 · focusScale 은 1.2~3.5', async () => {
    const { easeInOutCubic, focusScale } = await import('./TraceGraph');
    expect(easeInOutCubic(0)).toBe(0); expect(easeInOutCubic(0.5)).toBe(0.5); expect(easeInOutCubic(1)).toBe(1);
    expect(focusScale(0.2)).toBe(1.2); expect(focusScale(1)).toBe(2.4); expect(focusScale(3)).toBe(3.5);
  });
});
