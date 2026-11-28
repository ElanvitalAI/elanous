// LOOP-AGENT v2 supervisors (SUPERVISOR-REVIVE-1127) — `loop:<id>` → mail seat. A leaf module (no imports): msg-store reads it.
// Every v2 card's `address` must equal the value here (loop-agent seats test).
export const V2_AGENT_SEATS: Readonly<Record<string, string>> = {
  'run-supervisor': 'RUN-SUPERVISOR',
  'run-doctor': 'RUN-DOCTOR',
  autopsy: 'AUTOPSY',
  macrophage: 'MACROPHAGE',
  'train-manager': 'TRAIN-MANAGER',
  'release-rocket': 'RELEASE-ROCKET',
  'silence-watch': 'SILENCE-WATCH',
  'watchers-check': 'WATCHERS-CHECK',
  'hand-steward': 'HAND-STEWARD', // 행정관 (orchestrator duty) — not `orchestrator`: that id is the coordinator graph route
  'fed-analyst': 'FED-ANALYST', // 연방 분석관 (FED-ANALYST-LOOP-AGENT · 30-min analysis · L0 OP)
  'supervisor-auditor': 'SUPERVISOR-AUDITOR', // 감독 감사관 (SUPERVISOR-AUDITOR-LOOP · fleet-audit kind · L0 OP)
  'rail-canary': 'RAIL-CANARY', // 레일 캐너리 (RAIL-CANARY-AUTO-ROLLBACK · canary.check kind · L0 OP)
};
