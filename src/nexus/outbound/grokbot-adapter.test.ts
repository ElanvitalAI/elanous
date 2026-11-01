import { describe, expect, test } from 'bun:test';
import { createGrokbotAdapter } from './grokbot-adapter.js';

describe('grokbot outbound adapter', () => {
  test('normalizes a request, sends through the named COO agent, and records request/reply times', async () => {
    const sent: Array<{ agent: string; prompt: string }> = [];
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    let tick = 0;
    const adapter = createGrokbotAdapter({
      sendPrompt: async (agent, prompt) => { sent.push({ agent, prompt }); return { preview: '확인했습니다.' }; },
      now: () => `t${++tick}`,
      log: (event, data) => logs.push({ event, data }),
    });

    const envelope = await adapter.receive?.({ id: 'req-1', text: '[시험] 연결 확인', kind: 'request' });
    expect(envelope).toEqual({ text: '[시험] 연결 확인', kind: 'request', channel: 'COO', senderId: 'COO', messageId: 'req-1' });
    const config = adapter.parseConfig?.({ type: 'grokbot' });
    expect(config).toEqual({ type: 'grokbot' });
    const result = await adapter.send(config!, { text: '응답 본문', markdown: false, kind: 'reply' }, {} as never, {});

    expect(result).toEqual({ type: 'grokbot', ok: true });
    expect(sent).toEqual([{ agent: 'COO', prompt: '[엘라누스 알림 — 아래를 대표님께 그대로 전해 주세요. 덧붙이지 마세요]\n\n응답 본문' }]);
    expect(logs).toEqual([
      { event: 'received', data: { id: 'req-1', text: '[시험] 연결 확인', receivedAt: 't1' } },
      { event: 'request', data: { agent: 'COO', text: '응답 본문', requestedAt: 't2', kind: 'reply' } },
      { event: 'reply', data: { agent: 'COO', repliedAt: 't3', preview: '확인했습니다.' } },
    ]);
  });

  test('rejects malformed inbound events and records a safe failure on send errors', async () => {
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const adapter = createGrokbotAdapter({
      sendPrompt: async () => { throw new Error('gateway offline'); },
      now: () => 'now',
      log: (event, data) => logs.push({ event, data }),
    });

    expect(await adapter.receive?.({ text: 17 })).toBeNull();
    const result = await adapter.send({ type: 'grokbot' }, { text: 'hello', markdown: false, kind: 'request' }, {} as never, {});

    expect(result).toEqual({ type: 'grokbot', ok: false, error: 'gateway offline' });
    expect(logs).toEqual([
      { event: 'request', data: { agent: 'COO', text: 'hello', requestedAt: 'now', kind: 'request' } },
      { event: 'failure', data: { agent: 'COO', failedAt: 'now', reason: 'gateway offline' } },
    ]);
  });
});
