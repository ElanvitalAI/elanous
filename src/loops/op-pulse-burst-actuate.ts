// BURST-ACTUATOR-WIRED (0.3.40 P1 · CEO 11-29 02:3x «등록이 아니라 당장 바로 시작») — the burst's hands.
//
// S: `eln pulse burst start --goal land --preset 4h` (burst-20261128T1409) beat «손 +0 · VM 0» for ~5 h. The pulse wrote
//    «- hands: 4 → 6» every 15 min, the rhythm yaml called the actuators «wired», and burst.json kept `launches: []`.
// C: two faults. (1) Nothing executed planScale(): its decisions were only rendered as brief lines; the only writer of a
//    launch was the manual `eln pulse burst launched`. (2) startBurst seeded `levels` with the preset TARGETS, so the
//    planner believed 4 hands were already up and every beat read a target as if it were running.
// Q: how does a started burst raise a real lane within one burst cadence (15 min), and how does the beat say what ran?
// A: actuateBurst() — every unblocked step of the plan goes through the lane's existing door (hands = els new for a hand
//    seat with no live pane · vm = eln hosts start), injected so tests and sims drive fakes. Each launched unit is recorded
//    with its exact id (budget-guarded by recordLaunch); `levels` = executed units only; the beat line counts launches.
//    A lane whose door is `none` (graphs/policies/burst-actuators.yaml) says «미배선», never a fake +k.
//
// 세 얼굴:
//   관측 = burst.json launches (exact ids) · the brief's «실행» line (executed vs planned per lane) · the ⚠ stall line
//   판단 근거 = planScale decisions (pressure · cooldown · budget · local first) ⊕ the YAML door table
//   수복과 인계 = an actuator error / no free seat / unwired lane stays in the row (OP sees why); a burst older than
//          stall_after_min with zero launches while a lane wants up raises a ⚠ line in the pulse turn
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { BURST_LANES, recordLaunch, type BurstLane, type BurstLaunch, type BurstState, type LaneConfig, type ScaleDecision } from './op-pulse-burst.js';

export type BurstDoor = 'els-new' | 'hosts-start' | 'none';

export interface BurstActuatorPolicy {
  readonly stallAfterMin: number;
  readonly maxUnitsPerPulse: number;
  readonly costHoursCap: number;
  readonly pressureTargets: { readonly gateWaitMin: number; readonly reviewWaitMin: number; readonly landQueue: number; readonly readyPerHandDefault: number; readonly judgeWaitMinDefault: number };
  readonly lanes: Readonly<Record<BurstLane, { readonly door: BurstDoor; readonly seatsDir?: string; readonly command?: readonly string[]; readonly timeoutSec?: number }>>;
}

export const burstActuatorPolicyPath = (root = resolve(import.meta.dir, '../..')): string => join(root, 'graphs', 'policies', 'burst-actuators.yaml');

const DOORS: ReadonlySet<string> = new Set(['els-new', 'hosts-start', 'none']);

/** Parse the policy text. A missing / invalid value throws (the caller decides what an unreadable policy means). */
export function parseBurstActuatorPolicy(text: string): BurstActuatorPolicy {
  const v = parse(text) as Record<string, unknown> | null;
  const num = (obj: unknown, key: string, path: string, min: number): number => {
    const n = (obj as Record<string, unknown> | undefined)?.[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min) throw new Error(`burst-actuators policy: invalid ${path}`);
    return n;
  };
  const pt = v?.pressure_targets;
  const rawLanes = (v?.lanes ?? {}) as Record<string, Record<string, unknown>>;
  const lanes = {} as Record<BurstLane, BurstActuatorPolicy['lanes'][BurstLane]>;
  for (const lane of BURST_LANES) {
    const row = rawLanes[lane];
    const door = row?.door ?? 'none';
    if (typeof door !== 'string' || !DOORS.has(door)) throw new Error(`burst-actuators policy: invalid lanes.${lane}.door`);
    const strs = (k: string): string[] | undefined => {
      const a = row?.[k];
      if (a === undefined) return undefined;
      if (!Array.isArray(a) || !a.every(x => typeof x === 'string' && x.length > 0)) throw new Error(`burst-actuators policy: invalid lanes.${lane}.${k}`);
      return a as string[];
    };
    const command = strs('command');
    const seatsDir = row?.seats_dir;
    if (door === 'els-new' && (!command?.length || typeof seatsDir !== 'string' || !seatsDir || seatsDir.includes('/'))) throw new Error(`burst-actuators policy: lanes.${lane} els-new needs command and seats_dir (one folder name)`);
    lanes[lane] = {
      door: door as BurstDoor,
      ...(typeof seatsDir === 'string' ? { seatsDir } : {}),
      ...(command ? { command } : {}),
      // A wired door must say how long one launch may take (no code default).
      ...(door !== 'none' ? { timeoutSec: num(row, 'timeout_sec', `lanes.${lane}.timeout_sec`, 1) } : {}),
    };
  }
  return {
    stallAfterMin: num(v, 'stall_after_min', 'stall_after_min', 1),
    maxUnitsPerPulse: num(v, 'max_units_per_pulse', 'max_units_per_pulse', 1),
    costHoursCap: num(v, 'cost_hours_cap', 'cost_hours_cap', 0),
    pressureTargets: {
      gateWaitMin: num(pt, 'gate_wait_min', 'pressure_targets.gate_wait_min', 1), reviewWaitMin: num(pt, 'review_wait_min', 'pressure_targets.review_wait_min', 1),
      landQueue: num(pt, 'land_queue', 'pressure_targets.land_queue', 1), readyPerHandDefault: num(pt, 'ready_per_hand_default', 'pressure_targets.ready_per_hand_default', 1),
      judgeWaitMinDefault: num(pt, 'judge_wait_min_default', 'pressure_targets.judge_wait_min_default', 1),
    },
    lanes,
  };
}

let memo: { path: string; mtimeMs: number; policy: BurstActuatorPolicy } | null = null;
/** The live policy (re-read when the file changes). Throws when unreadable — a burst must not run on invented numbers. */
export function liveBurstActuatorPolicy(path = burstActuatorPolicyPath()): BurstActuatorPolicy {
  const mtimeMs = statSync(path).mtimeMs;
  if (memo && memo.path === path && memo.mtimeMs === mtimeMs) return memo.policy;
  const policy = parseBurstActuatorPolicy(readFileSync(path, 'utf8'));
  memo = { path, mtimeMs, policy };
  return policy;
}

// ── state normalisation ─────────────────────────────────────────────────────────────────────────────────────────────

/** Open (not closed) launches per lane — the executed level. */
export function executedLevels(state: Pick<BurstState, 'launches'>): Partial<Record<BurstLane, number>> {
  const out: Partial<Record<BurstLane, number>> = {};
  for (const l of state.launches) if (!l.closedAt) out[l.lane] = (out[l.lane] ?? 0) + 1;
  return out;
}

/**
 * A burst.json written before this fix carried the preset targets in `levels` and no `targets`: move them to `targets`
 * and rebuild `levels` from the recorded launches, so the planner starts from what really runs.
 */
export function normalizeBurstState(state: BurstState): BurstState {
  if (state.targets !== undefined) return state;
  return { ...state, targets: { ...state.levels }, levels: executedLevels(state) };
}

// ── actuation ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface BurstUnit { readonly id: string; readonly host?: string }
/** One lane's door: launch up to `count` units now; returns the exact ids it launched (fewer = no more capacity, with why). */
export type BurstLaunchDoor = (input: { lane: BurstLane; count: number; state: BurstState; now: Date }) => Promise<{ units: BurstUnit[]; note?: string }>;
export interface BurstActuators {
  readonly up: Partial<Record<BurstLane, BurstLaunchDoor>>;
  /** Close one launch by its exact id (scale-down). Absent = scale-downs stay planned only. */
  readonly close?: (launch: BurstLaunch) => Promise<void>;
}

export type ActuationStatus = 'did' | 'partial' | 'would' | 'unwired' | 'failed' | 'blocked' | 'capped';
export interface ActuationRow {
  readonly lane: BurstLane; readonly from: number; readonly planned: number; readonly executed: number;
  readonly ids: readonly string[]; readonly status: ActuationStatus; readonly note: string;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);

/**
 * Execute the scale plan. live → each unblocked up-step goes through its lane door (at most max_units_per_pulse units
 * this pulse), each unit recorded by exact id with its cost (recordLaunch refuses past the budget ceiling); each
 * down-step closes the newest open launches of the lane. Any other stage → «would» rows, state unchanged.
 * `levels` always equals the executed (open) launches afterwards.
 */
export async function actuateBurst(input: {
  state: BurstState; plan: readonly ScaleDecision[]; actuators: BurstActuators | null; policy: BurstActuatorPolicy;
  lanes: Readonly<Record<BurstLane, LaneConfig>>; now: Date; stage: string;
}): Promise<{ state: BurstState; rows: ActuationRow[] }> {
  let state = input.state;
  const rows: ActuationRow[] = [];
  let unitsLeft = input.policy.maxUnitsPerPulse;
  const hoursLeft = Math.max(0, (Date.parse(state.until) - input.now.getTime()) / 3_600_000);
  for (const d of input.plan) {
    const planned = d.to - d.from;
    if (d.blocked || planned === 0) { rows.push({ lane: d.lane, from: d.from, planned: 0, executed: 0, ids: [], status: 'blocked', note: d.blocked ?? 'no step' }); continue; }
    if (input.stage !== 'live') { rows.push({ lane: d.lane, from: d.from, planned, executed: 0, ids: [], status: 'would', note: `stage ${input.stage}` }); continue; }
    if (planned < 0) {
      const close = input.actuators?.close;
      if (!close) { rows.push({ lane: d.lane, from: d.from, planned, executed: 0, ids: [], status: 'unwired', note: 'no closer' }); continue; }
      const open = state.launches.filter(l => l.lane === d.lane && !l.closedAt).slice(planned);
      const closed: string[] = []; let note = '';
      for (const l of open.reverse()) {
        try { await close(l); closed.push(l.id); state = { ...state, launches: state.launches.map(x => x === l ? { ...x, closedAt: input.now.toISOString() } : x) }; }
        catch (e) { note = `close ${l.id}: ${msg(e)}`; break; }
      }
      if (closed.length) state = { ...state, lastChangeAt: { ...state.lastChangeAt, [d.lane]: input.now.toISOString() } };
      rows.push({ lane: d.lane, from: d.from, planned, executed: -closed.length, ids: closed, status: closed.length === -planned ? 'did' : closed.length ? 'partial' : 'failed', note });
      continue;
    }
    const door = input.policy.lanes[d.lane].door === 'none' ? undefined : input.actuators?.up[d.lane];
    if (!door) {
      const why = input.policy.lanes[d.lane].door === 'none' ? 'door none in graphs/policies/burst-actuators.yaml' : `door ${input.policy.lanes[d.lane].door} not given to this pulse`;
      rows.push({ lane: d.lane, from: d.from, planned, executed: 0, ids: [], status: 'unwired', note: why }); continue;
    }
    const count = Math.min(planned, unitsLeft);
    if (count <= 0) { rows.push({ lane: d.lane, from: d.from, planned, executed: 0, ids: [], status: 'capped', note: `max_units_per_pulse ${input.policy.maxUnitsPerPulse} used` }); continue; }
    let units: BurstUnit[] = []; let note = '';
    try { const r = await door({ lane: d.lane, count, state, now: input.now }); units = r.units.slice(0, count); note = r.note ?? ''; }
    catch (e) { rows.push({ lane: d.lane, from: d.from, planned, executed: 0, ids: [], status: 'failed', note: msg(e) }); continue; }
    const ids: string[] = [];
    const unitCost = input.lanes[d.lane].costPerUnitHourUsd * Math.min(hoursLeft, input.policy.costHoursCap);
    for (const u of units) {
      // recordLaunch refuses a unit past the budget ceiling; the door already ran, so the unit is named in the note for OP
      // to close by id (the ledger must not hide a running unit).
      try { state = recordLaunch(state, { lane: d.lane, id: u.id, ...(u.host ? { host: u.host } : {}) }, input.now, unitCost); ids.push(u.id); }
      catch (e) { note = `${note ? `${note} · ` : ''}${u.id} launched but not recorded (${msg(e)}) — close it by id`; }
    }
    unitsLeft -= ids.length;
    if (ids.length) state = { ...state, lastChangeAt: { ...state.lastChangeAt, [d.lane]: input.now.toISOString() } };
    rows.push({ lane: d.lane, from: d.from, planned, executed: ids.length, ids, status: ids.length === planned ? 'did' : ids.length ? 'partial' : 'failed', note: note || (ids.length < planned ? `door launched ${ids.length}/${planned}` : '') });
  }
  return { state: { ...state, levels: executedLevels(state) }, rows };
}

// ── what the beat says ──────────────────────────────────────────────────────────────────────────────────────────────

const LANE_WORD: Readonly<Record<BurstLane, string>> = { hands: '손', remote: '원격', ta: 'TA', review: '리뷰', pregate: '게이트', land: '착지', judge: '판정', vm: 'VM' };
const signed = (n: number) => (n >= 0 ? `+${n}` : String(n));

/** The beat line: executed units this pulse per lane (never the plan), then what runs in total. */
export function actuationSummary(rows: readonly ActuationRow[], state: BurstState): string {
  const by = (lane: BurstLane) => rows.filter(r => r.lane === lane).reduce((n, r) => n + r.executed, 0);
  const open = executedLevels(state);
  const total = Object.values(open).reduce((n, x) => n + (x ?? 0), 0);
  const running = BURST_LANES.filter(l => (open[l] ?? 0) > 0).map(l => `${LANE_WORD[l]} ${open[l]}`).join(' · ');
  return `실행(이번 펄스): 손 ${signed(by('hands'))} · VM ${signed(by('vm'))}${rows.some(r => r.lane !== 'hands' && r.lane !== 'vm' && r.executed) ? ` · 그 밖 ${rows.filter(r => r.lane !== 'hands' && r.lane !== 'vm').reduce((n, r) => n + r.executed, 0)}` : ''} · 가동 중 ${total}${running ? ` (${running})` : ''}`;
}

export function actuationLines(rows: readonly ActuationRow[]): string[] {
  return rows.filter(r => r.status !== 'blocked').map(r => `- 실행 ${r.lane}: 계획 ${signed(r.planned)} → 실행 ${signed(r.executed)} (${r.status}${r.ids.length ? ` · ${r.ids.join(', ')}` : ''}${r.note ? ` · ${r.note}` : ''})`);
}

/** ⚠ when the burst is older than stall_after_min, nothing ever launched, and the plan still wants a lane up. */
export function stallLine(state: BurstState, rows: readonly ActuationRow[], now: Date, policy: BurstActuatorPolicy): string | null {
  const ageMin = (now.getTime() - Date.parse(state.startedAt)) / 60_000;
  if (ageMin < policy.stallAfterMin || state.launches.length > 0) return null;
  const wanted = rows.filter(r => r.planned > 0);
  if (!wanted.length) return null;
  return `⚠ 버스트 무가동 ${Math.round(ageMin)}분 — 계획은 올리는데 실행 0: ${wanted.map(r => `${r.lane} ${r.status}${r.note ? ` (${r.note})` : ''}`).join(' · ')}`;
}
