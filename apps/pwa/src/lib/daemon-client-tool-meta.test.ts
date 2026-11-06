import { describe, expect, it } from 'bun:test';

import { DaemonClient } from './daemon-client';
import { withFakeFetchDevice } from '../test-devices/fake-fetch';

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function toolEvent(event: 'tool_call' | 'tool_call_update', data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function makeClient(): DaemonClient {
  return new DaemonClient({
    baseUrl: 'http://localhost:31415',
    token: '',
    provider: 'anthropic',
  });
}

type ToolHandlers = NonNullable<Parameters<DaemonClient['agentCliPromptStream']>[1]>;
type ToolEvent = Parameters<NonNullable<ToolHandlers['onToolCall']>>[0];

async function streamToolEvents(chunks: string[]): Promise<ToolEvent[]> {
  return withFakeFetchDevice([{ url: '/v1/agent-cli/prompt', method: 'POST', response: () => sseResponse(chunks) }], async () => {
    const events: ToolEvent[] = [];
    await makeClient().agentCliPromptStream(
      { sessionId: 'session-1', message: 'hello' },
      { onToolCall: (event) => events.push(event) },
    );
    return events;
  });
}

describe('DaemonClient.agentCliPromptStream tool metadata', () => {
  it('forwards rawOutput unchanged and preserves the five existing fields', async () => {
    const rawOutput = { answer: ['one', { two: true }] };
    const [event] = await streamToolEvents([
      toolEvent('tool_call_update', {
        toolCallId: 'tool-1',
        title: 'inspect',
        kind: 'mcp',
        status: 'completed',
        contentText: 'done',
        rawOutput,
      }),
    ]);

    expect(event).toEqual({
      kind: 'tool_call_update',
      toolCallId: 'tool-1',
      title: 'inspect',
      toolKind: 'mcp',
      status: 'completed',
      contentText: 'done',
      rawOutput,
    });
    expect(event!.rawOutput).toEqual(rawOutput);
  });

  it('selects the nested MCP Apps resource URI', async () => {
    const [event] = await streamToolEvents([
      toolEvent('tool_call', {
        rawOutput: { _meta: { ui: { resourceUri: 'ui://nested' } } },
      }),
    ]);

    expect(event).toMatchObject({ resourceUri: 'ui://nested' });
  });

  it('falls back to the flat resource URI when nested URI is absent or invalid', async () => {
    const events = await streamToolEvents([
      toolEvent('tool_call', {
        rawOutput: { 'ui/resourceUri': 'ui://flat' },
      }),
      toolEvent('tool_call_update', {
        rawOutput: {
          _meta: { ui: { resourceUri: 42 } },
          'ui/resourceUri': 'ui://fallback',
        },
      }),
    ]);

    expect(events.map((event) => event.resourceUri)).toEqual(['ui://flat', 'ui://fallback']);
  });

  it('prefers the nested resource URI when both protocol forms exist', async () => {
    const [event] = await streamToolEvents([
      toolEvent('tool_call_update', {
        rawOutput: {
          _meta: { ui: { resourceUri: 'ui://nested' } },
          'ui/resourceUri': 'ui://flat',
        },
      }),
    ]);

    expect(event).toMatchObject({ resourceUri: 'ui://nested' });
  });

  it('omits metadata URI for missing, non-object, array, and non-string URI values', async () => {
    const events = await streamToolEvents([
      toolEvent('tool_call', {}),
      toolEvent('tool_call', { rawOutput: null }),
      toolEvent('tool_call', { rawOutput: 'text' }),
      toolEvent('tool_call', { rawOutput: [] }),
      toolEvent('tool_call', { rawOutput: { _meta: null, 'ui/resourceUri': 42 } }),
      toolEvent('tool_call', { rawOutput: { _meta: { ui: { resourceUri: false } } } }),
    ]);

    expect(events).toHaveLength(6);
    for (const event of events) expect(event).not.toHaveProperty('resourceUri');
    expect(events[0]).not.toHaveProperty('rawOutput');
    expect(events.slice(1).map((event) => event.rawOutput)).toEqual([null, 'text', [], { _meta: null, 'ui/resourceUri': 42 }, { _meta: { ui: { resourceUri: false } } }]);
  });

  it('skips a malformed notification and continues forwarding later tool events', async () => {
    const [event] = await streamToolEvents([
      'event: tool_call\ndata: {broken\n\n',
      toolEvent('tool_call_update', {
        toolCallId: 'after-malformed',
        title: 'next',
        kind: 'shell',
        status: 'completed',
        contentText: 'still works',
      }),
    ]);

    expect(event).toEqual({
      kind: 'tool_call_update',
      toolCallId: 'after-malformed',
      title: 'next',
      toolKind: 'shell',
      status: 'completed',
      contentText: 'still works',
    });
  });
});
