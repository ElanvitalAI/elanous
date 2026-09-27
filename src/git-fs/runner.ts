import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { runGitWithRetry, type GitRunResult, type GitRunner } from './retry.js';

export type GitCommandOptions = SpawnSyncOptions;
export type GitCommandRunner = (cwd: string, args: string[], options: GitCommandOptions) => GitRunResult;

let testRunner: GitCommandRunner | undefined;

/** Installs a process-free runner for behavioral tests of callers such as undo-turn. */
export function setGitCommandRunnerForTesting(runner: GitCommandRunner | undefined): void {
  testRunner = runner;
}

function outputText(output: string | Buffer | undefined | null): string {
  return output == null ? '' : output.toString();
}

/** Runs one Git command in cwd through the shared lock-contention retry seam.
 * The complete structured result is retained so callers can distinguish
 * command failure from an empty command output. */
export function runGitCommand(
  cwd: string,
  args: string[],
  options: GitCommandOptions = {},
  runner?: GitRunner,
): GitRunResult {
  const run = runner ?? ((gitArgs: string[]): GitRunResult => {
    if (testRunner) return testRunner(cwd, gitArgs, options);
    const result = spawnSync('git', gitArgs, { ...options, cwd });
    return {
      status: result.status,
      ...(result.signal ? { signal: result.signal } : {}),
      stdout: outputText(result.stdout),
      stderr: outputText(result.stderr),
    };
  });
  return runGitWithRetry(args, run);
}
