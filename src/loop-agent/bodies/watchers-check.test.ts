import { describe, expect, test } from 'bun:test';
import { withPolicies } from '../policy-context.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseKnowhowItems } from '../../seat-loop/seat-knowhow.js';
import { loadCard } from '../card.js';
import { fileAgentMemory } from '../memory.js';
import { tickAgent, voiceAgent, type AgentPorts, type VoiceLlm, type VoiceMessage } from '../runtime.js';
import type { Beat } from '../../kit/heartbeat/index.js';
import { createBody, watchRows, type WatchersCheckDeps } from './watchers-check.js';

const T0 = new Date('2026-11-27T10:00:00Z');
const M = 60_000;
function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const beat = (name: string, at: number, everyMin = 10, err?: string): Beat => ({ name, at: new Date(at).toISOString(), saw: 1, everyMin, ...(err ? { err } : {}) });

// Seeded federation: N v2 cards — healthy · dead · never beat; core watchers; one stale retired watcher.
function world(seed: number, opts: { stubborn?: boolean } = {}) {
  const r = rng(seed);
  const n = 3 + Math.floor(r() * 4);
  const ids = Array.from({ length: n }, (_, i) => `sup-${seed}-${i}`);
  const kind = new Map<string, 'ok' | 'dead' | 'missing'>();
  ids.forEach((id, i) => kind.set(id, i === 0 ? 'dead' : i === 1 ? 'missing' : r() < 0.4 ? 'dead' : 'ok'));
  let clock = T0.getTime();
  const beats: Beat[] = [];
  const alive = new Set<string>(['trigger-tick', 'release-graph-tick']);
  for (const [id, k] of kind) {
    if (k === 'ok') { beats.push(beat(`loop:${id}`, clock - M)); alive.add(`loop:${id}`); }
    if (k === 'dead') beats.push(beat(`loop:${id}`, clock - 90 * M));
  }
  beats.push(beat('trigger-tick', clock - M, 2), beat('release-graph-tick', clock - M, 2), beat('res-patrol', clock - 60 * M, 5));
  beats.push(beat('old-retired-watcher', clock - 3 * 24 * 60 * M, 5));
  const deps: WatchersCheckDeps = {
    beats: () => beats.slice(),
    sourceHead: () => null,
    cardIds: () => ids.slice(),
    // the registered agents (registry refires them) · sup-<seed>-1 is a card whose trigger was never registered
    triggerIds: () => new Set(ids.filter((_, i) => i !== 1).map(id => `${id}-agent`)),
  };
  // the trigger registry (not this agent) brings a dead registered agent back: it beats again unless stubborn
  const registryRefires = (t: number) => { if (!opts.stubborn) for (const [id, k] of kind) if (k === 'dead') { alive.add(`loop:${id}`); beats.push(beat(`loop:${id}`, t)); } };
  const advance = (t: number) => { clock = t; for (const name of alive) beats.push(beat(name, t, name.startsWith('loop:') ? 10 : name === 'res-patrol' ? 5 : 2)); };
  const bad = [...kind.values()].filter(k => k !== 'ok').length + 1; // + res-patrol DEAD
  return { ids, kind, deps, advance, registryRefires, bad };
}

function harness(seed: number, opts: { stubborn?: boolean; llm?: VoiceLlm } = {}) {
  const root = mkdtempSync(join(tmpdir(), `wc-${seed}-`));
  const card = loadCard('watchers-check');
  const memory = fileAgentMemory(root, card.id, card.supervisor);
  const posts: Array<{ key: string; to: string; body: string }> = [];
  const ports: AgentPorts = {
    memory, post(key, to, body) { if (posts.some(p => p.key === key)) return null; posts.push({ key, to, body }); return 700 + posts.length; },
    beat: () => {}, speak: () => {}, llm: opts.llm ?? null,
  };
  const w = world(seed, opts);
  return { root, card, memory, posts, ports, body: createBody({ stateRoot: root, card }, w.deps), ...w };
}

describe('watchers-check: pure', () => {
  test('rows: expected missing · recent bad · stale retired ignored · self excluded', () => withPolicies(loadCard('watchers-check').policies, async () => {
    const now = T0.getTime();
    const rows = watchRows([
      { name: 'loop:a', status: 'DEAD', ageMin: 40, everyMin: 10, sawLastWindow: 0, last: null, lastError: null, source: null, sourceHead: null, reason: 'x' },
      { name: 'x-old', status: 'DEAD', ageMin: 4000, everyMin: 5, sawLastWindow: 0, last: null, lastError: null, source: null, sourceHead: null, reason: 'x' },
      { name: 'loop:watchers-check', status: 'DEAD', ageMin: 40, everyMin: 5, sawLastWindow: 0, last: null, lastError: null, source: null, sourceHead: null, reason: 'x' },
    ], ['loop:a', 'loop:b', 'loop:watchers-check']);
    expect(rows.map(r => `${r.name}:${r.status}`)).toEqual(['loop:a:DEAD', 'loop:b:MISSING']);
    expect(now).toBeGreaterThan(0);
  }));
});

describe('watchers-check sim: a KPI roll-up — the registry refires, this agent wakes nobody (LOOP-AGENTS-AS-PLUGINS P1 · seeds)', () => {
  for (const seed of [1, 7, 42]) {
    test(`seed ${seed}`, async () => {
      const h = harness(seed);
      const r1 = await tickAgent(h.card, h.body, h.ports, T0);
      expect(r1.kpi).toBe(h.bad);
      expect(r1.kpiOk).toBe(false);
      expect(r1.acted).toEqual([]);
      expect(r1.failed).toEqual([]);
      let t = T0.getTime(); let r = r1;
      for (let i = 0; i < 3; i++) { t += 5 * M; h.registryRefires(t); h.advance(t); r = await tickAgent(h.card, h.body, h.ports, new Date(t)); }
      // the never-registered card and res-patrol (crontab · not a registry trigger) stay — the roll-up names who owns them
      expect(r.kpi).toBe(2); expect(r.acted).toEqual([]);
    });
  }
  test('subjects say who owns each gap now — registry · unregistered · outside clock · owner', () => withPolicies(loadCard('watchers-check').policies, async () => {
    const h = harness(1);
    const beats = h.deps.beats()!.filter(b => b.name !== 'trigger-tick');
    h.deps.beats = () => [...beats, { name: 'trigger-tick', at: new Date(T0.getTime() - 30 * M).toISOString(), saw: 1, everyMin: 2 }];
    const obs = h.body.observe({ now: T0 } as Parameters<typeof h.body.observe>[0]);
    const by = Object.fromEntries((await obs).subjects.map(s => [s.id, s.summary.split(' · ').at(-1)]));
    expect(by['loop:sup-1-0']).toBe('레지스트리가 다시 쏘고 주인 카드');
    expect(by['loop:sup-1-1']).toBe('레지스트리 미등록 — 주인이 등록할 것');
    expect(by['trigger-tick']).toBe('바깥 시계(nexus trigger-clock)가 깨움');
    expect(by['res-patrol']).toBe('크론 감시자 — 주인이 볼 것');
  }));
  test('a gap that stays is carded to OP once (the runtime KPI ladder)', async () => {
    const h = harness(5, { stubborn: true });
    let t = T0.getTime();
    for (let i = 0; i < 12; i++) { h.advance(t); await tickAgent(h.card, h.body, h.ports, new Date(t)); t += 5 * M; }
    const l0 = h.posts.filter(p => p.key.startsWith('kpi-breach'));
    expect(l0.length).toBe(1); expect(l0[0]!.to).toBe('OP');
  });
  test('an absorbed (retired) trigger\'s last beat is history: no subject (LOOP-AGENTS-AS-PLUGINS)', async () => {
    const h = harness(11);
    const base = (await tickAgent(h.card, h.body, h.ports, T0)).kpi;
    const h2 = harness(11);
    const beats = h2.deps.beats()!;
    h2.deps.beats = () => [...beats, { name: 'watchers-check', at: new Date(T0.getTime() - 60 * M).toISOString(), saw: 3, everyMin: 5 }];
    const withStale = (await tickAgent(h2.card, h2.body, h2.ports, T0)).kpi;
    expect(withStale).toBe((base ?? 0) + 1);
    const h3 = harness(11);
    h3.deps.beats = h2.deps.beats; h3.deps.retiredIds = () => new Set(['watchers-check']);
    const r3 = await tickAgent(h3.card, h3.body, h3.ports, T0);
    expect(r3.kpi).toBe(base);
  });
  test('unreadable ledger = unknown, not 0', async () => {
    const h = harness(3);
    h.deps.beats = () => null;
    const r = await tickAgent(h.card, h.body, h.ports, T0);
    expect(r.kpi).toBeNull(); expect(r.acted).toEqual([]);
  });
});

function fakeLlm(): VoiceLlm {
  return {
    async complete(_system, user) {
      const said = user.slice(user.lastIndexOf('## 받은 말'));
      const dead = /(loop:sup-\d+-\d+)\(watcher-(?:dead|missing)/u.exec(user)?.[1];
      if (/깨워/u.test(said) && dead) return { model: 'fake', text: JSON.stringify({ reply: `${dead} 를 깨운다.`, actions: [{ cmd: 'act', action: 'restart', target: dead }] }) };
      if (/kill/u.test(said)) return { model: 'fake', text: JSON.stringify({ reply: 'kill 은 내 권한 밖이다.', actions: [{ cmd: 'act', action: 'kill', target: 'res-patrol' }, { cmd: 'escalate', why: 'kill 요청 — 권한 밖' }] }) };
      const kpi = /missing_heartbeats (\d+)/u.exec(user)?.[1];
      return { model: 'fake', text: JSON.stringify({ reply: `결손 ${kpi ?? '?'} — ${dead ?? '-'} 등. 죽은 감독자를 깨우는 중이다.`, actions: [] }) };
    },
  };
}
const msg = (id: number, from: string, body: string): VoiceMessage => ({ id, from, body, at: T0.toISOString(), channel: 'mail', thread: 'mail' });

describe('watchers-check voice (fake LLM)', () => {
  test('answers from facts · a restart is no longer its right (refused) · kill refused and escalated to OP', async () => {
    const h = harness(21, { llm: fakeLlm() });
    const deps = { card: h.card, body: h.body, ports: h.ports, now: T0 };
    const r1 = await voiceAgent(deps, msg(1, 'CLAUDE-OP', '왜 KPI 가 나빠? 지금 뭐 해? 뭐가 막아?'));
    expect(r1.folded).toBe(false);
    expect(r1.reply).toMatch(/결손 \d+ — loop:sup-21-\d+/u);
    const r2 = await voiceAgent(deps, msg(2, 'CLAUDE-OP', '죽은 거 하나 깨워'));
    expect(r2.actions.some(a => a.startsWith('act-refused:restart:loop:sup-21-'))).toBe(true);
    const r3 = await voiceAgent(deps, msg(3, 'OPC', 'res-patrol kill 해'));
    expect(r3.actions).toContain('act-refused:kill:res-patrol');
    expect(r3.escalated).toBe(true);
    expect(h.posts.some(p => p.to === 'OP' && p.key.startsWith('voice-esc:'))).toBe(true);
  });
});

describe('watchers-check card', () => {
  test('card loads · knowhow parses ≥3', () => {
    const c = loadCard('watchers-check');
    expect(c).toMatchObject({ id: 'watchers-check', address: 'WATCHERS-CHECK', supervisor: 'OP', kpi: { name: 'missing_heartbeats', target: 0, dir: 'at_most' } });
    const kh = readFileSync(resolve(import.meta.dir, '../../../graphs/loop-agents/watchers-check/knowhow.md'), 'utf8');
    expect(parseKnowhowItems(kh, 'WATCHERS-CHECK').length).toBeGreaterThanOrEqual(3);
  });
});
