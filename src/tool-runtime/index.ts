// ── Public API ──
//
// import { registerAllDefaultToolRuntimes, dispatchToolByName } from './tool-runtime';

import { registerToolRuntime } from './registry.js';
import { PTY_RUNTIMES } from './pty-runtimes.js';
import { terminalInjectRuntime } from './terminal-inject-runtime.js';
import { bashRuntime } from './bash-runtime.js';
import { apiCallRuntime } from './api-call-runtime.js';
import { runShellRuntime } from './run-shell-runtime.js';
import { runTestsRuntime } from './run-tests-runtime.js';
import { dashboardStateRuntime } from './dashboard-state-runtime.js';
import { ALL_CONTEXT_RUNTIMES } from './context-runtime.js';
import { ALL_CONTROL_RUNTIMES } from './control-runtime.js';
import { ALL_TERMINAL_MODAL_RUNTIMES } from './terminal-modal-runtimes.js';
import { ALL_TERMINAL_MATRIX_RUNTIMES } from './terminal-matrix-runtimes.js';
import { ALL_CODE_EDIT_RUNTIMES } from './code-edit-runtimes.js';
import { askUserQuestionRuntime } from './ask-user-question-runtime.js';
import { updatePlanRuntime } from './update-plan-runtime.js';
import { ALL_PLAN_MODE_RUNTIMES } from './plan-mode-runtimes.js';
import { setWorkingDirRuntime } from './set-working-dir-runtime.js';
import { enterWorktreeRuntime, exitWorktreeRuntime } from './git-worktree-runtimes.js';
import { selfImplementRuntime } from '../self-implement/self-implement-runtime.js';
import { isSelfOrchestrateModelSurfaceEnabled, selfOrchestrateRuntime } from '../self-dev/self-orchestrate-runtime.js';
import { undoTurnRuntime } from './undo-turn-runtime.js';
import { ALL_SHELL_RUNNER_RUNTIMES } from './shell-runner-runtimes.js';
import { ALL_INPUT_POLICY_RUNTIMES } from './input-policy-runtimes.js';
import { ALL_AGENT_LIST_RUNTIMES } from './agent-list-runtimes.js';
import { agentRuntime } from './agent-runtime.js';
import { agentOutputRuntime } from './agent-output-runtime.js';
import { agentReplyRuntime } from './agent-reply-runtime.js';
import { agentStopRuntime } from './agent-stop-runtime.js';
import { ALL_TEAM_TOOL_RUNTIMES } from './team-tool-runtimes.js';
import { ALL_OPS_FLEET_RUNTIMES } from './ops-fleet-runtimes.js';
import { ALL_AUTO_RESEARCH_RUNTIMES } from './auto-research-runtimes.js';
import { ALL_INTELLIGENCE_MAP_RUNTIMES } from './intelligence-map-runtimes.js';
import { ALL_CFT_ANDON_RUNTIMES } from './cft-andon-runtimes.js';
import { ALL_CFT_SPC_RUNTIMES } from './cft-spc-runtimes.js';
import { ALL_CFT_FMEA_RUNTIMES } from './cft-fmea-runtimes.js';
import { ALL_CFT_RCA_RUNTIMES } from './cft-rca-runtimes.js';
import { ALL_CFT_A3_DMAIC_RUNTIMES } from './cft-a3-dmaic-runtimes.js';
import { ALL_CFT_PDCA_RUNTIMES } from './cft-pdca-runtimes.js';
import { ALL_CFT_QUICK_KILL_RUNTIMES } from './cft-quick-kill-runtimes.js';
import { ALL_CFT_ESCALATION_LADDER_RUNTIMES } from './cft-escalation-ladder-runtimes.js';
import { ALL_KNOWLEDGE_RUNTIMES } from './knowledge-runtimes.js';
import { ALL_CONDUCTOR_RUNTIMES } from './conductor-runtimes.js';
import { ALL_TOX_RUNTIMES } from '../task-orchestrator/runtimes/index.js';
import { ACP_SESSION_RUNTIMES } from './acp-session-runtime.js';
import { announceCompletionRuntime } from './announce-completion-runtime.js';
import { toolSearchRuntime } from './tool-search-runtime.js';
import { gitCommitRuntime } from './git-commit-runtime.js';
import { openPullRequestRuntime, mergePullRequestRuntime } from './git-pr-runtime.js';
import { findRepoRuntime } from './find-repo-runtime.js';
import { syncRepoRuntime } from './sync-repo-runtime.js';
import { refConsultRuntime } from './ref-consult-runtime.js';
import { refsGCRuntime } from './refs-gc-runtime.js';
import { ALL_BROWSER_RUNTIMES } from './browser-runtime.js';
import { registerWebTerminalRuntimes } from './web-terminal-runtimes.js';
import { elanousSkillsListRuntime } from './elanous-skills-list-runtime.js';
import { skillExecRuntime } from './skill-exec-runtime.js';
import { elanousObsidianSearchRuntime } from './elanous-obsidian-search-runtime.js';
import { elanousObsidianInfoRuntime } from './elanous-obsidian-info-runtime.js';
import { ELANOUS_ASANA_RUNTIMES } from './elanous-asana-runtimes.js';
import { elanousFsListRuntime } from './elanous-fs-list-runtime.js';
import { elanousFsReadRuntime } from './elanous-fs-read-runtime.js';
import { elanousShowroomBroadcastRuntime } from './elanous-showroom-broadcast-runtime.js';
import { elanousAutopilotLaunchRuntime } from './elanous-autopilot-launch-runtime.js';
import { elanousTaskSubmitRuntime } from './elanous-task-submit-runtime.js';
import { persistentGroundingRuntime } from './persistent-grounding-runtime.js';
import { goalAuthorRuntime } from './goal-author-runtime.js';
import { bootstrapMcpProxyRuntimes } from './mcp-proxy-bootstrap.js';
import { SELF_COGNITION_RUNTIMES } from './self-cognition-runtimes.js';
import { ELANOUS_CONTROL_RUNTIMES } from './elanous-control-runtimes.js';

/** Register every built-in runtime. Idempotent — safe to call more
 *  than once (registry dedupe). Call from the dashboard boot path;
 *  skills pick up registrations via side-effect when this module
 *  gets imported. */
export function registerAllDefaultToolRuntimes(): void {
  for (const rt of PTY_RUNTIMES) registerToolRuntime(rt);
  registerToolRuntime(terminalInjectRuntime);
  registerToolRuntime(bashRuntime);
  registerToolRuntime(apiCallRuntime);
  registerToolRuntime(runShellRuntime);
  // OH8 follow-up (PR-1) — multi-filter run_tests: reports unmatchedFilters so a
  // typo filter (0 files, exit 0) can no longer false-pass as a clean test run.
  registerToolRuntime(runTestsRuntime);
  registerToolRuntime(dashboardStateRuntime);
  for (const rt of ALL_CONTEXT_RUNTIMES) registerToolRuntime(rt);
  for (const rt of ALL_CONTROL_RUNTIMES) registerToolRuntime(rt);
  for (const rt of ALL_TERMINAL_MODAL_RUNTIMES) registerToolRuntime(rt);
  for (const rt of ALL_TERMINAL_MATRIX_RUNTIMES) registerToolRuntime(rt);
  for (const rt of ALL_CODE_EDIT_RUNTIMES) registerToolRuntime(rt);
  registerToolRuntime(askUserQuestionRuntime);
  registerToolRuntime(updatePlanRuntime);
  for (const rt of ALL_PLAN_MODE_RUNTIMES) registerToolRuntime(rt);
  registerToolRuntime(setWorkingDirRuntime);
  registerToolRuntime(enterWorktreeRuntime);
  registerToolRuntime(exitWorktreeRuntime);
  // self-implement P2 — 자율 구현→draft PR 툴(deferred·PR HITL fail-closed).
  registerToolRuntime(selfImplementRuntime);
  // ⛔⭐⭐ `SelfOrchestrate` 는 «모델 표면에서 내려간다»(기본 off · 대표 결정 2026-08-20).
  //   흡수가 이미 끝났다 — SelfImplement 가 goals[]/concurrency/decompose/auto_merge 를 받고
  //   그 인자가 있으면 «같은 함수»(runSelfOrchestrateCliCommand)로 간다.
  //   ⇒ 둘째 문은 «능력»이 아니라 파편화다. ⚠️ CLI(`elanous self orchestrate`)는 «남는다».
  //   🩹 되돌리기: tools.selfOrchestrate.modelSurface = true
  if (isSelfOrchestrateModelSurfaceEnabled()) registerToolRuntime(selfOrchestrateRuntime);
  registerToolRuntime(undoTurnRuntime);
  for (const rt of ALL_SHELL_RUNNER_RUNTIMES) registerToolRuntime(rt);
  for (const rt of ALL_INPUT_POLICY_RUNTIMES) registerToolRuntime(rt);
  for (const rt of ALL_AGENT_LIST_RUNTIMES) registerToolRuntime(rt);
  registerToolRuntime(agentRuntime);
  registerToolRuntime(agentOutputRuntime);
  registerToolRuntime(agentReplyRuntime);
  registerToolRuntime(agentStopRuntime);
  for (const rt of ALL_TEAM_TOOL_RUNTIMES) registerToolRuntime(rt);
  for (const rt of ALL_OPS_FLEET_RUNTIMES) registerToolRuntime(rt);
  for (const rt of ALL_AUTO_RESEARCH_RUNTIMES) registerToolRuntime(rt);
  for (const rt of ALL_INTELLIGENCE_MAP_RUNTIMES) registerToolRuntime(rt);
  for (const rt of ALL_CFT_ANDON_RUNTIMES) registerToolRuntime(rt);
  for (const rt of ALL_CFT_SPC_RUNTIMES) registerToolRuntime(rt);
  for (const rt of ALL_CFT_FMEA_RUNTIMES) registerToolRuntime(rt);
  for (const rt of ALL_CFT_RCA_RUNTIMES) registerToolRuntime(rt);
  for (const rt of ALL_CFT_A3_DMAIC_RUNTIMES) registerToolRuntime(rt);
  for (const rt of ALL_CFT_PDCA_RUNTIMES) registerToolRuntime(rt);
  for (const rt of ALL_CFT_QUICK_KILL_RUNTIMES) registerToolRuntime(rt);
  for (const rt of ALL_CFT_ESCALATION_LADDER_RUNTIMES) registerToolRuntime(rt);
  for (const rt of ALL_KNOWLEDGE_RUNTIMES) registerToolRuntime(rt);
  for (const rt of ALL_CONDUCTOR_RUNTIMES) registerToolRuntime(rt);
  for (const rt of ALL_TOX_RUNTIMES) registerToolRuntime(rt);
  for (const rt of ACP_SESSION_RUNTIMES) registerToolRuntime(rt);
  registerToolRuntime(announceCompletionRuntime);
  registerToolRuntime(toolSearchRuntime);
  registerToolRuntime(gitCommitRuntime);
  registerToolRuntime(openPullRequestRuntime);
  registerToolRuntime(mergePullRequestRuntime);
  registerToolRuntime(findRepoRuntime);
  registerToolRuntime(syncRepoRuntime);
  registerToolRuntime(refConsultRuntime);
  registerToolRuntime(refsGCRuntime);
  registerToolRuntime(persistentGroundingRuntime);
  registerToolRuntime(goalAuthorRuntime);
  for (const rt of ALL_BROWSER_RUNTIMES) registerToolRuntime(rt);
  // WT-L-1b — register the web-terminal LLM tools (List · Snapshot ·
  // Input). The runtimes were defined in WT-L-1 (#1607) but never
  // wired into the default boot, so agents couldn't drive web terminals
  // without an extra setup step. Idempotent guard inside.
  registerWebTerminalRuntimes();
  // PLAN-codex-app-server-hermes-parity §5 Phase H1·5a (2026-05-16) —
  // codex MCP callback surface. elanous_* tools are exposed only to the
  // 'mcp' surface (catalog entry), so they don't surface in TUI or
  // dashboard tool lists but the elanous-tools MCP server (src/mcp/
  // server.ts) lists them when codex queries tools/list.
  registerToolRuntime(elanousSkillsListRuntime);
  registerToolRuntime(skillExecRuntime);
  registerToolRuntime(elanousObsidianSearchRuntime);
  registerToolRuntime(elanousObsidianInfoRuntime);
  for (const rt of ELANOUS_ASANA_RUNTIMES) registerToolRuntime(rt);
  registerToolRuntime(elanousFsListRuntime);
  registerToolRuntime(elanousFsReadRuntime);
  registerToolRuntime(elanousShowroomBroadcastRuntime);
  registerToolRuntime(elanousAutopilotLaunchRuntime);
  registerToolRuntime(elanousTaskSubmitRuntime);
  for (const rt of SELF_COGNITION_RUNTIMES) registerToolRuntime(rt);
  for (const rt of ELANOUS_CONTROL_RUNTIMES) registerToolRuntime(rt);
  // External MCP proxies already declare surfaces `['mcp','tui']`, but the
  // TUI process never registered them. Fire-and-forget: handshake must not
  // block TUI startup; failures stay queryable via diagnostics.
  bootstrapMcpProxyRuntimes();
}

export { setTerminalInjectApprover } from './terminal-inject-runtime.js';
export { setPersistentGroundingRuntimeDeps } from './persistent-grounding-runtime.js';
export { setGoalAuthorRuntimeDeps } from './goal-author-runtime.js';
export { setBashRuntimeDeps } from './bash-runtime.js';
export { setWorktreeRuntimeDeps } from './git-worktree-runtimes.js';
export {
  setSelfImplementApprover,
  setSelfImplementRuntimeDeps,
  setSelfImplementSoftStopSpaceObserver,
} from '../self-implement/self-implement-runtime.js';
export {
  setTerminalSessionsGetter,
  setTerminalMouseIntentsGetter,
  setDashboardToolsGetter,
} from './dashboard-state-runtime.js';
export { setContextRuntimeDeps } from './context-runtime.js';
export { setTerminalModalRuntimeDeps } from './terminal-modal-runtimes.js';

export {
  registerToolRuntime,
  getToolRuntime,
  dispatchToolByName,
  listToolRuntimes,
  _resetToolRuntimeRegistryForTest,
} from './registry.js';

export type { ToolRuntime, ToolRuntimeContext, ToolSurface, ToolRunResult } from './types.js';
