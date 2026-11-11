import { describe, expect, test } from 'bun:test';
import { CLICK_KIND_EXPRESSION, decideReversibility } from './browser-act-reversibility.js';
import { performBrowserAction } from './browser-act.js';
import type { CdpClient } from '../browser-cdp/client.js';


/** ⛔ 흉내가 아니라 «진짜 performBrowserAction» 을 부른다 — CDP 만 대역이다. */
function fakeClient(options: { clicks: Array<{ x: number; y: number }>; kind: string; evaluations?: string[] }): CdpClient {
  let listener: ((event: { method: string; params: Record<string, unknown> }) => void) | undefined;
  return {
    pid: -1,
    isAlive: true,
    async navigate() {
      listener?.({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'frame', loaderId: 'loader' } });
      return { frameId: 'frame', loaderId: 'loader' };
    },
    async evaluate(expression: string) { options.evaluations?.push(expression); return { x: 5, y: 6, kind: options.kind }; },
    async screenshot() { return Buffer.from('png'); },
    async click(coordinates: { x: number; y: number }) { options.clicks.push(coordinates); },
    async close() { /* no-op */ },
    on(_method: string, subscribed: (event: { method: string; params: Record<string, unknown> }) => void) {
      listener = subscribed;
      return () => { listener = undefined; };
    },
  } as unknown as CdpClient;
}


/**
 * 첫 이동은 «완료»시키고, ***클릭 뒤에는 아무 lifecycle 도 안 내는*** 대역.
 * ⛔ 첫 이동까지 침묵시키면 «다른 대기»(초기 load)가 시한을 먹어 겨냥이 어긋난다 —
 *    실측 2026-08-28: 그렇게 썼다가 8초를 기다리고 load-timeout 이 났다.
 */
function silentClient(options: { clicks: Array<{ x: number; y: number }> }): CdpClient {
  let listener: ((event: { method: string; params: Record<string, unknown> }) => void) | undefined;
  return {
    pid: -1,
    isAlive: true,
    async navigate() {
      // 첫 이동만 완료시킨다 — 클릭 뒤에는 «아무것도» 안 낸다.
      queueMicrotask(() => listener?.({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'frame', loaderId: 'loader' } }));
      return { frameId: 'frame', loaderId: 'loader' };
    },
    async evaluate() { return { x: 5, y: 6, kind: 'navigation' }; },
    async screenshot() { return Buffer.from('png'); },
    async click(coordinates: { x: number; y: number }) { options.clicks.push(coordinates); },
    async close() { /* no-op */ },
    on(_method: string, subscribed: (event: { method: string; params: Record<string, unknown> }) => void) {
      listener = subscribed;
      return () => { listener = undefined; };
    },
  } as unknown as CdpClient;
}


describe('click reversibility', () => {
  test('an unattended path may follow a link but may not submit', () => {
    // 📌 대표 이 「쓴다」를 승인했다(2026-08-28). ⛔ 그런데 «되돌리기 장치가 없다».
    //    ⇒ 막을 수 있는 것은 되돌리기가 아니라 「무엇을 누를 수 있나」다.
    expect(decideReversibility({ kind: 'navigation', policy: 'navigation-only' }).allowed).toBe(true);
    expect(decideReversibility({ kind: 'submit', policy: 'navigation-only' }).allowed).toBe(false);
    expect(decideReversibility({ kind: 'other', policy: 'navigation-only' }).allowed).toBe(false);
  });

  test('a refusal says what it refused and how a human opens it', () => {
    // ⛔ 「금지만 주고 길을 안 주는」 것이 이 저장소가 이름 붙인 실패 모드다.
    const r = decideReversibility({ kind: 'submit', policy: 'navigation-only' });
    expect(r.allowed).toBe(false);
    expect(r.detail).toContain('되돌릴 길이 «없다»');
    expect(r.detail).toContain('--allow any');
  });

  test('never reads "could not tell" as "fine"', () => {
    // ⛔ 이 저장소가 하루 종일 고친 병 — 「모른다」와 「괜찮다」를 뭉치는 것.
    const r = decideReversibility({ kind: undefined, policy: 'navigation-only' });
    expect(r.allowed).toBe(false);
    expect(r.detail).toContain('「모른다」를 「괜찮다」로 읽지 않는다');
    // ⛔ 정책이 any 여도 «모르는 것»은 못 지나간다… 가 아니다: any 는 사람이 연 것이므로 통과한다.
    expect(decideReversibility({ kind: undefined, policy: 'any' }).allowed).toBe(false);
  });

  test('classifies by DOM structure, not by words on the button', () => {
    // ⛔ 낱말 짐작은 ⓐ 언어마다 다르고 ⓑ 틀렸을 때 «거짓 안심»을 준다.
    for (const word of ['구매', 'Submit', 'Send', 'Buy', '결제', 'Delete']) {
      expect(CLICK_KIND_EXPRESSION).not.toContain(word);
    }
    // ✅ 대신 구조를 본다
    expect(CLICK_KIND_EXPRESSION).toContain("closest('form')");
    expect(CLICK_KIND_EXPRESSION).toContain("tag === 'button'");
    expect(CLICK_KIND_EXPRESSION).toContain('hasAttribute');
  });

  test('an anchor without href, or a javascript: href, is not navigation', () => {
    // ⛔ href «없는» <a> 는 이동이 아니라 자바스크립트 핸들러다.
    expect(CLICK_KIND_EXPRESSION).toContain("tag === 'a' && element.hasAttribute('href')");
    expect(CLICK_KIND_EXPRESSION).toContain('javascript:');
  });

  test('an anchor inside a form counts as submit — a link can submit a form', () => {
    // ⛔ 폼 검사가 «앵커 검사보다 앞»이어야 한다.
    const form = CLICK_KIND_EXPRESSION.indexOf("closest('form')");
    const anchor = CLICK_KIND_EXPRESSION.indexOf("tag === 'a'");
    expect(form).toBeGreaterThan(-1);
    expect(anchor).toBeGreaterThan(form);
  });

  test('refuses BEFORE dispatching the click — a refusal after the fact is only a record', async () => {
    // ⛔⭐ 「소스에 있다·순서가 맞다」는 «돈다»가 아니다.
    //    📏 실측 2026-08-28: 거부문을 `void decision;` 으로 죽여도 소스 시험이 ***0 fail*** 이었다
    //       (`decideReversibility({` 문자열이 «남아 있어서»).
    //    ⇒ 그래서 이 시험은 진짜 performBrowserAction 을 부르고 ***클릭이 «갔나»***를 센다.
    const clicks: Array<{ x: number; y: number }> = [];
    const result = await performBrowserAction(
      { url: 'https://example.test', target: '#buy', armed: true },
      {
        connect: async () => fakeClient({ clicks, kind: 'submit' }),
        captureTimeoutMs: 200,
        reclaimOpenedTabs: false,
        observe: () => { /* noop */ },
      },
    );
    expect(result.ok).toBe(false);
    expect(String((result as { error?: string }).error)).toContain('refused (submit)');
    // ⛔ 이것이 이 시험의 전부다 — ***클릭이 «안 갔다»***
    expect(clicks).toEqual([]);
  });

  test('an explicitly opened policy does dispatch — the guard is a gate, not a wall', async () => {
    const clicks: Array<{ x: number; y: number }> = [];
    const result = await performBrowserAction(
      { url: 'https://example.test', target: '#buy', armed: true },
      {
        connect: async () => fakeClient({ clicks, kind: 'submit' }),
        captureTimeoutMs: 200,
        reclaimOpenedTabs: false,
        reversibilityPolicy: 'any',
        observe: () => { /* noop */ },
      },
    );
    expect(result.ok).toBe(true);
    expect(clicks).toHaveLength(1);
  });

  test('click classification and coordinates share one CDP evaluation before the URL readback', async () => {
    const clicks: Array<{ x: number; y: number }> = [];
    const evaluations: string[] = [];
    const result = await performBrowserAction(
      { url: 'https://example.test', target: '#buy', armed: true },
      { connect: async () => fakeClient({ clicks, kind: 'submit', evaluations }), captureTimeoutMs: 200, // Source: #13406 browser-act capture fixture.
        reclaimOpenedTabs: false, reversibilityPolicy: 'any', observe: () => {} },
    );
    expect(result.ok).toBe(true);
    expect(evaluations).toHaveLength(2); // Source: #13406 one click probe plus the URL readback; no separate kind probe.
    expect(evaluations.filter((expression) => expression.includes(CLICK_KIND_EXPRESSION))).toHaveLength(1);
    expect(evaluations.at(-1)).toBe('location.href');
    expect(clicks).toEqual([{ x: 5, y: 6 }]);
  });

  test('a click that starts no navigation does not pay the full load budget', async () => {
    // ⛔⭐ 실측 2026-08-28: waitForLoad 가 «이동이 시작도 안 했는데» 시한 «전체»(3초)를 기다렸다.
    //    ⇒ 모든 비이동 클릭이 3초를 버렸고, 심 시험이 5초에 «타임아웃»했다(#13406 부터).
    //    📏 그리고 이동은 79·436·454·540ms 에 첫 이벤트가 온다(봇 4대 · n=4).
    const clicks: Array<{ x: number; y: number }> = [];
    const started = Date.now();
    const result = await performBrowserAction(
      { url: 'https://example.test', target: '#link', armed: true },
      {
        // ⛔ 이 대역은 navigate 뒤 lifecycle 을 «내지 않는다» — 이동이 «없는» 판이다.
        connect: async () => silentClient({ clicks }),
        captureTimeoutMs: 20,
        reclaimOpenedTabs: false,
        loadWaitTimeoutMs: 8_000,   // ⛔ 시한을 «크게» 줘도 빨리 끝나야 한다
        saveAttachment: async () => ({ ok: true, entry: { path: 'p' } } as never),
        observe: () => { /* noop */ },
      },
    );
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(true);
    // ⛔ 「빠르다」가 아니라 ***「시한 전체를 안 쓴다」***를 못 박는다 — 그것이 계약이다.
    expect(elapsed).toBeLessThan(4_000);
  }, 20_000);

  test('a navigation that started but has not finished is not read as "no navigation"', async () => {
    // ⛔⭐ 시작 창은 「아무 일도 «안» 났나」만 판정해야 한다.
    //    이벤트를 «봤는데도» 'none' 을 내면 ***이동 한가운데서 찍는*** 옛 34% 로 되돌아간다.
    let listener: ((event: { method: string; params: Record<string, unknown> }) => void) | undefined;
    let navigated = false;
    const client = {
      pid: -1, isAlive: true,
      async navigate() {
        queueMicrotask(() => listener?.({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'f', loaderId: 'first' } }));
        return { frameId: 'f', loaderId: 'first' };
      },
      async evaluate() { return { x: 1, y: 2, kind: 'navigation' }; },
      async screenshot() { return Buffer.from('png'); },
      async click() {
        navigated = true;
        // 클릭이 «새 문서»를 시작한다 — 그러나 load 는 «시작 창 뒤»에 온다.
        setTimeout(() => listener?.({ method: 'Page.lifecycleEvent', params: { name: 'init', frameId: 'f', loaderId: 'second' } }), 30);
        setTimeout(() => listener?.({ method: 'Page.lifecycleEvent', params: { name: 'load', frameId: 'f', loaderId: 'second' } }), 2_200);
      },
      async close() { /* no-op */ },
      on(_m: string, l: (event: { method: string; params: Record<string, unknown> }) => void) { listener = l; return () => { listener = undefined; }; },
    } as unknown as CdpClient;

    const events: Array<Record<string, unknown>> = [];
    await performBrowserAction(
      { url: 'https://example.test', target: '#link', armed: true },
      {
        connect: async () => client, captureTimeoutMs: 20, reclaimOpenedTabs: false, loadWaitTimeoutMs: 6_000,
        saveAttachment: async () => ({ ok: true, entry: { path: 'p' } } as never),
        observe: (_e, d) => events.push(d),
      },
    );
    expect(navigated).toBe(true);
    // ⛔ 시작 창(1.5초)보다 «늦게» 온 load 도 «기다려» 잡아야 한다
    expect(events[0]?.postClickLoadWait).toBe('event');
  }, 20_000);

});
