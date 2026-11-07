import { describe, expect, test } from 'bun:test';

import { dispatchDashboardChatMainAcpSend } from '../src/dashboard/input/chat-main-acp-dispatch.js';

describe('dashboard chat main acp dispatch', () => {
  test('streams assistant content into the chat buffer with prefix, tool call, and debug trailer', async () => {
    const chatLines: string[] = [];
    const redraws: string[] = [];

    dispatchDashboardChatMainAcpSend({
      dashboardAcpChat: {
        send: async (_backend, _message, handlers) => {
          handlers.pushLine('  -> sending');
          handlers.appendChunk('Hello');
          handlers.pushToolCall('tool: read_file');
          handlers.appendChunk('World');
          handlers.onDone('completed');
        },
      },
      backend: 'claude',
      message: 'hi',
      attachments: [],
      debugEnabled: true,
      chatLines,
      setChatScrollToTail: () => {},
      redraw: () => { redraws.push('redraw'); },
      formatAssistantLines: (text) => [text],
      formatUserLine: (display, message) => `user:${display}:${message}`,
      formatMutedLine: (line) => `muted:${line}`,
      formatToolLine: (tool) => `tool:${tool}`,
      formatDebugLine: (display, reason, chars) => `debug:${display}:${reason}:${chars}`,
      formatErrorLine: (display, message) => `error:${display}:${message}`,
      formatAssistantPrefix: (display) => `assistant:${display}`,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chatLines).toEqual([
      'user:claude:hi',
      'muted:  -> sending',
      'assistant:claude Hello',
      'tool:tool: read_file',
      '  World',
      'debug:claude:completed:10',
    ]);
    expect(redraws).toEqual(['redraw']);
  });

  test('surfaces errors through the provided formatter', async () => {
    const chatLines: string[] = [];

    dispatchDashboardChatMainAcpSend({
      dashboardAcpChat: {
        send: async (_backend, _message, handlers) => {
          handlers.onError(new Error('boom'));
        },
      },
      backend: 'gemini',
      message: 'hi',
      attachments: [],
      debugEnabled: false,
      chatLines,
      setChatScrollToTail: () => {},
      redraw: () => {},
      formatAssistantLines: (text) => [text],
      formatUserLine: (display, message) => `user:${display}:${message}`,
      formatMutedLine: (line) => line,
      formatToolLine: (tool) => tool,
      formatDebugLine: (_display, _reason, _chars) => '',
      formatErrorLine: (display, message) => `error:${display}:${message}`,
      formatAssistantPrefix: (display) => `assistant:${display}`,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chatLines).toEqual([
      'user:gemini:hi',
      'error:gemini:boom',
    ]);
  });

});
