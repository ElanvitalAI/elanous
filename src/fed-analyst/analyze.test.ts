// FED-ANALYST-LOOP-AGENT — the analyst arithmetic (pure) ⊕ the prose guard ⊕ the loop-agent body (fake deps).
// Expectations are literals (OP rule 11 — independent of the product constants).
import { describe, expect, test } from 'bun:test';
import { analyze, DEFAULT_LISTS, DEFAULT_NUMBERS, eigenvector, type Inputs, type MailRow, passBoard, renderAnalysis, topology } from './analyze.js';
import { numbersPreserved, proseLines } from './prose.js';
import { alignedEnd, createBody } from '../loop-agent/bodies/fed-analyst.js';

let nid = 1000;
const at = (min: number) => new Date(Date.UTC(2026, 10, 27, 14, 30) + min * 60_000).toISOString();
const m = (from: string, to: string, min: number, body = 'x', kind = 'report'): MailRow => ({ id: nid++, from, to, kind, createdAt: at(min), body });

// window 14:30–15:00Z: OP gets 12 (→ 24/h) · 2 machine of 30 (7%) · 3 ✋ to TC (→ 6/h) · RES (dormant) gets 2
const mails: MailRow[] = [
  ...Array.from({ length: 10 }, (_, i) => m('TC', 'OP', i, 'PR #40575 착지')),
  m('ORCHESTRATOR', 'OP', 11, 'ready 0 / idle 3'), m('JUD', 'OP', 12, '[연방 공보 · 30분] 착지 3'),
  m('TC-H-CX-1', 'TC', 13, '[✋ NEED HUMAN · TC-H-CX-1] slot'), m('TC-H-CX-2', 'TC', 14, '[✋ NEED HUMAN · TC-H-CX-2] hold'), m('TC-H-CX-1', 'TC', 15, '[✋ NEED HUMAN · TC-H-CX-1] slot again'),
  m('OP', 'RES', 16, 'lease?', 'request'), m('OP', 'RES', 17, 'lease??', 'request'),
  m('MK', 'JUD', 18, 'judge?', 'request'), m('JUD', 'MK', 18.5, 'ok'), m('MK', 'JUD', 19, 'judge??', 'request'), m('MK', 'JUD', 20, 'judge???', 'request'),
  m('JUDGE-BUTLER', 'JUD', 22, 'sign?', 'request'), m('JUDGE-BUTLER', 'JUD', 23, 'sign?', 'request'), m('JUDGE-BUTLER', 'JUD', 24, 'sign?', 'request'),
  ...Array.from({ length: 6 }, (_, i) => m('TC', 'TC-H-CX-1', 25 + i * 0.5, 'go')),
];
const panes = new Set(['OP', 'TC', 'JUD', 'MK', 'TC-H-CX-1', 'TC-H-CX-2']);

const inputs = (over: Partial<Inputs> = {}): Inputs => ({
  windowStart: new Date(at(0)), windowEnd: new Date(at(30)), mails, panes, dormantTable: ['RES', 'REL'],
  kpi1h: { landedPerHour: 3, idleWithWorkHands: 4, idleWithWorkSeats: ['JUD-3', 'JUD-B', 'MK', 'TC-H-CX-4'], greens: 6 },
  kpiWin: { claims: 5, greens: 2 },
  throughput: { verdict: 'ready-drought', lever: 'L-SUPPLY', owner: 'OP', lands: 3, greens: 6 },
  hands: [{ id: 198558, from: 'TC-H-CX-2', to: 'GUARDIAN', reason: 'HUMAN_DECISION', waitedMin: 21 }, { id: 198695, from: 'TC-H-POOL-1', to: 'TC', reason: 'auto-continue', waitedMin: 9 }],
  loops: { total: 22, exceptions: [{ id: 'release-traffic', owner: 'OP', at: at(-120) }] },
  board: { version: '0.3.38', total: 409, green: 211, done: 26, p0Yellow: 31 },
  ...over,
});

describe('topology — the Claude analyst script definitions', () => {
  test('OP inbound/h · machine % · ✋→TC/h · edges · dormant', () => {
    const t = topology(mails, DEFAULT_NUMBERS, DEFAULT_LISTS, { panes, dormantTable: ['RES', 'REL'] });
    expect(t.mails).toBe(30);
    expect(t.opInboundPerH).toBe(24);
    expect(t.machineRatioPct).toBe(7); // ORCHESTRATOR ⊕ «[연방 공보» = 2 of 30
    expect(t.handToTcPerH).toBe(6);
    // MK→JUD 3 requests / 1 answered = 33% · JUDGE-BUTLER is a loop agent (excluded) · OP→RES 2 requests (< 3)
    expect(t.badEdges).toEqual([{ edge: 'MK>JUD', requests: 3, answered: 1 }]);
    expect(t.dormantEdges).toEqual([{ to: 'RES', mails: 2 }]);
    expect(t.topPair).toEqual({ pair: 'OP<>TC', mails: 10 });
  });
  test('eigenvector: triangle ⊕ pendant (power iteration, undirected · values from an independent python run)', () => {
    const ev = eigenvector([{ from: 'A', to: 'HUB' }, { from: 'B', to: 'HUB' }, { from: 'A', to: 'B' }, { from: 'HUB', to: 'C' }]);
    const r = (k: string) => Math.round(ev.get(k)! * 1000) / 1000;
    expect([r('HUB'), r('A'), r('B'), r('C')]).toEqual([0.612, 0.523, 0.523, 0.282]);
  });
  test('pass board: six checks with the policy thresholds', () => {
    const t = topology(mails, DEFAULT_NUMBERS, DEFAULT_LISTS, { panes, dormantTable: ['RES', 'REL'] });
    expect(passBoard(t, DEFAULT_NUMBERS).map(p => [p.key, p.ok])).toEqual([
      ['op-inbound', false], ['machine', true], ['edges', false], ['dormant', false], ['hand-tc', true], ['eigen', false]]);
  });
  test('no pane list → only the dormant table decides', () => {
    const t = topology([m('OP', 'GHOST', 1), m('OP', 'REL', 2)], DEFAULT_NUMBERS, DEFAULT_LISTS, { panes: null, dormantTable: ['RES', 'REL'] });
    expect(t.dormantEdges).toEqual([{ to: 'REL', mails: 1 }]);
  });
});

describe('the six findings — every breach carries who · what · re-check', () => {
  test('owners and re-check time (window end + 30 min, KST)', () => {
    const a = analyze(inputs());
    expect(a.findings.map(f => [f.key, f.status])).toEqual([
      ['hands', 'breach'], ['loops', 'breach'], ['throughput', 'breach'], ['board', 'breach'], ['mail-path', 'breach'], ['op-topology', 'breach']]);
    const who = Object.fromEntries(a.findings.map(f => [f.key, f.action?.who]));
    expect(who).toEqual({ hands: 'OP', loops: 'OP', throughput: 'OP', board: 'OP', 'mail-path': 'GUARDIAN', 'op-topology': 'OP' });
    expect(a.findings[0]!.facts).toBe('열린 ✋ 2 · 15분 넘은 것 1 — #198558 TC-H-CX-2→GUARDIAN 21분 (HUMAN_DECISION)');
    expect(a.findings[2]!.facts).toBe('착지 3/h · 초록 6/h · claims 5/30분 · 일 있는 유휴 손 4(JUD-3 · JUD-B · MK · TC-H-CX-4) · 제어기 ready-drought → L-SUPPLY');
    for (const f of a.findings) expect(f.action!.recheckAt).toBe('00:30');
    expect(a.passed).toBe(2);
  });
  test('a ✋ held by a seat that answers stays with that seat', () => {
    const a = analyze(inputs({ hands: [{ id: 1, from: 'TC-H-CX-1', to: 'TC', reason: 'slot', waitedMin: 40 }] }));
    expect(a.findings[0]!.action!.who).toBe('TC');
  });
  test('unread sources read «?» (unknown), never 0', () => {
    const a = analyze(inputs({ hands: null, loops: null, board: null, kpi1h: null, throughput: null }));
    expect(a.findings.slice(0, 4).map(f => f.status)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    expect(a.findings[2]!.facts.startsWith('착지 ?/h · 초록 ?/h')).toBe(true);
  });
  test('all in bounds → no action lines · «병목 없음»', () => {
    const quiet = [m('TC', 'OP', 1, 'PR #1 착지'), m('OP', 'TC', 2, 'ok')];
    const a = analyze(inputs({ mails: quiet, hands: [], loops: { total: 3, exceptions: [] }, board: { version: '0.3.39', total: 10, green: 10, done: 0, p0Yellow: 0 },
      kpi1h: { landedPerHour: 12, idleWithWorkHands: 0, idleWithWorkSeats: [], greens: 11 } }), { ...DEFAULT_NUMBERS, coord_eigen_max_pct: 100 }); // two seats → 0.707 each
    expect(a.findings.every(f => f.action === null)).toBe(true);
    expect(a.bottleneck).toBe('병목 없음 — 여섯 줄 모두 기준 안');
    expect(renderAnalysis(a).filter(l => l.includes('→ 조치'))).toEqual([]);
  });
});

describe('prose — the one LLM node never renumbers', () => {
  test('a number not in the facts drops the line', () => {
    expect(numbersPreserved('착지 3/h · 초록 6/h', '착지는 3/h, 초록은 6/h 이다')).toBe(true);
    expect(numbersPreserved('착지 3/h · 초록 6/h', '착지는 4/h 이다')).toBe(false);
  });
  test('LLM reply → prose for kept lines · a reassuring breach line is dropped · template when no LLM', async () => {
    const a = analyze(inputs());
    const llm = { complete: async () => ({ model: 'fake/cheap', text: '{"throughput":"착지 3/h, 초록 6/h 로 목표 아래다","loops":"멈춘 루프는 없고 22개 중 release-traffic 만 예외다","board":"P0 노랑 99 다"}' }) };
    const r = await proseLines(a, llm);
    expect(Object.keys(r.prose)).toEqual(['throughput']);
    expect(r.why).toBe('2 line(s) dropped — a number not in the facts, or a breach worded as fine');
    expect((await proseLines(a, null)).used).toBe(false);
    expect(renderAnalysis(a, r.prose).find(l => l.startsWith('3. '))).toBe('3. 🔴 **처리량** — 착지 3/h, 초록 6/h 로 목표 아래다');
    expect(renderAnalysis(a, r.prose).find(l => l.startsWith('2. '))).toBe('2. 🔴 **멈춘 루프** — 루프 ok 21/22 · exception release-traffic');
  });
});

describe('loop agent body (fake deps)', () => {
  const card = {} as never;
  const make = (latestEnd: string | null) => {
    const wrote: unknown[] = []; const cases: string[] = [];
    const body = createBody({ stateRoot: '/nonexistent', card }, {
      gather: async (end, w) => ({ inputs: inputs({ windowEnd: end, windowStart: new Date(end.getTime() - w * 60_000) }), unread: [] }),
      latest: () => (latestEnd ? { windowEnd: latestEnd } as never : null),
      write: row => { wrote.push(row); return true; },
      openCase: (_a, key) => { cases.push(key); return true; },
      resolveOk: () => [],
      llm: () => null,
      prose: async () => ({ prose: {}, model: null, used: false, why: 'no LLM' }),
    });
    return { body, wrote, cases };
  };
  test('window boundary: a tick at :02 analyses [:30, :00)', () => {
    expect(alignedEnd(new Date('2026-11-27T15:02:40Z'), 30).toISOString()).toBe('2026-11-27T15:00:00.000Z');
  });
  test('due window → publish ⊕ one case per breached finding · KPI = minutes since the last window', async () => {
    const { body, wrote, cases } = make('2026-11-27T14:30:00.000Z');
    const now = new Date('2026-11-27T15:02:00Z');
    const obs = await body.observe({ now } as never);
    expect(obs.kpi).toBe(32);
    const plan = body.plan(obs, {} as never);
    expect(plan.map(p => `${p.action}:${p.target}`)).toEqual(['publish:window', 'case:hands', 'case:loops', 'case:throughput', 'case:board', 'case:mail-path', 'case:op-topology']);
    const r = await body.actions.publish!.run('window', { now, obs } as never);
    expect(r.ok).toBe(true);
    expect((wrote[0] as { windowEnd: string }).windowEnd).toBe('2026-11-27T15:00:00.000Z');
    expect((await body.actions.case!.run('hands', { now, obs } as never)).ok).toBe(true);
    expect(cases).toEqual(['hands']);
  });
  test('the window already published → no publish', async () => {
    const { body } = make('2026-11-27T15:00:00.000Z');
    const obs = await body.observe({ now: new Date('2026-11-27T15:12:00Z') } as never);
    expect(obs.kpi).toBe(12);
    expect(body.plan(obs, {} as never).some(p => p.action === 'publish')).toBe(false);
  });
  test('inputs unreadable → KPI unknown (null), nothing planned', async () => {
    const body = createBody({ stateRoot: '/x', card }, { gather: async () => { throw new Error('store locked'); }, latest: () => null, write: () => true, openCase: () => true, resolveOk: () => [], llm: () => null, prose: async () => ({ prose: {}, model: null, used: false, why: '' }) });
    const obs = await body.observe({ now: new Date() } as never);
    expect(obs.kpi).toBe(null);
    expect(body.plan(obs, {} as never)).toEqual([]);
  });
});
