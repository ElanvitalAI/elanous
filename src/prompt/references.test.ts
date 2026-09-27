import { expect, test } from 'bun:test';
import { expandPromptReferences } from './references.js';
import { buildDashboardTurnMessage } from '../dashboard/turn-message-runtime.js';
import { addAttachment, createContextRegistry } from '../context.js';
import type { TerminalSessionRegistry } from '../terminal/session-registry.js';

test('pane and window tokens stay literal even if legacy window deps are supplied', () => {
  const terminalRegistry = {
    get: (id: string) => id === 'term-session:1' ? session : undefined,
    list: () => [session],
  } as unknown as TerminalSessionRegistry;
  const session = {
    id: 'term-session:1', title: 'terminal', cwd: '/tmp', state: 'foreground',
    preview: { render: () => 'TERMINAL_CAPTURE' },
  };
  const legacyWindowDeps = {
    addressBook: {
      parse: (address: string) => ({
        parsed: { paneId: address === 'pane:p1' ? 'p1' : undefined },
        pane: { id: 'p1', kind: 'terminal', windowId: 2 },
      }),
      resolvePane: () => ({ id: 'p1', windowId: 2 }),
    },
    windowRegistry: {
      get: () => ({ getPane: () => ({ kind: 'terminal', capture: () => 'VIRTUAL_CAPTURE' }) }),
    },
  };
  const result = expandPromptReferences(
    '@pane:p1 안녕 @win:2/pane:p1 @term:term-session:1',
    { terminalRegistry, ...legacyWindowDeps },
  );
  expect(result).toContain('@pane:p1 안녕 @win:2/pane:p1');
  expect(result).toContain('TERMINAL_CAPTURE');
  expect(result).not.toContain('VIRTUAL_CAPTURE');
});

test('the model turn keeps @pane:p1 literal while expanding a registered file attachment', () => {
  const contextRegistry = createContextRegistry();
  const attachment = addAttachment(contextRegistry, {
    kind: 'text', sourcePath: '/tmp/notes.txt', filename: 'notes.txt',
    sizeBytes: 12, mtime: 1, text: 'FILE_CONTENT',
  });
  attachment.loaded = true;
  const result = buildDashboardTurnMessage({
    userText: `@pane:p1 안녕 ${attachment.token}`,
    promptBankContext: '',
    contextText: 'ctx',
    contextRegistry,
    terminalRegistry: {} as never,
    blockAttach: { banner: () => null, consume: (msg) => msg },
    pushChatLine: () => {},
  });
  expect(result.userMsg.content).toContain('@pane:p1 안녕 [Text #1]');
  expect(result.userMsg.content).toContain('FILE_CONTENT');
});
