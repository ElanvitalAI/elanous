import { expect, test } from 'bun:test';
import { installTypeaheadFixtures, startAimockLocal } from '../../test/ux-sim/aimock-local.js';

test('AIMock drives the real local provider through timed text and tool-call SSE', async () => {
  const session = await startAimockLocal((mock) => {
    mock.onMessage('count', { content: '1\n2\n3\n' }, { chunkSize: 2, streamingProfile: { ttft: 80, tps: 100, jitter: 0 } });
    mock.onMessage('list files', { toolCalls: [{ id: 'call_list', name: 'Bash', arguments: '{"command":"ls"}' }] });
  });
  try {
    const started = performance.now();
    let firstTextAt: number | undefined;
    const textEvents = [];
    for await (const event of session.provider.streamChat!([{ role: 'user', content: 'count' }])) {
      if (event.type === 'text' && firstTextAt === undefined) firstTextAt = performance.now();
      textEvents.push(event);
    }
    expect(firstTextAt! - started).toBeGreaterThanOrEqual(60);
    expect(textEvents.filter((event) => event.type === 'text').length).toBeGreaterThan(1);
    expect(textEvents.filter((event) => event.type === 'text').map((event) => event.delta).join('')).toBe('1\n2\n3\n');
    const toolEvents = await Array.fromAsync(session.provider.streamChat!([{ role: 'user', content: 'list files' }], {
      tools: [{ name: 'Bash', description: 'Run command', parameters: { type: 'object', properties: { command: { type: 'string' } } } }],
    }));
    expect(toolEvents).toContainEqual({ type: 'tool_call', id: 'call_list', name: 'Bash', args: { command: 'ls' } });
    expect(session.mock.getRequests().length).toBe(2);
  } finally {
    await session.close();
  }
});

test('typeahead fixtures cover marker, count stream, and tool continuation', async () => {
  const session = await startAimockLocal(installTypeaheadFixtures);
  try {
    const provider = session.provider;
    const marker = await Array.fromAsync(provider.streamChat!([{ role: 'user', content: 'Q2MARK' }]));
    expect(marker.map((event) => event.type === 'text' ? event.delta : '').join('')).toBe('Q2MARK\n');
    const count = await Array.fromAsync(provider.streamChat!([{ role: 'user', content: '1부터 30까지' }]));
    expect(count.filter((event) => event.type === 'text').map((event) => event.delta).join('')).toBe(
      Array.from({ length: 30 }, (_, index) => `${index + 1}\n`).join(''));
    const messages = [{ role: 'user' as const, content: 'Bash 도구를 써서 파일 확인' }];
    const first = await Array.fromAsync(provider.streamChat!(messages, {
      tools: [{ name: 'Bash', description: 'Run command', parameters: { type: 'object', properties: { command: { type: 'string' } } } }],
    }));
    expect(first).toContainEqual({ type: 'tool_call', id: 'fake-bash-list-1', name: 'Bash', args: { command: 'ls' } });
    const second = await Array.fromAsync(provider.streamChat!([
      ...messages,
      { role: 'assistant', content: [{ type: 'tool_use', id: 'fake-bash-list-1', name: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fake-bash-list-1', content: 'file.txt' }] },
    ]));
    expect(second.filter((event) => event.type === 'text').map((event) => event.delta).join('')).toBe('파일 목록을 확인했습니다.\n');
  } finally {
    await session.close();
  }
});
