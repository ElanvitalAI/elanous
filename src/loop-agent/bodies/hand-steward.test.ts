import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseKnowhowItems } from '../../seat-loop/seat-knowhow.js';
import { loadCard } from '../card.js';
import { fileAgentMemory } from '../memory.js';
import { tickAgent, voiceAgent, type AgentPorts, type VoiceLlm, type VoiceMessage } from '../runtime.js';
import { createBody, pairs, parseTarget, target, type Cell, type Hand, type HandStewardDeps, type Hint } from './hand-steward.js';

function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const T0 = new Date('2026-11-27T10:00:00Z');

// Seeded federation: idle / working / judge hands · ready / blocked / umbrella / owned cells. step() = every hinted hand
// claims its cell on `eln work next` (owner set, hand working, hint gone).
function world(seed: number, opts: { brokenHint?: boolean } = {}) {
  const r = rng(seed);
  const hands: Array<{ seat: string; state: Hand['state']; since?: number; judge?: boolean; cell?: string }> = [];
  const nIdle = 2 + Math.floor(r() * 3);
  for (let i = 0; i < nIdle; i++) hands.push({ seat: `UX-H${seed}${i}`, state: 'idle', since: T0.getTime() - (10 + Math.floor(r() * 50)) * 60_000 });
  hands.push({ seat: 'JUD-B', state: 'idle', since: T0.getTime() - 90 * 60_000, judge: true });
  hands.push({ seat: `TC-H${seed}`, state: 'working', cell: 'BUSY-1' });
  const cells: Array<Cell & { owner?: string }> = [];
  const nReady = 1 + Math.floor(r() * 4);
  for (let i = 0; i < nReady; i++) cells.push({ id: `RDY-${seed}-${i}`, title: `ready ${i}`, status: 'yellow', priority: r() < 0.4 ? 'P0' : 'P1', paths: i % 2 ? ['src/els/server.ts'] : ['docs/x.md'] });
  cells.push({ id: 'PRE-OPEN', title: 'pred', status: 'yellow', owner: 'TC-H9', paths: [] });
  cells.push({ id: `BLOCKED-${seed}`, title: 'blocked', status: 'yellow', predecessors: ['PRE-OPEN'], paths: [] });
  cells.push({ id: `UMB-${seed}`, title: 'umbrella', status: 'yellow', dispatchKind: 'umbrella', paths: [] });
  cells.push({ id: 'BUSY-1', title: 'busy', status: 'yellow', owner: `TC-H${seed}`, paths: [] });
  const hints: Record<string, Hint> = {};
  const mails: Array<{ key: string; to: string; body: string }> = []; const models: string[] = [];
  const deps: HandStewardDeps = {
    readHands: () => hands.map(h => ({ ...h })),
    readCells: () => ({ version: '0.3.40', cells: cells.map(c => ({ ...c })) }),
    readHints: () => ({ ...hints }),
    hint: (cell, seat) => { if (opts.brokenHint) throw new Error('EACCES priority-order.json'); hints[cell] = { seat, until: new Date(T0.getTime() + 45 * 60_000).toISOString() }; },
    unhint: cell => { if (!hints[cell]) return false; delete hints[cell]; return true; },
    modelFor: (seat, cell) => { const tier = cell.paths.some(p => p.includes('els/server')) ? 'hard' : 'easy'; models.push(`${seat}:${cell.id}:${tier}`); return { line: `model: ${tier}`, tier }; },
    post: (key, to, body) => { if (mails.some(m => m.key === key)) return null; mails.push({ key, to, body }); return 600 + mails.length; },
    wake: () => 'wake typed',
  };
  const step = () => {
    for (const [cell, h] of Object.entries(hints)) {
      const hand = hands.find(x => x.seat === h.seat)!; const c = cells.find(x => x.id === cell)!;
      c.owner = h.seat; hand.state = 'working'; hand.cell = cell; delete hints[cell];
    }
  };
  return { hands, cells, hints, mails, models, deps, step, nIdle, nReady };
}

function harness(seed: number, opts: { brokenHint?: boolean; llm?: VoiceLlm } = {}) {
  const root = mkdtempSync(join(tmpdir(), `hs-${seed}-`));
  const card = loadCard('hand-steward');
  const memory = fileAgentMemory(root, card.id, card.supervisor);
  const posts: Array<{ key: string; to: string; body: string }> = []; const spoken: string[] = [];
  const ports: AgentPorts = { memory, post(key, to, body) { if (posts.some(p => p.key === key)) return null; posts.push({ key, to, body }); return 900 + posts.length; },
    beat: () => {}, speak: l => { spoken.push(l); }, llm: opts.llm ?? null };
  const w = world(seed, opts);
  const body = createBody({ stateRoot: root, card }, w.deps);
  return { root, card, memory, posts, spoken, ports, body, ...w };
}

describe('hand-steward card', () => {
  test('card loads · address = id upper · knowhow parses', () => {
    const c = loadCard('hand-steward');
    expect(c).toMatchObject({ id: 'hand-steward', address: 'HAND-STEWARD', supervisor: 'OP', name: '행정관', kpi: { name: 'idle_hands_with_ready_cells', dir: 'at_most', target: 0 } });
    expect(c.rights.actions).toEqual(['assign', 'unassign']);
    const kh = readFileSync(resolve(import.meta.dir, '../../../graphs/loop-agents/hand-steward/knowhow.md'), 'utf8');
    expect(parseKnowhowItems(kh, 'HAND-STEWARD').length).toBeGreaterThanOrEqual(3);
  });
  test('pairs: longest idle first · P0 first · never judge / umbrella / blocked / owned', () => {
    const hands: Hand[] = [{ seat: 'A', state: 'idle', since: 2 }, { seat: 'B', state: 'idle', since: 1 }, { seat: 'J', state: 'idle', since: 0, judge: true }];
    const cells: Cell[] = [{ id: 'X1', title: '', status: 'yellow', priority: 'P1', paths: [] }, { id: 'X0', title: '', status: 'yellow', priority: 'P0', paths: [] },
      { id: 'U', title: '', status: 'yellow', dispatchKind: 'umbrella', paths: [] }, { id: 'B', title: '', status: 'yellow', predecessors: ['Z'], paths: [] }];
    expect(pairs(hands, cells, {}).map(p => target(p.cell.id, p.hand.seat))).toEqual(['X0@B', 'X1@A']);
    expect(pairs(hands, cells, { X0: { seat: 'B', until: 'x' } }).map(p => target(p.cell.id, p.hand.seat))).toEqual(['X1@A']);
    expect(parseTarget('RDY-1@ux-h1')).toEqual({ cell: 'RDY-1', seat: 'UX-H1' });
  });
});

describe('hand-steward sim: idle hand → wake → pull hint → KPI', () => {
  for (const seed of [1, 5, 11]) {
    test(`seed ${seed}`, async () => {
      const h = harness(seed);
      const want = Math.min(h.nIdle, h.nReady);
      const r1 = await tickAgent(h.card, h.body, h.ports, T0);
      expect(r1.kpi).toBe(want); expect(r1.breach).toBe('new');
      expect(r1.acted.length).toBe(Math.min(3, want));
      expect(h.mails.every(m => /`eln work next`/u.test(m.body) && /model: (hard|easy)/u.test(m.body))).toBe(true);
      expect(h.models.length).toBe(r1.acted.length);
      // hinted hands are in progress: KPI already counts only unhinted pairs
      let t = T0.getTime(); let r = r1;
      for (let i = 0; i < 4 && (r.kpiOk !== true || i === 0); i++) { h.step(); t += 10 * 60_000; r = await tickAgent(h.card, h.body, h.ports, new Date(t)); }
      expect(r.kpi).toBe(0); expect(r.kpiOk).toBe(true);
      expect(h.spoken.some(l => l.startsWith('✅'))).toBe(true);
      expect(h.cells.filter(c => c.owner && c.id.startsWith('RDY-')).length).toBe(want);
      expect(h.cells.find(c => c.id.startsWith('UMB-'))!.owner).toBeUndefined();
      expect(h.cells.find(c => c.id.startsWith('BLOCKED-'))!.owner).toBeUndefined();
      expect(h.hands.find(x => x.seat === 'JUD-B')!.state).toBe('idle');
      const acts = h.memory.cases(200).filter(c => c.kind === 'act');
      expect(acts.every(c => (c.extra as { undo?: string } | undefined)?.undo?.startsWith('unassign '))).toBe(true);
      expect(h.posts.filter(p => p.key.startsWith('kpi-breach')).length).toBe(0);
    });
  }
  test('a hint the body cannot write → idle hands stay → exactly one L0 card to OP', async () => {
    const h = harness(4, { brokenHint: true });
    let t = T0.getTime();
    for (let i = 0; i < 6; i++) { await tickAgent(h.card, h.body, h.ports, new Date(t)); h.step(); t += 20 * 60_000; }
    const l0 = h.posts.filter(p => p.key.startsWith('kpi-breach'));
    expect(l0.length).toBe(1); expect(l0[0]!.to).toBe('OP');
    expect(h.memory.cases(200).some(c => c.kind === 'act-failed')).toBe(true);
  });
});

function fakeLlm(): VoiceLlm {
  return {
    async complete(_system, user) {
      const said = user.slice(user.lastIndexOf('## 받은 말'));
      const t = /\b([A-Z]+-\d+-\d+@[A-Z]+-H\d+)\b/u.exec(said)?.[1];
      if (/걸어/u.test(said) && t) return { model: 'fake', text: JSON.stringify({ reply: `${t} 를 건다.`, actions: [{ cmd: 'act', action: 'assign', target: t }] }) };
      if (/쪼개/u.test(said)) return { model: 'fake', text: JSON.stringify({ reply: '쪼개기는 OP 몫이다.', actions: [{ cmd: 'split', cell: 'RDY-1-0' }] }) };
      const kpi = /idle_hands_with_ready_cells (\d+)/u.exec(user)?.[1];
      const idle = /놀고 있는 손 (\d+)/u.exec(user)?.[1];
      return { model: 'fake', text: JSON.stringify({ reply: `짝 안 지은 손 ${kpi ?? '?'} · 놀고 있는 손 ${idle ?? '?'} — 힌트를 걸고 있다.`, actions: [] }) };
    },
  };
}
const msg = (id: number, from: string, body: string): VoiceMessage => ({ id, from, body, at: T0.toISOString(), channel: 'els:ws:supervisors', thread: 'els:ws:supervisors' });

describe('hand-steward voice (fake LLM)', () => {
  test('answers from facts · assigns inside rights · refuses a split and escalates to OP', async () => {
    const h = harness(2, { llm: fakeLlm() });
    const deps = { card: h.card, body: h.body, ports: h.ports, now: T0 };
    const r1 = await voiceAgent(deps, msg(1, 'OP', '지금 뭐 하고 있어? 왜 KPI 가 안 좋아?'));
    expect(r1.folded).toBe(false);
    expect(r1.reply).toMatch(/짝 안 지은 손 \d+ · 놀고 있는 손 \d+/u);
    const hand = h.hands.find(x => x.state === 'idle' && !x.judge)!; const cell = h.cells.find(c => c.id.startsWith('RDY-'))!;
    const t = target(cell.id, hand.seat);
    const r2 = await voiceAgent(deps, msg(2, 'OP', `${t} 걸어`));
    expect(r2.actions).toContain(`act:assign:${t}`.replace(/[^A-Za-z0-9._:=-]/gu, '_'));
    expect(h.hints[cell.id]?.seat).toBe(hand.seat);
    const r3 = await voiceAgent(deps, msg(3, 'OPC', 'RDY 칸 쪼개줘'));
    expect(r3.escalated).toBe(true);
    expect(h.posts.some(p => p.to === 'OP' && p.key.startsWith('voice-esc:'))).toBe(true);
  });
});
