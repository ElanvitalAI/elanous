import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseKnowhowItems } from '../../seat-loop/seat-knowhow.js';
import { loadCard } from '../card.js';
import { addCandidate, decideLesson, fileAgentMemory } from '../memory.js';
import { loadBodyFactory } from '../registry.js';
import { tickAgent, voiceAgent, type AgentPorts, type VoiceLlm, type VoiceMessage } from '../runtime.js';
import type { Beat } from '../../kit/heartbeat/index.js';
import { createBody, restartArgv, watchRows, type WatchersCheckDeps } from './watchers-check.js';

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
  const fired: string[][] = [];
  const deps: WatchersCheckDeps = {
    beats: () => beats.slice(),
    sourceHead: () => null,
    cardIds: () => ids.slice(),
    triggerIds: () => new Set(['res-patrol']),
    fire: (argv) => {
      fired.push([...argv]);
      if (!opts.stubborn) {
        const name = argv[1] === 'agent' ? `loop:${argv[2]}` : argv[4] ?? 'trigger-tick';
        alive.add(name); beats.push(beat(name, clock, name === 'res-patrol' ? 5 : 10));
      }
      return { ok: true, line: `fired eln ${argv.join(' ')}` };
    },
  };
  const advance = (t: number) => { clock = t; for (const name of alive) beats.push(beat(name, t, name.startsWith('loop:') ? 10 : name === 'res-patrol' ? 5 : 2)); };
  const bad = [...kind.values()].filter(k => k !== 'ok').length + 1; // + res-patrol DEAD
  return { ids, kind, deps, fired, advance, bad };
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
  test('rows: expected missing · recent bad · stale retired ignored · self excluded', () => {
    const now = T0.getTime();
    const rows = watchRows([
      { name: 'loop:a', status: 'DEAD', ageMin: 40, everyMin: 10, sawLastWindow: 0, last: null, lastError: null, source: null, sourceHead: null, reason: 'x' },
      { name: 'x-old', status: 'DEAD', ageMin: 4000, everyMin: 5, sawLastWindow: 0, last: null, lastError: null, source: null, sourceHead: null, reason: 'x' },
      { name: 'loop:watchers-check', status: 'DEAD', ageMin: 40, everyMin: 5, sawLastWindow: 0, last: null, lastError: null, source: null, sourceHead: null, reason: 'x' },
    ], ['loop:a', 'loop:b', 'loop:watchers-check']);
    expect(rows.map(r => `${r.name}:${r.status}`)).toEqual(['loop:a:DEAD', 'loop:b:MISSING']);
    expect(now).toBeGreaterThan(0);
    expect(restartArgv('loop:a', new Set(['a']), null)).toEqual(['loop', 'agent', 'a', 'tick']);
    expect(restartArgv('loop:zzz', new Set(['a']), null)).toBeNull();
    expect(restartArgv('res-patrol', new Set(), new Set(['res-patrol']))).toEqual(['loop', 'trigger', 'tick', '--only', 'res-patrol']);
    expect(restartArgv('unknown', new Set(), new Set())).toBeNull();
  });
});

describe('watchers-check sim: dead/missing supervisors → restart → KPI (seeds)', () => {
  for (const seed of [1, 7, 42]) {
    test(`seed ${seed}`, async () => {
      const h = harness(seed);
      const r1 = await tickAgent(h.card, h.body, h.ports, T0);
      expect(r1.kpi).toBe(h.bad);
      expect(r1.kpiOk).toBe(false);
      expect(r1.acted.length).toBe(Math.min(5, h.bad));
      expect(h.fired.some(a => a.join(' ') === `loop agent sup-${seed}-1 tick`)).toBe(true); // never-beat card is seen and woken
      let t = T0.getTime(); let r = r1;
      for (let i = 0; i < 3; i++) { t += 5 * M; h.advance(t); r = await tickAgent(h.card, h.body, h.ports, new Date(t)); }
      expect(r.kpi).toBe(0); expect(r.kpiOk).toBe(true);
      expect(h.fired.length).toBe(h.bad); // each one woken exactly once
      expect(h.posts.filter(p => p.key.startsWith('kpi-breach')).length).toBe(0);
    });
  }
  test('a supervisor that does not come back is carded to OP once', async () => {
    const h = harness(5, { stubborn: true });
    let t = T0.getTime();
    for (let i = 0; i < 12; i++) { h.advance(t); await tickAgent(h.card, h.body, h.ports, new Date(t)); t += 5 * M; }
    const l0 = h.posts.filter(p => p.key.startsWith('kpi-breach'));
    expect(l0.length).toBe(1); expect(l0[0]!.to).toBe('OP');
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

describe('registered watchers-check memory integration', () => {
  test('supervisor-verified lesson holds a restart on the next tick and persistent failures reach OP', async () => {
    const h = harness(5, { stubborn: true });
    const factory = await loadBodyFactory('watchers-check') as typeof createBody;
    const body = factory({ stateRoot: h.root, card: h.card }, h.deps);
    h.deps.fire = argv => { h.fired.push([...argv]); return { ok: false, line: 'synthetic restart failure' }; };
    const target = `loop:${h.ids[0]}`;
    const first = await tickAgent(h.card, body, h.ports, T0);
    expect(first.failed).toContain(`restart:${target}`);
    const lesson = addCandidate(h.memory, 'synthetic-failure', `watchers-check:hold-restart:${target}`, T0);
    expect(lesson).not.toBeNull();
    expect(decideLesson(h.memory, lesson!.id, true, h.card.supervisor, T0)?.status).toBe('active');
    const before = h.fired.length;
    const next = new Date(T0.getTime() + (h.card.escalateAfterMin + 1) * M);
    h.advance(next.getTime());
    // A fresh runtime and file-memory instance model the next independent invocation.
    const reopenedMemory = fileAgentMemory(h.root, h.card.id, h.card.supervisor);
    const reopenedBody = factory({ stateRoot: h.root, card: h.card }, h.deps);
    const second = await tickAgent(h.card, reopenedBody, { ...h.ports, memory: reopenedMemory }, next);
    expect(reopenedMemory.lessons().find(l => l.id === lesson!.id)?.status).toBe('active');
    expect(h.fired.slice(before).some(a => a[2] === h.ids[0])).toBe(false);
    expect(second.failed.length).toBeGreaterThan(0);
    expect(second.escalated).toBe(true);
    expect(h.posts.some(p => p.key.startsWith('kpi-breach:') && p.to === h.card.supervisor)).toBe(true);
    const holdCase = reopenedMemory.cases(100).find(c => c.kind === 'lesson-hold' && c.subject === target);
    expect(holdCase).toMatchObject({
      decidedBy: h.card.address, supervisedBy: h.card.supervisor, extra: { lesson: lesson!.id },
    });
    console.log('SYNTHETIC_MEMORY_EVIDENCE', JSON.stringify({ target, firstFailed: first.failed,
      storedLesson: reopenedMemory.lessons().find(l => l.id === lesson!.id),
      secondFired: h.fired.slice(before), secondFailed: second.failed, escalated: second.escalated,
      holdCase, handoff: h.posts.filter(p => p.key.startsWith('kpi-breach:')) }));
  });
});

describe('watchers-check voice (fake LLM)', () => {
  test('answers from facts · restart inside rights · kill refused and escalated to OP', async () => {
    const h = harness(21, { llm: fakeLlm() });
    const deps = { card: h.card, body: h.body, ports: h.ports, now: T0 };
    const r1 = await voiceAgent(deps, msg(1, 'CLAUDE-OP', '왜 KPI 가 나빠? 지금 뭐 해? 뭐가 막아?'));
    expect(r1.folded).toBe(false);
    expect(r1.reply).toMatch(/결손 \d+ — loop:sup-21-\d+/u);
    const r2 = await voiceAgent(deps, msg(2, 'CLAUDE-OP', '죽은 거 하나 깨워'));
    expect(r2.actions.some(a => a.startsWith('act:restart:loop:sup-21-'))).toBe(true);
    expect(h.fired.length).toBe(1);
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
