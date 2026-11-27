import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseKnowhowItems } from '../../seat-loop/seat-knowhow.js';
import { loadCard } from '../card.js';
import { fileAgentMemory } from '../memory.js';
import { tickAgent, voiceAgent, type AgentPorts, type VoiceLlm, type VoiceMessage } from '../runtime.js';
import { createBody, defaultClock, milestones, type Clock, type ReleaseRocketDeps, type ReleaseView, type RunView, type YellowCell } from './release-rocket.js';

function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
// 22:00 / 04:00 / 06:00 KST written in UTC.
const CLOCK: Clock = { rehearsalAt: '2026-11-27T13:00:00.000Z', cutAt: '2026-11-27T19:00:00.000Z', publishAt: '2026-11-27T21:00:00.000Z' };
const at = (iso: string, plusMin: number) => new Date(Date.parse(iso) + plusMin * 60_000);
const NONE: RunView = { exists: false, done: false, hardStop: null, steps: {} };

// Seeded release world: yellow cells (some critical) · a rehearsal that nobody started · the cut done at cut time by the
// release graph (or never, `stuckCut`).
function world(seed: number, opts: { stuckCut?: boolean; rehearsalDone?: boolean; failStart?: boolean } = {}) {
  const r = rng(seed);
  const yellow: YellowCell[] = [];
  const n = 3 + Math.floor(r() * 5);
  for (let i = 0; i < n; i++) { const crit = r() < 0.3; yellow.push({ id: `C-${seed}-${i}`, critical: crit, why: crit ? 'P0' : 'P2' }); }
  if (!yellow.some(c => !c.critical)) yellow.push({ id: `C-${seed}-x`, critical: false, why: 'P2' });
  const state = { rehearsal: opts.rehearsalDone ? { exists: true, done: true, hardStop: null, steps: {} } as RunView : NONE, run: NONE, published: false };
  const mails: Array<{ key: string; to: string; body: string }> = [];
  const started: string[] = []; const archived: string[] = [];
  let now = new Date(CLOCK.rehearsalAt);
  const deps: ReleaseRocketDeps = {
    readRelease: (): ReleaseView => {
      // the release graph cuts at cut time (unless stuck) — a run with the cut step done
      if (!opts.stuckCut && now.getTime() >= Date.parse(CLOCK.cutAt) && !state.run.exists) state.run = { exists: true, done: false, hardStop: null, steps: { cut: 'done', publish: 'pending' } };
      return { version: '0.3.40', published: state.published, clock: CLOCK, clockSource: 'schedule', run: state.run, rehearsal: state.rehearsal, yellow };
    },
    startRehearsal: (v) => { if (opts.failStart) return { ok: false, line: 'createRehearsal: EACCES' }; started.push(v); state.rehearsal = { exists: true, done: false, hardStop: null, steps: { cut: 'would-run' } }; return { ok: true, line: `예행 런 ${v}-rehearsal 생성` }; },
    archiveRehearsal: (v) => { if (!state.rehearsal.exists) return null; archived.push(v); state.rehearsal = NONE; return `/tmp/release-graph/${v}-rehearsal#1`; },
    post: (key, to, body) => { if (mails.some(m => m.key === key)) return null; mails.push({ key, to, body }); return 700 + mails.length; },
  };
  return { yellow, state, mails, started, archived, deps, setNow: (d: Date) => { now = d; } };
}

function harness(seed: number, opts: { stuckCut?: boolean; rehearsalDone?: boolean; failStart?: boolean; llm?: VoiceLlm } = {}) {
  const root = mkdtempSync(join(tmpdir(), `rr-${seed}-`));
  const card = loadCard('release-rocket');
  const memory = fileAgentMemory(root, card.id, card.supervisor);
  const posts: Array<{ key: string; to: string; body: string }> = []; const spoken: string[] = [];
  const ports: AgentPorts = { memory, post(key, to, body) { if (posts.some(p => p.key === key)) return null; posts.push({ key, to, body }); return 900 + posts.length; },
    beat: () => {}, speak: l => { spoken.push(l); }, llm: opts.llm ?? null };
  const w = world(seed, opts);
  const body = createBody({ stateRoot: root, card }, w.deps);
  const tick = (d: Date) => { w.setNow(d); return tickAgent(card, body, ports, d); };
  return { root, card, memory, posts, spoken, ports, body, tick, ...w };
}

describe('release-rocket card', () => {
  test('card loads · address = id upper · knowhow parses', () => {
    const c = loadCard('release-rocket');
    expect(c).toMatchObject({ id: 'release-rocket', address: 'RELEASE-ROCKET', supervisor: 'OP', name: '발행 매니저', kpi: { name: 'late_milestones', dir: 'at_most', target: 0 } });
    expect(c.rights.actions).toEqual(['start-rehearsal', 'archive-rehearsal', 'propose-waiver']);
    const kh = readFileSync(resolve(import.meta.dir, '../../../graphs/loop-agents/release-rocket/knowhow.md'), 'utf8');
    expect(parseKnowhowItems(kh, 'RELEASE-ROCKET').length).toBeGreaterThanOrEqual(3);
  });
  test('milestones: grace · default clock judges only the rehearsal', () => {
    const v: ReleaseView = { version: '0.3.40', published: false, clock: CLOCK, clockSource: 'schedule', run: NONE, rehearsal: NONE, yellow: [] };
    expect(milestones(v, at(CLOCK.rehearsalAt, 10)).find(m => m.id === 'rehearsal')!.state).toBe('pending');
    expect(milestones(v, at(CLOCK.rehearsalAt, 16)).find(m => m.id === 'rehearsal')!.state).toBe('late');
    expect(milestones(v, at(CLOCK.cutAt, 16)).find(m => m.id === 'cut')!.why).toBe('발행 런 없음');
    expect(milestones({ ...v, clockSource: 'default' }, at(CLOCK.cutAt, 16)).map(m => m.id)).toEqual(['rehearsal']);
    const d = defaultClock(new Date(2026, 10, 27, 12, 0));
    expect(new Date(d.publishAt).getHours()).toBe(6); expect(new Date(d.cutAt).getHours()).toBe(4); expect(new Date(d.rehearsalAt).getHours()).toBe(22);
    expect(Date.parse(d.publishAt)).toBeGreaterThan(Date.parse(d.rehearsalAt));
  });
});

describe('release-rocket sim: clock → wake → rehearsal / waiver proposal → KPI', () => {
  for (const seed of [1, 6, 13]) {
    test(`seed ${seed}`, async () => {
      const h = harness(seed);
      const r1 = await h.tick(at(CLOCK.rehearsalAt, 20)); // 22:20 — rehearsal due, not started
      expect(r1.kpi).toBe(1); expect(r1.breach).toBe('new');
      expect(r1.acted).toEqual(['start-rehearsal:0.3.40']);
      expect(h.started).toEqual(['0.3.40']);
      const r2 = await h.tick(at(CLOCK.rehearsalAt, 30));
      expect(r2.kpi).toBe(0); expect(r2.breach).toBe('recovered');
      expect(h.memory.cases(100).some(c => c.kind === 'act' && (c.extra as { undo?: string } | undefined)?.undo?.startsWith('archiveRehearsal 0.3.40'))).toBe(true);
      // 04:30 — cut done by the release graph · publish in 90 min → one waiver proposal to OP (mail only)
      const r3 = await h.tick(at(CLOCK.cutAt, 30));
      expect(r3.kpi).toBe(0);
      expect(r3.acted).toEqual(['propose-waiver:0.3.40']);
      const prop = h.mails.filter(m => m.key.startsWith('release-waiver:'));
      expect(prop.length).toBe(1); expect(prop[0]!.to).toBe('OP');
      for (const c of h.yellow) expect(prop[0]!.body.includes(c.id)).toBe(!c.critical);
      const r4 = await h.tick(at(CLOCK.cutAt, 45));
      expect(r4.acted).toEqual([]); // cooldown 60 min · no second proposal
      expect(h.posts.filter(p => p.key.startsWith('kpi-breach')).length).toBe(0);
    });
  }
  test('a late cut the body cannot close → exactly one L0 card to OP', async () => {
    const h = harness(3, { stuckCut: true, rehearsalDone: true });
    for (let m = 20; m <= 80; m += 10) await h.tick(at(CLOCK.cutAt, m));
    const l0 = h.posts.filter(p => p.key.startsWith('kpi-breach'));
    expect(l0.length).toBe(1); expect(l0[0]!.to).toBe('OP');
    expect(h.memory.cases(200).filter(c => c.kind === 'act' && c.subject.startsWith('start-rehearsal')).length).toBe(0);
  });
});

function fakeLlm(): VoiceLlm {
  return {
    async complete(_system, user) {
      const said = user.slice(user.lastIndexOf('## 받은 말'));
      if (/예행 열어/u.test(said)) return { model: 'fake', text: JSON.stringify({ reply: '0.3.40 예행을 연다.', actions: [{ cmd: 'act', action: 'start-rehearsal', target: '0.3.40' }] }) };
      if (/발행해/u.test(said)) return { model: 'fake', text: JSON.stringify({ reply: '발행은 내 권한이 아니다.', actions: [{ cmd: 'publish', version: '0.3.40' }] }) };
      const kpi = /late_milestones (\d+)/u.exec(user)?.[1];
      const late = /0\.3\.40:(\w+)\(milestone-late/u.exec(user)?.[1];
      return { model: 'fake', text: JSON.stringify({ reply: `늦은 이정표 ${kpi ?? '?'} — ${late ?? '없음'} 이 막고 있다.`, actions: [] }) };
    },
  };
}
const msg = (id: number, from: string, body: string): VoiceMessage => ({ id, from, body, at: CLOCK.rehearsalAt, channel: 'els:ws:supervisors', thread: 'els:ws:supervisors' });

describe('release-rocket voice (fake LLM)', () => {
  test('answers from facts · opens the rehearsal inside rights · refuses publish and escalates to OP', async () => {
    const h = harness(8, { llm: fakeLlm() });
    const now = at(CLOCK.rehearsalAt, 20); h.setNow(now);
    const deps = { card: h.card, body: h.body, ports: h.ports, now };
    const r1 = await voiceAgent(deps, msg(1, 'OP', '뭐가 막고 있어? 왜 KPI 가 떨어졌어?'));
    expect(r1.folded).toBe(false);
    expect(r1.reply).toContain('늦은 이정표 1 — rehearsal');
    const r2 = await voiceAgent(deps, msg(2, 'OP', '예행 열어'));
    expect(r2.actions).toContain('act:start-rehearsal:0.3.40');
    expect(h.started).toEqual(['0.3.40']);
    const r3 = await voiceAgent(deps, msg(3, 'OPC', '지금 발행해'));
    expect(r3.escalated).toBe(true);
    expect(h.posts.some(p => p.to === 'OP' && p.key.startsWith('voice-esc:'))).toBe(true);
  });
});
