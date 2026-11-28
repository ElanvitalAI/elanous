// kit/canary — measure a build swap and decide «keep · roll back · hand over» (RAIL-CANARY-AUTO-ROLLBACK · 0.3.40 P0 ·
// 대표 11-29 02:3x «등록이 아니라 당장 바로 시작»).
//
// S: on 11-28 night three regressions reached operations through the 2-hourly rail (installed build swap) and each stopped
//    work 1–4 h — #40735 made every hand pane seat=null (fed snapshot hands 0 → wakeups/assign stopped → landings 0/h),
//    the GH mirror insteadOf turned `git remote get-url origin` into a local path (claim refused), a seat's GitHub budget hit
//    300/300. Nothing measured the swap; rail-watch (src/land-graph/rail-watch.ts) smokes four CLI exits and cards a revert
//    PR, but the broken build stays installed until a person acts.
// C: the facts already exist (install.json commit · previous · installedAt · `els ls` panes · land-steward last tick · the
//    gh-governor ledger · the fed snapshot) and the rollback door exists (`eln self-update --rollback`: current ↔ previous).
//    The numbers and the probe list belong in YAML; a new supervisor is a plugin (no per-agent TS).
// Q: what is the smallest shared piece that any canary instance can run from its agent.yaml policies ⊕ its probe pack?
// A: this kit — pure: the probe pack schema (`parseCanaryPack`) · value extraction (`extractValue`) · one probe judgment vs
//    the previous build (`judgeReading`) · the swap state machine (`noteBuild` · `decide` · `noteRollback` · `kpiOf`) · the
//    card text (`rollbackCard` · `handoverCard`). No clock, no mail, no CLI. The executor kind `canary.check`
//    (src/loop-agent/v3/canary-kind.ts) wires it to the runtime and the doors.
//
// 세 얼굴: 관측 = the readings per probe per build in <home>/canary.json (a probe that cannot be read is «모름», never a
//          fail unless the pack says error_is_fail) / 판단 근거 = regression = failed now (confirm_reads reads) AND passed on
//          the previous build, inside watch_window_min after the swap · a probe with no previous reading cannot regress /
//          수복과 인계 = roll back once per build sha (the existing door) ⊕ restart doors ⊕ one card naming prev..new
//          suspects · the second regression of the same sha, a previous build the canary never saw healthy, and a rollback
//          that did not fix the probe (false rollback) are cards to the L0, never a second automatic move.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export { CANARY_POLICY_NAMES } from './policy-names.js';

const MIN = 60_000; // 출처: one minute in ms (unit, not a bound)

// ── policy (every number from the agent.yaml policies: block) ───────────────────────────────────────────────────────
export interface CanaryPolicy {
  readonly windowMin: number; readonly confirmReads: number; readonly confirmGapSec: number; readonly rollbacksPerShaMax: number;
  readonly verifyMin: number; readonly stepTimeoutSec: number; readonly suspectsMax: number; readonly falseRollbackWindowH: number;
}
/** `pn` = the runtime's policy reader (throws on a missing name — no default here). */
export function canaryPolicy(pn: (name: string) => number): CanaryPolicy {
  return {
    windowMin: pn('watch_window_min'), confirmReads: Math.max(1, Math.round(pn('confirm_reads'))), confirmGapSec: pn('confirm_gap_sec'),
    rollbacksPerShaMax: pn('rollbacks_per_sha_max'), verifyMin: pn('verify_min'), stepTimeoutSec: pn('step_timeout_sec'),
    suspectsMax: pn('suspects_max'), falseRollbackWindowH: pn('false_rollback_window_h'),
  };
}

// ── the probe pack (graphs/policies/<pack>.yaml) ────────────────────────────────────────────────────────────────────
export interface ProbeExtract {
  /** Dotted path: a number, or an array (its length · with `countPresent` the rows whose field is a non-empty value). */
  readonly path: string | null;
  readonly countPresent: string | null;
  /** Sum of these dotted paths (null when one is not a number). */
  readonly sum: readonly string[] | null;
  /** Minutes since this field (ISO time or epoch ms). */
  readonly ageOf: string | null;
}
export type ReadSpec =
  | { readonly kind: 'cmd'; readonly argv: readonly string[]; readonly timeoutSec: number; readonly json: ProbeExtract | null }
  | { readonly kind: 'file'; readonly path: string; readonly json: ProbeExtract; readonly maxAgeMin: number | null }
  | { readonly kind: 'sensor'; readonly sensor: string; readonly args: Readonly<Record<string, string>> };
export interface FailIf { readonly dropPctOver?: number; readonly over?: number; readonly under?: number; readonly notMatch?: string }
export interface ProbeSpec { readonly id: string; readonly what: string; readonly read: ReadSpec; readonly failIf: FailIf; readonly errorIsFail: boolean }
export interface DoorStep { readonly id: string; readonly argv: readonly string[]; readonly optional: boolean }
export interface CanaryPack {
  readonly build: { readonly file: string; readonly shaPath: string; readonly previousPath: string; readonly installedAtPath: string };
  readonly probes: readonly ProbeSpec[];
  readonly rollback: readonly string[];
  readonly restart: readonly DoorStep[];
  /** The undo of a rollback (re-install the new build) — a person / the L0 runs it, never the canary. */
  readonly undo: readonly string[];
  readonly suspectsRepo: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const argvOf = (v: unknown): string[] | null => (Array.isArray(v) && v.length && v.every(x => typeof x === 'string' && x.length) ? v as string[] : null);
const numOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const ID_RE = /^[a-z][a-z0-9-]{0,62}$/u;
export const SENSORS: readonly string[] = ['gh-graphql-used-pct'];

function extractOf(v: unknown, at: string, errors: string[]): ProbeExtract | null {
  if (v === undefined) return null;
  const e = isObj(v) ? v : (errors.push(`${at} must be a map {path · count_present · sum · age_of}`), {});
  const sum = e.sum === undefined ? null : Array.isArray(e.sum) && e.sum.every(x => typeof x === 'string') ? e.sum as string[] : (errors.push(`${at}.sum must be a list of paths`), null);
  const ex: ProbeExtract = { path: str(e.path) || null, countPresent: str(e.count_present) || null, sum, ageOf: str(e.age_of) || null };
  if (!ex.path && !ex.sum && !ex.ageOf) errors.push(`${at} needs path, sum or age_of`);
  return ex;
}

/** Parse + validate a probe pack. Never throws; `pack` is null when there is any error. */
export function parseCanaryPack(text: string): { pack: CanaryPack | null; errors: string[] } {
  const errors: string[] = [];
  let j: Record<string, unknown>;
  try { const v = parse(text) as unknown; j = isObj(v) ? v : {}; } catch (e) { return { pack: null, errors: [`bad yaml — ${e instanceof Error ? e.message : String(e)}`] }; }
  if (j.schema !== 1) errors.push('schema must be 1');
  const b = isObj(j.build) ? j.build : {};
  const build = { file: str(b.file), shaPath: str(b.sha_path) || 'commit', previousPath: str(b.previous_path) || 'previous', installedAtPath: str(b.installed_at_path) || 'installedAt' };
  if (!build.file) errors.push('build.file is required (the installed build identity — install.json)');
  const probes: ProbeSpec[] = [];
  (Array.isArray(j.probes) ? j.probes : []).forEach((raw, i) => {
    const p = isObj(raw) ? raw : {}; const at = `probes[${i}]`;
    const id = str(p.id);
    if (!ID_RE.test(id)) { errors.push(`${at}.id must match ${ID_RE}`); return; }
    if (probes.some(x => x.id === id)) errors.push(`${at}: duplicate probe ${id}`);
    const r = isObj(p.read) ? p.read : {};
    let read: ReadSpec | null = null;
    if (r.cmd !== undefined) {
      const argv = argvOf(r.cmd);
      if (!argv) errors.push(`${at}.read.cmd must be a non-empty argv list (no shell)`);
      const t = numOf(r.timeout_sec);
      if (t === undefined || t <= 0) errors.push(`${at}.read.timeout_sec is required (a hung probe must end)`);
      read = { kind: 'cmd', argv: argv ?? [], timeoutSec: t ?? 0, json: extractOf(r.json, `${at}.read.json`, errors) };
    } else if (r.file !== undefined) {
      const path = str(r.file); const json = extractOf(r.json, `${at}.read.json`, errors);
      if (!path) errors.push(`${at}.read.file must be a path template`);
      if (!json) errors.push(`${at}.read.json is required for a file probe`);
      read = { kind: 'file', path, json: json ?? { path: null, countPresent: null, sum: null, ageOf: null }, maxAgeMin: numOf(r.max_age_min) ?? null };
    } else if (r.sensor !== undefined) {
      const sensor = str(r.sensor);
      if (!SENSORS.includes(sensor)) errors.push(`${at}.read.sensor ${sensor || '—'} is not one of ${SENSORS.join(', ')}`);
      const args: Record<string, string> = {};
      for (const [k, v] of Object.entries(r)) if (k !== 'sensor' && typeof v === 'string') args[k] = v;
      read = { kind: 'sensor', sensor, args };
    } else errors.push(`${at}.read needs cmd, file or sensor`);
    const f = isObj(p.fail_if) ? p.fail_if : {};
    const failIf: FailIf = { ...(numOf(f.drop_pct_over) !== undefined ? { dropPctOver: numOf(f.drop_pct_over) } : {}), ...(numOf(f.over) !== undefined ? { over: numOf(f.over) } : {}),
      ...(numOf(f.under) !== undefined ? { under: numOf(f.under) } : {}), ...(str(f.not_match) ? { notMatch: str(f.not_match) } : {}) };
    if (!Object.keys(failIf).length) errors.push(`${at}.fail_if needs drop_pct_over, over, under or not_match`);
    if (failIf.notMatch) { try { new RegExp(failIf.notMatch, 'u'); } catch { errors.push(`${at}.fail_if.not_match is not a regex`); } }
    if (failIf.notMatch && read?.kind === 'cmd' && read.json) errors.push(`${at}: not_match reads the command text — drop read.json`);
    if (read) probes.push({ id, what: str(p.what) || id, read, failIf, errorIsFail: p.error_is_fail === true });
  });
  if (!probes.length) errors.push('probes needs at least one probe');
  const rb = isObj(j.rollback) ? j.rollback : {};
  const rollback = argvOf(rb.cmd); const undo = argvOf(rb.undo);
  if (!rollback) errors.push('rollback.cmd must be the existing rollback door as an argv list');
  if (!undo) errors.push('rollback.undo must be the argv that re-installs the new build (every executed act is reversible)');
  const restart: DoorStep[] = [];
  (Array.isArray(rb.restart) ? rb.restart : []).forEach((raw, i) => {
    const s = isObj(raw) ? raw : {}; const argv = argvOf(s.cmd); const id = str(s.id);
    if (!ID_RE.test(id) || !argv) { errors.push(`rollback.restart[${i}] needs id and cmd`); return; }
    restart.push({ id, argv, optional: s.optional === true });
  });
  const sus = isObj(j.suspects) ? j.suspects : {};
  const suspectsRepo = str(sus.repo);
  if (!suspectsRepo) errors.push('suspects.repo is required (git log prev..new --first-parent runs there)');
  return errors.length ? { pack: null, errors } : { pack: { build, probes, rollback: rollback!, restart, undo: undo!, suspectsRepo }, errors };
}

// ── values ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function at(obj: unknown, path: string): unknown {
  let v: unknown = obj;
  for (const k of path.split('.')) { if (!isObj(v)) return undefined; v = v[k]; }
  return v;
}
const present = (v: unknown): boolean => v !== null && v !== undefined && v !== '';

/** The number a probe reads from a JSON value · null = 모름 (missing path · not a number). */
export function extractValue(obj: unknown, ex: ProbeExtract, nowMs: number): number | null {
  if (ex.ageOf) {
    const v = at(obj, ex.ageOf);
    const ms = typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' ? Date.parse(v) : NaN;
    return Number.isFinite(ms) ? Math.max(0, Math.round((nowMs - ms) / MIN)) : null;
  }
  if (ex.sum) {
    let s = 0;
    for (const p of ex.sum) { const v = at(obj, p); if (typeof v !== 'number' || !Number.isFinite(v)) return null; s += v; }
    return s;
  }
  const v = ex.path ? at(obj, ex.path) : obj;
  if (Array.isArray(v)) return ex.countPresent ? v.filter(r => isObj(r) && present(r[ex.countPresent!])).length : v.length;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ── one probe judgment ──────────────────────────────────────────────────────────────────────────────────────────────
/** ok null = 모름 (could not be read · stale source) — never counted as a fail unless error_is_fail. */
export interface Reading { readonly ok: boolean | null; readonly value: number | null; readonly detail: string; readonly at: string }
export interface RawRead { readonly value: number | null; readonly text?: string; readonly error?: string; readonly stale?: boolean }

/** Judge one read of `probe` against the reading of the previous build (`base`, undefined = never read there). */
export function judgeReading(probe: ProbeSpec, raw: RawRead, base: Reading | undefined, atIso: string): Reading {
  const f = probe.failIf;
  if (raw.error) return { ok: probe.errorIsFail ? false : null, value: null, detail: raw.error.slice(0, 200), at: atIso };
  if (raw.stale) return { ok: null, value: raw.value, detail: 'source stale', at: atIso };
  if (f.notMatch !== undefined) {
    const text = (raw.text ?? '').trim();
    const ok = new RegExp(f.notMatch, 'u').test(text);
    return { ok, value: ok ? 1 : 0, detail: `«${text.slice(0, 80)}»${ok ? '' : ` ≠ /${f.notMatch}/`}`, at: atIso };
  }
  const v = raw.value;
  if (v === null) return { ok: null, value: null, detail: 'no value', at: atIso };
  if (f.over !== undefined && v > f.over) return { ok: false, value: v, detail: `${v} > ${f.over}`, at: atIso };
  if (f.under !== undefined && v < f.under) return { ok: false, value: v, detail: `${v} < ${f.under}`, at: atIso };
  if (f.dropPctOver !== undefined && base?.value !== null && base?.value !== undefined && base.value > 0) {
    const drop = Math.round(((base.value - v) / base.value) * 100);
    if (drop > f.dropPctOver) return { ok: false, value: v, detail: `${base.value}→${v} (−${drop}% > ${f.dropPctOver}%)`, at: atIso };
    return { ok: true, value: v, detail: `${base.value}→${v}`, at: atIso };
  }
  return { ok: true, value: v, detail: String(v), at: atIso };
}

/** A regression = failed now AND observed passing on the previous build (a probe the previous build never passed cannot regress). */
export const isRegression = (now: Reading, base: Reading | undefined): boolean => now.ok === false && base?.ok === true;

// ── state (one file in the agent home) ──────────────────────────────────────────────────────────────────────────────
export interface RollbackRow {
  readonly from: string; readonly to: string; readonly at: string; readonly failSince: string; readonly probes: readonly string[];
  readonly minutes: number; readonly verdict: 'pending' | 'fixed' | 'false' | 'unmeasured'; readonly verdictAt?: string;
}
export interface CanaryState {
  readonly v: 1;
  /** Installed build (sha12) at the last tick · its predecessor · when it was installed · how it got there. */
  sha: string | null; prevSha: string | null; swapAt: string | null; origin: 'first' | 'swap' | 'rollback';
  /** The last reading per probe per build (sha12 → probe → reading) — the previous build's row is the baseline. */
  readings: Record<string, Record<string, Reading>>;
  /** First tick a confirmed regression was seen on `sha` (open episode) · the probes. */
  failSince: string | null; regressed: string[];
  rollbacks: RollbackRow[];
  /** Hand-over cards already decided (kind:sha12) — one per episode. */
  carded: string[];
  lastFailToRollbackMin: number | null;
}
export const emptyCanaryState = (): CanaryState => ({ v: 1, sha: null, prevSha: null, swapAt: null, origin: 'first', readings: {}, failSince: null, regressed: [], rollbacks: [], carded: [], lastFailToRollbackMin: null });
export const CANARY_FILE = 'canary.json';
const KEEP_BUILDS = 6; // 출처: three rails of history each side of a rollback (2-hourly rail ⇒ half a day)
const KEEP_ROWS = 20; // 출처: rollbacks / cards kept for the KPI window (a week of incidents at the 11-28 rate ≈ 3/night)

export function readCanaryState(home: string): CanaryState {
  try {
    const j = JSON.parse(readFileSync(join(home, CANARY_FILE), 'utf8')) as Partial<CanaryState>;
    const e = emptyCanaryState();
    return { ...e, ...j, v: 1, readings: isObj(j.readings) ? j.readings as CanaryState['readings'] : {}, regressed: Array.isArray(j.regressed) ? j.regressed : [],
      rollbacks: Array.isArray(j.rollbacks) ? j.rollbacks : [], carded: Array.isArray(j.carded) ? j.carded : [] };
  } catch { return emptyCanaryState(); }
}
export function writeCanaryState(home: string, s: CanaryState, kpi?: Readonly<Record<string, number | null>>): void {
  mkdirSync(home, { recursive: true });
  const keep = new Set([s.sha, s.prevSha, ...Object.keys(s.readings).slice(-KEEP_BUILDS)].filter((x): x is string => !!x));
  const readings = Object.fromEntries(Object.entries(s.readings).filter(([k]) => keep.has(k)));
  const p = join(home, CANARY_FILE); const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...s, readings, rollbacks: s.rollbacks.slice(-KEEP_ROWS), carded: s.carded.slice(-KEEP_ROWS), ...(kpi ? { kpi } : {}) }, null, 2));
  renameSync(tmp, p); // atomic: a crash mid-write never reads back as «no baseline»
}
export const canaryStatePresent = (home: string): boolean => existsSync(join(home, CANARY_FILE));

// ── the installed build ─────────────────────────────────────────────────────────────────────────────────────────────
export interface BuildInfo { readonly sha: string; readonly previousSha: string | null; readonly previousDir: string | null; readonly installedAt: string | null }
export const sha12 = (s: string): string => s.trim().toLowerCase().slice(0, 12);
/** «versions/<판>-<sha12>» · «versions/<판>-dev.<sha12>» → sha12 (the rollback target's identity). */
export function versionDirSha(dir: string | null): string | null {
  const m = /-(?:dev\.)?([0-9a-f]{12})(?:-dirty)?$/u.exec((dir ?? '').trim());
  return m ? m[1]! : null;
}
/** install.json (any record shape) → the build identity · null = unreadable / no commit. */
export function buildOf(record: unknown, pack: CanaryPack['build']): BuildInfo | null {
  const c = at(record, pack.shaPath);
  if (typeof c !== 'string' || !/^[0-9a-f]{7,40}$/iu.test(c.trim())) return null;
  const prev = at(record, pack.previousPath); const ia = at(record, pack.installedAtPath);
  const previousDir = typeof prev === 'string' && prev.trim() ? prev.trim() : null;
  return { sha: sha12(c), previousDir, previousSha: versionDirSha(previousDir), installedAt: typeof ia === 'string' && Number.isFinite(Date.parse(ia)) ? ia : null };
}

/** Fold the installed build into the state: a new sha is a swap (or the canary's own rollback landing). Mutates `s`. */
export function noteBuild(s: CanaryState, b: BuildInfo, now: Date): 'first' | 'same' | 'swap' {
  if (s.sha === b.sha) return 'same';
  if (s.sha === null) { s.sha = b.sha; s.prevSha = b.previousSha; s.swapAt = now.toISOString(); s.origin = 'first'; s.failSince = null; s.regressed = []; return 'first'; }
  // installedAt bounds the window when it is believable (not in the future, not older than the last build we saw)
  const ia = b.installedAt ? Date.parse(b.installedAt) : NaN;
  s.prevSha = s.sha; s.sha = b.sha; s.origin = 'swap'; s.failSince = null; s.regressed = [];
  s.swapAt = Number.isFinite(ia) && ia <= now.getTime() ? new Date(ia).toISOString() : now.toISOString();
  return 'swap';
}

export const inWindow = (s: CanaryState, p: CanaryPolicy, now: Date): boolean =>
  s.origin === 'swap' && !!s.prevSha && !!s.swapAt && now.getTime() - Date.parse(s.swapAt) <= p.windowMin * MIN;

export type Decision =
  | { readonly kind: 'none'; readonly why: string }
  | { readonly kind: 'rollback'; readonly from: string; readonly to: string; readonly probes: readonly string[] }
  | { readonly kind: 'limit' | 'no-target'; readonly sha: string; readonly probes: readonly string[]; readonly why: string }
  | { readonly kind: 'false-rollback'; readonly row: RollbackRow; readonly probes: readonly string[] };

/** One tick's decision from the confirmed regressions on the installed build. Mutates `s` (episode · verdicts). */
export function decide(s: CanaryState, b: BuildInfo, regressed: readonly string[], readingsNow: Readonly<Record<string, Reading>>, p: CanaryPolicy, now: Date): Decision {
  const nowIso = now.toISOString();
  // a rollback this canary made: did the build it rolled back to bring the failed probes back?
  const last = s.rollbacks[s.rollbacks.length - 1];
  if (s.origin === 'rollback' && last && last.verdict === 'pending' && last.to === s.sha) {
    const still = last.probes.filter(id => readingsNow[id]?.ok === false);
    const allOk = last.probes.every(id => readingsNow[id]?.ok === true);
    const due = now.getTime() - Date.parse(last.at) >= p.verifyMin * MIN;
    if (allOk) { s.rollbacks[s.rollbacks.length - 1] = { ...last, verdict: 'fixed', verdictAt: nowIso }; return { kind: 'none', why: `rollback verified — ${last.probes.join(', ')} back on ${s.sha}` }; }
    if (due && still.length) { const row = { ...last, verdict: 'false' as const, verdictAt: nowIso }; s.rollbacks[s.rollbacks.length - 1] = row; return { kind: 'false-rollback', row, probes: still }; }
    if (due) { s.rollbacks[s.rollbacks.length - 1] = { ...last, verdict: 'unmeasured', verdictAt: nowIso }; return { kind: 'none', why: 'rollback verify window passed with unreadable probes' }; }
    return { kind: 'none', why: `verifying rollback (${still.length ? `${still.join(', ')} still failing` : 'probes unread'})` };
  }
  if (!inWindow(s, p, now)) { s.failSince = null; s.regressed = []; return { kind: 'none', why: s.origin === 'swap' ? 'outside the watch window — baseline only' : `no swap to watch (${s.origin})` }; }
  if (!regressed.length) { s.failSince = null; s.regressed = []; return { kind: 'none', why: 'no regression' }; }
  s.failSince ??= nowIso; s.regressed = [...regressed];
  const sha = s.sha!;
  if (s.rollbacks.filter(r => r.from === sha).length >= p.rollbacksPerShaMax) return { kind: 'limit', sha, probes: regressed, why: `${sha} was rolled back ${p.rollbacksPerShaMax}× already — not again` };
  if (!b.previousSha || b.previousSha !== s.prevSha) return { kind: 'no-target', sha, probes: regressed, why: `install.json previous (${b.previousDir ?? 'none'}) is not the build watched healthy (${s.prevSha})` };
  return { kind: 'rollback', from: sha, to: s.prevSha!, probes: regressed };
}

/** The rollback landed (install.json names `to`): record it and switch the state to the rolled-back build. Mutates `s`. */
export function noteRollback(s: CanaryState, d: Extract<Decision, { kind: 'rollback' }>, now: Date): RollbackRow {
  const failSince = s.failSince ?? now.toISOString();
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(failSince)) / MIN));
  const row: RollbackRow = { from: d.from, to: d.to, at: now.toISOString(), failSince, probes: [...d.probes], minutes, verdict: 'pending' };
  s.rollbacks.push(row);
  s.sha = d.to; s.prevSha = d.from; s.origin = 'rollback'; s.swapAt = row.at; s.failSince = null; s.regressed = []; s.lastFailToRollbackMin = minutes;
  return row;
}

/** KPIs: canary_fail_to_rollback_minutes = an open confirmed regression's age (0 when none) · false_rollbacks in the window. */
export function kpiOf(s: CanaryState, p: CanaryPolicy, now: Date): { canary_fail_to_rollback_minutes: number; false_rollbacks: number } {
  const open = s.failSince ? Math.max(0, Math.round((now.getTime() - Date.parse(s.failSince)) / MIN)) : 0;
  const from = now.getTime() - p.falseRollbackWindowH * 60 * MIN;
  return { canary_fail_to_rollback_minutes: open, false_rollbacks: s.rollbacks.filter(r => r.verdict === 'false' && Date.parse(r.verdictAt ?? r.at) >= from).length };
}

// ── cards (Korean: operations mail) ─────────────────────────────────────────────────────────────────────────────────
export interface SuspectRow { readonly pr: number; readonly sha: string; readonly title: string }
const suspectLines = (sus: readonly SuspectRow[] | null, prev: string, next: string, max: number): string[] => sus === null
  ? [`  용의자: main 기록을 못 읽었다 — git log --first-parent --oneline ${prev}..${next}`]
  : !sus.length ? ['  용의자: 범위에 squash PR 없음 (호스트·설정 변경?) — 레일 로그 확인']
    : [`  용의자 (${prev}..${next} --first-parent · ${sus.length}개 · 최신 먼저):`, ...sus.slice(0, max).map(x => `    #${x.pr} «${x.title.slice(0, 70)}» ${x.sha.slice(0, 12)}`), ...(sus.length > max ? [`    … 외 ${sus.length - max}`] : [])];

export function rollbackCard(i: { name: string; row: RollbackRow; swapAt: string | null; failed: ReadonlyArray<{ id: string; base: Reading | undefined; now: Reading | undefined }>;
  restarts: readonly string[]; suspects: readonly SuspectRow[] | null; suspectsMax: number; undo: string; holdHint: string }): string {
  const sinceSwap = i.swapAt ? Math.round((Date.parse(i.row.at) - Date.parse(i.swapAt)) / MIN) : null;
  return [
    `[${i.name} → OP · 자동 되돌림] 설치 빌드 ${i.row.from} → ${i.row.to} 로 되돌렸다${sinceSwap !== null ? ` (교체 후 ${sinceSwap}분` : ' ('}· 실패 확인 후 ${i.row.minutes}분).`,
    ...i.failed.map(f => `  ✗ ${f.id}: 이전 빌드 ${f.base?.detail ?? '?'} → 지금 ${f.now?.detail ?? '?'}`),
    `  재기동: ${i.restarts.join(' · ') || '없음'}`,
    ...suspectLines(i.suspects, i.row.to, i.row.from, i.suspectsMax),
    `  취소(새 빌드 다시 설치): ${i.undo} · 같은 빌드는 다시 자동으로 되돌리지 않는다 — main 을 고친(revert PR) 뒤 다음 레일 · 자동 되돌림 멈춤: ${i.holdHint}`,
  ].join('\n');
}

export function handoverCard(i: { name: string; d: Exclude<Decision, { kind: 'none' } | { kind: 'rollback' }>; readings: Readonly<Record<string, Reading>>; undo: string; suspects: readonly SuspectRow[] | null; prev: string | null; suspectsMax: number }): string {
  const probeLine = (ids: readonly string[]) => ids.map(id => `${id} ${i.readings[id]?.detail ?? '?'}`).join(' · ');
  if (i.d.kind === 'false-rollback') {
    const r = i.d.row;
    return [`[${i.name} → OP · 되돌림 효과 없음] ${r.from} → ${r.to} 되돌림 뒤에도 ${i.d.probes.join(', ')} 가 실패한다 — 빌드가 원인이 아니었다(거짓 되돌림).`,
      `  지금: ${probeLine(i.d.probes)}`, `  새 빌드로 돌아가려면: ${i.undo} · 원인은 호스트·설정·바깥(GitHub·els 서버) 쪽을 본다`].join('\n');
  }
  const head = i.d.kind === 'limit'
    ? `[${i.name} → OP · 되돌림 안 함 · 한도] 빌드 ${i.d.sha} 가 또 회귀했다 — 이 빌드는 이미 한 번 되돌렸다(빌드당 1회).`
    : `[${i.name} → OP · 되돌림 안 함 · 대상 불명] 빌드 ${i.d.sha} 회귀 — ${i.d.why}.`;
  return [head, `  실패: ${probeLine(i.d.probes)}`, ...(i.prev ? suspectLines(i.suspects, i.prev, i.d.sha, i.suspectsMax) : []),
    `  판단: main 을 고치거나(revert PR) 레일 HOLD · 손으로 되돌리기: eln self-update --rollback`].join('\n');
}

/** «{a} {b}» templates of the pack: {stateRoot} {installRoot} {hqRepo} {uid} {date} (UTC yyyymmdd) · argv item `{eln}` = this build's CLI. */
export interface TemplateVars { readonly stateRoot: string; readonly installRoot: string; readonly hqRepo: string; readonly uid: string; readonly eln: readonly string[] }
export function expand(t: string, v: TemplateVars, now: Date): string {
  return t.replaceAll('{stateRoot}', v.stateRoot).replaceAll('{installRoot}', v.installRoot).replaceAll('{hqRepo}', v.hqRepo).replaceAll('{uid}', v.uid)
    .replaceAll('{date}', now.toISOString().slice(0, 10).replace(/-/gu, ''));
}
export const expandArgv = (argv: readonly string[], v: TemplateVars, now: Date): string[] => argv.flatMap(a => (a === '{eln}' ? [...v.eln] : [expand(a, v, now)]));
