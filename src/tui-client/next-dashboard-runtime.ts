/** Dashboard integrations used by next TUI, loaded only after that surface is opened. */
import type { PendingTaskNotification } from '../agent/task-notification.js';
import type { VisibleMissionResult } from '../sidetab-core/visible-agent-mission.js';

export interface NextTuiMissionPairMember {
  missionId: string;
  mission: string;
  workspaceDir: string;
  startedAt: number;
  result: VisibleMissionResult;
}

export interface NextTuiMissionPairCompletionInput {
  taskId: string;
  codex: NextTuiMissionPairMember;
  claude: NextTuiMissionPairMember;
}

export interface NextTuiMissionPairCompletionResult {
  status: 'done' | 'error';
  notification?: PendingTaskNotification;
}

/** Keep the next-TUI sidetab controller on the dashboard facade, not dashboard internals. */
export async function completeNextTuiMissionPair(
  input: NextTuiMissionPairCompletionInput,
): Promise<NextTuiMissionPairCompletionResult> {
  const { enqueueClassicSidetabMissionPairCompletion } = await import('../sidetab-core/classic-sidetab-mission-job.js');
  const asClassicResult = (result: VisibleMissionResult) => ({
    ok: result.ok,
    status: result.ok ? 'completed' as const : 'failed' as const,
    ...(result.path ? { path: result.path } : {}),
    ...(result.content !== undefined ? { content: result.content } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.failureStage ? { failureStage: result.failureStage } : {}),
    ...(result.failureScreen ? { failureScreen: result.failureScreen } : {}),
  });
  let notification: PendingTaskNotification | undefined;
  const completion = await enqueueClassicSidetabMissionPairCompletion({
    codex: {
      missionId: input.codex.missionId, taskId: input.taskId, startedAt: input.codex.startedAt,
      mission: input.codex.mission, workspaceDir: input.codex.workspaceDir,
      completion: Promise.resolve(asClassicResult(input.codex.result)),
    },
    claude: {
      missionId: input.claude.missionId, taskId: input.taskId, startedAt: input.claude.startedAt,
      mission: input.claude.mission, workspaceDir: input.claude.workspaceDir,
      completion: Promise.resolve(asClassicResult(input.claude.result)),
    },
  }, item => { notification = item; });
  return { status: completion.status, ...(notification ? { notification } : {}) };
}

export async function loadNextTuiDashboardRuntime() {
  const [segments, goalContinue] = await Promise.all([
    import('../tui/turn-start-segments.js'),
    import('../tui/input/goal-continue.js'),
  ]);
  return { ...segments, ...goalContinue };
}
