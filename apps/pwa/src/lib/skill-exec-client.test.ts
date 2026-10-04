import { describe, expect, it } from 'bun:test';
import { runSkillExec } from './skill-exec-client';

const daemon = { baseUrl: 'http://fake/', token: 'secret' };
const id = '123e4567-e89b-12d3-a456-426614174000';

describe('runSkillExec', () => {
  it('posts authenticated work and polls running to done with injected transport and sleep', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const sleeps: number[] = [];
    const bodies = [{ id }, { status: 'running' }, { status: 'done', ok: true, output: '답' }];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json(bodies.shift(), { status: calls.length === 1 ? 202 : 200 });
    }) as unknown as typeof fetch;
    expect(await runSkillExec(daemon, 'omni-crawl', '오늘 AI 뉴스', { fetch: fetcher, sleep: async (ms) => { sleeps.push(ms); } })).toEqual({ kind: 'done', ok: true, output: '답' });
    expect(calls.map((call) => call.url)).toEqual(['http://fake/v1/skills/exec', `http://fake/v1/skills/exec/${id}`, `http://fake/v1/skills/exec/${id}`]);
    expect(calls[0]!.init).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: '{"skill":"omni-crawl","task":"오늘 AI 뉴스"}' });
    expect(calls[1]!.init?.headers).toEqual({ authorization: 'Bearer secret' });
    expect(sleeps).toEqual([3000]);
  });

  it.each([
    [{ status: 'rejected', reason: 'not-allowlisted' }, { kind: 'rejected' }],
    [{ status: 'failed', error: 'daemon-restarted' }, { kind: 'failed', error: 'daemon-restarted' }],
    [{ status: 'done', ok: false, output: '오류' }, { kind: 'done', ok: false, output: '오류' }],
  ] as Array<[object, object]>)('returns terminal state %#', async (terminal, expected) => {
    let count = 0;
    const fetcher = (async () => Response.json(count++ ? terminal as object : { id }, { status: count === 1 ? 202 : 200 })) as unknown as typeof fetch;
    expect(JSON.stringify(await runSkillExec(daemon, 'skill', 'task', { fetch: fetcher }))).toBe(JSON.stringify(expected));
  });

  it('returns HTTP and network failures without contacting a daemon', async () => {
    for (const fetcher of [
      (async () => Response.json({ error: 'bad_request' }, { status: 400 })) as unknown as typeof fetch,
      (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
    ]) {
      const result = await runSkillExec(daemon, 'x', 'task', { fetch: fetcher });
      expect(result.kind).toBe('failed');
      expect(result.kind === 'failed' && result.error).toMatch(/HTTP 400|offline/);
    }
  });

  it('bounds an in-flight request by the configured timeout', async () => {
    let aborted = false;
    const fetcher = (async (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    })) as unknown as typeof fetch;
    expect(await runSkillExec(daemon, 'x', 'task', { fetch: fetcher, timeoutMs: 5 })).toEqual({ kind: 'failed', error: 'timeout' });
    expect(aborted).toBe(true);
  });

  it('times out after the configured upper bound without another GET', async () => {
    let count = 0;
    const fetcher = (async () => { count++; return Response.json(count === 1 ? { id } : { status: 'running' }, { status: count === 1 ? 202 : 200 }); }) as unknown as typeof fetch;
    const result = await runSkillExec(daemon, 'x', 'task', { fetch: fetcher, intervalMs: 1, timeoutMs: 1, sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 2)); } });
    expect(result).toEqual({ kind: 'failed', error: 'timeout' });
    expect(count).toBeLessThanOrEqual(2);
  });
});
