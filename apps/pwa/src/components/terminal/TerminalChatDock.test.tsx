import { describe, expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { ChatInput } from '@/components/chat/ChatInput';
import { TerminalChatDock } from './TerminalChatDock';
import { countDroppedAttachments } from '@/lib/dock-attachment-count';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const daemon = {
  client: { connectAcp: () => ({ on: () => () => {}, close: () => {} }), fetchJson: async () => ({ messages: [] }) } as never,
  config: { baseUrl: '', token: '', provider: '' },
  sessionId: '',
  setSessionId: () => {}, setConfig: () => {},
};

const renderDock = (height?: number): string => renderToStaticMarkup(
  <DaemonContext.Provider value={daemon}>
    <TerminalChatDock terminalId="terminal-1" open {...(height === undefined ? {} : { height })} />
  </DaemonContext.Provider>,
);

test('mounted dock sends a contextual agent turn via terminal/repl/exec', async () => {
  const sent: Array<{ method: string; params: unknown }> = [];
  const tabIntents: Array<'next' | 'prev' | number> = [];
  const acp = {
    on: () => () => {}, close: () => {},
    send: async (method: string, params: unknown) => {
      sent.push({ method, params });
      if ((params as { line?: string }).line === ':tab next') return { output: 'next tab', tabIntent: 'next' };
      return { agent: { markdown: 'done', modelLabel: 'test', stopReason: 'end_turn' } };
    },
  };
  const client = { connectAcp: () => acp, fetchJson: async () => ({ messages: [] }) };
  let tree: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      tree = create(
        <DaemonContext.Provider value={{ ...daemon, client: client as never, sessionId: 'session-1' }}>
          <TerminalChatDock terminalId="terminal-1" open onTabIntent={(intent) => tabIntents.push(intent)} />
        </DaemonContext.Provider>,
      );
    });
    const input = tree!.root.findByType(ChatInput);
    await act(async () => { input.findByType('textarea').props.onChange({ target: { value: 'hello' } }); });
    await act(async () => { input.findAllByType('button').at(-1)!.props.onClick(); });
    expect(sent).toContainEqual({
      method: 'terminal/repl/exec',
      params: { sessionId: 'session-1', terminalId: 'terminal-1', line: ':agent hello' },
    });
    await act(async () => { input.findByType('textarea').props.onChange({ target: { value: ':help' } }); });
    await act(async () => { input.findAllByType('button').at(-1)!.props.onClick(); });
    expect(sent).toContainEqual({
      method: 'terminal/repl/exec',
      params: { sessionId: 'session-1', terminalId: 'terminal-1', line: ':help' },
    });
    expect(Object.keys(sent.at(-1)!.params as object).sort()).toEqual(['line', 'sessionId', 'terminalId']);
    await act(async () => { input.findByType('textarea').props.onChange({ target: { value: ':tab next' } }); });
    await act(async () => { input.findAllByType('button').at(-1)!.props.onClick(); });
    expect(tabIntents).toEqual(['next']);
    const attachment = {
      id: 'file-1', filename: 'notes.txt', mediaType: 'text/plain',
      size: 5, downloadUrl: '/v1/attachments/file-1', path: '/tmp/notes.txt',
    };
    await act(async () => { input.props.onAttached([attachment]); });
    await act(async () => { input.findByType('textarea').props.onChange({ target: { value: 'read this' } }); });
    await act(async () => { input.findAllByType('button').at(-1)!.props.onClick(); });
    expect(sent).toContainEqual({
      method: 'terminal/repl/exec',
      params: {
        sessionId: 'session-1', terminalId: 'terminal-1',
        line: ':agent [attached] /tmp/notes.txt\n\nread this',
      },
    });
  } finally {
    if (tree) {
      const mounted = tree;
      await act(async () => { mounted.unmount(); });
    }
  }
});

test('dock warns only for attachments without a non-empty path', () => {
  expect(countDroppedAttachments([{ path: '/tmp/a' }, { path: '' }, {}, { path: ' ' }])).toBe(2);
  expect(countDroppedAttachments([])).toBe(0);
});

describe('TerminalChatDock (SSR)', () => {
  test('renders a positive parent-provided height without the legacy minimum', () => {
    const html = renderDock(320);
    expect(html).toContain('style="height:320px"');
    expect(html).not.toContain('h-[clamp(160px,30vh,360px)]');
    expect(html).not.toContain('min-h-[200px]');
  });

  test('renders a sub-minimum positive parent-provided height without legacy constraints', () => {
    const html = renderDock(160);
    expect(html).toContain('style="height:160px"');
    expect(html).not.toContain('h-[clamp(160px,30vh,360px)]');
    expect(html).not.toContain('min-h-[200px]');
  });

  test('retains the legacy CSS height budget when no height is provided', () => {
    const html = renderDock();
    expect(html).not.toContain('REPL off');
    expect(html).not.toContain('REPL on');
    expect(html).toContain('h-[clamp(160px,30vh,360px)]');
    expect(html).toContain('min-h-[200px]');
    expect(html).not.toContain('style="height:');
  });

  test('falls back to the legacy CSS height budget for invalid heights', () => {
    for (const height of [0, Infinity]) {
      const html = renderDock(height);
      expect(html).toContain('h-[clamp(160px,30vh,360px)]');
      expect(html).toContain('min-h-[200px]');
      expect(html).not.toContain('style="height:');
    }
  });
});
