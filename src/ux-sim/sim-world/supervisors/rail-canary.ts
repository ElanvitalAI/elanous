// SIM-WORLD supervisors · RAIL-CANARY-AUTO-ROLLBACK — the loop agent rail-canary (an agent.yaml instance of the shared kind
// canary.check) on the REAL path: supervisorTick over graphs/loop-agents/rail-canary/agent.yaml (policies · authority · HOLD gate)
// ⊕ the REAL probe pack graphs/policies/rail-canary.yaml ⊕ the real kit judgment and state file in this universe. Only the doors
// are fakes: install.json · the els server (its seat answer depends on the build it was last restarted with) · the fed snapshot ·
// the gh ledger % · `eln self-update --rollback` (swaps commit ↔ previous like rollbackDevInstall) · launchctl · git log · mail.
// Literal expectations (OPS-RULES 11) · LLM 0 · no ssh · no real install.
//   SUP-CANARY-REGRESS: a #40735-shaped build (els restarted at +3 → every pane seat=null · fed hands 0) → rollback at +6 (≤ 10 min
//                       after the swap) · els ⊕ nexus restarted · one OP card naming #40735 · verify at +11 = fixed · KPI 0/0
//   SUP-CANARY-HEALTHY: a healthy swap ticked +1…+36 → no rollback · no card · the window closes at +30
//   SUP-CANARY-FLAP:    a probe that fails then passes on the confirm re-read (every tick) → no rollback · then a real regression of
//                       another build → ONE rollback · the rail re-installs that build and it regresses again → no second rollback,
//                       one «한도» card
//   SUP-CANARY-HOLD:    a regression under an active HOLD on cell RAIL → held (no rollback, journal «held») · HOLD lifted → rollback
//   SUP-CANARY-FALSE:   the OP GitHub budget jumps to 99% after the swap for a reason outside the build → rollback → still 99% on the
//                       old build after verify_min → one «되돌림 효과 없음» card · KPI false_rollbacks 1
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadCard } from '../../../loop-agent/card.js';
import { agentHome, fileAgentMemory } from '../../../loop-agent/memory.js';
import { readJournal } from '../../../loop-agent/journal.js';
import type { AgentPorts, TickReport } from '../../../loop-agent/runtime.js';
import { supervisorTick } from '../../../loop-agent/v3/supervisor.js';
import { createCanaryBody, type CanaryDeps, type RunResult } from '../../../loop-agent/v3/canary-kind.js';
import { parseCanaryPack, readCanaryState } from '../../../kit/canary/index.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const REPO = resolve(import.meta.dir, '../../../..');
const CANARY = 'rail-canary';
const T0 = Date.parse('2026-11-28T14:00:00Z');
const MIN = 60_000; // 출처: one minute in ms (scenario clock unit, not a bound)
const at = (min: number) => new Date(T0 + min * MIN);
const fail = (reason: string, diff: unknown): SimWorldScenarioOutcome => ({ ok: false, reason, diff: typeof diff === 'string' ? diff : JSON.stringify(diff) });
const A = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'; const B = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2'; const C = 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';
const Z = 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0';
const dir = (sha: string) => `versions/0.3.40-dev.0-${sha.slice(0, 12)}`;
const SEATS = ['OP', 'JUD', 'TC', 'HAND-A', 'HAND-B', 'HAND-C', 'MK', 'UX'];

/** A host: install.json ⊕ an els server that answers with the build it was last restarted with ⊕ the other probe sources. */
function world(ctx: SimWorldScenarioContext, o: { badBuilds: readonly string[]; flapBuilds?: readonly string[]; ghPct?: (min: number) => number; hold?: (min: number) => string | null }) {
  const stateRoot = join(ctx.universeRoot, 'state'); mkdirSync(stateRoot, { recursive: true });
  let clock = T0 - 30 * MIN;
  const install: { commit: string; previous: string; installedAt: string; versionDir: string } = { commit: A, previous: dir(Z), installedAt: at(-120).toISOString(), versionDir: dir(A) };
  let elsBuild = A; let flapRead = 0;
  const doors: string[] = []; const mails: Array<{ key: string; to: string; body: string }> = []; const keys = new Set<string>();
  const post = (key: string, to: string, body: string) => { if (keys.has(key)) return null; keys.add(key); mails.push({ key, to, body }); return mails.length; };
  const nowMin = () => Math.round((clock - T0) / MIN);
  const handsOf = (build: string) => (o.badBuilds.includes(build) ? 0 : SEATS.length);
  const res = (code: number, stdout = '', stderr = ''): RunResult => ({ code, stdout, stderr, timedOut: false });
  const deps: CanaryDeps = {
    pack: () => parseCanaryPack(readFileSync(join(REPO, 'graphs', 'policies', 'rail-canary.yaml'), 'utf8')).pack!,
    installRecord: () => ({ ...install }),
    run(argv) {
      const line = argv.join(' ');
      if (line.includes(' side ls --json')) {
        // a flapping build: the first read of a tick fails, the confirm re-read passes
        const flap = nowMin() < 60 && (o.flapBuilds ?? []).includes(elsBuild) && (flapRead++ % 2 === 0); // flaps for the first hour only
        const bad = o.badBuilds.includes(elsBuild) || flap;
        return res(0, JSON.stringify({ panes: SEATS.map(s => ({ seat: bad ? null : s })) }));
      }
      if (line.includes('remote get-url origin')) return res(0, 'git@github.com:ElanvitalAI/elanous.git\n');
      if (line.includes('self-update --rollback')) {
        doors.push(`rollback@${nowMin()}`);
        const cur = install.versionDir; const prev = install.previous;
        const sha = /-([0-9a-f]{12})$/u.exec(prev)?.[1];
        const to = [A, B, C, Z].find(s => s.startsWith(sha ?? '-'));
        if (!to) return res(2, '', 'no previous');
        Object.assign(install, { commit: to, versionDir: prev, previous: cur, installedAt: new Date(clock).toISOString() });
        return res(0, JSON.stringify({ exitCode: 0, current: prev }));
      }
      if (argv[0] === 'launchctl') { const svc = argv[3] ?? ''; doors.push(`${svc.split('/').pop()}@${nowMin()}`); if (svc.endsWith('dev.elanous.els')) elsBuild = install.commit; return res(0); }
      return res(127, '', `unknown door ${line}`);
    },
    readFile(path) {
      if (path.endsWith('land-steward/last-tick.json')) return { text: JSON.stringify({ at: new Date(clock - 4 * MIN).toISOString() }), mtimeMs: clock - 4 * MIN };
      if (path.endsWith('fed-state/snapshots/latest.json')) { const h = handsOf(elsBuild); return { text: JSON.stringify({ totals: { hands: { idle: h, holding: 0, working: 0, noPane: SEATS.length - h } } }), mtimeMs: clock - MIN }; }
      return null;
    },
    sensor: () => (o.ghPct ? o.ghPct(nowMin()) : 10),
    sleep: async () => {},
    suspects: (_repo, from, to) => (from.startsWith('a1a1') && (to.startsWith('b2b2') || to.startsWith('c3c3')) ? [{ pr: 40735, sha: to, title: 'fix(els): seat inference only for eln commands' }, { pr: 40730, sha: '9'.repeat(40), title: 'docs: x' }] : []),
    post: (key, to, body) => post(key, to, body),
    vars: { stateRoot, installRoot: join(ctx.universeRoot, 'install'), hqRepo: '/hq', uid: '501', eln: ['bun', '/pkg/bin/elanous.mjs'] },
  };
  const card = loadCard(CANARY);
  const body = createCanaryBody({ stateRoot, card }, deps);
  const ports: AgentPorts = { memory: fileAgentMemory(stateRoot, CANARY, card.supervisor), post: (k, to, b) => post(k, to, b), beat: () => {},
    ...(o.hold ? { holdOn: () => o.hold!(nowMin()) } : {}) };
  const tick = async (min: number): Promise<TickReport> => { clock = T0 + min * MIN; return (await supervisorTick(card, body, ports, at(min))).report; };
  /** The rail: install a new build (the els server keeps the old one until the rail's own els-refresh at `elsAfter`). */
  const rail = (sha: string, min: number) => { Object.assign(install, { previous: install.versionDir, versionDir: dir(sha), commit: sha, installedAt: at(min).toISOString() }); };
  const elsRefresh = () => { elsBuild = install.commit; };
  const state = () => readCanaryState(agentHome(stateRoot, CANARY));
  return { stateRoot, install, doors, mails, tick, rail, elsRefresh, state, home: agentHome(stateRoot, CANARY) };
}
const sha12 = (s: string) => s.slice(0, 12);
const acted = (r: TickReport) => r.acted;

async function regress(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome> {
  const w = world(ctx, { badBuilds: [B] });
  await w.tick(-10); await w.tick(-5);                 // baseline on A
  w.rail(B, 0);
  const r1 = await w.tick(1);                          // els still the old server → probes pass
  w.elsRefresh();                                      // +3: the rail restarts els on B → every pane seat=null
  const r2 = await w.tick(6);
  const r3 = await w.tick(11);
  const s = w.state();
  const card = w.mails.find(m => m.key === `rail-canary:rollback:${sha12(B)}`);
  const obs = { acted: [acted(r1), acted(r2), acted(r3)], installed: sha12(w.install.commit), doors: w.doors, rollbacks: s.rollbacks.map(r => `${r.from}>${r.to}:${r.probes.join('+')}:${r.minutes}:${r.verdict}`),
    swapToRollbackMin: s.rollbacks[0] ? Math.round((Date.parse(s.rollbacks[0].at) - T0) / MIN) : null, cardTo: card?.to ?? null,
    card: card ? ['#40735', 'seat-panes', '8→0', 'eln self-update --rollback', '재기동: els ok · nexus ok'].map(x => card.body.includes(x)) : null, kpi: [r2.kpi, r3.kpi], mails: w.mails.length };
  ctx.recorder.event('sup:canary-regress', obs);
  const want = { acted: [[], [`rollback:RAIL@${sha12(B)}`], []], installed: sha12(A), doors: ['rollback@6', 'dev.elanous.els@6', 'com.elanous.nexus@6'],
    rollbacks: [`${sha12(B)}>${sha12(A)}:seat-panes+fed-hands:0:fixed`], swapToRollbackMin: 6, cardTo: 'OP', card: [true, true, true, true, true], kpi: [0, 0], mails: 1 };
  if (JSON.stringify(obs) !== JSON.stringify(want)) return fail('regress-rollback', obs);
  return { ok: true };
}

async function healthy(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome> {
  const w = world(ctx, { badBuilds: [] });
  await w.tick(-10); await w.tick(-5);
  w.rail(B, 0);
  const reports: TickReport[] = [];
  for (const m of [1, 6, 11, 16, 21, 26, 31, 36]) { if (m === 6) w.elsRefresh(); reports.push(await w.tick(m)); }
  const s = w.state();
  const obs = { acted: reports.flatMap(acted), doors: w.doors, mails: w.mails.length, installed: sha12(w.install.commit), rollbacks: s.rollbacks.length, kpi: reports.map(r => r.kpi),
    state: `${s.origin}:${s.sha}:${s.prevSha}:${s.failSince}`, probesOk: Object.values(s.readings[s.sha!] ?? {}).map(r => r.ok) };
  ctx.recorder.event('sup:canary-healthy', obs);
  const want = { acted: [], doors: [], mails: 0, installed: sha12(B), rollbacks: 0, kpi: [0, 0, 0, 0, 0, 0, 0, 0], state: `swap:${sha12(B)}:${sha12(A)}:null`, probesOk: [true, true, true, true, true] };
  if (JSON.stringify(obs) !== JSON.stringify(want)) return fail('healthy-no-rollback', obs);
  return { ok: true };
}

async function flap(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome> {
  const w = world(ctx, { badBuilds: [C], flapBuilds: [B] });
  await w.tick(-10); await w.tick(-5);
  w.rail(B, 0); w.elsRefresh();
  const flapActs: string[] = [];
  for (const m of [1, 6, 11, 16]) flapActs.push(...acted(await w.tick(m)));
  // a real regression on the next rail (C) → one rollback to B (the build watched healthy before it)
  w.rail(C, 120); w.elsRefresh();
  const r1 = await w.tick(121);
  await w.tick(126);
  // the next rail re-installs C (main not fixed yet) and it regresses again
  w.rail(C, 240); w.elsRefresh();
  const r2 = await w.tick(241); const r3 = await w.tick(246);
  const s = w.state();
  const obs = { flapActs, rollbackAct: acted(r1), again: [acted(r2), acted(r3)], rollbacks: s.rollbacks.map(r => `${r.from}>${r.to}`), installed: sha12(w.install.commit),
    mails: w.mails.map(m => m.key), limitTo: w.mails.find(m => m.key.startsWith('rail-canary:limit:'))?.to ?? null };
  ctx.recorder.event('sup:canary-flap', obs);
  const want = { flapActs: [], rollbackAct: [`rollback:RAIL@${sha12(C)}`], again: [[`card:limit:${sha12(C)}`], []], rollbacks: [`${sha12(C)}>${sha12(B)}`], installed: sha12(C),
    mails: [`rail-canary:rollback:${sha12(C)}`, `rail-canary:limit:${sha12(C)}`], limitTo: 'OP' };
  if (JSON.stringify(obs) !== JSON.stringify(want)) return fail('flap-one-rollback', obs);
  return { ok: true };
}

async function hold(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome> {
  const w = world(ctx, { badBuilds: [B], hold: m => (m < 10 ? 'H-RAIL-1 (OP · RAIL · ~14:30Z)' : null) });
  await w.tick(-10); await w.tick(-5);
  w.rail(B, 0); w.elsRefresh();
  const r1 = await w.tick(1); const r2 = await w.tick(6); const r3 = await w.tick(11);
  const held = readJournal(w.home, T0, T0 + 12 * MIN).filter(j => j.action === 'rollback').map(j => `${j.status}`);
  const obs = { acted: [acted(r1), acted(r2), acted(r3)], deferred: [r1.deferred?.length ?? 0, r2.deferred?.length ?? 0], held, doors: w.doors.filter(d => d.startsWith('rollback')), installed: sha12(w.install.commit) };
  ctx.recorder.event('sup:canary-hold', obs);
  const want = { acted: [[], [], [`rollback:RAIL@${sha12(B)}`]], deferred: [1, 1], held: ['refused', 'refused', 'acted'], doors: ['rollback@11'], installed: sha12(A) };
  if (JSON.stringify(obs) !== JSON.stringify(want)) return fail('hold-respected', obs);
  return { ok: true };
}

async function falseRollback(ctx: SimWorldScenarioContext): Promise<SimWorldScenarioOutcome> {
  const w = world(ctx, { badBuilds: [], ghPct: m => (m >= 4 ? 99 : 10) });
  await w.tick(-10); await w.tick(-5);
  w.rail(B, 0); w.elsRefresh();
  const r1 = await w.tick(6); const r2 = await w.tick(11); const r3 = await w.tick(21); const r4 = await w.tick(26);
  const s = w.state();
  const card = w.mails.find(m => m.key.startsWith('rail-canary:false-rollback:'));
  const obs = { acted: [acted(r1), acted(r2), acted(r3), acted(r4)], verdicts: s.rollbacks.map(r => `${r.probes.join('+')}:${r.verdict}`), installed: sha12(w.install.commit),
    card: card ? [card.to, card.body.includes('거짓 되돌림'), card.body.includes('eln self-update --rollback')] : null,
    kpi: JSON.parse(readFileSync(join(w.home, 'canary.json'), 'utf8')).kpi as unknown };
  ctx.recorder.event('sup:canary-false', obs);
  const want = { acted: [[`rollback:RAIL@${sha12(B)}`], [], [`card:false-rollback:${sha12(B)}`], []], verdicts: ['op-gh-budget:false'], installed: sha12(A),
    card: ['OP', true, true], kpi: { canary_fail_to_rollback_minutes: 0, false_rollbacks: 1 } };
  if (JSON.stringify(obs) !== JSON.stringify(want)) return fail('false-rollback-card', obs);
  return { ok: true };
}

export const simWorldScenarios: readonly SimWorldScenario[] = [
  { id: 'SUP-CANARY-REGRESS', title: 'rail-canary (canary.check kind): #40735-shaped build (els seat=null from +3) → rollback at +6 · els ⊕ nexus restarted · one OP card naming #40735 · verify fixed at +11', run: regress },
  { id: 'SUP-CANARY-HEALTHY', title: 'rail-canary: healthy swap ticked +1…+36 → no rollback · no card · window closed after +30', run: healthy },
  { id: 'SUP-CANARY-FLAP', title: 'rail-canary: a probe that recovers on the confirm re-read → no rollback · a real regression → one rollback · the same build re-installed and regressing → no second rollback, one limit card', run: flap },
  { id: 'SUP-CANARY-HOLD', title: 'rail-canary: regression under an active HOLD on RAIL → held twice (journal) · HOLD lifted → rollback', run: hold },
  { id: 'SUP-CANARY-FALSE', title: 'rail-canary: OP GitHub budget 99% after the swap (not the build) → rollback → still 99% after verify_min → one «되돌림 효과 없음» card · KPI false_rollbacks 1', run: falseRollback },
];
