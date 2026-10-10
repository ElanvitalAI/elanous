import '../autopilot/mission-codebase-gate.js';
import { readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import type { LLMToolSpec } from '../llm.js';
import {
  groundForGoalAuthor,
  resolveGoalAuthorPersistentGrounding,
  requiresImplementationTargetClarification,
  IMPLEMENTATION_TARGET_CLARIFICATION,
  writeAuthoredGoal,
  type GoalAuthorDeps,
  type GoalAuthorGroundingDeps,
  type GoalFileDeps,
} from '../self-implement/goal-author.js';
import { enhancePrompt } from '../prompt-enhance/enhance.js';
import { groundGoalAuthoringContext, type GoalAuthoringGroundingDeps } from '../self-implement/goal-authoring-grounding.js';
import type { ToolRuntime, ToolRuntimeContext } from './types.js';

interface GoalAuthorArgs {
  ask: string;
  cwd?: string;
  parentGoalFile?: string;
  parentQuestionId?: string;
}

interface GoalAuthorRuntimeDeps {
  groundForGoalAuthor?: typeof groundForGoalAuthor;
  grounding?: GoalAuthorGroundingDeps;
  goalAuthoringGrounding?: GoalAuthoringGroundingDeps;
  groundGoalAuthoringContext?: typeof groundGoalAuthoringContext;
  writeAuthoredGoal?: typeof writeAuthoredGoal;
  enhance?: GoalAuthorDeps['enhance'];
  slugFn?: GoalAuthorDeps['slugFn'];
  fileDeps?: GoalFileDeps;
}

interface GoalAuthorRunResult {
  output: string;
  path: string | null;
  document: string | null;
  grounded: boolean;
}

function readParentDocument(cwd: string, goalFile: string): string {
  if (isAbsolute(goalFile)) throw new Error('parent goal file must be repository-relative');
  const root = resolve(cwd);
  const path = resolve(root, goalFile);
  const fromRoot = relative(root, path);
  if (fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('parent goal file must stay within the repository');
  }
  return readFileSync(path, 'utf8');
}

function buildGoalAuthorTool(): LLMToolSpec {
  return {
    name: 'GoalAuthor',
    description: 'Author one grounded goal document with PROBLEM, WHAT TO BUILD, RULES, and ACCEPTANCE CRITERIA blocks. It only creates a goal document; it does not modify repository code or start implementation.',
    parameters: {
      type: 'object',
      properties: {
        ask: { type: 'string', description: 'The development request to preserve verbatim and turn into a grounded goal document.' },
        cwd: { type: 'string', description: 'Repository root. Defaults to the current working directory.' },
        parentGoalFile: { type: 'string', description: 'Repository-relative path of the parent goal document. Requires parentQuestionId.' },
        parentQuestionId: { type: 'string', description: 'Unresolved-question ID in the parent goal document. Requires parentGoalFile.' },
      },
      required: ['ask'],
      additionalProperties: false,
    },
  };
}

async function runGoalAuthor(
  req: GoalAuthorArgs,
  _ctx: ToolRuntimeContext,
  deps: GoalAuthorRuntimeDeps,
): Promise<GoalAuthorRunResult> {
  const ask = typeof req.ask === 'string' ? req.ask : '';
  if (!ask.trim()) {
    return {
      output: 'GoalAuthor requires a non-empty ask.',
      path: null,
      document: null,
      grounded: false,
    };
  }

  const cwd = typeof req.cwd === 'string' && req.cwd ? req.cwd : process.cwd();
  if (Boolean(req.parentGoalFile) !== Boolean(req.parentQuestionId)) {
    throw new Error('parent goal file and parent question id must be supplied together');
  }
  const parent = req.parentGoalFile && req.parentQuestionId
    ? { goalFile: req.parentGoalFile, questionId: req.parentQuestionId }
    : undefined;
  const ground = deps.groundForGoalAuthor ?? groundForGoalAuthor;
  const resolvedGrounding = resolveGoalAuthorPersistentGrounding(deps.grounding);
  const grounding = await ground(ask, cwd, resolvedGrounding.deps);
  const groundContext = deps.groundGoalAuthoringContext ?? groundGoalAuthoringContext;
  const hasRepositoryEvidence = grounding.facts.files.length > 0 || grounding.facts.documentFacts.length > 0;
  const authoringGrounding = hasRepositoryEvidence
    ? {
      ...deps.goalAuthoringGrounding,
      repositoryRoot: cwd,
      repositoryGrounding: async () => grounding.facts,
    }
    : {
      ...deps.goalAuthoringGrounding,
      repositoryRoot: cwd,
    };
  const authoringContext = await groundContext(ask, authoringGrounding);
  if (requiresImplementationTargetClarification(grounding.facts, ask, false, cwd)) {
    return {
      output: IMPLEMENTATION_TARGET_CLARIFICATION,
      path: null,
      document: null,
      grounded: grounding.facts.grounded,
    };
  }
  if (!authoringContext.documentLines.length) {
    throw new Error('GoalAuthor requires non-empty grounding evidence');
  }
  const write = deps.writeAuthoredGoal ?? writeAuthoredGoal;
  const result = await write(ask, cwd, {
    ground: async () => grounding.facts,
    enhance: deps.enhance ?? enhancePrompt,
    groundingEvidence: authoringContext.documentLines,
    repositoryRoot: cwd,
    ...(deps.slugFn && { slugFn: deps.slugFn }),
    ...(parent && { parent, parentDocument: readParentDocument(cwd, parent.goalFile) }),
  }, deps.fileDeps);

  return {
    output: `GoalAuthor wrote ${result.path}.`,
    path: result.path,
    document: result.authored.document,
    grounded: result.authored.grounded,
  };
}

let defaultRuntimeDeps: GoalAuthorRuntimeDeps = {};

/** Configure the default runtime's authoring seams; used by isolated deterministic tests. */
export function setGoalAuthorRuntimeDeps(deps: GoalAuthorRuntimeDeps = {}): void {
  defaultRuntimeDeps = deps;
}

export const goalAuthorRuntime: ToolRuntime<GoalAuthorArgs, GoalAuthorRunResult> = {
  id: 'goal_author',
  spec: buildGoalAuthorTool(),
  run: (req, ctx) => runGoalAuthor(req, ctx, defaultRuntimeDeps),
};
