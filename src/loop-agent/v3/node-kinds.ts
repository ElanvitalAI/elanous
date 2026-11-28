// LOOP-AGENT v3 YAML — what this install can execute (LOOP-AGENT-V3-YAML · 대표 11-27 «그래프러너 v2 처럼 yaml 로 정의»).
// An agent.yaml's manifest.requires is checked against THIS table: a node kind, kit or executor that is not here is a loud
// refusal (lint exit 1 · runtime refuses the agent and reports to its L0), never a silent skip.
//
// Node kinds are the graph-runner-v2 vocabulary for a loop agent's body. A «body» kind binds an existing TS body (the body
// code is not rewritten — the kind is its name in YAML); `needsKpis` are the KPI names the bound body judges, so a missing
// KPI in the YAML is a lint error instead of an undefined threshold at tick time. «hook» kinds are the v3 smartness slots
// (reflection · plan · learn-to-knowhow): accepted only as `optional: true` nodes until an executor version runs them.

import { FLEET_POLICY_NAMES } from '../../kit/fleet-audit/policy-names.js';
import { CANARY_POLICY_NAMES } from '../../kit/canary/policy-names.js';

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

/** Kits installed with this executor (src/kit/<name>). bus-post = CONTEXT-BUS-FEDERATION ③ (the `bus-post` node's executor). */
export const INSTALLED_KITS: readonly string[] = ['kpi', 'bus-post', 'fleet-audit'];

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
  /** SUPERVISORS-EXECUTE-NOT-PROPOSE: the acts a bespoke body runs itself (agent.yaml `authority.executes` / `undo` may name them). */
  readonly acts?: readonly string[];
}

/** The policies each supervisor body reads through `pv()` (src/loop-agent/bodies/<id>.ts) — an agent.yaml must declare them. */
export const SUPERVISOR_BODY_POLICIES: Readonly<Record<string, readonly string[]>> = {
  'run-supervisor': ['pregate_zombie_min', 'stale_record_min', 'run_stall_min', 'run_zombie_min', 'run_window_h'],
  'run-doctor': ['window_h', 'settle_min', 'retry_max_age_h', 'loop_exception_min', 'rail_window_min', 'loop_normalize_attempts', 'loop_case_sla_min'],
  autopsy: ['window_h', 'classify_batch', 'cell_repeat', 'cell_window_days', 'cells_per_day'],
  macrophage: ['recent_reap_min', 'stale_worktree_days', 'stale_stash_days', 'oneshot_grace_h'],
  'watchers-check': ['recent_min'],
  'silence-watch': ['sla_min', 'sla_min_op', 'lookback_h', 'page_rows', 'pages_max', 'notice_close_max'],
  'train-manager': ['churn_window_min'],
  'release-rocket': ['grace_min', 'waiver_window_min'],
  'hand-steward': [],
  'fed-analyst': ['window_min', 'publish_slack_min', 'prose_llm_per_tick', 'op_inbound_per_h_max', 'machine_ratio_max_pct', 'edge_min_requests', 'edge_answer_min_pct',
    'dormant_edges_max', 'hand_to_tc_per_h_max', 'coord_eigen_max_pct', 'hand_stale_min', 'lands_per_h_min', 'greens_per_h_min', 'recheck_min'],
};

/** CODE-BODY-TO-KIND: the shared kinds a sub (agent.yaml `subs[].kind`) runs on → the params block named after the kind. A sub's
 *  flavour is that block (YAML); the kind's code is one per install, reused by every agent that declares it. */
export const SUB_KINDS: Readonly<Record<string, string>> = { 'kpi-rollup': 'kpi_rollup', 'resource-check': 'resource_check' };

export const NODE_KINDS: Readonly<Record<string, NodeKindDef>> = {
  gate: { kind: 'gate', status: 'ready', describe: 'graph-runner v2 terminal / join node (no work)' },
  // ── sub kinds (CODE-BODY-TO-KIND) — run inside the body node that spawns the sub (the guardian pulse) ──
  'kpi-rollup': { kind: 'kpi-rollup', status: 'ready', describe: 'sub kind — a read of other agents\' own KPI ticks ⊕ case ledgers → one KPI line naming who owns each breach (src/kit/kpi/rollup.ts · params kpi_rollup:)' },
  'resource-check': { kind: 'resource-check', status: 'ready', describe: 'sub kind — rows ⊕ normal_if ⊕ normalize act / cards / run steps (action ports) ⊕ KPI line, all from params resource_check: (src/loop-agent/v3/resource-check.ts)' },
  // CODE-BODY-TO-KIND: an agent whose body is the land graph (land-steward is one instance) — lane order = the package's
  // policies.yaml · metrics = src/land-graph/metrics.ts · the voice is the next node (kpi-voice). lands_per_hour = slot advice.
  'land-graph.tick': {
    kind: 'land-graph.tick', status: 'ready',
    describe: 'land graph body tick — policy-pack lane order · the agent as terminal owner · finisher · cell link · land metrics (src/loop-agent/v3/land-graph-kind.ts)',
    needsKpis: ['lands_per_hour'],
  },
  // CODE-BODY-TO-KIND: metrics → agent.yaml KPI breaches (kpis[].from · key · breach) → one line per key per window ·
  // the plan (when declared) picks line · L0 card (voice.l0_card) · quiet (src/loop-agent/v3/kpi-voice.ts).
  'kpi-voice': {
    kind: 'kpi-voice', status: 'ready',
    describe: 'body metrics → KPI breaches (kpis[].from vs target · kpis[].breach text) → one channel line per breach key per breach_line_every_min (voice.line) · plan: line · L0 card (voice.l0_card) · quiet',
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
  // GUARDIAN-V3-SMART: the guardian's thin body (src/guardian-agent/pulse.ts runResidentPulse · LLM 0) — every number it and
  // its seven subs read comes from the agent.yaml policies (src/guardian-agent/def.ts gp()); the subs are `subs:` (spawned
  // per event / cadence inside this node, never resident).
  'guardian.pulse': {
    kind: 'guardian.pulse', status: 'ready',
    describe: 'guardian thin body pulse (src/guardian-agent/pulse.ts runResidentPulse) — world aggregate · sub spawns (subs:) · detector ladders (kit/case-ledger) · final route',
    needsKpis: ['host_load_per_cpu', 'orphans_over_2h', 'unnormalized_cases'],
    // the body's own reads (gp()) — the sub windows (reattach · fuel · key cards) are $policies refs in subs[].resource_check
    needsPolicies: ['scale_ratio', 'scale_headroom', 'idle_hand_scale_down_h', 'proposal_every_min', 'digest_every_min', 'dead_after_cadences', 'reattach_after_min',
      'event_respawn_min', 'key_stale_days'],
  },
  // SUPERVISOR-AUDITOR-LOOP (대표 11-28 16:5x «스스로 돌아가도록»): a whole body as ONE shared kind — any agent.yaml whose entry
  // node is this kind audits the loop-agent fleet with its own policies (src/loop-agent/v3/fleet-audit-kind.ts ⊕ kit/fleet-audit ·
  // the body registry binds it by kind, never by id). An HQ auditor today; a kingdom's fleet auditor is another agent.yaml.
  'fleet-audit.observe': {
    kind: 'fleet-audit.observe', status: 'ready', step: 'observe',
    describe: 'fleet audit (kit/fleet-audit) — every loop agent home: tick age · KPI · breach · acts/fails/refusals · lessons → six axes ⊕ trend · watch-only / false-green / tick-stale / KPI-missing → ladder refire → owner card → ✋ L0 · report (ledger ⊕ HQ bus ⊕ hourly OP mail) · red → OP ⊕ telegram once',
    needsKpis: ['watch_only_agents'],
    needsPolicies: ['subject_lost_ticks', ...FLEET_POLICY_NAMES],
  },
  // RAIL-CANARY-AUTO-ROLLBACK (대표 11-29 02:3x): a whole body as ONE shared kind — any agent.yaml whose entry node is this kind
  // measures the installed build after a swap with the probes of graphs/policies/<canary.pack | id>.yaml (kit/canary) and rolls
  // a regressed build back through the existing door once per sha (src/loop-agent/v3/canary-kind.ts · bound by kind).
  'canary.check': {
    kind: 'canary.check', status: 'ready', step: 'observe',
    describe: 'build canary (kit/canary) — install.json swap → pack probes vs the previous build inside the watch window (confirm re-reads) → rollback once per sha (existing door ⊕ restart doors ⊕ OP card with prev..new suspects) · limit / unknown target / false rollback → one OP card',
    needsKpis: ['canary_fail_to_rollback_minutes'],
    needsPolicies: ['subject_lost_ticks', ...CANARY_POLICY_NAMES],
  },
  'judge-butler.tick': {
    kind: 'judge-butler.tick', status: 'ready',
    describe: 'judge-butler body tick + voice (src/judge-butler/agent.ts wakeButler) — goal numbers still read from goal.yaml (cards.ts)',
    needsKpis: ['greens_per_hour', 'judge_queue_median_wait', 'frozen_hands', 'hand_answer_sla'],
    // sign-green (judgeCell ⊕ criterion kit · never security-4 / JUD verdict / a HOLD naming the cell) · its undo = JUD's veto
    // (set back → lesson · no re-sign on the same evidence) · run-evidence / run-sim write only test-universe receipts
    acts: ['sign-green', 'veto', 'run-evidence', 'run-sim', 'expire-holds'],
  },
  // CONTEXT-BUS-FEDERATION ③ — the guardian's own body (src/guardian-agent/body.ts guardianTick · run by graphs/triggers/guardian.yaml).
  'guardian.tick': {
    kind: 'guardian.tick', status: 'ready',
    describe: 'guardian body tick (src/guardian-agent/body.ts) — reap · route · hand-scale proposals · 30-min status (its numbers still live in the body; agent.yaml carries its KPIs and the bus-post opt-in)',
    needsKpis: ['host_load_per_cpu', 'orphan_test_universe_age'],
  },
  // CONTEXT-BUS-FEDERATION ③ (kit/bus-post · src/kit/bus-post/index.ts): the agent's notice mail (agent.yaml `bus.notices`,
  // kinds info|status only) becomes one `status` item in its L0's bus space when the L0 reads the bus; otherwise — and when
  // the bus write fails — the mail port unchanged. A fail-open slot around the mail port, so `optional: true` like a hook.
  'bus-post': { kind: 'bus-post', status: 'hook', describe: 'notices → L0 bus space as status (reader-gated · mail fallback once · requests stay mail)', needsPolicies: ['bus_reader_window_h'] },
  // LOOP-AGENT-V3-SMART (executor 3.1 runs them · src/loop-agent/v3/smart.ts): still `optional: true` only — a hook is a
  // fail-open slot around the body, never a node the body's outcome depends on.
  reflect: { kind: 'reflect', status: 'hook', describe: 'v3 reflect — resolve past actions (receiver acted? KPI moved?) · «N unacted in a row» patterns', needsPolicies: [...HOOK_POLICIES.reflect] },
  plan: { kind: 'plan', status: 'hook', describe: 'v3 plan — YAML default unless a lesson says it does not work · score actions by KPI gap × act rate − cost · LLM node only when ambiguous', needsPolicies: [...HOOK_POLICIES.plan] },
  'learn-knowhow': { kind: 'learn-knowhow', status: 'hook', describe: 'v3 learn — one lesson per pattern (dedupe · cap) → knowhow card after N windows (cap · marker dedupe)', needsPolicies: [...HOOK_POLICIES['learn-knowhow']] },
  retro: { kind: 'retro', status: 'hook', describe: 'v3 retro — every retro_every_h (and `eln loop agent <id> retro`): journal ⊕ KPI window → what worked · what failed and why · one change to try (memory · the voice quotes it)', needsPolicies: [...HOOK_POLICIES.retro] },
};

export const nodeKind = (kind: string): NodeKindDef | null => (Object.hasOwn(NODE_KINDS, kind) ? NODE_KINDS[kind]! : null);
