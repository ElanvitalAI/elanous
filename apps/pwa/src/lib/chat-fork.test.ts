import { describe, expect, it } from 'bun:test';
import type { DaemonClient } from './daemon-client';
import { forkConversation, userTurns } from './chat-fork';
import { SessionsStoreApi } from './sessions-store-api';

function fakeApi(fetchJson: (path: string, init?: RequestInit) => Promise<unknown>): SessionsStoreApi {
  return new SessionsStoreApi({ fetchJson } as DaemonClient);
}

describe('forkConversation — persisted session fork', () => {
  it('uses the store endpoint with no body for a full fork and returns the new id', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const api = fakeApi(async (path, init) => {
      calls.push({ path, init });
      return { ok: true, id: 'new-session' };
    });
    expect(await forkConversation(api, 'old/session')).toEqual({ kind: 'forked', id: 'new-session' });
    expect(calls).toEqual([{
      path: '/v1/sessions/store/old%2Fsession/fork',
      init: { method: 'POST' },
    }]);
  });

  it('passes beforeUser to the store API for a truncated fork', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const api = fakeApi(async (path, init) => {
      calls.push({ path, init });
      return { ok: true, id: 'rewound-session' };
    });
    expect(await forkConversation(api, 'old', { beforeUser: 3 })).toEqual({ kind: 'forked', id: 'rewound-session' });
    expect(calls).toEqual([{
      path: '/v1/sessions/store/old/fork',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ beforeUser: 3 }),
      },
    }]);
  });

  it('maps a missing store session (404) to empty', async () => {
    const api = fakeApi(async () => { throw new Error('HTTP 404: session not found'); });
    expect(await forkConversation(api, 'missing')).toEqual({ kind: 'empty' });
    expect(await forkConversation(fakeApi(async () => { throw new Error('not_found'); }), 'missing'))
      .toEqual({ kind: 'empty' });
    expect(await forkConversation(fakeApi(async () => { throw Object.assign(new Error('missing'), { status: 404 }); }), 'missing'))
      .toEqual({ kind: 'empty' });
  });

  it('returns only the first error line for other HTTP errors, even when details mention 404', async () => {
    const api = fakeApi(async () => { throw new Error('HTTP 503: unavailable\ninternal details'); });
    expect(await forkConversation(api, 'old')).toEqual({ kind: 'error', error: 'HTTP 503: unavailable' });
    const upstream = fakeApi(async () => { throw new Error('HTTP 500: upstream returned 404\ninternal details'); });
    expect(await forkConversation(upstream, 'old'))
      .toEqual({ kind: 'error', error: 'HTTP 500: upstream returned 404' });
    expect(await forkConversation(fakeApi(async () => ({ ok: false, error: 'HTTP 500: upstream returned 404\ninternal details' })), 'old'))
      .toEqual({ kind: 'error', error: 'HTTP 500: upstream returned 404' });
  });

  it('handles failed JSON responses and an invalid success without changing sessions', async () => {
    expect(await forkConversation(fakeApi(async () => ({ ok: false, error: 'HTTP 404: missing' })), 'old'))
      .toEqual({ kind: 'empty' });
    expect(await forkConversation(fakeApi(async () => ({ ok: false, error: 'denied\nsecret' })), 'old'))
      .toEqual({ kind: 'error', error: 'denied' });
    expect(await forkConversation(fakeApi(async () => ({ ok: true })), 'old'))
      .toEqual({ kind: 'error', error: 'Fork failed' });
  });
});

describe('userTurns', () => {
  it('counts only user messages, not assistant/system/meta messages', () => {
    expect(userTurns([])).toBe(0);
    expect(userTurns([
      { role: 'system' }, { role: 'user' }, { role: 'assistant' },
      { role: 'meta' }, { role: 'user' }, { role: 'assistant' }, { role: 'assistant' },
    ])).toBe(2);
  });
});
