import { describe, expect, it } from 'bun:test';
import { DaemonClient } from './daemon-client';
import { dispatchMeta, META_COMMANDS, type ChatRuntimeContext } from './chat-runtime';
import { withFakeFetchDevice, type FakeFetchCall } from '../test-devices/fake-fetch';

const ctx: ChatRuntimeContext = {
  sessionId: 'test', provider: 'anthropic', setSessionId: () => {},
  client: new DaemonClient({ baseUrl: 'http://fake', token: 'secret', provider: 'anthropic' }),
  daemon: { baseUrl: 'http://fake', token: 'secret' },
};
const id = '123e4567-e89b-12d3-a456-426614174000';

function withSkillRunResponses<T>(
  results: readonly unknown[],
  run: (calls: () => FakeFetchCall[]) => T | Promise<T>,
): Promise<T> {
  let resultIndex = 0;
  return withFakeFetchDevice([
    { url: '/v1/skills/exec', method: 'POST', response: () => Response.json({ id }, { status: 202 }) },
    { url: `/v1/skills/exec/${id}`, method: 'GET', response: () => Response.json(results[resultIndex++]) },
  ], async (device) => {
    const result = await run(device.calls);
    for (const call of device.calls()) expect(call.headers.authorization).toBe('Bearer secret');
    return result;
  });
}

describe('PWA /run-skill', () => {
  it('shows one usage line for zero or one argument without fetching', async () => {
    await withFakeFetchDevice([{ url: '/never', response: Response.json({}) }], async (device) => {
      for (const line of ['/run-skill', '/run-skill omni-crawl', '/rs', '/run name']) {
        expect(await dispatchMeta(line, ctx)).toEqual({ text: '쓰는 법: /run-skill <이름> <할 일>' });
      }
      expect(device.calls()).toEqual([]);
      expect(META_COMMANDS).toContainEqual({ name: 'run-skill', description: '이름을 댄 스킬 하나 바로 실행 (/run-skill <이름> <할 일>)' });
    });
  });

  it('dispatches all three slash names to one authenticated client and formats the answer', async () => {
    await withSkillRunResponses([
      { status: 'done', ok: true, output: '답' },
      { status: 'done', ok: true, output: '답' },
      { status: 'done', ok: true, output: '답' },
    ], async (calls) => {
      for (const name of ['/run-skill', '/rs', '/run']) expect(await dispatchMeta(`${name} omni-crawl 오늘 AI 뉴스`, ctx)).toEqual({ text: '답' });
      const observed = calls();
      expect(observed.filter((call) => call.method === 'POST').map((call) => JSON.parse(String(call.body)))).toEqual(Array(3).fill({ skill: 'omni-crawl', task: '오늘 AI 뉴스' }));
      expect(observed.map((call) => call.url)).toEqual(Array(3).fill(['http://fake/v1/skills/exec', `http://fake/v1/skills/exec/${id}`]).flat());
    });
  });

  it('waits through a running poll before returning one answer', async () => {
    await withSkillRunResponses([{ status: 'running' }, { status: 'done', ok: true, output: '완료' }], async (calls) => {
      expect(await dispatchMeta('/run-skill omni-crawl 오늘 AI 뉴스', ctx)).toEqual({ text: '완료' });
      expect(calls().map((call) => call.url)).toEqual(['http://fake/v1/skills/exec', `http://fake/v1/skills/exec/${id}`, `http://fake/v1/skills/exec/${id}`]);
    });
  });

  it('formats rejection, failure, unsuccessful work and truncation', async () => {
    for (const [result, line, expected] of [
      [{ status: 'rejected', reason: 'not-allowlisted' }, '/run-skill forbidden 할 일', '이 스킬은 바로 실행할 수 없습니다 — 대화로 «forbidden 으로 …» 라고 부탁해 보세요'],
      [{ status: 'failed', error: 'daemon-restarted' }, '/rs skill task', '스킬 실행을 확인하지 못했습니다(daemon-restarted)'],
      [{ status: 'done', ok: false, output: '실패' }, '/run skill task', '스킬이 실패했습니다\n실패'],
      [{ status: 'done', ok: true, output: 'x'.repeat(8001) }, '/run skill task', `${'x'.repeat(8000)}… (잘림)`],
    ] as const) {
      await withSkillRunResponses([result], async () => {
        expect(await dispatchMeta(line, ctx)).toEqual({ text: expected });
      });
    }
  });

  it('logs skill and kind only, preserving other meta commands and TUI-only names', async () => {
    const seen: unknown[] = [];
    const original = console.debug;
    console.debug = ((label: string, value: unknown) => { if (label.includes('webterm.chat.run-skill')) seen.push(value); }) as typeof console.debug;
    try {
      await withSkillRunResponses([{ status: 'done', ok: true, output: 'private output' }], async () => {
        expect(await dispatchMeta('/run-skill skill private task', ctx)).toEqual({ text: 'private output' });
      });
      expect(seen).toEqual([{ skill: 'skill', kind: 'done' }]);
      expect(JSON.stringify(seen)).not.toContain('private');
      await withSkillRunResponses([{ status: 'rejected', reason: 'not-allowlisted' }], async () => {
        await dispatchMeta('/rs skill private task', ctx);
      });
      expect(seen[1]).toEqual({ skill: 'skill', kind: 'rejected' });
      expect(JSON.stringify(seen)).not.toContain('private');
      expect((await dispatchMeta('/mission', ctx))?.text).toContain('모르는 명령입니다: /mission');
      expect((await dispatchMeta('/remaining', { ...ctx, daemon: undefined }))?.text).toBe('남은 양을 읽지 못했습니다');
      expect((await dispatchMeta(':session', ctx))?.text).toBe('session = test');
      expect((await dispatchMeta('/fork invalid', ctx))?.text).toBe('쓰는 법: /fork');
    } finally { console.debug = original; }
  });
});
