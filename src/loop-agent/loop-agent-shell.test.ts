import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseKnowhowItems } from '../seat-loop/seat-knowhow.js';
import { butlerKnowhow } from '../judge-butler/agent.js';
import { applyPolicyChange, effectiveCard, emptyPolicy, parseCard } from './card.js';
import { LESSON_CAP, PROMOTE_AFTER_H, addCandidate, addLesson, fileAgentMemory, grepMemory, maintainLessons, recall } from './memory.js';
import { tickAgent, voiceAgent, type AgentBody, type AgentPorts, type VoiceLlm, type VoiceMessage } from './runtime.js';
import { parseLoopVoiceInput, toLoopVoiceReply, toVoiceMessage } from './channel.js';
import { outboxSpeaker } from './speak.js';

const CARD_YAML = `runtime: v2
id: toy-reaper
address: TOY-REAPER
supervisor: TC
soul: { name: 장난감 수거반, role: 좀비 런을 거둔다, temperament: 짧게, values: [증거 먼저] }
subject: toy runs
goal: 좀비 런 0
kpi: { name: zombie_runs, at_most: 0 }
done_when: [zombie_runs == 0 for one tick]
rights: { actions: [reap], never_auto: [kill by pattern], max_per_tick: 2, cooldown_min: 30 }
wake: { events: [run-stalled], max_wait_min: 10 }
escalate_after_min: 30
`;

// Seeded world: N runs, some zombies; `reap` ends a zombie (fails for ids listed in `stubborn`).
function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function world(seed: number, opts: { stubborn?: boolean } = {}) {
  const r = rng(seed);
  const runs = new Map<string, { zombie: boolean }>();
  const n = 4 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) runs.set(`run-${seed}-${i}`, { zombie: r() < 0.5 });
  if (![...runs.values()].some(x => x.zombie)) runs.get(`run-${seed}-0`)!.zombie = true;
  const body: AgentBody = {
    observe: () => {
      const z = [...runs].filter(([, v]) => v.zombie);
      return { kpi: z.length, subjects: z.map(([id]) => ({ id, kind: 'run', summary: 'no progress 30m', ageMin: 30 })), facts: [`runs ${runs.size}`],
        patterns: z.length ? [{ key: 'zombie@toy', lesson: 'toy 런은 30분 진전 없음이 반복된다 — 발사 전 호스트 부하를 본다.' }] : [] };
    },
    plan: obs => obs.subjects.map(s => ({ action: 'reap', target: s.id, why: 'zombie' })),
    actions: {
      reap: { describe: '좀비 런 하나를 정확 id 로 거둔다(되돌림: 재발사)', run: (target) => {
        const run = runs.get(target);
        if (!run) return { ok: false, line: `${target} 없음` };
        if (opts.stubborn) return { ok: false, line: `${target} 거두기 실패(stubborn)` };
        run.zombie = false; return { ok: true, line: `${target} 거둠`, ref: `run:${target}`, undo: `relaunch ${target}` };
      } },
    },
  };
  return { runs, body };
}
function harness(seed: number, opts: { stubborn?: boolean; llm?: VoiceLlm } = {}) {
  const root = mkdtempSync(join(tmpdir(), `la-${seed}-`));
  const card = parseCard(CARD_YAML, '장난감 수거반 — 시험용.');
  const memory = fileAgentMemory(root, card.id, card.supervisor);
  const posts: Array<{ key: string; to: string; body: string }> = [];
  const beats: Array<{ name: string; saw: number; err?: string }> = [];
  const spoken: string[] = [];
  const ports: AgentPorts = {
    memory, post(key, to, body) { if (posts.some(p => p.key === key)) return null; posts.push({ key, to, body }); return 900 + posts.length; },
    beat: b => { beats.push(b); }, speak: l => { spoken.push(l); }, llm: opts.llm ?? null,
  };
  return { root, card, memory, posts, beats, spoken, ports, ...world(seed, opts) };
}

describe('card', () => {
  test('parses a v2 card and refuses an unaccountable one', () => {
    const c = parseCard(CARD_YAML);
    expect(c).toMatchObject({ id: 'toy-reaper', address: 'TOY-REAPER', supervisor: 'TC', name: '장난감 수거반', kpi: { name: 'zombie_runs', target: 0, dir: 'at_most' } });
    expect(() => parseCard(CARD_YAML.replace('supervisor: TC\n', ''))).toThrow(/supervisor/);
    expect(() => parseCard(CARD_YAML.replace('actions: [reap], ', ''))).toThrow(/reversible action/);
    expect(() => parseCard(CARD_YAML.replace('runtime: v2\n', ''))).toThrow(/runtime: v2/);
  });
  test('policy is bounded and rights only narrow', () => {
    const c = parseCard(CARD_YAML);
    expect(applyPolicyChange(c, emptyPolicy(), 'kpi.target', 2).ok).toBe(true);
    expect(applyPolicyChange(c, emptyPolicy(), 'rights.max_per_tick', 99).ok).toBe(false);
    expect(applyPolicyChange(c, emptyPolicy(), 'rights.disable', 'shell').ok).toBe(false);
    expect(applyPolicyChange(c, emptyPolicy(), 'supervisor', 'CEO').ok).toBe(false);
    const p = applyPolicyChange(c, emptyPolicy(), 'rights.disable', 'reap');
    expect(p.ok && effectiveCard(c, p.policy).rights.actions).toEqual([]);
  });
});

describe('sim: subject event → wake → action → KPI (seeds)', () => {
  for (const seed of [1, 7, 42]) {
    test(`seed ${seed}`, async () => {
      const h = harness(seed);
      const zombies = [...h.runs.values()].filter(r => r.zombie).length;
      const t0 = new Date('2026-11-27T10:00:00Z');
      const r1 = await tickAgent(h.card, h.body, h.ports, t0);
      expect(r1.kpi).toBe(zombies);
      expect(r1.kpiOk).toBe(false);
      expect(r1.breach).toBe('new');
      expect(r1.acted.length).toBe(Math.min(2, zombies)); // max_per_tick 2
      expect(h.spoken[0]).toContain('zombie_runs');
      expect(h.beats.at(-1)).toMatchObject({ name: 'loop:toy-reaper', saw: zombies });
      // next ticks close the rest; KPI recovers and is spoken once
      let r = r1; let t = t0;
      for (let i = 0; i < 4 && r.kpiOk !== true; i++) { t = new Date(t.getTime() + 10 * 60_000); r = await tickAgent(h.card, h.body, h.ports, t); }
      t = new Date(t.getTime() + 10 * 60_000); r = await tickAgent(h.card, h.body, h.ports, t);
      expect(r.kpi).toBe(0); expect(r.kpiOk).toBe(true);
      expect(h.spoken.some(l => l.startsWith('✅'))).toBe(true);
      const kinds = h.memory.cases(200).map(c => c.kind);
      expect(kinds.filter(k => k === 'act').length).toBe(zombies);
      expect(kinds).toContain('kpi-breach'); expect(kinds).toContain('kpi-recovered');
      expect(h.posts.filter(p => p.key.startsWith('kpi-breach')).length).toBe(0); // closed inside escalate_after_min
    });
  }
  test('a breach the body cannot close is carded to L0 once; failures 3× → candidate lesson', async () => {
    const h = harness(5, { stubborn: true });
    let t = new Date('2026-11-27T10:00:00Z');
    for (let i = 0; i < 8; i++) { await tickAgent(h.card, h.body, h.ports, t); t = new Date(t.getTime() + 31 * 60_000); }
    const l0 = h.posts.filter(p => p.key.startsWith('kpi-breach'));
    expect(l0.length).toBe(1); expect(l0[0]!.to).toBe('TC');
    const lessons = h.memory.lessons();
    expect(lessons.some(l => l.pattern === 'act:reap:fail' && l.status !== 'rejected')).toBe(true);
    expect(h.posts.some(p => p.key.startsWith('lesson-candidate:') && p.to === 'TC')).toBe(true);
  });
  test('a planned action outside the rights is recorded as planned (once per cooldown), never run or refused', async () => {
    const h = harness(9);
    h.memory.writePolicy({ values: {}, disabled: ['reap'], focus: '' });
    const r = await tickAgent(h.card, h.body, h.ports, new Date('2026-11-27T10:00:00Z'));
    await tickAgent(h.card, h.body, h.ports, new Date('2026-11-27T10:05:00Z'));
    expect(r.acted).toEqual([]); expect(r.refused).toEqual([]);
    const planned = h.memory.cases(100).filter(c => c.kind === 'planned');
    expect(planned.length).toBe(r.kpi!);
    expect([...h.runs.values()].some(x => x.zombie)).toBe(true);
  });
  test('subject lost: 3 unreadable ticks → one reattach proposal to L0 (not idle) · reading again resets', async () => {
    const h = harness(4);
    const lost: AgentBody = { ...h.body, observe: () => ({ kpi: null, subjects: [], facts: ['run ledger gone'] }) };
    let t = new Date('2026-11-27T10:00:00Z');
    const reports = [];
    for (let i = 0; i < 5; i++) { reports.push(await tickAgent(h.card, lost, h.ports, t)); t = new Date(t.getTime() + 10 * 60_000); }
    expect(reports.map(r => r.subjectLost === true)).toEqual([false, false, true, false, false]);
    const cards = h.posts.filter(p => p.key.startsWith('subject-lost:'));
    expect(cards.length).toBe(1);
    expect(cards[0]!.to).toBe('TC');
    expect(cards[0]!.body).toContain('toy runs');
    expect(h.memory.cases(100).filter(c => c.kind === 'subject-lost').length).toBe(1);
    expect(h.spoken.some(l => l.startsWith('❓'))).toBe(true);
    await tickAgent(h.card, h.body, h.ports, t); // readable again
    expect(h.memory.readState().unknownTicks).toBe(0);
  });
  test('subject lost: a threshold lowered below the running count mid-outage alerts once on the next tick (Terra #40447 r3)', async () => {
    const h = harness(4);
    const lost: AgentBody = { ...h.body, observe: () => ({ kpi: null, subjects: [], facts: ['run ledger gone'] }) };
    const at = (m: number) => new Date(Date.parse('2026-11-27T10:00:00Z') + m * 60_000);
    const flags: boolean[] = [];
    for (let i = 0; i < 4; i++) flags.push((await tickAgent(h.card, lost, h.ports, at(i * 10), { policies: { subject_lost_ticks: 6 } })).subjectLost === true);
    for (let i = 4; i < 7; i++) flags.push((await tickAgent(h.card, lost, h.ports, at(i * 10), { policies: { subject_lost_ticks: 2 } })).subjectLost === true);
    expect(flags).toEqual([false, false, false, false, true, false, false]);
    expect(h.posts.filter(p => p.key.startsWith('subject-lost:')).map(p => p.to)).toEqual(['TC']);
    expect(h.memory.readState().unknownTicks).toBe(7);
    await tickAgent(h.card, h.body, h.ports, at(70)); // reads again → a new outage may alert again
    for (let i = 8; i < 10; i++) await tickAgent(h.card, lost, h.ports, at(i * 10), { policies: { subject_lost_ticks: 2 } });
    expect(h.posts.filter(p => p.key.startsWith('subject-lost:')).length).toBe(2);
  });
  test('levels: shadow plans only · off beats with error', async () => {
    const h = harness(3);
    h.memory.setLevel('shadow', 'TC', 'test');
    const r = await tickAgent(h.card, h.body, h.ports, new Date('2026-11-27T10:00:00Z'));
    expect(r.acted).toEqual([]);
    expect(h.memory.cases(50).some(c => c.kind === 'planned')).toBe(true);
    h.memory.setLevel('off', 'TC', 'test');
    await tickAgent(h.card, h.body, h.ports, new Date('2026-11-27T10:10:00Z'));
    expect(h.beats.at(-1)?.err).toBe('level off');
  });
});

describe('memory: lessons · knowhow · recall', () => {
  test('an L0 lesson survives reopening and influences the next body plan; persistent failure is handed to L0', async () => {
    const h = harness(51, { stubborn: true });
    const start = new Date('2026-11-27T10:00:00Z');
    const lesson = addLesson(h.memory, 'zombie_runs: reap the observed run', 'zombie_runs', 'TC', start);
    const reopened = fileAgentMemory(h.root, h.card.id, h.card.supervisor);
    let applied = false;
    const body: AgentBody = {
      ...h.body,
      plan(obs, ctx) {
        applied = ctx.recall?.lessons.includes(lesson.id) ?? false;
        return applied ? h.body.plan(obs, ctx) : [];
      },
    };
    const ports = { ...h.ports, memory: reopened };
    for (let i = 0; i < 3; i++) await tickAgent(h.card, body, ports, new Date(start.getTime() + i * 31 * 60_000));
    expect(applied).toBe(true);
    expect(reopened.lessons().some(l => l.id === lesson.id && l.status === 'active')).toBe(true);
    expect(reopened.cases(100).some(c => c.kind === 'act-failed' && c.why.includes('실패'))).toBe(true);
    expect(h.posts.some(p => p.key.startsWith('kpi-breach') && p.to === 'TC')).toBe(true);
  });
  test('lesson promotion sim: silence promotes · L0 reject sticks · cap holds', () => {
    const h = harness(11);
    const t0 = new Date('2026-11-27T00:00:00Z');
    const a = addCandidate(h.memory, 'p:a', 'A 는 반복 실패', t0)!;
    const b = addCandidate(h.memory, 'p:b', 'B 는 반복 실패', t0)!;
    expect(addCandidate(h.memory, 'p:a', 'dup', t0)).toBeNull();
    expect(maintainLessons(h.memory, new Date(t0.getTime() + (PROMOTE_AFTER_H - 1) * 3_600_000)).promoted).toEqual([]);
    // L0 rejects B before the window ends
    const rows = h.memory.lessons(); rows.find(r => r.id === b.id)!.status = 'rejected'; h.memory.writeLessons(rows);
    const m = maintainLessons(h.memory, new Date(t0.getTime() + PROMOTE_AFTER_H * 3_600_000));
    expect(m.promoted.map(l => l.id)).toEqual([a.id]);
    expect(h.memory.lessons().find(l => l.id === b.id)!.status).toBe('rejected');
    for (let i = 0; i < LESSON_CAP + 5; i++) addLesson(h.memory, `교훈 ${i}`, `p:${i}`, 'TC', new Date(t0.getTime() + i * 1000));
    expect(h.memory.lessons().filter(l => l.status === 'active').length).toBe(LESSON_CAP);
  });
  test('recall stays within budget and marks the lessons it used', () => {
    const h = harness(12);
    const now = new Date('2026-11-27T00:00:00Z');
    for (let i = 0; i < 25; i++) h.memory.addKnowhow({ title: `호스트 부하 규칙 ${i}`, situation: `node-b 부하 ${i} ${'가'.repeat(300)}`, prescription: '다른 호스트로' }, 'TC', now);
    for (let i = 0; i < 20; i++) addLesson(h.memory, `node-b tsc 시간초과 ${i} ${'나'.repeat(200)}`, `p:${i}`, 'TC', now);
    for (let i = 0; i < 30; i++) h.memory.appendCase({ at: now.toISOString(), kind: 'tick', subject: 'k', why: 'x'.repeat(300), decidedBy: 'X', supervisedBy: 'TC' });
    const r = recall(h.memory, 'node-b tsc 시간초과', now, { budget: 3_000 });
    expect(r.chars).toBeLessThanOrEqual(3_000);
    expect(r.text.length).toBeLessThanOrEqual(3_000);
    expect(r.knowhow.length + r.lessons.length).toBeGreaterThan(0);
    expect(h.memory.lessons().filter(l => l.hits > 0).length).toBe(r.lessons.length);
    expect(grepMemory(h.memory, 'node-b').length).toBeGreaterThan(0);
  });
  test('knowhow: the judge-butler seed parses in the seat KNOWHOW format · add bumps version and id', () => {
    const seed = readFileSync(resolve(import.meta.dir, '../../graphs/loop-agents/judge-butler/knowhow.md'), 'utf8');
    expect(parseKnowhowItems(seed, 'JUDGE-BUTLER').length).toBe(4);
    const h = harness(13);
    expect(h.memory.seedKnowhow(seed)).toBe(true);
    expect(h.memory.seedKnowhow(seed)).toBe(false); // same hash = same version
    const kid = h.memory.addKnowhow({ title: 't', situation: 's', prescription: 'p' }, 'TC');
    expect(kid).toBe('K-TOY-REAPER-001');
    expect(h.memory.knowhow().meta.version).toBe(2);
  });
});

// Fake LLM: answers from the prompt's facts and asks for actions by what the message says.
function fakeLlm(log: Array<{ system: string; user: string }>): VoiceLlm {
  return {
    async complete(system, user) {
      log.push({ system, user });
      const said = user.slice(user.lastIndexOf('## 받은 말'));
      const z = /\b(run-\d+-\d+)\b/u.exec(said)?.[1];
      if (/거둬/u.test(said) && z) return { model: 'fake', text: JSON.stringify({ reply: `${z} 를 거둔다.`, actions: [{ cmd: 'act', action: 'reap', target: z }] }) };
      if (/rm -rf/u.test(said)) return { model: 'fake', text: JSON.stringify({ reply: '셸은 하지 않는다.', actions: [{ cmd: 'shell', run: 'rm -rf /' }] }) };
      if (/목표/u.test(said)) return { model: 'fake', text: JSON.stringify({ reply: '목표를 바꾼다.', actions: [{ cmd: 'set-policy', key: 'kpi.target', value: 1, why: 'L0 요청' }] }) };
      if (/승인/u.test(said)) return { model: 'fake', text: JSON.stringify({ reply: '승인.', actions: [{ cmd: 'lesson-decide', id: /L-\d+/u.exec(said)?.[0] ?? '', approve: true }] }) };
      const kpi = /zombie_runs (\d+)/u.exec(user)?.[1];
      return { model: 'fake', text: `생각…\n${JSON.stringify({ reply: `지금 좀비 ${kpi ?? '?'} 개를 보고 있다.`, actions: [] })}` };
    },
  };
}
const msg = (id: number, from: string, body: string): VoiceMessage => ({ id, from, body, at: '2026-11-27T10:00:00Z', channel: 'els:ws:supervisors', thread: 'els:ws:supervisors' });

describe('voice round-trip (fake LLM)', () => {
  test('answers with evidence · acts inside rights · refuses outside · policy only from L0 · multi-turn thread', async () => {
    const log: Array<{ system: string; user: string }> = [];
    const h = harness(21, { llm: fakeLlm(log) });
    const now = new Date('2026-11-27T10:00:00Z');
    const deps = { card: h.card, body: h.body, ports: h.ports, now };
    const r1 = await voiceAgent(deps, msg(1, 'OPC', '지금 뭐 하고 있어?'));
    expect(r1.folded).toBe(false);
    expect(r1.reply).toMatch(/좀비 \d+ 개/);
    expect(r1.refs).toContain('els:ws:supervisors:1');
    expect(log[0]!.system).toContain('장난감 수거반'); // soul first
    const z = [...h.runs].find(([, v]) => v.zombie)![0];
    const r2 = await voiceAgent(deps, msg(2, 'OPC', `${z} 거둬줘`));
    expect(r2.actions).toContain(`act:reap:${z}`);
    expect(h.runs.get(z)!.zombie).toBe(false);
    expect(log[1]!.user).toContain('지금 뭐 하고 있어?'); // previous turn in the thread
    const r3 = await voiceAgent(deps, msg(3, 'OPC', 'rm -rf 해'));
    expect(r3.escalated).toBe(true);
    expect(h.posts.some(p => p.to === 'TC' && p.key.startsWith('voice-esc:'))).toBe(true);
    const r4 = await voiceAgent(deps, msg(4, 'OPC', '목표 1로'));
    expect(r4.actions).toContain('set-policy-refused:kpi.target');
    const r5 = await voiceAgent(deps, msg(5, 'TC', '목표 1로'));
    expect(r5.actions).toContain('set-policy:kpi.target');
    expect(h.memory.policy().values['kpi.target']).toBe(1);
    const cand = addCandidate(h.memory, 'p:x', '후보', now)!;
    const r6 = await voiceAgent(deps, msg(6, 'TC', `${cand.id} 승인`));
    expect(r6.actions).toContain(`lesson-approve:${cand.id}`);
    expect(h.memory.lessons().find(l => l.id === cand.id)!.status).toBe('active');
    expect(h.memory.cases(100).filter(c => c.kind === 'voice').length).toBe(6);
  });
  test('folds to facts without an LLM and when over budget', async () => {
    const h = harness(22);
    const r = await voiceAgent({ card: h.card, body: h.body, ports: h.ports }, msg(1, 'OP', '왜 KPI 가 떨어졌어?'));
    expect(r.folded).toBe(true);
    expect(r.reply).toContain('zombie_runs');
    expect(r.reply).toContain('L0 TC');
  });
  test('channel adapter: #40331 JSON in → reply out, thread = channel', () => {
    const input = parseLoopVoiceInput(JSON.stringify({ loop: 'toy-reaper', from: { role: 'hand', pane: 'p3', seat: 'OPC' }, channel: 'ws:supervisors', text: 'hi', refs: ['pr:1'], messageId: 'cm-1' }), 'toy-reaper');
    const m = toVoiceMessage(input, new Date('2026-11-27T10:00:00Z'));
    expect(m).toMatchObject({ from: 'OPC', channel: 'els:ws:supervisors', thread: 'els:ws:supervisors' });
    expect(() => parseLoopVoiceInput(JSON.stringify({ loop: 'other', from: { role: 'hand' }, text: 'x', messageId: '1' }), 'toy-reaper')).toThrow();
    const reply = toLoopVoiceReply({ msg: m, folded: false, reply: 'ok', refs: ['els:ws:supervisors:cm-1', 'bad ref with space'], actions: ['act:reap:run-1', 'bad action!'], model: 'fake', escalated: false });
    expect(reply.evidence).toEqual(['els:ws:supervisors:cm-1', 'badrefwithspace']);
    expect(reply.actions).toEqual(['act:reap:run-1']);
  });
  test('outbox speaker writes one line per call', () => {
    const root = mkdtempSync(join(tmpdir(), 'la-speak-'));
    outboxSpeaker(root, 'toy-reaper', () => new Date('2026-11-27T10:00:00Z'))('⚠️ hi');
    expect(readFileSync(join(root, 'loop-agents', 'toy-reaper', 'speak.jsonl'), 'utf8')).toContain('"channel":"loop:toy-reaper"');
  });
});


describe('judge-butler on the shell', () => {
  test('its knowhow pack is seeded into its own home and recalled for a voice turn', () => {
    const root = mkdtempSync(join(tmpdir(), 'la-jb-'));
    const text = butlerKnowhow({ root: join(root, 'loop-agents', 'judge-butler') }, new Date('2026-11-27T00:00:00Z'))('같은 head 영수 focused 재요구');
    expect(text).toContain('K-JUDGE-BUTLER-001');
    expect(readFileSync(join(root, 'loop-agents', 'judge-butler', 'knowhow', 'seed.md'), 'utf8')).toContain('K-JUDGE-BUTLER-004');
  });
});
