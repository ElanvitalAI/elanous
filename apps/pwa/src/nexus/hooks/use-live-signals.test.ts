import { describe, expect, test } from 'bun:test';
import { storeCoverage } from './use-live-signals';

describe('storeCoverage — 연합 조회가 연 저장소를 화면에 보인다', () => {
  test('네 조회의 저장소 합집합 ⊕ 못 읽은 저장소 이름 ⊕ 등록 수(있을 때만)', () => {
    const r = storeCoverage([
      { ok: true, logs: [], count: 0, stores: ['prod', 'test:a'], failedStores: [{ name: 'test:b', reason: 'no log store' }] },
      { ok: true, logs: [], count: 0, stores: ['prod', 'test:c'], registeredStores: 922 },
      undefined,
    ]);
    expect(r.stores.sort()).toEqual(['prod', 'test:a', 'test:c']);
    expect(r.failedStores).toEqual(['test:b']);
    expect(r.registeredStores).toBe(922);
  });

  test('옛 데몬(칸 없음)이면 빈 값 — 화면은 저장소 줄을 안 그린다', () => {
    expect(storeCoverage([{ ok: true, logs: [], count: 0 }])).toEqual({ stores: [], failedStores: [], registeredStores: null });
  });
});
