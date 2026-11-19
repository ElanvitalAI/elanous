import type { PendingTaskNotification, TaskNotificationQueue } from '../agent/task-notification.js';
import { emitTurnLife } from '../debug/turn-life.js';
import { encodeCapsuleFrame } from './capsule-frame.js';

/** Mid-run matching lines are progress, never completion. The child keeps the full notification for the next turn. */
export function watchShellLineFrames(
  sessionId: string,
  queue: Pick<TaskNotificationQueue, 'onEnqueue'>,
  write: (frame: string) => void,
): () => void {
  return queue.onEnqueue((notice: PendingTaskNotification) => {
    if (!notice.taskId.startsWith('shell-watch:') || notice.state !== 'running'
      || (notice.parentSessionId !== undefined && notice.parentSessionId !== sessionId)) return;
    write(encodeCapsuleFrame({ type: 'capsule-progress', capsuleId: notice.taskId,
      kind: 'shell', sessionId, at: notice.finishedAt, line: notice.output }));
    emitTurnLife('turn-life:watch-emitted', { source: 'watch', eventId: notice.taskId, arrivedAt: notice.finishedAt });
  });
}
