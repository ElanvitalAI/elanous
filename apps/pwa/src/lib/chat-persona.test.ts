import { describe, expect, it } from 'bun:test';
import { handleChatPersona, selectedChatPersona } from './chat-persona';
import type { AcpConnection, DaemonClient } from './daemon-client';
import { runChatTurnAcp, runChatTurnStreaming } from './chat-runtime';

describe('per-conversation PWA persona commands', () => {
  it('lists, selects by display name, isolates sessions, and clears without contacting a turn', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const paths: string[] = [];
    const client = { fetchJson: async (path: string) => {
      paths.push(path);
      if (path === '/v1/personas') return { personas: [{ personaId: 'mira', displayName: '미라' }] };
      if (path === '/v1/personas/%EB%AF%B8%EB%9D%BC') return { persona: { personaId: 'mira', displayName: '미라' } };
      throw new Error('HTTP 404');
    } } as unknown as DaemonClient;
    expect(await handleChatPersona([], 'one', client, storage)).toContain('미라 (mira)');
    expect(await handleChatPersona(['미라'], 'one', client, storage)).toContain('골랐습니다');
    expect(selectedChatPersona('one', storage)).toBe('mira');
    expect(selectedChatPersona('two', storage)).toBeUndefined();
    expect(await handleChatPersona([], 'one', client, storage)).toContain('(지금)');
    expect(await handleChatPersona(['missing'], 'two', client, storage)).toContain('그런 페르소나가 없습니다');
    expect(await handleChatPersona(['-'], 'one', client, storage)).toContain('뺐습니다');
    expect(selectedChatPersona('one', storage)).toBeUndefined();
    expect(paths).toEqual(['/v1/personas', '/v1/personas/%EB%AF%B8%EB%9D%BC', '/v1/personas', '/v1/personas/missing']);
  });

  it('forwards the selected id only on that conversation for both daemon turn transports', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } });
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    const streamed: unknown[] = [];
    const acp = { on: () => () => {}, send: async (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params }); return { stopReason: 'end_turn' };
    } } as unknown as AcpConnection;
    const client = { promptStream: async (req: unknown) => {
      streamed.push(req); return { sessionId: 'one', text: 'ok', stopReason: 'end_turn' };
    } } as unknown as DaemonClient;
    const ctx = (sessionId: string) => ({ client, sessionId, provider: 'anthropic', setSessionId: () => {} });
    try {
      values.set('elanous:chat:persona:one', 'mira');
      await runChatTurnAcp(acp, '안녕', ctx('one'));
      await runChatTurnAcp(acp, '안녕', ctx('two'));
      expect(sent.map(({ params }) => params._meta)).toEqual([{ elanous: { pwaPersonaId: 'mira' } }, undefined]);
      await runChatTurnStreaming('안녕', ctx('one'));
      await runChatTurnStreaming('안녕', ctx('two'));
      expect(streamed).toEqual([
        { sessionId: 'one', userText: '안녕', provider: 'anthropic', personaId: 'mira' },
        { sessionId: 'two', userText: '안녕', provider: 'anthropic' },
      ]);
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});
