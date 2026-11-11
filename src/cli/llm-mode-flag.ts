/** Global provider override flags. Keep the decision in the LLM boundary while
 *  making the override explicit and inheritable by spawned child processes. */
export type LlmModeOverride = 'real' | 'fake';

export interface LlmModeFlagResult {
  mode: LlmModeOverride | undefined;
  argv: string[];
}

export function extractLlmModeFlag(argv: readonly string[]): LlmModeFlagResult {
  const remaining: string[] = [];
  let mode: LlmModeOverride | undefined;
  let afterDoubleDash = false;
  for (const arg of argv) {
    if (afterDoubleDash) { remaining.push(arg); continue; }
    if (arg === '--') { afterDoubleDash = true; remaining.push(arg); }
    else if (arg === '--real-llm') mode = 'real';
    else if (arg === '--fake-llm') mode = 'fake';
    else remaining.push(arg);
  }
  return { mode, argv: remaining };
}

/** Consume the global flag before Commander parses argv. An inherited mode is
 *  preserved when this process has no override of its own. */
export function applyLlmModeFlagFromArgv(testUniverse = false): LlmModeOverride | undefined {
  const result = extractLlmModeFlag(process.argv);
  if (result.mode !== undefined) {
    process.argv = result.argv;
    process.env.ELANOUS_LLM_MODE = result.mode;
  } else if (testUniverse && process.env.ELANOUS_LLM_MODE !== 'fake') {
    // `--test` selects the live isolated harness universe. Gate-test envs may
    // set the legacy fake switch globally, so the explicit universe wins.
    process.env.ELANOUS_LLM_MODE = 'real';
  }
  return result.mode;
}
