import { randomUUID } from 'node:crypto';
import { debug } from '../debug/log.js';
import type { LLMToolSpec } from '../llm.js';
import type { ClassicSidetabMissionDispatchContext } from './classic-sidetab-mission.js';

export const TUI_PLUGIN_WIZARD_TOOL_NAME = 'StartPluginWizard';

export interface TuiPluginWizardRequest {
  runId: string;
  mission: string;
  missing: string;
  context?: ClassicSidetabMissionDispatchContext;
}

export interface TuiPluginWizardTool {
  getTools(existing: readonly LLMToolSpec[]): LLMToolSpec[];
  dispatchTool(name: string, args: unknown, context?: ClassicSidetabMissionDispatchContext): Promise<unknown> | undefined;
}

/** Add a non-blocking TUI entry point; the injected host runs the shared task/plugin-wizard path. */
export function createTuiPluginWizardTool(start: (request: TuiPluginWizardRequest) => Promise<void>, createId: () => string = randomUUID): TuiPluginWizardTool {
  const spec: LLMToolSpec = {
    name: TUI_PLUGIN_WIZARD_TOOL_NAME,
    description: 'When a needed capability is missing, start the plugin wizard in this TUI session. It asks a short question, searches trusted plugins, and if needed launches the visible Codex and Claude side-tab pair. Returns a run ID immediately; check the task notification for completion.',
    parameters: {
      type: 'object',
      properties: {
        mission: { type: 'string', minLength: 1, description: 'The active task to complete after installing or creating the tool.' },
        missing: { type: 'string', minLength: 1, description: 'The missing tool or capability.' },
      },
      required: ['mission', 'missing'],
      additionalProperties: false,
    },
  };

  return {
    getTools: (existing) => [...existing, spec],
    dispatchTool(name, args, context) {
      if (name !== TUI_PLUGIN_WIZARD_TOOL_NAME) return undefined;
      const output = (status: 'running' | 'error', body: string, id: string | null = null) => ({ status, body, artifacts: [], id });
      if (!args || typeof args !== 'object' || Array.isArray(args)) return Promise.resolve(output('error', 'arguments must be an object'));
      const input = args as Record<string, unknown>;
      if (Object.keys(input).some((key) => key !== 'mission' && key !== 'missing')) return Promise.resolve(output('error', 'arguments contain unsupported fields'));
      const mission = typeof input.mission === 'string' ? input.mission.trim() : '';
      const missing = typeof input.missing === 'string' ? input.missing.trim() : '';
      if (!mission || !missing) return Promise.resolve(output('error', 'mission and missing capability are required'));
      const runId = createId();
      void Promise.resolve().then(() => start({ runId, mission, missing, ...(context ? { context } : {}) })).catch((error) => {
        try { debug.log('plugin-wizard.tool', 'start-failed', { runId, reason: error instanceof Error ? error.message : String(error) }, { level: 'error' }); }
        catch { /* failure reporting must not re-enter the tool boundary */ }
      });
      return Promise.resolve(output('running', `Plugin wizard started in the background (run ${runId}).`, runId));
    },
  };
}
