import { describe, expect, test } from 'bun:test';
import { createAcpChannelBrowserView } from '../src/acp/channel-browser-shell.js';
import { stripAnsi } from '../src/tui.js';
import { Printer } from '../src/ui/printer.js';
import type { AcpSessionStub } from '../src/session/card.js';
import { createMessageBlockStream } from '../src/conv-substrate/message-block.js';

const liveStub: AcpSessionStub = {
  id: 'acp-cli:claude:1',
  title: 'ACP · claude-code · monad-agent',
  agentKind: 'claude-code',
  isAlive: true,
  createdAt: 1,
  lastActivityAt: 2,
  meta: { namespace: 'acp-cli', backendId: 'claude-code', backendSessionId: '1', activeHops: 0 },
};

describe('ACP channel browser shell', () => {
  test('shared view renders ACP title and session rails', () => {
    const stream = createMessageBlockStream();
    stream.push({
      id: `${liveStub.id}:assistant:0:1`,
      ts: 1,
      source: 'agent',
      body: { kind: 'assistant', text: 'live excerpt line' },
    });
    const view = createAcpChannelBrowserView({}, {
      dualRoleManager: { listAsSidebarStubs: () => [liveStub], onChange: () => () => {} },
      backgroundManager: {
        list: () => [], status: () => null,
        onCreate: () => () => {}, onStateChange: () => () => {},
      },
      eventRouter: { getStream: () => stream },
      persistence: { list: () => [], load: () => null, onChange: () => () => {} },
    } as any);
    view.layout({ width: 70, height: 34 });
    const printer = Printer.create({ width: 70, height: 34, focused: true });
    view.draw(printer);
    const out = printer.lines().map(stripAnsi).join('\n');
    expect(out).toContain('ACP Channels');
    expect(out).toContain('Channels');
    expect(out).toContain('ACP · claude-code · monad-agent');
    expect(out).toContain('Right-click menu');
    expect(out).toContain('Lane type');
    expect(out).toContain('Primary action');
    expect(out).toContain('Next actions');
    expect(out).toContain('Output excerpt');
    expect(out).toContain('Active hops');
    expect(out).toContain('0');
    expect(out).toContain('live excerpt line');
  });
});
