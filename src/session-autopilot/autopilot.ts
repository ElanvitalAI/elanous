// SESSION-AUTOPILOT (CEO 11-24 15:0x) — «자율주행(autopilot) 모드»: a common eln feature for any seat / any user session.
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
//                 decision card only if the back-off persists 2 h. Volume alone never stops it (CEO 11-24 15:5x:
//                 the hourly turn cap counted every mail turn and stopped OP in 10 min — removed; a stored
//                 «시간당 자율 턴 상한» stop is cleared on load, logged once). Cost guard: no per-seat token budget
//                 exists in config yet → skipped.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { CLOSED_FIRST_CLASS_KEEP, GOAL_FEED_MARK, deriveEffectiveGoal, firstClassText as firstClassGoalText, firstClassFromMail, GOAL_TASK_REF, goalFeedBlock, sanitizeGoalText, sameDerived, type DerivedGoal, type FirstClassGoal, type GoalMailSignal } from './dynamic-goal.js';
import { goalApplyFromMail, goalAppliedLine, goalSetterVerdict, type GoalLadder } from './crown-goal-apply.js';
import { addPin, expirePins, pinPriority, pinToClose, taskPinEntries, taskPinFeed, taskPinRows, type PinEntry, type ExpiredPin, type PinPriority, type TaskPin } from './task-pins.js';
import { BLOCKED_MS, GOAL_DEFAULT_DEADLINE_MS, GOAL_RATE_WINDOW_MS, GOAL_EXPIRE_GRACE_MS, GOAL_REJECT_TEXT, GOAL_REPLACE_REF, HISTORY_KEEP, HISTORY_ROW_SHOW_MS, LOOP_SIG_KEEP, NARROW_DEADLINE_MS, SLOW_CHECK_EVERY_MS,
  THRASH_REPLACEMENTS, THRASH_WINDOW_MS, FREEZE_MS, blockedDue, burnDue, checklistCheckTrue, clearedLine, crownPinBar, describeCheck, escapeLine, expiredLine, fileCheckTrue,
  goalBarReason, goalDoneRefs, historyLine, lossLine, loopSig, mailCheckTrue, matchGoalRef, parseDoneCheck, pastDueLine, stallDue, supersededLine,
  type DoneCheck, type EscapeKind, type GoalArchive, type GoalKind, type GoalLife, type GoalOutcome } from './goal-clearing.js';
import { releaseGoalNote, STANDING_TARGETS } from '../ops-dashboard/release-targets.js';
import { DRIVE_BLOCK_AFTER_UNCHANGED, DRIVE_CONTINUE_PROMPT, DRIVE_HAND_PULL_PROMPT, decideGoalDrive, driveWindow, isTaskGoal, type HandPullInput } from './goal-drive.js';
import { observeChecklistHighWater, type ChecklistCountObservation } from './goal-progress.js';
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
  standing?: StandingGoal;
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
  /** OP-GOAL-EXPLICIT-ONLY — the running person turn's own words (last {@link TURN_TEXT_KEEP} chars) · absent in an auto turn. */
  turnText?: string;
  /** AUTOPILOT-DYNAMIC-GOAL-FEED — open first-class goals (crown · human directive · war); the latest overrides standing. */
  firstClass?: FirstClassGoal[];
  /** Closed first-class ids (a re-delivered crown mail never re-opens its goal) — last CLOSED_FIRST_CLASS_KEEP. */
  closedFirstClass?: string[];
  /** The effective goal last applied (`goal` mirrors its text) — change detection for `goal-derived`. */
  derived?: DerivedGoal;
  /** AUTOPILOT-HUMAN-GOAL — the first-class goal id that already got its «초안부터» nudge (once per goal). */
  awaitNudged?: string;
  /** AUTOPILOT-RELEASE-GOAL — the release resolver's version last seen on a tick (a change = a release was published). */
  releaseSeen?: string;
  /** AUTOPILOT-TASK-GOAL-PIN — task goals (pins above the input · never the chip) · at most PIN_MAX. */
  pins?: TaskPin[];
  /** The one «expired» line (a pin past deadline + 30 min). */
  pinExpired?: ExpiredPin;
  /** AUTOPILOT-GOAL-CLEARING — lifecycle of every open first-class goal and pin (deadline · done check · escapes). */
  life?: GoalLife[];
  /** Closed goals (done · superseded · expired · …) — last HISTORY_KEEP; the «🎯 history» line shows the last 3. */
  history?: GoalArchive[];
  /** Rate-limit windows: model-set autopilot goal openings · pin changes · first-class replacements (thrash). */
  goalOpens?: number[];
  pinChanges?: number[];
  replacements?: number[];
  /** Thrash escape: goal changes become pins until then. */
  freezeUntil?: number;
  /** AUTOPILOT-GOAL-DRIVE — immediate continuations of the open goal (`key` = goal id · `at` = epoch ms, last 30 min). */
  drive?: { key: string; at: number[]; toolSig?: string;
    /** GOAL-DRIVE-NARROW — the ledger fingerprint when the last continuation was issued · drive turns in a row with no change. */
    ledgerFp?: string; unchanged?: number };
  /** GOAL-DRIVEN-LOOP — per-goal checklist high-water (key = goal life id): the last count observed toward the goal's OWN count check. */
  driveProgress?: Record<string, ChecklistCountObservation>;
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
/** `note` / `done` are set when a published release moved the goal (AUTOPILOT-RELEASE-GOAL). */
export interface StandingGoal { version: string; phase: AutopilotPhase; note?: string; done?: string }
/** AUTOPILOT-RELEASE-GOAL (owner 11-25 07:1x «버전 발행 후 자동으로 오토파일럿 살아 있으면 골 셋팅») — the next version's goal. */
// RELEASE-GOAL-FROM-LEDGER (L4): the note is built from targets — the plan's front-matter when it sets them, else the standing OPS targets.
export const RELEASE_GOAL_NOTE = releaseGoalNote(STANDING_TARGETS);
export const releaseGoalDone = (version: string): string => `${version} 로스터 초록 · 컷`;
export const releaseStanding = (s: StandingGoal): StandingGoal => ({ version: s.version, phase: s.phase, note: s.note ?? RELEASE_GOAL_NOTE, done: releaseGoalDone(s.version) });
const VERSION_IN_TEXT = /(?<![\d.])(\d+)\.(\d+)\.(\d+)(?![\d.])/gu;
/** The first version a goal text names that is older than `current` (a goal still aimed at a released version). */
export function staleVersionIn(text: string | undefined, current: string): string | null {
  const cur = SEMVER.exec(current);
  if (!text || !cur) return null;
  for (const m of text.matchAll(VERSION_IN_TEXT)) {
    const a = [Number(m[1]), Number(m[2]), Number(m[3])]; const b = [Number(cur[1]), Number(cur[2]), Number(cur[3])];
    const cmp = a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
    if (cmp < 0) return m[0];
  }
  return null;
}
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
export const nextPatch = (v: string): string => { const m = SEMVER.exec(v)!; return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`; };

/**
 * The version in play and its phase (CEO 11-24 15:5x: the first cut read «0.3.34 개발» after 0.3.34 shipped — this host's
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
  // RELEASE-GOAL-FROM-LEDGER (L4): a current plan that sets hourly targets names the chip's note (no hand-typed numbers).
  let note: string | undefined;
  try {
    const { standingNoteFromPlan } = require('../ops-dashboard/release-goal.js') as typeof import('../ops-dashboard/release-goal.js');
    note = standingNoteFromPlan(input.hqRoot, version);
  } catch { note = undefined; }
  return { version, phase: cut ? '컷·발행' : '개발', ...(note ? { note } : {}) };
}

export const standingGoalText = (s: StandingGoal): string => `${s.version} ${s.phase}${s.note && s.phase === '개발' ? ` — ${s.note}` : ''}`;

/** The decision-autonomy paragraph for the turn's volatile (non-cached) context while autopilot is ON. */
export function autopilotPolicyParagraph(state: AutopilotState | null, goals: readonly AutopilotGoal[] = [], now = Date.now()): string | null {
  if (!state?.on || state.stopped) return null;
  const goal = state.goal ? ` · 목표: ${state.goal}` : '';
  const lines = goalLines(goals, now);
  const stack = lines.length ? `\n사람이 정한 목표(가까운 기한 순):\n${lines.join('\n')}\n목표는 사람만 정한다 — 새 목표가 필요해 보이면 제안 카드(decisions raise)로만 올린다.` : '';
  if (state.paused) {
    return `## 🚗 자율주행 일시정지 (사람이 «내가 운전하겠다»고 명시함)${goal}\n사람이 직접 운전하겠다고 말했다 — 사람의 말을 따른다. 사람이 «다시 자율주행»이라고 하면 autopilot_set({on:true})를 부른다.${stack}`;
  }
  return `## 🚗 자율주행 켜짐${goal}\n`
    + '정책 안의 일은 이 턴에서 스스로 정하고 진행한다: 운영·재시도·재측정·배정·약속 마감·기존 게이트 안의 착지. '
    + '사람에게는 돈·보안 사고·되돌릴 수 없는 행동·방향 결정만 결정 카드(decisions raise)로 올린다. '
    + '스스로 정한 결정마다 autopilot_set({decided:{kind, criterion}}) 한 번으로 기록한다. '
    + '지금 할 수 있는 다음 단계가 남아 있으면 턴을 끝내지 말고 이 턴에서 이어서 한다 — 완료 기준에 닿거나 진짜 막힘(다른 자리·외부 결과 대기·사람 결정)일 때만 끝낸다. 끝낼 때만 무엇을 기다리는지·다음 점검 시각을 한 줄로 남긴다 — 깨움은 자율주행이 건다. '
    + '사람의 새 요청·다른 방향·긴급 지시도 그냥 입력이다 — 처리하되 자율주행은 켜진 채로 둔다. 작업 골(📌 핀 · 입력창 위 · 최대 3)은 사람이 «이걸 골로 잡아»처럼 골 설정을 명시할 때만 세운다 — autopilot_set({on:true, goal:"<한 줄>", explicit_ask:"<사람 말 그대로>", done_criterion:"<완료 판정 한 줄>", deadline:"HH:MM", expected_turns:N}). 질문·상태 확인·요청·기한 있는 부탁·우편 답장·후속 확인은 골이 아니다 — 이번 턴에 답하거나 처리한다(추론으로 골을 만들지 않는다). 자율주행 골(🚗 칩)은 바꾸지 않는다(kind:"autopilot" 은 판 골·대표 P0 지시만). 작업 골이 끝나면 autopilot_set({goal_done:true, kind:"task", goal:"<그 줄>"}). 백그라운드 에이전트를 띄웠으면 «아직 없음»으로 끝내지 말고 초안부터 낸다. '
    + '보통 우편·요청은 골이 아니다(약속 원장·체크리스트) — 골은 사람·대표 지시만 바꾼다. 1급 골(대표 지시)의 일이 끝나면 autopilot_set({goal_done:true})로 닫는다 — 상시 골이 돌아온다. 기한이 지나면 부분 결과로 닫기(outcome:"partial") · 기한 연장({on:true, deadline}) · 포기(outcome:"dropped", reason) 중 하나를 고른다. '
    + '멈추는 것은 사람이 «이제부터 내가 운전하겠다»(autopilot_set({on:true, hold:true})) 또는 «자율주행 멈춰»(autopilot_set({on:false}))라고 명시할 때뿐이다.' + stack;
}

// ── controller ────────────────────────────────────────────────────────────────────────────────────────────────────
export interface AutopilotSetRequest {
  on?: boolean;
  goal?: string;
  until?: string;
  /** with on:true — only an explicit «이제부터 내가 운전하겠다»: stay paused until resumed (no other input pauses). */
  hold?: boolean;
  /** an in-turn autonomous decision to record (no state change). */
  decided?: { kind: string; criterion: string };
  /** close the open first-class goal (its directive is done) — the standing goal returns. */
  goalDone?: boolean;
  /** with goal — the done criterion (one judgment line); required when the model sets a goal (source 'tool'). */
  doneCriterion?: string;
  /**
   * AUTOPILOT-TASK-GOAL-PIN — 'task' (default for a model-set goal) = a pin above the input, never the chip;
   * 'autopilot' (default for /autopilot on <goal>) = the chip goal — only for a standing / crown P0 direction.
   */
  kind?: 'autopilot' | 'task';
  /** with a task goal — «HH:MM» or ISO (required: a pin needs a deadline). */
  deadline?: string;
  /** with a task goal — P0 / P1 (default) / P2 (eviction order beyond PIN_MAX). */
  priority?: string | number;
  /** AUTOPILOT-GOAL-CLEARING — machine done check (`file:<path>` · `file-updated:<path>` · `pr:<n>` · `mail:<SEAT>` · checklist). */
  doneCheck?: unknown;
  /** The acceptance bar: the model's size estimate (≥ 3 turns or > 15 minutes). */
  expectedTurns?: number;
  expectedMinutes?: number;
  /** with goalDone — done (default) · partial (closed with a partial result) · dropped (with reason). */
  outcome?: 'done' | 'partial' | 'dropped';
  reason?: string;
  /**
   * OP-GOAL-EXPLICIT-ONLY (대표 11-26 04:5x) — the person's own words that ask to set this as a goal, quoted verbatim from
   * the running person turn. A model-set goal without it (or with a quote not found in that turn) is refused: a question
   * or a request is answered inside the turn, never pinned.
   */
  explicitAsk?: string;
}

/** OP-GOAL-EXPLICIT-ONLY — how much of the person turn is kept for the quote check. */
export const TURN_TEXT_KEEP = 4000;
/** OP-GOAL-EXPLICIT-ONLY — the shortest quote accepted (a one-letter quote proves nothing). */
export const EXPLICIT_ASK_MIN_CHARS = 4;
const quoteNorm = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
/**
 * OP-GOAL-EXPLICIT-ONLY — is this goal backed by the person's explicit ask? Structural check only: the turn is a person
 * turn and the quoted words are a verbatim substring of it. Whether the words ask for a goal is the model's judgment
 * (prompt + tool description); this refuses the inferred case (no quote / quote invented / not a person turn).
 */
export function explicitGoalAskReason(state: Pick<AutopilotState, 'turnOrigin' | 'turnText'>, quote: string | undefined): string | null {
  const q = quoteNorm(quote ?? '');
  if (!q) return 'no-explicit-ask';
  if (q.length < EXPLICIT_ASK_MIN_CHARS) return 'explicit-ask-too-short';
  if (state.turnOrigin !== 'human' || !state.turnText) return 'not-a-person-turn';
  return quoteNorm(state.turnText).includes(q) ? null : 'explicit-ask-not-in-turn';
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
  /** GOAL-SET-COORD-BY-OP — this session's seat (the receiver of goal mails) and the federation ladder (read lazily). */
  seat?: string | null;
  federationLadder?: () => GoalLadder | null;
  /** The standing goal source (coordinator release cycle) — production: resolveStandingGoal. */
  standingGoal?: () => StandingGoal | null;
  sessionId?: string;
  notify?: (line: string) => void;
  /** The one near-due progress card per goal (goal · progress · blocking · ETA go in the card). */
  postProgress?: (goal: AutopilotGoal, timeToDue: string) => void;
  /** AUTOPILOT-GOAL-CLEARING — where relative `file:` done checks resolve (default: process cwd). */
  checkRoot?: string;
  /** The seat's loss ledger (configured = the file exists) — expired goals and escapes append one line; absent → log only. */
  lossLedger?: (line: string) => void;
  /** Slow checks (pr-merged · checklist) — async, throttled to one per SLOW_CHECK_EVERY_MS per goal. */
  slowCheck?: (check: DoneCheck) => Promise<boolean>;
  /** Where the hand-off escape writes its note (default `<state dir>/handoffs`). */
  handoffDir?: string;
  /** HAND-PULL-FIRST — hand seats only: the hand's cell state ⊕ whether `eln work next` exists (undefined = not a hand). */
  handPull?: () => HandPullInput | undefined;
  /** GOAL-DRIVE-NARROW — a cheap fingerprint of this seat's ledger (cells · PR/receipt/result mail · ✋ outcomes); absent = no check. */
  ledgerFingerprint?: () => string | undefined;
  /** GOAL-DRIVEN-LOOP — one release-checklist read: how many cells of `version` currently hold `status` (undefined = unknown → fail closed). */
  checklistCount?: (version: string, status: string) => number | undefined;
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
  /** Background agents (capsules) still running for this session at turn end. */
  backgroundRunning?: number;
  /** The turn made a succeeded state-changing call (goal-continue turnMadeProgress). */
  stateChanged?: boolean;
  /** AUTOPILOT-GOAL-CLEARING — the turn's tokens (input + output) · tool signatures (name + args) · replies awaited. */
  tokens?: number;
  toolSigs?: readonly string[];
  waitingOn?: number;
  /** AUTOPILOT-GOAL-DRIVE — a person's queued line (typed · not a notice) waits at this turn end. */
  personQueued?: number;
  /** AUTOPILOT-GOAL-DRIVE — a needs-human block (approval · HITL) is open. */
  needsHuman?: boolean;
  /** AUTOPILOT-GOAL-DRIVE — the delay of the earliest ScheduleWakeup the model set in this turn (structured tool row). */
  modelWakeInMs?: number;
}

/** One background capsule finished (turn-capsule CapsuleDoneEvent fields read here). */
export interface AutopilotBackgroundDone { capsuleId: string; kind: string; status: string; summary: string }

export type AutopilotTurnEndResult = {
  arm: { delayMs: number; reason: string } | null;
  backoff?: string;
  /** AUTOPILOT-HUMAN-GOAL — one «초안부터 내고 결과 오면 갱신» nudge to queue (once per first-class goal). */
  nudge?: string;
  /** AUTOPILOT-GOAL-DRIVE — continue the open goal NOW in this session with this prompt (bounded · see goal-drive.ts). */
  drive?: string;
};

/** The nudge text when a turn ends with only «not yet» while background agents still run for the open goal. */
export const awaitAgentsNudge = (goal: string | undefined, running: number): string =>
  `${goal ? `🎯 지금 골: ${goal} — ` : ''}백그라운드 에이전트 ${running}개가 아직 돈다. «아직 없음»으로 끝내지 말고 초안부터 내고 결과 오면 갱신한다.`
  + (goal ? '' : ' 사람이 골 설정을 명시하면(explicit_ask 에 그 말 인용) autopilot_set({on:true, goal, explicit_ask, done_criterion, deadline})로 작업 골(핀)을 세운다 — 질문·요청은 골이 아니다.');
/** The re-feed text when a background agent finishes while a first-class goal is open. */
export const agentDoneRefeed = (goal: string, done: AutopilotBackgroundDone): string =>
  `🎯 지금 골: ${goal} — 백그라운드 에이전트 «${short(done.summary, 60)}» 끝남(${done.status}) · capsule:${done.capsuleId}. 결과를 합쳐 완료 기준까지 이어서 간다.`;

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
  let keystrokeLoggedAt: number | null = null;
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
    applyDerived('refresh');
    expireDue();
    return state;
  };
  const standingNow = (): StandingGoal | null => { try { return deps.standingGoal?.() ?? null; } catch { return null; } };
  /**
   * AUTOPILOT-RELEASE-GOAL — read on every refresh/tick from the cached release resolver (no new polling). A seat in
   * AUTO whose version moved (a release was published) — or whose goal still names an older version — gets the next
   * version's goal «<v> 개발 — 로스터 착지 · 초록 +10/h» (done = <v> 로스터 초록 · 컷), logged as
   * `goal-derived {source:'release', from, to}`. AUTO off → nothing changes (not even the seen version).
   */
  const rollStanding = (): void => {
    if (!state.on || !deps.standingGoal) return;
    const derived = standingNow();
    if (!derived) return;
    const seen = state.releaseSeen;
    const seenChanged = seen !== derived.version;
    if (seenChanged) state = { ...state, releaseSeen: derived.version };
    const cur = state.standing;
    if (cur) {
      const noteMoved = derived.note !== undefined && derived.note !== cur.note;
      if (derived.version === cur.version && derived.phase === cur.phase && !noteMoved) { if (seenChanged) save(); return; }
      const rolled = derived.version !== cur.version;
      const next = rolled ? releaseStanding(derived) : { ...cur, phase: derived.phase, ...(derived.note !== undefined ? { note: derived.note } : {}) };
      const from = standingGoalText(cur); const to = standingGoalText(next);
      state = { ...state, standing: next };
      log(rolled ? 'goal-rolled' : 'goal-phase', { from, to });
      deps.notify?.(`🚗 목표 ${from} → ${to}`);
      if (!applyDerived(rolled ? 'standing-rolled' : 'standing-phase', rolled ? { source: 'release', from: cur.version, to: next.version } : undefined)) save();
      return;
    }
    // A seat without a standing goal: a release moved the version under it, or its goal still names an older version.
    const stale = staleVersionIn(state.goal, derived.version);
    const released = seen !== undefined && seenChanged;
    if (!stale && !released) { if (seenChanged) save(); return; }
    state = { ...state, standing: releaseStanding(derived) };
    log('release-goal-set', { from: stale ?? seen, to: derived.version, under: state.derived?.tier ?? 'none' });
    if (!applyDerived('release', { source: 'release', from: stale ?? seen, to: derived.version })) save();
  };
  /** Goal-tier fields every state rebuild carries over (on/off/until never drop an open directive). */
  const goalTier = (): Pick<AutopilotState, 'firstClass' | 'closedFirstClass' | 'derived' | 'awaitNudged' | 'releaseSeen' | 'pins' | 'pinExpired'
    | 'life' | 'history' | 'goalOpens' | 'pinChanges' | 'replacements' | 'freezeUntil'> => ({
    ...(state.life?.length ? { life: state.life } : {}),
    ...(state.history?.length ? { history: state.history } : {}),
    ...(state.goalOpens?.length ? { goalOpens: state.goalOpens } : {}),
    ...(state.pinChanges?.length ? { pinChanges: state.pinChanges } : {}),
    ...(state.replacements?.length ? { replacements: state.replacements } : {}),
    ...(state.freezeUntil !== undefined ? { freezeUntil: state.freezeUntil } : {}),
    ...(state.releaseSeen ? { releaseSeen: state.releaseSeen } : {}),
    ...(state.pins?.length ? { pins: state.pins } : {}),
    ...(state.pinExpired ? { pinExpired: state.pinExpired } : {}),
    ...(state.firstClass?.length ? { firstClass: state.firstClass } : {}),
    ...(state.awaitNudged ? { awaitNudged: state.awaitNudged } : {}),
    ...(state.closedFirstClass?.length ? { closedFirstClass: state.closedFirstClass } : {}),
    ...(state.derived ? { derived: state.derived } : {}),
  });
  /**
   * AUTOPILOT-DYNAMIC-GOAL-FEED — effective goal = open first-class > standing. Applied (goal · derived · one
   * `goal-derived` log · save · notify) only when it changed, autopilot is ON and no explicit hold is in force.
   */
  const applyDerived = (reason: string, logOver?: Record<string, unknown>): boolean => {
    if (!state.on || state.stopped || state.paused?.hold) return false;
    const d = deriveEffectiveGoal(state.firstClass, state.standing ? standingGoalText(state.standing) : undefined, state.standing?.done);
    if (sameDerived(d, state.derived)) return false;
    if (!d) {
      if (state.derived?.tier !== 'first-class') return false;
      // The last first-class closed and the seat has no standing goal: the closed directive is no longer the goal.
      const { derived: _d, goal: _g, ...rest } = state; state = rest;
      log('goal-derived', { tier: 'none', source: 'none', goal: '', reason });
      save();
      return true;
    }
    const from = state.goal;
    state = { ...state, derived: d, goal: d.goal };
    log('goal-derived', { tier: d.tier, source: d.source, goal: d.goal, reason, ...(logOver ?? {}) });
    if (from !== undefined && from !== d.goal) deps.notify?.(`🎯 골 ${from} → ${d.goal}`);
    save();
    return true;
  };
  // ── AUTOPILOT-GOAL-CLEARING — lifecycle helpers ──────────────────────────────────────────────────────────────────
  /** Lines for the model's next turn (due nudges · escapes) — the TUI drains them after each tick / mail / turn end. */
  const nudges: string[] = [];
  const slowChecked = new Map<string, number>();
  const slowHits = new Set<string>();
  const lives = (): GoalLife[] => state.life ?? [];
  const lifeOf = (id: string): GoalLife | undefined => lives().find((l) => l.id === id);
  const putLife = (life: GoalLife): void => { state = { ...state, life: [...lives().filter((l) => l.id !== life.id), life] }; };
  const dropLife = (id: string): void => {
    const left = lives().filter((l) => l.id !== id);
    const { life: _l, ...rest } = state; state = { ...rest, ...(left.length ? { life: left } : {}) };
  };
  const newLife = (id: string, kind: GoalKind, text: string, at: number, deadline: number, extra: Partial<GoalLife> = {}): GoalLife =>
    ({ id, kind, text, at, deadline, turns: 0, idleTurns: 0, tokens: 0, lastProgressAt: at, ...extra });
  /** The goal turns are charged to: the open first-class goal, else the pin due first (parked pins never). */
  const activeLife = (): GoalLife | undefined => {
    const fc = state.firstClass?.at(-1);
    const top = fc ? lifeOf(fc.id) : undefined;
    if (top) return top;
    const pinIds = new Set((state.pins ?? []).map((p) => p.id));
    return lives().filter((l) => pinIds.has(l.id) && !l.parked).sort((a, b) => a.deadline - b.deadline)[0];
  };
  const loss = (what: string, life: GoalLife, reason: string): void => {
    const line = lossLine(now(), what, life, reason);
    if (deps.lossLedger) { try { deps.lossLedger(line); return; } catch (error) { log('loss-ledger-failed', { error: String(error) }); } }
    log('goal-loss', { what, id: life.id, goal: life.text, tokens: life.tokens, turns: life.turns, reason });
  };
  const archive = (id: string, kind: GoalKind, text: string, outcome: GoalOutcome, by: string, reason?: string, keepLife = false): void => {
    const life = lifeOf(id);
    const entry: GoalArchive = { id, kind, text, outcome, by, at: now(), ...(reason ? { reason } : {}), ...(keepLife && life ? { life } : {}) };
    state = { ...state, history: [...(state.history ?? []), entry].slice(-HISTORY_KEEP) };
    dropLife(id);
  };
  const say = (line: string, toModel = true): void => { deps.notify?.(line); if (toModel) nudges.push(line); };
  const escape = (kind: EscapeKind, life: GoalLife, line: string, extra: Record<string, unknown> = {}): void => {
    const cur = lifeOf(life.id);
    if (cur) putLife({ ...cur, escapes: { ...(cur.escapes ?? {}), [kind]: now() } });
    log('goal-escape', { kind, goal: life.text, id: life.id, tokens: life.tokens, turns: life.turns, ...extra });
    loss(`escape:${kind}`, life, line);
    say(line);
  };

  const openFirstClass = (goal: FirstClassGoal, reason: string, life?: Partial<GoalLife>): boolean => {
    if (state.firstClass?.some((g) => g.id === goal.id) || state.closedFirstClass?.includes(goal.id)) return false;
    if (state.pins?.some((p) => p.id === goal.id)) return false;
    state = { ...state, firstClass: [...(state.firstClass ?? []), goal] };
    if (goal.source !== 'war') putLife(newLife(goal.id, 'autopilot', firstClassGoalText(goal), goal.at, life?.deadline ?? goal.at + GOAL_DEFAULT_DEADLINE_MS, { ...(goal.done ? { done: goal.done } : {}), ...life }));
    if (state.paused?.hold) log('goal-derived-held', { tier: 'first-class', source: goal.source === 'crown' ? goal.id : goal.source, goal: goal.text, reason });
    if (!applyDerived(reason)) save();
    return true;
  };
  const closeFirstClass = (id: string | undefined, reason: string): FirstClassGoal | null => {
    const open = state.firstClass ?? [];
    const target = id === undefined ? open.at(-1) : open.find((g) => g.id === id);
    if (!target) return null;
    const left = open.filter((g) => g.id !== target.id);
    const { firstClass: _fc, ...rest } = state;
    state = { ...rest, ...(left.length ? { firstClass: left } : {}),
      closedFirstClass: [...(state.closedFirstClass ?? []).filter((c) => c !== target.id), target.id].slice(-CLOSED_FIRST_CLASS_KEEP) };
    dropLife(target.id);
    log('first-class-closed', { id: target.id, goal: target.text, reason });
    if (!applyDerived(reason)) save();
    return target;
  };
  /** Add a pin (with its lifecycle record) — used by the tool, crown→pin and the thrash / parallel escapes. */
  const pinGoal = (pin: TaskPin, life?: Partial<GoalLife>): void => {
    const change = addPin(state.pins ?? [], pin);
    state = { ...state, pins: change.pins };
    if (change.replaced) { log('pin-replaced', { id: change.replaced.id, text: pin.text }); dropLife(change.replaced.id); }
    if (change.evicted) {
      log('pin-evicted', { id: change.evicted.id, text: change.evicted.text, priority: change.evicted.priority, by: pin.text });
      archive(change.evicted.id, 'task', change.evicted.text, 'superseded', 'pin-limit');
      deps.notify?.(`📌 Pin replaced (limit 3): ${change.evicted.text}`);
    }
    const { id: _i, kind: _k, text: _t, at: _a, ...carried } = life ?? {};
    putLife(newLife(pin.id, 'task', pin.text, pin.at, pin.deadline, { done: pin.done, ...carried }));
    log('pin-set', { id: pin.id, text: pin.text, done: pin.done, deadline: pin.deadline, priority: pin.priority, count: change.pins.length });
    lastPinChange = change;
  };
  let lastPinChange: ReturnType<typeof addPin> | null = null;
  /**
   * A newer person's direction supersedes the older one — archived as «superseded» (never silently overwritten) with a
   * notice. Thrash escape: the 2nd replacement within 30 min freezes goal changes — the oldest unfinished goal stays
   * the autopilot goal, the others become pins.
   */
  const openHumanGoal = (goal: FirstClassGoal, reason: string, life?: Partial<GoalLife>): boolean => {
    const t = now();
    const open = (state.firstClass ?? []).filter((g) => g.source === 'human' || reason === 'crown-replace');
    const asPin = (g: { id: string; text: string; at: number }, l?: Partial<GoalLife>): void => {
      const deadline = l?.deadline ?? t + GOAL_DEFAULT_DEADLINE_MS;
      pinGoal({ id: g.id.startsWith('pin:') ? g.id : `pin:${g.id}`, text: g.text, done: l?.done ?? '(see goal)', deadline, priority: 1, at: g.at }, { ...l, deadline });
    };
    if (state.freezeUntil !== undefined && t < state.freezeUntil) {
      log('goal-rejected', { reason: 'frozen', goal: goal.text, until: state.freezeUntil });
      asPin({ id: goal.id, text: firstClassGoalText(goal), at: goal.at }, { ...life, ...(goal.done ? { done: goal.done } : {}) });
      // The chip keeps the frozen goal (set() already wrote the asked text into `goal`).
      if (state.derived) state = { ...state, goal: state.derived.goal };
      save();
      return false;
    }
    if (open.length) {
      const recent = (state.replacements ?? []).filter((at) => t - at < THRASH_WINDOW_MS);
      if (recent.length + 1 >= THRASH_REPLACEMENTS) {
        // Thrash: keep the oldest unfinished goal (the earliest one superseded in the window, else the open one).
        const oldest = (state.history ?? []).find((h) => h.outcome === 'superseded' && h.kind === 'autopilot' && t - h.at < THRASH_WINDOW_MS && h.life);
        const others: Array<{ id: string; text: string; at: number; life?: Partial<GoalLife> }> = [
          ...open.map((g) => ({ id: g.id, text: firstClassGoalText(g), at: g.at, life: lifeOf(g.id) ?? {} })),
          { id: goal.id, text: firstClassGoalText(goal), at: goal.at, life: { ...life, ...(goal.done ? { done: goal.done } : {}) } },
        ];
        if (oldest?.life) {
          for (const g of open) { dropLife(g.id); }
          state = { ...state, firstClass: [...(state.firstClass ?? []).filter((g) => !open.includes(g)),
            { id: oldest.id, source: 'human', text: oldest.text, at: oldest.life.at, ...(oldest.life.done ? { done: oldest.life.done } : {}) }],
            closedFirstClass: (state.closedFirstClass ?? []).filter((c) => c !== oldest.id),
            history: (state.history ?? []).filter((h) => h !== oldest) };
          putLife(oldest.life);
          for (const o of others) asPin(o, o.life);
        } else {
          for (const o of others.slice(-1)) asPin(o, o.life);
        }
        state = { ...state, freezeUntil: t + FREEZE_MS, replacements: [] };
        const kept = oldest?.life ?? lifeOf(open[0]!.id) ?? newLife(goal.id, 'autopilot', goal.text, t, t + GOAL_DEFAULT_DEADLINE_MS);
        escape('freeze', kept, escapeLine('freeze', kept.text, { deadline: t + FREEZE_MS }));
        if (!applyDerived('thrash-freeze')) save();
        return true;
      }
      for (const g of open) {
        archive(g.id, 'autopilot', firstClassGoalText(g), 'superseded', reason, undefined, true);
        say(supersededLine(firstClassGoalText(g), firstClassGoalText(goal)), false);
        log('goal-superseded', { id: g.id, goal: firstClassGoalText(g), by: firstClassGoalText(goal) });
      }
      state = { ...state, replacements: [...recent, t], firstClass: (state.firstClass ?? []).filter((g) => !open.includes(g)),
        closedFirstClass: [...(state.closedFirstClass ?? []), ...open.map((g) => g.id)].slice(-CLOSED_FIRST_CLASS_KEEP) };
      if (!(state.firstClass?.length)) { const { firstClass: _e, ...rest } = state; state = rest; }
    }
    return openFirstClass(goal, reason, life);
  };
  /**
   * CROWN-GOAL-APPLY — a goal mail (structured `goal` field) replaces the autopilot goal with no model in the loop:
   * every open non-war first-class goal is superseded, the thrash freeze does not apply (an explicit setter is not
   * thrash), `goal-applied {source, msgId}` is logged and one line goes to the transcript (and the model's next turn).
   * Returns true when the effective goal changed (or was recorded for when autopilot is on).
   */
  const applyMailGoal = (m: GoalMailSignal): boolean => {
    const t = now();
    const decision = goalApplyFromMail({ goal: m.goal ?? null, crownDirective: m.crownDirective ?? null, ...(m.expiresAt ? { expiresAt: m.expiresAt } : {}),
      ...(m.sender ? { sender: m.sender } : {}), ...(typeof m.msgId === 'number' ? { msgId: m.msgId } : {}) }, t,
    { seat: deps.seat ?? null, ...(deps.federationLadder ? { ladder: deps.federationLadder } : {}) });
    if (decision.kind === 'none') return false;
    if (decision.kind === 'expired') {
      log('goal-apply-refused', { reason: 'expired', sender: decision.sender, msgId: m.msgId ?? null, goal: decision.goal, expiresAt: decision.expiresAt });
      return false;
    }
    if (decision.kind === 'refused') {
      log('goal-apply-refused', { reason: decision.reason, sender: decision.sender, msgId: m.msgId ?? null, goal: decision.goal });
      log('goal-applied', { source: `mail:${decision.sender || 'unknown'}`, by: decision.sender, msgId: m.msgId ?? null, goal: decision.goal, applied: false, reason: decision.reason, detail: decision.detail });
      return false;
    }
    // Re-delivery: the same mail never re-opens its goal.
    if (state.firstClass?.some((g) => g.id === decision.id) || state.closedFirstClass?.includes(decision.id)) return false;
    if ((m.refs ?? []).includes(GOAL_TASK_REF)) {
      const deadline = m.deadlineAt ? Date.parse(m.deadlineAt) : NaN;
      const done = m.doneWhen?.trim();
      if (!done || !Number.isFinite(deadline) || deadline <= t) {
        log('goal-apply-refused', { reason: 'task-requires-done-and-future-deadline', msgId: m.msgId ?? null });
        return false;
      }
      pinGoal({ id: `pin:${decision.id}`, text: decision.goal, done, deadline, priority: 1, at: t, task: true });
      state = { ...state, closedFirstClass: [...(state.closedFirstClass ?? []), decision.id].slice(-CLOSED_FIRST_CLASS_KEEP) };
      log('goal-applied', { source: decision.source, by: decision.by, msgId: m.msgId ?? null, goal: decision.goal, applied: true, kind: 'task' });
      save();
      return true;
    }
    const mailExpiry = m.expiresAt ? Date.parse(m.expiresAt) : NaN;
    const goal: FirstClassGoal = { id: decision.id, source: decision.crown ? 'crown' : 'human', text: decision.goal, at: t,
      ...(m.doneWhen?.trim() ? { done: m.doneWhen.trim() } : {}), ...(Number.isFinite(mailExpiry) ? { expiresAt: mailExpiry } : {}),
      ...((m.refs ?? []).includes(GOAL_TASK_REF) ? { task: true } : {}) };
    const open = (state.firstClass ?? []).filter((g) => g.source !== 'war');
    for (const g of open) {
      archive(g.id, 'autopilot', firstClassGoalText(g), 'superseded', 'goal-applied', undefined, true);
      log('goal-superseded', { id: g.id, goal: firstClassGoalText(g), by: firstClassGoalText(goal) });
    }
    const keep = (state.firstClass ?? []).filter((g) => g.source === 'war');
    const { firstClass: _fc, freezeUntil: _fz, ...rest } = state;
    state = { ...rest, ...(keep.length ? { firstClass: keep } : {}),
      ...(open.length ? { closedFirstClass: [...(state.closedFirstClass ?? []), ...open.map((g) => g.id)].slice(-CLOSED_FIRST_CLASS_KEEP) } : {}) };
    // GOAL-SET-COORD-BY-OP — a seat whose autopilot was never switched (not role:coordinator → never default-ON) is
    // switched ON by a setter's goal; an explicit human off (by tool/slash) or a hold is kept and named as the reason.
    let blocked: string | null = null;
    if (state.paused?.hold) blocked = 'autopilot-held';
    else if (state.stopped) blocked = 'autopilot-stopped';
    else if (!state.on) {
      if (state.by === 'tool' || state.by === 'slash') blocked = 'autopilot-off';
      else {
        state = { ...state, on: true, since: t, by: 'goal-mail' };
        log('on', { reason: 'goal-mail', by: decision.by, msgId: m.msgId ?? null, goal: decision.goal });
      }
    }
    const deadline = m.deadlineAt ? Date.parse(m.deadlineAt) : NaN;
    openFirstClass(goal, 'goal-applied', { ...(Number.isFinite(deadline) ? { deadline } : {}), done: m.doneWhen?.trim() || 'goal carried out (goal_done)' });
    const shown = state.derived?.tier === 'first-class' && state.derived.source === (decision.crown ? goal.id : 'human') && state.derived.goal === firstClassGoalText(goal);
    log('goal-applied', { source: decision.source, by: decision.by, msgId: m.msgId ?? null, goal: decision.goal, applied: shown,
      ...(shown ? {} : { reason: blocked ?? 'not-effective' }) });
    say(goalAppliedLine({ goal: firstClassGoalText(goal), sender: (m.sender ?? '').toUpperCase(), ...(typeof m.msgId === 'number' ? { msgId: m.msgId } : {}), applied: shown }));
    save();
    return true;
  };
  /** AUTOPILOT-TASK-GOAL-PIN — overdue pins (deadline + 30 min) leave; the latest becomes the one expired line. */
  const expireDue = (): void => {
    if (!state.pins?.length) return;
    const t = now();
    const { pins, expired } = expirePins(state.pins, t);
    if (!expired.length) return;
    for (const p of expired) {
      log('pin-expired', { id: p.id, text: p.text, deadline: p.deadline });
      const life = lifeOf(p.id) ?? newLife(p.id, 'task', p.text, p.at, p.deadline);
      log('goal-expired', { id: p.id, goal: p.text, kind: 'task' });
      loss('expired', life, 'no action 30 min past due');
      archive(p.id, 'task', p.text, 'expired', 'deadline');
    }
    const last = expired.at(-1)!;
    const { pins: _p, ...rest } = state;
    state = { ...rest, ...(pins.length ? { pins } : {}), pinExpired: { text: last.text, deadline: last.deadline, at: t } };
    save();
  };
  const unpin = (pin: TaskPin, reason: string): void => {
    const left = (state.pins ?? []).filter((p) => p.id !== pin.id);
    const { pins: _p, ...rest } = state;
    state = { ...rest, ...(left.length ? { pins: left } : {}) };
    if (pin.id.startsWith('crown:')) state = { ...state, closedFirstClass: [...(state.closedFirstClass ?? []), pin.id].slice(-CLOSED_FIRST_CLASS_KEEP) };
    dropLife(pin.id);
    log('pin-done', { id: pin.id, text: pin.text, reason });
    save();
  };
  /** Clear one goal (first-class or pin) — archived with its outcome; one log + one notice. */
  const clearGoal = (id: string, by: string, outcome: GoalOutcome = 'done', reason?: string): boolean => {
    const life = lifeOf(id);
    const pin = state.pins?.find((p) => p.id === id);
    const fc = state.firstClass?.find((g) => g.id === id);
    if (!pin && !fc) { if (life) { dropLife(id); save(); } return false; }
    const text = pin?.text ?? firstClassGoalText(fc!);
    const kind: GoalKind = pin ? 'task' : 'autopilot';
    if (outcome === 'dropped' && life) loss('dropped', life, reason ?? 'dropped');
    archive(id, kind, text, outcome, by, reason);
    if (pin) unpin(pin, `goal-cleared:${by}`); else closeFirstClass(id, `goal-cleared:${by}`);
    log('goal-cleared', { by, goal: text, id, outcome, ...(reason ? { reason } : {}) });
    if (outcome === 'done') say(clearedLine(text, by), by !== 'tool');
    else deps.notify?.(`✓ goal closed (${outcome}): ${text}`);
    save();
    return true;
  };
  /** Each tick: done checks → due nudge → expiry (first-class; pins via expireDue) → time-based escapes. */
  const clearPass = (): void => {
    const t = now();
    for (const life of [...lives()]) {
      if (!lifeOf(life.id)) continue;
      const c = life.check;
      let hit = slowHits.has(life.id);
      if (!hit && c?.kind === 'file') hit = fileCheckTrue(c, life.at, deps.checkRoot ?? process.cwd());
      if (!hit && c && (c.kind === 'pr-merged' || c.kind === 'checklist') && deps.slowCheck && t - (slowChecked.get(life.id) ?? 0) >= SLOW_CHECK_EVERY_MS) {
        slowChecked.set(life.id, t);
        const id = life.id;
        deps.slowCheck(c).then((ok) => { if (ok) { slowHits.add(id); log('check-hit', { id, check: describeCheck(c) }); } })
          .catch((error) => log('check-failed', { id, check: describeCheck(c), error: String(error).slice(0, 200) }));
      }
      if (hit) { slowHits.delete(life.id); clearGoal(life.id, 'check'); continue; }
      const fc = state.firstClass?.find((g) => g.id === life.id);
      // DIRECTIVE-EXPIRY (Q5) — the carrying mail lapsed: the goal leaves the next turn's injection (dropped · expired).
      if (fc?.expiresAt !== undefined && t >= fc.expiresAt) { clearGoal(life.id, 'expiry', 'dropped', 'directive expired'); continue; }
      if (t >= life.deadline + GOAL_EXPIRE_GRACE_MS && fc) {
        log('goal-expired', { id: life.id, goal: life.text, kind: life.kind });
        loss('expired', life, 'no action 30 min past due');
        archive(life.id, 'autopilot', life.text, 'expired', 'deadline');
        closeFirstClass(life.id, 'expired');
        say(expiredLine(life.text), false);
        continue;
      }
      if (t >= life.deadline && life.nudgedAt === undefined) {
        putLife({ ...life, nudgedAt: t });
        log('goal-nudge-due', { id: life.id, goal: life.text, deadline: life.deadline });
        say(pastDueLine(life.text));
        save();
        continue;
      }
      if (blockedDue(life, t)) { park(life); continue; }
      if (stallDue(life, t)) narrow(life);
    }
  };
  /** Stall escape: the goal gets a 30-min deadline and the model is told to shrink it to the next smallest deliverable. */
  const narrow = (life: GoalLife): void => {
    const deadline = now() + NARROW_DEADLINE_MS;
    putLife({ ...life, deadline, idleTurns: 0, lastProgressAt: now() });
    const { nudgedAt: _n, ...cur } = lifeOf(life.id)!; putLife(cur);
    state = { ...state, ...(state.pins?.some((p) => p.id === life.id) ? { pins: state.pins!.map((p) => (p.id === life.id ? { ...p, deadline } : p)) } : {}) };
    escape('narrow', life, escapeLine('narrow', life.text, { deadline }));
    save();
  };
  /** Blocked escape: park the goal as a pin that wakes on the awaited reply; the seat pulls the next roster item. */
  const park = (life: GoalLife): void => {
    const fc = state.firstClass?.find((g) => g.id === life.id);
    if (fc) {
      const { firstClass: _f, ...rest } = state;
      const left = (state.firstClass ?? []).filter((g) => g.id !== fc.id);
      state = { ...rest, ...(left.length ? { firstClass: left } : {}) };
      const pin: TaskPin = { id: `pin:${fc.id}`, text: life.text, done: life.done ?? '(see goal)', deadline: life.deadline, priority: 1, at: life.at };
      const change = addPin(state.pins ?? [], pin);
      state = { ...state, pins: change.pins };
      dropLife(life.id);
      const parked: GoalLife = { ...life, id: pin.id, kind: 'task', parked: true };
      putLife(parked);
      applyDerived('parked');
      escape('parallel', parked, escapeLine('parallel', life.text, {}));
    } else {
      putLife({ ...life, parked: true });
      escape('parallel', life, escapeLine('parallel', life.text, {}));
    }
    save();
  };
  const writeHandoff = (life: GoalLife): string | undefined => {
    try {
      const dir = deps.handoffDir ?? join(dirname(deps.file), 'handoffs');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${life.id.replace(/[^A-Za-z0-9_-]+/gu, '_')}.md`);
      writeFileSync(path, [`# Hand-off · ${life.text}`, '', `- id: ${life.id}`, `- done when: ${life.done ?? '(none)'}`,
        `- deadline: ${new Date(life.deadline).toISOString()}`, `- spent: tokens=${life.tokens} turns=${life.turns}${life.estTurns ? ` (estimate ${life.estTurns} turns)` : ''}`,
        `- check: ${life.check ? describeCheck(life.check) : '(none)'}`, '', 'The goal burned its budget in this seat — continue it from here (space coordinator / hand) or decide on the card.', ''].join('\n'));
      return path;
    } catch (error) { log('handoff-write-failed', { error: String(error).slice(0, 200) }); return undefined; }
  };

  /** Background capsules already re-fed (a replayed capsule-done frame re-feeds nothing). */
  const refed = new Set<string>();
  /** The last submitted person's line (ms) — a human request turn with agents running gets one nudge even without a goal. */
  let humanTurnAt: number | null = null;
  const active = (): boolean => state.on && !state.stopped && !state.paused;
  const resume = (reason: string): void => {
    if (!state.on || !state.paused) return;
    // A resume is a fresh start for the runaway accounting too: no stop, no back-off, no streaks carried over.
    const { paused: _paused, stopped: _stopped, backoff: _backoff, failure: _failure, noProgress: _noProgress, ...rest } = state;
    state = rest;
    log('resume', { reason, goal: state.goal });
    if (!applyDerived('resume')) save();
  };

  const api = {
    refresh,
    state: (): AutopilotState => state,
    goals,
    goalsFile,
    paragraph: (): string | null => autopilotPolicyParagraph(state, goals(), now()),
    /** The TUI marks each turn's origin so the goal tools (REPL child) can refuse writes in autonomous turns. */
    noteTurnStart(origin: 'human' | 'auto', text?: string): void {
      const kept = origin === 'human' && text ? text.slice(-TURN_TEXT_KEEP) : undefined;
      if (state.turnOrigin === origin && state.turnText === kept) return;
      const { turnText: _old, ...rest } = state;
      state = { ...rest, turnOrigin: origin, ...(kept ? { turnText: kept } : {}) };
      save();
    },
    isActive: (): boolean => active(),
    /** The effective goal last applied (null before the first derivation). */
    derivedGoal: (): DerivedGoal | null => state.derived ?? null,
    /** The one fixed-id «🎯 지금 골» block for the head of the turn input (null while OFF). */
    goalFeed: (): string | null => {
      if (!state.on) return null;
      const pins = taskPinFeed(state.pins);
      const fc = state.derived?.tier === 'first-class' ? state.firstClass?.at(-1) : undefined;
      const life = fc ? lifeOf(fc.id) : undefined;
      // The deadline line only when it matters (≤ 30 min left or past due) — no standing token cost.
      const due = life && life.deadline - now() <= GOAL_EXPIRE_GRACE_MS ? `\n⏰ 기한 ${clock(life.deadline)} · id ${life.id}${life.check ? ` · 자동 완료 검사 ${describeCheck(life.check)}` : ''} — 지나면 부분 결과로 닫기(goal_done outcome:"partial") · 기한 연장(deadline) · 포기(outcome:"dropped" + reason)` : '';
      const lost = [...(state.history ?? [])].reverse().find((h) => h.outcome !== 'done');
      const hist = lost && now() - lost.at < HISTORY_ROW_SHOW_MS ? historyLine(state.history) : null;
      const tail = `${pins}${hist ? `\n${hist}` : ''}`;
      const block = goalFeedBlock(state.derived);
      return block ? `${block}${due}${tail}` : tail ? `${GOAL_FEED_MARK}${tail}` : null;
    },
    /** AUTOPILOT-TASK-GOAL-PIN — open task pins (never in the chip). */
    pins: (): TaskPin[] => state.pins ?? [],
    /** The rows the TUI draws just above the input («📌 i/n …» · one «⌛ Pin expired» line). */
    pinRows: (): string[] => api.pinEntries().map((e) => e.row),
    /** The same rows with their pin ids (the TUI hangs each pin's background agents under its row). */
    pinEntries: (): PinEntry[] => {
      const rows = taskPinEntries(state.pins, state.pinExpired, now());
      // AUTOPILOT-GOAL-CLEARING — «🎯 history» (last 3) shows for an hour after a goal was lost (superseded · expired · dropped).
      const lost = [...(state.history ?? [])].reverse().find((h) => h.outcome !== 'done');
      const line = lost && now() - lost.at < HISTORY_ROW_SHOW_MS ? historyLine(state.history) : null;
      return line ? [...rows, { row: line }] : rows;
    },
    /**
     * Seat mail arrived. Only a mail carrying a `crownDirective` id opens a first-class goal (once per directive id —
     * duplicates and re-deliveries change nothing); every other mail is tier 3 and never touches the goal.
     * Returns true when the effective goal changed.
     */
    observeMail(mails: readonly GoalMailSignal[] | undefined): boolean {
      if (!mails?.length) return false;
      const t = now();
      // CROWN-GOAL-APPLY — a structured `goal` field from OP / CLAUDE-OP (or a crown mail) sets the goal by itself.
      const goalApplied = new Set<GoalMailSignal>();
      let applied = false;
      // DIRECTIVE-EXPIRY (Q5) — a retraction (`supersedes`) closes the goal the retracted mail set (structured ids only).
      for (const m of mails) {
        if (typeof m.supersedes !== 'number') continue;
        refresh();
        const reason = `retracted by ${m.sender ?? 'mail'}${m.msgId ? ` msg:${m.msgId}` : ''}`;
        if (clearGoal(`goal:${m.supersedes}`, 'retracted', 'dropped', reason)) applied = true;
        // Task pins use a separate ID; only an authorized goal setter may retract one.
        const verdict = goalSetterVerdict({ sender: m.sender, seat: deps.seat, crownDirective: m.crownDirective, ladder: deps.federationLadder });
        if (verdict.ok) {
          if (clearGoal(`pin:goal:${m.supersedes}`, 'retracted', 'dropped', reason)) applied = true;
          // Remember even an early retraction so later delivery cannot resurrect the goal.
          const id = `goal:${m.supersedes}`;
          if (!state.closedFirstClass?.includes(id)) {
            state = { ...state, closedFirstClass: [...(state.closedFirstClass ?? []), id].slice(-CLOSED_FIRST_CLASS_KEEP) };
            save();
          }
        }
      }
      for (const m of mails) {
        if (typeof m.goal !== 'string' || !m.goal.trim()) continue;
        refresh();
        if (applyMailGoal(m)) applied = true;
        goalApplied.add(m);
      }
      // AUTOPILOT-GOAL-CLEARING — clearing signals first (only when a goal is open: a plain mail costs one state read).
      const signals = mails.some((m) => goalDoneRefs(m).length > 0 || m.sender || typeof m.replyTo === 'number');
      let cleared = false;
      if (signals) {
        const before = state.derived;
        refresh();
        if (lives().length) {
          for (const m of mails) {
            const arrivedAt = m.createdAt ? Date.parse(m.createdAt) || t : t;
            for (const ref of goalDoneRefs(m)) {
              const target = matchGoalRef(ref, lives(), activeLife()?.id);
              if (target) { cleared = clearGoal(target.id, 'mail', 'done', `${m.sender ?? 'mail'}${m.msgId ? ` msg:${m.msgId}` : ''}`) || cleared; }
              else log('goal-done-unmatched', { ref, from: m.sender ?? '', msgId: m.msgId ?? null });
            }
            for (const life of [...lives()]) {
              if (mailCheckTrue(life.check, m.sender, arrivedAt, life.at)) { cleared = clearGoal(life.id, 'check') || cleared; continue; }
              // A parked goal wakes on the awaited reply.
              if (life.parked && (typeof m.replyTo === 'number' || (life.check?.kind === 'mail' && life.check.from === m.sender?.toUpperCase()))) {
                const { parked: _p, waitingSince: _w, ...rest } = life; putLife(rest);
                log('goal-unparked', { id: life.id, goal: life.text, from: m.sender ?? '' });
                say(`↩ reply arrived for parked goal: ${life.text}`);
                save();
              }
            }
            // Loop signal: the same reply chain partner again.
            const active = activeLife();
            if (active && m.sender && typeof m.replyTo === 'number') {
              putLife({ ...active, sigs: [...(active.sigs ?? []), `mail-pair:${m.sender}`].slice(-LOOP_SIG_KEEP) });
              const sig = loopSig(lifeOf(active.id)!, t);
              if (sig) { const cur = lifeOf(active.id)!; putLife({ ...cur, sigs: [] }); escape('break-loop', cur, escapeLine('break-loop', cur.text, { sig })); }
              save();
            }
          }
        }
        cleared = cleared || !sameDerived(before, state.derived);
      }
      cleared = cleared || applied;
      const crowns = mails.filter((m) => !goalApplied.has(m)).map((m) => ({ m, fc: firstClassFromMail(m, t) })).filter((x): x is { m: GoalMailSignal; fc: FirstClassGoal } => x.fc !== null);
      if (crowns.length === 0) return cleared;
      refresh();
      const before = state.derived;
      for (const { m, fc } of crowns) {
        const replace = (m.refs ?? []).includes(GOAL_REPLACE_REF);
        const deadline = m.deadlineAt ? Date.parse(m.deadlineAt) : NaN;
        const life: Partial<GoalLife> = { ...(Number.isFinite(deadline) ? { deadline } : {}), done: m.doneWhen?.trim() || 'directive carried out (goal_done)' };
        const goalOpen = (state.firstClass ?? []).some((g) => g.source !== 'war');
        if (replace && goalOpen) { openHumanGoal(fc, 'crown-replace', life); continue; }
        if (!goalOpen) { openFirstClass(fc, 'crown-mail', life); continue; }
        // A standing autopilot goal is open: the crown becomes a pin only when it meets the bar, else a normal turn.
        if (state.closedFirstClass?.includes(fc.id) || state.pins?.some((p) => p.id === fc.id)) continue;
        const bar = crownPinBar(m, t);
        if (!bar) { log('goal-rejected', { reason: 'crown-below-bar', goal: fc.text, id: fc.id }); continue; }
        pinGoal({ id: fc.id, text: fc.text, done: bar.done, deadline: bar.deadline, priority: 0, at: t, task: true });
        save();
      }
      return cleared || !sameDerived(before, state.derived);
    },
    /** AUTOPILOT-GOAL-CLEARING — lines queued for the model (due nudges · escapes · cleared-by-others) since the last call. */
    takeNudges(): string[] { return nudges.splice(0, nudges.length); },
    /** Archived goals (newest last). */
    history: (): GoalArchive[] => state.history ?? [],
    /** Lifecycle records of the open goals. */
    lives: (): GoalLife[] => lives(),
    /**
     * AUTOPILOT-HUMAN-GOAL — a background agent finished while a first-class goal is open: the re-feed line for one
     * new turn (goal + «integrate and continue to the done criterion»). Once per capsule; null otherwise.
     */
    noteBackgroundDone(done: AutopilotBackgroundDone): string | null {
      refresh();
      if (!active() || state.derived?.tier !== 'first-class' || done.kind !== 'agent' || refed.has(done.capsuleId)) return null;
      refed.add(done.capsuleId);
      log('goal-refeed', { tier: state.derived.tier, source: state.derived.source, goal: state.derived.goal, capsuleId: done.capsuleId, kind: done.kind, status: done.status });
      return agentDoneRefeed(state.derived.goal, done);
    },
    /** «war» arousal: on → opens the first-class war goal · off → closes it (no arousal source is wired yet). */
    noteWar(on: boolean, text = '⚔ 전시 대응'): boolean {
      refresh();
      const before = state.derived;
      if (on) openFirstClass({ id: 'war:arousal', source: 'war', text, at: now() }, 'war-on');
      else {
        closeFirstClass('war:arousal', 'war-off');
        // war can come back: its id is not a once-only directive.
        if (state.closedFirstClass?.includes('war:arousal')) { state = { ...state, closedFirstClass: state.closedFirstClass.filter((c) => c !== 'war:arousal') }; save(); }
      }
      return !sameDerived(before, state.derived);
    },
    /** Close a first-class goal (its directive is done) — id omitted = the latest. The standing goal returns. */
    closeFirstClass(id?: string): boolean { refresh(); return closeFirstClass(id, 'close') !== null; },
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
        state = { v: 1, on: false, by: source, ...(state.goal ? { goal: state.goal } : {}), ...(state.standing ? { standing: state.standing } : {}), ...goalTier() };
        log('off', { reason: source, goal: state.goal });
        save();
        return { ok: true, text: '🚗 자율주행 꺼짐 — 다시 켤 때까지 꺼진 채로 둔다' };
      }
      if (req.goalDone === true && req.on !== true) {
        // AUTOPILOT-TASK-GOAL-PIN — a task goal's done unpins it (matching text, else the newest pin).
        const pinText = req.goal?.trim() ? (sanitizeGoalText(req.goal) || req.goal.trim()) : undefined;
        const pins = state.pins ?? [];
        const pinTarget = (pinText ? pins.find((p) => p.text === pinText) : undefined)
          ?? (pins.length && (req.kind === 'task' || (req.kind === undefined && !state.firstClass?.length)) ? pinToClose(pins, undefined) : undefined);
        const outcome = req.outcome ?? 'done';
        const reason = req.reason?.trim() || undefined;
        if (outcome === 'dropped' && !reason) return { ok: false, text: '골 포기(outcome:"dropped")에는 사유(reason)가 필요하다' };
        if (pinTarget) {
          const life = lifeOf(pinTarget.id);
          if (outcome === 'dropped' && life) loss('dropped', life, reason!);
          archive(pinTarget.id, 'task', pinTarget.text, outcome, source, reason);
          unpin(pinTarget, `goal-done:${source}`);
          log('goal-cleared', { by: source, goal: pinTarget.text, id: pinTarget.id, outcome, ...(reason ? { reason } : {}) });
          return { ok: true, text: `📌 핀 닫힘: ${pinTarget.text}` };
        }
        const top = state.firstClass?.at(-1);
        if (top && top.source !== 'war') {
          const life = lifeOf(top.id);
          if (outcome === 'dropped' && life) loss('dropped', life, reason!);
          archive(top.id, 'autopilot', firstClassGoalText(top), outcome, source, reason);
          log('goal-cleared', { by: source, goal: firstClassGoalText(top), id: top.id, outcome, ...(reason ? { reason } : {}) });
        }
        const closed = closeFirstClass(undefined, `goal-done:${source}`);
        return closed ? { ok: true, text: `🎯 1급 골 닫힘: ${closed.text} — 지금 골: ${state.goal ?? '(없음)'}` } : { ok: true, text: '🎯 열린 1급 골 없음' };
      }
      if (req.on !== true) return { ok: false, text: 'autopilot_set: on(true|false) 또는 decided 가 필요하다' };
      let until: number | undefined;
      if (req.until !== undefined && req.until !== '') {
        const parsed = parseAutopilotUntil(req.until, t);
        if (parsed === null) return { ok: false, text: `until 은 «HH:MM» 또는 ISO 시각 — 받은 값 ${JSON.stringify(req.until)}` };
        until = parsed;
      }
      // AUTOPILOT-HUMAN-GOAL — the goal text goes through the one sanitizer (a pasted frame never becomes the goal).
      const goal = req.goal?.trim() ? (sanitizeGoalText(req.goal) || req.goal.trim()) : undefined;
      const doneCriterion = req.doneCriterion?.trim() || undefined;
      const kind = req.kind ?? (source === 'tool' ? 'task' : 'autopilot');
      // AUTOPILOT-GOAL-CLEARING — extend: a deadline with no goal moves the open goal's deadline (the «past due» answer).
      if (!goal && req.deadline?.trim() && !req.hold) {
        const at = parseAutopilotUntil(req.deadline, t);
        if (at === null) return { ok: false, text: `deadline 은 «HH:MM» 또는 ISO 시각 — 받은 값 ${JSON.stringify(req.deadline)}` };
        const target = (kind === 'task' ? undefined : activeLife()) ?? activeLife();
        if (!target) return { ok: false, text: '연장할 열린 골이 없다' };
        const { nudgedAt: _n, ...rest } = target;
        putLife({ ...rest, deadline: at });
        if (state.pins?.some((p) => p.id === target.id)) state = { ...state, pins: state.pins!.map((p) => (p.id === target.id ? { ...p, deadline: at } : p)) };
        log('goal-extended', { id: target.id, goal: target.text, from: target.deadline, to: at });
        save();
        return { ok: true, text: `⏰ 기한 연장: ${target.text} → ${clock(at)}` };
      }
      let doneCheck: DoneCheck | undefined;
      if (req.doneCheck !== undefined && req.doneCheck !== null && req.doneCheck !== '') {
        const parsed = parseDoneCheck(req.doneCheck);
        if (!parsed) return { ok: false, text: `done_check 형식: file:<path> · file-updated:<path> · pr:<n> · mail:<SEAT> · checklist:<v>:<status>>=<n> · checklist:<v>:<id>=<status> — 받은 값 ${JSON.stringify(req.doneCheck)}` };
        doneCheck = parsed;
      }
      const est: Partial<GoalLife> = { ...(doneCheck ? { check: doneCheck } : {}),
        ...(typeof req.expectedTurns === 'number' && req.expectedTurns > 0 ? { estTurns: req.expectedTurns } : {}),
        ...(typeof req.expectedMinutes === 'number' && req.expectedMinutes > 0 ? { estMinutes: req.expectedMinutes } : {}) };
      // AUTOPILOT-DYNAMIC-GOAL-FEED — only a person (or a crown directive) sets a goal: an autonomous turn's goal is refused.
      if (goal && source === 'tool' && state.turnOrigin === 'auto') {
        log('goal-refused', { goal, reason: 'autonomous-turn', current: state.goal });
        return { ok: false, text: '골은 사람·대표 지시만 바꾼다 — 보통 우편·요청은 약속 원장·체크리스트에 적는다' };
      }
      // OP-GOAL-EXPLICIT-ONLY — a model-set task goal (📌 pin) needs the person's explicit ask, quoted from this person turn.
      // (The 🚗 chip goal — kind:"autopilot" — stays the standing / crown direction under its own bar and rate limits.)
      if (goal && source === 'tool' && kind === 'task' && !req.hold) {
        const why = explicitGoalAskReason(state, req.explicitAsk);
        if (why) {
          log('goal-refused', { goal, reason: why, current: state.goal });
          return { ok: false, text: `Not a goal: ${why}. A goal is set only when the person explicitly says to set it as a goal (quote their words in explicit_ask) or a crown mail carries a goal field. Answer the question or do the request in this turn.` };
        }
      }
      if (goal && source === 'tool' && !doneCriterion) {
        log('goal-refused', { goal, reason: 'no-done-criterion', current: state.goal });
        return { ok: false, text: '골에는 완료 기준(done_criterion · 한 줄 판정)이 필요하다 — 이번 턴에 끝나는 질문·상태 확인·한 걸음 명령은 골이 아니다' };
      }
      let deadline: number | undefined;
      if (goal && kind === 'task') {
        const parsed = req.deadline?.trim() ? parseAutopilotUntil(req.deadline, t) : null;
        if (!doneCriterion || parsed === null) {
          log('goal-refused', { goal, reason: doneCriterion ? 'no-deadline' : 'no-done-criterion', kind });
          log('goal-rejected', { reason: doneCriterion ? 'no-deadline' : 'no-done-criterion', goal, kind });
          return { ok: false, text: '작업 골(핀)에는 완료 기준(done_criterion)과 기한(deadline «HH:MM»·ISO)이 둘 다 필요하다' };
        }
        deadline = parsed;
      } else if (goal && req.deadline?.trim()) {
        const parsed = parseAutopilotUntil(req.deadline, t);
        if (parsed === null) return { ok: false, text: `deadline 은 «HH:MM» 또는 ISO 시각 — 받은 값 ${JSON.stringify(req.deadline)}` };
        deadline = parsed;
      }
      // AUTOPILOT-GOAL-CLEARING — the acceptance bar for a model-set goal: done + deadline + multi-turn size + rate limits.
      if (goal && source === 'tool' && !req.hold) {
        const frozen = kind === 'autopilot' && state.freezeUntil !== undefined && t < state.freezeUntil;
        const bar = goalBarReason({ kind: frozen ? 'task' : kind, doneCriterion, deadline: deadline ?? null,
          ...(est.estTurns ? { estTurns: est.estTurns } : {}), ...(est.estMinutes ? { estMinutes: est.estMinutes } : {}) },
          { goalOpens: state.goalOpens, pinChanges: state.pinChanges }, t);
        if (bar) {
          log('goal-rejected', { reason: bar, goal, kind });
          return { ok: false, text: GOAL_REJECT_TEXT[bar] ?? bar };
        }
      }
      if (req.hold) {
        if (!state.on) return { ok: false, text: '🚗 자율주행이 꺼져 있다 — 먼저 켜라' };
        state = { ...state, paused: { at: state.paused?.at ?? t, hold: true, lastHumanAt: t } };
        log('pause', { reason: 'human-hold', goal: state.goal });
        save();
        return { ok: true, text: '🚗 PAUSED · 사람 운전 (다시 자율주행이라고 할 때까지)' };
      }
      if (goal && kind === 'task' && deadline !== undefined) {
        // A task goal never touches the chip goal: autopilot is switched on (as asked) and the goal becomes a pin.
        if (!state.on) {
          state = { ...state, on: true, since: t, by: source };
          log('on', { reason: source, goal: state.goal });
          applyDerived(`on-${source}`);
        }
        const pin: TaskPin = { id: `pin:${t}:${randomUUID().slice(0, 8)}`, text: goal, done: doneCriterion!, deadline,
          priority: pinPriority(req.priority) as PinPriority, at: t };
        pinGoal(pin, est);
        const change = lastPinChange!;
        if (source === 'tool') state = { ...state, pinChanges: [...(state.pinChanges ?? []).filter((at) => t - at < 2 * GOAL_RATE_WINDOW_MS), t] };
        save();
        return { ok: true, text: `📌 ${change.pins.length} · ${pin.text}${change.evicted ? ` (밀림: ${change.evicted.text})` : ''}` };
      }
      if (state.on && !state.stopped && state.paused && !goal) {
        resume(source);
        return { ok: true, text: api.statusText() };
      }
      state = { v: 1, on: true, since: t, by: source, ...(state.standing ? { standing: state.standing } : {}), ...goalTier(),
        ...(goal ? { goal } : state.goal ? { goal: state.goal } : {}), ...(until !== undefined ? { until } : {}),
        ...(state.turnOrigin ? { turnOrigin: state.turnOrigin } : {}), ...(state.turnText ? { turnText: state.turnText } : {}) };
      log('on', { reason: source, goal: state.goal, ...(until !== undefined ? { until } : {}) });
      // A person's goal = a first-class directive (it overrides the standing goal until goal_done closes it).
      // A newer person's direction supersedes the older one (crown goals underneath stay open).
      if (goal) {
        if (source === 'tool') state = { ...state, goalOpens: [...(state.goalOpens ?? []).filter((at) => t - at < 2 * GOAL_RATE_WINDOW_MS), t] };
        openHumanGoal({ id: `human:${t}:${randomUUID().slice(0, 8)}`, source: 'human', text: goal, at: t, ...(doneCriterion ? { done: doneCriterion } : {}) }, `human-${source}`,
          { ...est, ...(deadline !== undefined ? { deadline } : {}) });
      }
      else if (!applyDerived(`on-${source}`)) save();
      return { ok: true, text: api.statusText() };
    },
    /**
     * A human keystroke / submitted line is just another input — autopilot stays AUTO (CEO 11-25). Only an explicit
     * hold (autopilot_set {hold:true} · «내가 운전») pauses. Observed: `keystroke-ignored`, at most once a minute.
     */
    noteHuman(): void {
      if (!state.on || state.stopped) return;
      const t = now();
      humanTurnAt = t;
      if (keystrokeLoggedAt !== null && t - keystrokeLoggedAt < 60_000) return;
      keystrokeLoggedAt = t;
      log('keystroke-ignored', { goal: state.goal, ...(state.paused ? { hold: state.paused.hold } : {}) });
    },
    /** Periodic: `until` reached → off · 10 min without human input → resume. Returns true when it resumed. */
    tick(): boolean {
      const t = now();
      if (state.on && state.until !== undefined && t >= state.until) {
        state = { v: 1, on: false, by: 'until', ...(state.goal ? { goal: state.goal } : {}), ...(state.standing ? { standing: state.standing } : {}), ...goalTier() };
        log('off', { reason: 'until-reached', goal: state.goal });
        save();
        return false;
      }
      rollStanding();
      if (state.on) clearPass();
      expireDue();
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
      // AUTOPILOT-GOAL-CLEARING — charge this turn to the active goal; turn-based escapes (burn · loop · stall · blocked).
      // Only turns that work toward the goal are charged: autopilot's own wakes and a person's turns (mail turns are not).
      const charged = end.selfInitiated || humanTurnAt !== null ? activeLife() : undefined;
      if (charged) {
        const sigs = [...(charged.sigs ?? []), ...(end.toolSigs ?? [])].slice(-LOOP_SIG_KEEP);
        const waiting = (end.waitingOn ?? 0) > 0;
        let life: GoalLife = { ...charged, turns: charged.turns + 1, tokens: charged.tokens + Math.max(0, end.tokens ?? 0), sigs,
          idleTurns: end.stateChanged === true ? 0 : end.stateChanged === false ? charged.idleTurns + 1 : charged.idleTurns,
          lastProgressAt: end.stateChanged === true ? t : charged.lastProgressAt };
        if (waiting && life.waitingSince === undefined) life = { ...life, waitingSince: t };
        if (!waiting && life.waitingSince !== undefined && life.check?.kind !== 'mail') { const { waitingSince: _w, ...rest } = life; life = rest; }
        putLife(life);
        const sig = loopSig(life, t);
        if (burnDue(life)) {
          const note = writeHandoff(life);
          let card: string | undefined;
          try { card = deps.raiseDecision?.({ title: `goal hand-off · ${short(life.text, 50)}`, reason: `tokens=${life.tokens} turns=${life.turns}${life.estTurns ? ` estimate=${life.estTurns}` : ''}`, goal: life.text, sessionId: deps.sessionId }); }
          catch (error) { log('decision-failed', { error: error instanceof Error ? error.message : String(error) }); }
          escape('hand-off', life, escapeLine('hand-off', life.text, { ...(note ? { note } : {}), ...(card ? { card } : {}) }), { ...(note ? { note } : {}), ...(card ? { decisionId: card } : {}) });
        } else if (sig) {
          putLife({ ...life, sigs: [] });
          escape('break-loop', life, escapeLine('break-loop', life.text, { sig: short(sig, 60) }), { sig: short(sig, 120) });
        } else if (blockedDue(life, t)) park(life);
        else if (stallDue(life, t)) narrow(life);
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
      // AUTOPILOT-HUMAN-GOAL — background agents still run for the open first-class goal: the turn end is not «done».
      // The goal stays; each agent completion re-feeds it (noteBackgroundDone). A turn that changed nothing gets one
      // «초안부터» nudge per goal.
      let nudge: string | undefined;
      const openGoal = state.derived?.tier === 'first-class' ? state.firstClass?.at(-1) : undefined;
      const humanTurn = !end.selfInitiated && humanTurnAt !== null;
      if ((end.backgroundRunning ?? 0) > 0 && (openGoal || humanTurn) && !state.paused) {
        const key = openGoal?.id ?? `human-turn:${humanTurnAt}`;
        const goal = openGoal ? state.derived?.goal : undefined;
        log('await-agents', { goal: goal ?? '', key, running: end.backgroundRunning, stateChanged: end.stateChanged === true });
        if (end.stateChanged !== true && state.awaitNudged !== key) {
          state = { ...state, awaitNudged: key };
          nudge = awaitAgentsNudge(goal, end.backgroundRunning ?? 0);
          log('await-agents-nudge', { goal: goal ?? '', key, running: end.backgroundRunning });
        }
      }
      if (!end.selfInitiated) humanTurnAt = null;
      // AUTOPILOT-GOAL-DRIVE — the open goal continues now when the turn left work it can do now (structured signals only).
      let drive: string | undefined;
      {
        const life = activeLife();
        let handPull: HandPullInput | undefined;
        try { handPull = deps.handPull?.(); } catch { handPull = undefined; }
        const driveKey = life ? life.id : handPull ? 'hand-pull' : undefined;
        const history = state.drive && driveKey && state.drive.key === driveKey ? driveWindow(state.drive.at, t) : [];
        const toolSig = end.toolSigs && end.toolSigs.length > 0 ? createHash('sha256').update(end.toolSigs.join('\n')).digest('hex').slice(0, 16) : undefined;
        const repeatToolCall = end.selfInitiated && toolSig !== undefined && driveKey !== undefined && state.drive?.key === driveKey && state.drive?.toolSig === toolSig;
        // GOAL-DRIVE-NARROW ① — only a TASK goal is driven (structured: done check · task flag · crown directive).
        const taskGoal = life ? isTaskGoal({ hasCheck: life.check !== undefined,
          taskFlag: state.firstClass?.some((g) => g.id === life.id && g.task === true) === true || state.pins?.some((p) => p.id === life.id && p.task === true) === true,
          crownDirective: state.firstClass?.some((g) => g.id === life.id && g.source === 'crown') === true }) : undefined;
        // GOAL-DRIVE-NARROW ③ — did the previous continuation move the ledger? 3 unchanged in a row = blocked.
        let fp: string | undefined;
        try { fp = deps.ledgerFingerprint?.(); } catch { fp = undefined; }
        const prevDrive = state.drive && driveKey && state.drive.key === driveKey ? state.drive : undefined;
        const ledgerUnchanged = end.selfInitiated && fp !== undefined && prevDrive?.ledgerFp !== undefined && prevDrive.ledgerFp === fp;
        const moved = fp !== undefined && prevDrive?.ledgerFp !== undefined && prevDrive.ledgerFp !== fp;
        const unchanged = ledgerUnchanged ? (prevDrive?.unchanged ?? 0) + 1 : moved ? 0 : prevDrive?.unchanged ?? 0;
        if (prevDrive && fp !== undefined && (end.selfInitiated || moved)) {
          state = { ...state, drive: { ...prevDrive, ledgerFp: fp, unchanged } };
          if (ledgerUnchanged) log(unchanged >= DRIVE_BLOCK_AFTER_UNCHANGED ? 'goal-blocked' : 'drive-no-progress', { goal: life?.text ?? '', id: driveKey, unchanged });
        }
        // OP-GOAL-DRIVEN-LOOP ④ — goal-scoped progress evidence: the count toward the goal's OWN checklist count check
        // (checklist:<version>:<status>>=n) — never a global fingerprint, so other cells' churn can't feed this goal's drive.
        // One read per turn end; unknown/failed reads fail closed. The persisted per-goal high-water consumes each increase
        // once, so the same count never buys a second continuation past the cap.
        let goalProgress = false;
        const progressGoal = life && !life.parked ? life : undefined;
        const progressCheck = progressGoal?.check?.kind === 'checklist' && progressGoal.check.id === undefined ? progressGoal.check : undefined;
        if (progressGoal && progressCheck) {
          try {
            const count = deps.checklistCount?.(progressCheck.version, progressCheck.status);
            if (count !== undefined && Number.isSafeInteger(count) && count >= 0) {
              const seen = observeChecklistHighWater(state.driveProgress?.[progressGoal.id], {
                goalId: progressGoal.id, version: progressCheck.version, status: progressCheck.status,
                target: progressCheck.min ?? 1, count,
              });
              if (seen.highWater) state = { ...state, driveProgress: { ...(state.driveProgress ?? {}), [progressGoal.id]: seen.highWater } };
              goalProgress = seen.progress;
            }
          } catch { /* observation is evidence, not a gate — an unknown count buys nothing */ }
        }
        const verdict = decideGoalDrive({
          ...(life && !life.parked ? { goalId: life.id } : {}),
          failed: end.failed, // still paused after this turn: a hold, or a self wake while a person drives (a person's turn resumes below)
          paused: state.paused !== undefined && (state.paused.hold || end.selfInitiated), backoff: state.backoff !== undefined,
          personQueued: end.personQueued ?? 0, needsHuman: end.needsHuman === true, waitingOn: end.waitingOn ?? 0,
          backgroundRunning: end.backgroundRunning ?? 0, sameReply: end.selfInitiated && (state.noProgress?.count ?? 0) >= AUTOPILOT_RUNAWAY_REPEATS, repeatToolCall,
          ...(end.modelWakeInMs !== undefined ? { modelWakeInMs: end.modelWakeInMs } : {}),
          ...(end.stateChanged !== undefined ? { stateChanged: end.stateChanged } : {}), ...(end.openWork !== undefined ? { openWork: end.openWork } : {}),
          ...(handPull ? { handPull } : {}),
          ...(taskGoal !== undefined ? { taskGoal } : {}), ...(ledgerUnchanged ? { ledgerUnchanged: true } : {}),
          ...(unchanged >= DRIVE_BLOCK_AFTER_UNCHANGED ? { blocked: true } : {}),
          ...(goalProgress ? { goalProgress: true } : {}),
          history, now: t,
        });
        if (verdict.kind === 'continue' && verdict.signal === 'hand-pull' && handPull) {
          // HAND-PULL-FIRST — the hand takes the next cell now (same session) instead of waiting for an assignment.
          state = { ...state, drive: { key: driveKey ?? 'hand-pull', at: [...history, t], ...(toolSig ? { toolSig } : {}), ...(fp !== undefined ? { ledgerFp: fp, unchanged } : {}) } };
          drive = DRIVE_HAND_PULL_PROMPT(handPull.cell === 'open' ? 'waiting' : handPull.cell);
          log('drive-continue', { signal: verdict.signal, cell: handPull.cell, streak: history.length + 1 });
        } else if (verdict.kind === 'continue' && life) {
          state = { ...state, drive: { key: life.id, at: [...history, t], ...(toolSig ? { toolSig } : {}), ...(fp !== undefined ? { ledgerFp: fp, unchanged } : {}) } };
          drive = DRIVE_CONTINUE_PROMPT(life.text);
          log('drive-continue', { signal: verdict.signal, goal: life.text, id: life.id, streak: history.length + 1,
            ...(end.modelWakeInMs !== undefined ? { modelWakeInMs: end.modelWakeInMs } : {}) });
        } else if (verdict.kind === 'stop' && life && history.length > 0) {
          // only a drive streak that ends is logged (a turn that never drove stays silent)
          log('drive-stop', { reason: verdict.reason, goal: life.text, id: life.id, streak: history.length });
        }
      }
      const withNudge = <T extends AutopilotTurnEndResult>(r: T): T => {
        const withDrive = drive ? { ...r, drive } : r;
        return nudge ? { ...withDrive, nudge } : withDrive;
      };
      // AUTOPILOT-GOAL-CONTINUE-CAP: a person's turn finished → the wheel goes back (only «hold» keeps a person driving).
      if (state.paused && !state.paused.hold && !end.selfInitiated) {
        log('resume-decided', { reason: 'human-turn-done', goal: state.goal });
        resume('human-turn-done');
      }
      if (state.paused) { save(); return { arm: null, ...(state.backoff ? { backoff: state.backoff.reason } : {}) }; }
      if (end.scheduledWakeAt !== undefined) { state = { ...state, nextWakeAt: end.scheduledWakeAt }; save(); return withNudge({ arm: null }); }
      if (end.rhythmActive && deps.coordinator && !state.backoff) { save(); return withNudge({ arm: null }); }
      const delayMs = state.backoff ? AUTOPILOT_BACKOFF_CADENCE_MS : end.openWork ? AUTOPILOT_OPEN_WORK_CADENCE_MS : AUTOPILOT_DEFAULT_CADENCE_MS;
      save();
      return withNudge({ arm: { delayMs, reason: `🚗 자율주행: 목표를 향해 이어서 진행${state.goal ? ` — ${state.goal}` : ''}` }, ...(state.backoff ? { backoff: state.backoff.reason } : {}) });
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
      if (state.paused) return '🚗 PAUSED · you are driving';
      const near = nearestGoalChip(goals(), now());
      const goal = `${state.goal ? ` · ${short(state.goal)}` : ''}${near ? ` · ${near}` : ''}`;
      const next = state.nextWakeAt !== undefined && state.nextWakeAt > now() ? ` · next ⏰${clock(state.nextWakeAt)}` : '';
      return `🚗 AUTO${goal}${state.backoff ? ' · slowed' : ''}${next}`;
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

/**
 * AUTOPILOT-GOAL-CLEARING — production slow done checks (the controller throttles each goal to one per 5 min):
 * pr-merged = `gh pr view <n> --json state` (async · 20 s cap) · checklist = the release checklist ledger (one read).
 */
export async function slowDoneCheck(check: DoneCheck): Promise<boolean> {
  if (check.kind === 'pr-merged') {
    const { execFile } = require('node:child_process') as typeof import('node:child_process');
    const out = await new Promise<string>((resolve, reject) => {
      execFile('gh', ['pr', 'view', String(check.pr), '--json', 'state', '-q', '.state'], { timeout: 20_000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
    });
    return out.trim() === 'MERGED';
  }
  if (check.kind === 'checklist') {
    const { list } = require('../release-loop/feature-store.js') as typeof import('../release-loop/feature-store.js');
    return checklistCheckTrue(check, list(check.version).items.map((i) => ({ id: i.id, status: String(i.status) })));
  }
  return false;
}

/** GOAL-DRIVEN-LOOP — one release-checklist read: how many cells of `version` currently hold `status` (fail-soft: undefined = unknown). */
export function checklistStatusCount(version: string, status: string): number | undefined {
  try {
    const { list } = require('../release-loop/feature-store.js') as typeof import('../release-loop/feature-store.js');
    return list(version).items.filter((i) => String(i.status) === status).length;
  } catch {
    return undefined;
  }
}
