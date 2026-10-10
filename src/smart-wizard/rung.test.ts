import { expect, test } from 'bun:test';
import { classifyRung, type GraphValueSignal, type RungConditions, type WizardRung } from './rung.js';

const base: RungConditions = {
  capabilityGaps: 0, graphSignals: [], recurring: false, needsMemory: false,
  unattended: false, roles: 1, differentCadences: false, differentPermissions: false, handoffs: 0,
};
const decide = (overrides: Partial<RungConditions> = {}) => classifyRung({ ...base, ...overrides });
const signals: GraphValueSignal[] = ['verification', 'rework'];

test('boundaries: gaps 0/1, distinct graph signals 1/2, cadence without memory or autonomy', () => {
  expect(decide().rung).toBe('a');
  expect(decide({ capabilityGaps: 1 }).rung).toBe('b');
  expect(decide({ graphSignals: ['verification'] }).rung).toBe('a');
  expect(decide({ graphSignals: ['verification', 'verification'] }).rung).toBe('a');
  expect(decide({ graphSignals: signals }).rung).toBe('c');
  expect(decide({ recurring: true }).rung).toBe('a');
  expect(decide({ needsMemory: true, unattended: true }).rung).toBe('a');
  expect(decide({ recurring: true, needsMemory: true }).rung).toBe('d');
  expect(decide({ recurring: true, unattended: true }).rung).toBe('d');
});

test('boundaries: collective requires two roles, differentiated cadence or permission, and a handoff', () => {
  const collective: Partial<RungConditions> = { roles: 2, differentCadences: true, handoffs: 1 };
  expect(decide(collective).rung).toBe('e');
  expect(decide({ ...collective, roles: 1 }).rung).toBe('a');
  expect(decide({ ...collective, handoffs: 0 }).rung).toBe('a');
  expect(decide({ ...collective, differentCadences: false }).rung).toBe('a');
  expect(decide({ ...collective, differentCadences: false, differentPermissions: true }).rung).toBe('e');
});

test('selection only rises, reasons cite triggered signals and rejectedHigher explains only higher rungs', () => {
  const selected = decide({ capabilityGaps: 2, graphSignals: ['rework', 'verification'], recurring: true, unattended: true });
  expect(selected.rung).toBe('d');
  expect(selected.reasons).toEqual([
    'b: capability gaps 2 > 0',
    'c: 2 graph value signals >= 2 (verification, rework)',
    'd: recurring and unattended',
  ]);
  expect(selected.rejectedHigher).toEqual([expect.stringContaining('handoffs 0 < 1')]);
  expect(decide().rejectedHigher.map(reason => reason[0])).toEqual(['b', 'c', 'd', 'e']);
  expect(decide({ roles: 2, differentPermissions: true, handoffs: 1 }).rejectedHigher).toEqual([]);
  expect(decide({ graphSignals: signals, roles: 2, differentCadences: true, handoffs: 1 }).rung).toBe('e');
});

test('same conditions always yield the same decision regardless of signal order or duplicate signals', () => {
  const first = decide({ graphSignals: ['rework', 'verification', 'rework'], capabilityGaps: 1 });
  expect(first).toEqual(decide({ graphSignals: ['verification', 'rework'], capabilityGaps: 1 }));
  expect(decide({ graphSignals: ['verification', 'rework'], capabilityGaps: 1 })).toEqual(first);
});

test('invalid counts and unknown graph signals are rejected instead of silently changing the rung', () => {
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => decide({ capabilityGaps: value })).toThrow(RangeError);
    expect(() => decide({ roles: value })).toThrow(RangeError);
    expect(() => decide({ handoffs: value })).toThrow(RangeError);
  }
  expect(() => decide({ graphSignals: ['unknown' as GraphValueSignal] })).toThrow(TypeError);
});

// Each request is accompanied by established conditions; natural-language extraction is not part of this deterministic selector.
const samples: { request: string; expected: WizardRung; conditions: Partial<RungConditions> }[] = [
  { request: '이 텍스트 요약해 줘', expected: 'a', conditions: {} },
  { request: '영문 문장 번역해 줘', expected: 'a', conditions: {} },
  { request: '이 사진 설명해 줘', expected: 'a', conditions: {} },
  { request: '표 한 번 정리해 줘', expected: 'a', conditions: {} },
  { request: '이메일 초안 써 줘', expected: 'a', conditions: {} },
  { request: '한 장짜리 슬라이드 만들어 줘', expected: 'a', conditions: {} },
  { request: '단어 뜻 찾아 줘', expected: 'a', conditions: {} },
  { request: '기사 세 줄로 줄여 줘', expected: 'a', conditions: {} },
  { request: '메모 맞춤법 봐 줘', expected: 'a', conditions: {} },
  { request: '이 데이터 CSV 로 바꿔 줘', expected: 'a', conditions: {} },
  { request: '계산 결과 알려 줘', expected: 'a', conditions: {} },
  { request: '기존 스킬로 자료 찾아 줘', expected: 'a', conditions: {} },
  { request: '새 PDF 커넥터를 붙이고 한 번 읽어 줘', expected: 'b', conditions: { capabilityGaps: 1 } },
  { request: '번역 플러그인을 들여서 한 번 번역해 줘', expected: 'b', conditions: { capabilityGaps: 2 } },
  { request: '없는 MCP 스킬을 만든 뒤 파일 한 번 읽어 줘', expected: 'b', conditions: { capabilityGaps: 1 } },
  { request: '지식 팩을 추가하고 한 번 답해 줘', expected: 'b', conditions: { capabilityGaps: 1 } },
  { request: '새 CRM 연동을 설치하고 한 번 조회해 줘', expected: 'b', conditions: { capabilityGaps: 1 } },
  { request: '새 영상 도구를 설치해 3분 영상 만들어 줘', expected: 'b', conditions: { capabilityGaps: 1, graphSignals: ['approval'] } },
  { request: '초안 검증 후 틀리면 고쳐서 다시 내 줘', expected: 'c', conditions: { graphSignals: ['verification', 'rework'] } },
  { request: '출처 확인하고 승인받아 게시해 줘', expected: 'c', conditions: { graphSignals: ['verification', 'approval'] } },
  { request: '병렬 수집 후 합치고 결과에 따라 갈라 줘', expected: 'c', conditions: { graphSignals: ['parallel', 'branching'] } },
  { request: '중간에 멈춰도 이어서 검증해 줘', expected: 'c', conditions: { graphSignals: ['resume', 'verification'] } },
  { request: '매주 다음 단원 자료를 진도에 맞춰 준비해 줘', expected: 'd', conditions: { recurring: true, needsMemory: true, graphSignals: signals } },
  { request: '매일 자동으로 뉴스 조사해서 보내 줘', expected: 'd', conditions: { recurring: true, unattended: true } },
  { request: '사진 올라올 때마다 승인용 피드 만들어 줘', expected: 'd', conditions: { recurring: true, unattended: true, graphSignals: ['approval', 'branching'] } },
  { request: '매주 성과를 보고 다음 주 계획에 반영해 줘', expected: 'd', conditions: { recurring: true, needsMemory: true } },
  { request: '고객 문의 분류를 주간 리포트에 넘겨 줘', expected: 'e', conditions: { roles: 2, differentCadences: true, handoffs: 1, recurring: true, unattended: true } },
  { request: '수집 담당의 결과를 별도 승인 담당에게 넘겨 줘', expected: 'e', conditions: { roles: 2, differentPermissions: true, handoffs: 1 } },
  { request: '매일 수집한 걸 주말 분석 담당에게 전달해 줘', expected: 'e', conditions: { roles: 2, differentCadences: true, handoffs: 1, capabilityGaps: 1 } },
  { request: '모니터링·작성·승인 역할을 나누고 산출을 전달해 줘', expected: 'e', conditions: { roles: 3, differentPermissions: true, handoffs: 2, graphSignals: signals } },
];

test('30 sample requests: report each selected rung and its explanation', () => {
  expect(samples).toHaveLength(30);
  for (const [index, sample] of samples.entries()) {
    const result = decide(sample.conditions);
    expect(result.rung).toBe(sample.expected);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.rejectedHigher).toHaveLength(4 - 'abcde'.indexOf(result.rung));
    expect(result.rejectedHigher.every(reason => reason.includes(': '))).toBe(true);
    console.log(`${String(index + 1).padStart(2, '0')} | ${sample.request} | ${result.rung} | ${result.reasons.join('; ')} | rejected: ${result.rejectedHigher.join('; ') || 'none'}`);
  }
  const low = samples.filter(sample => decide(sample.conditions).rung === 'a' || decide(sample.conditions).rung === 'b').length;
  expect(low).toBe(18);
  console.log(`LOW-RUNG: ${low}/30 (${(100 * low / samples.length).toFixed(1)}%)`);
});
