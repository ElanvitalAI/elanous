import type { LLMToolSpec } from '../llm/tool-spec.js';

import type { UserConfig } from '../user-config.js';
import { debug } from '../debug/log.js';

export interface DashboardOptionalToolSpecRuntimeDeps {
  userConfig: UserConfig;
  // ⛔ PTY 가용성은 이 모듈의 관심사가 아니다 — PtyShell spec 은 tool-runtime 이 낸다.
  //    정본은 `pty-shell/registry.ts` 의 `ptyAvailable()`.
  termSize: () => { cols: number; rows: number };
  registerAllDefaultToolRuntimes: () => void;
  setTerminalModalRuntimeDeps: (deps: { termSize: () => { cols: number; rows: number } }) => void;
  buildBashTool: () => LLMToolSpec;
  buildTerminalInjectTool: () => LLMToolSpec;
  buildApiCallTool: () => LLMToolSpec;
  buildRunShellTool: () => LLMToolSpec;
  buildDashboardStateTool: () => LLMToolSpec;
  buildTerminalModalTools: () => LLMToolSpec[];
}

export function buildDashboardOptionalToolSpecs(
  deps: DashboardOptionalToolSpecRuntimeDeps,
): LLMToolSpec[] {
  // PtyShell specs come from PTY_RUNTIMES after this registration. Those
  // runtimes own the operational dispatch (`run()`), so optional specs must
  // not rebuild the same five names and duplicate the TUI catalog. The
  // native-tool-catalog PtyShell aliases only resolve names to these registered
  // runtimes in getToolRuntime(); they are not another spec source.
  deps.registerAllDefaultToolRuntimes();
  // Umbrella kill-switch — when `shell.allowDashboardOptionalTools`
  // is explicitly false, return ZERO dashboard-scoped optional tools.
  // Stabilization mode (2026-05-03 PM++): TUI tool exposure
  // (DashboardState always-on + TerminalModal always-added)
  // diverges from JSON-test (`elanous repro`) tool exposure and
  // confounds codex behavior measurement. Flipping this off makes
  // TUI use ONLY host tools — same set the JSON path uses.
  if (deps.userConfig.shell.allowDashboardOptionalTools === false) {
    // Umbrella off — but keep Bash alive when its dedicated toggle is
    // on. User-stated invariant (2026-05-04): "Bash must survive even
    // when the umbrella drops everything else, since Read+Bash form
    // the minimum file-IO+command surface needed for chatlog
    // debugging." `shell.allowDashboardBash` still gates the survival
    // — explicit user opt-out wins over the umbrella exception.
    const survivors: LLMToolSpec[] = [];
    if (deps.userConfig.shell.allowDashboardBash === true) {
      survivors.push(deps.buildBashTool());
    }
    if (debug.enabled) {
      debug.log('llm.tool-exposure', 'dashboard-optional-specs.short-circuited', {
        reason: 'allowDashboardOptionalTools=false',
        survivors: survivors.map(s => s.name),
        bashSurvived: survivors.some(s => s.name === 'Bash'),
        bashGate: deps.userConfig.shell.allowDashboardBash === true,
      });
    }
    return survivors;
  }
  const specs: LLMToolSpec[] = [];
  const decisions: Record<string, { enabled: boolean; reason?: string; count?: number }> = {};

  if (deps.userConfig.shell.allowDashboardBash === true) {
    specs.push(deps.buildBashTool());
    decisions.bash = { enabled: true, count: 1 };
  } else {
    decisions.bash = { enabled: false, reason: 'allowDashboardBash=false' };
  }

  if (deps.userConfig.shell.allowDashboardTerminalInject === true) {
    specs.push(deps.buildTerminalInjectTool());
    decisions.terminalInject = { enabled: true, count: 1 };
  } else {
    decisions.terminalInject = { enabled: false, reason: 'allowDashboardTerminalInject=false' };
  }

  if (deps.userConfig.shell.allowDashboardApiCall === true) {
    specs.push(deps.buildApiCallTool());
    decisions.apiCall = { enabled: true, count: 1 };
  } else {
    decisions.apiCall = { enabled: false, reason: 'allowDashboardApiCall=false' };
  }

  if (deps.userConfig.shell.allowDashboardRunShell === true) {
    specs.push(deps.buildRunShellTool());
    decisions.runShell = { enabled: true, count: 1 };
  } else {
    decisions.runShell = { enabled: false, reason: 'allowDashboardRunShell=false' };
  }

  if (deps.userConfig.shell.allowDashboardState !== false) {
    specs.push(deps.buildDashboardStateTool());
    decisions.dashboardState = { enabled: true, count: 1 };
  } else {
    decisions.dashboardState = { enabled: false, reason: 'allowDashboardState=false' };
  }

  // TerminalModalTools — currently unconditionally added when umbrella
  // is on. Future per-tool flag could gate this too; logged here so
  // the forensic trace lists every contributor explicitly.
  const terminalModalTools = deps.buildTerminalModalTools();
  specs.push(...terminalModalTools);
  decisions.terminalModal = { enabled: true, count: terminalModalTools.length };

  deps.setTerminalModalRuntimeDeps({ termSize: deps.termSize });

  if (debug.enabled) {
    debug.log('llm.tool-exposure', 'dashboard-optional-specs.return', {
      total: specs.length,
      names: specs.map(s => s.name),
      decisions,
      umbrellaOn: true,
    });
  }

  return specs;
}
