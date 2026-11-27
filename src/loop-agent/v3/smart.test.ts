// LOOP-AGENT-V3-SMART — reflect · plan · learn-knowhow over a real file store (literals · no product constants reused).
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { lintAgentDir, lintAgentYaml } from './agent-yaml.js';
import { beginSmart, failureCause, fileSmartStore, humanMemory, learn, lessonKey, lessonMarker, plan, reflect, retro, shellPlan, smartConfig, type ActionRow, type SmartConfig, type SmartLesson } from './smart.js';

const REPO = resolve(import.meta.dir, '../../..');
const TRIGGERS = join(REPO, 'graphs', 'triggers');
const T0 = Date.parse('2026-11-27T04:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000);

const cfg = (over: Partial<SmartConfig['p']> = {}): SmartConfig => ({
  agent: 'a1', reflect: true, plan: true, learn: true, retro: false, retroEveryH: 6, soul: null, llmPerHour: 0,
  kpis: [{ name: 'backlog', dir: 'at_most', target: 4, unit: '', ref: 'backlog_max' }],
  actions: [
    { id: 'mail', channel: 'mail', target: 'receiver', serves: ['backlog'], cost: 0.05, isDefault: true },
    { id: 'escalate-l0', channel: 'mail', target: 'l0', serves: ['backlog'], cost: 0.15, isDefault: false },
    { id: 'fold-digest', channel: 'none', target: 'none', serves: [], cost: 0, isDefault: false },
  ],
  p: { graceMin: 20, repeatMin: 3, windowMin: 60, margin: 0.05, penalty: 0.25, llmPerHour: 0, lessonCap: 2, promoteMin: 2, knowhowCap: 1, ...over },
});
const row = (min: number, to: string, key: string): ActionRow => ({ at: at(min).toISOString(), intent: 'nudge', action: 'mail', to, key, kpi: 'backlog', base: 9 });

test('reflect: acted resolves at once · unacted only after the grace · unknown stays pending · streak → pattern', () => {
  const rows = [row(0, 'A', 'a0'), row(10, 'A', 'a1'), row(20, 'A', 'a2'), row(25, 'A', 'a3'), row(0, 'B', 'b0')];
  const r = reflect({ now: at(41), cfg: cfg(), readings: [{ name: 'backlog', value: 9 }], rows, outcome: x => (x.to === 'B' ? true : x.key === 'a3' ? null : false) });
  expect(rows.map(x => x.outcome ?? 'pending')).toEqual(['unacted', 'unacted', 'unacted', 'pending', 'acted']);
  expect(r.patterns.map(p => [p.key, p.streak])).toEqual([['unacted:nudge:mail:A', 3]]);
  expect(r.gaps).toEqual({ backlog: 1 });
  expect(r.resolved).toEqual({ acted: 1, unacted: 3 });
});

test('reflect: a row tied to a KPI without an outcome port — moved toward target = acted', () => {
  const rows = [row(0, 'channel', 'k0'), row(0, 'channel', 'k1')];
  rows[1] = { ...rows[1]!, base: 3 };
  reflect({ now: at(30), cfg: cfg(), readings: [{ name: 'backlog', value: 6 }], rows });
  expect(rows.map(x => x.outcome)).toEqual(['acted', 'unacted']); // 9 → 6 moved · 3 → 6 got worse
});

test('plan: the default until a lesson says otherwise · then KPI gap × act rate − cost', () => {
  const c = cfg();
  const rows = [row(0, 'A', 'a0'), row(10, 'A', 'a1'), row(20, 'A', 'a2')];
  const r = reflect({ now: at(60), cfg: c, readings: [{ name: 'backlog', value: 12 }], rows, outcome: () => false });
  expect(plan({ cfg: c, reflection: r, lessons: [], intent: { intent: 'nudge', to: 'A' }, l0: 'JUD' }).action).toBe('mail');
  const l = learn({ now: at(60), cfg: c, reflection: r, lessons: [] });
  const ch = plan({ cfg: c, reflection: r, lessons: l.lessons, intent: { intent: 'nudge', to: 'A' }, l0: 'JUD' });
  expect([ch.action, ch.to, ch.judgedBy, ch.scores]).toEqual(['escalate-l0', 'JUD', 'score', { mail: 0, 'escalate-l0': 0.35, 'fold-digest': 0 }]);
  expect(plan({ cfg: c, reflection: r, lessons: l.lessons, intent: { intent: 'nudge', to: 'B' }, l0: 'JUD' }).action).toBe('mail'); // lesson is per receiver
});

test('learn: dedupe per key · cleared when the receiver acts again · cap evicts the oldest · promotion capped', () => {
  const c = cfg();
  const pat = (to: string) => ({ key: `unacted:nudge:mail:${to}`, intent: 'nudge', action: 'mail', to, streak: 3 });
  const refl = (pats: ReturnType<typeof pat>[], stats: Array<{ to: string; acted: number; streak: number }> = []) => ({ at: '-', gaps: {}, patterns: pats, resolved: { acted: 0, unacted: 0 },
    stats: stats.map(s => ({ intent: 'nudge', action: 'mail', to: s.to, sent: 4, acted: s.acted, unacted: 3, pending: 0, streak: s.streak })) });
  const a = learn({ now: at(0), cfg: c, reflection: refl([pat('A')]), lessons: [] });
  const b = learn({ now: at(70), cfg: c, reflection: refl([pat('A')]), lessons: a.lessons });
  expect([b.lessons.length, b.lessons[0]!.hits, b.lessons[0]!.windows.length, b.promote.map(x => x.to)]).toEqual([1, 2, 2, ['A']]);
  const d = learn({ now: at(80), cfg: c, reflection: refl([pat('B'), pat('C')]), lessons: b.lessons });
  expect([d.lessons.filter(x => x.status === 'active').map(x => x.to), d.evicted]).toEqual([['B', 'C'], ['unacted:nudge:mail:A']]);
  const e = learn({ now: at(90), cfg: c, reflection: refl([], [{ to: 'B', acted: 1, streak: 0 }]), lessons: d.lessons });
  expect([e.cleared, e.lessons.find(x => x.to === 'B')!.status]).toEqual([['unacted:nudge:mail:B'], 'cleared']);
});

test('session: real store round-trip · knowhow promoted once with a marker · v2 files untouched', () => {
  const home = mkdtempSync(join(tmpdir(), 'v3s-'));
  const store = fileSmartStore(home); const items: string[] = [];
  const kh = { text: () => items.join('\n'), add: (it: { title: string }) => { items.push(it.title); return `K-A1-00${items.length}`; } };
  for (let t = 0; t < 6; t++) {
    const s = beginSmart({ cfg: cfg(), store, now: at(t * 35), l0: 'JUD', knowhow: kh, readings: [{ name: 'backlog', value: 9 }], outcome: () => false });
    s.record({ intent: 'nudge', action: 'mail', to: 'A', key: `k${t}`, kpi: 'backlog', base: 9 });
    s.save();
  }
  expect([store.lessons().length, items.length, items[0]!.startsWith('[v3:')]).toEqual([1, 1, true]);
  expect(store.root).toBe(join(home, 'v3'));
  expect(readFileSync(join(home, 'v3', 'actions.jsonl'), 'utf8').trim().split('\n').length).toBe(6);
});

test('lint: repo land-steward and judge-butler agent.yaml carry the hooks · judge-butler KPI targets equal goal.yaml', () => {
  const ls = lintAgentDir(join(REPO, 'graphs', 'loop-agents', 'land-steward'), { triggersDir: TRIGGERS });
  const jb = lintAgentDir(join(REPO, 'graphs', 'loop-agents', 'judge-butler'), { triggersDir: TRIGGERS });
  expect([ls.ok, ls.errors, ls.warnings, jb.ok, jb.errors, jb.warnings]).toEqual([true, [], [], true, [], []]);
  expect(smartConfig(ls.compiled!)!.actions.map(a => [a.id, a.isDefault])).toEqual([['breach-line', true], ['l0-card', false], ['quiet', false]]);
  expect(smartConfig(jb.compiled!)!.actions.map(a => a.id)).toEqual(['mail', 'escalate-l0', 'fold-digest']);
  expect(smartConfig(ls.compiled!)!.llmPerHour).toBe(0); // budget.llm_turns_per_hour 0 wins over plan_llm_per_hour
  const goal = parse(readFileSync(join(REPO, 'graphs', 'loop-agents', 'judge-butler', 'goal.yaml'), 'utf8')) as { kpi: Record<string, number> };
  expect(jb.compiled!.kpis.map(k => k.target)).toEqual([goal.kpi.greens_per_hour_min, goal.kpi.judge_queue_median_wait_max_min, goal.kpi.frozen_hands_max, goal.kpi.hand_answer_sla_min]);
});

test('lint: a hook without its policy · plan without actions · two defaults · unknown KPI in serves → refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v3l-')); writeFileSync(join(dir, 'soul.md'), '# a1\n');
  const y = (policies: string, actions: string) => `apiVersion: elanous/loop-agent@3
manifest: { name: a1, version: 0.1.0, requires: { executor: loop-agent@3.1, kits: [kpi], node_kinds: [gate, plan], facts: [] }, provides: { agent: a1, kpis: [k1] } }
identity: { id: a1, soul: soul.md }
soul: { purpose: keep k1 up, values: [facts first], do_not: [never guess], voice: short, serves: [TC] }
supervisor: { duty: landing }
policies: { k1_min: 3, c: 0${policies} }
kpis: [{ name: k1, at_least: $policies.k1_min }]
wake: { trigger: { condition: { predicate: { kind: state-changed, parts: [{ file: '{stateRoot}/sim/wake' }] } } } }
body: { entry_node: s, terminal_nodes: [done], nodes: [{ node_id: s, kind: gate }, { node_id: p, kind: plan, optional: true }, { node_id: done, kind: gate }], edges: [{ from: s, map: { ok: done } }] }
${actions}`;
  const pol = ', plan_ambiguity_margin: 0.1, unacted_penalty: 0.5, plan_llm_per_hour: 0';
  const ok = 'actions: [{ id: a, channel: mail, serves: [k1], cost: $policies.c, default: true }]';
  expect(lintAgentYaml(y(pol, ok), dir).errors).toEqual([]);
  expect(lintAgentYaml(y('', ok), dir).errors).toContain('node kind plan needs policy plan_ambiguity_margin');
  expect(lintAgentYaml(y(pol, ''), dir).errors).toContain('plan node needs actions: (what the plan may choose)');
  expect(lintAgentYaml(y(pol, 'actions: [{ id: a, channel: mail, serves: [k1], cost: $policies.c, default: true }, { id: b, channel: none, serves: [], cost: $policies.c, default: true }]'), dir).errors).toContain("actions: exactly one action must be default: true (the plan's prior)");
  expect(lintAgentYaml(y(pol, 'actions: [{ id: a, channel: mail, serves: [zz], cost: $policies.c, default: true }]'), dir).errors).toContain('actions[0].serves names KPI zz — not under kpis:');
});

// ── LOOP-AGENT-V3-SMART-2: failure lessons with a cause · shell plan · human memory · retro ─────────────────────────────
const shellCfg = (over: Partial<SmartConfig> = {}): SmartConfig => ({
  ...cfg({ repeatMin: 3, promoteMin: 1, knowhowCap: 5, lessonCap: 12 }), agent: 'run-supervisor', retro: true, retroEveryH: 6,
  soul: { purpose: 'zombie runs 0', values: ['facts'], doNot: ['pkill·killall'], voice: 'short', serves: ['TC'] },
  kpis: [{ name: 'zombie_runs', dir: 'at_most', target: 0, unit: '', ref: 'zombie_runs_max' }],
  actions: [
    { id: 'end-zombie-pregate', channel: 'self', target: 'self', serves: ['zombie_runs'], cost: 0, isDefault: true, fallback: 'close-stale-record' },
    { id: 'close-stale-record', channel: 'self', target: 'self', serves: ['zombie_runs'], cost: 0, isDefault: false },
  ],
  ...over,
});
const failRow = (min: number, target: string): ActionRow => ({ at: at(min).toISOString(), intent: 'pregate-zombie', action: 'end-zombie-pregate', to: 'self', key: `k${min}`,
  outcome: 'unacted', resolvedAt: at(min).toISOString(), cause: 'pid <defunct> · 기록 100분 — 아직 닫을 나이 아님(120분)' });

test('failure cause: the target id prefix is stripped (with or without the subject prefix)', () => {
  expect(failureCause('abc-light: pid <defunct> · 아직', 'pregate:abc-light')).toBe('pid <defunct> · 아직');
  expect(failureCause('run:r1: 다시 읽으니 열린 런이 아니다', 'run:r1')).toBe('다시 읽으니 열린 런이 아니다');
  expect(failureCause('SIGTERM 실패', 'pregate:x')).toBe('SIGTERM 실패');
});

test('3 failures in a row → one lesson with the cause and the fallback → one knowhow line (marker) at once', () => {
  const home = mkdtempSync(join(tmpdir(), 'v3s2-'));
  const store = fileSmartStore(home);
  store.writeActions([failRow(0, 'a'), failRow(21, 'a'), failRow(42, 'a')]);
  const added: Array<{ title: string; situation: string; prescription: string }> = [];
  const s = beginSmart({ cfg: shellCfg(), store, now: at(43), readings: [], l0: 'TC', knowhow: { text: () => added.map(a => a.title).join('\n'), add: (item) => { added.push(item); return `K-RUN-SUPERVISOR-00${added.length}`; } } });
  s.save();
  expect(s.learned.created).toEqual(['unacted:pregate-zombie:end-zombie-pregate:self']);
  expect(added.length).toBe(1);
  expect(added[0]!.title.startsWith(`${lessonMarker('unacted:pregate-zombie:end-zombie-pregate:self')} end-zombie-pregate 반복 실패`)).toBe(true);
  expect(added[0]!.situation).toContain('원인: pid <defunct> · 기록 100분 — 아직 닫을 나이 아님(120분)');
  expect(added[0]!.prescription).toContain('end-zombie-pregate 대신 close-stale-record');
  // a second window: the marker is in the pack → no second line
  const s2 = beginSmart({ cfg: shellCfg(), store, now: at(200), readings: [], l0: 'TC', knowhow: { text: () => added.map(a => a.title).join('\n'), add: (item) => { added.push(item); return 'K-X'; } } });
  expect([s2.learned.promoted, added.length]).toEqual([[], 1]);
});

const lesson = (status: 'active' | 'cleared'): SmartLesson => ({ key: lessonKey('pregate-zombie', 'end-zombie-pregate', 'self'), intent: 'pregate-zombie', action: 'end-zombie-pregate', to: 'self',
  text: 't', streak: 3, hits: 1, firstAt: at(0).toISOString(), lastAt: at(0).toISOString(), windows: [1], status, cause: 'pid <defunct>' });
const planned = [{ action: 'end-zombie-pregate', target: 'pregate:b', why: 'zombie', kind: 'pregate-zombie' }, { action: 'end-zombie-pregate', target: 'pregate:z', why: 'zombie', kind: 'other' }];
const kh = (m: string) => (m === lessonMarker(lessonKey('pregate-zombie', 'end-zombie-pregate', 'self')) ? 'K-RUN-SUPERVISOR-005' : null);

test('shell plan: knowhow ⊕ active lesson ⊕ fallback → swap (that kind only) · cleared lesson / fallback failed on target / soul do_not → keep', () => {
  const human = [{ id: 'L-2', by: 'CEO', text: 'close-stale-record 전에 명령줄을 다시 읽는다' }, { id: 'K-RUN-SUPERVISOR-006', by: 'CEO', text: '금요일엔 조용히' }];
  const p = shellPlan({ cfg: shellCfg(), planned, lessons: [lesson('active')], knowhowId: kh, human, failedOn: () => false });
  expect(p.lines.map(l => [l.action, l.target, l.from ?? '-', l.by])).toEqual([['close-stale-record', 'pregate:b', 'end-zombie-pregate', 'knowhow'], ['end-zombie-pregate', 'pregate:z', '-', 'body']]);
  expect(p.lines[0]!.why.startsWith('K-RUN-SUPERVISOR-005: end-zombie-pregate 이 «pregate-zombie» 에 3회 연속 실패(원인: pid <defunct>) → close-stale-record')).toBe(true);
  expect(p.lines[0]!.cites.some(c => c.startsWith('L-2(CEO)'))).toBe(true);
  expect([p.purpose, p.memory]).toEqual(['zombie runs 0', ['K-RUN-SUPERVISOR-006(CEO) 금요일엔 조용히']]);
  expect(shellPlan({ cfg: shellCfg(), planned, lessons: [lesson('cleared')], knowhowId: kh, human: [], failedOn: () => false }).lines[0]!.action).toBe('end-zombie-pregate');
  expect(shellPlan({ cfg: shellCfg(), planned, lessons: [lesson('active')], knowhowId: kh, human: [], failedOn: (a, t) => a === 'close-stale-record' && t === 'pregate:b' }).lines[0]!.action).toBe('end-zombie-pregate');
  expect(shellPlan({ cfg: shellCfg(), planned, lessons: [lesson('active')], knowhowId: () => null, human: [], failedOn: () => false }).lines[0]!.action).toBe('end-zombie-pregate');
  const vetoed = shellPlan({ cfg: shellCfg({ soul: { purpose: 'p', values: ['v'], doNot: ['close-stale-record (사람이)'], voice: 'v', serves: ['TC'] } }), planned, lessons: [lesson('active')], knowhowId: kh, human: [], failedOn: () => false });
  expect([vetoed.lines[0]!.action, vetoed.lines[0]!.cites.some(c => c.startsWith('soul.do_not'))]).toEqual(['end-zombie-pregate', true]);
  const refused = shellPlan({ cfg: shellCfg({ soul: { purpose: 'p', values: ['v'], doNot: ['end-zombie-pregate'], voice: 'v', serves: ['TC'] } }), planned, lessons: [], knowhowId: () => null, human: [], failedOn: () => false });
  expect(refused.lines.map(l => [l.refused ?? false, l.by])).toEqual([[true, 'soul'], [true, 'soul']]);
});

test('human memory: learned.md items without a v3 marker and not by the agent · seat lessons (not outcome/silence)', () => {
  const learnedText = [
    '## K-RUN-SUPERVISOR-001 [v3:0123456789] end-zombie-pregate 반복 실패 (x) (2026-11-27)', '- 처방(힐링): a', '- 출처: RUN-SUPERVISOR · 상태: active', '',
    '## K-RUN-SUPERVISOR-002 defunct 는 닫는다 (2026-11-27)', '- 처방(힐링): 기록만 닫는다', '- 출처: CEO · 상태: active', '',
    '## K-RUN-SUPERVISOR-003 self note (2026-11-27)', '- 처방(힐링): b', '- 출처: RUN-SUPERVISOR · 상태: active', ''].join('\n');
  const rows = humanMemory({ learnedText, self: 'RUN-SUPERVISOR', lessons: [{ id: 'L-1', text: 'auto', from: 'outcome', status: 'active' }, { id: 'L-2', text: 'by op', from: 'OP', status: 'active' }, { id: 'L-3', text: 'gone', from: 'OP', status: 'rejected' }] });
  expect(rows).toEqual([{ id: 'K-RUN-SUPERVISOR-002', by: 'CEO', text: 'defunct 는 닫는다 (2026-11-27) — 기록만 닫는다' }, { id: 'L-2', by: 'OP', text: 'by op' }]);
});

test('retro: window rows · KPI first→last · top failure with its cause · one change to try (the fallback lesson first)', () => {
  const rows = [
    { at: at(10).toISOString(), status: 'failed' as const, action: 'end-zombie-pregate', target: 'pregate:a', what: 'a: pid <defunct> · 아직 닫을 나이 아님' },
    { at: at(31).toISOString(), status: 'failed' as const, action: 'end-zombie-pregate', target: 'pregate:a', what: 'a: pid <defunct> · 아직 닫을 나이 아님' },
    { at: at(52).toISOString(), status: 'acted' as const, action: 'close-stale-record', target: 'pregate:b', what: 'closed' },
    { at: at(-500).toISOString(), status: 'acted' as const, action: 'old', target: 'x', what: 'outside the window' },
  ];
  const e = retro({ agent: 'run-supervisor', now: at(60), windowH: 6, rows, kpi: { name: 'zombie_runs', target: 0, dir: 'at_most' },
    kpiHistory: [{ at: at(10).toISOString(), v: 2 }, { at: at(31).toISOString(), v: 1 }, { at: at(52).toISOString(), v: 0 }], lessons: [lesson('active')], actions: shellCfg().actions });
  expect(e.counts).toEqual({ acted: 1, failed: 2, refused: 0 });
  expect(e.worked).toBe('close-stale-record×1 · KPI zombie_runs 2→0 (목표 충족 1/3 틱)');
  expect(e.failed).toBe('end-zombie-pregate×2 — 원인 «pid <defunct> · 아직 닫을 나이 아님»');
  expect(e.tryNext.startsWith('«pregate-zombie» 에는 end-zombie-pregate 대신 close-stale-record')).toBe(true);
  expect(retro({ agent: 'a', now: at(60), windowH: 6, rows: [], kpi: null, kpiHistory: [], lessons: [], actions: [] }).tryNext).toBe('지금대로 — 바꿀 근거가 없다');
});

test('lint: fallback must name another declared action · soul block compiled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v3f-')); writeFileSync(join(dir, 'soul.md'), '# a1\n');
  const y = (acts: string) => `apiVersion: elanous/loop-agent@3
manifest: { name: a1, version: 0.1.0, requires: { executor: loop-agent@3.2, kits: [kpi], node_kinds: [gate, plan, retro], facts: [] }, provides: { agent: a1, kpis: [k1] } }
identity: { id: a1, soul: soul.md }
soul: { purpose: keep k1 up, values: [facts first], do_not: [never guess], voice: short, serves: [TC] }
supervisor: { duty: landing }
policies: { k1_min: 3, c: 0, plan_ambiguity_margin: 0, unacted_penalty: 0.5, plan_llm_per_hour: 0, retro_every_h: 6 }
kpis: [{ name: k1, at_least: $policies.k1_min }]
wake: { trigger: { condition: { predicate: { kind: state-changed, parts: [{ file: '{stateRoot}/sim/wake' }] } } } }
body: { entry_node: s, terminal_nodes: [done], nodes: [{ node_id: s, kind: gate }, { node_id: p, kind: plan, optional: true }, { node_id: r, kind: retro, optional: true }, { node_id: done, kind: gate }], edges: [{ from: s, map: { ok: done } }] }
actions: ${acts}`;
  const ok = lintAgentYaml(y('[{ id: a, channel: self, target: self, serves: [k1], cost: $policies.c, default: true, fallback: b }, { id: b, channel: self, target: self, serves: [k1], cost: $policies.c }]'), dir);
  expect(ok.errors).toEqual([]);
  expect([ok.compiled!.soul.purpose, ok.compiled!.actions[0]!.fallback, smartConfig(ok.compiled!)!.retroEveryH]).toEqual(['keep k1 up', 'b', 6]);
  expect(lintAgentYaml(y('[{ id: a, channel: self, serves: [k1], cost: $policies.c, default: true, fallback: zz }]'), dir).errors).toContain('actions a: fallback zz is not a declared action');
  expect(lintAgentYaml(y('[{ id: a, channel: self, serves: [k1], cost: $policies.c, default: true, fallback: a }]'), dir).errors).toContain('actions a: fallback must be another action');
});
