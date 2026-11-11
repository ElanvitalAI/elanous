import type { AdaptiveGraphReplay } from '@/lib/adaptive-graph-replay';

/** Offline stand-in for MVP-A graph-design-sim frames. No market feed or order route is called. */
export const graphDesignReplayFixture: AdaptiveGraphReplay = {
  runId: 'stockcamp-1121-sim',
  simulated: true,
  frames: [
    {
      revision: 'r1', at: '2026-11-21T04:00:00Z', label: '처음 설계',
      nodes: [
        { id: 'pack', label: '전문가 노트 → 지식 팩', state: 'active', why: '현장 노트를 주장과 출처로 나눴습니다.' },
        { id: 'diagnose', label: '시장 진단', state: 'active', why: '아는 것과 모르는 것을 구분합니다.' },
        { id: 'map', label: '전 자산 조사', state: 'active', why: '자산군과 지역을 나눠 병렬로 조사합니다.' },
        { id: 'reduce', label: '근거 종합', state: 'active', why: '찬성·반대 근거를 함께 읽습니다.' },
      ],
      diff: [
        { op: 'add', nodeId: 'diagnose', why: '팩의 주장부터 검증해야 합니다.' },
        { op: 'add', nodeId: 'map', why: '비교할 자산군이 여럿입니다.' },
        { op: 'add', nodeId: 'reduce', why: '조사 결과를 결론으로 모읍니다.' },
      ],
      bloomQuestions: [
        { id: 'q-analyze', level: 4, text: '금리 경로와 자산군 반응은 어디에서 갈리는가?', sourceNodeId: 'diagnose' },
        { id: 'q-evaluate', level: 5, text: '반대 근거를 고려해도 이 전망을 유지할 만한가?', sourceNodeId: 'reduce' },
      ],
    },
    {
      revision: 'r2', at: '2026-11-21T04:04:00Z', label: '새 견해로 재진단',
      nodes: [
        { id: 'pack', label: '전문가 노트 → 지식 팩', state: 'active' },
        { id: 'diagnose', label: '시장 진단', state: 'active' },
        { id: 'map', label: '전 자산 조사', state: 'invalidated', why: '새 견해가 기존 조사 범위를 바꿨습니다.' },
        { id: 'map-r2', label: '반대 견해 재조사', state: 'active', why: '새 출처와 반대 근거를 포함합니다.' },
        { id: 'reduce', label: '근거 종합', state: 'active' },
        { id: 'counter', label: '반대 근거 확인', state: 'active', why: '충돌하는 주장에 대한 조사를 추가했습니다.' },
      ],
      diff: [
        { op: 'replace', nodeId: 'map-r2', from: 'map', to: 'map-r2', why: '새 전문가 견해가 기존 조사 범위를 무효화했습니다.' },
        { op: 'add', nodeId: 'counter', why: '기존 결론에 반대되는 근거가 생겼습니다.' },
      ],
      bloomQuestions: [
        { id: 'q-evaluate-r2', level: 5, text: '새 반대 근거는 기존 결론을 바꿀 만큼 강한가?', sourceNodeId: 'counter' },
      ],
    },
    {
      revision: 'r3', at: '2026-11-21T04:07:00Z', label: '결론 갱신',
      nodes: [
        { id: 'pack', label: '전문가 노트 → 지식 팩', state: 'active' },
        { id: 'diagnose', label: '시장 진단', state: 'active' },
        { id: 'map', label: '전 자산 조사', state: 'invalidated', why: 'r2에서 범위가 바뀌었습니다.' },
        { id: 'map-r2', label: '반대 견해 재조사', state: 'active' },
        { id: 'reduce', label: '근거 종합', state: 'superseded', why: '반대 근거가 들어오기 전 결론입니다.' },
        { id: 'counter', label: '반대 근거 확인', state: 'active' },
        { id: 'conclude', label: '조건부 결론', state: 'active', why: '살아 있는 근거만 다시 종합했습니다.' },
      ],
      diff: [
        { op: 'remove', nodeId: 'reduce', why: '기존 종합은 새 반대 근거를 반영하지 못했습니다.' },
        { op: 'add', nodeId: 'conclude', why: '갱신된 근거로 조건부 결론을 냅니다.' },
      ],
      conclusion: {
        title: '새 견해를 반영한 조건부 결론',
        summary: '반대 근거가 늘어 전망을 보수적으로 조정했습니다.',
        forecast: '기본·낙관·비관 경로를 나눠 관찰합니다.',
        recommendation: '모의 판단: 보유 · 추가 확인 전까지 변경 보류',
        evidence: '서로 다른 전문가 견해와 자산군 비교를 함께 검토했습니다.',
        counterEvidence: '새 반대 견해의 강도는 아직 확인 중입니다.',
        sources: [{ label: '시뮬레이션 자료', url: 'https://example.org/simulation' }],
      },
      bloomQuestions: [
        { id: 'q-final', level: 5, text: '어떤 추가 근거가 나오면 보유 판단을 바꿔야 하는가?', sourceNodeId: 'conclude' },
      ],
    },
  ],
};
