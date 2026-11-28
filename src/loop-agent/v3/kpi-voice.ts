// CODE-BODY-TO-KIND — the `kpi-voice` node kind: a body's metrics → agent.yaml KPI breaches → one line per breach key per
// window, the v3 plan choosing line · L0 card · quiet (LOOP-AGENTS-AS-PLUGINS · 대표 11-28 «코드로 된 것도 플러그인화»).
//
// S: the land steward judged its four KPIs in its own TS (kpi.ts breaches · BREACH_KPI · kpiValue) with the thresholds read
//    from YAML but the comparison, the line text, the debounce and the L0 card body written in code.
// C: another agent with metrics of its own (any body that leaves a numbers object) could not get the same voice without a copy.
// A: one generic node: kpis[].from reads the value (an array counts its length) · kit/kpi judges it raw against the target ·
//    kpis[].breach / voice.line / voice.l0_card are the texts (fillTemplate) · kit/kpi debounceKeys keeps one cursor per
//    kpis[].key · the v3 smart session (reflect · plan · learn) picks the action. Flavour = parameters.
//
// 세 얼굴: 관측 = the returned breaches · posted lines · plan choices (the tick report) / 판단 근거 = agent.yaml kpis (target ·
//   from · key · breach) ⊕ voice templates ⊕ breach_line_every_min / 수복과 인계 = a failed channel / mail port is fail-open (the
//   case row keeps it) · a broken v3 store → the default line (never silence).
import { debounceKeys, kpiBreached, pct } from '../../kit/kpi/index.js';
import type { AgentKpi } from './agent-yaml.js';
import { beginSmart, fileSmartStore, type Choice, type KnowhowSink, type Router, type SmartConfig, type SmartSession } from './smart.js';

/** A dotted path into the metrics object · an array counts its length · anything else non-numeric = unknown. */
export function readMetric(metrics: unknown, path: string | null | undefined): number | null {
  if (!path) return null;
  let v: unknown = metrics;
  for (const k of path.split('.')) { if (!v || typeof v !== 'object') return null; v = (v as Record<string, unknown>)[k]; }
  if (Array.isArray(v)) return v.length;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const pathValue = (vars: Readonly<Record<string, unknown>>, path: string): unknown => {
  let v: unknown = vars;
  for (const k of path.split('.')) { if (!v || typeof v !== 'object') return undefined; v = (v as Record<string, unknown>)[k]; }
  return v;
};
const show = (v: unknown): string => (v === null || v === undefined ? '?' : Array.isArray(v) ? String(v.length) : String(v));
const FILTERS: Readonly<Record<string, (v: unknown, arg: string | undefined) => string>> = {
  pct: v => pct(typeof v === 'number' ? v : null),
  round: v => (typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v)) : '?'),
  // `{kpi.refusalsWithoutNext|refs:5}` → «#41001 #41002» (the first N items, each with a # mark)
  refs: (v, arg) => (Array.isArray(v) ? v.slice(0, arg ? Number(arg) : v.length).map(x => `#${String(x)}`).join(' ') : show(v)),
};

/** `{path}` · `{path|filter[:arg]}` (pct · round · refs) · `{path?then:else}` (truthy number / string / non-empty array). */
export function fillTemplate(tpl: string, vars: Readonly<Record<string, unknown>>): string {
  return tpl.replace(/\{([A-Za-z_][\w.]*)(?:\|([a-z]+)(?::([^}]*))?|\?([^:}]*):([^}]*))?\}/gu, (_m, path: string, f?: string, arg?: string, yes?: string, no?: string) => {
    const v = pathValue(vars, path);
    if (yes !== undefined) return (Array.isArray(v) ? v.length > 0 : !!v) ? yes : no ?? '';
    if (f) { const fn = FILTERS[f]; return fn ? fn(v, arg) : show(v); }
    return show(v);
  });
}

export interface KpiBreach { readonly key: string; readonly kpi: string; readonly line: string; readonly value: number | null }

/** Every declared KPI (with key · breach) whose raw value breaches its target, in agent.yaml order. Unknown never breaches. */
export function kpiBreaches(kpis: readonly AgentKpi[], metrics: Readonly<Record<string, unknown>>): KpiBreach[] {
  const out: KpiBreach[] = [];
  for (const k of kpis) {
    if (!k.key || !k.breach) continue;
    const value = readMetric(metrics, k.from);
    if (kpiBreached({ target: k.target, dir: k.dir }, value) !== true) continue;
    out.push({ key: k.key, kpi: k.name, value, line: fillTemplate(k.breach, { ...metrics, value: pathValue(metrics, k.from ?? '') ?? value, target: k.target }) });
  }
  return out;
}

export interface KpiVoiceIn {
  readonly agent: string;
  readonly kpis: readonly AgentKpi[];
  readonly voice: { readonly line?: string; readonly l0Card?: string };
  readonly everyMin: number;
  /** the body's report the KPIs read (`from: kpi.landsLastHour` → metrics.kpi.landsLastHour) */
  readonly metrics: Readonly<Record<string, unknown>>;
  /** breach key → last line time (the agent's own state cursor) */
  readonly cursor: Readonly<Record<string, string>>;
  readonly now: Date;
  /** live = speak · otherwise lines are only returned (shadow) */
  readonly live: boolean;
  readonly smart: SmartSession | null;
  readonly router?: Router | null;
  channel(line: string): void;
  report?(key: string, to: string, body: string): void;
}
export interface KpiVoiceChoice { key: string; action: string; to: string; why: string; judgedBy: Choice['judgedBy']; fallback?: string }
export interface KpiVoiceOut { readonly breaches: KpiBreach[]; readonly posted: string[]; readonly choices: KpiVoiceChoice[]; readonly cursor: Record<string, string> }

/** One voice step: breaches → due keys (debounce) → plan (line · L0 card · quiet) → channel / mail → next cursor. */
export async function runKpiVoice(i: KpiVoiceIn): Promise<KpiVoiceOut> {
  const at = i.now.toISOString();
  const br = kpiBreaches(i.kpis, i.metrics);
  const deb = debounceKeys(i.cursor, br.map(b => b.key), i.now, i.everyMin);
  const posted: string[] = []; const choices: KpiVoiceChoice[] = [];
  for (const b of br) {
    if (!deb.due.includes(b.key)) continue;
    const line = fillTemplate(i.voice.line ?? '{breach}', { ...i.metrics, breach: b.line, time: at.slice(11, 16) });
    const ch = i.smart ? await i.smart.chooseJudged({ intent: `breach:${b.key}`, to: 'channel', kpis: [b.kpi] }, i.router ?? null, b.line).catch(() => null) : null;
    const action = ch?.action ?? 'breach-line';
    const row = { intent: `breach:${b.key}`, key: `${b.key}:${at}`, kpi: b.kpi, base: b.value };
    if (ch) choices.push({ key: b.key, action, to: ch.to, why: ch.why, judgedBy: ch.judgedBy, ...(ch.fallback ? { fallback: ch.fallback } : {}) });
    if (action === 'l0-card') {
      const body = fillTemplate(i.voice.l0Card ?? '{breach}', { ...i.metrics, breach: b.line, to: ch!.to, why: ch!.why, time: at.slice(11, 16) });
      try { i.report?.(`${i.agent}-v3:${b.key}:${at.slice(0, 13)}`, ch!.to, body); } catch { /* fail-open */ }
      i.smart!.record({ ...row, action, to: ch!.to });
      continue;
    }
    if (action === 'quiet') { i.smart!.record({ ...row, action, to: 'none' }); continue; }
    if (i.live) { try { i.channel(line); } catch { /* fail-open: the case row keeps it */ } }
    posted.push(line);
    i.smart?.record({ ...row, action: 'breach-line', to: 'channel' });
  }
  i.smart?.save();
  return { breaches: br, posted, choices, cursor: deb.next };
}

/** One v3 session for this tick (readings = every KPI's `from` value). Fail-open: a broken store → null (the default line). */
export function openKpiSmart(o: { cfg: SmartConfig; storeRoot: string; now: Date; l0: string; knowhow: KnowhowSink | null; metrics: Readonly<Record<string, unknown>>; kpis: readonly AgentKpi[] }): SmartSession | null {
  try {
    return beginSmart({ cfg: o.cfg, store: fileSmartStore(o.storeRoot), now: o.now, l0: o.l0, knowhow: o.knowhow,
      readings: o.cfg.kpis.map(k => ({ name: k.name, value: readMetric(o.metrics, o.kpis.find(x => x.name === k.name)?.from) })) });
  } catch { return null; }
}
