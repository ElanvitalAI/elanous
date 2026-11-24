// SESSION-AUTOPILOT (대표 11-24 15:0x) — «자율주행(autopilot) 모드»: a common eln feature for any seat / any user session.
//
// S: a session that is told «keep going toward this goal» still stops after each turn unless a wake happens to be armed,
//    and every in-policy decision waits for the person.
// C: the person wants to say «자율주행 시작» once and have the session keep itself running toward the goal, decide what
//    policy already allows, give the wheel back the moment a human types, and stop itself (one decision card) when it
//    loops without progress (it backs off; volume alone never stops it).
// Q: where does that live without new switches and without keyword grounding?
// A: one state file per memory store (seat / project / user) + this controller. The model turns it on/off through the
//    structured `autopilot_set` tool (session-autopilot/autopilot-tool.ts); `/autopilot on|off|resume|hold` calls the
//    same `set` directly. Coordinator seats (OP) start ON with a STANDING goal — the release cycle
//    «<v> 개발 → <v> 컷·발행 → <v+1> 개발 …» — that rolls by itself when <v>/release.json gets its publishedAt.
//
// 세 얼굴:
//   관측 = debug.log('autopilot', on|off|pause|resume|stop|goal-rolled|armed|decided, {reason, goal, …})
//   인지 = turnEnded(): same-failure streak · self-wakes with no change (reply fingerprint) · paused · wake armed?
//   수복과 인계 = no wake armed → arm one (cadence) · human takeover → pause, auto-resume after 10 min idle ·
//                 runaway (3× same failure · 3 self-wakes with no change) → BACK OFF to 30-min wakes + log; one
//                 decision card only if the back-off persists 2 h. Volume alone never stops it (대표 11-24 15:5x:
//                 the hourly turn cap counted every mail turn and stopped OP in 10 min — removed; a stored
//                 «시간당 자율 턴 상한» stop is cleared on load, logged once). Cost guard: no per-seat token budget
//                 exists in config yet → skipped.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { autopilotGoalsFile, goalLines, nearestGoalChip, OP_GOAL_SEED, readGoals, seedGoalsIfMissing, takeProgressCardsDue, timeToDue, type AutopilotGoal } from './goals.js';

export const AUTOPILOT_DEFAULT_CADENCE_MS = 30 * 60_000;
/** Sooner wake when the turn left open work (a requirement or goal continuation still pending). */
export const AUTOPILOT_OPEN_WORK_CADENCE_MS = 5 * 60_000;
/** Human takeover auto-resumes after this much quiet. */
export const AUTOPILOT_RESUME_AFTER_MS = 10 * 60_000;
/** Same failure N× in a row, or N self-wakes whose reply did not change → back off. */
export const AUTOPILOT_RUNAWAY_REPEATS = 3;
/** While backed off every self wake is this far apart. */
export const AUTOPILOT_BACKOFF_CADENCE_MS = 30 * 60_000;
/** A back-off that persists this long → one decision card. */
export const AUTOPILOT_BACKOFF_CARD_AFTER_MS = 2 * 60 * 60_000;
/** The legacy hourly-cap stop reason (removed guard) — cleared on load. */
const LEGACY_CAP_STOP = /^시간당 자율 턴 상한/u;

export type AutopilotPhase = '개발' | '컷·발행';

export interface AutopilotState {
  v: 1;
  on: boolean;
  goal?: string;
  /** Epoch ms after which autopilot turns itself off. */
  until?: number;
  since?: number;
  /** STANDING goal (coordinator release cycle): the goal is re-derived from the release ledger, not typed. */
  standing?: { version: string; phase: AutopilotPhase };
  paused?: { at: number; hold: boolean; lastHumanAt: number };
  /** Legacy (pre-11-24 15:5x) — nothing stops autopilot on volume any more; a cap stop is cleared on load. */
  stopped?: { at: number; reason: string; decisionId?: string };
  failure?: { sig: string; count: number };
  /** Self-wake reply fingerprint streak (no change = no progress). */
  noProgress?: { fingerprint: string; count: number };
  /** Runaway back-off: 30-min self wakes until a turn makes progress; one card after 2 h. */
  backoff?: { since: number; reason: string; cardId?: string };
  nextWakeAt?: number;
  wakeId?: string;
  /** Who last changed the switch: 'default' (coordinator boot) · 'tool' · 'slash'. */
  by?: string;
  /** Origin of the turn now running (written by the TUI at turn start) — the goal tools refuse writes in an 'auto' turn. */
  turnOrigin?: 'human' | 'auto';
}

export const AUTOPILOT_EMPTY: AutopilotState = { v: 1, on: false };

// ── store ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** `<memory store dir>/.autopilot/state.json` — the same store the session's memory uses (seat · project · user). */
export function autopilotStateFile(cwd: string, deps: { env?: NodeJS.ProcessEnv; baseRoot?: string; userRoot?: string } = {}): string {
  const override = (deps.env ?? process.env).ELANOUS_AUTOPILOT_STATE_FILE?.trim();
  if (override) return override;
  const { resolveMemoryStore } = require('../seat-memory/memory-store.js') as typeof import('../seat-memory/memory-store.js');
  return join(resolveMemoryStore(cwd, deps).dir, '.autopilot', 'state.json');
}

export function readAutopilotState(file: string): AutopilotState | null {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  try {
    const parsed = JSON.parse(text) as Partial<AutopilotState>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.on !== 'boolean') return null;
    const { turns: _legacyTurns, ...rest } = parsed as Partial<AutopilotState> & { turns?: unknown };
    return { ...rest, v: 1, on: parsed.on };
  } catch { return null; }
}

export function writeAutopilotState(file: string, state: AutopilotState): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, file);
}

// ── standing goal: the coordinator's release cycle ──────────────────────────────────────────────────────────────────
export interface StandingGoal { version: string; phase: AutopilotPhase }
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
export const nextPatch = (v: string): string => { const m = SEMVER.exec(v)!; return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`; };

/**
 * The version in play and its phase (대표 11-24 15:5x: the first cut read «0.3.34 개발» after 0.3.34 shipped — this host's
 * ledger had no release.json for it). Current = the release resolver (ops-dashboard/current-version: plan
 * `status: current` → a schedule newer than the last release → package); a version that is already published —
 * release.json publishedAt, or the INSTALLED build is that release or newer (the rail installs only published
 * releases) — is done, so the goal moves to the next checklist version (else +1 patch). Phase = «컷·발행» once the
 * cut is prepared or its scheduled cut time has passed.
 */
export function resolveStandingGoal(input: { hqRoot: string; ledgerRoot: string; installedVersion?: string; now?: number; packageVersion?: string }): StandingGoal | null {
  const { resolveCurrentVersion, isPublishedVersion, compareVersions } = require('../ops-dashboard/current-version.js') as typeof import('../ops-dashboard/current-version.js');
  const { assignedVersions, readSchedule } = require('../release-loop/feature-store.js') as typeof import('../release-loop/feature-store.js');
  const current = resolveCurrentVersion({ hqRoot: input.hqRoot, ledgerRoot: input.ledgerRoot, ...(input.packageVersion ? { packageVersion: input.packageVersion } : {}) });
  let version = current.version.replace(/-.*$/, '');
  if (!SEMVER.test(version)) return null;
  const installed = input.installedVersion && SEMVER.test(input.installedVersion) ? input.installedVersion : null;
  let assigned: string[] = [];
  try { assigned = assignedVersions(input.ledgerRoot).filter((v) => SEMVER.test(v)); } catch { /* no checklist ledger */ }
  const published = (v: string): boolean => isPublishedVersion(v, input.ledgerRoot) || (installed !== null && compareVersions(installed, v) >= 0);
  for (let guard = 0; guard < 50 && published(version); guard += 1) {
    version = assigned.filter((v) => compareVersions(v, version) > 0).sort(compareVersions)[0] ?? nextPatch(version);
  }
  let cut = existsSync(join(input.ledgerRoot, 'release', version, 'prepared'));
  if (!cut) {
    try { const row = readSchedule(version, input.ledgerRoot); cut = row !== null && Date.parse(row.cutAt) <= (input.now ?? Date.now()); } catch { /* no schedule */ }
  }
  return { version, phase: cut ? '컷·발행' : '개발' };
}

export const standingGoalText = (s: StandingGoal): string => `${s.version} ${s.phase}`;

/** The decision-autonomy paragraph for the turn's volatile (non-cached) context while autopilot is ON. */
export function autopilotPolicyParagraph(state: AutopilotState | null, goals: readonly AutopilotGoal[] = [], now = Date.now()): string | null {
  if (!state?.on || state.stopped) return null;
  const goal = state.goal ? ` · 목표: ${state.goal}` : '';
  const lines = goalLines(goals, now);
  const stack = lines.length ? `\n사람이 정한 목표(가까운 기한 순):\n${lines.join('\n')}\n목표는 사람만 정한다 — 새 목표가 필요해 보이면 제안 카드(decisions raise)로만 올린다.` : '';
  if (state.paused) {
    return `## 🚗 자율주행 일시정지 (사람 운전)${goal}\n사람이 운전대를 잡았다 — 이번 상호작용은 평소처럼 사람의 말을 따른다. 사람이 «다시 자율주행»이라고 하면 autopilot_set({on:true})를 부르고, «계속 내가 운전»이면 autopilot_set({on:true, hold:true})를 부른다.${stack}`;
  }
  return `## 🚗 자율주행 켜짐${goal}\n`
    + '정책 안의 일은 이 턴에서 스스로 정하고 진행한다: 운영·재시도·재측정·배정·약속 마감·기존 게이트 안의 착지. '
    + '사람에게는 돈·보안 사고·되돌릴 수 없는 행동·방향 결정만 결정 카드(decisions raise)로 올린다. '
    + '스스로 정한 결정마다 autopilot_set({decided:{kind, criterion}}) 한 번으로 기록한다. '
    + '턴을 끝낼 때는 목표를 향한 다음 한 걸음(열린 일·다음 점검 시각)을 한 줄로 남긴다 — 깨움은 자율주행이 건다.' + stack;
}

// ── controller ────────────────────────────────────────────────────────────────────────────────────────────────────
export interface AutopilotSetRequest {
  on?: boolean;
  goal?: string;
  until?: string;
  /** with on:true — «계속 내가 운전»: stay paused until resumed. */
  hold?: boolean;
  /** an in-turn autonomous decision to record (no state change). */
  decided?: { kind: string; criterion: string };
}

export interface AutopilotDecisionCard { title: string; reason: string; goal: string | undefined; sessionId: string | undefined }

export interface AutopilotDeps {
  file: string;
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
  /** Raise the one decision card when a back-off persists 2 h; returns the card id. */
  raiseDecision?: (card: AutopilotDecisionCard) => string | undefined;
  /** Coordinator seats start ON with the standing goal (once — an explicit off is persisted and kept). */
  coordinator?: boolean;
  /** The standing goal source (coordinator release cycle) — production: resolveStandingGoal. */
  standingGoal?: () => StandingGoal | null;
  sessionId?: string;
  notify?: (line: string) => void;
  /** The one near-due progress card per goal (goal · progress · blocking · ETA go in the card). */
  postProgress?: (goal: AutopilotGoal, timeToDue: string) => void;
}

export interface AutopilotTurnEnd {
  /** The turn was opened by autopilot's OWN wake (not mail · notice · person · retro). Only these count for no-progress. */
  selfInitiated: boolean;
  /** The turn's reply text — the same reply on consecutive self wakes = no progress. */
  fingerprint?: string;
  failed: boolean;
  /** Normalized failure text (error / stop reason) — the repeat signature. */
  failureSig?: string;
  /** Requirement / goal continuation still open → wake sooner. */
  openWork?: boolean;
  /** Earliest already-scheduled wake (ms) — present = nothing to arm. */
  scheduledWakeAt?: number;
  /** An existing rhythm (seat retro / bulletin) already wakes this session — coordinators add no extra timer. */
  rhythmActive?: boolean;
}

export type AutopilotTurnEndResult = { arm: { delayMs: number; reason: string } | null; backoff?: string };

const clock = (ms: number): string => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const short = (text: string | undefined, max = 24): string => {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return Array.from(t).length > max ? `${Array.from(t).slice(0, max - 1).join('')}…` : t;
};

/** `HH:MM` (next occurrence) or an ISO timestamp → epoch ms; null when unparseable. */
export function parseAutopilotUntil(value: string, now: number): number | null {
  const hm = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (hm) {
    const h = Number(hm[1]); const m = Number(hm[2]);
    if (h > 23 || m > 59) return null;
    const d = new Date(now); d.setHours(h, m, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

export function createAutopilot(deps: AutopilotDeps) {
  const now = deps.now ?? Date.now;
  const log = (event: string, data: Record<string, unknown>): void => {
    try { (deps.log ?? ((e, d) => debug.log('autopilot', e, d)))(event, data); } catch { /* observability is fail-open */ }
  };
  let state: AutopilotState = { ...AUTOPILOT_EMPTY };
  const goalsFile = autopilotGoalsFile(deps.file);
  const goals = (): AutopilotGoal[] => readGoals(goalsFile) ?? [];
  /** Near-due mid/long goals → one progress card each (only while ON). */
  const progressCards = (): void => {
    if (!state.on) return;
    const t = now();
    for (const g of takeProgressCardsDue(goalsFile, t)) {
      log('goal-near', { id: g.id, level: g.level, title: g.title, due: g.due });
      try { deps.postProgress?.(g, timeToDue(g.due, t)); } catch (error) { log('progress-card-failed', { id: g.id, error: String(error) }); }
    }
  };
  const save = (): void => {
    try { writeAutopilotState(deps.file, state); }
    catch (error) { log('persist-failed', { error: error instanceof Error ? error.message : String(error) }); }
  };
  /** Re-read the file (the REPL child's autopilot_set writes it) and roll the standing goal. */
  const refresh = (): AutopilotState => {
    const read = readAutopilotState(deps.file);
    if (read) {
      state = read;
      // Migration: the removed hourly cap left OP STOPPED — clear that stop once (logged once: the save drops it).
      if (state.stopped && LEGACY_CAP_STOP.test(state.stopped.reason)) {
        const { stopped, ...rest } = state;
        state = rest;
        log('migrated', { cleared: 'stopped', reason: stopped.reason, ...(stopped.decisionId ? { decisionId: stopped.decisionId } : {}) });
        save();
      }
    } else if (deps.coordinator) {
      // Coordinator default: ON with the standing goal, persisted (an explicit off later is kept).
      const standing = standingNow();
      state = { v: 1, on: true, since: now(), by: 'default',
        ...(standing ? { standing, goal: standingGoalText(standing) } : { goal: '다음 판 개발·발행' }) };
      log('on', { reason: 'coordinator-default', goal: state.goal });
      save();
    }
    if (deps.coordinator) { try { seedGoalsIfMissing(goalsFile, OP_GOAL_SEED); } catch (error) { log('goals-seed-failed', { error: String(error) }); } }
    rollStanding();
    return state;
  };
  const standingNow = (): StandingGoal | null => { try { return deps.standingGoal?.() ?? null; } catch { return null; } };
  const rollStanding = (): void => {
    if (!state.on || !state.standing || !deps.standingGoal) return;
    const derived = standingNow();
    if (!derived || (derived.version === state.standing.version && derived.phase === state.standing.phase)) return;
    const from = standingGoalText(state.standing); const to = standingGoalText(derived);
    const rolled = derived.version !== state.standing.version;
    state = { ...state, standing: derived, goal: to };
    log(rolled ? 'goal-rolled' : 'goal-phase', { from, to });
    deps.notify?.(`🚗 목표 ${from} → ${to}`);
    save();
  };
  const active = (): boolean => state.on && !state.stopped && !state.paused;
  const resume = (reason: string): void => {
    if (!state.on || !state.paused) return;
    // A resume is a fresh start for the runaway accounting too: no stop, no back-off, no streaks carried over.
    const { paused: _paused, stopped: _stopped, backoff: _backoff, failure: _failure, noProgress: _noProgress, ...rest } = state;
    state = rest;
    log('resume', { reason, goal: state.goal });
    save();
  };

  const api = {
    refresh,
    state: (): AutopilotState => state,
    goals,
    goalsFile,
    paragraph: (): string | null => autopilotPolicyParagraph(state, goals(), now()),
    /** The TUI marks each turn's origin so the goal tools (REPL child) can refuse writes in autonomous turns. */
    noteTurnStart(origin: 'human' | 'auto'): void {
      if (state.turnOrigin === origin) return;
      state = { ...state, turnOrigin: origin };
      save();
    },
    isActive: (): boolean => active(),
    /** The structured switch — the autopilot_set tool and `/autopilot` both land here. */
    set(req: AutopilotSetRequest, source: 'tool' | 'slash'): { ok: boolean; text: string } {
      refresh();
      const t = now();
      if (req.decided) {
        log('decided', { kind: String(req.decided.kind ?? ''), criterion: String(req.decided.criterion ?? ''), goal: state.goal, source });
        return { ok: true, text: 'recorded' };
      }
      if (req.on === false) {
        if (!state.on) return { ok: true, text: '🚗 자율주행 이미 꺼짐' };
        state = { v: 1, on: false, by: source, ...(state.goal ? { goal: state.goal } : {}), ...(state.standing ? { standing: state.standing } : {}) };
        log('off', { reason: source, goal: state.goal });
        save();
        return { ok: true, text: '🚗 자율주행 꺼짐 — 다시 켤 때까지 꺼진 채로 둔다' };
      }
      if (req.on !== true) return { ok: false, text: 'autopilot_set: on(true|false) 또는 decided 가 필요하다' };
      let until: number | undefined;
      if (req.until !== undefined && req.until !== '') {
        const parsed = parseAutopilotUntil(req.until, t);
        if (parsed === null) return { ok: false, text: `until 은 «HH:MM» 또는 ISO 시각 — 받은 값 ${JSON.stringify(req.until)}` };
        until = parsed;
      }
      const goal = req.goal?.trim() || undefined;
      if (req.hold) {
        if (!state.on) return { ok: false, text: '🚗 자율주행이 꺼져 있다 — 먼저 켜라' };
        state = { ...state, paused: { at: state.paused?.at ?? t, hold: true, lastHumanAt: t } };
        log('pause', { reason: 'human-hold', goal: state.goal });
        save();
        return { ok: true, text: '🚗 PAUSED · 사람 운전 (다시 자율주행이라고 할 때까지)' };
      }
      if (state.on && !state.stopped && state.paused && !goal) {
        resume(source);
        return { ok: true, text: api.statusText() };
      }
      const keepStanding = !goal && state.standing ? { standing: state.standing } : {};
      state = { v: 1, on: true, since: t, by: source, ...keepStanding,
        ...(goal ? { goal } : state.goal ? { goal: state.goal } : {}), ...(until !== undefined ? { until } : {}) };
      log('on', { reason: source, goal: state.goal, ...(until !== undefined ? { until } : {}) });
      save();
      return { ok: true, text: api.statusText() };
    },
    /** A human keystroke / turn = the person takes the wheel. */
    noteHuman(): void {
      if (!state.on || state.stopped) return;
      const t = now();
      if (state.paused) { state = { ...state, paused: { ...state.paused, lastHumanAt: t } }; return; }
      state = { ...state, paused: { at: t, hold: false, lastHumanAt: t } };
      log('pause', { reason: 'human-input', goal: state.goal });
      save();
    },
    /** Periodic: `until` reached → off · 10 min without human input → resume. Returns true when it resumed. */
    tick(): boolean {
      const t = now();
      if (state.on && state.until !== undefined && t >= state.until) {
        state = { v: 1, on: false, by: 'until', ...(state.goal ? { goal: state.goal } : {}), ...(state.standing ? { standing: state.standing } : {}) };
        log('off', { reason: 'until-reached', goal: state.goal });
        save();
        return false;
      }
      rollStanding();
      progressCards();
      if (state.on && state.paused && !state.paused.hold && t - state.paused.lastHumanAt >= AUTOPILOT_RESUME_AFTER_MS) {
        resume('idle-10m');
        return true;
      }
      return false;
    },
    resume,
    /** Turn end: runaway accounting (back off, never stop on volume), then whether to arm a self wake. */
    turnEnded(end: AutopilotTurnEnd): AutopilotTurnEndResult {
      refresh();
      if (!state.on || state.stopped) return { arm: null };
      progressCards();
      const t = now();
      let runaway: string | null = null;
      if (end.failed) {
        const sig = (end.failureSig ?? 'failed').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160);
        const count = state.failure?.sig === sig ? state.failure.count + 1 : 1;
        state = { ...state, failure: { sig, count } };
        if (count >= AUTOPILOT_RUNAWAY_REPEATS) runaway = `같은 실패 ${count}회: ${short(sig, 60)}`;
      } else if (state.failure) {
        const { failure: _f, ...rest } = state; state = rest;
      }
      let progressed = !end.failed;
      if (end.selfInitiated && state.wakeId) { const { wakeId: _consumed, ...rest } = state; state = rest; }
      if (end.selfInitiated) {
        const fingerprint = createHash('sha256').update((end.fingerprint ?? '').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
        const count = state.noProgress?.fingerprint === fingerprint ? state.noProgress.count + 1 : 1;
        state = { ...state, noProgress: { fingerprint, count } };
        if (count >= AUTOPILOT_RUNAWAY_REPEATS) { runaway ??= `자율 깨움 ${count}회 변화 없음`; progressed = false; }
        else if (count > 1) progressed = false;
      }
      if (runaway) {
        if (!state.backoff) {
          state = { ...state, backoff: { since: t, reason: runaway } };
          log('backoff', { reason: runaway, goal: state.goal });
        } else if (!state.backoff.cardId && t - state.backoff.since >= AUTOPILOT_BACKOFF_CARD_AFTER_MS) {
          let cardId: string | undefined;
          try { cardId = deps.raiseDecision?.({ title: `자율주행 감속 2시간 · ${short(runaway, 50)}`, reason: runaway, goal: state.goal, sessionId: deps.sessionId }); }
          catch (error) { log('decision-failed', { error: error instanceof Error ? error.message : String(error) }); }
          state = { ...state, backoff: { ...state.backoff, cardId: cardId ?? 'raise-failed' } };
          log('backoff-card', { reason: runaway, goal: state.goal, ...(cardId ? { decisionId: cardId } : {}) });
        }
      } else if (progressed && state.backoff) {
        const { backoff, ...rest } = state; state = rest;
        log('backoff-cleared', { reason: backoff.reason, goal: state.goal });
      }
      if (state.paused) { save(); return { arm: null, ...(state.backoff ? { backoff: state.backoff.reason } : {}) }; }
      if (end.scheduledWakeAt !== undefined) { state = { ...state, nextWakeAt: end.scheduledWakeAt }; save(); return { arm: null }; }
      if (end.rhythmActive && deps.coordinator && !state.backoff) { save(); return { arm: null }; }
      const delayMs = state.backoff ? AUTOPILOT_BACKOFF_CADENCE_MS : end.openWork ? AUTOPILOT_OPEN_WORK_CADENCE_MS : AUTOPILOT_DEFAULT_CADENCE_MS;
      save();
      return { arm: { delayMs, reason: `🚗 자율주행: 목표를 향해 이어서 진행${state.goal ? ` — ${state.goal}` : ''}` }, ...(state.backoff ? { backoff: state.backoff.reason } : {}) };
    },
    /** The armed self wake fired and its turn is the one now ending (TUI: the wake id left the scheduler). */
    ownWakeId: (): string | undefined => state.wakeId,
    noteArmed(wakeId: string, dueAt: number): void {
      state = { ...state, wakeId, nextWakeAt: dueAt };
      log('armed', { wakeId, dueAt, goal: state.goal });
      save();
    },
    /** Status chip: «🚗 AUTO · <goal> · next ⏰hh:mm» · «🚗 PAUSED · 사람 운전» · «🚗 STOPPED · <reason>»; '' when off. */
    statusText(): string {
      if (!state.on) return '';
      if (state.stopped) return `🚗 STOPPED · ${short(state.stopped.reason, 32)}`;
      if (state.paused) return '🚗 PAUSED · 사람 운전';
      const near = nearestGoalChip(goals(), now());
      const goal = `${state.goal ? ` · ${short(state.goal)}` : ''}${near ? ` · ${near}` : ''}`;
      const next = state.nextWakeAt !== undefined && state.nextWakeAt > now() ? ` · next ⏰${clock(state.nextWakeAt)}` : '';
      return `🚗 AUTO${goal}${state.backoff ? ' · 감속' : ''}${next}`;
    },
  };
  return api;
}

export type SessionAutopilot = ReturnType<typeof createAutopilot>;

/** Production decision card — a runaway back-off that persisted 2 h (decisions raise · direction belongs to the person). */
export function raiseAutopilotDecision(card: AutopilotDecisionCard): string | undefined {
  const { DecisionLedger } = require('../decisions/decision-ledger.js') as typeof import('../decisions/decision-ledger.js');
  const entry = new DecisionLedger().raise({
    title: card.title,
    category: 'scope',
    scqa: { s: `자율주행이 2시간째 감속(30분 깨움) 중이다${card.goal ? ` (목표 ${short(card.goal, 60)})` : ''}.`, c: short(card.reason, 200) },
    options: [
      { key: 'a', label: '그대로 둔다', consequence: '30분 깨움으로 계속 시도한다' },
      { key: 'b', label: '자율주행 끈다', consequence: '사람이 직접 운전한다(/autopilot off)' },
    ],
    recommendation: { option: 'a', why: '감속은 멈춤이 아니다 — 원인만 보고 필요하면 끈다' },
    raisedBy: { agent: 'autopilot', ...(card.sessionId ? { session: card.sessionId } : {}) },
  });
  return entry.id;
}

/** Production progress card for a near-due goal (decisions raise · category other). */
export function raiseGoalProgressCard(goal: AutopilotGoal, due: string, sessionId?: string): string {
  const { DecisionLedger } = require('../decisions/decision-ledger.js') as typeof import('../decisions/decision-ledger.js');
  return new DecisionLedger().raise({
    title: `목표 진행 · ${short(goal.title, 50)} · ${due}`,
    category: 'other',
    scqa: { s: `[${goal.level}] ${short(goal.title, 80)} 기한이 다가온다 (${due}).`, c: short(`진행·막힘·ETA 는 자율주행이 이 목표 관련 일을 먼저 하며 다음 턴에 적는다${goal.measure ? ` · 측정 ${goal.measure}` : ''}.`, 200) },
    options: [
      { key: 'a', label: '이대로 진행', consequence: '자율주행이 관련 일을 우선한다' },
      { key: 'b', label: '기한·범위 조정', consequence: '사람이 목표를 고친다(autopilot_goal_set)' },
    ],
    recommendation: { option: 'a', why: '기한 임박 목표는 관련 일을 먼저 한다' },
    raisedBy: { agent: 'autopilot', ...(sessionId ? { session: sessionId } : {}) },
  }).id;
}

/** Production proposal card — autopilot never creates a goal; it proposes one to the person. */
export function raiseGoalProposalCard(input: { title?: string; level?: string; due?: string }, sessionId?: string): string {
  const { DecisionLedger } = require('../decisions/decision-ledger.js') as typeof import('../decisions/decision-ledger.js');
  return new DecisionLedger().raise({
    title: `목표 제안 · ${short(input.title ?? '(제목 없음)', 50)}`,
    category: 'scope',
    scqa: { s: '자율주행이 새 목표가 필요해 보인다고 판단했다.', c: short(`[${input.level ?? '?'}] ${input.title ?? ''}${input.due ? ` · 기한 ${input.due}` : ''}`, 200) },
    options: [
      { key: 'a', label: '목표로 채택', consequence: '사람이 autopilot_goal_set 으로 추가한다' },
      { key: 'b', label: '채택 안 함', consequence: '목표 스택은 그대로' },
    ],
    recommendation: { skipped: true, reason: '목표는 사람이 정한다' },
    raisedBy: { agent: 'autopilot', ...(sessionId ? { session: sessionId } : {}) },
  }).id;
}
