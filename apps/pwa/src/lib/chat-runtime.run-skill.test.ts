import { afterEach, describe, expect, it } from 'bun:test';
import { DaemonClient } from './daemon-client';
import { dispatchMeta, META_COMMANDS, type ChatRuntimeContext } from './chat-runtime';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const ctx: ChatRuntimeContext = {
  sessionId: 'test', provider: 'anthropic', setSessionId: () => {},
  client: new DaemonClient({ baseUrl: 'http://fake', token: 'secret', provider: 'anthropic' }),
  daemon: { baseUrl: 'http://fake', token: 'secret' },
};
const id = '123e4567-e89b-12d3-a456-426614174000';

function wire(status: unknown): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return Response.json(urls.length % 2 ? { id } : status, { status: urls.length % 2 ? 202 : 200 });
  }) as unknown as typeof fetch;
  return urls;
}

describe('PWA /run-skill', () => {
  it('shows one usage line for zero or one argument without fetching', async () => {
    globalThis.fetch = (async () => { throw new Error('unexpected fetch'); }) as unknown as typeof fetch;
    for (const line of ['/run-skill', '/run-skill omni-crawl', '/rs', '/run name']) {
      expect(await dispatchMeta(line, ctx)).toEqual({ text: '쓰는 법: /run-skill <이름> <할 일>' });
    }
    expect(META_COMMANDS).toContainEqual({ name: 'run-skill', description: '이름을 댄 스킬 하나 바로 실행 (/run-skill <이름> <할 일>)' });
  });

  it('dispatches all three slash names to one authenticated client and formats the answer', async () => {
    const bodies: unknown[] = [];
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer secret');
      return Response.json(init?.body ? { id } : { status: 'done', ok: true, output: '답' }, { status: init?.body ? 202 : 200 });
    }) as unknown as typeof fetch;
    for (const name of ['/run-skill', '/rs', '/run']) expect(await dispatchMeta(`${name} omni-crawl 오늘 AI 뉴스`, ctx)).toEqual({ text: '답' });
    expect(bodies).toEqual(Array(3).fill({ skill: 'omni-crawl', task: '오늘 AI 뉴스' }));
    expect(urls).toEqual(Array(3).fill(['http://fake/v1/skills/exec', `http://fake/v1/skills/exec/${id}`]).flat());
  });

  it('waits through a running poll before returning one answer', async () => {
    const statuses = [{ id }, { status: 'running' }, { status: 'done', ok: true, output: '완료' }];
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json(statuses.shift(), { status: calls.length === 1 ? 202 : 200 });
    }) as unknown as typeof fetch;
    expect(await dispatchMeta('/run-skill omni-crawl 오늘 AI 뉴스', ctx)).toEqual({ text: '완료' });
    expect(calls).toEqual(['http://fake/v1/skills/exec', `http://fake/v1/skills/exec/${id}`, `http://fake/v1/skills/exec/${id}`]);
  });

  it('formats rejection, failure, unsuccessful work and truncation', async () => {
    wire({ status: 'rejected', reason: 'not-allowlisted' });
    expect(await dispatchMeta('/run-skill forbidden 할 일', ctx)).toEqual({ text: '이 스킬은 바로 실행할 수 없습니다 — 대화로 «forbidden 으로 …» 라고 부탁해 보세요' });
    wire({ status: 'failed', error: 'daemon-restarted' });
    expect(await dispatchMeta('/rs skill task', ctx)).toEqual({ text: '스킬 실행을 확인하지 못했습니다(daemon-restarted)' });
    wire({ status: 'done', ok: false, output: '실패' });
    expect(await dispatchMeta('/run skill task', ctx)).toEqual({ text: '스킬이 실패했습니다\n실패' });
    wire({ status: 'done', ok: true, output: 'x'.repeat(8001) });
    expect(await dispatchMeta('/run skill task', ctx)).toEqual({ text: `${'x'.repeat(8000)}… (잘림)` });
  });

  it('logs skill and kind only, preserving other meta commands and TUI-only names', async () => {
    const seen: unknown[] = [];
    const original = console.debug;
    console.debug = ((label: string, value: unknown) => { if (label.includes('webterm.chat.run-skill')) seen.push(value); }) as typeof console.debug;
    try {
      wire({ status: 'done', ok: true, output: 'private output' });
      expect(await dispatchMeta('/run-skill skill private task', ctx)).toEqual({ text: 'private output' });
      expect(seen).toEqual([{ skill: 'skill', kind: 'done' }]);
      wire({ status: 'rejected', reason: 'not-allowlisted' });
      await dispatchMeta('/rs skill private task', ctx);
      expect(seen[1]).toEqual({ skill: 'skill', kind: 'rejected' });
      expect(JSON.stringify(seen)).not.toContain('private');
      expect((await dispatchMeta('/mission', ctx))?.text).toContain('PWA 채팅에서 아직 안 됩니다');
      expect((await dispatchMeta('/remaining', { ...ctx, daemon: undefined }))?.text).toBe('남은 양을 읽지 못했습니다');
      expect((await dispatchMeta(':session', ctx))?.text).toBe('session = test');
      expect((await dispatchMeta('/fork invalid', ctx))?.text).toBe('쓰는 법: /fork');
    } finally { console.debug = original; }
  });
});
