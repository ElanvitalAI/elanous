// kit/canary — the policy NAMES it reads (a leaf module: the node-kind table imports it without the kit's readers).
// The numbers live only in the instance agent.yaml `policies:` block; lint refuses an instance that lacks one of these.
// The probe thresholds (drop % · ages · budget %) are not here: they sit next to each probe in graphs/policies/<pack>.yaml.
export const CANARY_POLICY_NAMES: readonly string[] = ['watch_window_min', 'confirm_reads', 'confirm_gap_sec', 'rollbacks_per_sha_max', 'verify_min',
  'step_timeout_sec', 'suspects_max', 'false_rollback_window_h'];
