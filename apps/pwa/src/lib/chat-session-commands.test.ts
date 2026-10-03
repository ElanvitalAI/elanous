import { afterEach, describe, expect, it } from 'bun:test';
import { DaemonClient } from './daemon-client';
import { formatSessionList, handleSessionCommand, parseSessionCommand, resolveResume } from './chat-session-commands';
import { dispatchMeta } from './chat-runtime';
import { SessionsService, type SessionSummary } from './sessions-service';

const now = Date.parse('2026-10-03T04:00:00Z');
const sessions: SessionSummary[] = [
  { id: 'abcd1111-other', msgCount: 2, lastTurnAt: '2026-10-03T02:00:00Z', lastMsgPreview: 'old' },
  { id: 'efgh2222-current', msgCount: 5, lastTurnAt: '2026-10-03T03:59:00Z', lastMsgPreview: '가'.repeat(45) },
  { id: 'abcd2222-other', msgCount: 3, lastTurnAt: '2026-10-03T03:00:00Z', lastMsgPreview: 'middle' },
];
const client = new DaemonClient({ baseUrl: 'http://localhost:31415', token: 'tok', provider: 'anthropic' });
const ctx = { client, sessionId: 'efgh2222-current' };
const realFetch = globalThis.fetch;
let requests: string[] = [];
let unavailable = false;

function serve(cards: readonly SessionSummary[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    if (unavailable) return { ok: false, status: 503, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ error: 'down' }) } as Response;
    return {
      ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ ok: true, sessions: cards.map((s) => ({
        id: s.id, messageCount: s.msgCount, updatedAt: s.lastTurnAt, preview: s.lastMsgPreview ?? '',
      })) }),
    } as Response;
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  requests = [];
  unavailable = false;
});

describe('PWA session commands', () => {
  it('parses the default 10 and caps requests at 30', () => {
    expect(parseSessionCommand('sessions', [])).toEqual({ kind: 'sessions', count: 10 });
    expect(parseSessionCommand('sessions', ['31'])).toEqual({ kind: 'sessions', count: 30 });
    expect(parseSessionCommand('sessions', ['2'])).toEqual({ kind: 'sessions', count: 2 });
    expect(parseSessionCommand('resume', [])).toEqual({ kind: 'resume' });
    expect(parseSessionCommand('resume', ['abc'])).toEqual({ kind: 'resume' });
    expect(parseSessionCommand('resume', ['abcd'])).toEqual({ kind: 'resume', prefix: 'abcd' });
  });

  it('formats newest-first rows, current marker, relative time, 40-char preview and empty list hint', () => {
    expect(formatSessionList(sessions, ctx.sessionId, 2, now)).toBe([
      `efgh2222 (지금) · 5개 · 1분 전 · ${'가'.repeat(40)}`,
      'abcd2222 · 3개 · 1시간 전 · middle',
      '이어가기: /resume <앞자리>',
    ].join('\n'));
    expect(formatSessionList([], ctx.sessionId, 10, now)).toBe('대화가 없습니다\n이어가기: /resume <앞자리>');
  });

  it('uses 10 rows by default and never more than 30 in the handler', async () => {
    const many = Array.from({ length: 35 }, (_, i): SessionSummary => ({
      id: `item${String(i).padStart(4, '0')}-session`, msgCount: i,
      lastTurnAt: new Date(now - i * 60_000).toISOString(),
    }));
    serve(many);
    const defaultList = await handleSessionCommand(parseSessionCommand('sessions', []), ctx);
    expect(defaultList.text.split('\n')).toHaveLength(11);
    const cappedList = await handleSessionCommand(parseSessionCommand('sessions', ['99']), ctx);
    expect(cappedList.text.split('\n')).toHaveLength(31);
    expect(cappedList.text.split('\n')[0]).toContain('item0000');
    expect(cappedList.text.split('\n')[29]).toContain('item0029');
  });

  it('renders an empty refreshed store without switching sessions', async () => {
    serve([]);
    expect(await handleSessionCommand(parseSessionCommand('sessions', []), ctx)).toEqual({ text: '대화가 없습니다\n이어가기: /resume <앞자리>' });
    expect(await handleSessionCommand(parseSessionCommand('resume', ['abcd']), ctx)).toEqual({ text: '그런 대화가 없습니다 — /sessions 로 목록' });
  });

  it('only returns newSessionId for one non-current matching id', () => {
    expect(resolveResume('abc', sessions, ctx.sessionId)).toEqual({ text: '쓰는 법: /resume <id 앞자리> (4자 이상)' });
    expect(resolveResume('ABCD1', sessions, ctx.sessionId)).toEqual({ newSessionId: 'abcd1111-other', text: 'abcd1111 대화로 옮겼습니다' });
    expect(resolveResume('abcd', sessions, ctx.sessionId)).toEqual({ text: 'abcd1111 · abcd2222\n더 길게 쳐 주세요' });
    expect(resolveResume('zzzz', sessions, ctx.sessionId)).toEqual({ text: '그런 대화가 없습니다 — /sessions 로 목록' });
    expect(resolveResume('efgh', sessions, ctx.sessionId)).toEqual({ text: '이미 이 대화입니다' });
  });

  it('refreshes the store for listing and resolving, without switching on invalid input', async () => {
    serve(sessions);
    expect((await handleSessionCommand(parseSessionCommand('sessions', ['1']), ctx)).text).toContain('efgh2222 (지금)');
    expect(await handleSessionCommand(parseSessionCommand('resume', ['abcd1']), ctx)).toEqual({ newSessionId: 'abcd1111-other', text: 'abcd1111 대화로 옮겼습니다' });
    const before = requests.length;
    expect(await handleSessionCommand(parseSessionCommand('resume', []), ctx)).toEqual({ text: '쓰는 법: /resume <id 앞자리> (4자 이상)' });
    expect(requests.length).toBe(before);
    expect(requests).toHaveLength(2);
    expect(requests.every((url) => url.endsWith('/v1/sessions/store'))).toBe(true);
  });

  it('dispatches /sessions and /resume to the same live session list', async () => {
    serve(sessions);
    const runtimeCtx = { ...ctx, provider: 'anthropic', setSessionId: () => {} };
    expect((await dispatchMeta('/sessions 2', runtimeCtx))?.text).toContain('efgh2222 (지금)');
    expect(await dispatchMeta('/resume abcd1', runtimeCtx)).toEqual({ newSessionId: 'abcd1111-other', text: 'abcd1111 대화로 옮겼습니다' });
    expect(await dispatchMeta('/resume abcd', runtimeCtx)).toEqual({ text: 'abcd1111 · abcd2222\n더 길게 쳐 주세요' });
    expect(await dispatchMeta('/resume zzzz', runtimeCtx)).toEqual({ text: '그런 대화가 없습니다 — /sessions 로 목록' });
    expect(await dispatchMeta('/resume efgh', runtimeCtx)).toEqual({ text: '이미 이 대화입니다' });
  });

  it('uses one successful snapshot even when the daemon changes the next response', async () => {
    let reads = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL) => {
      reads++;
      return {
        ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ ok: true, sessions: (reads === 1 ? sessions : []).map((s) => ({
          id: s.id, messageCount: s.msgCount, updatedAt: s.lastTurnAt, preview: s.lastMsgPreview ?? '',
        })) }),
      } as Response;
    }) as typeof fetch;
    expect(await handleSessionCommand(parseSessionCommand('resume', ['abcd1']), ctx)).toEqual({
      newSessionId: 'abcd1111-other', text: 'abcd1111 대화로 옮겼습니다',
    });
    expect(reads).toBe(1);
    reads = 0;
    expect((await handleSessionCommand(parseSessionCommand('sessions', ['1']), ctx)).text).toContain('efgh2222 (지금)');
    expect(reads).toBe(1);
  });

  it('extends colliding 8-character IDs until the displayed prefixes can be resumed', async () => {
    const collision: SessionSummary[] = [
      { id: 'abcd1234-a-older', msgCount: 1, lastTurnAt: '2026-10-03T02:00:00Z' },
      { id: 'abcd1234-b-newer', msgCount: 2, lastTurnAt: '2026-10-03T03:00:00Z' },
    ];
    const list = formatSessionList(collision, collision[1]!.id, 10, now);
    expect(list.split('\n')[0]).toStartWith('abcd1234-b (지금)');
    expect(list.split('\n')[1]).toStartWith('abcd1234-a ·');
    expect(resolveResume('abcd1234', collision, '')).toEqual({ text: 'abcd1234-a · abcd1234-b\n더 길게 쳐 주세요' });
    expect(resolveResume('abcd1234-a', collision, '')).toEqual({ newSessionId: collision[0]!.id, text: 'abcd1234-a 대화로 옮겼습니다' });
    expect(resolveResume('abcd1234-b', collision, collision[1]!.id)).toEqual({ text: '이미 이 대화입니다' });
    expect(resolveResume('abcd1234-a', [collision[0]!, collision[0]!], '')).not.toHaveProperty('newSessionId');
    serve(collision);
    const runtimeCtx = { ...ctx, provider: 'anthropic', setSessionId: () => {} };
    const listed = await dispatchMeta('/sessions', runtimeCtx);
    expect(listed?.text).toContain('abcd1234-a ·');
    expect(await dispatchMeta('/resume abcd1234-a', runtimeCtx)).toEqual({
      newSessionId: collision[0]!.id, text: 'abcd1234-a 대화로 옮겼습니다',
    });
  });

  it('exposes no failure signal from the service refresh after a cached success', async () => {
    let fail = false;
    const service = new SessionsService({ fetchJson: async () => {
      if (fail) throw new Error('daemon down');
      return { ok: true, sessions: [{ id: 'abcd1111-other', messageCount: 2, updatedAt: '2026-10-03T02:00:00Z', preview: 'old' }] };
    } } as unknown as DaemonClient);
    try {
      await service.forceRefresh();
      expect(service.list()[0]?.id).toBe('abcd1111-other');
      fail = true;
      expect(await service.forceRefresh()).toBeUndefined();
      expect(service.list()[0]?.id).toBe('abcd1111-other');
    } finally { service.dispose(); }
  });

  it('does not switch on daemon failure following an earlier successful list', async () => {
    serve(sessions);
    await handleSessionCommand(parseSessionCommand('sessions', []), ctx);
    unavailable = true;
    expect(await handleSessionCommand(parseSessionCommand('resume', ['abcd1']), ctx)).toEqual({ text: '대화 목록을 못 읽었습니다' });
    expect(await handleSessionCommand(parseSessionCommand('sessions', []), ctx)).toEqual({ text: '대화 목록을 못 읽었습니다' });
  });
});

describe('daemon ids share the elanous-session- prefix (live 10-03: every /resume elanou… matched all 9)', () => {
  const real: SessionSummary[] = [
    { id: 'elanous-session-bjugor', msgCount: 4, lastTurnAt: '2026-10-03T03:00:00Z', lastMsgPreview: 'a' },
    { id: 'elanous-session-t5ld2d', msgCount: 13, lastTurnAt: '2026-10-03T02:00:00Z', lastMsgPreview: 'b' },
    { id: 'elanous-session-t5xx00', msgCount: 1, lastTurnAt: '2026-10-03T01:00:00Z', lastMsgPreview: 'c' },
  ];
  it('lists the part after the prefix', () => {
    const lines = formatSessionList(real, 'elanous-session-bjugor', 10, now).split('\n');
    expect(lines[0]!.startsWith('bjugor (지금) · 4개')).toBe(true);
    expect(lines.some((line) => line.includes('elanous-session-'))).toBe(false);
  });
  it('resumes by the first characters after the prefix, with or without the prefix typed', () => {
    expect(resolveResume('t5ld', real, 'elanous-session-bjugor')).toEqual({ newSessionId: 'elanous-session-t5ld2d', text: 't5ld2d 대화로 옮겼습니다' });
    expect(resolveResume('elanous-session-t5ld', real, 'x').newSessionId).toBe('elanous-session-t5ld2d');
    expect(resolveResume('t5l', real, 'x')).toEqual({ text: '쓰는 법: /resume <id 앞자리> (4자 이상)' });
    expect(resolveResume('elanous-session-t5', real, 'x').newSessionId).toBeUndefined();
    expect(resolveResume('bjug', real, 'elanous-session-bjugor')).toEqual({ text: '이미 이 대화입니다' });
  });
});
