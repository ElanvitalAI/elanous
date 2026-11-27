// SUPERVISOR-CORRECTION-JOURNAL sim (seeds 1–5): ticks with synthetic events → journal lines match acted/failed exactly ·
// rollup counts · no line when nothing happened · the voice answers «오늘 뭘 했어» from the journal with the LLM up and down.
// Expected values come from the seeded world (which subject succeeds / fails), never from the journal code.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCard } from './card.js';
import { fileAgentMemory } from './memory.js';
import { tickAgent, voiceAgent, type AgentBody, type AgentPorts, type VoiceLlm, type VoiceMessage } from './runtime.js';
import { backfillTodayFromCases, emitWindowRollups, journalKpi, journalRowsFromCase, parseJournalPolicy, readJournal, readJournalPolicy, summarize, type JournalRow } from './journal.js';
import { resetExhaustedVoiceProviders, roleLlm, type RoleLlmDeps } from './role-llm.js';
import { fileMemory } from '../judge-butler/memory.js';
import { opDigestFolds, renderOpDigest } from '../msg/op-machine-digest.js';

const CARD_YAML = `runtime: v2
id: toy-sweeper
address: TOY-SWEEPER
supervisor: OP
soul: { name: 장난감 청소부, role: 남은 찌꺼기를 치운다, temperament: 짧게, values: [증거 먼저] }
subject: toy leftovers
goal: 찌꺼기 0
kpi: { name: leftovers, at_most: 0 }
done_when: [leftovers == 0 for one tick]
rights: { actions: [reap], never_auto: [kill by pattern], max_per_tick: 20, cooldown_min: 30 }
wake: { events: [leftover-seen], max_wait_min: 10 }
escalate_after_min: 600
`;

function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

/** Seeded world: synthetic events arrive in batches; each leftover either goes (ok) or resists (fail) — decided here. */
function world(seed: number) {
  const r = rng(seed * 7 + 3);
  const live = new Map<string, { resists: boolean }>();
  const attempted = new Set<string>();
  const expect = { acted: [] as string[], failed: [] as string[] };
  const inject = (batch: number): void => {
    const n = 2 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      const id = `lo-${seed}-${batch}-${i}`;
      const resists = r() < 0.35;
      live.set(id, { resists });
      (resists ? expect.failed : expect.acted).push(`reap:${id}`);
    }
  };
  const body: AgentBody = {
    observe: () => {
      const open = [...live].filter(([id]) => !attempted.has(id));
      return { kpi: open.length, subjects: open.map(([id]) => ({ id, kind: 'leftover', summary: `stale ${id}` })), facts: [`leftovers ${open.length}`] };
    },
    plan: obs => obs.subjects.map(s => ({ action: 'reap', target: s.id, why: 'stale leftover' })),
    actions: {
      reap: { describe: '찌꺼기 하나를 정확 id 로 치운다', run: (target) => {
        attempted.add(target);
        const lo = live.get(target);
        if (!lo) return { ok: false, line: `${target} 없음` };
        if (lo.resists) return { ok: false, line: `${target} 안 치워짐` };
        live.delete(target);
        return { ok: true, line: `${target} 치움`, ref: `lo:${target}`, undo: `restore ${target}`, before: 'present', after: 'gone' };
      } },
    },
  };
  return { body, inject, expect };
}

function harness(seed: number, llm: VoiceLlm | null) {
  const root = mkdtempSync(join(tmpdir(), `journal-${seed}-`));
  const card = parseCard(CARD_YAML, '장난감 청소부 — 시험용 영혼.');
  const memory = fileAgentMemory(root, card.id, card.supervisor);
  const rolled: Array<{ key: string; line: string }> = [];
  const ports: AgentPorts = { memory, post: () => 1, beat: () => undefined, speak: () => undefined, llm, rollup: (key, line) => { rolled.push({ key, line }); } };
  return { root, card, memory, ports, rolled, ...world(seed) };
}

const journalRows = (home: string): JournalRow[] => {
  const dir = join(home, 'journal');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.jsonl')).flatMap(f => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as JournalRow));
};
const msg = (id: number, body: string): VoiceMessage => ({ id, from: 'CEO', body, at: '2026-11-27T03:45:00Z', channel: 'els:cli', thread: 'els:cli' });

// 12:05 KST (03:05Z) — the 03:00–03:30Z window; 03:31Z starts the next one.
const T0 = Date.parse('2026-11-27T03:05:00Z');
const MIN = 60_000; // 출처: SUPERVISOR-CORRECTION-JOURNAL — one minute in ms (scenario clock unit, not a bound)

describe('SUPERVISOR-CORRECTION-JOURNAL sim (seeds 1–5)', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: journal = acted/failed exactly · rollup counts · quiet = no line · voice grounded (LLM up/down)`, async () => {
      const h = harness(seed, null);
      const home = h.memory.root;
      // quiet tick before any event: nothing happened → no journal at all
      const r0 = await tickAgent(h.card, h.body, h.ports, new Date(T0 - 2 * MIN));
      expect(r0.acted).toEqual([]);
      expect(existsSync(join(home, 'journal'))).toBe(false);
      // two batches of synthetic events in the 03:00–03:30Z window
      h.inject(1);
      const r1 = await tickAgent(h.card, h.body, h.ports, new Date(T0));
      h.inject(2);
      const r2 = await tickAgent(h.card, h.body, h.ports, new Date(T0 + 10 * MIN));
      const acted = [...r1.acted, ...r2.acted]; const failed = [...r1.failed, ...r2.failed];
      expect(acted.sort()).toEqual([...h.expect.acted].sort());
      expect(failed.sort()).toEqual([...h.expect.failed].sort());
      const rows = journalRows(home);
      expect(rows.filter(r => r.status === 'acted').map(r => `${r.action}:${r.target}`).sort()).toEqual([...h.expect.acted].sort());
      expect(rows.filter(r => r.status === 'failed').map(r => `${r.action}:${r.target}`).sort()).toEqual([...h.expect.failed].sort());
      expect(rows.filter(r => r.status === 'refused')).toEqual([]);
      for (const r of rows.filter(x => x.status === 'acted')) { expect(r.undo).toBe(`restore ${r.target}`); expect([r.before, r.after]).toEqual(['present', 'gone']); expect(r.evidence).toContain(`lo:${r.target}`); }
      for (const r of rows.filter(x => x.status === 'failed')) { expect(r.what).toBe(`${r.target} 안 치워짐`); expect(r.why).toBe('stale leftover'); }
      expect(h.rolled).toEqual([]); // the window has not ended yet
      // a quiet tick in the next window: the ended window is rolled up once with the literal counts
      const before = rows.length;
      await tickAgent(h.card, h.body, h.ports, new Date(T0 + 26 * MIN));
      expect(journalRows(home)).toHaveLength(before); // nothing happened → no line
      expect(h.rolled).toHaveLength(1);
      expect(h.rolled[0]!.key).toBe('journal-rollup:toy-sweeper:2026-11-27T03:00:00.000Z');
      expect(h.rolled[0]!.line).toContain(`행동 ${h.expect.acted.length} · 실패 ${h.expect.failed.length} · 거절 0`);
      await tickAgent(h.card, h.body, h.ports, new Date(T0 + 40 * MIN));
      await tickAgent(h.card, h.body, h.ports, new Date(T0 + 70 * MIN)); // the 03:30–04:00Z window was quiet → no line
      expect(h.rolled).toHaveLength(1);

      // voice refusal: an act outside the rights is a journaled refusal with its reason
      const asks: string[] = [];
      const up: VoiceLlm = { async complete(_s, user) {
        asks.push(user);
        if (/kill/u.test(user.slice(user.lastIndexOf('## 받은 말')))) return { model: 'fake', text: JSON.stringify({ reply: '해 본다.', actions: [{ cmd: 'act', action: 'kill', target: 'pid:1' }] }) };
        const j = /## 교정 일지[^\n]*\n([^\n]+)/u.exec(user)?.[1] ?? '일지 없음';
        return { model: 'fake', text: JSON.stringify({ reply: `일지대로: ${j}`, actions: [] }) };
      } };
      const at = new Date(T0 + 75 * MIN);
      const withLlm = { card: h.card, body: h.body, ports: { ...h.ports, llm: up }, now: at };
      await voiceAgent(withLlm, msg(1, 'kill pid:1 해'));
      const refused = journalRows(home).filter(r => r.status === 'refused');
      expect(refused.map(r => [r.action, r.target, r.source])).toEqual([['kill', 'pid:1', 'voice']]);
      expect(refused[0]!.what).toContain('권한 밖 행동');
      const total = h.expect.acted.length + h.expect.failed.length + 1;
      const counts = `행동 ${h.expect.acted.length} · 실패 ${h.expect.failed.length} · 거절 1`;
      // LLM up: the prompt carries the journal and the answer quotes its numbers
      const upR = await voiceAgent(withLlm, msg(2, '오늘 뭘 했어?'));
      expect(upR.folded).toBe(false);
      expect(asks.at(-1)).toContain(`교정 ${total}건: ${counts}`);
      expect(upR.reply).toContain(`교정 ${total}건: ${counts}`);
      // LLM down (throws · empty answer · none): a deterministic answer from the journal, never «목소리 실패»
      for (const llm of [{ complete: async () => { throw new Error('429 weekly quota'); } }, { complete: async () => ({ text: '', model: 'empty' }) }, null] as Array<VoiceLlm | null>) {
        const down = await voiceAgent({ card: h.card, body: h.body, ports: { ...h.ports, llm }, now: at }, msg(3, '오늘 뭘 했어?'));
        expect(down.folded).toBe(true);
        expect(down.reply).toContain(`교정 ${total}건: ${counts}`);
        expect(down.reply).toContain('장난감 청소부');
      }
      // rollup over the day ⊕ kit/kpi KPI
      const day = summarize('toy-sweeper', readJournal(home, Date.parse('2026-11-26T15:00:00Z'), at.getTime()));
      expect([day.acted, day.failed, day.refused]).toEqual([h.expect.acted.length, h.expect.failed.length, 1]);
      const kpi = journalKpi([day], 86_400_000);
      expect(kpi.correctionsPerDay).toBe(h.expect.acted.length);
      expect(kpi.failureRate).toBe(h.expect.failed.length / (h.expect.acted.length + h.expect.failed.length));
    });
  }
});

describe('bespoke agents journal from their cases (policy kind map)', () => {
  test('judge-butler sign → acted · sign-refused → refused · a voice/tick case is not a correction · guardian reap = one row per pid', () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-bespoke-'));
    const butler = fileMemory(root);
    butler.appendCase({ at: '2026-11-27T03:10:00Z', kind: 'sign', subject: 'CELL-A', why: 'done-when met', refs: ['cell:CELL-A', 'pr:#40001'], decidedBy: 'JUDGE-BUTLER', supervisedBy: 'JUD' });
    butler.appendCase({ at: '2026-11-27T03:11:00Z', kind: 'sign-refused', subject: 'CELL-B', why: 'security-4 path', decidedBy: 'JUDGE-BUTLER', supervisedBy: 'JUD' });
    butler.appendCase({ at: '2026-11-27T03:12:00Z', kind: 'voice', subject: 'mail#1', why: 'answered', decidedBy: 'JUDGE-BUTLER', supervisedBy: 'JUD' });
    const rows = journalRows(join(root, 'loop-agents', 'judge-butler'));
    expect(rows.map(r => [r.status, r.action, r.target])).toEqual([['acted', 'sign', 'CELL-A'], ['refused', 'sign-refused', 'CELL-B']]);
    const g = journalRowsFromCase('guardian', { at: '2026-11-27T03:13:00Z', kind: 'reap', subject: 'node-b', why: 'killed 2', refs: ['pid:node-b:11', 'pid:node-b:12'] });
    expect(g.map(r => r.target)).toEqual(['pid:node-b:11', 'pid:node-b:12']);
    expect(journalRowsFromCase('guardian', { at: '2026-11-27T03:13:00Z', kind: 'reap', subject: 'node-b', why: 'killed 0', refs: [] })).toEqual([]);
  });
  test('first start: today\'s act* cases (before the journal existed) become journal rows once · yesterday stays out', () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-backfill-'));
    const mem = fileAgentMemory(root, 'macrophage', 'RES');
    mem.appendCase({ at: '2026-11-26T14:00:00Z', kind: 'act', subject: 'reap:111', why: 'pid 111 SIGTERM · 이유: orphan', decidedBy: 'MACROPHAGE', supervisedBy: 'RES' }); // 23:00 KST 11-26
    mem.appendCase({ at: '2026-11-26T18:53:00Z', kind: 'act', subject: 'reap:63576', why: 'pid 63576 SIGTERM · 이유: orphan 42h', decidedBy: 'MACROPHAGE', supervisedBy: 'RES', extra: { undo: 'relaunch' } }); // 03:53 KST 11-27
    mem.appendCase({ at: '2026-11-26T18:54:00Z', kind: 'tick', subject: 'orphans_over_2h', why: 'x', decidedBy: 'MACROPHAGE', supervisedBy: 'RES' });
    const now = new Date('2026-11-27T04:00:00Z');
    expect(backfillTodayFromCases(mem.root, 'macrophage', now)).toBe(1);
    expect(backfillTodayFromCases(mem.root, 'macrophage', now)).toBe(0);
    const rows = journalRows(mem.root);
    expect(rows.map(r => [r.status, r.action, r.target, r.what, r.why, r.undo])).toEqual([['acted', 'reap', '63576', 'pid 63576 SIGTERM', 'orphan 42h', 'relaunch']]);
  });
  test('the repo policy parses: Seoul day · 30-min windows · KPI targets · bespoke kinds · voice ladder', () => {
    const p = readJournalPolicy();
    expect([p.tz, p.windowMin, p.top, p.keepDays]).toEqual(['Asia/Seoul', 30, 3, 30]);
    expect(p.kpi.failureRate).toEqual({ target: 0.3, dir: 'at_most' });
    expect(p.cases.guardian?.reap).toEqual({ status: 'acted', perRef: true });
    expect(p.voiceFallback.map(f => f.provider)).toEqual(['openai-codex', 'openrouter']);
    expect(parseJournalPolicy('rotation: { tz: Not/AZone, keep_days: -1 }').tz).toBe('Asia/Seoul'); // bad values fall back
  });
});

describe('rollup → OP digest · ws:supervisors', () => {
  test('a SUPERVISOR-JOURNAL rollup to OP folds into the digest and is quoted line by line', () => {
    expect(opDigestFolds({ from: 'SUPERVISOR-JOURNAL', to: 'OP', body: 'x', kind: 'info', refs: ['journal-rollup:macrophage:2026-11-27T03:00:00.000Z'] })).toBe(true);
    const text = renderOpDigest([
      { id: 1, sender: 'SUPERVISOR-JOURNAL', kind: 'info', intent: 'info', body: '[감독 교정 · macrophage] 12:00–12:30 행동 1 · 실패 0 · 거절 0 — 행동 reap×1 (reap:63576)', refs: [], createdAt: '2026-11-27T03:31:00Z' },
      { id: 2, sender: 'LAND-GRAPH', kind: 'info', intent: 'info', body: 'landed', refs: [], createdAt: '2026-11-27T03:32:00Z' },
    ]);
    expect(text).toContain('Supervisor corrections (1):');
    expect(text).toContain('[감독 교정 · macrophage] 12:00–12:30 행동 1 · 실패 0 · 거절 0');
  });
  test('missed windows: at most lookback_windows back · a quiet journal never rolls up', () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-roll-'));
    const lines: string[] = [];
    expect(emitWindowRollups(join(root, 'none'), 'none', new Date(T0), (_k, l) => { lines.push(l); })).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe('voice LLM ladder (router tier · skip exhausted)', () => {
  test('the configured role throws 429 → the next tier candidate answers · the exhausted one is not asked again · empty stream = exhausted', async () => {
    resetExhaustedVoiceProviders();
    const asked: string[] = [];
    const deps: RoleLlmDeps = {
      resolve: () => ({ provider: 'openrouter', model: 'glm-x' }),
      provider: (name, model) => ({ name, model }),
      fallbacks: () => [{ provider: 'openai-codex', model: 'codex-budget' }, { provider: 'anthropic', model: 'haiku-x' }],
      stream: async (_m, opts) => {
        const m = String(opts.model); asked.push(m);
        if (m === 'glm-x') throw new Error('429 weekly limit');
        if (m === 'codex-budget') return '';
        return '{"reply":"ok"}';
      },
    };
    const llm = roleLlm('coordinator', { site: 'loop-agent:toy' }, deps)!;
    expect(await llm.complete('S', 'U')).toEqual({ text: '{"reply":"ok"}', model: 'anthropic/haiku-x' });
    expect(asked).toEqual(['glm-x', 'codex-budget', 'haiku-x']);
    await llm.complete('S', 'U');
    expect(asked.slice(3)).toEqual(['haiku-x']);
    resetExhaustedVoiceProviders();
  });
});
