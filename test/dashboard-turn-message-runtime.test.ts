import { describe, expect, test } from 'bun:test';

import { buildDashboardTurnMessage } from '../src/dashboard/turn-message-runtime.js';
import { addAttachment, createContextRegistry } from '../src/context.js';

describe('buildDashboardTurnMessage', () => {
  test('builds the question body and emits block banner lines', () => {
    const chatLines: string[] = [];
    const result = buildDashboardTurnMessage({
      userText: 'hello world',
      promptBankContext: '## Prompt Bank Context\nWindow is compact.',
      contextText: 'cwd=/tmp',
      contextRegistry: createContextRegistry(),
      terminalRegistry: {} as never,
      blockAttach: {
        banner: () => 'Attached block #7',
        consume: (msg) => `[Block #7]\n${msg}`,
      },
      pushChatLine: (line) => { chatLines.push(line); },
    });

    expect(chatLines).toHaveLength(1);
    expect(chatLines[0]).toContain('Attached block #7');
    expect(result.questionWithBlock).toContain('[Block #7]');
    expect(result.questionBody).toContain('## Prompt Bank Context');
    expect(result.questionBody).toContain('Context:\ncwd=/tmp');
    expect(result.questionBody).toContain('Question: [Block #7]');
    expect(result.userMsg.role).toBe('user');
  });

  test('sends pane token literally and still attaches file contents to the model turn', () => {
    const contextRegistry = createContextRegistry();
    const attachment = addAttachment(contextRegistry, {
      kind: 'text', sourcePath: '/tmp/notes.txt', filename: 'notes.txt',
      sizeBytes: 12, mtime: 1, text: 'FILE_CONTENT',
    });
    attachment.loaded = true;
    const legacyWindowDeps = {
      addressBook: { resolvePane: () => ({ id: 'p1', windowId: 2 }) },
      windowRegistry: {
        get: () => ({ getPane: () => ({ kind: 'terminal', capture: () => 'VIRTUAL_CAPTURE' }) }),
      },
    };
    const result = buildDashboardTurnMessage({
      userText: `@pane:p1 안녕 ${attachment.token}`,
      promptBankContext: '',
      contextText: 'ctx',
      contextRegistry,
      terminalRegistry: {} as never,
      ...legacyWindowDeps,
      blockAttach: { banner: () => null, consume: (msg) => msg },
      pushChatLine: () => {},
    });

    expect(result.expandedQuestion).toBe(`@pane:p1 안녕 ${attachment.token}`);
    expect(result.questionWithBlock).toBe(`@pane:p1 안녕 ${attachment.token}`);
    expect(result.userMsg.content).toContain('@pane:p1 안녕 [Text #1]');
    expect(result.userMsg.content).toContain('FILE_CONTENT');
    expect(result.userMsg.content).not.toContain('VIRTUAL_CAPTURE');
  });

  test('skips banner line when no block is attached', () => {
    const chatLines: string[] = [];
    const result = buildDashboardTurnMessage({
      userText: 'plain text',
      promptBankContext: '',
      contextText: 'ctx',
      contextRegistry: createContextRegistry(),
      terminalRegistry: {} as never,
      blockAttach: {
        banner: () => null,
        consume: (msg) => msg,
      },
      pushChatLine: (line) => { chatLines.push(line); },
    });

    expect(chatLines).toEqual([]);
    expect(result.questionWithBlock).toBe('plain text');
  });
});
