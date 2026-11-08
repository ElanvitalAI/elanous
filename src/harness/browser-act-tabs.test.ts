import { describe, expect, test } from 'bun:test';
import { withFakeFetchDevice } from '../ux-sim/fake-fetch.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pageTargetIds, planTabReclaim } from './browser-act-tabs.js';
import { performBrowserAction } from './browser-act.js';
import type { CdpClient } from '../browser-cdp/client.js';


/** ⛔ 흉내가 아니라 «진짜 performBrowserAction» 을 부른다 — CDP 만 대역이다. */
function fakeClient(): CdpClient {
  let listener: ((event: { method: string; params: Record<string, unknown> }) => void) | undefined;
  const client = {
    pid: -1,
    isAlive: true,
    async navigate() {
      listener?.({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'frame', loaderId: 'loader' } });
      return { frameId: 'frame', loaderId: 'loader' };
    },
    // ⚖️ 실물 꼴 — clickExpression 이 좌표 «와 함께» 클릭 종류를 낸다(없으면 executeClick 이 거부한다).
    async evaluate() { return { x: 1, y: 2, kind: 'navigation' }; },
    async screenshot() { return Buffer.from('png'); },
    async click() { /* no-op */ },
    async close() { /* no-op */ },
    on(_method: string, subscribed: (event: { method: string; params: Record<string, unknown> }) => void) {
      listener = subscribed;
      return () => { listener = undefined; };
    },
  };
  return client as unknown as CdpClient;
}

const actSource = readFileSync(join(import.meta.dir, 'browser-act.ts'), 'utf8');
const list = (entries: Array<{ id: string; type: string }>) => JSON.stringify(entries);

describe('opened-tab reclaim', () => {
  test('counts only pages — an iframe or a service worker is not a tab', () => {
    const raw = list([
      { id: 'a', type: 'page' }, { id: 'b', type: 'iframe' },
      { id: 'c', type: 'service_worker' }, { id: 'd', type: 'page' },
    ]);
    expect(pageTargetIds(raw)).toEqual(['a', 'd']);
  });

  test('a broken or non-array body yields no ids rather than throwing', () => {
    expect(pageTargetIds('not json')).toEqual([]);
    expect(pageTargetIds('{"nope":1}')).toEqual([]);
  });

  test('closes only what the click opened — it never touches a tab that was already there', () => {
    // ⛔ 사람이 열어 둔 탭·봇이 쓰던 탭을 «회수 대상으로 삼지 않는다».
    const plan = planTabReclaim({ before: ['a', 'b'], after: ['a', 'b', 'c'], beforeReadable: true, afterReadable: true });
    expect(plan.close).toEqual(['c']);
    expect(plan.detail).toContain('1개');
  });

  test('never reads an unreadable list as "nothing was opened"', () => {
    // ⛔ 이 저장소가 오늘 하루 종일 고친 병 — 「없다」와 「못 봤다」를 뭉치는 것.
    for (const [b, a] of [[false, true], [true, false], [false, false]] as const) {
      const plan = planTabReclaim({ before: [], after: ['x'], beforeReadable: b, afterReadable: a });
      expect(plan.close).toEqual([]);
      expect(plan.detail).toContain('판정 불가');
    }
  });

  test('leaves at least one page alive — a browser with zero pages dies', () => {
    // 옛 탭이 «사라지고» 새 탭만 남은 판: 전부 닫으면 브라우저가 죽는다.
    const plan = planTabReclaim({ before: ['old'], after: ['new1', 'new2'], beforeReadable: true, afterReadable: true });
    expect(plan.close).toEqual(['new1']);
    expect(plan.close).not.toContain('new2');
  });

  test('says what it looked at even when it closes nothing', () => {
    const plan = planTabReclaim({ before: ['a'], after: ['a'], beforeReadable: true, afterReadable: true });
    expect(plan.close).toEqual([]);
    expect(plan.detail).toContain('전 1');
    expect(plan.detail).toContain('후 1');
  });

  test('actually closes the tab the click opened — and only that one', async () => {
    // ⛔⭐ 「소스에 있다·순서가 맞다」는 «돈다»가 아니다.
    //    📏 실측 2026-08-28: 배선을 죽이는 되돌리기 셋이 소스 시험에선 «전부 0 fail» 이었다
    //       (그중 하나는 `tabsBefore` → `tabsBeforeUnused` 인데 부분문자열이라 통과했다).
    //    ⇒ 그래서 이 시험은 CDP HTTP 를 «대역»으로 세우고 실제로 돌린다.
    let listCalls = 0;
    await withFakeFetchDevice([
      { url: '/json/list', response: () => {
        listCalls += 1;
        // 첫 조회(클릭 «전») = 탭 하나 · 둘째(클릭 «뒤») = 클릭이 연 탭이 하나 더
        const body = listCalls === 1
          ? [{ id: 'kept', type: 'page' }]
          : [{ id: 'kept', type: 'page' }, { id: 'opened', type: 'page' }];
        return new Response(JSON.stringify(body), { status: 200 });
      } },
      { url: '/json/close/opened', response: new Response('ok', { status: 200 }) },
    ], async (device) => {
      const events: Array<Record<string, unknown>> = [];
      const result = await performBrowserAction(
        { url: 'https://example.test', target: 'a', armed: true },
        {
          connect: async () => fakeClient(),
          captureTimeoutMs: 300,
          saveAttachment: async () => ({ ok: true, entry: { id: 'a', path: '/tmp/a.png', filename: 'a.png', mediaType: 'image/png', size: 3, createdAt: 1 } }),
          observe: (_event, data) => events.push(data),
        },
      );
      expect(result.ok).toBe(true);
      // ⛔ 클릭이 «연» 것만 닫는다 — 원래 있던 탭은 안 건드린다
      expect(device.calls().map((call) => new URL(call.url).pathname)).toEqual(['/json/list', '/json/list', '/json/close/opened']);
      expect(device.calls().at(-1)?.status).toBe(200);
      expect(events[0]).toMatchObject({ tabsPlanned: 1, tabsReclaimed: 1 });
    });
  });

  test('an unreadable tab list closes nothing and says so — it does not guess', async () => {
    await withFakeFetchDevice([{ url: '/json/list', response: new Response('', { status: 500 }) }], async (device) => {
      const events: Array<Record<string, unknown>> = [];
      await performBrowserAction(
        { url: 'https://example.test', target: 'a', armed: true },
        {
          connect: async () => fakeClient(),
          captureTimeoutMs: 300,
          saveAttachment: async () => ({ ok: true, entry: { id: 'a', path: '/tmp/a.png', filename: 'a.png', mediaType: 'image/png', size: 3, createdAt: 1 } }),
          observe: (_event, data) => events.push(data),
        },
      );
      expect(device.calls().map((call) => new URL(call.url).pathname)).toEqual(['/json/list', '/json/list']);
      expect(events[0]).toMatchObject({ tabsPlanned: 0, tabsReclaimed: 0 });
      expect(String(events[0]?.tabsDetail)).toContain('판정 불가');
    });
  });

  test('the observation separates "how many opened" from "how many closed"', () => {
    // ⛔ 뭉치면 «닫지 못한» 누수가 조용해진다.
    expect(actSource).toContain('tabsPlanned');
    expect(actSource).toContain('tabsReclaimed');
    expect(actSource).toContain('tabsDetail');
  });
});
