import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { createTaskPluginWizardHostDeps, type TaskPluginWizardHostResult } from '../cli/task-plugin-wizard-host.js';
import { defaultTaskLauncher } from '../cli/tasks-cli.js';
import { handTask, type HandTaskOptions } from '../task-agent/task-hand.js';
import { TASK_CARD_PREFIX } from '../task-agent/task-card-prefix.js';
import type { PluginMaker, PluginWizardDeps } from '../graph-wizard/mission-compose.js';
import { createTuiPluginWizardTool, type TuiPluginWizardTool } from './plugin-wizard-tool.js';
import type { TuiPluginWizardRequest } from './plugin-wizard-tool.js';

export interface DashboardPluginWizardRuntimePorts {
  runMissionPair: (request: {
    runId: string;
    prompt: string;
    context?: TuiPluginWizardRequest['context'];
  }) => Promise<Partial<Record<PluginMaker, TaskPluginWizardHostResult>>>;
  getWorkspace: () => string;
  taskHand?: (options: HandTaskOptions) => Promise<unknown>;
  launcher?: HandTaskOptions['launcher'];
  onEvent?: PluginWizardDeps['onEvent'];
}

/** Connect the TUI entry tool to handTask and the existing plugin composer without blocking the ACP turn. */
export function createDashboardPluginWizardRuntime(ports: DashboardPluginWizardRuntimePorts): TuiPluginWizardTool {
  return createTuiPluginWizardTool(async (request) => {
    const pluginWizardDeps = createTaskPluginWizardHostDeps({
      runMissionPair: ({ prompt }) => ports.runMissionPair({ runId: request.runId, prompt, ...(request.context ? { context: request.context } : {}) }),
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
  });
}
