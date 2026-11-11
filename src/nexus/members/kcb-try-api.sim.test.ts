import { afterAll, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as llmOriginal from '../../llm.js';
import * as crawlOriginal from '../../../skills/omni-crawl/src/free.js';

type CapturedCall = { messages: Array<{ role: string; content: string }>; options: unknown };
const calls: CapturedCall[] = [];
let streamReply: () => Promise<string> = async () => '실제 KCB 시험 결과';
let fetchedUrls: string[] = [];

mock.module('../../llm.js', () => ({
  ...llmOriginal,
  streamLLM: async (messages: Array<{ role: string; content: string }>, _onDelta: (delta: string) => void, options: unknown) => {
    calls.push({ messages, options });
    return streamReply();
  },
}));
mock.module('../../../skills/omni-crawl/src/free.js', () => ({
  ...crawlOriginal,
  fetchJina: async (url: string) => {
    fetchedUrls.push(url);
    return { title: '행사 기사', content: '기사에서 확인한 사실', url };
  },
}));

const { createMemberStore } = await import('./member-store.js');
const { createMembersApi } = await import('./members-api.js');
const { runKcbTryExample } = await import('./kcb-try.js');

afterAll(() => {
  mock.module('../../llm.js', () => llmOriginal);
  mock.module('../../../skills/omni-crawl/src/free.js', () => crawlOriginal);
});

function setup() {
  calls.length = 0;
  fetchedUrls = [];
  const store = createMemberStore({ path: ':memory:' });
  store.provisionEventCode({ code: 'KCB1114', maxUses: Number.MAX_SAFE_INTEGER, startsAt: '2026-11-10T00:00:00.000Z', endsAt: '2026-11-20T00:00:00.000Z' });
  const member = store.register(
    { sub: 'kcb-try-member', email: 'member@example.test', emailVerified: true, name: 'KCB member' },
    { consents: { privacy: 'v1', terms: 'v1' }, eventCode: 'KCB1114' },
    '2026-11-14T00:00:00.000Z',
  );
  const api = createMembersApi({
    store,
    google: { redirectUri: 'https://api.example.test/v1/members/oauth/google/callback' } as never,
    successRedirectUri: 'https://app.example.test/signup/complete',
    webOrigin: 'https://app.example.test',
    now: () => Date.parse('2026-11-14T00:00:00.000Z'),
    runTryExample: runKcbTryExample,
  });
  return { api, store, token: member.session.token };
}

function postTry(api: { handle(request: Request): Promise<Response | undefined> }, token: string, input: string) {
  return api.handle(new Request('https://app.example.test/v1/members/try', {
    method: 'POST',
    headers: { cookie: `__Host-elanous_member_session=${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ exampleId: 'article-brief', input }),
  }));
}

test('KCB try endpoint runs real article grounding and prompt construction; failed provider calls release the attempt', async () => {
  const { api, store, token } = setup();
  try {
    let first = true;
    streamReply = async () => {
      if (first) { first = false; throw new Error('provider temporarily unavailable'); }
      return '검증된 KCB 결과';
    };
    const url = 'https://news.example.test/kcb-story';
    const failed = await postTry(api, token, url);
    expect(failed?.status).toBe(503);
    const succeeded = await postTry(api, token, url);
    expect(succeeded?.status).toBe(200);
    expect(await succeeded?.json()).toEqual({ exampleId: 'article-brief', result: '검증된 KCB 결과' });
    expect(fetchedUrls).toEqual([url, url]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.messages[0]?.content).toContain('한국어 30초 브리핑');
    expect(calls[1]?.messages[1]?.content).toContain('제목 발췌: 행사 기사');
    expect(calls[1]?.messages[1]?.content).toContain('기사에서 확인한 사실');
    for (let index = 0; index < 2; index += 1) expect((await postTry(api, token, '오늘 일정'))?.status).toBe(200);
    expect((await postTry(api, token, '오늘 일정'))?.status).toBe(429);
    expect(calls).toHaveLength(4);
  } finally { store.close(); }
});

test('KCB try reservations cap concurrent execution at three', async () => {
  const { api, store, token } = setup();
  let release!: (value: string) => void;
  const gate = new Promise<string>(resolve => { release = resolve; });
  streamReply = () => gate;
  try {
    const pending = Array.from({ length: 4 }, () => postTry(api, token, '오늘 일정'));
    // Source: bounded test watchdog so a broken reservation path cannot hang CI.
    const cutoff = Date.now() + 5_000;
    while (calls.length < 3 && Date.now() < cutoff) await Bun.sleep(1);
    expect(calls).toHaveLength(3);
    release('동시 실행 결과');
    const responses = await Promise.all(pending);
    expect(responses.map(response => response?.status).sort()).toEqual([200, 200, 200, 429]);
    expect(calls).toHaveLength(3);
  } finally { store.close(); }
});


test('expired in-flight reservations recover after store restart; completed attempts remain counted', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kcb-try-lease-'));
  const path = join(directory, 'members.db');
  let store = createMemberStore({ path });
  try {
    store.provisionEventCode({ code: 'KCB1114', maxUses: Number.MAX_SAFE_INTEGER, startsAt: '2026-11-10T00:00:00.000Z', endsAt: '2026-11-20T00:00:00.000Z' });
    const member = store.register(
      { sub: 'kcb-lease-member', email: 'lease@example.test', emailVerified: true, name: 'KCB lease' },
      { consents: { privacy: 'v1', terms: 'v1' }, eventCode: 'KCB1114' },
      '2026-11-14T00:00:00.000Z',
    );
    expect(store.reserveEventTry(member.id, 'KCB1114', 1, '2026-11-14T00:00:00.000Z')).not.toBeNull();
    store.close();
    store = createMemberStore({ path });
    const recovered = store.reserveEventTry(member.id, 'KCB1114', 1, '2026-11-14T00:03:00.000Z');
    expect(recovered).not.toBeNull();
    expect(store.completeEventTry(recovered!, '2026-11-14T00:03:01.000Z')).toBe(true);
    expect(store.reserveEventTry(member.id, 'KCB1114', 1, '2026-11-14T00:06:00.000Z')).toBeNull();
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
