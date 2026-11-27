// 착지 집사 — cards (graphs/loop-agents/land-steward/{goal.yaml,soul.md,knowhow.md}) ⊕ memory (LOOP-AGENT §1 ②③).
//   <state>/loop-agents/land-steward/cases.jsonl — every tick summary · voice answer · KPI breach line
//   <state>/loop-agents/land-steward/state.json  — breach cursor (one line per breach key per 30 min)
//   <state>/loop-agents/land-steward/level.json  — live | shadow | off (shadow/off run the plain body · landing never stops)
// Events (lands · refusals · cards) stay in the body's ledger <state>/land-graph/ledger.jsonl — no new ledger for them.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { appendAudit } from '../kit/audit-ledger/index.js';

export const STEWARD_ID = 'land-steward';
export const STEWARD_SEAT = 'LAND-STEWARD';
export const STEWARD_SUPERVISOR = 'TC';
export const STEWARD_LEVELS = ['live', 'shadow', 'off'] as const;
export type StewardLevel = typeof STEWARD_LEVELS[number];
/** Seats that may change the level — the CLI binds `--by` to the verified caller first (src/land-steward/cli.ts verifyLevelCaller). */
export const STEWARD_DEMOTERS = new Set(['TC', 'OP', 'CLAUDE-OP']);

export interface StewardGoal {
  kpi: { lands_per_hour_min: number; landable_ratio_min: number; needs_finisher_wait_p50_max_min: number; refusals_without_next_max: number };
  report: { breach_line_every_min: number };
}
export const DEFAULT_GOAL: StewardGoal = {
  kpi: { lands_per_hour_min: 10, landable_ratio_min: 0.5, needs_finisher_wait_p50_max_min: 30, refusals_without_next_max: 0 },
  report: { breach_line_every_min: 30 },
};
export interface StewardCards {
  goal: StewardGoal; soulText: string; knowhowText: string;
  /** Where the goal came from: agent.yaml (v3 · wins when present) · goal.yaml (v2 legacy) · defaults. */
  source?: 'agent.yaml' | 'goal.yaml' | 'default';
  /** agent.yaml present but refused by lint — the tick runs the plain body and reports these to the L0 (never silent). */
  refused?: string[];
  /** L0 named by agent.yaml (org duty) when it could be read. */
  supervisor?: { duty?: string; seat?: string };
  /** v3 hook nodes (reflect · plan · learn-knowhow) of the linted agent.yaml — absent = the v2 voice exactly (LOOP-AGENT-V3-SMART). */
  smart?: SmartConfig;
}

// LOOP-AGENT-V3-YAML: agent.yaml is the portable definition; goal.yaml is the v2 legacy card kept for the equivalence sim.
import { kpiOf, lintAgentDir, type CompiledAgent, type LintEnv } from '../loop-agent/v3/agent-yaml.js';
import { smartConfig, type SmartConfig } from '../loop-agent/v3/smart.js';

export const cardsDir = (root = resolve(import.meta.dir, '../..')): string => join(root, 'graphs', 'loop-agents', STEWARD_ID);
const triggersDirOf = (dir: string): string => join(dir, '..', '..', 'triggers');

/** v2 legacy: goal.yaml → goal. Each value is validated on its own: a wrong type / out-of-range value falls back to its default. */
export function goalFromGoalYaml(text: string): StewardGoal {
  try {
    const j = parse(text) as { kpi?: Record<string, unknown>; report?: Record<string, unknown> } | null;
    const n = (v: unknown, d: number, max = Number.POSITIVE_INFINITY) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : d);
    const k = j?.kpi ?? {}; const r = j?.report ?? {}; const D = DEFAULT_GOAL;
    return {
      kpi: { lands_per_hour_min: n(k.lands_per_hour_min, D.kpi.lands_per_hour_min), landable_ratio_min: n(k.landable_ratio_min, D.kpi.landable_ratio_min, 1),
        needs_finisher_wait_p50_max_min: n(k.needs_finisher_wait_p50_max_min, D.kpi.needs_finisher_wait_p50_max_min), refusals_without_next_max: n(k.refusals_without_next_max, D.kpi.refusals_without_next_max) },
      report: { breach_line_every_min: n(r.breach_line_every_min, D.report.breach_line_every_min) || D.report.breach_line_every_min },
    };
  } catch { return DEFAULT_GOAL; }
}

/** v3: a linted agent.yaml → goal (lint guarantees the four KPIs and breach_line_every_min exist — node kind land-steward.tick). */
export function goalFromAgent(c: CompiledAgent): StewardGoal {
  const t = (name: string) => kpiOf(c, name)!.target;
  return {
    kpi: { lands_per_hour_min: t('lands_per_hour'), landable_ratio_min: t('landable_ratio'), needs_finisher_wait_p50_max_min: t('needs_finisher_wait_p50'), refusals_without_next_max: t('refusals_without_next') },
    report: { breach_line_every_min: c.voice.breachLineEveryMin ?? c.policies.breach_line_every_min! },
  };
}

/** agent.yaml when present (refused → defaults ⊕ `refused` for the L0 report) · else goal.yaml · else defaults. Never throws. */
export function loadCards(dir = cardsDir(), env: LintEnv = {}): StewardCards {
  const read = (f: string) => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return ''; } };
  const fallbackSoul = '착지 집사 (land-steward) — 착지 거절의 최종 주인 · L0 = TC';
  const v3 = lintAgentDir(dir, { triggersDir: triggersDirOf(dir), ...env });
  if (v3.present && v3.compiled) {
    const smart = smartConfig(v3.compiled);
    return { goal: goalFromAgent(v3.compiled), soulText: v3.compiled.soulText || fallbackSoul, knowhowText: v3.compiled.knowhowText, source: 'agent.yaml', supervisor: v3.compiled.supervisor, ...(smart ? { smart } : {}) };
  }
  if (v3.present) {
    let supervisor: StewardCards['supervisor'];
    try { const d = (parse(read('agent.yaml')) as { supervisor?: { duty?: unknown } } | null)?.supervisor?.duty; if (typeof d === 'string' && d) supervisor = { duty: d }; } catch { /* unreadable */ }
    return { goal: DEFAULT_GOAL, soulText: read('soul.md') || fallbackSoul, knowhowText: read('knowhow.md'), source: 'default', refused: v3.errors.length ? v3.errors : ['agent.yaml refused'], ...(supervisor ? { supervisor } : {}) };
  }
  const g = read('goal.yaml');
  return { goal: g ? goalFromGoalYaml(g) : DEFAULT_GOAL, soulText: read('soul.md') || fallbackSoul, knowhowText: read('knowhow.md'), source: g ? 'goal.yaml' : 'default' };
}

export interface StewardCase { at: string; kind: 'tick' | 'voice' | 'breach' | 'level'; subject: string; why: string; refs?: string[]; extra?: Record<string, unknown> }
export interface StewardState { lastTickAt: string | null; breaches: Record<string, string> }
const emptyState = (): StewardState => ({ lastTickAt: null, breaches: {} });

export interface StewardMemory {
  readonly root: string;
  readState(): StewardState;
  writeState(s: StewardState): void;
  appendCase(c: StewardCase): void;
  cases(limit?: number): StewardCase[];
  level(): { level: StewardLevel; by: string; at: string; reason: string };
  setLevel(level: StewardLevel, by: string, reason: string, now?: Date): void;
}

export const stewardHome = (stateRoot: string): string => join(stateRoot, 'loop-agents', STEWARD_ID);

export function fileMemory(stateRoot: string): StewardMemory {
  const root = stewardHome(stateRoot);
  const p = (f: string) => join(root, f);
  const ensure = () => mkdirSync(root, { recursive: true });
  return {
    root,
    readState() { try { return { ...emptyState(), ...JSON.parse(readFileSync(p('state.json'), 'utf8')) as Partial<StewardState> }; } catch { return emptyState(); } },
    writeState(s) { ensure(); writeFileSync(p('state.json.tmp'), JSON.stringify(s, null, 1)); renameSync(p('state.json.tmp'), p('state.json')); },
    appendCase(c) { appendAudit(p('cases.jsonl'), 'land-steward.case/1', { ...c }); },
    cases(limit = 200) {
      if (!existsSync(p('cases.jsonl'))) return [];
      return readFileSync(p('cases.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as StewardCase]; } catch { return []; } }).slice(-limit);
    },
    level() {
      try {
        const j = JSON.parse(readFileSync(p('level.json'), 'utf8')) as { level?: string; by?: string; at?: string; reason?: string };
        if ((STEWARD_LEVELS as readonly string[]).includes(String(j.level))) return { level: j.level as StewardLevel, by: j.by ?? '?', at: j.at ?? '?', reason: j.reason ?? '' };
      } catch { /* default */ }
      return { level: 'live', by: 'default', at: '-', reason: 'land-steward rollout — live by default (the body keeps land.graph.mode)' };
    },
    setLevel(level, by, reason, now = new Date()) {
      if (!(STEWARD_LEVELS as readonly string[]).includes(level)) throw new Error(`level must be ${STEWARD_LEVELS.join(' | ')}`);
      const who = by.trim().toUpperCase();
      if (!STEWARD_DEMOTERS.has(who)) throw new Error(`only ${[...STEWARD_DEMOTERS].join('/')} may change the land-steward level (got ${by})`);
      ensure();
      writeFileSync(p('level.json'), JSON.stringify({ level, by: who, at: now.toISOString(), reason }));
      appendAudit(p('cases.jsonl'), 'land-steward.case/1', { at: now.toISOString(), kind: 'level', subject: level, why: `${who}: ${reason}` } satisfies StewardCase);
    },
  };
}
