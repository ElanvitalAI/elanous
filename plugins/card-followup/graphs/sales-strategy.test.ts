import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStrategy, crmRow, upsertCrm } from './sales-strategy.js';

const card = { name: 'Lee, "Jane"', company: 'Acme', email: 'jane@example.test', title: 'Director' };
const research = { sources: [
  { title: 'Acme home', url: 'https://acme.example/', snippet: 'Cloud platform' },
  { title: 'Acme products', url: 'https://acme.example/products', snippet: 'Platform offering' },
] };
const approach = { who: 'Jane', problem: 'workflow', proposal: 'demo', channel: 'email', timing: 'next week' };
const nextAction = { what: 'schedule demo', due: 'next week' };
const approachBasis = { who: ['card'], problem: ['S1'], proposal: ['offer'], channel: ['assumption'], timing: ['assumption'] };
const nextActionBasis = { what: ['assumption'], due: ['assumption'] };
const verified = { unsupportedReasons: [], unsupportedApproach: [], unsupportedAction: [] };

test('invalid S9 is discarded and one retry uses three valid reasons', async () => {
  const calls: Record<string, unknown>[] = [];
  const answer = (basis: string) => ({
    fit: { score: 87, label: 'high', reasons: [{ text: 'product fit', basis }, { text: 'company', basis: 'S2' }, { text: 'role', basis: 'card' }] },
    approach, nextAction, approachBasis, nextActionBasis,
  });
  const result = await buildStrategy({ card, research, context: 'at conference', offer: 'workflow software for cloud teams', ask: async payload => {
    calls.push(payload);
    if (payload.task === 'strategy-verify') return verified;
    return calls.filter(call => call.task === 'strategy').length === 1 ? answer('S9') : answer('S1');
  } });
  expect(calls.filter(call => call.task === 'strategy')).toHaveLength(2);
  expect((calls[0]!.evidence as unknown[])).toHaveLength(2);
  expect(result.fit).toEqual({ score: 87, label: 'high', reasons: [
    { text: 'product fit', basis: 'S1' }, { text: 'company', basis: 'S2' }, { text: 'role', basis: 'card' },
  ] });
  expect(result.approach).toEqual(approach);
  const stillBad = await buildStrategy({ card, research, offer: 'workflow software', ask: async payload => payload.task === 'strategy-verify' ? verified : answer('S9') });
  expect(stillBad.fit).toEqual({ score: null, label: 'unknown', reasons: [{ text: 'company', basis: 'S2' }, { text: 'role', basis: 'card' }] });
});

test('a real S1 number does not license a claim absent from its source or from the approach', async () => {
  const calls: Record<string, unknown>[] = [];
  const answer = (falseClaim: boolean) => ({
    fit: { score: 70, label: 'medium', reasons: [
      { text: falseClaim ? 'Acme is the world leader' : 'Acme offers a cloud platform', basis: 'S1' },
      { text: 'Director', basis: 'card' }, { text: 'workflow software', basis: 'offer' },
    ] },
    approach: { ...approach, problem: falseClaim ? 'Acme is the world leader' : 'explore workflows' }, nextAction, approachBasis, nextActionBasis,
  });
  const result = await buildStrategy({ card, research, offer: 'workflow software', ask: async payload => {
    calls.push(payload);
    if (payload.task === 'strategy') return answer(calls.filter(call => call.task === 'strategy').length === 1);
    const claims = payload.claims as { text: string; evidence?: { snippet: string } }[];
    expect(claims[0]!.evidence!.snippet).toBe('Cloud platform');
    const citedApproach = payload.approach as { field: string; evidence: { snippet: string }[]; basis: string[] }[];
    expect(citedApproach.find(claim => claim.field === 'problem')).toMatchObject({ basis: ['S1'], evidence: [{ snippet: 'Cloud platform' }] });
    expect((payload.evidence as unknown[])).toHaveLength(2);
    const bad = claims[0]!.text.includes('world leader');
    return { ...verified, unsupportedReasons: bad ? [0] : [], unsupportedApproach: bad ? ['problem'] : [] };
  } });
  expect(calls.filter(call => call.task === 'strategy')).toHaveLength(2);
  expect(result.fit.reasons).toHaveLength(3);
  expect(result.fit.reasons[0]).toEqual({ text: 'Acme offers a cloud platform', basis: 'S1' });
  expect(result.approach.problem).toBe('explore workflows');

  const uncorrected = await buildStrategy({ card, research, offer: 'workflow software', ask: async payload =>
    payload.task === 'strategy' ? answer(true) : { ...verified, unsupportedReasons: [0] } });
  expect(uncorrected.fit).toEqual({ score: null, label: 'unknown', reasons: [{ text: 'Director', basis: 'card' }, { text: 'workflow software', basis: 'offer' }] });
  await expect(buildStrategy({ card, research, offer: 'workflow software', ask: async payload =>
    payload.task === 'strategy' ? answer(true) : { ...verified, unsupportedReasons: [0], unsupportedApproach: ['problem'] } })).rejects.toThrow('근거 없는 접근 전략');
  await expect(buildStrategy({ card, research, offer: 'workflow software', ask: async payload =>
    payload.task === 'strategy' ? answer(true) : {} })).rejects.toThrow('전략 근거 검증 응답을 읽지 못했다');
});

test('assumptions and absent inputs cannot establish three grounded fit reasons', async () => {
  const calls: Record<string, unknown>[] = [];
  const answers = [
    [{ text: 'perhaps', basis: 'assumption' }, { text: 'maybe', basis: 'assumption' }, { text: 'guess', basis: 'assumption' }],
    [{ text: 'Director', basis: 'card' }, { text: 'not a meeting', basis: 'context' }, { text: 'maybe', basis: 'assumption' }],
  ];
  const result = await buildStrategy({ card, research, offer: 'workflow software', ask: async payload => {
    calls.push(payload);
    if (payload.task === 'strategy-verify') return verified;
    return { fit: { score: 99, label: 'high', reasons: answers[calls.filter(call => call.task === 'strategy').length - 1] },
      approach, nextAction, approachBasis, nextActionBasis };
  } });
  expect(calls.filter(call => call.task === 'strategy')).toHaveLength(2);
  expect(result.fit).toEqual({ score: null, label: 'unknown', reasons: [{ text: 'Director', basis: 'card' }] });
});

test('three repeated bases do not count as three independent fit reasons', async () => {
  const tasks: string[] = [];
  const result = await buildStrategy({ card, research, offer: 'workflow software', ask: async payload => {
    tasks.push(String(payload.task));
    if (payload.task === 'strategy-verify') return verified;
    return { fit: { score: 80, label: 'high', reasons: [
      { text: 'first observation', basis: 'card' }, { text: 'second observation', basis: 'card' },
      { text: 'software', basis: 'offer' },
    ] }, approach, nextAction, approachBasis, nextActionBasis };
  } });
  expect(tasks).toEqual(['strategy', 'strategy-verify', 'strategy', 'strategy-verify']);
  expect(result.fit.score).toBeNull();
  expect(result.fit.label).toBe('unknown');
});

test('without offer fit stays unknown while approach and next action are produced', async () => {
  const result = await buildStrategy({ card, research, context: 'conference', ask: async payload => {
    if (payload.task === 'strategy-verify') return verified;
    expect(payload.research).toEqual({});
    expect(payload.evidence).toEqual([]);
    return { fit: { score: 98, label: 'high', reasons: [] }, approach, nextAction,
      approachBasis: { ...approachBasis, problem: ['context'], proposal: ['assumption'] }, nextActionBasis };
  } });
  expect(result.fit).toEqual({ score: null, label: 'unknown', reasons: [{ text: 'offer 입력이 없어 맞음을 판정하지 않았다', basis: 'offer' }] });
  expect(Object.values(result.approach).every(Boolean)).toBe(true);
  expect(result.nextAction).toEqual(nextAction);
});

test('approach verifier receives a source not cited by any fit reason, with claim-specific basis', async () => {
  const result = await buildStrategy({ card, research, offer: 'workflow software', ask: async payload => {
    if (payload.task === 'strategy-verify') {
      const fitClaims = payload.claims as { basis: string }[];
      expect(fitClaims.map(claim => claim.basis)).toEqual(['S1', 'card', 'offer']);
      const sources = payload.evidence as { id: string; snippet: string }[];
      expect(sources.find(source => source.id === 'S2')?.snippet).toBe('Platform offering');
      const problem = (payload.approach as { field: string; basis: string[]; evidence: { id: string; snippet: string }[] }[]).find(claim => claim.field === 'problem');
      expect(problem).toMatchObject({ basis: ['S2'], evidence: [{ id: 'S2', snippet: 'Platform offering' }] });
      return verified;
    }
    return { fit: { score: 75, label: 'medium', reasons: [{ text: 'cloud', basis: 'S1' }, { text: 'director', basis: 'card' }, { text: 'software', basis: 'offer' }] },
      approach, approachBasis: { ...approachBasis, problem: ['S2'] }, nextAction, nextActionBasis };
  } });
  expect(result.fit.score).toBe(75);
});

test('next action customer promises and dates require evidence or an internal-plan rewrite', async () => {
  const calls: Record<string, unknown>[] = [];
  const result = await buildStrategy({ card, research, offer: 'workflow software', ask: async payload => {
    calls.push(payload);
    if (payload.task === 'strategy-verify') {
      const action = payload.nextAction as { field: string; text: string; basis: string[] }[];
      expect(action.map(item => item.field)).toEqual(['what', 'due']);
      expect(action[0]!.basis).toEqual(['assumption']);
      return action[0]!.text.includes('promised') ? { ...verified, unsupportedAction: ['what', 'due'] } : verified;
    }
    const first = calls.filter(call => call.task === 'strategy').length === 1;
    return { fit: { score: 70, label: 'medium', reasons: [{ text: 'role', basis: 'card' }, { text: 'product', basis: 'offer' }, { text: 'site', basis: 'S1' }] },
      approach, approachBasis, nextAction: first ? { what: 'Jane promised a purchase', due: 'Jane confirmed Friday' } : { what: 'propose a demo internally', due: 'target Friday' }, nextActionBasis };
  } });
  expect(calls.filter(call => call.task === 'strategy')).toHaveLength(2);
  expect(result.nextAction).toEqual({ what: 'propose a demo internally', due: 'target Friday' });
  await expect(buildStrategy({ card, research, offer: 'workflow software', ask: async payload => payload.task === 'strategy-verify'
    ? { ...verified, unsupportedAction: ['what', 'due'] }
    : { fit: { score: 70, label: 'medium', reasons: [{ text: 'role', basis: 'card' }, { text: 'product', basis: 'offer' }, { text: 'site', basis: 'S1' }] },
      approach, approachBasis, nextAction: { what: 'Jane promised a purchase', due: 'Jane confirmed Friday' }, nextActionBasis } })).rejects.toThrow('근거 없는 접근 전략/다음 행동');
});

test('a malformed strategy answer gets one retry and never skips evidence verification', async () => {
  const tasks: string[] = [];
  const result = await buildStrategy({ card, research, offer: 'workflow software', ask: async payload => {
    tasks.push(String(payload.task));
    if (payload.task === 'strategy-verify') return verified;
    if (tasks.filter(task => task === 'strategy').length === 1) return { reply: 'not JSON' };
    expect(payload.instruction).toContain('올바른 JSON 객체');
    return { fit: { score: 70, label: 'medium', reasons: [
      { text: 'cloud', basis: 'S1' }, { text: 'role', basis: 'card' }, { text: 'software', basis: 'offer' },
    ] }, approach, nextAction, approachBasis, nextActionBasis };
  } });
  expect(tasks).toEqual(['strategy', 'strategy', 'strategy-verify']);
  expect(result.fit.score).toBe(70);
  await expect(buildStrategy({ card, research, offer: 'software', ask: async () => ({ reply: 'not JSON' }) }))
    .rejects.toThrow('strategy 응답 JSON 객체 없음');
});

test('a strategy with missing fields retries once rather than returning a partial approach', async () => {
  const tasks: string[] = [];
  const answer = { fit: { score: 70, label: 'medium', reasons: [
    { text: 'cloud', basis: 'S1' }, { text: 'role', basis: 'card' }, { text: 'software', basis: 'offer' },
  ] }, approach, nextAction, approachBasis, nextActionBasis };
  const result = await buildStrategy({ card, research, offer: 'software', ask: async payload => {
    tasks.push(String(payload.task));
    if (payload.task === 'strategy-verify') return verified;
    if (tasks.filter(task => task === 'strategy').length === 1) return { ...answer, approach: { ...approach, who: '' } };
    expect(payload.instruction).toContain('필수 필드가 빠졌다');
    return answer;
  } });
  expect(tasks).toEqual(['strategy', 'strategy', 'strategy-verify']);
  expect(result.approach).toEqual(approach);
  await expect(buildStrategy({ card, research, offer: 'software', ask: async () => ({ ...answer, nextAction: { ...nextAction, due: '' } }) }))
    .rejects.toThrow('접근 전략 필수 필드 없음');
});

test('reason and approach bases must point to present inputs and nonempty research evidence', async () => {
  const emptyResearch = { sources: [{ url: 'https://acme.example/', title: '', snippet: '' }] };
  const tasks: string[] = [];
  const result = await buildStrategy({ card, research: emptyResearch, offer: 'workflow software', ask: async payload => {
    tasks.push(String(payload.task));
    if (payload.task === 'strategy-verify') return verified;
    const bad = tasks.filter(task => task === 'strategy').length === 1;
    return { fit: { score: 80, label: 'high', reasons: bad
      ? [{ text: 'nothing to cite', basis: 'S1' }, { text: 'role', basis: 'card' }, { text: 'offer', basis: 'offer' }]
      : [{ text: 'role', basis: 'card' }, { text: 'offer', basis: 'offer' }, { text: 'context absent', basis: 'context' }] },
      approach, nextAction, approachBasis: { ...approachBasis, problem: bad ? ['S1'] : ['assumption'] }, nextActionBasis };
  } });
  expect(tasks).toEqual(['strategy', 'strategy-verify', 'strategy', 'strategy-verify']);
  expect(result.fit).toEqual({ score: null, label: 'unknown', reasons: [{ text: 'role', basis: 'card' }, { text: 'offer', basis: 'offer' }] });
  await expect(buildStrategy({ card, research: emptyResearch, offer: 'software', ask: async payload => payload.task === 'strategy-verify' ? verified
    : { fit: { score: 80, label: 'high', reasons: [{ text: 'role', basis: 'card' }, { text: 'offer', basis: 'offer' }] },
      approach, nextAction, approachBasis: { ...approachBasis, problem: ['S1'] }, nextActionBasis } }))
    .rejects.toThrow('근거 없는 접근 전략/다음 행동');
});

test('CRM upserts by email or name and company, sorts null last, quotes commas, quotes and newlines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'strategy-crm-'));
  try {
    const path = join(dir, 'nested', 'crm.csv');
    const fit = (score: number | null) => ({ score, label: score === null ? 'unknown' as const : 'high' as const, reasons: [] });
    upsertCrm(path, crmRow(card, fit(30), approach, nextAction, 'met at event', '2026-10-01T00:00:00Z'));
    upsertCrm(path, crmRow({ ...card, name: 'renamed' }, fit(90), approach, nextAction, 'updated', '2026-10-02T00:00:00Z'));
    let csv = readFileSync(path, 'utf8');
    expect(csv.split('\n')).toHaveLength(3);
    expect(csv).toContain('renamed');
    expect(csv).not.toContain('Lee,');
    upsertCrm(path, crmRow({ name: 'Lee, "Jane"', company: 'Acme', email: '' }, fit(70), approach, nextAction, 'hello, "team"\nagain', 'now'));
    upsertCrm(path, crmRow({ name: 'Lee, "Jane"', company: 'Acme', email: '' }, fit(80), approach, nextAction, 'second', 'now'));
    upsertCrm(path, crmRow({ name: 'Third', company: 'Co', email: 'third@example.test' }, fit(null), approach, nextAction, '', 'now'));
    csv = readFileSync(path, 'utf8');
    expect(csv.split('\n')).toHaveLength(5);
    expect(csv).toContain('"Lee, ""Jane"""');
    expect(csv.indexOf('renamed')).toBeLessThan(csv.indexOf('"Lee, ""Jane"""'));
    expect(csv.indexOf('"Lee, ""Jane"""')).toBeLessThan(csv.indexOf('Third'));
    expect((csv.match(/Lee, ""Jane""/g) ?? [])).toHaveLength(1);
    upsertCrm(path, crmRow({ name: 'Fourth', company: 'Co', email: '' }, fit(60), approach, nextAction, 'line1\nline2, "quoted"', 'now'));
    upsertCrm(path, crmRow({ name: 'Fifth', company: 'Co', email: '' }, fit(50), approach, nextAction, '', 'now'));
    csv = readFileSync(path, 'utf8');
    expect(csv).toContain('"line1\nline2, ""quoted"""');
    upsertCrm(path, crmRow({ name: 'Fourth', company: 'Co', email: '' }, fit(60), approach, nextAction, 'line1\nline2, "quoted"', 'later'));
    csv = readFileSync(path, 'utf8');
    expect((csv.match(/Fourth/g) ?? [])).toHaveLength(1);
    expect(csv).toContain('"line1\nline2, ""quoted"""');
    upsertCrm(path, crmRow({ name: 'Fifth', company: 'Co', email: '' }, fit(55), approach, nextAction, '', 'later'));
    csv = readFileSync(path, 'utf8');
    expect(csv).toContain('"line1\nline2, ""quoted"""');
    expect((csv.match(/Fifth/g) ?? [])).toHaveLength(1);
    expect(csv.indexOf('Fourth')).toBeLessThan(csv.indexOf('Fifth'));
    expect(csv.indexOf('Fifth')).toBeLessThan(csv.indexOf('Third'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a rejected approach field gets a third try that names it, then passes', async () => {
  const calls: Record<string, unknown>[] = [];
  let verifies = 0;
  const reasons = [{ text: 'Director', basis: 'card' }, { text: 'met at event', basis: 'context' }, { text: 'needs workflow', basis: 'offer' }];
  const result = await buildStrategy({ card, research, context: 'met at event', offer: 'workflow software', ask: async payload => {
    calls.push(payload);
    if (payload.task === 'strategy-verify') return ++verifies < 3 ? { ...verified, unsupportedApproach: ['problem'] } : verified;
    return { fit: { score: 70, label: 'medium', reasons }, approach, nextAction, approachBasis, nextActionBasis };
  } });
  const tries = calls.filter(call => call.task === 'strategy');
  expect(tries).toHaveLength(3);
  expect(String(tries[2]!.instruction)).toContain('특히 problem');
  expect(result.approach.problem).toBe('workflow');
});

test('a rejected approach field on all three tries still fails closed', async () => {
  const reasons = [{ text: 'Director', basis: 'card' }, { text: 'met at event', basis: 'context' }, { text: 'needs workflow', basis: 'offer' }];
  await expect(buildStrategy({ card, research, context: 'met at event', offer: 'workflow software', ask: async payload =>
    payload.task === 'strategy-verify' ? { ...verified, unsupportedApproach: ['problem'] }
      : { fit: { score: 70, label: 'medium', reasons }, approach, nextAction, approachBasis, nextActionBasis } })).rejects.toThrow('근거 없는 접근 전략/다음 행동: problem');
});
