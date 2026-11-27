// kit/kpi — one KPI helper (PLATFORM-KITS-DUPLICATION-MAP-1127 §1-13 · 대표 11-27 11:5x «중복된 내용들 정리»).
//
// S: four loop agents (loop-agent v2 · judge-butler · land-steward · throughput-controller · guardian) each counted
//    «last hour», took medians, judged targets and debounced breach lines on their own. Copies drifted: two windows counted
//    rows dated AFTER now (clock-skewed or future-stamped rows inflated «lands/h»), one judged a rounded value.
// C: a KPI must be judged on its raw value, counted by the event's own time, rounded only for a person, and a breach must
//    speak once when it starts, stay quiet while it lasts (re-alert only after N minutes), and be forgotten on recovery.
// Q: what is the smallest shared piece every agent can call without changing its own card format?
// A: this pure module (no I/O, no clock — `now` is always passed in). The loop-agent runtime semantics are the kept ones.
//
// 세 얼굴: 관측 = callers' own report rows (kpiLine · breach events) — this module has no side effects /
//          판단 근거 = `kpiOk` (raw value vs target) ⊕ `inWindow` (0 ≤ age ≤ window by event time) ⊕ `breachStep` /
//          수복과 인계 = the old copies were deleted in the same PR; a new copy is a review finding.

export type KpiDir = 'at_most' | 'at_least';
export interface KpiTarget { readonly target: number; readonly dir: KpiDir }

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

// ── judgment (raw) ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Raw-value judgment: `null` = unknown (no reading / NaN). Never pass a display-rounded value here. */
export function kpiOk(t: KpiTarget, value: number | null | undefined): boolean | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return t.dir === 'at_most' ? value <= t.target : value >= t.target;
}

/** `kpiOk` inverted for «is this a breach?» call sites: unknown stays unknown. */
export function kpiBreached(t: KpiTarget, value: number | null | undefined): boolean | null {
  const ok = kpiOk(t, value);
  return ok === null ? null : !ok;
}

/** Comparator glyph for a target line: `≤` / `≥`. */
export const dirGlyph = (dir: KpiDir): string => (dir === 'at_most' ? '≤' : '≥');

/** One status mark for tables: ✓ ok · ✘ miss · · unknown. */
export const okMark = (ok: boolean | null | undefined): string => (ok === false ? '✘' : ok ? '✓' : '·');

// ── display (rounded) ────────────────────────────────────────────────────────────────────────────────────────────────

/** Display rounding only (half away from zero like Math.round for positives); `null` passes through. */
export function displayRound(value: number | null | undefined, digits = 0): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = 10 ** Math.max(0, Math.floor(digits));
  return Math.round(value * f) / f;
}

/** Ratio 0..1 → «42%» for a person; `?` when unknown. */
export function pct(ratio: number | null | undefined): string {
  const r = displayRound(ratio === null || ratio === undefined ? null : ratio * 100);
  return r === null ? '?' : `${r}%`;
}

/** Fixed-digit display (e.g. load/ncpu `0.83`); `?` when unknown. */
export function fixed(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '?' : value.toFixed(digits);
}

// ── windows (by event time) ──────────────────────────────────────────────────────────────────────────────────────────

/** Event time in ms; `null` for a missing / unparsable stamp (such a row never counts). */
export function eventMs(at: string | number | null | undefined): number | null {
  if (at === null || at === undefined || at === '') return null;
  const t = typeof at === 'number' ? at : Date.parse(at);
  return Number.isFinite(t) ? t : null;
}

/** An event is in the window when 0 ≤ now − at ≤ window. A row dated after `now` never counts. */
export function inWindow(at: string | number | null | undefined, nowMs: number, windowMs: number): boolean {
  const t = eventMs(at);
  if (t === null) return false;
  const age = nowMs - t;
  return age >= 0 && age <= windowMs;
}

/** Rows whose own event time lies in [now − window, now]. */
export function filterInWindow<T>(rows: readonly T[], at: (row: T) => string | number | null | undefined, nowMs: number, windowMs: number): T[] {
  return rows.filter(r => inWindow(at(r), nowMs, windowMs));
}

export function countInWindow<T>(rows: readonly T[], at: (row: T) => string | number | null | undefined, nowMs: number, windowMs: number): number {
  let n = 0;
  for (const r of rows) if (inWindow(at(r), nowMs, windowMs)) n++;
  return n;
}

/** Event time ≥ `sinceMs` and ≤ now (e.g. «today since local midnight»). */
export function inRange(at: string | number | null | undefined, sinceMs: number, nowMs: number): boolean {
  const t = eventMs(at);
  return t !== null && t >= sinceMs && t <= nowMs;
}

/** Minutes since an event, clamped at 0 (a clock-skewed future start is 0, not negative); `null` when unknown. */
export function ageMin(at: string | number | null | undefined, nowMs: number): number | null {
  const t = eventMs(at);
  return t === null ? null : Math.max(0, (nowMs - t) / MINUTE_MS);
}

/** Median of raw values (even count = mean of the two middles); `null` when empty. */
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// ── breach debounce ──────────────────────────────────────────────────────────────────────────────────────────────────

/** One KPI's breach memory (loop-agent v2 `kpiOk` ⊕ `breachSince`). */
export interface BreachState { readonly ok: boolean | null; readonly since: string | null }
export type BreachEvent = 'new' | 'ongoing' | 'recovered' | null;
export interface BreachStep {
  readonly event: BreachEvent;
  readonly next: BreachState;
  /** Minutes the breach has lasted (0 on `new`, null when not breaching). */
  readonly breachMin: number | null;
}

/**
 * One tick of the breach state machine (kept semantics = loop-agent runtime):
 * - `false` after anything but `false` → `new`, since = at;
 * - `false` after `false` → `ongoing` (since kept; a missing since is repaired to `at`);
 * - `true` after `false` → `recovered`, since cleared;
 * - unknown (`null`) changes nothing — an unreadable KPI is neither a breach nor a recovery.
 */
export function breachStep(prev: BreachState, ok: boolean | null, at: string): BreachStep {
  const nowMs = Date.parse(at);
  if (ok === null) return { event: null, next: prev, breachMin: prev.ok === false && prev.since ? Math.max(0, (nowMs - Date.parse(prev.since)) / MINUTE_MS) : null };
  if (ok === false && prev.ok !== false) return { event: 'new', next: { ok: false, since: at }, breachMin: 0 };
  if (ok === false) {
    const since = prev.since ?? at;
    return { event: 'ongoing', next: { ok: false, since }, breachMin: Math.max(0, (nowMs - Date.parse(since)) / MINUTE_MS) };
  }
  if (prev.ok === false) return { event: 'recovered', next: { ok: true, since: null }, breachMin: null };
  return { event: null, next: { ok: true, since: null }, breachMin: null };
}

/** Per-key last-alert stamps (land-steward `state.breaches`). */
export type AlertStamps = Readonly<Record<string, string>>;

/**
 * Per-key debounce: a breaching key alerts when it has no stamp or its stamp is ≥ `everyMin` old (then re-stamped);
 * a key that is no longer breaching is forgotten, so its next breach alerts at once.
 */
export function debounceKeys(prev: AlertStamps, breaching: readonly string[], now: Date, everyMin: number): { due: string[]; next: Record<string, string> } {
  const nowMs = now.getTime(); const at = now.toISOString(); const every = everyMin * MINUTE_MS;
  const next: Record<string, string> = {}; const due: string[] = [];
  for (const key of new Set(breaching)) {
    const last = prev[key];
    const lastMs = last ? Date.parse(last) : NaN;
    if (last && Number.isFinite(lastMs) && nowMs - lastMs < every) { next[key] = last; continue; }
    due.push(key); next[key] = at;
  }
  return { due, next };
}
