import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseKnowhowItems } from '../../seat-loop/seat-knowhow.js';
import { loadCard } from '../card.js';
import { fileAgentMemory } from '../memory.js';
import { readJournal } from '../journal.js';
import { tickAgent, voiceAgent, type AgentPorts, type VoiceLlm, type VoiceMessage } from '../runtime.js';
import { createBody, ledgerAnswerFrom, type CellEvent, type SilenceDeps } from './silence-watch.js';

const T0 = new Date('2026-11-27T10:00:00Z');
const M = 60_000;
function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

// Seeded mail ledger: requests to live seats (answer once their bell rings), to a reader-less address (RES), optionally to a
// deaf seat (reads mail, never decides), plus one fresh request inside the SLA that must not count.
function world(seed: number, opts: { deaf?: boolean } = {}) {
  const r = rng(seed);
  const seats = ['TC', 'UX', 'JUD'];
  const pending = new Map<number, { id: number; from: string; to: string; at: number; body: string }>();
  let id = 9000 + seed * 10;
  const n = 3 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) { id++; pending.set(id, { id, from: 'OP', to: seats[i % seats.length]!, at: T0.getTime() - (35 + Math.floor(r() * 300)) * M, body: `칸 ${i} 수락/거절 부탁` }); }
  id++; pending.set(id, { id, from: 'LAND-GRAPH', to: 'RES', at: T0.getTime() - 120 * M, body: 'pregate over cap' });
  const noReaderId = id;
  if (opts.deaf) { id++; pending.set(id, { id, from: 'OP', to: 'REL', at: T0.getTime() - 90 * M, body: '컷 확인 요청' }); }
  id++; pending.set(id, { id, from: 'OP', to: 'TC', at: T0.getTime() - 5 * M, body: '방금 보낸 것' }); // inside SLA
  const rung: Array<[string, number]> = [];
  const posted: Array<{ key: string; to: string; body: string }> = [];
  const deps: SilenceDeps = {
    overdue: (now, sla) => [...pending.values()].filter(m => now.getTime() - m.at >= sla * M).map(m => ({ id: m.id, from: m.from, to: m.to, ageMin: (now.getTime() - m.at) / M, summary: m.body })),
    readers: (_now, addrs) => new Map(addrs.map(a => [a, a !== 'RES'] as const)),
    stalled: () => [{ name: 'loop:release-rocket', ageMin: 40 }],
    // one bell wakes the seat for its whole inbox: a live seat then answers every request it holds (REL reads, never decides)
    ring: (to, msgId) => { rung.push([to, msgId]); if (to !== 'REL') for (const [k, m] of pending) if (m.to === to) pending.delete(k); return true; },
    post: (key, to, body) => { if (posted.some(p => p.key === key)) return null; posted.push({ key, to, body }); return 300 + posted.length; },
  };
  return { pending, overdueCount: n + 1 + (opts.deaf ? 1 : 0), noReaderId, deps, rung, posted };
}

function harness(seed: number, opts: { deaf?: boolean; llm?: VoiceLlm } = {}) {
  const root = mkdtempSync(join(tmpdir(), `sw-${seed}-`));
  const card = loadCard('silence-watch');
  const memory = fileAgentMemory(root, card.id, card.supervisor);
  const posts: Array<{ key: string; to: string; body: string }> = [];
  const ports: AgentPorts = {
    memory, post(key, to, body) { if (posts.some(p => p.key === key)) return null; posts.push({ key, to, body }); return 800 + posts.length; },
    beat: () => {}, speak: () => {}, llm: opts.llm ?? null,
  };
  const w = world(seed, opts);
  return { root, card, memory, posts, ports, body: createBody({ stateRoot: root, card }, w.deps), ...w };
}

describe('silence-watch sim: unanswered mail → wake → redeliver/bounce → KPI (seeds)', () => {
  for (const seed of [1, 7, 42]) {
    test(`seed ${seed}`, async () => {
      const h = harness(seed);
      const r1 = await tickAgent(h.card, h.body, h.ports, T0);
      expect(r1.kpi).toBe(h.overdueCount); // the 5-minute-old request is not counted
      expect(r1.kpiOk).toBe(false);
      expect(r1.acted).toContain('bounce:RES');
      expect(h.posted.filter(p => p.key === 'silence-bounce:RES:LAND-GRAPH:2026-11-27').map(p => p.to)).toEqual(['LAND-GRAPH']);
      expect(h.posted.find(p => p.to === 'LAND-GRAPH')!.body).toContain(`#${h.noReaderId}`);
      expect(h.rung.some(([to]) => to === 'RES')).toBe(false); // no bell for a reader-less address
      let t = T0.getTime(); let r = r1;
      for (let i = 0; i < 2; i++) { t += 5 * M; r = await tickAgent(h.card, h.body, h.ports, new Date(t)); }
      expect(r.kpi).toBe(0); expect(r.kpiOk).toBe(true);
      // one bell per addressee (TC · UX · JUD each hold ≥ 1 overdue request in every seed), never one per message
      expect(h.rung.map(([to]) => to).sort()).toEqual(['JUD', 'TC', 'UX']);
      expect(h.posts.filter(p => p.key.startsWith('kpi-breach')).length).toBe(0);
      const acts = h.memory.cases(200).filter(c => c.kind === 'act');
      expect(acts.every(c => typeof c.extra?.undo === 'string')).toBe(true);
    });
  }
  test('a seat that reads but never decides: rung once, then one card to OP after escalate_after_min', async () => {
    const h = harness(5, { deaf: true });
    let t = T0.getTime();
    for (let i = 0; i < 16; i++) { await tickAgent(h.card, h.body, h.ports, new Date(t)); t += 5 * M; }
    expect(h.rung.filter(([to]) => to === 'REL').length).toBe(1);
    const l0 = h.posts.filter(p => p.key.startsWith('kpi-breach'));
    expect(l0.length).toBe(1); expect(l0[0]!.to).toBe('OP');
    expect(l0[0]!.body).toContain('msg:');
  });
  test('SUPERVISOR-JOURNAL-DEFECTS: a reader-less ORCHESTRATOR with 18 re-asks → no bell · one line a day to the sender · RES reroutes to GUARDIAN', async () => {
    const h = harness(11);
    for (let i = 0; i < 18; i++) h.pending.set(9500 + i, { id: 9500 + i, from: 'OP', to: 'ORCHESTRATOR', at: T0.getTime() - (60 + i) * M, body: `[OP · re-ask] No reply yet ${i}` });
    h.deps.readers = (_now, addrs) => new Map(addrs.map(a => [a, a !== 'RES' && a !== 'ORCHESTRATOR'] as const));
    h.deps.reroute = m => (m.to === 'RES' ? 'GUARDIAN' : m.to === 'ORCHESTRATOR' ? 'OP' : null);
    let t = T0.getTime();
    for (let i = 0; i < 12; i++) { await tickAgent(h.card, h.body, h.ports, new Date(t)); t += 5 * M; }
    expect(h.rung.some(([to]) => to === 'ORCHESTRATOR')).toBe(false);
    expect(h.posted.filter(p => p.key.startsWith('silence-bounce:ORCHESTRATOR:')).map(p => `${p.to}|${p.key}`)).toEqual(['OP|silence-bounce:ORCHESTRATOR:OP:2026-11-27']);
    expect(h.posted.find(p => p.key.startsWith('silence-bounce:ORCHESTRATOR:'))!.body).toContain('18통');
    expect(h.posted.filter(p => p.key.startsWith('silence-bounce:RES:')).map(p => p.to)).toEqual(['GUARDIAN']);
    const rows = readJournal(h.memory.root, T0.getTime() - 3_600_000, t);
    expect(rows.filter(r => r.target === 'ORCHESTRATOR').length).toBe(1);
    expect(rows.length).toBe(5); // bounce ORCHESTRATOR · bounce RES · redeliver TC · UX · JUD
  });
  test('YAML-OPS-SCRIPTS-ABSORB: an OP request is due after sla_min_op (15) · another sender after sla_min (30)', async () => {
    const h = harness(3);
    h.pending.set(9901, { id: 9901, from: 'OP', to: 'UX', at: T0.getTime() - 20 * M, body: '20분 된 OP 요청' });
    h.pending.set(9902, { id: 9902, from: 'LAND-GRAPH', to: 'UX', at: T0.getTime() - 20 * M, body: '20분 된 착지 그래프 요청' });
    h.pending.set(9903, { id: 9903, from: 'OP', to: 'UX', at: T0.getTime() - 14 * M, body: '14분 된 OP 요청' });
    const r1 = await tickAgent(h.card, h.body, h.ports, T0);
    expect(r1.kpi).toBe(h.overdueCount + 1); // only #9901 joins
  });
  test('unreadable store = unknown, not 0', async () => {
    const h = harness(3);
    h.deps.overdue = () => null;
    const r = await tickAgent(h.card, h.body, h.ports, T0);
    expect(r.kpi).toBeNull(); expect(r.acted).toEqual([]);
  });
});

function fakeLlm(): VoiceLlm {
  return {
    async complete(_system, user) {
      const said = user.slice(user.lastIndexOf('## 받은 말'));
      const mid = /msg:(\d+)\(mail-overdue/u.exec(user)?.[1];
      if (/다시 알려/u.test(said) && mid) return { model: 'fake', text: JSON.stringify({ reply: `#${mid} 를 다시 알린다.`, actions: [{ cmd: 'act', action: 'redeliver', target: mid }] }) };
      if (/ack/u.test(said)) return { model: 'fake', text: JSON.stringify({ reply: '남의 우편 ack 는 내 권한 밖이다.', actions: [{ cmd: 'act', action: 'ack', target: mid ?? '0' }, { cmd: 'escalate', why: '대신 ack 요청 — 권한 밖' }] }) };
      const kpi = /unanswered_mail_past_sla (\d+)/u.exec(user)?.[1];
      return { model: 'fake', text: JSON.stringify({ reply: `SLA 넘은 미결 ${kpi ?? '?'} 통(msg:${mid ?? '?'} 등) — 받는 자리를 한 번씩 다시 깨우는 중이고, RES 는 읽는 몸이 없어 보낸 이에게 알렸다.`, actions: [] }) };
    },
  };
}
const msg = (id: number, from: string, body: string): VoiceMessage => ({ id, from, body, at: T0.toISOString(), channel: 'mail', thread: 'mail' });

describe('silence-watch voice (fake LLM)', () => {
  test('answers from facts · redeliver inside rights · ack-for-others refused and escalated to OP', async () => {
    const h = harness(21, { llm: fakeLlm() });
    const deps = { card: h.card, body: h.body, ports: h.ports, now: T0 };
    const r1 = await voiceAgent(deps, msg(1, 'OP', '왜 KPI 가 나빠? 지금 뭐 해? 뭐가 막아?'));
    expect(r1.folded).toBe(false);
    expect(r1.reply).toMatch(/미결 \d+ 통\(msg:\d+/u);
    const r2 = await voiceAgent(deps, msg(2, 'OP', '그 우편 다시 알려줘'));
    expect(r2.actions.some(a => a.startsWith('act:redeliver:'))).toBe(true);
    expect(h.rung.length).toBe(1);
    const r3 = await voiceAgent(deps, msg(3, 'TC', '내 대신 ack 해줘'));
    expect(r3.actions.some(a => a.startsWith('act-refused:ack:'))).toBe(true);
    expect(r3.escalated).toBe(true);
    expect(h.posts.some(p => p.to === 'OP' && p.key.startsWith('voice-esc:'))).toBe(true);
  });
});

describe('silence-watch card', () => {
  test('card loads · knowhow parses ≥3', () => {
    const c = loadCard('silence-watch');
    expect(c).toMatchObject({ id: 'silence-watch', address: 'SILENCE-WATCH', supervisor: 'OP', kpi: { name: 'unanswered_mail_past_sla', target: 0, dir: 'at_most' } });
    expect(c.rights.actions).toEqual(['redeliver', 'bounce', 'settle', 'close-notice', 'reopen-notice']);
    const kh = readFileSync(resolve(import.meta.dir, '../../../graphs/loop-agents/silence-watch/knowhow.md'), 'utf8');
    expect(parseKnowhowItems(kh, 'SILENCE-WATCH').length).toBeGreaterThanOrEqual(3);
  });
});

// DETECT-TO-ACTION (11-28 live: KPI 158 flat 18 h · 140 of 159 already seen ⊕ hand-acked ⊕ rung once — the ladder had no next step)
describe('silence-watch settle: a request its cell ledger already answered gets the done receipt the ledger proves', () => {
  const at = '2026-11-27T09:00:00.000Z';
  const ev = (min: number, by: string, field: string, to: unknown): CellEvent => ({ at: new Date(Date.parse(at) + min * M).toISOString(), by, field, to });
  test('ledgerAnswerFrom: receiver wrote after the mail · cell green · owner moved · nothing (and a release move is not a reply)', () => {
    const m = { to: 'TC-H-CX-3', at, cells: ['A-1'] };
    expect(ledgerAnswerFrom(m, () => [ev(-5, 'OP', 'claim', 'TC-H-CX-3'), ev(12, 'TC-H-CX-3', 'claim', 'TC')])).toEqual({ cell: 'A-1', why: 'receiver-wrote', evidence: 'cell:A-1 claim by TC-H-CX-3 @2026-11-27T09:12:00.000Z' });
    expect(ledgerAnswerFrom(m, () => [ev(30, 'JUDGE-BUTLER', 'status', 'green')])).toEqual({ cell: 'A-1', why: 'cell-closed', evidence: 'cell:A-1 status green by JUDGE-BUTLER @2026-11-27T09:30:00.000Z' });
    expect(ledgerAnswerFrom(m, () => [ev(40, 'OP', 'claim', 'MVP-B')])).toEqual({ cell: 'A-1', why: 'owner-moved', evidence: 'cell:A-1 claim → MVP-B by OP @2026-11-27T09:40:00.000Z' });
    expect(ledgerAnswerFrom(m, () => [ev(40, 'OP', 'claim', 'TC-H-CX-3'), ev(50, 'TC-H-CX-3', 'move', '0.3.40'), ev(-60, 'OP', 'status', 'yellow')])).toBeNull();
    expect(ledgerAnswerFrom({ to: 'TC', at, cells: [] }, () => [ev(1, 'TC', 'claim', 'TC')])).toBeNull();
    expect(ledgerAnswerFrom({ to: 'TC', at: undefined, cells: ['A-1'] }, () => [ev(1, 'TC', 'claim', 'TC')])).toBeNull();
  });
  test('tick: 3 answered mails settled once (source ledger · evidence) · the unanswered one is rung, never settled · KPI 4 → 1', async () => {
    const h = harness(31);
    h.pending.clear();
    const base = T0.getTime() - 120 * M;
    const rows = [
      { id: 7001, to: 'TC-H-CX-3', cells: ['A-1'] }, { id: 7002, to: 'TC-H-CX-3', cells: ['A-2'] },
      { id: 7003, to: 'UX', cells: ['B-1'] }, { id: 7004, to: 'UX', cells: ['B-2'] },
    ];
    const hist: Record<string, CellEvent[]> = {
      'A-1': [{ at: new Date(base + 10 * M).toISOString(), by: 'TC-H-CX-3', field: 'claim', to: 'TC-H-CX-3' }],
      'A-2': [{ at: new Date(base + 20 * M).toISOString(), by: 'JUDGE-BUTLER', field: 'status', to: 'done' }],
      'B-1': [{ at: new Date(base + 30 * M).toISOString(), by: 'OP', field: 'claim', to: 'MVP-B' }],
      'B-2': [],
    };
    const receipts: string[] = []; const settled = new Set<number>();
    h.deps.overdue = (now) => rows.filter(r => !settled.has(r.id)).map(r => ({ id: r.id, from: 'OP', to: r.to, ageMin: (now.getTime() - base) / M, summary: 'assign', at: new Date(base).toISOString(), kind: 'assign', cells: r.cells }));
    h.deps.ring = (to, id) => { h.rung.push([to, id]); return true; };
    h.deps.ledgerAnswer = m => ledgerAnswerFrom(m, c => hist[c] ?? []);
    h.deps.settle = (to, id, reason, evidence) => { receipts.push(`${id}|${to}|${evidence}|${reason}`); settled.add(id); return true; };
    const r1 = await tickAgent(h.card, h.body, h.ports, T0);
    expect(r1.kpi).toBe(4);
    expect([...r1.acted].sort()).toEqual(['redeliver:UX', 'settle:TC-H-CX-3', 'settle:UX']);
    expect(receipts).toEqual([
      '7001|TC-H-CX-3|cell:A-1 claim by TC-H-CX-3 @2026-11-27T08:10:00.000Z|silence-watch: 받는 이가 칸 원장에 씀 — 우편 대신 칸 원장에서 결정됨',
      '7002|TC-H-CX-3|cell:A-2 status done by JUDGE-BUTLER @2026-11-27T08:20:00.000Z|silence-watch: 칸이 끝남 — 우편 대신 칸 원장에서 결정됨',
      '7003|UX|cell:B-1 claim → MVP-B by OP @2026-11-27T08:30:00.000Z|silence-watch: 칸 주인이 바뀜 — 우편 대신 칸 원장에서 결정됨',
    ]);
    expect(h.rung).toEqual([['UX', 7004]]);
    const r2 = await tickAgent(h.card, h.body, h.ports, new Date(T0.getTime() + 5 * M));
    expect(r2.kpi).toBe(1);
    expect(receipts.length).toBe(3);
    const settleCase = h.memory.cases(50).find(c => c.kind === 'act' && c.subject === 'settle:TC-H-CX-3');
    expect(settleCase?.why).toBe('TC-H-CX-3 미결 2통 정리(done · 원장 근거: 받는 이가 칸 원장에 씀·칸이 끝남) #7001 #7002 · 이유: TC-H-CX-3 앞 2통은 칸 원장이 이미 답함(#7001 A-1 · #7002 A-2)');
  });
  test('a cooldown is «대기» with its reason, not «거절» (11-27 journal: «행동 0/4 · 거절 4» were all cooldowns)', async () => {
    const h = harness(33);
    h.pending.clear();
    let n = 7100;
    const add = () => { n++; h.pending.set(n, { id: n, from: 'OP', to: 'REL', at: T0.getTime() - 40 * M, body: `ask ${n}` }); };
    h.deps.ring = (to, id) => { h.rung.push([to, id]); return true; }; // REL reads, never decides
    add();
    await tickAgent(h.card, h.body, h.ports, T0);
    add(); // a new unrung request to the same seat inside the 60-min cooldown of redeliver:REL
    const r2 = await tickAgent(h.card, h.body, h.ports, new Date(T0.getTime() + 5 * M));
    expect(r2.refused).toEqual([]);
    expect(r2.deferred).toEqual(['redeliver:REL: 60분 쿨다운 안 (마지막 10:00Z)']);
    const tick = h.memory.cases(50).filter(c => c.kind === 'tick').at(-1)!;
    expect(tick.why).toContain('행동 0/1 · 대기 1(쿨다운 1 — redeliver:REL: 60분 쿨다운 안 (마지막 10:00Z))');
    expect(tick.why).not.toContain('거절');
  });
});
