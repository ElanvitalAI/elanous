// ── 조건 감시 틱 `commitment/condition-sweep` (COND-WATCH · steward:mail R5 · 11-28) ─────────────────────────────────
//
// S 11-28 00:2x 실측: 깨우개 9,145 중 armed 1,479 · 그 가운데 1,449 가 지평을 이미 넘겼다(TC 1,136 · UX 109 · OP 32 …).
//   24h 동안 commitment.watch.armed 727 · satisfied 1 · expired 1. 약속을 «조건»으로 걸어도 재는 것이 없었다.
// C 조건을 재는 길은 둘뿐이다 — 우편마다 뜨는 분리 감시(`msg wait-for`)와 일정 틱(`msg wait-tick`). 분리 감시는 부모가
//   죽으면 `orphaned` 로 나가며 «wait-tick 이 이어 잰다»고 남기는데, wait-tick 을 거는 일정은 한 번도 등록되지 않았다
//   (self-timer-watch.ts 머리 «틱 등록은 OP 몫»). 그래서 조건은 충족도 만료도 없이 쌓이고, 사람은 다시 «회신해 달라»를 쓴다.
// Q 어떻게 «충족·만료 때만 주인을 한 번 깨우는» 약속을 실제로 지키나 — 쌓인 1,449 를 한꺼번에 깨우지 않고?
// A 그래프 러너 레시피 하나(graphs/triggers/cond-watch-sweep.yaml · 5분)가 전 자리의 armed 깨우개를 한 번씩 잰다:
//   · 지평을 `staleMs`(30분) 넘게 지난 것 = 묵은 것 → 아무도 깨우지 않고 정리(retireStaleWaker): 로컬 원장 조건이 지금 차
//     있으면 약속을 근거와 함께 닫고(조용한 satisfied), 아니면 `stale` 로 거둔다. 사실은 기록되고 아무도 깨우지 않는다.
//   · 다른 살아 있는 감시가 지키는 것 = 건너뜀(두 번 깨우지 않는다).
//   · 나머지 = evaluateWaker 그대로(충족 → 약속 닫고 한 번 깨움 · 만료 → 한 번 깨움 · 아니면 대기). 한 틱의 깨움은 `maxWakes`
//     까지 — 넘치면 다음 틱으로 미룬다(깨움 폭주 막이).
//   shadow 단계 = dry-run: 같은 판정을 «했을 것»으로만 적는다(원장 쓰기 0 · 깨움 0).
//
// 세 얼굴:
//   관측 = commitment.watch.sweep {counts} 한 줄/틱 ⊕ <state>/commitments/watch-sweep.json(마지막 틱 · 그래프 goal) ⊕
//          `eln commitment watches`(열린 조건 표)
//   판단 근거 = 깨우개 칸(condition · deadlineAt · watcherPid · autoClose) ⊕ 탐침이 돌려준 원장 줄
//   수복과 인계 = 충족 → 약속 done ⊕ 주인 1회 · 만료 → 주인 1회 · 묵은 것 → 조용히 정리(주인은 `eln commitment list` 에서 본다)

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { describeWatch } from './condition-watch.js';
import {
  defaultWakersRoot, evaluateWaker, listWakers, measurePredicate, parseWaitCondition, retireStaleWaker,
  type SelfTimerDeps, type WakerRecord,
} from '../msg/self-timer-watch.js';
import { debug } from '../debug/log.js';

/** Sweep policy — graphs/policies/condition-sweep.yaml (stale window · wake budget · probe budget). Read per sweep. */
export interface ConditionSweepPolicy { readonly staleMs: number; readonly maxWakes: number; readonly maxProbes: number }
export const conditionSweepPolicyPath = (root = resolve(import.meta.dir, '../..')): string => join(root, 'graphs', 'policies', 'condition-sweep.yaml');
/** Pure: the pack text → policy. Throws on a missing or non-positive key (a malformed pack is never a silent default). */
export function parseConditionSweepPolicy(text: string): ConditionSweepPolicy {
  const y = (parse(text) ?? {}) as { version?: unknown; sweep?: Record<string, unknown> };
  if (y.version !== 1) throw new Error('condition-sweep policy: version must be 1');
  const num = (k: string): number => {
    const v = y.sweep?.[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`condition-sweep policy: sweep.${k} must be a positive number`);
    return v;
  };
  return { staleMs: num('stale_min') * 60_000, maxWakes: Math.floor(num('max_wakes')), maxProbes: Math.floor(num('max_probes')) };
}
export function loadConditionSweepPolicy(path = conditionSweepPolicyPath()): ConditionSweepPolicy {
  return parseConditionSweepPolicy(readFileSync(path, 'utf8'));
}

export type SweepOutcome =
  | 'fired' | 'expired' | 'pending' | 'closed' | 'cancelled'
  | 'stale-satisfied' | 'stale-cancelled' | 'watched-elsewhere' | 'deferred'
  | 'would-fire' | 'would-expire' | 'would-retire' | 'unmeasured';

export interface SweepRow { seat: string; wakerId: string; condition: string; outcome: SweepOutcome; evidence?: string }

export interface SweepReport {
  at: string;
  dryRun: boolean;
  armed: number;
  wakes: number;
  counts: Partial<Record<SweepOutcome, number>>;
  rows: SweepRow[];
  line: string;
}

export interface SweepOptions {
  /** Only this seat (default: every seat with a waker file). */
  seat?: string;
  /** Judge only — no ledger write, no wake (the trigger's shadow stage). */
  dryRun?: boolean;
  staleMs?: number;
  maxWakes?: number;
  maxProbes?: number;
}

function seatsUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(n => n.endsWith('.json')).map(n => n.slice(0, -'.json'.length)).sort();
}

function alive(pid: number | undefined, deps: SelfTimerDeps): boolean {
  if (pid === undefined) return false;
  if (deps.pid !== undefined && pid === deps.pid) return false;
  const probe = deps.isPidAlive ?? ((p: number) => { try { process.kill(p, 0); return true; } catch { return false; } });
  return probe(pid);
}

const WAKE_OUTCOMES: ReadonlySet<SweepOutcome> = new Set(['fired', 'expired']);

/** One sweep over every armed waker. Never throws for one bad waker (its row reads `unmeasured`). */
export async function sweepConditions(opts: SweepOptions = {}, deps: SelfTimerDeps = {}): Promise<SweepReport> {
  const root = deps.root ?? defaultWakersRoot();
  const now = (deps.now ?? (() => new Date()))();
  const policy = opts.staleMs !== undefined && opts.maxWakes !== undefined && opts.maxProbes !== undefined ? null : loadConditionSweepPolicy();
  const staleMs = opts.staleMs ?? policy!.staleMs;
  const maxWakes = opts.maxWakes ?? policy!.maxWakes;
  const maxProbes = opts.maxProbes ?? policy!.maxProbes;
  const seats = opts.seat !== undefined ? [opts.seat.trim().toUpperCase()] : seatsUnder(root);
  const armed: WakerRecord[] = [];
  for (const seat of seats) {
    try { armed.push(...listWakers(seat, { ...deps, root }).filter(w => w.status === 'armed')); } catch { /* a half-written file reads next tick */ }
  }
  // Oldest horizon first — the longest-waiting owner hears first when the wake cap bites.
  armed.sort((a, b) => Date.parse(a.deadlineAt) - Date.parse(b.deadlineAt) || a.id.localeCompare(b.id));
  const rows: SweepRow[] = [];
  let wakes = 0; let probes = 0;
  for (const w of armed) {
    const row = (outcome: SweepOutcome, evidence?: string) => rows.push({ seat: w.seat, wakerId: w.id, condition: w.condition, outcome, ...(evidence ? { evidence } : {}) });
    const overdue = now.getTime() - Date.parse(w.deadlineAt);
    try {
      if (overdue > staleMs) {
        if (opts.dryRun) { row('would-retire'); continue; }
        const r = await retireStaleWaker(w.seat, w.id, { ...deps, root });
        row(r.outcome, r.waker.evidence);
        continue;
      }
      if (alive(w.watcherPid, deps)) { row('watched-elsewhere'); continue; }
      if (opts.dryRun) {
        if (parseWaitCondition(w.condition).kind === 'time') { row(now.getTime() >= Date.parse(w.fireAt ?? w.deadlineAt) ? 'would-fire' : 'pending'); continue; }
        if (probes >= maxProbes) { row('deferred'); continue; }
        probes++;
        const m = await measurePredicate(w.condition, { seat: w.seat, sinceIso: w.armedAt }, { ...deps, root });
        if (m.kind === 'met') row('would-fire', m.evidence);
        else if (overdue >= 0) row('would-expire');
        else row(m.kind === 'missing' ? 'unmeasured' : 'pending');
        continue;
      }
      if (wakes >= maxWakes) { row('deferred'); continue; }
      const tick = await evaluateWaker(w.seat, w.id, { ...deps, root });
      row(tick.outcome, tick.waker.evidence);
      if (WAKE_OUTCOMES.has(tick.outcome)) wakes++;
    } catch { row('unmeasured'); }
  }
  const counts: Partial<Record<SweepOutcome, number>> = {};
  for (const r of rows) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  const report: SweepReport = { at: now.toISOString(), dryRun: opts.dryRun === true, armed: armed.length, wakes, counts, rows, line: '' };
  report.line = sweepLine(report);
  try { (deps.emit ?? defaultEmit)('commitment', 'commitment.watch.sweep', { dryRun: report.dryRun, armed: report.armed, wakes, ...counts }); } catch { /* observation is fail-open */ }
  return report;
}

function defaultEmit(category: string, event: string, data: Record<string, unknown>): void { debug.log(category, event, data); }

/** One line for the board / the trigger receipt. */
export function sweepLine(r: Pick<SweepReport, 'dryRun' | 'armed' | 'wakes' | 'counts'>): string {
  const c = (k: SweepOutcome) => r.counts[k] ?? 0;
  if (r.dryRun) {
    return `👁 cond-watch sweep (shadow) · armed ${r.armed} · would fire ${c('would-fire')} · would expire ${c('would-expire')} · would retire stale ${c('would-retire')}`
      + ` · pending ${c('pending')} · watched elsewhere ${c('watched-elsewhere')} · deferred ${c('deferred')}`;
  }
  return `👁 cond-watch sweep · armed ${r.armed} · wakes ${r.wakes} (fired ${c('fired')} · expired ${c('expired')}) · stale retired ${c('stale-cancelled') + c('stale-satisfied')}`
    + ` (satisfied ${c('stale-satisfied')}) · pending ${c('pending')} · watched elsewhere ${c('watched-elsewhere')} · deferred ${c('deferred')}`;
}

/** The last sweep as a file (the trigger graph's goal reads its mtime). Atomic rename. */
export function writeSweepReport(path: string, report: SweepReport): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  // Rows beyond 200 are counted, not listed (1,449 stale rows on the first live tick).
  writeFileSync(tmp, `${JSON.stringify({ ...report, rows: report.rows.slice(0, 200), rowsOmitted: Math.max(0, report.rows.length - 200) }, null, 2)}\n`);
  renameSync(tmp, path);
}

// ── 열린 조건 표 (`eln commitment watches`) ──────────────────────────────────────────────

export interface OpenConditionRow {
  seat: string;
  wakerId: string;
  commitmentId: string;
  condition: string;
  awaits: string;
  autoClose: boolean;
  armedAt: string;
  deadlineAt: string;
  /** Minutes past the horizon (negative = minutes left). */
  overdueMin: number;
  state: 'open' | 'overdue' | 'stale';
  watched: boolean;
}

/** Armed wakers as condition rows, oldest horizon first. `stale` rows are what the next live sweep retires silently. */
export function listOpenConditions(opts: { seat?: string; staleMs?: number } = {}, deps: SelfTimerDeps = {}): OpenConditionRow[] {
  const root = deps.root ?? defaultWakersRoot();
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const staleMs = opts.staleMs ?? loadConditionSweepPolicy().staleMs;
  const seats = opts.seat !== undefined ? [opts.seat.trim().toUpperCase()] : seatsUnder(root);
  const rows: OpenConditionRow[] = [];
  for (const seat of seats) {
    let wakers: WakerRecord[] = [];
    try { wakers = listWakers(seat, { ...deps, root }); } catch { continue; }
    for (const w of wakers) {
      if (w.status !== 'armed') continue;
      let awaits = w.condition;
      try { awaits = describeWatch(parseWaitCondition(w.condition)); } catch { /* keep the raw condition */ }
      const overdueMs = nowMs - Date.parse(w.deadlineAt);
      rows.push({
        seat: w.seat, wakerId: w.id, commitmentId: w.commitmentId, condition: w.condition, awaits,
        autoClose: w.autoClose === true, armedAt: w.armedAt, deadlineAt: w.deadlineAt,
        overdueMin: Math.round(overdueMs / 60_000),
        state: overdueMs > staleMs ? 'stale' : overdueMs >= 0 ? 'overdue' : 'open',
        watched: alive(w.watcherPid, deps),
      });
    }
  }
  return rows.sort((a, b) => Date.parse(a.deadlineAt) - Date.parse(b.deadlineAt) || a.wakerId.localeCompare(b.wakerId));
}
