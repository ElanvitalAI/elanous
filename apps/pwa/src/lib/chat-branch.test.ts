import { expect, test } from 'bun:test';
import { dispatchMeta, type ChatRuntimeContext, type ChatMessage } from './chat-runtime';
import type { DaemonClient } from './daemon-client';

// PCH-11 PWA half: slash fork/rewind/undo → fork endpoint, faked at the DaemonClient boundary.
// The daemon half (handleSessionsStoreFork → real forkSessionById truncation) lives in
// src/nexus/api/sessions-store.test.ts so this PWA test never imports repo src/.

type Turn = { role: string; content: string };

/** In-memory stand-in for POST /v1/sessions/store/:id/fork with the daemon's beforeUser semantics
 *  (keep history strictly before the Nth user turn; no body = full copy). */
function fakeForkStore(seed: Record<string, Turn[]>) {
  const sessions = new Map(Object.entries(seed).map(([id, turns]) => [id, turns.map((t) => ({ ...t }))]));
  const forkedFrom = new Map<string, string>();
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  let next = 0;
  const client = {
    fetchJson: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      const match = /^\/v1\/sessions\/store\/([^/]+)\/fork$/.exec(path);
      if (!match) throw new Error(`Unmatched fork route: ${path}`);
      const source = sessions.get(decodeURIComponent(match[1]!));
      if (!source) return { ok: false, error: 'HTTP 404: session not found' };
      const beforeUser = init?.body ? (JSON.parse(String(init.body)) as { beforeUser?: number }).beforeUser : undefined;
      let cut = source.length;
      if (beforeUser !== undefined) {
        let seen = 0;
        const idx = source.findIndex((t) => t.role === 'user' && ++seen === beforeUser);
        if (idx >= 0) cut = idx;
      }
      const id = `branch-${++next}`;
      sessions.set(id, source.slice(0, cut).map((t) => ({ ...t })));
      forkedFrom.set(id, decodeURIComponent(match[1]!));
      return { ok: true, id };
    },
  } as DaemonClient;
  return { client, calls, sessions, forkedFrom };
}

const persisted: Turn[] = [
  { role: 'user', content: 'first' }, { role: 'assistant', content: 'first answer' },
  { role: 'user', content: 'second' }, { role: 'assistant', content: 'second answer' },
  { role: 'user', content: 'last' },
];

const messages = [
  { role: 'user' }, { role: 'assistant' }, { role: 'meta' },
  { role: 'user' }, { role: 'assistant' }, { role: 'user' },
] as ChatMessage[];

test('PCH-11 slash fork copies the conversation; rewind 1 and undo omit the last user turn', async () => {
  const store = fakeForkStore({ original: persisted });
  const ctx: ChatRuntimeContext = {
    sessionId: 'original', provider: 'anthropic', client: store.client, messages,
    setSessionId: () => {},
  };
  const full = (await dispatchMeta('/fork', ctx))?.newSessionId;
  const rewind = (await dispatchMeta('/rewind 1', ctx))?.newSessionId;
  const undo = (await dispatchMeta('/undo', ctx))?.newSessionId;
  expect(new Set([full, rewind, undo]).size).toBe(3);
  expect(store.calls.map(({ init }) => init)).toEqual([
    { method: 'POST' },
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"beforeUser":3}' },
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"beforeUser":3}' },
  ]);
  expect(store.sessions.get(full!)).toEqual(persisted);
  for (const id of [rewind!, undo!]) {
    expect(store.sessions.get(id)!.map(({ content }) => content)).toEqual(['first', 'first answer', 'second', 'second answer']);
  }
  for (const id of [full!, rewind!, undo!]) expect(store.forkedFrom.get(id)).toBe('original');
  expect(store.sessions.get('original')).toEqual(persisted);
});

test('PCH-11 fork of an unknown session starts a fresh session, not a branch of another', async () => {
  const store = fakeForkStore({});
  const result = await dispatchMeta('/fork', {
    sessionId: 'missing-session', provider: 'anthropic', client: store.client, messages, setSessionId: () => {},
  });
  expect(store.calls.at(-1)?.path).toBe('/v1/sessions/store/missing-session/fork');
  expect(result?.newSessionId).toBeTruthy();
  expect(store.forkedFrom.has(result!.newSessionId!)).toBe(false);
  expect(store.sessions.size).toBe(0);
});
