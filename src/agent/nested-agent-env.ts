/** Parent-only markers that make a spawned coding agent reject nested execution. */
export const NESTED_AGENT_ENV_BLOCKLIST = new Set<string>([
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'ELANOUS_SESSION_ID',
  'ELANOUS_UNDO_REF',
  'ELANOUS_GUARDIAN',
  'ELANOUS_UNDO',
  'ELANOUS_HITL_CALLBACK_PORT',
  'ELANOUS_HITL_PORT',
  'ELANOUS_HITL_PORT_SCAN_RANGE',
]);
