/** One injected input trace shared by classic and next goal-interim renderer evidence. */
export const GOAL_INTERIM_USER_INPUT = '영상 만들어줘';
export const GOAL_INTERIM_NOT_DONE_REPLY = '[fake-llm] {step}단계 렌더를 진행했습니다.\n남은 작업 {step}단계: 완료 영상 경로는 아직 보고할 수 없습니다 — 아직 못 했습니다.';
export const GOAL_INTERIM_TOOL_CALL = JSON.stringify({ when: GOAL_INTERIM_USER_INPUT, name: 'ScheduleWakeup', args: { delaySeconds: 3600, reason: '렌더 점검' } });

export const GOAL_INTERIM_RENDER_TRACE = {
  userInput: GOAL_INTERIM_USER_INPUT,
  interimReplies: [1, 2].map((step) => GOAL_INTERIM_NOT_DONE_REPLY.replaceAll('{step}', String(step))),
  finalReply: '완료 영상: /tmp/final.mp4',
  toolCalls: ['ScheduleWakeup', 'ScheduleWakeup progress', 'ScheduleWakeup progress'],
} as const;

export function goalInterimRenderMessages(ts: string) {
  const trace = GOAL_INTERIM_RENDER_TRACE;
  return [
    { role: 'user' as const, content: trace.userInput, ts },
    { role: 'tool' as const, content: '', toolName: trace.toolCalls[0], toolResult: '예약됨', ts },
    { role: 'tool' as const, content: '', toolName: trace.toolCalls[1], toolResult: '진행', ts },
    { role: 'assistant' as const, goalInterim: true, content: trace.interimReplies[0], ts },
    { role: 'tool' as const, content: '', toolName: trace.toolCalls[2], toolResult: '진행', ts },
    { role: 'assistant' as const, goalInterim: true, content: trace.interimReplies[1], ts },
    { role: 'assistant' as const, content: trace.finalReply, ts },
  ];
}
