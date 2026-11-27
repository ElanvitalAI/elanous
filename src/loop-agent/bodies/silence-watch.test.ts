import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseKnowhowItems } from '../../seat-loop/seat-knowhow.js';
import { loadCard } from '../card.js';
import { fileAgentMemory } from '../memory.js';
import { readJournal } from '../journal.js';
import { tickAgent, voiceAgent, type AgentPorts, type VoiceLlm, type VoiceMessage } from '../runtime.js';
import { createBody, type SilenceDeps } from './silence-watch.js';

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
    expect(c.rights.actions).toEqual(['redeliver', 'bounce']);
    const kh = readFileSync(resolve(import.meta.dir, '../../../graphs/loop-agents/silence-watch/knowhow.md'), 'utf8');
    expect(parseKnowhowItems(kh, 'SILENCE-WATCH').length).toBeGreaterThanOrEqual(3);
  });
});
