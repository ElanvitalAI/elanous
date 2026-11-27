// LOOP-AGENT v3 YAML — what this install can execute (LOOP-AGENT-V3-YAML · 대표 11-27 «그래프러너 v2 처럼 yaml 로 정의»).
// An agent.yaml's manifest.requires is checked against THIS table: a node kind, kit or executor that is not here is a loud
// refusal (lint exit 1 · runtime refuses the agent and reports to its L0), never a silent skip.
//
// Node kinds are the graph-runner-v2 vocabulary for a loop agent's body. A «body» kind binds an existing TS body (the body
// code is not rewritten — the kind is its name in YAML); `needsKpis` are the KPI names the bound body judges, so a missing
// KPI in the YAML is a lint error instead of an undefined threshold at tick time. «hook» kinds are the v3 smartness slots
// (reflection · plan · learn-to-knowhow): accepted only as `optional: true` nodes until an executor version runs them.

/** Policies each v3 hook node reads (LOOP-AGENT-V3-SMART) — lint refuses an agent.yaml with the hook but not the policy. */
export const HOOK_POLICIES = {
  reflect: ['act_grace_min', 'lesson_repeat_min', 'reflect_window_min'],
  plan: ['plan_ambiguity_margin', 'unacted_penalty', 'plan_llm_per_hour'],
  'learn-knowhow': ['lesson_cap', 'knowhow_promote_min', 'knowhow_cap'],
  // LOOP-AGENT-V3-SMART-2: periodic retro (journal ⊕ KPI window → what worked · what failed and why · one change to try)
  retro: ['retro_every_h'],
} as const;

/** The executor this install runs (`manifest.requires.executor` must name the same major). */
export const EXECUTOR = { name: 'loop-agent', major: 3, minor: 2 } as const; // 3.2 = retro hook ⊕ soul block ⊕ shell plan (LOOP-AGENT-V3-SMART-2)
export const EXECUTOR_TAG = `${EXECUTOR.name}@${EXECUTOR.major}.${EXECUTOR.minor}`;

/** Kits installed with this executor (src/kit/<name>). */
export const INSTALLED_KITS: readonly string[] = ['kpi'];

export type NodeKindStatus = 'ready' | 'hook';
export interface NodeKindDef {
  readonly kind: string;
  readonly status: NodeKindStatus;
  readonly describe: string;
  /** KPI names the bound body judges — each must be declared under `kpis:`. */
  readonly needsKpis?: readonly string[];
  /** Policy names the bound body reads besides KPI targets. */
  readonly needsPolicies?: readonly string[];
  /** v2-shell step this kind runs (src/loop-agent/runtime.ts TICK_STEPS) — absent for non-shell kinds. */
  readonly step?: 'observe' | 'act' | 'learn' | 'judge' | 'finish';
}

/** The policies each supervisor body reads through `pv()` (src/loop-agent/bodies/<id>.ts) — an agent.yaml must declare them. */
export const SUPERVISOR_BODY_POLICIES: Readonly<Record<string, readonly string[]>> = {
  'run-supervisor': ['pregate_zombie_min', 'stale_record_min', 'run_stall_min', 'run_zombie_min', 'run_window_h'],
  'run-doctor': ['window_h', 'settle_min', 'retry_max_age_h', 'loop_exception_min', 'rail_window_min', 'loop_normalize_attempts', 'loop_case_sla_min'],
  autopsy: ['window_h', 'classify_batch', 'cell_repeat', 'cell_window_days', 'cells_per_day'],
  macrophage: ['recent_reap_min'],
  'watchers-check': ['recent_min'],
  'silence-watch': ['sla_min', 'lookback_h'],
  'train-manager': ['churn_window_min'],
  'release-rocket': ['grace_min', 'waiver_window_min'],
  'hand-steward': [],
};

export const NODE_KINDS: Readonly<Record<string, NodeKindDef>> = {
  gate: { kind: 'gate', status: 'ready', describe: 'graph-runner v2 terminal / join node (no work)' },
  'land-steward.tick': {
    kind: 'land-steward.tick', status: 'ready',
    describe: 'land graph body tick with the train manager order · finisher · cell link (src/land-steward/agent.ts stewardTick)',
    needsKpis: ['lands_per_hour', 'landable_ratio', 'needs_finisher_wait_p50', 'refusals_without_next'],
    needsPolicies: ['breach_line_every_min'],
  },
  // ── v2 supervisors on the generic shell (YAML-SUPERVISORS-DEF): the tick is a graph of these steps (src/loop-agent/runtime.ts
  //    TICK_STEPS). `<id>.observe` binds that agent's body (src/loop-agent/bodies/<id>.ts) and names the policies it reads.
  ...Object.fromEntries(Object.entries(SUPERVISOR_BODY_POLICIES).map(([id, pol]) => [`${id}.observe`, {
    kind: `${id}.observe`, status: 'ready' as const, step: 'observe' as const,
    describe: `observe the ${id} subject (src/loop-agent/bodies/${id}.ts) · KPI vs target → ok | breach | unknown | off | error`,
    needsPolicies: ['subject_lost_ticks', ...pol],
  }])),
  'loop-agent.act': { kind: 'loop-agent.act', status: 'ready', step: 'act', describe: 'plan → run reversible actions inside the card rights (max per tick · cooldown)', needsPolicies: ['max_per_tick', 'cooldown_min'] },
  'loop-agent.learn': { kind: 'loop-agent.learn', status: 'ready', step: 'learn', describe: 'repeated outcome pattern → candidate lesson (L0 silence promotes) · lesson decay/cap' },
  'loop-agent.judge': { kind: 'loop-agent.judge', status: 'ready', step: 'judge', describe: 'KPI breach new / ongoing / recovered → one channel line · L0 card after escalate_after_min', needsPolicies: ['escalate_after_min'] },
  'loop-agent.finish': { kind: 'loop-agent.finish', status: 'ready', step: 'finish', describe: 'state · tick case · heartbeat (loop:<id>)', needsPolicies: ['heartbeat_every_min'] },
  'judge-butler.tick': {
    kind: 'judge-butler.tick', status: 'ready',
    describe: 'judge-butler body tick + voice (src/judge-butler/agent.ts wakeButler) — goal numbers still read from goal.yaml (cards.ts)',
    needsKpis: ['greens_per_hour', 'judge_queue_median_wait', 'frozen_hands', 'hand_answer_sla'],
  },
  // LOOP-AGENT-V3-SMART (executor 3.1 runs them · src/loop-agent/v3/smart.ts): still `optional: true` only — a hook is a
  // fail-open slot around the body, never a node the body's outcome depends on.
  reflect: { kind: 'reflect', status: 'hook', describe: 'v3 reflect — resolve past actions (receiver acted? KPI moved?) · «N unacted in a row» patterns', needsPolicies: [...HOOK_POLICIES.reflect] },
  plan: { kind: 'plan', status: 'hook', describe: 'v3 plan — YAML default unless a lesson says it does not work · score actions by KPI gap × act rate − cost · LLM node only when ambiguous', needsPolicies: [...HOOK_POLICIES.plan] },
  'learn-knowhow': { kind: 'learn-knowhow', status: 'hook', describe: 'v3 learn — one lesson per pattern (dedupe · cap) → knowhow card after N windows (cap · marker dedupe)', needsPolicies: [...HOOK_POLICIES['learn-knowhow']] },
  retro: { kind: 'retro', status: 'hook', describe: 'v3 retro — every retro_every_h (and `eln loop agent <id> retro`): journal ⊕ KPI window → what worked · what failed and why · one change to try (memory · the voice quotes it)', needsPolicies: [...HOOK_POLICIES.retro] },
};

export const nodeKind = (kind: string): NodeKindDef | null => (Object.hasOwn(NODE_KINDS, kind) ? NODE_KINDS[kind]! : null);
