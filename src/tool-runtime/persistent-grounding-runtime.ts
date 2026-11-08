import type { LLMToolSpec } from '../llm/tool-spec.js';
import { resolve } from 'node:path';

import {
  groundPersistently,
  type PersistentGroundingDeps,
  type PersistentGroundingResult,
} from '../skills/tools/persistent-grounding.js';
import { withAmbientSessionScope } from '../debug/log.js';
import type { ToolRuntime, ToolRuntimeContext } from './types.js';

interface PersistentGroundingArgs {
  goal: string;
  cwd?: string;
}

interface PersistentGroundingRuntimeDeps {
  groundPersistently?: typeof groundPersistently;
  grounding?: PersistentGroundingDeps;
}

interface PersistentGroundingRunResult {
  output: string;
  result: PersistentGroundingResult | null;
}

function buildPersistentGroundingTool(): LLMToolSpec {
  return {
    name: 'PersistentGrounding',
    description: 'Run a bounded, read-only repository grounding loop. It uses Grep, Glob, ListDir, AstGrep, and Read to find implementation candidates that it has actually read.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Repository implementation question to ground.' },
        cwd: { type: 'string', description: 'Repository root. Defaults to the current working directory.' },
      },
      required: ['goal'],
      additionalProperties: false,
    },
  };
}

async function runPersistentGrounding(
  req: PersistentGroundingArgs,
  ctx: ToolRuntimeContext,
  deps: PersistentGroundingRuntimeDeps,
): Promise<PersistentGroundingRunResult> {
  const goal = typeof req.goal === 'string' ? req.goal.trim() : '';
  if (!goal) return { output: 'PersistentGrounding requires a non-empty goal.', result: null };
  const cwd = resolve(typeof req.cwd === 'string' && req.cwd.trim() ? req.cwd : process.cwd());
  const runGrounding = deps.groundPersistently ?? groundPersistently;
  const sessionId = deps.grounding?.sessionId ?? ctx.sessionId ?? `persistent-grounding-${Date.now()}`;
  const result = await withAmbientSessionScope(sessionId, () => runGrounding(goal, cwd, {
    ...deps.grounding,
    sessionId,
  }));
  return {
    output: result
      ? `PersistentGrounding found ${result.files.length} verified candidate(s) in ${result.iterations} iteration(s): ${result.files.join(', ')}`
      : 'PersistentGrounding found no verified implementation candidates.',
    result,
  };
}


let defaultRuntimeDeps: PersistentGroundingRuntimeDeps = {};

/** Configure the default runtime's loop seam; used by isolated deterministic tests. */
export function setPersistentGroundingRuntimeDeps(deps: PersistentGroundingRuntimeDeps = {}): void {
  defaultRuntimeDeps = deps;
}

export const persistentGroundingRuntime: ToolRuntime<PersistentGroundingArgs, PersistentGroundingRunResult> = {
  id: 'persistent_grounding',
  spec: buildPersistentGroundingTool(),
  run: (req, ctx) => runPersistentGrounding(req, ctx, defaultRuntimeDeps),
};
