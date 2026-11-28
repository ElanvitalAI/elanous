// GUARDIAN-V3-SMART ⊕ GUARDIAN-SUBS — the guardian from its agent.yaml (one definition) on the real pulse (runResidentPulse),
// against a fake world (tmp state root · no ssh · no kill · no mail). Expectations are independent literals (rule 11).
//   V3-LINT          — every shipped agent.yaml lints (12 · guardian included) · the guardian has 7 subs, each detector with a
//                      ladder or an escalation · the trigger shim reads wake: from agent.yaml (same condition as before) ·
//                      a detector that only «sees», a ladder step outside the sub's rights, a missing SLA → refused.
//   SUB-LADDER       — 임대관: node-b overloaded → case opened → route-away recorded (acting) → node-b normal again → resolved ·
//                      no card to anyone.
//   OUT-OF-POLICY    — 맥박: an outcome bad 90 min → the reattach card (the sub's own) → case escalated at once, no second card ·
//                      a host that does not answer (no ladder) → one card to the L0 after its SLA → resolved when it answers.
//   KNOWHOW          — refresh-fuel ×4 (30 min apart) leaving the usage snapshot stale → ONE knowhow line with the cause · no
//                      second line · a dead trigger is counted in the 맥박 KPI but never restarted or carded here (the trigger
//                      registry owns it · LOOP-AGENTS-AS-PLUGINS P1).
//   RETRO · VOICE    — 6 h after the first pulse one retro entry (and only one) · the voice prompt carries the soul block and
//                      the retro · a refused agent.yaml runs on the last-known-good copy.
import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileMemory } from '../judge-butler/memory.js';
import { readCases } from '../kit/case-ledger/index.js';
import { lintAgentYaml } from '../loop-agent/v3/agent-yaml.js';
import { lintSupervisor } from '../loop-agent/v3/supervisor.js';
import { readTriggerDecl } from '../loops/trigger-registry.js';
import { GUARDIAN_DEMOTERS, GUARDIAN_ID, GUARDIAN_SUPERVISOR, type GuardianPorts, type GuardianView } from './body.js';
import { cards } from './guardian-cli.js';
import { guardianPkgDir, gp, guardianDef, resetGuardianDef } from './def.js';
import type { HostProbe } from './hosts.js';
import { runResidentPulse, type PulseDeps } from './pulse.js';
import { readPulseSnapshot } from './world.js';
import { guardianVoiceTurn } from './voice.js';

const REPO = resolve(import.meta.dir, '../..');
const T0 = new Date('2026-11-27T10:00:00.000Z');
// 출처: #40593 sim clock units — one minute / one hour in ms (time units, not a tuning bound)
const MIN = 60_000; const H = 60 * MIN;
const at = (m: number) => new Date(T0.getTime() + m * MIN);

afterEach(() => { resetGuardianDef(); });

function harness(opts: { deadSupervisor?: boolean; badSupervisor?: boolean; staleFuel?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'guardian-v3-'));
  const memory = fileMemory(root, { agent: GUARDIAN_ID, supervisor: GUARDIAN_SUPERVISOR, demoters: GUARDIAN_DEMOTERS });
  const posts: Array<{ key: string; to: string; body: string }> = [];
  let probes: HostProbe[] = [
    { host: 'node-b', reachable: true, load1: 4, ncpu: 32 }, { host: 'minim5', reachable: true, load1: 1.9, ncpu: 18 },
    { host: 'node-c', reachable: true, load1: 3.8, ncpu: 14 }, { host: 'mbp', reachable: true, load1: 4.7, ncpu: 18 },
  ];
  const post = (key: string, to: string, body: string) => { if (posts.some(p => p.key === key)) return null; posts.push({ key, to, body }); return 900 + posts.length; };
  const view = (now: Date): GuardianView => ({ now, probes, procs: new Map([['node-b', []]]), registry: new Map(), ready: null, hands: null });
  const ports: GuardianPorts = { memory, kill: () => ({ killed: [], skipped: [] }), writeRoute: () => {}, post, audit: () => {} };
  const deps = (now: Date): PulseDeps => ({
    stateRoot: root, now, memory,
    probes: () => probes,
    fuelSnapshot: () => ({ ts: opts.staleFuel ? now.getTime() - 3 * H : now.getTime(), accounts: [{ provider: 'codex', account: 'team', usedPercent: 20, status: 'ok' }] }),
    credentials: () => [], scanSecrets: () => [], refreshFuel: () => {},
    supervisors: () => [
      ...(opts.deadSupervisor ? [{ id: 'land-graph', owner: 'TC', everyMin: 10, lastAt: new Date(now.getTime() - 2 * H).toISOString(), lastStatus: 'done', badSince: null, via: 'trigger' as const }] : []),
      ...(opts.badSupervisor ? [{ id: 'judge-butler', owner: 'JUD', everyMin: 10, lastAt: new Date(now.getTime() - 5 * MIN).toISOString(), lastStatus: 'done', badSince: new Date(now.getTime() - 90 * MIN).toISOString(), via: 'trigger' as const }] : []),
      { id: 'op-pulse', owner: 'OP', everyMin: 10, lastAt: new Date(now.getTime() - 3 * MIN).toISOString(), lastStatus: 'done', badSince: null, via: 'trigger' as const },
    ],
    post,
    heavy: () => ({ view: view(now), ports, close: () => {} }),
    beat: () => {},
  });
  return { root, memory, posts, deps, setProbes: (p: HostProbe[]) => { probes = p; } };
}
const cardsTo = <P extends { key: string; to: string }>(posts: readonly P[], prefix: string): P[] => posts.filter(p => p.key.startsWith(prefix));

describe('V3-LINT — the guardian is one agent.yaml · 15 packages lint clean · detectors must act or escalate', () => {
  test('every shipped agent.yaml lints ok (15, guardian included · fed-analyst ⊕ supervisor-auditor ⊕ rail-canary) · the guardian declares 7 subs with detectors', () => {
    const root = join(REPO, 'graphs', 'loop-agents');
    const ids = readdirSync(root).filter(n => existsSync(join(root, n, 'agent.yaml'))).sort();
    expect(ids).toEqual(['autopsy', 'fed-analyst', 'guardian', 'hand-steward', 'judge-butler', 'land-steward', 'macrophage', 'rail-canary', 'release-rocket', 'run-doctor', 'run-supervisor', 'silence-watch', 'supervisor-auditor', 'train-manager', 'watchers-check']);
    for (const id of ids) { const r = lintSupervisor(id, root, { parity: true }); expect(`${id}:${r.ok}:${r.errors.join('|')}`).toBe(`${id}:true:`); }
    const def = guardianDef();
    expect(def.source).toBe('agent.yaml');
    expect(def.subs.map(s => `${s.id}:${s.name}:${s.everyMin}:${s.ttlMin}`)).toEqual(['pulse:맥박:15:5', 'lease:임대관:15:10', 'fuel:연료관:30:5', 'keys:열쇠지기:60:5', 'macrophage:대식세포:15:10', 'patrol:순찰대:30:10', 'post:우체국·레일지기:30:5']);
    for (const s of def.subs) for (const d of s.detectors) expect(d.normalize.length > 0 || d.escalate !== null).toBe(true);
    expect(def.subs.find(s => s.id === 'patrol')!.detectors.map(d => `${d.id}@${d.by}`)).toEqual(['zombie-run@run-supervisor', 'run-failed@run-doctor', 'loop-exception@run-doctor', 'unclassified-death@autopsy']);
    expect(def.subs.find(s => s.id === 'post')!.detectors.map(d => `${d.id}@${d.by}`)).toEqual(['mail-sla@silence-watch', 'dormant-recipient@mail-route', 'rail-regression@land-rail-watch']);
    expect(def.subs.find(s => s.id === 'fuel')!.detectors.map(d => d.id)).toEqual(['usage-stale', 'account-low', 'provider-dry']);
    expect([gp('scale_ratio'), gp('scale_headroom'), gp('host_load_per_cpu_max'), gp('event_respawn_min')]).toEqual([2, 0.6, 1, 2]);
    // LOOP-AGENTS-AS-PLUGINS P1: the 맥박 restarts nothing (the trigger registry owns a dead trigger) · 순찰대·우체국 are KPI roll-ups
    expect(def.subs.find(s => s.id === 'pulse')!.detectors.map(d => d.id)).toEqual(['supervisor-bad', 'host-unreachable']);
    expect(def.subs.filter(s => s.kpiRollup).map(s => `${s.id}:${s.kpiRollup!.targets.map(t => t.id).join(',')}`)).toEqual(['patrol:run-supervisor,autopsy,run-doctor', 'post:silence-watch,rail-watch']);
  });

  test('the trigger shim reads wake: from agent.yaml — same condition, owner OP, goal = the pulse snapshot', () => {
    const d = readTriggerDecl('graphs/triggers/guardian.yaml', REPO);
    expect(d.owner).toBe('OP');
    expect(d.goal).toEqual({ kind: 'file-mtime', path: '{stateRoot}/loop-agents/guardian/last-pulse.json' });
    expect(JSON.stringify(d.condition)).toBe('{"predicate":{"kind":"state-changed","parts":[{"file":"{stateRoot}/res/reaper/registry.jsonl"}]},"cooldownMin":1,"maxWaitMin":1,"onMaxWait":"fire"}');
  });

  test('refused: a detector that only sees · a ladder step outside the sub rights · an escalation without SLA', () => {
    const text = readFileSync(join(guardianPkgDir(), 'agent.yaml'), 'utf8');
    const seeOnly = text.replace(/      - id: host-unreachable\n        normal: "every local host answers the load probe"\n        normalize: \[\]\n        escalate: \{ to: l0, sla_min: \$policies.host_unreachable_sla_min \}\n/u,
      '      - id: host-unreachable\n        normal: "every local host answers the load probe"\n        normalize: []\n');
    expect(seeOnly).not.toBe(text);
    expect(lintAgentYaml(seeOnly, guardianPkgDir()).errors.some(e => e.includes('host-unreachable: declares neither a normalize ladder nor an escalation'))).toBe(true);
    const outside = text.replace('        normalize: [route-away]\n', '        normalize: [reap]\n');
    expect(lintAgentYaml(outside, guardianPkgDir()).errors.some(e => e.includes('host-overload: normalize step reap is not one of this sub\'s actions'))).toBe(true);
    const noSla = text.replace('escalate: { to: l0, sla_min: $policies.overload_case_sla_min }', 'escalate: { to: l0 }');
    expect(lintAgentYaml(noSla, guardianPkgDir()).errors.some(e => e.includes('host-overload: escalate.sla_min'))).toBe(true);
  });
});

describe('SUB-LADDER · OUT-OF-POLICY — detector → normalize → resolved · out of policy → escalate (kit/case-ledger)', () => {
  test('임대관: node-b overloaded → case · route-away (acting) → normal again → resolved · no card', () => {
    const h = harness();
    h.setProbes([{ host: 'node-b', reachable: true, load1: 135, ncpu: 32 }, { host: 'minim5', reachable: true, load1: 1.9, ncpu: 18 }, { host: 'node-c', reachable: true, load1: 3.8, ncpu: 14 }, { host: 'mbp', reachable: true, load1: 4.7, ncpu: 18 }]);
    const r1 = runResidentPulse(h.deps(T0));
    expect(r1.cases!.opened).toContain('host-overload:node-b');
    expect(r1.cases!.acting).toContain('host-overload:node-b');
    h.setProbes([{ host: 'node-b', reachable: true, load1: 20, ncpu: 32 }, { host: 'minim5', reachable: true, load1: 1.9, ncpu: 18 }, { host: 'node-c', reachable: true, load1: 3.8, ncpu: 14 }, { host: 'mbp', reachable: true, load1: 4.7, ncpu: 18 }]);
    const r2 = runResidentPulse(h.deps(at(16)));
    expect(r2.cases!.resolved).toContain('host-overload:node-b');
    const c = readCases(h.root, 'guardian-lease').find(x => x.id === 'host-overload:node-b')!;
    expect(c.history.map(x => x.state)).toEqual(['detected', 'acting', 'resolved']);
    expect(c.history[1]!.why).toBe('route-away: new work → minim5');
    expect(cardsTo(h.posts, 'guardian-case:')).toEqual([]);
  });

  test('맥박: outcome bad 90 min → the reattach card (out of policy) → escalated at once · no second card', () => {
    const h = harness({ badSupervisor: true });
    const r = runResidentPulse(h.deps(T0));
    expect(r.cases!.escalated).toContain('supervisor-bad:judge-butler');
    expect(cardsTo(h.posts, 'guardian-reattach:judge-butler').map(p => p.to)).toEqual(['JUD']);
    runResidentPulse(h.deps(at(100)));
    expect(cardsTo(h.posts, 'guardian-case:')).toEqual([]);
    expect(readCases(h.root, 'guardian-pulse').find(x => x.id === 'supervisor-bad:judge-butler')!.state).toBe('escalated');
  });

  test('맥박: a host that does not answer (no ladder) → one card to the L0 after 30 min → resolved when it answers', () => {
    const h = harness();
    const down: HostProbe[] = [{ host: 'node-b', reachable: true, load1: 4, ncpu: 32 }, { host: 'minim5', reachable: true, load1: 1.9, ncpu: 18 }, { host: 'node-c', reachable: true, load1: 3.8, ncpu: 14 }, { host: 'mbp', reachable: false, load1: null, ncpu: null, why: 'ssh timeout' }];
    h.setProbes(down);
    runResidentPulse(h.deps(T0));
    runResidentPulse(h.deps(at(16)));
    expect(cardsTo(h.posts, 'guardian-case:')).toEqual([]);
    runResidentPulse(h.deps(at(31)));
    const cs = cardsTo(h.posts, 'guardian-case:guardian-pulse:host-unreachable:mbp');
    expect(cs.map(p => p.to)).toEqual(['RES']);
    expect(cs[0]!.body).toContain('30분 안에 정상으로 돌아오지 않음');
    runResidentPulse(h.deps(at(47)));
    expect(cardsTo(h.posts, 'guardian-case:')).toHaveLength(1);
    h.setProbes(down.map(p => (p.host === 'mbp' ? { host: 'mbp', reachable: true, load1: 2, ncpu: 18 } : p)));
    const r = runResidentPulse(h.deps(at(63)));
    expect(r.cases!.resolved).toContain('host-unreachable:mbp');
  });
});

describe('KNOWHOW · RETRO · VOICE — v3 hooks on the guardian pulse', () => {
  test('same failure ×3 → one knowhow line with the cause (refresh-fuel keeps leaving the usage snapshot stale) · no second line', () => {
    const h = harness({ staleFuel: true });
    for (const m of [0, 31, 62, 93]) runResidentPulse(h.deps(at(m)));
    const learned = readFileSync(join(h.root, 'loop-agents', 'guardian', 'knowhow', 'learned.md'), 'utf8');
    const lines = learned.split('\n').filter(l => l.startsWith('## K-'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('refresh-fuel 반복 실패');
    expect(learned).toContain('refreshed but still stale');
    runResidentPulse(h.deps(at(124)));
    expect(readFileSync(join(h.root, 'loop-agents', 'guardian', 'knowhow', 'learned.md'), 'utf8').split('\n').filter(l => l.startsWith('## K-'))).toHaveLength(1);
  });

  test('a dead trigger is counted, never restarted or carded by the guardian (the registry owns it · LOOP-AGENTS-AS-PLUGINS P1)', () => {
    const h = harness({ deadSupervisor: true });
    for (const m of [0, 31, 62, 93, 124]) runResidentPulse(h.deps(at(m)));
    expect(h.posts.filter(p => p.key.includes('land-graph')).map(p => p.key.split(':')[0])).toEqual([]);
    expect(readPulseSnapshot(h.root)!.kpi.find(k => k.agent === 'pulse')!.value).toBe('감독자 결손 1/2 · 호스트 미응답 0');
  });

  test('6 h after the first pulse: one retro entry · the voice prompt carries the soul block and that retro', async () => {
    const h = harness({ deadSupervisor: true });
    runResidentPulse(h.deps(T0));
    expect(runResidentPulse(h.deps(at(180))).smart!.retro).toBeNull();
    const r = runResidentPulse(h.deps(at(361)));
    expect(r.smart!.retro).toMatch(/^회고 11-27T16:01Z \(6h\) — 잘 된 것: /u);
    runResidentPulse(h.deps(at(366)));
    const retros = readFileSync(join(h.root, 'loop-agents', 'guardian', 'v3', 'retros.jsonl'), 'utf8').trim().split('\n');
    expect(retros).toHaveLength(1);
    const c = cards(h.root);
    expect(c.perHour).toBe(12);
    let system = '';
    const view: GuardianView = { now: at(370), probes: [{ host: 'node-b', reachable: true, load1: 4, ncpu: 32 }], procs: new Map(), registry: new Map(), ready: null, hands: null };
    await guardianVoiceTurn({ id: 7, from: 'OP', body: '지금 세계 건강은?', at: at(370).toISOString(), channel: 'mail' }, view, {
      memory: h.memory, budgetOk: true, soulText: c.soulText, goalText: c.goalText,
      llm: { complete: async (s: string) => { system = s; return { text: '{"reply":"node-b 0.13 · 정상","actions":[]}', model: 'fake' }; } },
      cmds: { reap: () => '', route: () => '', proposeHands: () => '', escalate: () => '', demote: () => '' },
    });
    expect(system).toContain('## 영혼 (agent.yaml soul)');
    expect(system).toContain('- 목적: 연방의 몸을 지킨다');
    expect(system).toContain('## 최근 회고 (eln loop agent guardian retro)');
    expect(system).toContain('- KPI unnormalized_cases ≤ 0 건');
  });

  test('a refused agent.yaml runs on the last-known-good copy (and says so) · none at all → the policy read throws with the reason', () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-lkg-'));
    const pkg = join(root, 'graphs', 'loop-agents', 'guardian'); mkdirSync(pkg, { recursive: true });
    cpSync(guardianPkgDir(), pkg, { recursive: true });
    cpSync(join(REPO, 'graphs', 'triggers'), join(root, 'graphs', 'triggers'), { recursive: true });
    const state = join(root, 'state');
    expect(guardianDef({ dir: pkg, stateRoot: state, fresh: true }).source).toBe('agent.yaml');
    writeFileSync(join(pkg, 'agent.yaml'), readFileSync(join(pkg, 'agent.yaml'), 'utf8').replace('  scale_ratio: 2 ', '  scale_ratio: two '));
    const lkg = guardianDef({ dir: pkg, stateRoot: state, fresh: true });
    expect([lkg.source, lkg.policies.scale_ratio, lkg.subs.length]).toEqual(['last-known-good', 2, 7]);
    expect(lkg.errors.some(e => e.startsWith('policies.scale_ratio'))).toBe(true);
    const none = guardianDef({ dir: pkg, stateRoot: join(root, 'empty'), fresh: true });
    expect(none.source).toBe('none');
    expect(() => gp('scale_ratio')).toThrow('guardian policy scale_ratio unavailable (none');
  });
});
