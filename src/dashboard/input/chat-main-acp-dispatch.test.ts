import { expect, test } from 'bun:test';
import { dispatchDashboardChatMainAcpSend } from './chat-main-acp-dispatch.js';
import type { AcpChatHandlers } from '../chat/acp-chat.js';

test('dashboard ACP goal boundary folds each unfinished reply but preserves interleaved tools and final answer', async () => {
  const lines: string[] = [];
  const done = Promise.withResolvers<void>();
  dispatchDashboardChatMainAcpSend({
    dashboardAcpChat: {
      send: async (_backend, _message, handlers: AcpChatHandlers) => {
        handlers.appendChunk('1단계 렌더했습니다.\n아직 못 했습니다.');
        handlers.pushToolCall('도구: ScheduleWakeup');
        handlers.foldGoalInterim?.('1단계 렌더했습니다.\n아직 못 했습니다.');
        handlers.appendChunk('2단계 렌더했습니다.\n아직 못 했습니다.');
        handlers.foldGoalInterim?.('2단계 렌더했습니다.\n아직 못 했습니다.');
        handlers.pushToolCall('도구: Read');
        handlers.appendChunk('최종 영상: /tmp/final.mp4');
        handlers.onDone('end_turn');
      },
    },
    backend: 'claude', message: 'n8n 영상 만들기', attachments: [], debugEnabled: false,
    chatLines: lines, redraw: () => {}, setChatScrollToTail: () => {},
    formatAssistantLines: (text) => text.split('\n'),
    formatAssistantPrefix: () => '엘라누스:', formatUserLine: (_display, text) => text,
    formatMutedLine: (text) => text, formatToolLine: (text) => text,
    formatDebugLine: () => '', formatErrorLine: (_display, text) => text,
    onTurnDone: () => done.resolve(),
  });
  await done.promise;
  expect(lines).toEqual([
    'n8n 영상 만들기', '  · 진행 — 1단계 렌더했습니다. (접힘)', '도구: ScheduleWakeup',
    '  · 진행 — 2단계 렌더했습니다. (접힘)', '도구: Read', '  최종 영상: /tmp/final.mp4',
  ]);
});
