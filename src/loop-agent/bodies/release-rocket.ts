// release-rocket (발행 매니저 · L0 OP) — LOOP-AGENT v2 body (SUPERVISOR-REVIVE-1127 «발행 매니저(로켓)»).
//
// S: the release graph executor (graphs/release-rocket · src/release-loop/release-graph-exec.ts) ticks every started run
//    every 2 min, but nothing starts the rehearsal when 22:00 comes and nobody owns «the cut / publish is late» — REL has
//    no pane, so the milestone clock fell to OP by hand (11-26: the release run was never created).
// C: the times are already state (run clock · release_schedules row · OPS-RULES defaults 22:00 / 04:00 / 06:00), the
//    run states are files, and non-critical yellow cells are waived by OP before publish (OPS-RULES · 대표 11-22).
// Q: which reversible step keeps the milestones on time without the rocket cutting or publishing itself?
// A: per tick compute each milestone (rehearsal · cut · publish) due vs done; a rehearsal that is due and not started is
//    STARTED (createRehearsal — the dry-run subset: no push/publish/tag/rail · undo = archive it); within 2 h of publish,
//    non-critical yellow cells become ONE waiver proposal mail to OP (never a waiver write). A late cut/publish is the
//    L0's: the runtime cards OP once after escalate_after_min.
//
// 세 얼굴:
//   관측 = current version (release.graph.version → plan → schedule) · release run state ⊕ rehearsal run state · checklist
//   판단 근거 = KPI late_milestones ≤ 0 (grace 15 min) · clock source (run · schedule · OPS-RULES default)
//   수복과 인계 = start-rehearsal (undo: archive the rehearsal run) · propose-waiver (mail only) · late cut/publish → OP
import type { AgentCard } from '../card.js';
import type { BodyEnv } from '../registry.js';
import type { ActionResult, AgentBody, Observation, PlannedAction, Subject } from '../runtime.js';
import { livePost } from '../live.js';
import { pv } from '../policy-context.js';

export const AGENT_ID = 'release-rocket';
/** A milestone is late this many minutes after its time. */
export const GRACE_MIN = 15;
/** Waiver proposals open this many minutes before publish (OPS-RULES · 대표 11-25 «컷은 늦게 · 발행 2h 전»). */
export const WAIVER_WINDOW_MIN = 120;
// 출처: OPS-RULES 발행 케이던스 — 예행 22:00 · 컷 04:00 · 발행 06:00 (local). Used only when no run/schedule names the times.
export const DEFAULT_CLOCK = { rehearsalHour: 22, cutHour: 4, publishHour: 6 } as const;

export interface Clock { readonly rehearsalAt: string; readonly cutAt: string; readonly publishAt: string }
export type ClockSource = 'run' | 'schedule' | 'default';
export interface RunView { readonly exists: boolean; readonly done: boolean; readonly hardStop: string | null; readonly steps: Readonly<Record<string, string>> }
export interface YellowCell { readonly id: string; readonly critical: boolean; readonly why: string }
export interface ReleaseView {
  readonly version: string;
  readonly published: boolean;
  readonly clock: Clock | null;
  readonly clockSource: ClockSource | null;
  readonly run: RunView | null;
  readonly rehearsal: RunView | null;
  /** Open yellow cells (null = checklist unreadable). */
  readonly yellow: readonly YellowCell[] | null;
}

export interface ReleaseRocketDeps {
  /** The release in play (null = unreadable → KPI unknown). */
  readRelease(now: Date): ReleaseView | null;
  /** Create the rehearsal run (the release-rocket trigger ticks it). */
  startRehearsal(version: string, clock: Clock, now: Date): { ok: boolean; line: string };
  /** Archive the rehearsal run (undo of startRehearsal); returns the archive path or null. */
  archiveRehearsal(version: string): string | null;
  post(key: string, to: string, body: string): number | string | null;
}

export type MilestoneId = 'rehearsal' | 'cut' | 'publish';
export interface Milestone { readonly id: MilestoneId; readonly dueAt: string; readonly state: 'done' | 'started' | 'pending' | 'late' | 'skipped'; readonly why: string }

const startedStatus = (s: string | undefined) => s === 'running' || s === 'done' || s === 'skipped' || s === 'would-run';

/** Milestones of a release view at `now` — pure. */
export function milestones(v: ReleaseView, now: Date): Milestone[] {
  if (!v.clock) return [];
  const t = now.getTime(); const graceMs = pv('grace_min', GRACE_MIN) * 60_000;
  const pub = Date.parse(v.clock.publishAt);
  const out: Milestone[] = [];
  // rehearsal: started = a rehearsal run exists; irrelevant once publish has passed or the version is published.
  {
    const due = Date.parse(v.clock.rehearsalAt);
    const state: Milestone['state'] = v.rehearsal?.done ? 'done' : v.rehearsal?.exists ? 'started'
      : v.published || t >= pub ? 'skipped' : t >= due + graceMs ? 'late' : 'pending';
    out.push({ id: 'rehearsal', dueAt: v.clock.rehearsalAt, state, why: state === 'late' ? `예행 ${pv('grace_min', GRACE_MIN)}분 넘게 안 시작` : state });
  }
  // cut and publish are judged only on a named clock (run · schedule) — the default clock only drives the rehearsal.
  if (v.clockSource !== 'default') {
    const cutDue = Date.parse(v.clock.cutAt);
    const cutStep = v.run?.steps.cut;
    const cutState: Milestone['state'] = v.published || cutStep === 'done' ? 'done' : startedStatus(cutStep) ? 'started'
      : t >= cutDue + graceMs ? 'late' : 'pending';
    out.push({ id: 'cut', dueAt: v.clock.cutAt, state: cutState, why: cutState === 'late' ? (v.run?.exists ? `컷 단계 ${cutStep ?? '없음'}` : '발행 런 없음') : cutState });
    const pubState: Milestone['state'] = v.published ? 'done' : v.run?.done ? 'done' : t >= pub + graceMs ? 'late' : v.run?.exists ? 'started' : 'pending';
    out.push({ id: 'publish', dueAt: v.clock.publishAt, state: pubState, why: pubState === 'late' ? `발행 안 됨${v.run?.hardStop ? ` · hard stop: ${v.run.hardStop}` : ''}` : pubState });
  }
  return out;
}

export function createBody(env: BodyEnv, deps: ReleaseRocketDeps = liveDeps(env.stateRoot, env.card)): AgentBody {
  let last: ReleaseView | null = null;
  return {
    observe(ctx): Observation {
      const v = deps.readRelease(ctx.now);
      last = v;
      if (!v) return { kpi: null, subjects: [], facts: ['발행 판(현재 버전·런 상태)을 읽지 못함 — KPI 모름'] };
      const ms = milestones(v, ctx.now);
      const facts: string[] = [`판 ${v.version}${v.published ? ' (발행 완료)' : ''} · 시각 출처 ${v.clockSource ?? '없음'}`];
      if (v.clock) facts.push(`예행 ${v.clock.rehearsalAt} · 컷 ${v.clock.cutAt} · 발행 ${v.clock.publishAt}`);
      else facts.push('시각 모름(런·일정·기본값 없음)');
      if (v.run) facts.push(`발행 런 ${v.run.exists ? (v.run.done ? '끝' : '진행') : '없음'}${v.run.hardStop ? ` · hard stop ${v.run.hardStop}` : ''}`);
      if (v.rehearsal?.exists) facts.push(`예행 런 ${v.rehearsal.done ? '끝' : '진행'}`);
      if (v.yellow) {
        const nc = v.yellow.filter(c => !c.critical);
        facts.push(`노랑 칸 ${v.yellow.length} (크리티컬 ${v.yellow.length - nc.length} · 면제 후보 ${nc.length})`);
      } else facts.push('체크리스트를 읽지 못함 — 면제 제안 없음');
      const subjects: Subject[] = ms.map(m => ({ id: `${v.version}:${m.id}`, kind: `milestone-${m.state}`, summary: `${m.id} ${m.dueAt} · ${m.why}`,
        ageMin: Math.max(0, (ctx.now.getTime() - Date.parse(m.dueAt)) / 60_000) }));
      const late = ms.filter(m => m.state === 'late');
      const patterns = late.map(m => ({ key: `late:${m.id}`, lesson: `${m.id} 이정표가 늦는 일이 반복된다(${m.why}) — 그 단계의 선행 조건을 시각 전에 미리 본다.` }));
      return { kpi: v.clock ? late.length : null, subjects, facts, ...(patterns.length ? { patterns } : {}) };
    },
    plan(_obs, ctx): PlannedAction[] {
      if (!last?.clock) return [];
      const out: PlannedAction[] = [];
      const ms = milestones(last, ctx.now);
      if (ms.some(m => m.id === 'rehearsal' && m.state === 'late'))
        out.push({ action: 'start-rehearsal', target: last.version, why: `예행 시각 ${last.clock.rehearsalAt} + ${pv('grace_min', GRACE_MIN)}분 지남 · 예행 런 없음` });
      const pub = Date.parse(last.clock.publishAt); const t = ctx.now.getTime();
      const nc = (last.yellow ?? []).filter(c => !c.critical);
      if (!last.published && nc.length && t >= pub - pv('waiver_window_min', WAIVER_WINDOW_MIN) * 60_000 && t < pub)
        out.push({ action: 'propose-waiver', target: last.version, why: `발행 ${Math.round((pub - t) / 60_000)}분 전 · 크리티컬 아닌 노랑 ${nc.length}` });
      return out;
    },
    actions: {
      'start-rehearsal': {
        describe: '시각이 지났는데 안 시작된 예행을 연다(dry-run 부분 · push·publish·tag·rail 없음 · 되돌림: 예행 런 보관)',
        run(target, ctx): ActionResult {
          if (!last || last.version !== target || !last.clock) return { ok: false, line: `${target}: 지금 판이 아니다` };
          if (last.rehearsal?.exists) return { ok: false, line: `${target}: 예행 런이 이미 있다` };
          const r = deps.startRehearsal(target, last.clock, ctx.now);
          return { ok: r.ok, line: r.line, ref: `release-graph:${target}-rehearsal`, ...(r.ok ? { undo: `archiveRehearsal ${target} (release-graph/${target}-rehearsal → 보관 · 실발행 런은 안 건드림)` } : {}) };
        },
      },
      'archive-rehearsal': {
        describe: '예행 런을 보관한다(start-rehearsal 의 되돌림 · 실발행 런은 안 건드림)',
        run(target): ActionResult {
          if (!/^\d+\.\d+\.\d+$/u.test(target)) return { ok: false, line: `${target}: 버전(x.y.z)이 아니다` };
          const where = deps.archiveRehearsal(target);
          return where ? { ok: true, line: `${target}-rehearsal 보관 → ${where}`, ref: `release-graph:${target}-rehearsal` } : { ok: false, line: `${target}: 보관할 예행 런 없음` };
        },
      },
      'propose-waiver': {
        describe: '발행 2시간 안 · 크리티컬 아닌 노랑 칸 면제를 OP 에 제안한다(우편만 · 면제 기록은 하지 않음)',
        run(target, ctx): ActionResult {
          if (!last || last.version !== target) return { ok: false, line: `${target}: 지금 판이 아니다` };
          const nc = (last.yellow ?? []).filter(c => !c.critical);
          if (!nc.length) return { ok: false, line: `${target}: 면제 후보 없음` };
          const ids = nc.map(c => c.id);
          const id = deps.post(`release-waiver:${target}:${ids.slice().sort().join(',').slice(0, 300)}`, ctx.card.supervisor,
            `[${ctx.card.name} · 면제 제안] ${target} 발행 ${last.clock?.publishAt ?? '?'} 전 — 크리티컬 아닌 노랑 ${ids.length}: ${ids.slice(0, 12).join(', ')}${ids.length > 12 ? ` +${ids.length - 12}` : ''} · 크리티컬 ${(last.yellow ?? []).length - ids.length} 는 제외 · 결정은 OP: ELANOUS_TRACK=OP eln release checklist set <id> --disposition known-issue`);
          return { ok: id !== null, line: id !== null ? `면제 제안 우편 #${id} (${ids.length} 칸)` : '면제 제안 이미 보냄(같은 칸 묶음)', ...(id !== null ? { ref: `msg:${id}` } : {}), undo: '제안만 — 기록된 면제 없음(OP 가 무시하면 끝)' };
        },
      },
    },
  };
}

// ── live ───────────────────────────────────────────────────────────────────────────────────────────────────────────
/** OPS-RULES default clock around `now` (local time): the next publish at 06:00, cut 04:00 that day, rehearsal 22:00 the night before. */
export function defaultClock(now: Date): Clock {
  const pub = new Date(now); pub.setHours(DEFAULT_CLOCK.publishHour, 0, 0, 0);
  if (now.getTime() >= pub.getTime() + pv('grace_min', GRACE_MIN) * 60_000) pub.setDate(pub.getDate() + 1);
  const cut = new Date(pub); cut.setHours(DEFAULT_CLOCK.cutHour, 0, 0, 0);
  const reh = new Date(pub); reh.setDate(reh.getDate() - 1); reh.setHours(DEFAULT_CLOCK.rehearsalHour, 0, 0, 0);
  return { rehearsalAt: reh.toISOString(), cutAt: cut.toISOString(), publishAt: pub.toISOString() };
}

type Exec = typeof import('../../release-loop/release-graph-exec.js');
const runView = (s: import('../../release-loop/release-graph-exec.js').RunState | null): RunView =>
  s ? { exists: true, done: !!s.done, hardStop: s.hardStop ? s.hardStop.reason.slice(0, 120) : null, steps: Object.fromEntries(Object.entries(s.steps).map(([k, v]) => [k, v.status])) }
    : { exists: false, done: false, hardStop: null, steps: {} };

export function liveDeps(stateRoot: string, card?: AgentCard): ReleaseRocketDeps {
  const post = livePost(stateRoot, card, AGENT_ID);
  const exec = (): Exec => require('../../release-loop/release-graph-exec.js') as Exec;
  return {
    readRelease(now) {
      try {
        const { homedir } = require('node:os') as typeof import('node:os');
        const { join } = require('node:path') as typeof import('node:path');
        const cv = require('../../ops-dashboard/current-version.js') as typeof import('../../ops-dashboard/current-version.js');
        const cur = cv.resolveCurrentVersion({ hqRoot: join(homedir(), 'elanous-hq'), graphVersion: cv.readReleaseGraphVersion() });
        const version = cur.version.replace(/-.*$/u, '');
        const x = exec();
        const run = (() => { try { return x.loadRun(stateRoot, version); } catch { return null; } })();
        const reh = (() => { try { return x.loadRun(stateRoot, x.rehearsalKey(version)); } catch { return null; } })();
        let clock: Clock | null = null; let clockSource: ClockSource | null = null;
        if (run?.clock) { clock = { rehearsalAt: run.clock.rehearsalAt, cutAt: run.clock.cutAt, publishAt: run.clock.publishAt }; clockSource = 'run'; }
        else if (cur.schedule?.cutAt && cur.schedule.publishAt) {
          const pub = new Date(cur.schedule.publishAt); const reh8 = new Date(pub.getTime() - 8 * 3_600_000);
          clock = { rehearsalAt: reh8.toISOString(), cutAt: cur.schedule.cutAt, publishAt: cur.schedule.publishAt }; clockSource = 'schedule';
        } else if (!cur.published) { clock = defaultClock(now); clockSource = 'default'; }
        let yellow: YellowCell[] | null = null;
        try {
          const { listChecklist } = require('../../release-loop/checklist.js') as typeof import('../../release-loop/checklist.js');
          const { releaseLedgerRoot } = require('../../instance/resolve.js') as typeof import('../../instance/resolve.js');
          yellow = listChecklist(version, releaseLedgerRoot()).items.filter(i => i.status === 'yellow').map(i => {
            const why = i.priority === 'P0' ? 'P0' : i.must ? 'MUST' : i.disposition === 'block' ? 'block' : '';
            return { id: i.id, critical: !!why, why: why || (i.priority ?? '-') };
          });
        } catch { yellow = null; }
        return { version, published: cur.published, clock, clockSource, run: runView(run), rehearsal: runView(reh), yellow };
      } catch { return null; }
    },
    startRehearsal(version, clock, now) {
      try {
        const x = exec();
        const release = x.loadRun(stateRoot, version);
        const at = now.toISOString();
        x.createRehearsal(stateRoot, { version, clock: release ? { ...release.clock, rehearsalAt: at } : { ...clock, rehearsalAt: at } }, now);
        return { ok: true, line: `예행 런 ${version}-rehearsal 생성(${at.slice(11, 16)}Z) — release-rocket 틱(2분)이 진행` };
      } catch (e) { return { ok: false, line: `예행 생성 실패 — ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}` }; }
    },
    archiveRehearsal(version) {
      try { return (require('../../cli/release-graph-cli.js') as typeof import('../../cli/release-graph-cli.js')).archiveRehearsal(stateRoot, version); } catch { return null; }
    },
    post: (key, to, body) => post(key, to, body, 'request'),
  };
}
