export {
  SlashCommandRegistry,
  type SlashDispatchOutcome,
  type SlashHandler,
  type SlashHandlerReturn,
} from './registry.js';
export {
  buildDashboardSlashRegistry,
  runDeferredSkillToolSlash,
  _setSelfOrchestrateSlashRuntimeForTesting,
  type DashboardSlashContext,
  type DashboardSlashReturn,
  type SkillToolSlashExecutor,
  type SkillToolSlashResult,
} from './dashboard-handlers.js';
// TUI-SLASH-SPLIT-MISSION(D4b) — 새 집 src/tui/slash/mission.ts 의 공개 심볼을 옛 입구에서도 낸다(re-export shim · RFC A5).
export {
  handleMissionSlash,
  registerMissionSlash,
  type MissionSlashContext,
} from '../../tui/slash/mission.js';
// TUI-SLASH-SPLIT-TERM(D4b) — 새 집 src/tui/slash/term.ts 의 공개 심볼을 옛 입구에서도 낸다(re-export shim · RFC A5).
export {
  handleTermSlash,
  registerTermSlash,
  type TermSlashContext,
  type TermSlashHost,
} from '../../tui/slash/term.js';
