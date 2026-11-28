import { describe, expect, test } from 'bun:test';
import { classifyBoardRequirements, createRequirementJudgeHandler, decomposeDoneCriterion } from '../kit/requirement-judge/index.js';

const input = { cellId: 'A', requirements: [{ id: 'r1', text: '보호한다' }, { id: 'r2', text: '편의 기능' }], evidence: [{ id: 'e1', text: 'r1 시나리오 통과' }] };
const rows = [
  { id: 'r1', classification: 'must' as const, fulfilled: true, evidenceIds: ['e1'], reason: '증거 e1' },
  { id: 'r2', classification: 'edge' as const, fulfilled: false, evidenceIds: [], reason: '근거 없음' },
];
const call = (data: unknown) => async () => JSON.stringify(data);

describe('natural-language criterion decomposition', () => {
  const criterion = '핵심 경로 동작. 독립적인 편의 기능은 추후 개선.';
  const segments = [
    { text: '핵심 경로 동작. ', classification: 'must' as const },
    { text: '독립적인 편의 기능은 추후 개선.', classification: 'edge' as const },
  ];
  const responses = (...values: unknown[]) => async () => JSON.stringify(values.shift());
  test('preserves all source text and classifications after independent review', async () => {
    const result = await decomposeDoneCriterion('A', criterion, { callLLM: responses({ segments }, { approved: true, reason: '독립적인 후속 개선' }) });
    expect(result).toEqual({ trusted: true, requirements: segments.map((s, i) => ({ id: `criterion-${i + 1}`, ...s })) });
    if (result.trusted) {
      const evidence = [{ id: 'e1', text: '핵심 경로 검증됨' }];
      const judgments = result.requirements.map((r, i) => ({ id: r.id, classification: r.classification, fulfilled: i === 0, evidenceIds: i === 0 ? ['e1'] : [], reason: i === 0 ? '통과' : '잔여' }));
      expect(await classifyBoardRequirements({ cellId: 'A', requirements: result.requirements, evidence }, { callLLM: call({ requirements: judgments }) })).toMatchObject({ trusted: true, requirements: judgments });
    }
  });
  test('fails closed on omitted, reordered, altered, duplicate or all-edge text', async () => {
    for (const bad of [segments.slice(0, 1), [...segments].reverse(), [{ ...segments[0], text: '핵심 경로 동작.' }, segments[1]], [...segments, segments[1]], segments.map(s => ({ ...s, classification: 'edge' }))]) {
      expect((await decomposeDoneCriterion('A', criterion, { callLLM: responses({ segments: bad }) })).trusted).toBe(false);
    }
  });
  test('fails closed when review rejects, is malformed, or unavailable', async () => {
    for (const review of [{ approved: false, reason: '필수 조건임' }, { approved: true, reason: '' }, { approved: 'true', reason: '잘못된 형식' }]) {
      expect((await decomposeDoneCriterion('A', criterion, { callLLM: responses({ segments }, review) })).trusted).toBe(false);
    }
    let n = 0;
    expect((await decomposeDoneCriterion('A', criterion, { callLLM: async () => { if (n++) throw Error('offline'); return JSON.stringify({ segments }); } })).trusted).toBe(false);
  });
  test('does not let later judging reclassify a must or cite missing evidence', async () => {
    const result = await decomposeDoneCriterion('A', criterion, { callLLM: responses({ segments }, { approved: true, reason: '독립' }) });
    if (!result.trusted) throw Error('expected decomposition');
    const judgments = result.requirements.map(r => ({ id: r.id, classification: 'edge', fulfilled: true, evidenceIds: ['invented'], reason: '잘못된 근거' }));
    expect((await classifyBoardRequirements({ cellId: 'A', requirements: result.requirements, evidence: [] }, { callLLM: call({ requirements: judgments }) })).trusted).toBe(false);
  });
});

describe('board requirement judgment', () => {
  test('returns evidence-backed per-requirement decisions', async () => {
    const result = await classifyBoardRequirements(input, { callLLM: call({ requirements: rows }) });
    expect(result).toEqual({ trusted: true, policyVersion: '1', requirements: rows });
  });
  test('rejects incomplete, duplicate, unsupported, and invented evidence', async () => {
    for (const requirements of [rows.slice(0, 1), [rows[0], rows[0]], [{ ...rows[0], evidenceIds: [] }, rows[1]], [{ ...rows[0], evidenceIds: ['invented'] }, rows[1]]]) {
      expect((await classifyBoardRequirements(input, { callLLM: call({ requirements }) })).trusted).toBe(false);
    }
  });
  test('failure or invalid policy cannot produce a trusted judgment', async () => {
    expect(await classifyBoardRequirements(input, { callLLM: async () => { throw Error('offline'); } })).toMatchObject({ trusted: false, status: 'yellow', card: { to: 'JUD' } });
    expect((await classifyBoardRequirements(input, { policyPath: '/no/such/policy', callLLM: call({ requirements: rows }) })).trusted).toBe(false);
    expect((await classifyBoardRequirements(input, { callLLM: async () => 'not json' })).trusted).toBe(false);
  });
  test('handler fails closed when untrusted', async () => {
    const handler = createRequirementJudgeHandler({ callLLM: async () => 'bad' });
    const result = await handler({ input } as Parameters<typeof handler>[0]);
    expect(result.ok).toBe(false);
    expect(result.result).toMatchObject({ trusted: false, status: 'yellow' });
  });
});
