// Tool-hint domain types.
//
// A "hint" is a short-lived directive that adjusts which native tools
// the gate exposes, or defaults some of their args, for the next turn
// / session / project. Created by /hint, by the set_tool_hint native
// tool, or auto-generated from prior tool results (feedback). Consumed
// by `src/tool-hints/gate.ts` to derive a filtered catalog before the
// discipline prompt is built.
//
// Nothing here has behavior — this file is the shared vocabulary for
// P2 (registry), P4 (gate), P6 (/hint), and P7 (feedback).

/** Lifetime buckets. `turn` + `session` are memory-only; `project` + `global`
 *  persist to `~/.config/monad-agent/hints.json`. `project` is keyed
 *  by cwd so hints don't leak across repos. */
export type HintScope = 'turn' | 'session' | 'project' | 'global';

/** Arc H — intent-based tool scope. Per-entry on NativeToolCatalogEntry
 *  (additive field, default `'always'` for untagged). The gate filters
 *  by active intent scope set only when
 *  `HARNESS_TOOL_DISCIPLINE_ENABLED=1`; otherwise no-op.
 *
 *  Active scope computation:
 *    - `'coding'` — always active (default coding throughput lane)
 *    - `'browse'` / `'viz'` / `'capture'` / `'ops-fleet'` / `'ops-ui'`
 *      — active iff the matching intent regex in signals.ts matches
 *      the current turn
 *    - `'always'` — unfiltered (fallback for untagged entries)
 *
 *  Arc H follow-up (PR #572): the former `'ops'` scope split into two
 *  axes — `'ops-fleet'` for remote/fleet management (acp · agent room ·
 *  iphone · budget · policy · llm nodes · teams · hitl) and `'ops-ui'`
 *  for the local dashboard surface (windows · panes · terminal matrix/
 *  modal · context inspector · layout · vw · widget · scenario).
 */
export type ToolIntentScope = 'coding' | 'browse' | 'viz' | 'capture' | 'ops-fleet' | 'ops-ui' | 'always';

/** Effect a hint has on the gate decision.
 *  - prefer/boost:    raise priority (first to be quoted in prompt)
 *  - avoid:           lower priority (still available, less quoted)
 *  - enable/disable:  force tool in / out of the filtered catalog
 *  - param-default:   supply default args; LLM can still override
 */
export type HintKind =
  | 'prefer'
  | 'avoid'
  | 'enable'
  | 'disable'
  | 'boost'
  | 'param-default';

export interface Hint {
  /** Stable id (nanoid-like 12 chars) used for remove/consume. */
  id: string;
  kind: HintKind;
  /** Catalog id, alias, or '*' (apply to all). Resolved against the
   *  catalog at gate time — an unknown tool is a no-op, not an error,
   *  so a stale persisted hint doesn't break startup. */
  tool: string;
  /** Human-facing reason. Rendered in /hint list and shown to the
   *  LLM via the prompt-bank 'tool-hint' slot (P6). */
  reason?: string;
  scope: HintScope;
  /** Epoch ms at creation. */
  createdAt: number;
  /** Epoch ms absolute expiry; absent = no TTL (until manual reset). */
  expiresAt?: number;
  /** Remaining uses; each dispatch that honors the hint decrements.
   *  Absent = unlimited. Reaches 0 → hint is removed. */
  usesLeft?: number;
  /** Origin tag — 'slash' / 'feedback' / 'probe' / 'user-api' / 'llm'.
   *  Debug-only; kept in persisted file so audits can tell why a hint
   *  is there. */
  sourceSignal?: string;
  /** Kind-specific payload. For 'param-default', carries `{ args: {...} }`. */
  payload?: Record<string, unknown>;
}

/** Persisted shape of the hints file. Versioned so a future migration
 *  can tell old files apart without a schema guessing game. Only
 *  `project` + `global` hints live here; `turn` + `session` never
 *  touch disk. */
export interface HintsFileV1 {
  version: 1;
  /** Global hints apply regardless of cwd. */
  global: Hint[];
  /** Keyed by absolute cwd. Loading a project's hints is a
   *  look-up-by-cwd operation, not a scan. */
  projects: Record<string, Hint[]>;
}

/** Output of the gate evaluator (P4). Consumers: skill-runner (builds
 *  discipline prompt from `filtered`), set_tool_hint (UI listing
 *  `hintReasons`), api_call (applies `paramDefaults`). */
export interface GateDecision {
  /** Catalog entries the gate kept after hint + signal filtering. */
  filtered: string[];      // tool ids
  /** Boost scores per tool id — larger = quote earlier in prompt. */
  boost: Record<string, number>;
  /** Defaulted args per tool id, applied on dispatch when caller
   *  omits them. LLM-supplied args override. */
  paramDefaults: Record<string, Record<string, unknown>>;
  /** Reasons surfaced by current hints — for prompt injection. */
  hintReasons: string[];
  /** Why a catalog entry was not selected, keyed by stable catalog id. */
  excludedReasons?: Record<string, string>;
}
