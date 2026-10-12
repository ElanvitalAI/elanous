export type GoalCommandExecutionKind = 'success' | 'missing-command' | 'argument-problem' | 'execution-failure';

export interface GoalCommandExecutionResult {
  readonly status: number | null;
  readonly stderr: string;
}

export interface GoalCommandExecutionClassification {
  readonly kind: GoalCommandExecutionKind;
  readonly log: string;
}

/** Classifies an already-observed Commander result without executing a command. */
export function classifyGoalCommandExecution(result: GoalCommandExecutionResult): GoalCommandExecutionClassification {
  // A clean exit is authoritative: stderr text from a successful command is not a failure signal.
  if (result.status === 0) return { kind: 'success', log: 'command completed successfully' };

  const stderr = result.stderr;
  if (stderr.includes('unknown command') || stderr.includes('unknown option')) {
    return { kind: 'missing-command', log: 'command is not recognized; this may be not yet implemented rather than a defect' };
  }
  if (stderr.includes('missing required argument') || stderr.includes('required option')) {
    return { kind: 'argument-problem', log: 'command requires a missing argument or option' };
  }
  return { kind: 'execution-failure', log: `command execution failed with code ${String(result.status)}` };
}
