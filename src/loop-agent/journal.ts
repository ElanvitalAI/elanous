// SUPERVISOR-CORRECTION-JOURNAL (0.3.38 P1 · OP · 대표 11-27 12:5x «감독들의 실제 활동 교정내역 일지를 만들게 해 주세요»).
//
// S: a manual tick shows run-supervisor failed end-zombie-pregate ×N · macrophage reaped 1 · silence-watch redelivered 8 —
//    but those lines lived only in one tick report (last-tick.json is overwritten) and mixed into cases.jsonl with every
//    observation, voice turn and level change. Nobody could answer «what did the supervisors actually fix today?».
// C: one row per REAL correction (acted · failed · refused — never a cooldown skip, never a plain observation), append-only,
//    rotated per day, in the agent's own home; nothing written when nothing happened.
// Q: where is the one point every agent passes when a correction is decided, and how does a person read it back?
// A: the loop-agent tick finish step (runtime.ts tickAgent · voice `act`) writes the rows it just acted on; bespoke agents
//    (judge-butler · guardian) journal from their case rows by the kind map in graphs/policies/loop-agent-journal.yaml;
//    land-steward journals its lands. Readers: `eln loop agent journal <id>` · `--all --today` (rollup ⊕ kit/kpi KPI) ·
//    one rollup line per agent per window into OP's 30-min digest and ws:supervisors · the voice answers from it.
//
// 세 얼굴: 관측 = <state>/loop-agents/<id>/journal/<day>.jsonl (schema v1) ⊕ rollup-cursor.json /
//          판단 근거 = the policy YAML (tz · keep_days · window · top · KPI targets · bespoke kind map) /
//          수복과 인계 = each row carries before→after · evidence · undo — the undo line is how a person reverts it.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { kpiOk, pct, type KpiDir } from '../kit/kpi/index.js';
import { appendJsonl, readJsonl } from './memory.js';

export type JournalStatus = 'acted' | 'failed' | 'refused';
export interface JournalRow {
  readonly v: 1;
  readonly at: string;
  readonly agent: string;
  readonly status: JournalStatus;
  /** The correction verb (`reap` · `redeliver` · `end-zombie-pregate` · `sign` …). */
  readonly action: string;
  readonly target: string;
  /** What happened (the body's result line). */
  readonly what: string;
  /** Why it was planned (the body's reason · the voice request). */
  readonly why: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly evidence: readonly string[];
  readonly undo: string | null;
  readonly source: 'tick' | 'voice' | 'case';
  readonly by: string;
}

export interface JournalPolicy {
  readonly tz: string;
  readonly keepDays: number;
  readonly windowMin: number;
  readonly top: number;
  readonly lookbackWindows: number;
  readonly kpi: { readonly correctionsPerDay: { target: number; dir: KpiDir }; readonly failureRate: { target: number; dir: KpiDir } };
  /** bespoke agent → case kind → {status, perRef}. */
  readonly cases: Readonly<Record<string, Readonly<Record<string, { status: JournalStatus; perRef: boolean }>>>>;
  readonly voiceFallback: ReadonlyArray<{ provider: string; tier: string }>;
}

export const JOURNAL_POLICY_DEFAULTS: JournalPolicy = {
  tz: 'Asia/Seoul', keepDays: 30, windowMin: 30, top: 3, lookbackWindows: 2,
  kpi: { correctionsPerDay: { target: 1, dir: 'at_least' }, failureRate: { target: 0.3, dir: 'at_most' } },
  cases: {}, voiceFallback: [],
};

export const journalPolicyPath = (root = resolve(import.meta.dir, '../..')): string => join(root, 'graphs', 'policies', 'loop-agent-journal.yaml');

const num = (v: unknown, d: number, min = 0): number => (typeof v === 'number' && Number.isFinite(v) && v >= min ? v : d);
const target = (v: unknown, d: { target: number; dir: KpiDir }): { target: number; dir: KpiDir } => {
  const o = (v ?? {}) as { at_most?: unknown; at_least?: unknown };
  if (typeof o.at_most === 'number' && Number.isFinite(o.at_most)) return { target: o.at_most, dir: 'at_most' };
  if (typeof o.at_least === 'number' && Number.isFinite(o.at_least)) return { target: o.at_least, dir: 'at_least' };
  return d;
};
const STATUSES: ReadonlySet<string> = new Set(['acted', 'failed', 'refused']);

/** Parse the policy text; every bad value falls back to its default (a broken policy never stops a tick). */
export function parseJournalPolicy(text: string): JournalPolicy {
  let y: Record<string, unknown> = {};
  try { y = (parse(text) ?? {}) as Record<string, unknown>; } catch { return JOURNAL_POLICY_DEFAULTS; }
  const D = JOURNAL_POLICY_DEFAULTS;
  const rot = (y.rotation ?? {}) as Record<string, unknown>; const ru = (y.rollup ?? {}) as Record<string, unknown>; const k = (y.kpi ?? {}) as Record<string, unknown>;
  let tz = typeof rot.tz === 'string' && rot.tz.trim() ? rot.tz.trim() : D.tz;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); } catch { tz = D.tz; }
  const cases: Record<string, Record<string, { status: JournalStatus; perRef: boolean }>> = {};
  for (const [agent, kinds] of Object.entries((y.cases ?? {}) as Record<string, unknown>)) {
    if (!kinds || typeof kinds !== 'object') continue;
    for (const [kind, spec] of Object.entries(kinds as Record<string, unknown>)) {
      const s = (spec ?? {}) as { status?: unknown; per_ref?: unknown };
      if (typeof s.status !== 'string' || !STATUSES.has(s.status)) continue;
      (cases[agent] ??= {})[kind] = { status: s.status as JournalStatus, perRef: s.per_ref === true };
    }
  }
  const fb = Array.isArray((y.voice as { fallback?: unknown } | undefined)?.fallback) ? ((y.voice as { fallback: unknown[] }).fallback) : [];
  return {
    tz, keepDays: num(rot.keep_days, D.keepDays, 1), windowMin: num(ru.window_min, D.windowMin, 1), top: num(ru.top, D.top, 1), lookbackWindows: num(ru.lookback_windows, D.lookbackWindows, 1),
    kpi: { correctionsPerDay: target(k.corrections_per_day, D.kpi.correctionsPerDay), failureRate: target(k.failure_rate, D.kpi.failureRate) },
    cases,
    voiceFallback: fb.flatMap(f => { const o = (f ?? {}) as { provider?: unknown; tier?: unknown }; return typeof o.provider === 'string' && typeof o.tier === 'string' ? [{ provider: o.provider, tier: o.tier }] : []; }),
  };
}

let cached: { path: string; policy: JournalPolicy } | null = null;
/** The policy in force (read once per process per path · missing file = defaults). */
export function readJournalPolicy(path = journalPolicyPath()): JournalPolicy {
  if (cached?.path === path) return cached.policy;
  let policy = JOURNAL_POLICY_DEFAULTS;
  try { if (existsSync(path)) policy = parseJournalPolicy(readFileSync(path, 'utf8')); } catch { /* defaults */ }
  cached = { path, policy };
  return policy;
}

// ── writer ───────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The calendar day of `at` in the policy tz (`YYYY-MM-DD`). */
export function dayKey(at: string | Date, tz: string): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export const journalDir = (home: string): string => join(home, 'journal');
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u;

/** Append rows (one line per correction) to the day file of each row · a new day file prunes days older than keep_days. */
export function appendJournal(home: string, rows: readonly JournalRow[], policy: JournalPolicy = readJournalPolicy()): number {
  if (!rows.length) return 0;
  const dir = journalDir(home);
  mkdirSync(dir, { recursive: true });
  for (const r of rows) {
    const day = dayKey(r.at, policy.tz);
    const file = join(dir, `${day}.jsonl`);
    const fresh = !existsSync(file);
    appendJsonl(file, r);
    if (fresh) pruneDays(dir, day, policy.keepDays);
  }
  return rows.length;
}

function pruneDays(dir: string, today: string, keepDays: number): void {
  const cut = new Date(Date.parse(`${today}T00:00:00Z`) - keepDays * 86_400_000).toISOString().slice(0, 10);
  try { for (const f of readdirSync(dir)) { const m = DAY_FILE.exec(f); if (m && m[1]! < cut) rmSync(join(dir, f), { force: true }); } } catch { /* fail-soft */ }
}

/** Rows in [sinceMs, untilMs] (by the row's own time), oldest first. */
export function readJournal(home: string, sinceMs: number, untilMs: number, policy: JournalPolicy = readJournalPolicy()): JournalRow[] {
  const dir = journalDir(home);
  if (!existsSync(dir)) return [];
  const from = dayKey(new Date(sinceMs - 86_400_000), policy.tz); const to = dayKey(new Date(untilMs + 86_400_000), policy.tz);
  const out: JournalRow[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = DAY_FILE.exec(f);
    if (!m || m[1]! < from || m[1]! > to) continue;
    for (const r of readJsonl<JournalRow>(join(dir, f), 100_000)) { const t = Date.parse(r.at); if (Number.isFinite(t) && t >= sinceMs && t <= untilMs) out.push(r); }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** Start of the policy-tz day that contains `now` (ms). */
export function dayStartMs(now: Date, tz: string): number {
  const day = dayKey(now, tz);
  // the tz offset at `now`: format the same instant in tz and read it back as if UTC
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now);
  const g = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  const offset = asUtc - Math.floor(now.getTime() / 1000) * 1000;
  return Date.parse(`${day}T00:00:00Z`) - offset;
}

/** `--since`: ISO time · `30m` · `2h` · `3d` · `today` → ms. */
export function parseSince(v: string | undefined, now: Date, tz: string): number {
  const s = (v ?? 'today').trim();
  if (s === 'today') return dayStartMs(now, tz);
  const m = /^(\d+)\s*([mhd])$/u.exec(s);
  if (m) return now.getTime() - Number(m[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 } as const)[m[2] as 'm' | 'h' | 'd'];
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new Error(`--since ${s}: ISO time · 30m · 2h · 3d · today`);
  return t;
}

// ── first start: today's cases → journal (once) ──────────────────────────────────────────────────────────────────────
const CASE_STATUS: Readonly<Record<string, JournalStatus>> = { act: 'acted', 'act-failed': 'failed', 'act-refused': 'refused' };
/** The first time an agent journals, today's generic `act*` case rows (written before the journal existed) become journal
 *  rows — so «오늘 뭘 했어» on the day this lands is not «0». Once per home (marker <home>/journal-backfilled.json). */
export function backfillTodayFromCases(home: string, agent: string, now: Date, policy: JournalPolicy = readJournalPolicy()): number {
  const marker = join(home, 'journal-backfilled.json');
  if (existsSync(marker) || existsSync(journalDir(home))) return 0;
  const from = dayStartMs(now, policy.tz);
  const rows: JournalRow[] = [];
  for (const c of readJsonl<CaseLike & { decidedBy?: string }>(join(home, 'cases.jsonl'), 5_000)) {
    const status = CASE_STATUS[c.kind]; const t = Date.parse(c.at);
    if (!status || !Number.isFinite(t) || t < from || t > now.getTime()) continue;
    const i = c.subject.indexOf(':');
    const [what, why] = c.why.includes(' · 이유: ') ? c.why.split(' · 이유: ', 2) as [string, string] : [c.why, ''];
    rows.push({ v: 1, at: c.at, agent, status, action: i > 0 ? c.subject.slice(0, i) : c.subject, target: i > 0 ? c.subject.slice(i + 1) : '', what: what.slice(0, 300), why: why.slice(0, 300),
      before: null, after: status === 'acted' ? what.slice(0, 200) : null, evidence: [`case:${agent}@${c.at}`, ...(c.refs ?? [])].slice(0, 8), undo: typeof c.extra?.undo === 'string' ? c.extra.undo : null, source: 'case', by: c.decidedBy ?? agent.toUpperCase() });
  }
  appendJournal(home, rows, policy);
  try { mkdirSync(home, { recursive: true }); writeFileSync(marker, JSON.stringify({ at: now.toISOString(), rows: rows.length })); } catch { /* next tick retries */ }
  return rows.length;
}

// ── bespoke agents: case rows → journal rows ────────────────────────────────────────────────────────────────────────
export interface CaseLike { readonly at: string; readonly kind: string; readonly subject: string; readonly why: string; readonly refs?: readonly string[]; readonly decidedBy?: string; readonly extra?: Record<string, unknown> }

/** The journal rows a bespoke agent's case stands for (empty when the kind is not a correction in the policy). */
export function journalRowsFromCase(agent: string, c: CaseLike, policy: JournalPolicy = readJournalPolicy()): JournalRow[] {
  const spec = policy.cases[agent]?.[c.kind];
  if (!spec) return [];
  const base = { v: 1 as const, at: c.at, agent, status: spec.status, action: c.kind, what: c.why.slice(0, 300), why: c.why.slice(0, 300), before: null, after: null, undo: typeof c.extra?.undo === 'string' ? c.extra.undo : null, source: 'case' as const, by: c.decidedBy ?? agent.toUpperCase() };
  if (spec.perRef) return (c.refs ?? []).map(ref => ({ ...base, target: ref, evidence: [ref] }));
  return [{ ...base, target: c.subject, evidence: [...(c.refs ?? [])].slice(0, 8) }];
}

/** Hook for a bespoke memory's appendCase: write the case's journal rows (fail-soft — journaling never breaks a tick). */
export function journalCase(home: string, agent: string, c: CaseLike): void {
  try { appendJournal(home, journalRowsFromCase(agent, c)); } catch { /* fail-soft */ }
}

// ── rollup ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface JournalSummary {
  readonly agent: string; readonly acted: number; readonly failed: number; readonly refused: number;
  /** most frequent `action` (status) first: [{key: `reap`, status, n, sample}] */
  readonly top: ReadonlyArray<{ key: string; status: JournalStatus; n: number; sample: string }>;
}

export function summarize(agent: string, rows: readonly JournalRow[], top = JOURNAL_POLICY_DEFAULTS.top): JournalSummary {
  const by = new Map<string, { key: string; status: JournalStatus; n: number; sample: string }>();
  let acted = 0; let failed = 0; let refused = 0;
  for (const r of rows) {
    if (r.status === 'acted') acted += 1; else if (r.status === 'failed') failed += 1; else refused += 1;
    const k = `${r.status}:${r.action}`;
    const e = by.get(k) ?? { key: r.action, status: r.status, n: 0, sample: `${r.action}:${r.target}` };
    e.n += 1; by.set(k, e);
  }
  return { agent, acted, failed, refused, top: [...by.values()].sort((a, b) => b.n - a.n || a.key.localeCompare(b.key)).slice(0, top) };
}

const STATUS_KO: Record<JournalStatus, string> = { acted: '행동', failed: '실패', refused: '거절' };
export const topLine = (s: JournalSummary): string => s.top.map(t => `${STATUS_KO[t.status]} ${t.key}×${t.n} (${t.sample})`).join(' · ');
export const countsLine = (s: JournalSummary): string => `행동 ${s.acted} · 실패 ${s.failed} · 거절 ${s.refused}`;

/** kit/kpi KPI over summaries: corrections per day (acted, scaled to the span) · failure rate failed/(acted+failed). */
export function journalKpi(sums: readonly JournalSummary[], spanMs: number, policy: JournalPolicy = readJournalPolicy()): { correctionsPerDay: number | null; failureRate: number | null; correctionsOk: boolean | null; failureOk: boolean | null; line: string } {
  const acted = sums.reduce((n, s) => n + s.acted, 0); const failed = sums.reduce((n, s) => n + s.failed, 0);
  const days = spanMs / 86_400_000;
  const correctionsPerDay = days > 0 ? acted / Math.max(days, 1 / 24) : null;
  const failureRate = acted + failed > 0 ? failed / (acted + failed) : null;
  const correctionsOk = kpiOk(policy.kpi.correctionsPerDay, correctionsPerDay); const failureOk = kpiOk(policy.kpi.failureRate, failureRate);
  const mark = (ok: boolean | null) => (ok === null ? '?' : ok ? '✓' : '✘');
  const line = `교정/일 ${correctionsPerDay === null ? '?' : Math.round(correctionsPerDay * 10) / 10} (${policy.kpi.correctionsPerDay.dir === 'at_least' ? '≥' : '≤'} ${policy.kpi.correctionsPerDay.target}) ${mark(correctionsOk)} · 실패율 ${pct(failureRate)} (${policy.kpi.failureRate.dir === 'at_most' ? '≤' : '≥'} ${pct(policy.kpi.failureRate.target)}) ${mark(failureOk)}`;
  return { correctionsPerDay, failureRate, correctionsOk, failureOk, line };
}

/** Every agent home under <stateRoot>/loop-agents that has a journal. */
export function journalAgents(stateRoot: string): string[] {
  const dir = join(stateRoot, 'loop-agents');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(id => /^[a-z0-9][a-z0-9-]*$/u.test(id) && existsSync(journalDir(join(dir, id)))).sort();
}

/** The rollup line of one agent for one window. */
export function rollupLine(s: JournalSummary, fromMs: number, toMs: number, tz: string): string {
  const hm = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  return `[감독 교정 · ${s.agent}] ${hm(fromMs)}–${hm(toMs)} ${countsLine(s)}${s.top.length ? ` — ${topLine(s)}` : ''} · eln loop agent journal ${s.agent}`;
}

/** One rollup line out: live = a deduped mail from {@link JOURNAL_SENDER} to OP (folded into the 30-min machine digest) ⊕
 *  one line into ws:supervisors. `key` is the dedupe key of the window. */
export type RollupSink = (key: string, line: string) => void;
/** The machine sender of rollup mail (src/msg/op-machine-digest.ts folds it into OP's digest). */
export const JOURNAL_SENDER = 'SUPERVISOR-JOURNAL';
export const JOURNAL_ROLLUP_KEY = (agent: string, windowStartIso: string): string => `journal-rollup:${agent}:${windowStartIso}`;

/** Roll up the windows of `agent` that ended since the last rollup (≤ lookback_windows): one line per window that acted or
 *  failed → OP digest ⊕ ws:supervisors. Quiet windows write nothing. The cursor is <home>/journal/rollup-cursor.json. */
export function emitWindowRollups(home: string, agent: string, now: Date, sink: RollupSink, policy: JournalPolicy = readJournalPolicy()): string[] {
  const win = policy.windowMin * 60_000;
  const curStart = Math.floor(now.getTime() / win) * win;
  const cursorPath = join(journalDir(home), 'rollup-cursor.json');
  let last: number | null = null;
  try { const j = JSON.parse(readFileSync(cursorPath, 'utf8')) as { windowStart?: string }; const t = Date.parse(j.windowStart ?? ''); last = Number.isFinite(t) ? t : null; } catch { /* first */ }
  if (last !== null && last >= curStart) return [];
  const firstStart = Math.max(last ?? -Infinity, curStart - policy.lookbackWindows * win);
  const lines: string[] = [];
  for (let s = firstStart; s < curStart; s += win) {
    const rows = readJournal(home, s, s + win - 1, policy);
    const sum = summarize(agent, rows, policy.top);
    if (sum.acted + sum.failed === 0) continue; // only when it acted or failed
    const line = rollupLine(sum, s, s + win, policy.tz);
    try { sink(JOURNAL_ROLLUP_KEY(agent, new Date(s).toISOString()), line); } catch { /* the journal keeps it */ }
    lines.push(line);
  }
  if (existsSync(journalDir(home)) || lines.length) {
    mkdirSync(journalDir(home), { recursive: true });
    writeFileSync(cursorPath, JSON.stringify({ windowStart: new Date(curStart).toISOString(), at: now.toISOString() }));
  }
  return lines;
}

/** What the voice says about its own activity (LLM or not): «오늘 교정 N건: …» + the last few rows. */
export function journalBrief(home: string, agent: string, now: Date, policy: JournalPolicy = readJournalPolicy(), recent = 5): { text: string; summary: JournalSummary; rows: JournalRow[] } {
  const rows = readJournal(home, dayStartMs(now, policy.tz), now.getTime(), policy);
  const summary = summarize(agent, rows, policy.top);
  const total = summary.acted + summary.failed + summary.refused;
  const hm = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: policy.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  const text = total === 0 ? `오늘(${dayKey(now, policy.tz)}) 교정 0건 — 일지에 행동·실패·거절이 없다.`
    : [`오늘(${dayKey(now, policy.tz)}) 교정 ${total}건: ${countsLine(summary)}${summary.top.length ? ` — ${topLine(summary)}` : ''}`,
      ...rows.slice(-recent).reverse().map(r => `- ${hm(r.at)} ${STATUS_KO[r.status]} ${r.action}:${r.target} — ${r.what.slice(0, 120)}${r.undo ? ` · 되돌림 ${r.undo.slice(0, 80)}` : ''}`)].join('\n');
  return { text, summary, rows };
}
