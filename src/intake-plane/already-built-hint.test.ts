// ALREADY-BUILT-HINT 판정 신호 (UX · 0.2.34 칸 · RFC-harness-full-journey-as-graph §4f) —
// 같은 기능 문면 → 근거 링크 붙은 힌트 1건 · 관련 없는 요구 0건 · 근거 없는 행 0건 ·
// 거절한 짝(요구 해시 ⊕ feature) 0건 · 상위 매칭은 kind=already|similar.
// 템플릿: test/session-p5-search-rank.test.ts

import { describe, test, expect } from 'bun:test';
import { hashContent } from '../hasher.js';
import { rankByTrigramFts } from '../session/search-index.js';
import { alreadyBuiltHints } from './already-built-hint.js';

const FEATURE = {
  devProject: 'elanous-core',
  feature: 'session-search-rank',
  text: '세션 검색 관련도 랭킹을 trigram BM25 로 매긴다',
  evidence: { commit: 'f345b450b4', file: 'src/session/search-index.ts' },
};

describe('alreadyBuiltHints — «이미 있는 기능» 힌트(UX 0.2.34)', () => {
  test('같은 기능 문면 → 근거 링크 붙은 힌트 1건', () => {
    const hints = alreadyBuiltHints('trigram BM25 로 매긴다', [FEATURE], []);
    expect(hints).toHaveLength(1);
    expect(hints[0].kind).toBe('already');
    expect(hints[0].devProject).toBe(FEATURE.devProject);
    expect(hints[0].feature).toBe(FEATURE.feature);
    expect(hints[0].evidence.commit).toBe(FEATURE.evidence.commit);
    expect(hints[0].evidence.file).toBe(FEATURE.evidence.file);
  });

  test('관련 없는 요구 → 0건', () => {
    const hints = alreadyBuiltHints('회계 장부 집계를 자동으로 정리한다', [FEATURE], []);
    expect(hints).toHaveLength(0);
  });

  test('근거 없는 행 → 0건(근거 없으면 침묵)', () => {
    const hints = alreadyBuiltHints('trigram BM25 로 매긴다', [{ ...FEATURE, evidence: {} }], []);
    expect(hints).toHaveLength(0);
  });

  test('거절한 짝(요구 해시 ⊕ feature) → 0건', () => {
    const request = 'trigram BM25 로 매긴다';
    const hints = alreadyBuiltHints(
      request,
      [FEATURE],
      [{ requestHash: hashContent(request), feature: FEATURE.feature }],
    );
    expect(hints).toHaveLength(0);
  });

  test('매칭 후보가 3건을 넘으면 BM25 상위 3건만 힌트로 낸다', () => {
    const request = 'trigram BM25';
    const features = Array.from({ length: 5 }, (_, i) => ({
      devProject: `project-${i}`,
      feature: `rank-${i}`,
      text: `${request} ${'trigram BM25 '.repeat(i)}`,
      evidence: { file: `src/rank-${i}.ts` },
    }));
    const ranked = rankByTrigramFts(request, features.map((f, i) => ({ sessionId: String(i), content: f.text })))!;
    expect(ranked).toHaveLength(5);

    const hints = alreadyBuiltHints(request, features, []);
    expect(hints).toHaveLength(3);
    expect(hints.map((h) => h.feature)).toEqual(ranked.slice(0, 3).map((r) => features[Number(r.sessionId)].feature));
    expect(hints.map((h) => h.kind)).toEqual(['already', 'similar', 'similar']);
    expect(hints.map((h) => h.score)).toEqual(ranked.slice(0, 3).map((r) => r.score));
  });

  test('구분자가 들어간 프로젝트·기능의 충돌 키도 각각 자기 근거를 보존한다', () => {
    const hints = alreadyBuiltHints('trigram BM25', [
      { devProject: 'a::b', feature: 'c', text: 'trigram BM25 기능', evidence: { file: 'src/first.ts' } },
      { devProject: 'a', feature: 'b::c', text: 'trigram BM25 기능', evidence: { commit: 'second-commit' } },
    ], []);

    expect(hints).toHaveLength(2);
    expect(hints.map(({ devProject, feature, evidence }) => ({ devProject, feature, evidence })))
      .toEqual(expect.arrayContaining([
        { devProject: 'a::b', feature: 'c', evidence: { file: 'src/first.ts' } },
        { devProject: 'a', feature: 'b::c', evidence: { commit: 'second-commit' } },
      ]));
    expect(hints.map((h) => h.kind)).toEqual(['already', 'similar']);
  });

  test('상위 매칭 여러 건 → 첫 행 already · 뒤 행 similar(둘 다 근거 링크)', () => {
    const hints = alreadyBuiltHints('trigram BM25 로 매긴다', [
      FEATURE,
      {
        devProject: 'pwa',
        feature: 'session-search-rank-ui',
        text: 'trigram BM25 로 매긴다 · PWA 검색창 배선',
        evidence: { file: 'apps/pwa/src/search.ts' },
      },
    ], []);
    expect(hints).toHaveLength(2);
    // 1위는 already · 그 뒤는 similar — 순위 자체는 BM25 원시함수가 정한다.
    expect(hints[0].kind).toBe('already');
    expect(hints[1].kind).toBe('similar');
    expect(hints[0].score).toBeLessThanOrEqual(hints[1].score);
    // 각 행의 근거 링크는 그 행 그대로 보존된다.
    const byFeature = new Map(hints.map((h) => [h.feature, h.evidence.file] as const));
    expect(byFeature.get(FEATURE.feature)).toBe('src/session/search-index.ts');
    expect(byFeature.get('session-search-rank-ui')).toBe('apps/pwa/src/search.ts');
  });
});
