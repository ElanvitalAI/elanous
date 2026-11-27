// 수호자 (guardian) — loop agent v2 body (L1 · LLM 0). Same skeleton as the judge-butler (내부 문서 `LOOP-AGENT`):
//   observe (host probes · process lists · supply) → judge vs goal (load/ncpu ≤ 1 · orphans > 2 h = 0 · hands ≈ ready supply)
//   → act (sanitize · route · hand-scale proposals) → verify → evidence (cases) → report (RES digest) ⊕ escalate (paid VM → OP).
//
// S: 11-27 07:3x — node-b load 135/32 with 234 orphaned test universes while minim5/node-c/mbp idled; the CEO: «원격 손탭 많이
//    늘려도 됩니다 · 자원 새너타이징은 자원국이 해야 할 일이고 수호자와 함께».
// C: nothing owned «processes nobody needs», «which host runs the next check» or «enough hands for the ready supply».
// A: one tick: ① sanitize — kill expired/orphaned test universes by exact PID (reaper.ts) ② route — write the least-loaded local
//    host to `<state>/res/route.json` (pregate · self gate --remote read it) ③ hand-scale — when ready cells ≥ 2 × idle hands and
//    a local host has headroom, propose remote hand tabs there (sanitize → one real task PASS → enroll · tier by difficulty) to
//    RES; idle hands > 4 h → propose scale-down; no local headroom → escalate a paid VM start to OP (never started here).
import { pickHost, ratio, isPaid, HEADROOM_RATIO, type HostProbe } from './hosts.js';
import { planReap, type Proc, type ReapCandidate, type Registration } from './reaper.js';
import { fixed, kpiBreached, type KpiTarget } from '../kit/kpi/index.js';
import type { ButlerLevel, ButlerMemory, Case } from '../judge-butler/memory.js';

export const GUARDIAN_ID = 'guardian';
export const GUARDIAN_SEAT = 'GUARDIAN';
export const GUARDIAN_SUPERVISOR = 'RES';
export const GUARDIAN_DEMOTERS = new Set(['RES', 'OP', 'CLAUDE-OP', 'CEO']);
export const SCALE_RATIO = 2;
export const SCALE_HEADROOM = 0.6; // a host takes new hands only below this load/ncpu
export const IDLE_HAND_SCALE_DOWN_MS = 4 * 60 * 60_000;
export const PROPOSAL_EVERY_MS = 60 * 60_000;

export interface HandIn { readonly seat: string; readonly host: string | null; readonly state: 'idle' | 'working' | 'no-pane'; readonly idleMs: number }
export interface GuardianView {
  readonly now: Date;
  readonly probes: readonly HostProbe[];
  /** host → its processes (null = could not list) */
  readonly procs: ReadonlyMap<string, readonly Proc[] | null>;
  readonly registry: ReadonlyMap<string, readonly Registration[]>;
  /** ready (yellow, unowned) cells in the target release, by difficulty */
  readonly ready: { readonly total: number; readonly p0: number } | null;
  readonly hands: readonly HandIn[] | null;
  /** pids this tick must never touch, per host (itself and its parents) */
  readonly self?: ReadonlyMap<string, ReadonlySet<number>>;
  /** DETECT-TO-ACTION: «미정상화 사건» (kit/case-ledger open cases · target 0) · null/absent = unread. */
  readonly cases?: { readonly open: number; readonly overdue: number } | null;
}

export interface GuardianPorts {
  readonly memory: ButlerMemory;
  kill(host: string, cands: readonly ReapCandidate[]): { killed: number[]; skipped: number[] };
  writeRoute(route: { host: string | null; why: string; ranked: Array<{ host: string; ratio: number }>; at: string }): void;
  post(key: string, to: string, body: string, kind?: string): number | null;
  audit(row: Record<string, unknown>): void;
  /** shared reaper lock (live: withReapLock) — kill ⊕ audit run inside it · absent = run as is */
  reapLock?<T>(fn: () => T): T;
  /** `${host}:${pid}` reaped within the window by any actor (shared reaper audit) — read inside reapLock · absent = none */
  recentReaps?(nowMs: number): ReadonlySet<string>;
}

export interface GuardianPlan {
  readonly reap: Map<string, ReapCandidate[]>;
  readonly route: ReturnType<typeof pickHost>;
  readonly scaleUp: { readonly hosts: string[]; readonly count: number; readonly tier: 'high' | 'mid'; readonly why: string } | null;
  readonly scaleDown: string[];
  readonly paidEscalation: string | null;
  readonly kpi: { maxRatio: number | null; overloaded: string[]; orphansOver2h: number; unnormalized?: number | null };
}

/** 임대관 KPI «load/ncpu ≤ 1.0» — a host above HEADROOM_RATIO is overloaded. */
const LOAD_KPI: KpiTarget = { target: HEADROOM_RATIO, dir: 'at_most' };

/** Pure: one observation → the plan. */
export function planGuardian(view: GuardianView): GuardianPlan {
  const nowMs = view.now.getTime();
  const reap = new Map<string, ReapCandidate[]>();
  for (const [host, procs] of view.procs) if (procs) reap.set(host, planReap(procs, view.registry.get(host) ?? [], nowMs, { self: view.self?.get(host) ?? new Set() }));
  const route = pickHost(view.probes);
  const measured = view.probes.filter(p => p.reachable && p.load1 !== null && p.ncpu);
  const overloaded = measured.filter(p => kpiBreached(LOAD_KPI, ratio(p)) === true).map(p => p.host); // raw ratio vs target (kit/kpi)
  const maxRatio = measured.length ? Math.max(...measured.map(ratio)) : null;
  const orphansOver2h = [...reap.values()].reduce((n, c) => n + c.length, 0);
  let scaleUp: GuardianPlan['scaleUp'] = null; let paidEscalation: string | null = null;
  const idle = view.hands?.filter(h => h.state === 'idle').length ?? null;
  if (view.ready && idle !== null && view.ready.total >= SCALE_RATIO * Math.max(1, idle)) {
    const room = measured.filter(p => !isPaid(p.host) && p.host !== 'mshq' && !p.reserved && ratio(p) < SCALE_HEADROOM).sort((a, b) => ratio(a) - ratio(b));
    const want = Math.max(1, Math.ceil(view.ready.total / SCALE_RATIO) - idle);
    if (room.length) {
      const hosts: string[] = [];
      for (let i = 0; i < want; i++) hosts.push(room[i % room.length]!.host);
      scaleUp = { hosts, count: want, tier: view.ready.p0 > 0 ? 'high' : 'mid', why: `ready ${view.ready.total} ≥ ${SCALE_RATIO} × idle ${idle} · headroom ${room.map(p => `${p.host} ${ratio(p).toFixed(2)}`).join(' ')}` };
    } else paidEscalation = `ready ${view.ready.total} ≥ ${SCALE_RATIO} × idle ${idle} but no local host under ${SCALE_HEADROOM} load/ncpu — a paid VM (res lease) is OP's call`;
  }
  const scaleDown = (view.hands ?? []).filter(h => h.state === 'idle' && h.idleMs >= IDLE_HAND_SCALE_DOWN_MS).map(h => h.seat);
  return { reap, route, scaleUp, scaleDown, paidEscalation, kpi: { maxRatio, overloaded, orphansOver2h, ...(view.cases !== undefined ? { unnormalized: view.cases?.open ?? null } : {}) } };
}

export interface GuardianReport {
  readonly level: ButlerLevel;
  readonly at: string;
  readonly reaped: Record<string, number>;
  readonly skipped: Record<string, number>;
  readonly route: string | null;
  readonly proposals: string[];
  readonly escalations: string[];
  readonly kpi: GuardianPlan['kpi'];
}

const kase = (k: Case['kind'], subject: string, why: string, now: Date, refs?: readonly string[], extra?: Record<string, unknown>): Case =>
  ({ at: now.toISOString(), kind: k, subject, why, ...(refs?.length ? { refs } : {}), decidedBy: GUARDIAN_SEAT, supervisedBy: GUARDIAN_SUPERVISOR, ...(extra ? { extra } : {}) });

/** One tick. `off` = nothing · `shadow` = plan only · `L1`/`live` = act (the voice is the only difference). */
/** `steps` = which sub-agent duties run (대식세포 sanitize · 임대관 route + scale); default all (the 15-min maintenance tick). */
export type GuardianStep = 'sanitize' | 'route' | 'scale';
export function runGuardian(view: GuardianView, ports: GuardianPorts, steps: ReadonlySet<GuardianStep> = new Set(['sanitize', 'route', 'scale'])): GuardianReport {
  const mem = ports.memory; const now = view.now; const nowMs = now.getTime();
  const level = mem.level().level;
  const plan = planGuardian(view);
  const report: GuardianReport = { level, at: now.toISOString(), reaped: {}, skipped: {}, route: plan.route.host, proposals: [], escalations: [], kpi: plan.kpi };
  if (level === 'off' || level === 'shadow') return report;
  const state = mem.readState();
  // ① sanitize — exact PID, re-verified, audited
  for (const [host, cands] of steps.has('sanitize') ? plan.reap : new Map<string, ReapCandidate[]>()) {
    if (!cands.length) continue;
    let already = 0;
    const res = (ports.reapLock ?? (<T,>(fn: () => T) => fn()))(() => {
      // re-validate INSIDE the lock (Terra #40447 must-fix 2): the plan was computed before it — a target another actor (the
      // macrophage card) reaped in the window is skipped, so one target is signalled and audited once
      const recent = ports.recentReaps?.(now.getTime()) ?? new Set<string>();
      const todo = cands.filter(c => !recent.has(`${host}:${c.pid}`));
      already = cands.length - todo.length;
      const r = todo.length ? ports.kill(host, todo) : { killed: [] as number[], skipped: [] as number[] };
      for (const c of todo) if (r.killed.includes(c.pid)) ports.audit({ at: now.toISOString(), host, pid: c.pid, pgid: c.pgid, ageH: Math.round(c.ageMs / 3_600_000), cpu: c.cpu, why: c.why, command: c.command.slice(0, 120), by: GUARDIAN_SEAT });
      return { killed: r.killed, skipped: [...r.skipped, ...cands.filter(c => recent.has(`${host}:${c.pid}`)).map(c => c.pid)] };
    });
    report.reaped[host] = res.killed.length; report.skipped[host] = res.skipped.length;
    mem.appendCase(kase('reap', host, `killed ${res.killed.length} · skipped ${res.skipped.length} (changed/gone${already ? ` · ${already} already reaped by another actor` : ''}) of ${cands.length}: ${[...new Set(cands.map(c => c.why.split(' ').slice(0, 2).join(' ')))].join(', ')}`, now, res.killed.slice(0, 20).map(p => `pid:${host}:${p}`)));
  }
  // ② route
  if (steps.has('route')) ports.writeRoute({ ...plan.route, at: now.toISOString() });
  if (steps.has('route') && plan.route.host) mem.appendCase(kase('route', plan.route.host, plan.route.why, now));
  // ③ hand-scale (proposals within rights · paid VM escalated)
  const hourly = (key: string) => { const at = state.sent[key]; return !at || nowMs - Date.parse(at) >= PROPOSAL_EVERY_MS; };
  if (steps.has('scale') && plan.scaleUp && hourly('scale-up')) {
    const s = plan.scaleUp;
    const body = `[수호자 · 손 늘리기 제안] ${s.why}. 원격 손 탭 ${s.count}개: ${s.hosts.join(', ')} · 모델 등급 ${s.tier}(P0 칸 있으면 high). 절차 = 새너타이즈(eln res reap --apply --host <h>) → 실제 작업 1회 PASS → 편입(memory resource-onboard-verify-first). 수호자는 제안만 — 탭 기동은 RES.`;
    const id = ports.post(`scale-up:${now.toISOString().slice(0, 13)}`, GUARDIAN_SUPERVISOR, body, 'request');
    if (id !== null) { state.sent['scale-up'] = now.toISOString(); report.proposals.push(`scale-up#${id}`); mem.appendCase(kase('hand-propose', s.hosts.join(','), s.why, now, [`msg:${id}`])); }
  }
  if (steps.has('scale') && plan.scaleDown.length && hourly('scale-down')) {
    const id = ports.post(`scale-down:${now.toISOString().slice(0, 13)}`, GUARDIAN_SUPERVISOR, `[수호자 · 손 줄이기 제안] ${IDLE_HAND_SCALE_DOWN_MS / 3_600_000}h 넘게 유휴: ${plan.scaleDown.slice(0, 12).join(', ')} — 닫기 전 몫 이관(seat-close-needs-ownership-handoff).`, 'request');
    if (id !== null) { state.sent['scale-down'] = now.toISOString(); report.proposals.push(`scale-down#${id}`); mem.appendCase(kase('hand-scale-down', plan.scaleDown.join(','), 'idle > 4h', now, [`msg:${id}`])); }
  }
  if (steps.has('scale') && plan.paidEscalation && hourly('paid')) {
    const id = ports.post(`paid-vm:${now.toISOString().slice(0, 13)}`, 'OP', `[수호자 → OP · 유료 VM 판단] ${plan.paidEscalation}. 수호자는 유료 VM 을 켜지 않는다 — eln res lease request --host <vm> 은 OP 결정.`, 'request');
    if (id !== null) { state.sent['paid'] = now.toISOString(); report.escalations.push(`paid#${id}`); mem.appendCase(kase('paid-escalate', 'OP', plan.paidEscalation, now, [`msg:${id}`])); }
  }
  // report: RES digest at most every 30 min, only when something moved
  const moved = Object.values(report.reaped).reduce((a, b) => a + b, 0) + report.proposals.length + report.escalations.length;
  if (moved && (!state.lastDigestAt || nowMs - Date.parse(state.lastDigestAt) >= 30 * 60_000)) {
    ports.post(`guardian-digest:${now.toISOString().slice(0, 16)}`, GUARDIAN_SUPERVISOR,
      `[수호자 · 30분] 정리 ${Object.entries(report.reaped).map(([h, n]) => `${h} ${n}`).join(' · ') || '0'} · 경로 ${plan.route.host ?? '?'} · 과부하 ${plan.kpi.overloaded.join(',') || '없음'} (최대 load/ncpu ${fixed(plan.kpi.maxRatio)})${plan.kpi.unnormalized !== undefined ? ` · 미정상화 사건 ${plan.kpi.unnormalized ?? '?'}(목표 0)` : ''} · 제안 ${report.proposals.length} · OP 올림 ${report.escalations.length} — eln loop guardian status`, 'status');
    state.lastDigestAt = now.toISOString();
  }
  state.lastTickAt = now.toISOString();
  mem.writeState(state);
  return report;
}
