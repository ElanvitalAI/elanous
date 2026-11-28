// kit/fleet-audit — the policy NAMES it reads (a leaf module: the node-kind table imports it without the kit's readers).
// The numbers live only in the instance agent.yaml `policies:` block; lint refuses an instance that lacks one of these.
export const FLEET_POLICY_NAMES: readonly string[] = ['window_min', 'stale_tick_min', 'stale_cadence_x', 'watch_only_breach_min', 'false_green_unacted_min', 'rung_wait_min',
  'heal_max_per_tick', 'red_watch_only_min', 'red_after_min', 'score_partial_pct', 'summary_lines_max',
  'w_outcome', 'w_response', 'w_proactive', 'w_robust', 'w_judgment', 'w_sustain'];
