import type { LLMToolSpec } from '../../llm/tool-spec.js';
// Step 2 next-stone (BACKLOG §8.6.b · 2026-04-30) — default dashboard
// tool builders factory. Extracts the inline `require()` block in
// src/dashboard/index.ts (~50 lines) that wires the standard tool
// builders (PTY / bash / terminal-inject / api-call / run-shell /
// dashboard-state / terminal-modal) into the `buildDashboardOptionalToolSpecs`
// runtime.
//
// Future Step 2 (full `runDashboardChatMainPlainTurn` extract) will
// route through this factory so the orchestrator stays clean. For
// now the dashboard `let plainTurnSettled` site simply spreads the
// returned object into `buildDashboardOptionalToolSpecs`.


import type { DashboardOptionalToolSpecRuntimeDeps } from '../optional-tool-spec-runtime.js';

/** Slim subset of `DashboardOptionalToolSpecRuntimeDeps` produced by
 *  the factory — caller still supplies `userConfig`, `ptyAvailable`,
 *  `termSize`, `registerAllDefaultToolRuntimes`,
 *  `setTerminalModalRuntimeDeps` because those depend on the
 *  dashboard's lazy `import('../tool-runtime/index.js')` + per-turn
 *  state. The factory only owns the deterministic builder closures. */
export type DashboardDefaultToolBuilders = Pick<
  DashboardOptionalToolSpecRuntimeDeps,
  | 'buildBashTool'
  | 'buildTerminalInjectTool'
  | 'buildApiCallTool'
  | 'buildRunShellTool'
  | 'buildDashboardStateTool'
  | 'buildTerminalModalTools'
>;

/** Build the standard dashboard tool builders. Each closure lazy-
 *  requires the actual implementation at first call so a TUI boot
 *  that doesn't dispatch a turn never loads the tool modules.
 *
 *  The lazy `require()` pattern matches the pre-extract behaviour
 *  exactly — moving the requires here doesn't change which side
 *  of the boot pays the import cost. */
export function buildDefaultDashboardToolBuilders(): DashboardDefaultToolBuilders {
  return {
    buildBashTool: (): LLMToolSpec => {
      const mod = require('../../skills/tools/index.js') as typeof import('../../skills/tools/index.js');
      return mod.buildBashTool();
    },
    buildTerminalInjectTool: (): LLMToolSpec => {
      const mod = require('../../skills/tools/terminal-modal-inject.js') as typeof import('../../skills/tools/terminal-modal-inject.js');
      return mod.buildTerminalModalInjectTool();
    },
    buildApiCallTool: (): LLMToolSpec => {
      const mod = require('../../skills/tools/api-call.js') as typeof import('../../skills/tools/api-call.js');
      return mod.buildApiCallTool();
    },
    buildRunShellTool: (): LLMToolSpec => {
      const mod = require('../../skills/tools/shell.js') as typeof import('../../skills/tools/shell.js');
      return mod.buildRunShellTool();
    },
    buildDashboardStateTool: (): LLMToolSpec => {
      const mod = require('../../skills/tools/dashboard-state.js') as typeof import('../../skills/tools/dashboard-state.js');
      return mod.buildGetDashboardStateTool();
    },
    buildTerminalModalTools: (): LLMToolSpec[] => {
      const tm = require('../../skills/tools/terminal-modal.js') as typeof import('../../skills/tools/terminal-modal.js');
      return [
        tm.buildTerminalModalListTool(),
        tm.buildTerminalModalObserveTool(),
        tm.buildTerminalModalFocusTool(),
        tm.buildTerminalModalDetachTool(),
        tm.buildTerminalModalKillTool(),
      ];
    },
  };
}
