// MEMORY-TRIAGE-NO-LLM (c) REVIEW-1 — 자리 memory_save 의 반출 대상(audience)은 «함수가 있나»가 아니라 턴 시점 «실제 세션»으로 정한다.
// 실제 buildReplTools 경로로 돈다(audience 를 손으로 넣지 않는다). 가짜 Jev 만 · 임시 HOME·상태 폴더.
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JEV_ENDPOINT, type JevRequest } from '../decide/jev.js';
import type { MemoryJevDeps } from '../memory-triage/jev-adapter.js';
import { buildReplTools, resolveSeatMemoryAudience } from './index.js';

const root = mkdtempSync(join(tmpdir(), 'tc-mtg-audience-'));
afterAll(() => { rmSync(root, { recursive: true, force: true }); });
let n = 0;

function world(memberBoardSession?: () => unknown) {
  const calls: JevRequest[] = [];
  const jev: MemoryJevDeps = {
    peekEndpoint: () => JEV_ENDPOINT,
    resolveAccess: () => ({ ok: true, access: { endpoint: JEV_ENDPOINT, endpointSource: 'default', key: 'fake-not-a-key' } }),
    callJev: async (req) => {
      calls.push(req);
      return { model: 'jev-fake', answers: { durable: { type: 'noul', noul: 0.9 }, scope: { type: 'choice', choice: 'seat' }, kind: { type: 'choice', choice: 'fact' } } };
    },
    log: () => {},
  };
  // 자리 저장소만 시험 폴더로 — audience 는 손으로 넣지 않는다(실제 getAudience 경로).
  const tools = buildReplTools({
    sessionId: 'session-audience', getRequestId: () => 'request-1', seatMemoryJevDeps: jev,
    seatMemoryContext: { seat: 'TC', dir: join(root, `seat-${n += 1}`) },
    ...(memberBoardSession ? { memberBoardSession: memberBoardSession as never } : {}),
  });
  return { calls, save: (body: string) => tools.dispatch('memory_save', { name: `n-${calls.length}-${body.length}`, description: 'd', type: 'feedback', body }) };
}

test('함수가 있어도 세션이 없으면 본부(hq-seat) — Jev 를 부른다', async () => {
  const w = world(() => undefined);
  expect(await w.save('세션 없는 next TUI 자리의 교훈 하나')).toMatchObject({ saved: true, seat: 'TC' });
  expect(w.calls).toHaveLength(1);
});

test('회원 세션이 실제로 붙으면 member — Jev 를 부르지 않는다', async () => {
  const w = world(async () => ({ nexusUrl: 'https://nexus.invalid', sessionToken: 'fake-session' }));
  expect(await w.save('회원 세션이 붙은 턴의 교훈 둘')).toMatchObject({ saved: true, seat: 'TC' });
  expect(w.calls).toHaveLength(0);
});

test('세션 조회가 던지면 member(반출 막음)', async () => {
  const w = world(() => { throw new Error('ipc closed'); });
  expect(await w.save('조회가 실패한 턴의 교훈 셋')).toMatchObject({ saved: true, seat: 'TC' });
  expect(w.calls).toHaveLength(0);
});

test('반쯤 묶인 세션도 member — 칸이 하나라도 있으면 반출을 막는다 · 칸이 하나도 없을 때만 hq-seat', async () => {
  const cases: Array<[Record<string, string>, number]> = [
    [{ nexusUrl: 'https://nexus.invalid', sessionToken: '' }, 0],
    [{ nexusUrl: '', sessionToken: 'fake-session' }, 0],
    [{ nexusUrl: 'https://nexus.invalid', sessionToken: 'fake-session' }, 0],
    [{ nexusUrl: '', sessionToken: '' }, 1],
  ];
  for (const [session, jevCalls] of cases) {
    const w = world(async () => session);
    expect(await w.save(`반쯤 묶인 세션 사례 ${JSON.stringify(session)}`)).toMatchObject({ saved: true, seat: 'TC' });
    expect(w.calls).toHaveLength(jevCalls);
  }
});

test('세션 조회가 시간 안에 안 끝나면 member · 함수가 없으면 hq-seat', async () => {
  // 출처: R-TST40 — 벽시계로 판정하지 않는다. 1ms 는 «끝나지 않는 조회를 곧바로 끊는다»를 만드는 주입값이다
  const injectedTimeoutMs = 1;
  expect(await resolveSeatMemoryAudience(() => new Promise(() => {}), injectedTimeoutMs)).toBe('member');
  expect(await resolveSeatMemoryAudience(undefined)).toBe('hq-seat');
  expect(await resolveSeatMemoryAudience(() => ({ nexusUrl: '', sessionToken: '' }))).toBe('hq-seat');
  expect(await resolveSeatMemoryAudience(() => ({ nexusUrl: 'https://nexus.invalid', sessionToken: '' }))).toBe('member');
});
