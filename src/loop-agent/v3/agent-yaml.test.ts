// LOOP-AGENT-V3-YAML — agent.yaml lint: the repo's land-steward package passes · each refusal names its cause (literals).
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { lintAgentDir, lintAgentYaml, refusalReport, supervisorSeat } from './agent-yaml.js';

const REPO = resolve(import.meta.dir, '../../..');
const PKG = join(REPO, 'graphs', 'loop-agents', 'land-steward');
const TRIGGERS = join(REPO, 'graphs', 'triggers');

test('land-steward agent.yaml lints clean against this install and the registered land-graph trigger', () => {
  const r = lintAgentDir(PKG, { triggersDir: TRIGGERS });
  expect([r.present, r.ok, r.errors, r.warnings]).toEqual([true, true, [], []]);
  const c = r.compiled!;
  expect(c.kpis.map(k => [k.name, k.dir, k.target])).toEqual([['lands_per_hour', 'at_least', 10], ['landable_ratio', 'at_least', 0.5], ['needs_finisher_wait_p50', 'at_most', 30], ['refusals_without_next', 'at_most', 0]]);
  expect([c.supervisor, c.voice.breachLineEveryMin, c.wake.cooldownMin, c.wake.maxWaitMin, c.subs.map(s => s.id)]).toEqual([{ duty: 'landing' }, 30, 2, 10, ['train-manager', 'finisher', 'cell-link', 'pr-aging']]);
});

/** A temp agent dir with its soul card (identity.soul is required — LOOP-AGENT-V3-SMART-2). */
const soulDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'la3-')); writeFileSync(join(d, 'soul.md'), '# a1 soul\n'); return d; };
const minimal = (over = ''): string => `apiVersion: elanous/loop-agent@3
manifest: { name: a1, version: 0.1.0, requires: { executor: loop-agent@3, kits: [kpi], node_kinds: [gate], facts: [res.slots] }, provides: { agent: a1, kpis: [k1] } }
identity: { id: a1, soul: soul.md }
soul: { purpose: keep k1 up, values: [facts first], do_not: [never guess], voice: short, serves: [TC] }
supervisor: { duty: landing }
policies: { k1_min: 3, slots: { fact: res.slots, default: 2 } }
kpis: [{ name: k1, at_least: $policies.k1_min }]
wake: { trigger: { condition: { predicate: { kind: state-changed, parts: [{ file: '{stateRoot}/sim/wake' }] } } } }
body: { entry_node: s, terminal_nodes: [done], nodes: [{ node_id: s, kind: gate }, { node_id: done, kind: gate }], edges: [{ from: s, map: { ok: done } }] }
${over}`;

test('policy values: literal · fact (read now) · fact default when absent (warned)', () => {
  const dir = soulDir();
  const a = lintAgentYaml(minimal(), dir, { facts: n => (n === 'res.slots' ? 5 : undefined) });
  expect([a.ok, a.compiled?.policies]).toEqual([true, { k1_min: 3, slots: 5 }]);
  const b = lintAgentYaml(minimal(), dir);
  expect([b.ok, b.compiled?.policies.slots, b.warnings.some(w => w.includes('fact res.slots not available here — default 2'))]).toEqual([true, 2, true]);
});

test('refusals name their cause', () => {
  const dir = soulDir();
  const errs = (y: string) => lintAgentYaml(y, dir).errors.join(' | ');
  expect(errs(minimal().replace('executor: loop-agent@3', 'executor: loop-agent@4'))).toContain('this install runs loop-agent@3.2');
  expect(errs(minimal().replace('$policies.k1_min', '$policies.nope'))).toContain('missing policy ref $policies.nope');
  expect(errs(minimal().replace('{ node_id: s, kind: gate }', '{ node_id: s, kind: warp }'))).toContain('unknown node kind warp');
  expect(errs(minimal().replace('supervisor: { duty: landing }', 'supervisor: { duty: lunch }'))).toContain('supervisor.duty lunch is not an org duty');
  expect(errs(minimal('memory: { knowhow: ../../etc/k.md }'))).toContain('must stay inside the agent dir');
  expect(errs(minimal('goal: ping ops@example.com'))).toContain('not portable (email / account)');
  // LOOP-AGENT-V3-SMART-2: the soul is required (block ⊕ soul card) — a missing or half block is refused by name
  expect(errs(minimal().replace(/^soul: .*\n/mu, ''))).toContain('soul: block is required');
  expect(errs(minimal().replace('voice: short, ', ''))).toContain('soul.voice is required');
  expect(errs(minimal().replace('identity: { id: a1, soul: soul.md }', 'identity: { id: a1 }'))).toContain('identity.soul (soul.md in the agent dir) is required');
  writeFileSync(join(dir, 'agent.yaml'), 'apiVersion: [');
  expect(lintAgentDir(dir).errors[0]).toStartWith('bad yaml');
});

test('GUARDIAN-KPI-FROM: from as { file · path · where } compiles · a path string stays the tick-file form · bad file / where refused by name', () => {
  const dir = soulDir();
  const k = (from: string) => lintAgentYaml(minimal().replace('{ name: k1, at_least: $policies.k1_min }', `{ name: k1, at_least: $policies.k1_min, from: ${from} }`), dir);
  const a = k('{ file: last-pulse.json, path: kpi, where: { ok: false } }');
  expect([a.ok, a.errors, a.compiled?.kpis[0]]).toEqual([true, [], { name: 'k1', dir: 'at_least', target: 3, unit: '', ref: 'k1_min', from: 'kpi', fromFile: 'last-pulse.json', fromWhere: { ok: false } }]);
  expect(k('kpi.k1').compiled?.kpis[0]).toEqual({ name: 'k1', dir: 'at_least', target: 3, unit: '', ref: 'k1_min', from: 'kpi.k1' });
  expect(k('{ file: ../x.json, path: kpi }').errors[0]).toEqual('kpis[0].from.file must be a JSON file name in the agent home (e.g. last-pulse.json)');
  expect(k('{ file: last-pulse.json, path: kpi, where: { ok: [1] } }').errors[0]).toEqual('kpis[0].from.where must map field names to scalars (e.g. { ok: false })');
  expect(k('{ file: last-pulse.json }').errors[0]).toEqual('kpis[0].from must be a dotted field path into the tick file (e.g. kpi.landsLastHour)');
  expect(k('{ path: kpi, pick: max }').errors[0]).toEqual('kpis[0].from takes only file · path · where');
});

test('refusal report: L0 by duty through the org map · key stable per error set', () => {
  const org = join(mkdtempSync(join(tmpdir(), 'la3-org-')), 'federation.yaml');
  writeFileSync(org, 'org:\n  duties:\n    landing: TC\n    veto: JUD\n');
  expect(supervisorSeat({ duty: 'landing' }, 'OP', { path: org })).toBe('TC');
  const a = refusalReport('a1', ['x', 'y'], 'TC'); const b = refusalReport('a1', ['x', 'y'], 'TC'); const c = refusalReport('a1', ['x'], 'TC');
  expect([a.key === b.key, a.key === c.key, a.body.startsWith('[a1 → L0 TC] agent.yaml 거부')]).toEqual([true, false, true]);
});
