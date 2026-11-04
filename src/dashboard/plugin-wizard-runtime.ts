import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { createTaskPluginWizardHostDeps, type TaskPluginWizardHostResult } from '../cli/task-plugin-wizard-host.js';
import { defaultTaskLauncher } from '../cli/tasks-cli.js';
import { handTask, type HandTaskOptions } from '../task-agent/task-hand.js';
import { TASK_CARD_PREFIX } from '../task-agent/task-card-prefix.js';
import type { ClassicSidetabMissionIntegration } from './classic-sidetab-mission.js';
import type { ClassicSidetabMissionPairCompletionResult } from './classic-sidetab-mission-job.js';
import type { PluginMaker, PluginWizardDeps, PluginWizardPairDecomposition } from '../graph-wizard/mission-compose.js';
import { createTuiPluginWizardTool, type TuiPluginWizardTool } from './plugin-wizard-tool.js';
import type { TuiPluginWizardRequest } from './plugin-wizard-tool.js';
import { dispatchToolSearch } from '../skills/tools/tool-search.js';
import { filterAvailableToolSpecs } from '../session-runtime/index.js';
import type { LLMToolSpec } from '../llm.js';

/** Search only the tools that pass the session runtime's availability guard. */
export function searchAvailablePluginWizardTools(
  capability: string,
  specs: readonly LLMToolSpec[],
  toolAvailability?: Readonly<Record<string, boolean>>,
): string[] {
  const searchable = filterAvailableToolSpecs(specs, toolAvailability)
    .filter(spec => spec.name !== 'ToolSearch' && spec.name !== 'StartPluginWizard');
  return dispatchToolSearch({ query: capability, max_results: 25 }, { specs: searchable }).matched;
}
export interface DashboardPluginWizardRuntimePorts {
  pair: {
    dispatchTool: ClassicSidetabMissionIntegration['dispatchTool'];
    completions: Map<string, Promise<ClassicSidetabMissionPairCompletionResult>>;
  };
  getWorkspace: () => string;
  taskHand?: (options: HandTaskOptions) => Promise<unknown>;
  launcher?: HandTaskOptions['launcher'];
  onEvent?: PluginWizardDeps['onEvent'];
  findAvailableTools?: (capability: string) => readonly string[];
}

type PluginWizardPairRequest = {
  runId: string;
  prompt: string;
  decomposition: PluginWizardPairDecomposition;
  context?: TuiPluginWizardRequest['context'];
};

/** The production RunSidetabMission adapter used by the dashboard entrypoint. */
export function createTuiPluginWizardPairRunner(
  dispatchTool: ClassicSidetabMissionIntegration['dispatchTool'],
  completions: Map<string, Promise<ClassicSidetabMissionPairCompletionResult>>,
): (request: PluginWizardPairRequest) => Promise<Partial<Record<PluginMaker, TaskPluginWizardHostResult>>> {
  return async ({ runId, prompt, decomposition, context }) => {
    const pairCallId = `plugin-wizard:${runId}`;
    const started = await dispatchTool('RunSidetabMission', {
      agent: 'codex', mission: prompt, decomposition,
    }, { callId: pairCallId, ...(context?.parentSessionId ? { parentSessionId: context.parentSessionId } : {}) });
    const completion = completions.get(pairCallId);
    if (!completion || started?.status === 'error') {
      completions.delete(pairCallId);
      throw new Error(started?.body ?? 'Codex/Claude pair did not start');
    }
    try {
      const result = await completion;
      return {
        codex: { ok: result.codex.ok, ...(result.codex.content ? { content: result.codex.content } : {}), ...(result.codex.error ? { error: result.codex.error } : {}) },
        claude: { ok: result.claude.ok, ...(result.claude.content ? { content: result.claude.content } : {}), ...(result.claude.error ? { error: result.claude.error } : {}) },
      };
    } finally { completions.delete(pairCallId); }
  };
}

/** Connect the TUI entry tool to handTask and the existing plugin composer without blocking the ACP turn. */
export function createDashboardPluginWizardRuntime(ports: DashboardPluginWizardRuntimePorts): TuiPluginWizardTool {
  const runMissionPair = createTuiPluginWizardPairRunner(ports.pair.dispatchTool, ports.pair.completions);
  return createTuiPluginWizardTool(async (request) => {
    const pluginWizardDeps = createTaskPluginWizardHostDeps({
      wizardId: request.runId,
      runMissionPair: ({ prompt, decomposition }) => runMissionPair({ runId: request.runId, prompt, decomposition, ...(request.context ? { context: request.context } : {}) }),
      onEvent: ports.onEvent ?? ((event) => {
        if (event.step !== 'validate' || !event.detail || typeof event.detail !== 'object') return;
        const winner = (event.detail as { winner?: unknown }).winner;
        if (winner) debug.log('wizard.validate', 'winner-adopted', { runId: event.wizardId, ts: event.ts, winner });
      }),
    });
    const runHandTask = ports.taskHand ?? handTask;
    await runHandTask({
      id: `${TASK_CARD_PREFIX}plugin-${request.runId.replaceAll('-', '').slice(0, 20)}`,
      text: request.mission,
      seat: 'TC',
      live: true,
      launcher: ports.launcher ?? defaultTaskLauncher,
      pluginWizard: {
        missing: request.missing,
        root: effectiveInstanceRoot(),
        workspace: ports.getWorkspace(),
        wizardId: request.runId,
      },
      pluginWizardDeps,
    });
  }, { findAvailableTools: ports.findAvailableTools });
}

/** Build the dashboard wizard with the same classic sidetab wiring used by the TUI entrypoint. */
export function createDashboardPluginWizardRuntimeFromSidetab(
  sidetab: ClassicSidetabMissionIntegration,
  completions: Map<string, Promise<ClassicSidetabMissionPairCompletionResult>>,
  ports: Omit<DashboardPluginWizardRuntimePorts, 'pair'>,
): TuiPluginWizardTool {
  return createDashboardPluginWizardRuntime({
    ...ports,
    pair: { dispatchTool: sidetab.dispatchTool, completions },
  });
}
