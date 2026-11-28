// SIM-WORLD supervisors — the cases every v2 supervisor shares (CEO 11-27 11:5x «감독자들도 일을 제대로 만드는 계획을 오늘 안에
// 세우고 집행하고 시뮬월드에서 만들어라»). Per-supervisor wake → work → KPI → escalation scenarios live beside this file
// (run-lifecycle.ts · hygiene.ts · flow.ts); here:
//   SUP-SUBJECT-LOST  — «환자를 잃은 의사»: every supervisor whose subject cannot be read 3 ticks in a row proposes a reattach
//                       to its L0 once (never idle), says it in its channel, and keeps the KPI unknown (not 0).
//   SUP-GUARDIAN-PULSE — the guardian's resident pulse (src/guardian-agent/pulse.ts · #40362): dead supervisor → counted in the
//                       맥박 KPI only (the trigger registry refires and cards · P1) · bad 90 min → reattach proposal to its owner
//                       (never retire) · healthy untouched.
// Expectations are independent literals (rule 11): the seat names and counts below are written out, not read from the cards.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadCard } from '../../../loop-agent/card.js';
import { fileAgentMemory } from '../../../loop-agent/memory.js';
import { loadBody } from '../../../loop-agent/registry.js';
import { tickAgent, type AgentBody, type AgentPorts } from '../../../loop-agent/runtime.js';
import { fileMemory } from '../../../judge-butler/memory.js';
import { GUARDIAN_DEMOTERS, GUARDIAN_ID, GUARDIAN_SUPERVISOR, type GuardianPorts, type GuardianView } from '../../../guardian-agent/body.js';
import { runResidentPulse, type PulseDeps } from '../../../guardian-agent/pulse.js';
import { readPulseSnapshot } from '../../../guardian-agent/world.js';
import type { SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });

/** Literal L0 per supervisor (SUPERVISOR-REVIVE-1127 table) — not read from the cards. */
const L0: Readonly<Record<string, string>> = {
  'run-supervisor': 'TC', 'run-doctor': 'TC', autopsy: 'OP', macrophage: 'RES', 'train-manager': 'TC',
  'release-rocket': 'OP', 'silence-watch': 'OP', 'watchers-check': 'OP', 'hand-steward': 'OP',
};

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'SUP-SUBJECT-LOST',
    title: 'every supervisor: subject unreadable 3 ticks → one reattach proposal to its L0 (not idle) · KPI stays unknown · reading again resets',
    async run(ctx) {
      const rows: Array<{ id: string; seed: number; lostAt: number[]; posts: string[]; spoke: number; kpis: Array<number | null> }> = [];
      for (const seed of [ctx.seed, ctx.seed + 1, ctx.seed + 2]) {
        for (const id of Object.keys(L0)) {
          const stateRoot = join(ctx.universeRoot, `s${seed}`, id);
          mkdirSync(stateRoot, { recursive: true });
          const card = loadCard(id);
          const real = await loadBody(id, { stateRoot, card });
          // The subject is gone: the source the body watched returns nothing (KPI unknown · no subject · one fact why).
          const gone: AgentBody = { ...real, observe: () => ({ kpi: null, subjects: [], facts: [`${id} source gone (seed ${seed})`] }) };
          const posts: Array<{ key: string; to: string }> = []; let spoke = 0;
          const ports: AgentPorts = { memory: fileAgentMemory(stateRoot, id, card.supervisor), post: (key, to) => { if (posts.some(p => p.key === key)) return null; posts.push({ key, to }); return posts.length; }, beat: () => undefined, speak: () => { spoke += 1; }, llm: null };
          const lostAt: number[] = []; const kpis: Array<number | null> = [];
          let t = Date.parse('2026-11-27T12:00:00Z') + seed * 60_000;
          for (let i = 1; i <= 4; i++) {
            const r = await tickAgent(card, gone, ports, new Date(t));
            if (r.subjectLost) lostAt.push(i);
            kpis.push(r.kpi);
            t += 10 * 60_000;
          }
          rows.push({ id, seed, lostAt, posts: posts.map(p => `${p.key.split(':')[0]}→${p.to}`), spoke, kpis });
          if (JSON.stringify(lostAt) !== '[3]') return fail('reattach-not-proposed', `${id} seed ${seed}: subjectLost on ticks ${JSON.stringify(lostAt)} (want [3])`);
          if (JSON.stringify(posts.map(p => `${p.key.split(':')[0]}→${p.to}`)) !== JSON.stringify([`subject-lost→${L0[id]}`])) return fail('wrong-escalation', `${id} seed ${seed}: posts ${JSON.stringify(posts)} (want one subject-lost to ${L0[id]})`);
          if (spoke !== 1) return fail('silent', `${id} seed ${seed}: spoke ${spoke} lines (want 1)`);
          if (kpis.some(k => k !== null)) return fail('unknown-read-as-zero', `${id} seed ${seed}: KPI ${JSON.stringify(kpis)} (want all null)`);
        }
      }
      ctx.recorder.event('sup:subject-lost', { rows: rows.length, agents: Object.keys(L0).length });
      return { ok: true };
    },
  },
  {
    id: 'SUP-GUARDIAN-PULSE',
    title: 'guardian pulse (수호자 맥박): a dead supervisor is counted, never restarted or carded here (the trigger registry owns it · LOOP-AGENTS-AS-PLUGINS P1) · a long-bad one gets a reattach proposal to its owner · healthy ones untouched',
    async run(ctx) {
      // Literal cases per seed: which supervisor is dead, its owner, and which one has been bad for 90 min.
      const CASES = [
        { dead: 'land-graph', owner: 'TC', bad: 'judge-butler', badOwner: 'OP' },
        { dead: 'op-bulletin', owner: 'OP', bad: 'land-graph', badOwner: 'TC' },
        { dead: 'judge-butler', owner: 'OP', bad: 'op-bulletin', badOwner: 'OP' },
      ] as const;
      const rows: unknown[] = [];
      for (const seed of [ctx.seed, ctx.seed + 1, ctx.seed + 2]) {
        const c = CASES[((seed % 3) + 3) % 3]!;
        const root = join(ctx.universeRoot, `guardian-s${seed}`);
        mkdirSync(root, { recursive: true });
        const memory = fileMemory(root, { agent: GUARDIAN_ID, supervisor: GUARDIAN_SUPERVISOR, demoters: GUARDIAN_DEMOTERS });
        const now = new Date(Date.parse('2026-11-27T10:00:00Z') + seed * 60_000);
        const at = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
        const posts: Array<{ to: string; body: string }> = [];
        const view: GuardianView = { now, probes: [{ host: 'minim5', reachable: true, load1: 2, ncpu: 18 }], procs: new Map(), registry: new Map(), ready: { total: 0, p0: 0 }, hands: [] };
        const ports: GuardianPorts = { memory, kill: () => ({ killed: [], skipped: [] }), writeRoute: () => {}, post: (_k, to, body) => { posts.push({ to, body }); return posts.length; }, audit: () => {} };
        const ids = ['land-graph', 'judge-butler', 'op-bulletin'];
        const owners: Record<string, string> = { 'land-graph': 'TC', 'judge-butler': 'OP', 'op-bulletin': 'OP' };
        const deps: PulseDeps = {
          stateRoot: root, now, memory,
          probes: () => [...view.probes], fuelSnapshot: () => null, refreshFuel: () => {}, credentials: () => [], scanSecrets: () => [],
          supervisors: () => ids.map(id => ({ id, owner: owners[id]!, everyMin: 10, via: 'trigger' as const, lastStatus: 'done',
            lastAt: at(id === c.dead ? 120 : 3), badSince: id === c.bad ? at(90) : null })),
          post: (_k, to, body) => { posts.push({ to, body }); return posts.length; },
          heavy: () => ({ view, ports, close: () => {} }),
          beat: () => {},
        };
        runResidentPulse(deps);
        runResidentPulse({ ...deps, now: new Date(now.getTime() + 2 * 60_000) });
        const kpi = readPulseSnapshot(root)?.kpi.find(k => k.agent === 'pulse')?.value ?? null;
        rows.push({ seed, to: posts.map(p => p.to), kpi });
        if (posts.some(p => p.body.includes(c.dead) && !p.body.includes('재부착 제안'))) return fail('guardian-carded-dead', `seed ${seed}: the guardian carded ${c.dead} — the registry owns a dead trigger: ${JSON.stringify(posts.map(p => [p.to, p.body.slice(0, 80)]))}`);
        if (kpi !== '감독자 결손 2/3 · 호스트 미응답 0') return fail('kpi', `seed ${seed}: 맥박 KPI ${kpi} (want 감독자 결손 2/3 · 호스트 미응답 0)`);
        if (!posts.some(p => p.to === c.badOwner && p.body.includes('재부착 제안') && p.body.includes(c.bad))) return fail('no-reattach', `seed ${seed}: no reattach proposal to ${c.badOwner} for ${c.bad}: ${JSON.stringify(posts.map(p => [p.to, p.body.slice(0, 80)]))}`);
      }
      ctx.recorder.event('sup:guardian-pulse', { rows });
      return { ok: true };
    },
  },
];
