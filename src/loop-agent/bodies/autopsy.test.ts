import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseKnowhowItems } from '../../seat-loop/seat-knowhow.js';
import { loadCard } from '../card.js';
import { fileAgentMemory } from '../memory.js';
import { tickAgent, voiceAgent, type AgentPorts, type VoiceLlm, type VoiceMessage } from '../runtime.js';
import { cellIdFor, classifyDeath, createBody, type AutopsyDeps, type AutopsyRow, type CellRow, type Death } from './autopsy.js';

function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const T0 = Date.parse('2026-11-27T10:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();

// Seeded world: land refusals (one class repeated ≥ cell_repeat 3 — agent.yaml policy, a literal here · rule 11), discarded runs, closed PRs with and without a cause.
function world(seed: number, opts: { noEvidence?: boolean; sourceDown?: boolean } = {}) {
  const r = rng(seed);
  const deaths: Array<{ -readonly [K in keyof Death]: Death[K] }> = []; // mutable: one test injects the closer comment afterwards
  const repeats = 3 + Math.floor(r() * 3);
  for (let i = 0; i < repeats; i++) deaths.push({ id: `land:${42000 + i}:abc${i}:stale-head`, kind: 'land-refused', ref: `pr:${42000 + i}`, at: iso(T0 - (i + 1) * 3_600_000), cls: 'stale-head', text: '' });
  const nRuns = 1 + Math.floor(r() * 3);
  for (let i = 0; i < nRuns; i++) deaths.push({ id: `run:run-${seed}-${i}`, kind: 'run-died', ref: `run:run-${seed}-${i}`, at: iso(T0 - 600_000), cls: i === 0 ? 'pod-died' : `natural-language-research-${i}:question-plan:aborted`, text: '' }); // distinct: only the land class repeats
  deaths.push({ id: `pr:${43000 + seed}`, kind: 'pr-closed', ref: `pr:${43000 + seed}`, at: iso(T0 - 900_000), cls: null, text: 'feat: x\nsuperseded by → #43999' });
  if (opts.noEvidence) for (let i = 0; i < 2; i++) deaths.push({ id: `pr:${44000 + i}`, kind: 'pr-closed', ref: `pr:${44000 + i}`, at: iso(T0 - 300_000), cls: null, text: 'wip' });
  const rows: AutopsyRow[] = []; const cells: CellRow[] = []; const opened: string[] = [];
  const deps: AutopsyDeps = {
    deaths: () => ({ deaths: deaths.map(d => ({ ...d })), unknown: opts.sourceDown ? ['gh'] : [] }),
    rows: () => rows.map(x => ({ ...x })),
    record: rs => { rows.push(...rs); },
    cells: () => cells.map(c => ({ ...c })),
    openCell: (cellId) => { opened.push(cellId); return { ok: true, line: `칸 ${cellId} 추가` }; },
    recordCell: c => { cells.push(c); },
  };
  return { deaths, rows, cells, opened, deps, repeats };
}

function harness(seed: number, opts: { noEvidence?: boolean; sourceDown?: boolean; llm?: VoiceLlm } = {}) {
  const root = mkdtempSync(join(tmpdir(), `ap-${seed}-`));
  const card = loadCard('autopsy');
  const memory = fileAgentMemory(root, card.id, card.supervisor);
  const posts: Array<{ key: string; to: string; body: string }> = [];
  const ports: AgentPorts = {
    memory, post(key, to, body) { if (posts.some(p => p.key === key)) return null; posts.push({ key, to, body }); return 600 + posts.length; },
    beat: () => {}, speak: () => {}, llm: opts.llm ?? null,
  };
  const w = world(seed, opts);
  return { root, card, memory, posts, ports, body: createBody({ stateRoot: root, card }, w.deps), ...w };
}

describe('autopsy card · knowhow · classification', () => {
  test('card loads with L0 OP', () => {
    const c = loadCard('autopsy');
    expect(c).toMatchObject({ id: 'autopsy', address: 'AUTOPSY', supervisor: 'OP', kpi: { name: 'unclassified_deaths', target: 0, dir: 'at_most' } });
    expect(c.rights.actions).toEqual(['classify', 'open-cell', 'reclassify']);
  });
  test('knowhow seed parses', () => {
    const t = readFileSync(resolve(import.meta.dir, '../../../graphs/loop-agents/autopsy/knowhow.md'), 'utf8');
    expect(parseKnowhowItems(t, 'AUTOPSY').length).toBeGreaterThanOrEqual(3);
  });
  test('structured cause first · closing text second · otherwise unclassified', () => {
    const base = { id: 'x', ref: 'pr:1', at: iso(T0) };
    expect(classifyDeath({ ...base, kind: 'land-refused', cls: 'tsc', text: '' })).toEqual({ cls: 'land:tsc', basis: 'structured' });
    expect(classifyDeath({ ...base, kind: 'pr-closed', cls: 'refused-then-closed:stale-head', text: 'superseded' }).cls).toBe('pr:refused-then-closed:stale-head');
    expect(classifyDeath({ ...base, kind: 'pr-closed', cls: null, text: '→ #123 로 대체' })).toEqual({ cls: 'pr:superseded', basis: 'text' });
    expect(classifyDeath({ ...base, kind: 'run-died', cls: null, text: '' }).cls).toBe('unclassified');
    expect(cellIdFor('land:stale-head')).toBe('AUTOPSY-LAND-STALE-HEAD');
  });
});

describe('sim: death → wake → classify ⊕ repeated class → one cell (seeds)', () => {
  for (const seed of [1, 7, 42]) {
    test(`seed ${seed}`, async () => {
      const h = harness(seed);
      let t = T0;
      const r1 = await tickAgent(h.card, h.body, h.ports, new Date(t));
      expect(r1.kpi).toBe(h.deaths.length);
      expect(r1.kpiOk).toBe(false);
      expect(r1.acted).toContain('classify:pending');
      let r = r1;
      for (let i = 0; i < 4; i++) { t += 11 * 60_000; r = await tickAgent(h.card, h.body, h.ports, new Date(t)); }
      expect(r.kpi).toBe(0);
      expect(r.kpiOk).toBe(true);
      expect(h.rows.length).toBe(h.deaths.length);
      expect(h.rows.every(x => x.cls !== 'unclassified')).toBe(true);
      expect(h.rows.find(x => x.kind === 'pr-closed')!.cls).toBe('pr:superseded');
      // the repeated land class opened exactly one cell, never again on later ticks
      expect(h.opened).toEqual(['AUTOPSY-LAND-STALE-HEAD']);
      const cellAct = h.memory.cases(300).find(c => c.kind === 'act' && c.subject.startsWith('open-cell:'));
      expect(cellAct?.extra?.undo).toBe('eln release checklist rm AUTOPSY-LAND-STALE-HEAD');
      expect(h.posts.filter(p => p.key.startsWith('kpi-breach')).length).toBe(0);
    });
  }
  test('deaths with no cause evidence stay unclassified → exactly one L0 card to OP after escalate_after_min', async () => {
    const h = harness(5, { noEvidence: true });
    let t = T0;
    for (let i = 0; i < 8; i++) { await tickAgent(h.card, h.body, h.ports, new Date(t)); t += 31 * 60_000; }
    const l0 = h.posts.filter(p => p.key.startsWith('kpi-breach'));
    expect(l0.length).toBe(1);
    expect(l0[0]!.to).toBe('OP');
    expect(h.rows.filter(x => x.cls === 'unclassified').map(x => x.id).sort()).toEqual(['pr:44000', 'pr:44001']);
  });
  test('daily cell budget used up: open-cell is not planned (no failed rows) · the next day it opens', async () => {
    const h = harness(2);
    // two cells already opened in the last 24 h for other classes (the live 11-27 state: «오늘 칸 2개 — 하루 한도 2»)
    h.cells.push({ cls: 'land:other-a', cellId: 'AUTOPSY-LAND-OTHER-A', at: iso(T0 - 3_600_000) }, { cls: 'land:other-b', cellId: 'AUTOPSY-LAND-OTHER-B', at: iso(T0 - 1_800_000) });
    let t = T0;
    for (let i = 0; i < 4; i++) { await tickAgent(h.card, h.body, h.ports, new Date(t)); t += 11 * 60_000; }
    expect(h.opened).toEqual([]);
    expect(h.memory.cases(300).filter(c => c.kind === 'act-failed').length).toBe(0);
    expect(h.memory.cases(300).filter(c => c.kind === 'tick').at(-1)!.why).not.toContain('실패');
    await tickAgent(h.card, h.body, h.ports, new Date(T0 + 25 * 3_600_000));
    expect(h.opened).toEqual(['AUTOPSY-LAND-STALE-HEAD']);
  });
  test('an unreadable source makes the KPI unknown, never 0', async () => {
    const h = harness(9, { sourceDown: true });
    const r = await tickAgent(h.card, h.body, h.ports, new Date(T0));
    expect(r.kpi).toBeNull();
    expect(r.kpiOk).toBeNull();
  });
});

function fakeLlm(): VoiceLlm {
  return {
    async complete(_system, user) {
      const said = user.slice(user.lastIndexOf('## 받은 말'));
      if (/분류해/u.test(said)) return { model: 'fake', text: JSON.stringify({ reply: '미분류를 분류한다.', actions: [{ cmd: 'act', action: 'classify', target: 'pending' }] }) };
      if (/다시 열어/u.test(said)) return { model: 'fake', text: JSON.stringify({ reply: 'PR 을 다시 여는 것은 내 권한 밖이다.', actions: [{ cmd: 'reopen-pr', pr: 43001 }] }) };
      const kpi = /unclassified_deaths (\d+)/u.exec(user)?.[1];
      const fact = /사실: ([^\n]*)/u.exec(user)?.[1]?.slice(0, 60) ?? '';
      return { model: 'fake', text: JSON.stringify({ reply: `미분류 ${kpi ?? '?'} — ${fact}`, actions: [] }) };
    },
  };
}
const msg = (id: number, from: string, body: string): VoiceMessage => ({ id, from, body, at: '2026-11-27T10:00:00Z', channel: 'els:ws:supervisors', thread: 'els:ws:supervisors' });

describe('voice round-trip (fake LLM)', () => {
  test('answers what it is doing from facts · classifies inside rights · refuses reopening a PR and escalates to OP', async () => {
    const h = harness(21, { llm: fakeLlm() });
    const deps = { card: h.card, body: h.body, ports: h.ports, now: new Date(T0) };
    const r1 = await voiceAgent(deps, msg(1, 'TC', '지금 뭐 하고 있어?'));
    expect(r1.folded).toBe(false);
    expect(r1.reply).toMatch(/미분류 \d+ — 사망 \d+/u);
    const r2 = await voiceAgent(deps, msg(2, 'OP', '미분류 분류해'));
    expect(r2.actions).toContain('act:classify:pending');
    expect(h.rows.length).toBe(h.deaths.length);
    const r3 = await voiceAgent(deps, msg(3, 'TC', '닫힌 PR 다시 열어'));
    expect(r3.escalated).toBe(true);
    expect(h.posts.some(p => p.to === 'OP' && p.key.startsWith('voice-esc:'))).toBe(true);
  });
});

// DETECT-TO-ACTION (11-28 live: unclassified_deaths ≥ 1 for 18 h, «행동 0/0» — the closing comment held the cause, the reader took the body only)
describe('autopsy reclassify: an «unclassified» row whose fresh evidence now classifies gets a newer row', () => {
  test('closing comments of the five 11-27 PRs classify (literal texts from #40438 #40430 #40363 #40475 #40415)', () => {
    const d = (text: string): Death => ({ id: 'pr:1', kind: 'pr-closed', ref: 'pr:1', at: iso(T0), cls: null, text });
    expect(classifyDeath(d('Superseded by #40441 (same commit rebased on current main — merge-main conflict in expect-load count; new branch instead of force push).')).cls).toBe('pr:superseded');
    expect(classifyDeath(d('사전 점검(새 골 정책 경로 v2) 산출물 — 같은 칸 THROUGHPUT-GIT-CWD-E4 의 #40394 와 중복이라 닫는다.')).cls).toBe('pr:duplicate');
    expect(classifyDeath(d('Claude OP: TA 스프린트 draft — 수확하지 않기로 함(폴백이 저장소 전체 파일을 PR 파일로 돌려 보안 4종 오탐). live.ts 단일 writer 를 SPLIT-TO-GREEN(TC-H-POOL-1)에 넘기려고 닫음.')).cls).toBe('pr:abandoned');
    expect(classifyDeath(d('NOTICE-TURN-QUIET-CLOSE 를 감독 분해안대로 쪼갬(CORE = 정보성 notice 안내 분기) — 이 중간 draft 는 분할로 대체.')).cls).toBe('pr:superseded');
    expect(classifyDeath(d('NOTICE-TURN-QUIET-CLOSE 를 감독 분해안대로 쪼갬')).cls).toBe('pr:split');
    expect(classifyDeath(d('하니스 종결 트리아지: 멈춘 사유 no-progress · 라운드 3 · 착지한 조각 PR 없음')).cls).toBe('pr:harness-stop:no-progress');
    expect(classifyDeath(d('wip')).cls).toBe('unclassified');
  });
  test('tick: the stuck row is reclassified once (KPI 1 → 0) · a death with still no evidence is not touched', async () => {
    const h = harness(9, { noEvidence: true });
    let t = T0;
    await tickAgent(h.card, h.body, h.ports, new Date(t)); // classifies everything · pr:44000/44001 stay unclassified
    expect(h.rows.filter(x => x.cls === 'unclassified').map(x => x.id).sort()).toEqual(['pr:44000', 'pr:44001']);
    // the closer's comment arrives for pr:44000 only
    h.deaths.find(x => x.id === 'pr:44000')!.text = 'Superseded by #44100\nwip';
    t += 11 * 60_000;
    const r = await tickAgent(h.card, h.body, h.ports, new Date(t));
    expect(r.kpi).toBe(2);
    expect(r.acted).toEqual(['reclassify:stuck', 'open-cell:cls:land:stale-head']); // the repeated land class opens its one cell on the same tick
    expect(h.rows.filter(x => x.id === 'pr:44000').map(x => x.cls)).toEqual(['unclassified', 'pr:superseded']);
    t += 11 * 60_000;
    const r3 = await tickAgent(h.card, h.body, h.ports, new Date(t));
    expect(r3.kpi).toBe(1);
    expect(r3.acted).toEqual([]);
    expect(h.rows.filter(x => x.id === 'pr:44001').map(x => x.cls)).toEqual(['unclassified']);
    const act = h.memory.cases(100).find(c => c.kind === 'act' && c.subject === 'reclassify:stuck');
    expect(act?.why).toBe('미분류 1건 재분류 — pr:44000→pr:superseded · 이유: 미분류 행 1건에 새 근거(닫는 댓글 등) — pr:44000');
  });
});
