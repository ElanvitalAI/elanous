// SIM-WORLD guardian — GUARDIAN-SUBS (대표 11-28 07:5x «미구현 순찰대·우체국 구현 · 나머지 정상화» · «시뮬레이션 월드에서 충분한
// 시나리오 검증을 하고 시작» · 08:0x «7일치 합성 사용량 곡선 · 하나라도 FAIL 이면 운영 적용·착지 금지»).
// Device GUARDIAN-WORLD = the REAL guardian pulse (runResidentPulse · agent.yaml · ladders · kit/case-ledger) inside the
// scenario's universe: peers (run-supervisor · run-doctor · autopsy · silence-watch · rail-watch) are their tick files, the
// trigger registry is the supervisors port, mail is recorded (no ssh · no kill · no mail · LLM 0). LOOP-AGENTS-AS-PLUGINS P1:
// the guardian has no wake port any more — `wakes` stays as the witness that it wakes nobody (the registry owns a silent peer). The fuel
// scenarios drive the real llm-accounts pack (repo pack ⊕ the ops overlay shape) through runFuelPhase → llmAccountDecision.
// Every expectation is an independent literal (rule 11); the seed (ctx.random) only moves numbers that must not move a verdict.
import { appendFileSync, copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileMemory, type ButlerMemory } from '../../../judge-butler/memory.js';
import { openCase, readCases, moveCase } from '../../../kit/case-ledger/index.js';
import { resetLlmAccountPackCache } from '../../../kit/resource-facts/llm-accounts.js';
import { llmAccountDecision, resetAppliedBeats, resetLlmDecisionCache } from '../../../kit/resource-facts/llm-decide.js';
import { GUARDIAN_DEMOTERS, GUARDIAN_ID, GUARDIAN_SUPERVISOR, type GuardianPorts, type GuardianView } from '../../../guardian-agent/body.js';
import { resetGuardianDef } from '../../../guardian-agent/def.js';
import { accountEntries, annotateRoutes, judgeFuel, type UsageAccount } from '../../../guardian-agent/fuel.js';
import { runFuelPhase, type FuelPhasePorts } from '../../../guardian-agent/fuel-phase-run.js';
import type { HostProbe } from '../../../guardian-agent/hosts.js';
import { credentialEntries, judgeKeys, type CredentialIn } from '../../../guardian-agent/keys.js';
import { refreshAdvanced, type KeyCard, type KeyRefreshResult } from '../../../kit/credential-keeper/index.js';
import { applySeatModelDirective, directiveFor, handPlan, noModelFallback, pickHandModel, readSeatModelDirective, usedShareFromSnapshot, writeSeatModelDirective } from '../../../seat/model-by-difficulty.js';
import { clearSessionProvider, getSessionProvider, setSessionProvider } from '../../../tui-client/session-provider.js';
import { codexTokenAxis, formatUnifiedUsage } from '../../../budget/unified-usage.js';
import { runKpiRollup } from '../../../kit/kpi/rollup.js';
import { guardianDef } from '../../../guardian-agent/def.js';
import { codexHomeMeta, liveFuelRoutes, runResidentPulse, type PulseDeps, type PulseReport } from '../../../guardian-agent/pulse.js';
import type { SupervisorIn } from '../../../guardian-agent/world.js';
import type { SimWorldDeviceDef, SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';
import { burstScenarios, burstWorldDevice, type BurstWorld } from './burst-scenes.js';

const DEVICE = 'GUARDIAN-WORLD';
const REPO = resolve(import.meta.dir, '../../../..');
const T0 = new Date('2026-11-28T00:00:00.000Z'); // 09:00 KST
// 출처: sim clock units — one minute in ms (a time unit, not a tuning bound)
const MIN = 60_000;
const at = (m: number) => new Date(T0.getTime() + m * MIN);
const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const between = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

/** The ops overlay shape (~/.elanous/resource-facts/llm-accounts.yaml 11-28) — literal, so a pack change shows here. */
const OPS_OVERLAY = `providers:
  openai-codex:
    credit_order: by_balance_desc
    accounts:
      team:  { credits: until_reset }
      third: { credits: until_reset }
      default: { credits: true }
`;

export interface PeerTickIn { kpi: number | null; kpiOk: boolean | null; ageMin: number; acted?: string[]; refused?: string[]; error?: string; bounce?: string[]; breachSinceMin?: number; escalatedRef?: string }
export interface GuardianWorld {
  readonly root: string;
  readonly memory: ButlerMemory;
  readonly posts: Array<{ key: string; to: string; body: string }>;
  readonly wakes: Array<{ id: string; at: string }>;
  /** registered triggers (the 맥박 sees them ok unless `lastAgeMin` says the registry has not fired them · `badSinceMin` = its outcome probe bad that long) — peers absent here are «not installed» */
  triggers: Array<{ id: string; owner: string; lastAgeMin?: number; badSinceMin?: number }>;
  installed: string | null;
  creds: CredentialIn[];
  /** KEYS-PROACTIVE-REFRESH: the scripted CLI refresh (null = the port is absent) · calls and raised cards are recorded */
  refresh: ((home: string, now: Date) => KeyRefreshResult) | null;
  readonly refreshCalls: Array<{ home: string; at: string }>;
  readonly keyCards: Array<{ ref: string; card: KeyCard }>;
  usage: UsageAccount[];
  balances: Record<string, number | null>;
  tick(id: string, now: Date, t: PeerTickIn): void;
  rail(now: Date, r: { sha: string; ageMin: number; smoke: Record<string, boolean>; carded?: string[] }): void;
  /** `defDir` = an edited copy of the guardian package (CODE-BODY-TO-KIND scenes: a YAML param change alone) */
  deps(now: Date, o?: { fuel?: boolean; defDir?: string }): PulseDeps;
  pulse(now: Date, o?: { fuel?: boolean; defDir?: string }): PulseReport;
  /** env for the llm-accounts pack/ledger inside this universe (restored by the returned function) */
  packEnv(): () => void;
  fuelPorts(now: Date): FuelPhasePorts;
}

export const simWorldDevices: readonly (SimWorldDeviceDef<GuardianWorld> | SimWorldDeviceDef<BurstWorld>)[] = [{
  id: DEVICE,
  title: 'GUARDIAN-SUBS — the real guardian pulse with peer tick files, a trigger table, recorded wakes and mail (LLM 0)',
  create: (ctx) => {
    const root = join(ctx.universeRoot, 'state');
    mkdirSync(root, { recursive: true });
    resetGuardianDef();
    const memory = fileMemory(root, { agent: GUARDIAN_ID, supervisor: GUARDIAN_SUPERVISOR, demoters: GUARDIAN_DEMOTERS });
    const posts: GuardianWorld['posts'] = []; const wakes: GuardianWorld['wakes'] = [];
    const post = (key: string, to: string, body: string): number | null => { if (posts.some(p => p.key === key)) return 0; posts.push({ key, to, body }); return 700 + posts.length; };
    const probes: HostProbe[] = [{ host: 'node-b', reachable: true, load1: 4, ncpu: 32 }, { host: 'minim5', reachable: true, load1: 2, ncpu: 18 }, { host: 'node-c', reachable: true, load1: 2, ncpu: 14 }, { host: 'mbp', reachable: true, load1: 3, ncpu: 18 }];
    const fuelSent: Record<string, string> = {};
    const w: GuardianWorld = {
      root, memory, posts, wakes,
      triggers: [{ id: 'run-supervisor-agent', owner: 'TC' }, { id: 'run-doctor-agent', owner: 'TC' }, { id: 'autopsy-agent', owner: 'OP' }, { id: 'silence-watch-agent', owner: 'OP' }, { id: 'rail-watch', owner: 'TC' }],
      installed: null, creds: [], refresh: null, refreshCalls: [], keyCards: [], usage: [{ provider: 'codex', account: 'team', usedPercent: 20, status: 'ok' }], balances: {},
      tick(id, now, t) {
        const home = join(root, 'loop-agents', id); mkdirSync(home, { recursive: true });
        const tickAt = new Date(now.getTime() - t.ageMin * MIN).toISOString();
        writeFileSync(join(home, 'last-tick.json'), JSON.stringify({ id, at: tickAt, level: 'live', kpi: t.kpi, kpiOk: t.kpiOk, kpiLine: `${id} kpi ${t.kpi ?? '?'}`, subjects: 0, planned: 0,
          acted: t.acted ?? [], refused: t.refused ?? [], failed: [], breach: t.kpiOk === false ? 'ongoing' : null, escalated: false, ...(t.error ? { error: t.error } : {}),
          plan: { purpose: '-', lines: (t.bounce ?? []).map(to => ({ action: 'bounce', target: to, why: `${to} 읽는 몸 없음` })) } }));
        const since = t.kpiOk === false ? new Date(now.getTime() - (t.breachSinceMin ?? 60) * MIN).toISOString() : null;
        writeFileSync(join(home, 'state.json'), JSON.stringify({ breachSince: since }));
        if (t.escalatedRef && since) appendFileSync(join(home, 'cases.jsonl'), `${JSON.stringify({ at: new Date(Date.parse(since) + MIN).toISOString(), kind: 'escalate', subject: 'kpi', why: 'L0 card', refs: [t.escalatedRef] })}\n`);
      },
      rail(now, r) {
        mkdirSync(join(root, 'land-graph'), { recursive: true });
        writeFileSync(join(root, 'land-graph', 'rail-watch.json'), JSON.stringify({ sha: r.sha, at: new Date(now.getTime() - r.ageMin * MIN).toISOString(), smoke: r.smoke, carded: r.carded ?? [] }));
      },
      deps(now, o = {}) {
        const supervisors = (): SupervisorIn[] => w.triggers.map(t => ({ id: t.id, owner: t.owner, everyMin: 10, lastAt: new Date(now.getTime() - (t.lastAgeMin ?? 2) * MIN).toISOString(), lastStatus: 'done',
          badSince: t.badSinceMin ? new Date(now.getTime() - t.badSinceMin * MIN).toISOString() : null, via: 'trigger' as const }));
        const view = (n: Date): GuardianView => ({ now: n, probes, procs: new Map([['node-b', []]]), registry: new Map(), ready: null, hands: null });
        const ports: GuardianPorts = { memory, kill: () => ({ killed: [], skipped: [] }), writeRoute: () => {}, post, audit: () => {} };
        return {
          stateRoot: root, now, memory, ...(o.defDir ? { defDir: o.defDir } : {}), probes: () => probes,
          fuelSnapshot: () => ({ ts: now.getTime(), accounts: w.usage }),
          credentials: () => w.creds, scanSecrets: () => [], refreshFuel: () => {},
          ...(w.refresh ? { refreshKey: (home: string) => { w.refreshCalls.push({ home, at: now.toISOString() }); return w.refresh!(home, now); } } : {}),
          raiseKeyCard: (card: KeyCard, ref: string) => { if (w.keyCards.some(c => c.ref === ref)) return null; w.keyCards.push({ ref, card }); return `D-${w.keyCards.length}`; },
          supervisors, post,
          heavy: () => ({ view: view(now), ports, close: () => {} }), beat: () => {},
          installedSha: () => w.installed,
          ...(o.fuel ? { fuelRoutes: () => { resetLlmDecisionCache(); return liveFuelRoutes(now); }, fuelPhase: (sent: Readonly<Record<string, string>>, mark: (k: string, v: string) => void) => ({ ...w.fuelPorts(now), sent: { ...sent, ...fuelSent }, mark: (k: string, v: string) => { fuelSent[k] = v; mark(k, v); } }) } : {}),
        };
      },
      pulse(now, o = {}) { return runResidentPulse(w.deps(now, o)); },
      packEnv() {
        const keys = ['LLM_ACCOUNT_POLICY_PACK', 'LLM_ACCOUNT_POLICY_OVERLAY', 'RESOURCE_FACTS_LEDGER', 'ELANOUS_STATE_DIR'] as const;
        const saved = Object.fromEntries(keys.map(k => [k, process.env[k]] as const));
        const dir = join(ctx.universeRoot, 'policy'); mkdirSync(dir, { recursive: true });
        copyFileSync(join(REPO, 'graphs', 'policies', 'llm-accounts.yaml'), join(dir, 'pack.yaml'));
        writeFileSync(join(dir, 'overlay.yaml'), OPS_OVERLAY);
        process.env.LLM_ACCOUNT_POLICY_PACK = join(dir, 'pack.yaml'); process.env.LLM_ACCOUNT_POLICY_OVERLAY = join(dir, 'overlay.yaml');
        process.env.RESOURCE_FACTS_LEDGER = join(dir, 'events.jsonl'); process.env.ELANOUS_STATE_DIR = join(ctx.universeRoot, 'elanous-state');
        resetLlmAccountPackCache(); resetLlmDecisionCache(); resetAppliedBeats();
        return () => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } resetLlmAccountPackCache(); resetLlmDecisionCache(); };
      },
      fuelPorts(now) {
        return { now, day: now.toISOString().slice(0, 10), sent: { ...fuelSent }, mark: (k, v) => { fuelSent[k] = v; },
          usage: () => w.usage, credits: () => ({ ...w.balances }), maintenance: () => false,
          raise: () => null, decided: () => null, journal: () => {}, paceStateDir: join(ctx.universeRoot, 'pace'), ledgerPath: process.env.RESOURCE_FACTS_LEDGER };
      },
    };
    return w;
  },
}, burstWorldDevice];

// ── helpers (independent of product rendering: literal substrings only) ──────────────────────────────────────────────
const kpiOf = (r: PulseReport, agent: string) => r.kpi.find(k => k.agent === agent) ?? null;
const casesOf = (w: GuardianWorld, sub: string) => readCases(w.root, `guardian-${sub}`);
const freshPeers = (w: GuardianWorld, now: Date, r: () => number) => {
  w.installed ??= 'f'.repeat(40);
  w.rail(now, { sha: w.installed, ageMin: 1, smoke: { version: true } });
  w.tick('run-supervisor', now, { kpi: 0, kpiOk: true, ageMin: between(r, 1, 4) });
  w.tick('run-doctor', now, { kpi: 0.8, kpiOk: true, ageMin: between(r, 1, 4) });
  w.tick('autopsy', now, { kpi: 0, kpiOk: true, ageMin: between(r, 1, 4) });
  w.tick('silence-watch', now, { kpi: 0, kpiOk: true, ageMin: between(r, 1, 4) });
};
const wakeIds = (w: GuardianWorld) => w.wakes.map(x => x.id).sort().join(',');
/** llm-decide `route` keeps a skipped account for its credits path — the subscription route is what «routed to» means here. */
const subRoute = (now: Date): { sub: string[]; credit: string[]; d: ReturnType<typeof llmAccountDecision> } => {
  resetLlmDecisionCache(); const d = llmAccountDecision(undefined, now);
  const sub = (d.route['openai-codex'] ?? []).filter(a => d.accounts.some(x => x.provider === 'openai-codex' && x.account === a && x.subscriptionRoutable));
  return { sub, credit: [...(d.creditRoute['openai-codex']?.accounts ?? [])], d };
};

/** CODE-BODY-TO-KIND: a copy of the shipped guardian package (and the trigger dir its lint reads) whose agent.yaml differs ONLY
 *  by `edits` (exact substrings — a missing one throws, so a renamed param shows here, never a silent no-op). */
const editedPackage = (root: string, edits: ReadonlyArray<readonly [string, string]>): string => {
  const dst = join(root, 'pkg', 'graphs');
  cpSync(join(REPO, 'graphs', 'loop-agents', 'guardian'), join(dst, 'loop-agents', 'guardian'), { recursive: true });
  cpSync(join(REPO, 'graphs', 'triggers'), join(dst, 'triggers'), { recursive: true });
  const p = join(dst, 'loop-agents', 'guardian', 'agent.yaml');
  let text = readFileSync(p, 'utf8');
  for (const [from, to] of edits) { if (!text.includes(from)) throw new Error(`agent.yaml has no «${from}»`); text = text.replace(from, to); }
  writeFileSync(p, text);
  return join(dst, 'loop-agents', 'guardian');
};

export const simWorldScenarios: readonly SimWorldScenario[] = [
  // ── 순찰대 ──────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'GRD-PATROL-ZOMBIE',
    title: '순찰대 (KPI roll-up): a zombie run run-supervisor is ending now → KPI 좀비 런 N with its owner · the same breach in a 15-min-old tick → «올림 대기» · the guardian wakes nobody (the peer\'s own trigger owns it)',
    devices: [DEVICE],
    async run(ctx) {
      const w = ctx.device<GuardianWorld>(DEVICE);
      const n = between(ctx.random, 1, 3);
      freshPeers(w, T0, ctx.random);
      w.tick('run-supervisor', T0, { kpi: n, kpiOk: false, ageMin: 2, acted: ['end-zombie-pregate:pregate:abc'] });
      const r1 = w.pulse(T0); const k1 = kpiOf(r1, 'patrol');
      w.tick('run-supervisor', at(31), { kpi: n, kpiOk: false, ageMin: 15, acted: [] });
      freshPeers(w, at(31), ctx.random); w.tick('run-supervisor', at(31), { kpi: n, kpiOk: false, ageMin: 15 });
      const r2 = w.pulse(at(31)); const k2 = kpiOf(r2, 'patrol');
      ctx.recorder.event('guardian:patrol-zombie', { n, k1: k1?.value ?? null, k2: k2?.value ?? null, wakes: wakeIds(w) });
      if (!k1 || k1.value.includes('not built') || k1.ok !== false) return fail('patrol-not-measured', JSON.stringify(k1));
      if (!k1.value.startsWith(`좀비 런 ${n} (run-supervisor 사다리 진행(end-zombie-pregate:pregate:abc))`)) return fail('zombie-owner-missing', k1.value);
      if (wakeIds(w) !== '') return fail('guardian-woke-a-peer', wakeIds(w));
      if (!k2?.value.startsWith(`좀비 런 ${n} (run-supervisor 올림 대기)`)) return fail('zombie-owner-missing', k2?.value ?? '-');
      return { ok: true };
    },
  },
  {
    id: 'GRD-PATROL-RUN-FAILED',
    title: '순찰대 (KPI roll-up): run-doctor below its re-success target in a 12+ min old tick → KPI «실패 진단 위반 (… L0 올림 대기)» · no wake',
    devices: [DEVICE],
    async run(ctx) {
      const w = ctx.device<GuardianWorld>(DEVICE);
      freshPeers(w, T0, ctx.random);
      w.tick('run-doctor', T0, { kpi: 0.2, kpiOk: false, ageMin: between(ctx.random, 12, 25), refused: ['retry-once:red:1'] });
      const k = kpiOf(w.pulse(T0), 'patrol');
      ctx.recorder.event('guardian:patrol-run-failed', { k: k?.value ?? null, wakes: wakeIds(w) });
      if (k?.ok !== false || !k.value.includes('실패 진단 위반 (run-doctor 행동 거절 1 · L0 올림 대기)')) return fail('run-failed-missed', k?.value ?? '-');
      if (wakeIds(w) !== '') return fail('guardian-woke-a-peer', wakeIds(w));
      return { ok: true };
    },
  },
  {
    id: 'GRD-PATROL-LOOP-EXC',
    title: '순찰대 (KPI roll-up): an open loop-exception case (run-doctor lane) → KPI 루프 예외 1 · no wake → resolved → 0 and ok',
    devices: [DEVICE],
    async run(ctx) {
      const w = ctx.device<GuardianWorld>(DEVICE);
      freshPeers(w, T0, ctx.random); w.tick('run-doctor', T0, { kpi: 0.8, kpiOk: true, ageMin: 20 });
      openCase(w.root, { domain: 'loop-exception', id: 'loop:land-graph', subject: 'land-graph 예외', owner: 'TC', slaMin: 60, by: 'RUN-DOCTOR', why: 'exception' }, at(-5));
      const k1 = kpiOf(w.pulse(T0), 'patrol');
      moveCase(w.root, 'loop-exception', 'loop:land-graph', 'resolved', { by: 'RUN-DOCTOR', why: 'done again' }, at(10));
      freshPeers(w, at(31), ctx.random);
      const k2 = kpiOf(w.pulse(at(31)), 'patrol');
      ctx.recorder.event('guardian:patrol-loop-exc', { k1: k1?.value ?? null, k2: k2?.value ?? null, wakes: wakeIds(w) });
      if (!k1?.value.includes('루프 예외 1') || k1.ok !== false) return fail('loop-exception-missed', k1?.value ?? '-');
      if (wakeIds(w) !== '') return fail('guardian-woke-a-peer', wakeIds(w));
      if (!k2?.value.includes('루프 예외 0') || k2.ok !== true) return fail('loop-exception-not-cleared', k2?.value ?? '-');
      return { ok: true };
    },
  },
  {
    id: 'GRD-PATROL-UNCLASSIFIED',
    title: '순찰대: autopsy has unclassified deaths and already carded its L0 → KPI names that card · the guardian sends nothing and wakes nobody',
    devices: [DEVICE],
    async run(ctx) {
      const w = ctx.device<GuardianWorld>(DEVICE);
      const n = between(ctx.random, 1, 4);
      freshPeers(w, T0, ctx.random); w.tick('autopsy', T0, { kpi: n, kpiOk: false, ageMin: 3, breachSinceMin: 90, escalatedRef: 'msg:191777' });
      const k = kpiOf(w.pulse(T0), 'patrol');
      ctx.recorder.event('guardian:patrol-unclassified', { k: k?.value ?? null, wakes: wakeIds(w), posts: w.posts.length });
      if (!k?.value.includes(`미분류 사망 ${n} (autopsy 가 L0 에 올림 msg:191777)`) || k.ok !== false) return fail('unclassified-owner-missing', k?.value ?? '-');
      if (wakeIds(w) !== '') return fail('double-action', wakeIds(w));
      if (w.posts.some(p => p.key.includes('guardian-patrol'))) return fail('double-card', 'guardian carded an escalated peer breach');
      return { ok: true };
    },
  },
  {
    id: 'GRD-PATROL-CONCURRENT',
    title: '순찰대 (KPI roll-up): zombie run ⊕ unclassified death at once, both peers stale → one KPI line naming both · an overlapping second read in the same window is the same line and acts on nothing',
    devices: [DEVICE],
    async run(ctx) {
      const w = ctx.device<GuardianWorld>(DEVICE);
      freshPeers(w, T0, ctx.random);
      w.tick('run-supervisor', T0, { kpi: 2, kpiOk: false, ageMin: between(ctx.random, 11, 20) });
      w.tick('autopsy', T0, { kpi: 1, kpiOk: false, ageMin: between(ctx.random, 11, 20) });
      const k = kpiOf(w.pulse(T0), 'patrol');
      const world = w.triggers.map(t => ({ kind: 'supervisor' as const, id: t.id, owner: t.owner, status: 'ok' as const, lastSeen: T0.toISOString(), facts: {} }));
      const second = runKpiRollup(guardianDef().subs.find(s => s.id === 'patrol')!.kpiRollup!, { stateRoot: w.root, now: T0, rows: world, installedSha: () => null });
      ctx.recorder.event('guardian:patrol-concurrent', { k: k?.value ?? null, wakes: wakeIds(w), second: second.value });
      if (wakeIds(w) !== '') return fail('guardian-woke-a-peer', wakeIds(w));
      if (second.value !== k?.value) return fail('second-read-differs', `${second.value} ≠ ${k?.value}`);
      if (!k?.value.startsWith('좀비 런 2') || !k.value.includes('미분류 사망 1') || k.ok !== false) return fail('concurrent-kpi-wrong', k?.value ?? '-');
      return { ok: true };
    },
  },
  {
    id: 'GRD-PATROL-PEER-SILENT',
    title: '순찰대 (KPI roll-up): run-supervisor not fired by the registry for 120 min (row dead) → KPI «응답 없는 서브 1/3 (run-supervisor · 레지스트리 몫)» · the guardian wakes and cards nobody · the registry fires it again → 0/3',
    devices: [DEVICE],
    async run(ctx) {
      const w = ctx.device<GuardianWorld>(DEVICE);
      const silentFor = between(ctx.random, 45, 120);
      w.triggers = w.triggers.map(t => (t.id === 'run-supervisor-agent' ? { ...t, lastAgeMin: silentFor } : t));
      freshPeers(w, T0, ctx.random); w.tick('run-supervisor', T0, { kpi: 0, kpiOk: true, ageMin: silentFor });
      const k1 = kpiOf(w.pulse(T0), 'patrol');
      w.triggers = w.triggers.map(t => (t.id === 'run-supervisor-agent' ? { id: t.id, owner: t.owner } : t));
      freshPeers(w, at(31), ctx.random);
      const k2 = kpiOf(w.pulse(at(31)), 'patrol');
      const guardianCards = w.posts.filter(p => p.body.includes('run-supervisor'));
      ctx.recorder.event('guardian:patrol-peer-silent', { silentFor, k1: k1?.value ?? null, k2: k2?.value ?? null, wakes: wakeIds(w), cards: guardianCards.length });
      if (!k1?.value.endsWith('응답 없는 서브 1/3 (run-supervisor · 레지스트리 몫)') || k1.ok !== false) return fail('silent-peer-kpi', k1?.value ?? '-');
      if (wakeIds(w) !== '' || guardianCards.length) return fail('guardian-acted-on-silent-peer', `${wakeIds(w)} · ${guardianCards.map(p => p.key).join(',')}`);
      if (!k2?.value.endsWith('응답 없는 서브 0/3')) return fail('silent-peer-not-cleared', k2?.value ?? '-');
      return { ok: true };
    },
  },
  // ── 우체국·레일지기 ──────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'GRD-POST-SLA',
    title: '우체국: requests past SLA with silence-watch escalated to its L0 → KPI «SLA 초과 우편 N (… 올림 msg)» · miss · no guardian card · no wake',
    devices: [DEVICE],
    async run(ctx) {
      const w = ctx.device<GuardianWorld>(DEVICE);
      const n = between(ctx.random, 2, 9);
      freshPeers(w, T0, ctx.random); w.installed = 'a'.repeat(40); w.rail(T0, { sha: 'a'.repeat(40), ageMin: 3, smoke: { version: true } });
      w.tick('silence-watch', T0, { kpi: n, kpiOk: false, ageMin: 2, refused: ['redeliver:TC'], escalatedRef: 'msg:192953' });
      const k = kpiOf(w.pulse(T0), 'post');
      ctx.recorder.event('guardian:post-sla', { k: k?.value ?? null, wakes: wakeIds(w) });
      if (!k?.value.startsWith(`SLA 초과 우편 ${n} (silence-watch 가 L0 에 올림 msg:192953)`) || k.ok !== false) return fail('sla-owner-missing', k?.value ?? '-');
      if (wakeIds(w) !== '' || w.posts.some(p => p.key.includes('guardian-post'))) return fail('double-action', `${wakeIds(w)} · ${w.posts.length}`);
      return { ok: true };
    },
  },
  {
    id: 'GRD-POST-READ-NOTICE',
    title: '우체국: only an already-read notice / answered request (silence-watch counts 0) → KPI ok · nothing woken · nothing carded',
    devices: [DEVICE],
    async run(ctx) {
      const w = ctx.device<GuardianWorld>(DEVICE);
      freshPeers(w, T0, ctx.random); w.installed = 'b'.repeat(40); w.rail(T0, { sha: 'b'.repeat(40), ageMin: between(ctx.random, 1, 9), smoke: { version: true, 'decisions-list': true } });
      const k = kpiOf(w.pulse(T0), 'post');
      ctx.recorder.event('guardian:post-read-notice', { k: k?.value ?? null });
      if (k?.value !== 'SLA 초과 우편 0 · 잠든 수신처 0 · 레일 bbbbbbbb 스모크 통과 · 응답 없는 서브 0/2' || k.ok !== true) return fail('read-notice-counted', k?.value ?? '-');
      if (wakeIds(w) !== '' || w.posts.some(p => p.key.includes('guardian-post'))) return fail('read-notice-acted', wakeIds(w));
      return { ok: true };
    },
  },
  {
    id: 'GRD-POST-DORMANT',
    title: '우체국: silence-watch bounces mail to two dormant recipients → KPI «잠든 수신처 2 (HAND-X,REL)» · miss',
    devices: [DEVICE],
    async run(ctx) {
      const w = ctx.device<GuardianWorld>(DEVICE);
      freshPeers(w, T0, ctx.random); w.installed = 'c'.repeat(40); w.rail(T0, { sha: 'c'.repeat(40), ageMin: 2, smoke: { version: true } });
      w.tick('silence-watch', T0, { kpi: 2, kpiOk: false, ageMin: 1, acted: ['bounce:REL', 'bounce:HAND-X'], bounce: ['REL', 'HAND-X'] });
      const k = kpiOf(w.pulse(T0), 'post');
      ctx.recorder.event('guardian:post-dormant', { k: k?.value ?? null });
      if (!k?.value.includes('잠든 수신처 2 (HAND-X,REL)') || k.ok !== false) return fail('dormant-missed', k?.value ?? '-');
      return { ok: true };
    },
  },
  {
    id: 'GRD-POST-RAIL',
    title: '레일지기 (KPI roll-up): a new install not smoked for 15 min → KPI «스모크 전» miss (rail-watch\'s own trigger wakes it · no guardian wake) · then a regression rail-watch carded → KPI «회귀 · rail-watch 카드 보냄», no guardian card · a known break is not a miss',
    devices: [DEVICE],
    async run(ctx) {
      const w = ctx.device<GuardianWorld>(DEVICE);
      freshPeers(w, T0, ctx.random);
      w.installed = 'e'.repeat(40); w.rail(T0, { sha: 'd'.repeat(40), ageMin: between(ctx.random, 11, 25), smoke: { version: true } });
      const k1 = kpiOf(w.pulse(T0), 'post');
      freshPeers(w, at(31), ctx.random);
      w.rail(at(31), { sha: 'e'.repeat(40), ageMin: 2, smoke: { version: true, 'land-graph-status': false }, carded: [`${'e'.repeat(12)}:land-graph-status@TC`, `${'e'.repeat(12)}:land-graph-status@OP`] });
      const k2 = kpiOf(w.pulse(at(31)), 'post');
      freshPeers(w, at(61), ctx.random);
      w.rail(at(61), { sha: 'e'.repeat(40), ageMin: 2, smoke: { version: true, 'land-graph-status': false }, carded: [] });
      const k3 = kpiOf(w.pulse(at(61)), 'post');
      ctx.recorder.event('guardian:post-rail', { k1: k1?.value ?? null, k2: k2?.value ?? null, k3: k3?.value ?? null, wakes: wakeIds(w) });
      if (wakeIds(w) !== '' || !k1?.value.includes('레일 eeeeeeee 스모크 전') || k1.ok !== false) return fail('unchecked-rail-missed', `${wakeIds(w)} · ${k1?.value}`);
      if (!k2?.value.includes('레일 eeeeeeee 스모크 실패 land-graph-status (회귀 · rail-watch 카드 보냄)') || k2.ok !== false) return fail('regression-missed', k2?.value ?? '-');
      if (w.posts.some(p => p.key.includes('guardian-post'))) return fail('double-card', 'guardian carded a regression rail-watch carded');
      if (!k3?.value.includes('(알려진 고장 · 직전 레일부터)') || k3.ok !== true) return fail('known-break-counted', k3?.value ?? '-');
      return { ok: true };
    },
  },
  // ── 연료관 ──────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'GRD-FUEL-ROUTE-NEXT',
    title: '연료관: codex team at 100 % → the decision routes third first, team off the subscription route · KPI ok «건너뜀 1» · no fuel card · no fuel-90 re-spawn',
    devices: [DEVICE],
    async run(ctx) {
      const w = ctx.device<GuardianWorld>(DEVICE); const restore = w.packEnv();
      try {
        const third = between(ctx.random, 5, 40);
        w.usage = [{ provider: 'codex', account: 'team', usedPercent: 100, status: 'ok', resetsIn: '3h 0m' }, { provider: 'codex', account: 'third', usedPercent: third, status: 'ok' }, { provider: 'codex', account: 'default', usedPercent: 10, status: 'ok' }, { provider: 'openrouter', account: 'default', usedPercent: null, leftUsd: 400, status: 'ok' }];
        w.balances = { 'openai-codex:default': 20_000, 'openai-codex:team': 14_000, 'openai-codex:third': 22_000 };
        runFuelPhase(w.fuelPorts(T0));
        freshPeers(w, T0, ctx.random);
        const r = w.pulse(T0, { fuel: true }); const k = kpiOf(r, 'fuel');
        const { sub: route, credit } = subRoute(T0);
        const r2 = w.pulse(at(3), { fuel: true });
        ctx.recorder.event('guardian:fuel-route-next', { route, credit, k: k?.value ?? null, respawn: r2.spawned });
        if (route.join(',') !== 'third,default') return fail('route-not-moved', route.join(','));
        if (!credit.includes('team')) return fail('until-reset-credits-lost', credit.join(','));
        if (k?.ok !== true || !k.value.includes('codex:team 100% 건너뜀') || !k.value.includes('소진·경로 잔존 0 · 건너뜀 1')) return fail('fuel-false-miss', k?.value ?? '-');
        if (w.posts.some(p => p.key.startsWith('guardian-fuel'))) return fail('fuel-card-noise', w.posts.map(p => p.key).join(','));
        if (r2.spawned.some(s => s.startsWith('fuel('))) return fail('fuel-90-respawn', r2.spawned.join(','));
        return { ok: true };
      } finally { restore(); }
    },
  },
  {
    id: 'GRD-FUEL-ALL-DRY',
    title: '연료관: every codex account at 100 % and every codex credit at its floor → «경로 가능 계정 0: openai-codex» · ONE card to OP (a second pulse sends none) · reset → back on the route, case resolved, KPI ok',
    devices: [DEVICE],
    async run(ctx) {
      const w = ctx.device<GuardianWorld>(DEVICE); const restore = w.packEnv();
      try {
        w.usage = ['team', 'third', 'default'].map(a => ({ provider: 'codex', account: a, usedPercent: 100, status: 'ok' as const, resetsIn: '2h 0m' }));
        w.balances = { 'openai-codex:default': between(ctx.random, 0, 1_999), 'openai-codex:team': 0, 'openai-codex:third': 0 };
        runFuelPhase(w.fuelPorts(T0));
        freshPeers(w, T0, ctx.random);
        const k1 = kpiOf(w.pulse(T0, { fuel: true }), 'fuel');
        runFuelPhase(w.fuelPorts(at(31))); freshPeers(w, at(31), ctx.random); w.pulse(at(31), { fuel: true });
        const dryCards = w.posts.filter(p => p.key.startsWith('guardian-fuel-dry:openai-codex'));
        // reset: team's window refills
        w.usage = [{ provider: 'codex', account: 'team', usedPercent: 0, status: 'ok' }, ...w.usage.filter(u => u.account !== 'team')];
        for (const m of [62, 80, 100]) runFuelPhase(w.fuelPorts(at(m)));
        freshPeers(w, at(101), ctx.random); const k3 = kpiOf(w.pulse(at(101), { fuel: true }), 'fuel');
        const { sub: route } = subRoute(at(101));
        const c = casesOf(w, 'fuel').find(x => x.id === 'provider-dry:openai-codex');
        ctx.recorder.event('guardian:fuel-all-dry', { k1: k1?.value ?? null, cards: dryCards.map(p => p.to), k3: k3?.value ?? null, route, state: c?.state ?? null });
        if (k1?.ok !== false || !k1.value.includes('경로 가능 계정 0: openai-codex')) return fail('dry-missed', k1?.value ?? '-');
        if (dryCards.length !== 1 || dryCards[0]!.to !== 'OP') return fail('dry-card-count', String(dryCards.length));
        if (route[0] !== 'team') return fail('reset-not-back', route.join(','));
        if (k3?.ok !== true || c?.state !== 'resolved') return fail('dry-not-resolved', `${k3?.value} · ${c?.state}`);
        return { ok: true };
      } finally { restore(); }
    },
  },
  {
    id: 'GRD-FUEL-7DAY',
    title: '연료관: 7 days of synthetic codex usage (30-min steps · daily and weekly reset boundaries) → the first routed account is never at 100 %, every exhausted account is off the subscription route, a reset account is back within one step, the guardian KPI never misses while a route exists',
    devices: [DEVICE],
    async run(ctx) {
      const w = ctx.device<GuardianWorld>(DEVICE); const restore = w.packEnv();
      try {
        const step = 30; const steps = (7 * 24 * 60) / step;
        const accts = ['team', 'third', 'default'] as const;
        // reset boundaries: team/third daily at seeded hours, default weekly at a seeded day · burn 3–9 %/step in work hours
        const resetHour = { team: between(ctx.random, 0, 23), third: between(ctx.random, 0, 23), default: between(ctx.random, 0, 23) };
        const weeklyDay = between(ctx.random, 1, 6);
        const burn = Object.fromEntries(accts.map(a => [a, between(ctx.random, 3, 9)])) as Record<typeof accts[number], number>;
        const used: Record<string, number> = { team: 0, third: 0, default: 0 };
        let firstRuns = ''; let last = ''; const resetAt: Record<string, number> = {};
        w.balances = { 'openai-codex:default': 25_000, 'openai-codex:team': 14_000, 'openai-codex:third': 22_000 };
        for (let i = 0; i <= steps; i++) {
          const now = at(i * step); const hour = now.getUTCHours(); const day = Math.floor(i * step / 1440);
          for (const a of accts) {
            const reset = a === 'default' ? (day === weeklyDay && hour === resetHour.default && now.getUTCMinutes() === 0) : (hour === resetHour[a] && now.getUTCMinutes() === 0);
            if (reset && i > 0) { used[a] = 0; resetAt[a] = i; }
            else if (hour >= 0 && hour < 14) used[a] = Math.min(100, used[a]! + burn[a]); // 09:00–23:00 KST work hours
          }
          w.usage = accts.map(a => ({ provider: 'codex', account: a, usedPercent: used[a]!, status: 'ok' as const }));
          runFuelPhase(w.fuelPorts(now));
          const { sub: route, d } = subRoute(now);
          const first = route[0] ?? '-';
          if (first !== last) { firstRuns += `${firstRuns ? ' ' : ''}${i}:${first}`; last = first; }
          if (first !== '-' && used[first]! >= 100) return fail('routed-to-exhausted', `step ${i}: ${first} at ${used[first]}% first in ${route.join(',')}`);
          for (const a of accts) if (used[a]! >= 100 && d.accounts.find(x => x.provider === 'openai-codex' && x.account === a)?.subscriptionRoutable) return fail('exhausted-still-routed', `step ${i}: ${a}`);
          for (const a of accts) if (resetAt[a] === i - 1 && !route.includes(a)) return fail('reset-not-back', `step ${i}: ${a} reset at ${i - 1} · route ${route.join(',')}`);
          const v = judgeFuel(annotateRoutes(accountEntries({ ts: now.getTime(), accounts: w.usage }, now.getTime()), liveFuelRoutes(now)));
          if (v.dry.length === 0 && (v.stuck.length > 0 || v.floorGone)) return fail('fuel-false-miss', `step ${i}: ${v.value}`); // a miss = stuck · floor gone (the KPI line's terms)
        }
        ctx.recorder.event('guardian:fuel-7day', { resetHour, weeklyDay, burn, firstRuns });
        return { ok: true };
      } finally { restore(); }
    },
  },
  // ── 열쇠지기 ────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'GRD-KEYS-REAL-VS-PAUSED',
    title: '열쇠지기: a credential whose known expiry passed and that has not refreshed 10 days → stale · ONE card to OP · a named codex account (expiry unknown in the elanous row, live JWT in its CODEX_HOME) → not stale, no card',
    devices: [DEVICE],
    async run(ctx) {
      const w = ctx.device<GuardianWorld>(DEVICE);
      const days = between(ctx.random, 8, 12);
      // the named account's CODEX_HOME auth.json: access JWT exp 2 days ahead, last_refresh `days` ago (codex refreshes near expiry)
      const payload = Buffer.from(JSON.stringify({ exp: Math.floor(at(2 * 1440).getTime() / 1000) })).toString('base64url');
      const auth = JSON.stringify({ last_refresh: at(-days * 1440).toISOString(), tokens: { access_token: `hdr.${payload}.sig` } });
      const meta = codexHomeMeta('/codex-third', () => auth);
      w.creds = [
        { provider: 'anthropic', connected: true, expiresAt: at(-60).getTime(), lastRefresh: at(-10 * 1440).toISOString() },
        { provider: 'openai-codex:third', connected: true, expiresAt: null, lastRefresh: at(-days * 1440).toISOString() },
        { provider: 'openai-codex:team', connected: true, expiresAt: meta?.expiresAt ?? null, lastRefresh: meta?.lastRefresh ?? null },
      ];
      const rows = credentialEntries(w.creds, T0.getTime());
      const v = judgeKeys(rows, []);
      freshPeers(w, T0, ctx.random); const k = kpiOf(w.pulse(T0), 'keys');
      const cards = w.posts.filter(p => p.key.startsWith('guardian-key-stale:'));
      ctx.recorder.event('guardian:keys', { status: rows.map(r => `${r.id}=${r.status}`), k: k?.value ?? null, cards: cards.map(p => `${p.to}:${p.key.split(':').slice(1, 3).join(':')}`) });
      if (rows.map(r => r.status).join(',') !== 'stale,unknown,ok') return fail('key-status-wrong', rows.map(r => `${r.id}=${r.status}`).join(','));
      if (meta?.lastRefresh !== at(-days * 1440).toISOString() || meta.connected !== true) return fail('codex-home-meta', JSON.stringify(meta));
      if (v.stale.join(',') !== 'oauth:anthropic') return fail('false-alarm', v.stale.join(','));
      if (cards.length !== 1 || cards[0]!.to !== 'OP' || !cards[0]!.key.startsWith('guardian-key-stale:oauth:anthropic:')) return fail('key-card-wrong', JSON.stringify(cards.map(p => p.key)));
      if (!k?.value.includes('만료/정지 oauth:anthropic · 만료 모름 oauth:openai-codex:third')) return fail('keys-kpi', k?.value ?? '-');
      return { ok: true };
    },
  },
  // ── 연료관 · FALLBACK-SUBSCRIPTION-FIRST (0.3.39 P0 · 대표 11-28 12:3x «구독 여유 → 유료 크레딧») ─────────────────────────────
  {
    id: 'GRD-FUEL-SUB-FIRST',
    title: '연료관 · hand model: zai week full while codex team/third have headroom → codex (subscription) — never OpenRouter credits · every subscription full → OpenRouter credits · a review seat never runs GLM',
    devices: [DEVICE],
    async run(ctx) {
      const w = ctx.device<GuardianWorld>(DEVICE);
      const restore = w.packEnv();
      try {
        const team = between(ctx.random, 5, 60); const third = between(ctx.random, 1, 40); const full = between(ctx.random, 95, 100);
        const snap = (zai: number, t: number, th: number, orLeft: number) => ({ accounts: [
          { provider: 'codex', account: 'team', usedPercent: t, status: 'ok' }, { provider: 'codex', account: 'third', usedPercent: th, status: 'ok' },
          { provider: 'codex', account: 'default', usedPercent: 100, status: 'ok' },
          { provider: 'zai', account: '5h', usedPercent: 0, status: 'ok' }, { provider: 'zai', account: 'week', usedPercent: zai, status: 'ok' },
          { provider: 'openrouter', account: 'credits', usedPercent: null, leftUsd: orLeft, status: 'ok' },
        ] });
        // the pack's credit route decides codex credits; the scene pins «no codex credits» so OpenRouter is the only paid path
        const noCodexCredits = { creditsAllowed: (payer: string) => payer === 'openrouter' };
        const a = snap(full, team, third, 877);
        const easy = pickHandModel('easy', p => usedShareFromSnapshot(a, p), noCodexCredits);
        const b = snap(full, full, full, 877);
        const dry = pickHandModel('easy', p => usedShareFromSnapshot(b, p), noCodexCredits);
        const hard = pickHandModel('hard', p => usedShareFromSnapshot(b, p), noCodexCredits);
        const review = (['hard', 'medium', 'easy'] as const).map(t => pickHandModel(t, p => usedShareFromSnapshot(b, p), { use: 'review', ...noCodexCredits }));
        const plan = handPlan();
        ctx.recorder.event('guardian:fuel-sub-first', { team, third, full, easy: `${easy.provider}/${easy.model}`, dry: `${dry.provider}/${dry.model}`, hard: `${hard.provider}/${hard.model}`, review: review.map(m => m.model) });
        if (plan.source !== 'pack' || plan.fallback.join(',') !== 'subscription-headroom,credits-by-balance') return fail('plan-not-yaml', `${plan.source} ${plan.fallback.join(',')}`);
        if (`${easy.provider}/${easy.model}` !== 'openai-codex/gpt-6-luna' || easy.via !== 'subscription-headroom') return fail('paid-before-subscription', `${easy.provider}/${easy.model} via ${easy.via ?? '-'} · ${easy.note ?? ''}`);
        if (!(easy.note ?? '').startsWith(`budget: glm at ${full}% (cap 95%) → openai-codex/gpt-6-luna (subscription headroom)`)) return fail('note', easy.note ?? '-');
        if (`${dry.provider}/${dry.model}` !== 'openrouter/z-ai/glm-5.3' || dry.via !== 'credits-by-balance') return fail('no-credits-when-dry', `${dry.provider}/${dry.model} via ${dry.via ?? '-'}`);
        if (`${hard.provider}/${hard.model}` !== 'openrouter/z-ai/glm-5.3') return fail('hard-dry', `${hard.provider}/${hard.model}`);
        if (review.some(m => (m.model ?? '').includes('glm'))) return fail('review-glm', review.map(m => `${m.provider}/${m.model}`).join(','));
        return { ok: true };
      } finally { restore(); }
    },
  },
  // Terra #40656 r1 ④ — every candidate refused → an explicit «none»: no directive, never the list's last paid model as a bypass
  {
    id: 'GRD-FUEL-NO-PAID-BYPASS',
    title: '연료관 · hand model: every subscription full, OpenRouter balance gone, codex credits not allowed → none for hard · medium · easy (no directive) — OpenRouter is never picked as a bypass',
    devices: [DEVICE],
    async run(ctx) {
      const w = ctx.device<GuardianWorld>(DEVICE);
      const restore = w.packEnv();
      try {
        const full = between(ctx.random, 95, 100);
        const snap = { accounts: [
          { provider: 'codex', account: 'team', usedPercent: full, status: 'ok' }, { provider: 'codex', account: 'third', usedPercent: full, status: 'ok' },
          { provider: 'codex', account: 'default', usedPercent: 100, status: 'ok' },
          { provider: 'zai', account: 'week', usedPercent: full, status: 'ok' },
          { provider: 'openrouter', account: 'credits', usedPercent: null, leftUsd: 0, status: 'ok' },
        ] };
        const opts = { creditsAllowed: (payer: string) => payer === 'openrouter' };
        const picks = (['hard', 'medium', 'easy'] as const).map(t => pickHandModel(t, p => usedShareFromSnapshot(snap, p), opts));
        const d = directiveFor({ seat: 'HAND-SIM', cell: 'DOCS-SIM', facts: { cellId: 'DOCS-SIM', paths: ['docs/a.md'] }, usedShare: p => usedShareFromSnapshot(snap, p), by: 'sim', now: T0, pick: opts });
        ctx.recorder.event('guardian:fuel-no-paid-bypass', { full, picks: picks.map(m => (m.none ? 'none' : `${m.provider}/${m.model}`)), directive: d ? `${d.provider}/${d.model}` : null });
        if (picks.some(m => !m.none)) return fail('paid-bypass', picks.map(m => `${m.tier}:${m.provider ?? 'none'}/${m.model ?? ''}`).join(','));
        if (!picks.every(m => (m.note ?? '').endsWith('— no paid bypass · no directive'))) return fail('none-note', picks.map(m => m.note).join(' | '));
        if (d !== null) return fail('directive-written', `${d.provider}/${d.model}`);
        return { ok: true };
      } finally { restore(); }
    },
  },
  // Terra #40656 r2 ③ · OP 결정 11-28 — none → the seat's old (paid) directive is removed → its tab returns to the seat default model
  // (no block · no paid) · one warn · ONE fuel case per seat
  {
    id: 'GRD-FUEL-NONE-CLEARS-DIRECTIVE',
    title: '연료관 · hand model: none (every candidate refused) → the seat\'s old openrouter directive is removed → the same session returns to its default model at its next turn · one fuel-no-model case (not repeated) · paid 0',
    devices: [DEVICE],
    async run(ctx) {
      const w = ctx.device<GuardianWorld>(DEVICE);
      const restore = w.packEnv();
      try {
        const seat = `HAND-SIM-${between(ctx.random, 1, 9)}`; const sid = `sess-none-${seat}`;
        const old = { seat, cell: 'OLD-CELL', tier: 'easy' as const, provider: 'openrouter', model: 'z-ai/glm-5.3', score: 0, reasons: ['docs/tests only'], note: 'budget: glm at 100% (cap 95%) → openrouter/z-ai/glm-5.3', by: 'seat-assign', at: at(-30).toISOString() };
        writeSeatModelDirective(w.root, old);
        const sel = (id: string, x: { provider: string; model: string }) => setSessionProvider(id, x as Parameters<typeof setSessionProvider>[1]);
        const first = applySeatModelDirective({ root: w.root, seat, sessionId: sid, lastAppliedAt: null, select: sel, clear: clearSessionProvider });
        const onPaid = getSessionProvider(sid)?.provider ?? null;
        const opts = { creditsAllowed: () => false };
        const d = directiveFor({ seat, cell: 'NEW-CELL', facts: { cellId: 'NEW-CELL', paths: ['docs/a.md'] }, usedShare: () => 1, by: 'sim', now: T0, pick: opts });
        const removed = d === null ? noModelFallback({ root: w.root, seat, cell: 'NEW-CELL', note: 'no acceptable model under the budget', by: 'sim', now: T0 }) : false;
        const again = noModelFallback({ root: w.root, seat, cell: 'NEW-CELL-2', note: 'no acceptable model under the budget', by: 'sim', now: at(5) });
        const next = applySeatModelDirective({ root: w.root, seat, sessionId: sid, lastAppliedAt: first?.at ?? null, select: sel, clear: clearSessionProvider });
        const after = getSessionProvider(sid) ?? null;
        const cases = readCases(w.root, 'fuel-no-model');
        ctx.recorder.event('guardian:fuel-none-clears', { seat, onPaid, directive: d, removed, again, after, cases: cases.map(c => `${c.id}:${c.state}`) });
        if (first?.provider !== 'openrouter' || onPaid !== 'openrouter') return fail('setup', `${first?.provider} ${onPaid}`);
        if (d !== null) return fail('picked-despite-none', `${d.provider}/${d.model}`);
        if (removed !== true || again !== false || readSeatModelDirective(w.root, seat) !== null) return fail('directive-not-removed', `${removed} ${again}`);
        if (next !== null || after !== null) return fail('session-still-paid', JSON.stringify(after));
        if (cases.length !== 1 || cases[0]!.id !== `no-model:${seat}` || cases[0]!.owner !== 'OP') return fail('case', cases.map(c => `${c.id}:${c.owner}`).join(','));
        return { ok: true };
      } finally { restore(); }
    },
  },
  // Terra #40656 r1 ⑤ — a tier whose every model is forbidden for the use → none; the forbidden first model is never returned
  {
    id: 'GRD-FUEL-REVIEW-NEVER-FORBIDDEN',
    title: '연료관 · hand model: a plan whose tier lists only GLM (zai · OpenRouter) and a review seat → none, whatever the budget — GLM is never returned for review',
    devices: [DEVICE],
    async run(ctx) {
      const w = ctx.device<GuardianWorld>(DEVICE);
      const restore = w.packEnv();
      try {
        const used = between(ctx.random, 0, 50) / 100;
        const base = handPlan();
        const glmOnly = base.tiers.easy.filter(m => m.model.includes('glm'));
        const plan = { tiers: { hard: glmOnly, medium: glmOnly, easy: glmOnly }, fallback: base.fallback, source: base.source };
        const picks = (['hard', 'medium', 'easy'] as const).map(t => pickHandModel(t, () => used, { use: 'review', plan, creditsAllowed: () => true }));
        const impl = pickHandModel('easy', () => used, { plan, creditsAllowed: () => true });
        ctx.recorder.event('guardian:fuel-review-forbidden', { used, glmOnly: glmOnly.map(m => `${m.provider}/${m.model}`), picks: picks.map(m => (m.none ? 'none' : m.model)), impl: impl.model ?? 'none' });
        if (glmOnly.map(m => `${m.provider}/${m.model}`).join(',') !== 'glm/glm-5.3,openrouter/z-ai/glm-5.3') return fail('plan', glmOnly.map(m => m.model).join(','));
        if (picks.some(m => !m.none)) return fail('forbidden-returned', picks.map(m => `${m.provider}/${m.model}`).join(','));
        if (picks[2]!.note !== 'budget: no model of easy may serve review (glm/glm-5.3 never for review · openrouter/z-ai/glm-5.3 never for review) — no directive') return fail('note', picks[2]!.note ?? '-');
        if (impl.model !== 'glm-5.3') return fail('implementation-still-glm', impl.model ?? 'none');
        return { ok: true };
      } finally { restore(); }
    },
  },
  // ── 열쇠지기 · KEYS-PROACTIVE-REFRESH (0.3.39 P0 · 대표 11-28 «가정이 아니라 증명») ─────────────────────────────────────────
  {
    id: 'GRD-KEYS-REFRESH',
    title: '열쇠지기: a codex home with < 48 h of access left → the CLI refresh runs once → last_refresh advanced on disk → KPI «만료 48h 이내 미갱신 0» · no card',
    devices: [DEVICE],
    async run(ctx) {
      const w = ctx.device<GuardianWorld>(DEVICE);
      const leftH = between(ctx.random, 2, 47);
      const home = '/sim/codex-team-owner';
      const disk = { lastRefresh: at(-6 * 1440).toISOString(), expiresAt: at(leftH * 60).getTime() };
      w.creds = [{ provider: 'codex-home:team:codex-team-owner', connected: true, expiresAt: disk.expiresAt, lastRefresh: disk.lastRefresh, home, refreshable: true }];
      w.refresh = (h, now) => {
        const before = { ...disk };
        disk.lastRefresh = now.toISOString(); disk.expiresAt = now.getTime() + 10 * 1440 * MIN;
        return { ok: true, before, after: { ...disk }, line: `account/read ok · last_refresh ${before.lastRefresh} → ${disk.lastRefresh}` };
      };
      freshPeers(w, T0, ctx.random);
      const k = kpiOf(w.pulse(T0), 'keys');
      ctx.recorder.event('guardian:keys-refresh', { leftH, calls: w.refreshCalls.length, k: k?.value ?? null, cards: w.keyCards.length });
      if (w.refreshCalls.length !== 1 || w.refreshCalls[0]!.home !== home) return fail('refresh-not-run', JSON.stringify(w.refreshCalls));
      if (disk.lastRefresh !== T0.toISOString()) return fail('last-refresh-not-advanced', disk.lastRefresh);
      if (!refreshAdvanced({ before: { lastRefresh: at(-6 * 1440).toISOString(), expiresAt: null }, after: { lastRefresh: disk.lastRefresh, expiresAt: null } })) return fail('verify', 'advanced=false');
      if (k?.ok !== true || !k.value.includes('만료 48h 이내 미갱신 0')) return fail('kpi', `${k?.ok} ${k?.value ?? '-'}`);
      if (w.keyCards.length !== 0) return fail('card-on-success', w.keyCards.map(c => c.ref).join(','));
      return { ok: true };
    },
  },
  {
    id: 'GRD-KEYS-REFRESH-FAIL',
    title: '열쇠지기: the CLI refresh does not move last_refresh → ONE relogin card (decisions · exact steps) · retried next hour without a second card inside 24 h · KPI breach',
    devices: [DEVICE],
    async run(ctx) {
      const w = ctx.device<GuardianWorld>(DEVICE);
      const leftH = between(ctx.random, 2, 40);
      const home = '/sim/codex-third-owner';
      const disk = { lastRefresh: at(-8 * 1440).toISOString(), expiresAt: at(leftH * 60).getTime() };
      w.creds = [{ provider: 'codex-home:third:codex-third-owner', connected: true, expiresAt: disk.expiresAt, lastRefresh: disk.lastRefresh, home, refreshable: true }];
      w.refresh = () => ({ ok: false, before: { ...disk }, after: { ...disk }, line: 'account/read error: refresh token was already used · last_refresh unchanged (not advanced)' });
      freshPeers(w, T0, ctx.random);
      const k1 = kpiOf(w.pulse(T0), 'keys');
      const later = at(between(ctx.random, 61, 600));
      freshPeers(w, later, ctx.random);
      const k2 = kpiOf(w.pulse(later), 'keys');
      ctx.recorder.event('guardian:keys-refresh-fail', { leftH, calls: w.refreshCalls.length, cards: w.keyCards.map(c => c.ref.split(':').slice(0, 3).join(':')), k1: k1?.value ?? null, k2: k2?.value ?? null });
      if (w.refreshCalls.length !== 2) return fail('retry-count', String(w.refreshCalls.length));
      if (w.keyCards.length !== 1) return fail('card-count', w.keyCards.map(c => c.ref).join(','));
      const c = w.keyCards[0]!.card;
      if (c.category !== 'secret' || !c.scqa.a.includes(`CODEX_HOME=${home} codex login`) || !c.scqa.a.includes('aside') || !c.scqa.a.includes('텔레그램')) return fail('card-steps', c.scqa.a);
      if (!w.keyCards[0]!.ref.startsWith('guardian-key-relogin:codex-home:third:codex-third-owner:')) return fail('card-ref', w.keyCards[0]!.ref);
      if (k1?.ok !== false || !k1.value.includes('만료 48h 이내 미갱신 1 (codex-home:third:codex-third-owner)')) return fail('kpi-1', k1?.value ?? '-');
      if (k2?.ok !== false) return fail('kpi-2', k2?.value ?? '-');
      return { ok: true };
    },
  },
  {
    id: 'GRD-KEYS-USAGE-EXP',
    title: '열쇠지기 ⊕ eln usage: the codex row shows the LOGIN\'s access exp (JWT exp of its CODEX_HOME) and last_refresh — the reset-credit expiry is labelled as such',
    devices: [DEVICE],
    async run(ctx) {
      const minute = between(ctx.random, 0, 59);
      // exp 1796176551 = 2026-12-02T01:55:51.000Z (literal) · the token itself never leaves the reader
      const auth = JSON.stringify({ last_refresh: '2026-11-22T01:55:51.779682Z', tokens: { access_token: `hdr.${Buffer.from('{"exp":1796176551}').toString('base64url')}.sig`, refresh_token: 'rt' } });
      const token = codexTokenAxis('/sim/codex-team-owner', () => auth);
      const resetAt = `2026-11-30T19:${String(minute).padStart(2, '0')}:59.488Z`;
      const text = formatUnifiedUsage({ rows: [{ provider: 'codex', accountName: 'team', accountCount: 1, soleAccount: true, credits: { status: 'error', detail: 'sim' }, subscription: { status: 'unavailable', reason: 'query-does-not-supply' },
        resetCredits: { status: 'available', expiresAt: resetAt, hasUnknownExpiry: false }, ...(token ? { token } : {}) }], accountCounts: { codex: 1, grok: 0, openrouter: 0 } } as never);
      const row = text.split('\n').find(l => l.includes(' team ')) ?? '';
      ctx.recorder.event('guardian:keys-usage', { minute, token });
      if (token?.accessExpiresAt !== '2026-12-02T01:55:51.000Z' || token.lastRefresh !== '2026-11-22T01:55:51.779682Z') return fail('token-axis', JSON.stringify(token));
      if (JSON.stringify(token).includes('hdr.') || JSON.stringify(token).includes('"rt"')) return fail('value-leak', JSON.stringify(token));
      if (!row.includes('token /sim/codex-team-owner access exp=2026-12-02T01:55:51.000Z · last_refresh=2026-11-22T01:55:51.779682Z')) return fail('usage-token-cell', row);
      if (!row.includes(`available reset-credit expires=${resetAt}`)) return fail('usage-reset-cell', row);
      return { ok: true };
    },
  },
  // ── CODE-BODY-TO-KIND: one scene per shared sub kind — the same world, the shipped YAML vs a copy changed ONLY in params ──
  {
    id: 'GRD-KIND-RESOURCE-CHECK-PARAMS',
    title: 'resource-check kind (CODE-BODY-TO-KIND): a supervisor whose outcome is bad 90+ min (owner TC) — the shipped YAML cards its owner TC and reads «감독자 결손 1/5»; a package copy that changes ONLY the 맥박 params (card to: OP · KPI line text) cards OP and reads the new line',
    devices: [DEVICE],
    async run(ctx) {
      const w = ctx.device<GuardianWorld>(DEVICE);
      const badMin = between(ctx.random, 90, 300);
      w.triggers = w.triggers.map(t => (t.id === 'run-supervisor-agent' ? { ...t, badSinceMin: badMin } : t));
      freshPeers(w, T0, ctx.random);
      const k1 = kpiOf(w.pulse(T0), 'pulse');
      const dir = editedPackage(ctx.universeRoot, [['to: "{owner|or:OP}"', 'to: OP'],
        ['value: "감독자 결손 {count.bad}/{count.sups} · 호스트 미응답 {count.gone}"', 'value: "결손 감독자 {count.bad}/{count.sups} · 미응답 호스트 {count.gone}"']]);
      const later = at(1440 + between(ctx.random, 1, 30));
      freshPeers(w, later, ctx.random);
      let k2: ReturnType<typeof kpiOf> = null; let src: string | null = null;
      try { const r = w.pulse(later, { defDir: dir }); k2 = kpiOf(r, 'pulse'); src = r.def ?? null; } finally { resetGuardianDef(); }
      const cards = w.posts.filter(p => p.key.startsWith('guardian-reattach:run-supervisor-agent:')).map(p => `${p.to}:${p.key.split(':')[2]}`);
      ctx.recorder.event('guardian:kind-resource-check', { badMin, k1: k1?.value ?? null, k2: k2?.value ?? null, cards, def: src });
      if (src !== 'agent.yaml') return fail('edited-package-refused', String(src));
      if (cards.join(',') !== 'TC:2026-11-28,OP:2026-11-29') return fail('card-target-not-from-yaml', cards.join(','));
      if (!k1?.value.startsWith('감독자 결손 1/5 · 호스트 미응답 0') || k1.ok !== false) return fail('shipped-line', k1?.value ?? '-');
      if (!k2?.value.startsWith('결손 감독자 1/5 · 미응답 호스트 0') || k2.ok !== false) return fail('edited-line', k2?.value ?? '-');
      return { ok: true };
    },
  },
  {
    id: 'GRD-KIND-ROLLUP-PARAMS',
    title: 'kpi-rollup kind (CODE-BODY-TO-KIND): run-supervisor\'s own tick 35–55 min old — the shipped YAML (silent after 30 min) reads «응답 없는 서브 1/3 (run-supervisor · 레지스트리 몫)»; a package copy that changes ONLY the policy the 순찰대 params name (peer_silent_after_min 60) reads «응답 없는 서브 0/3» · neither wakes nor cards',
    devices: [DEVICE],
    async run(ctx) {
      const w = ctx.device<GuardianWorld>(DEVICE);
      const age = between(ctx.random, 35, 55);
      freshPeers(w, T0, ctx.random); w.tick('run-supervisor', T0, { kpi: 0, kpiOk: true, ageMin: age });
      const k1 = kpiOf(w.pulse(T0), 'patrol');
      const dir = editedPackage(ctx.universeRoot, [['peer_silent_after_min: 30', 'peer_silent_after_min: 60']]);
      const later = at(31);
      freshPeers(w, later, ctx.random); w.tick('run-supervisor', later, { kpi: 0, kpiOk: true, ageMin: age });
      let k2: ReturnType<typeof kpiOf> = null;
      try { k2 = kpiOf(w.pulse(later, { defDir: dir }), 'patrol'); } finally { resetGuardianDef(); }
      const cards = w.posts.filter(p => p.body.includes('run-supervisor'));
      ctx.recorder.event('guardian:kind-rollup', { age, k1: k1?.value ?? null, k2: k2?.value ?? null, wakes: wakeIds(w), cards: cards.length });
      if (!k1?.value.endsWith('응답 없는 서브 1/3 (run-supervisor · 레지스트리 몫)') || k1.ok !== false) return fail('shipped-silent', k1?.value ?? '-');
      if (!k2?.value.endsWith('응답 없는 서브 0/3') || k2.ok === false) return fail('edited-not-silent', `${k2?.ok} ${k2?.value ?? '-'}`);
      if (wakeIds(w) !== '' || cards.length) return fail('guardian-acted-on-peer', `${wakeIds(w)} · ${cards.map(p => p.key).join(',')}`);
      return { ok: true };
    },
  },
  // BURST-ACTUATOR-WIRED — the resource kingdom's elastic lanes: a started burst raises a real lane (burst-scenes.ts).
  ...burstScenarios,
];
