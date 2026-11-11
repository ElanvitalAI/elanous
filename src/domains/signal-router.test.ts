// 신호 라우터 단위테스트 — 순수(주입 send·무네트워크). A3.
import { test, expect, describe, spyOn } from 'bun:test';
import { SignalPool, type Signal } from './signal-pool.js';
import type { CdpClient } from '../browser-cdp/client.js';
import { debug } from '../debug/log.js';
import {
  classifyRoute, isStale, formatAlert, formatDigest, runRouter, runDigest,
  digestInfographicSyntax, renderDigestSvg, rasterizeSvgViaCdp, svgDataHtmlUrl,
} from './signal-router.js';

const NOW = '2026-07-11T12:00:00Z';
const nowFn = () => NOW;

/** confirmed critical 신호 헬퍼 — gate2At 기본 최신(NOW). */
const conf = (over: Partial<Signal> = {}): Signal => ({
  eventId: 'e1', source: 'disclosure', observedAt: '2026-07-11T11:00:00Z',
  collectedAt: '2026-07-11T11:00:01Z', origin: 'Reuters', trust: 0.9,
  severity: 'S3', raw: 'SEC 제재 발표', confirmed: true, recommendation: 'alert',
  gate2At: NOW, ...over,
});

/** 실제 흐름 재현 — ingest(severity 적재) → markGate2(확정·gate2At). ingest 는 gate2 필드 미저장.
 *  dug 옵션 = 반응형 렌즈(B1) 통과 표시(디깅 유예 게이트 우회·즉시 라우팅 대상). */
function seed(p: SignalPool, over: Partial<Signal> = {}, dug: { confidence?: string } | false = { confidence: 'med' }): void {
  const s = conf(over);
  p.ingest(s);
  p.markGate2(s.eventId, {
    confirmed: s.confirmed ?? true,
    recommendation: s.recommendation ?? 'watch',
    reason: s.gate2Reason ?? '',
    at: s.gate2At ?? NOW,
  });
  if (dug) p.markDug(s.eventId, { verdict: s.digVerdict ?? '심층 검증', confidence: dug.confidence ?? 'med', at: s.gate2At ?? NOW });
}

describe('classifyRoute', () => {
  test('S4 → interrupt(권고 무관)', () => {
    expect(classifyRoute(conf({ severity: 'S4', recommendation: 'watch' })).route).toBe('interrupt');
  });
  test('권고 alert/adjust → interrupt', () => {
    expect(classifyRoute(conf({ recommendation: 'alert' })).route).toBe('interrupt');
    expect(classifyRoute(conf({ recommendation: 'adjust' })).route).toBe('interrupt');
  });
  test('권고 watch → batch', () => {
    expect(classifyRoute(conf({ severity: 'S3', recommendation: 'watch' })).route).toBe('batch');
  });
});

describe('isStale', () => {
  const now = Date.parse(NOW);
  test('최신(1h 전) → fresh', () => {
    expect(isStale('2026-07-11T11:00:00Z', now, 360)).toBe(false);
  });
  test('오래됨(7h 전) → stale', () => {
    expect(isStale('2026-07-11T05:00:00Z', now, 360)).toBe(true);
  });
  test('시각 불명/파싱불가 → stale(보수)', () => {
    expect(isStale(undefined, now, 360)).toBe(true);
    expect(isStale('garbage', now, 360)).toBe(true);
  });
});

describe('formatAlert / formatDigest', () => {
  test('알림에 심각도·출처·근거·무매매 고지 포함', () => {
    const t = formatAlert(conf({ asset: '005930.KO', gate2Reason: '실위협 · 연관: 반도체' }));
    expect(t).toContain('S3');
    expect(t).toContain('005930.KO');
    expect(t).toContain('실위협');
    expect(t).toContain('무매매');
  });
  test('다이제스트는 심각도별 그룹 + 건수', () => {
    const t = formatDigest([
      conf({ eventId: 'a', severity: 'S3', recommendation: 'watch', raw: 'A뉴스' }),
      conf({ eventId: 'b', severity: 'S2', recommendation: 'watch', raw: 'B뉴스' }),
    ]);
    expect(t).toContain('2건');
    expect(t).toContain('── S3 (1) ──');
    expect(t).toContain('── S2 (1) ──');
  });
});

describe('runRouter — shadow(무발송·DB 무변경)', () => {
  test('send 미주입 = 미리보기만, routed_at 미기록', () => {
    const p = new SignalPool({ path: ':memory:' });
    try {
      seed(p, { eventId: 'a', recommendation: 'alert' });
      seed(p, { eventId: 'b', recommendation: 'watch' });
      const r = runRouter(p, { now: nowFn });
      expect(r.mode).toBe('shadow');
      expect(r.total).toBe(2);
      expect(r.interrupt).toBe(1);
      expect(r.batch).toBe(1);
      expect(r.sent).toBe(0);
      // shadow 는 상태 무변경 → 재실행해도 동일 대상.
      expect(p.listUnrouted().length).toBe(2);
    } finally { p.close(); }
  });
});

describe('runRouter — live(발송·상태 소진)', () => {
  test('interrupt 즉시 발송 + routed 기록, batch 는 대기', () => {
    const p = new SignalPool({ path: ':memory:' });
    const sentMsgs: Array<{ text: string; kind: string }> = [];
    const send = (text: string, kind: string) => { sentMsgs.push({ text, kind }); return true; };
    try {
      seed(p, { eventId: 'a', recommendation: 'alert' });
      seed(p, { eventId: 'b', recommendation: 'watch' });
      const r = runRouter(p, { now: nowFn, send });
      expect(r.mode).toBe('live');
      expect(r.interrupt).toBe(1);
      expect(r.sent).toBe(1);
      expect(sentMsgs.length).toBe(1);
      expect(sentMsgs[0]!.kind).toBe('alert');
      // 상태 소진 → 재실행 시 미라우팅 0.
      expect(p.listUnrouted().length).toBe(0);
      // batch 는 다이제스트 대기.
      expect(p.listPendingDigest().map((s) => s.eventId)).toEqual(['b']);
    } finally { p.close(); }
  });

  test('★ 디깅 저신뢰(low) → 즉시알림 억제(배치 강등)', () => {
    const p = new SignalPool({ path: ':memory:' });
    const sent: string[] = [];
    try {
      // S4 지만 디깅이 low(모순/보류) → 배치.
      seed(p, { eventId: 'a', severity: 'S4', recommendation: 'adjust' }, { confidence: 'low' });
      const r = runRouter(p, { now: nowFn, send: (t) => { sent.push(t); return true; } });
      expect(r.interrupt).toBe(0);
      expect(r.batch).toBe(1);
      expect(sent.length).toBe(0);                    // 즉시 발송 안 함
      expect(p.listPendingDigest().length).toBe(1);   // 배치로
    } finally { p.close(); }
  });

  test('★ 미디깅 fresh critical → 라우팅 유보(디깅 대기·미소진)', () => {
    const p = new SignalPool({ path: ':memory:' });
    const sent: string[] = [];
    try {
      // 디깅 안 됨(dug=false) + fresh(gate2At=NOW) → 유보.
      seed(p, { eventId: 'a', severity: 'S4', recommendation: 'adjust' }, false);
      const r = runRouter(p, { now: nowFn, send: (t) => { sent.push(t); return true; } });
      expect(r.digDeferred).toBe(1);
      expect(r.interrupt).toBe(0);
      expect(sent.length).toBe(0);
      expect(p.listUnrouted().length).toBe(1);        // 미소진 → 다음 사이클 재시도
    } finally { p.close(); }
  });

  test('★ 미디깅이어도 grace(20분) 넘으면 라우팅(무한 대기 금지)', () => {
    const p = new SignalPool({ path: ':memory:' });
    const sent: string[] = [];
    try {
      // gate2At 30분 전(grace 초과) + 미디깅 → 유보 안 하고 interrupt.
      seed(p, { eventId: 'a', severity: 'S4', recommendation: 'adjust', gate2At: '2026-07-11T11:30:00Z' }, false);
      const r = runRouter(p, { now: nowFn, send: (t) => { sent.push(t); return true; } });
      expect(r.digDeferred).toBe(0);
      expect(r.interrupt).toBe(1);
      expect(sent.length).toBe(1);
    } finally { p.close(); }
  });

  test('freshness — 오래된 확정의 즉시-알림은 배치로 강등', () => {
    const p = new SignalPool({ path: ':memory:' });
    const sentMsgs: string[] = [];
    const send = (text: string) => { sentMsgs.push(text); return true; };
    try {
      // gate2At 7h 전 → stale.
      seed(p, { eventId: 'a', recommendation: 'alert', gate2At: '2026-07-11T05:00:00Z' });
      const r = runRouter(p, { now: nowFn, send, freshnessMin: 360 });
      expect(r.staleDowngraded).toBe(1);
      expect(r.interrupt).toBe(0);
      expect(r.batch).toBe(1);
      expect(sentMsgs.length).toBe(0);           // 즉시 발송 안 함
      expect(p.listPendingDigest().length).toBe(1); // 배치로 감
    } finally { p.close(); }
  });
});

describe('runDigest', () => {
  test('shadow — 미리보기만, 미소진', async () => {
    const p = new SignalPool({ path: ':memory:' });
    try {
      seed(p, { eventId: 'a', recommendation: 'watch' });
      runRouter(p, { now: nowFn, send: () => true }); // batch 로 라우팅
      const d = await runDigest(p, { now: nowFn });
      expect(d.mode).toBe('shadow');
      expect(d.count).toBe(1);
      expect(d.sent).toBe(false);
      expect(p.listPendingDigest().length).toBe(1); // 미소진
    } finally { p.close(); }
  });

  test('live — 1회 발송 + digested 소진', async () => {
    const p = new SignalPool({ path: ':memory:' });
    const sent: Array<{ text: string; kind: string }> = [];
    const send = (text: string, kind: string) => { sent.push({ text, kind }); return true; };
    const photos: Buffer[] = [];
    const fake = fakeCdpClient();
    try {
      seed(p, { eventId: 'a', severity: 'S3', recommendation: 'watch' });
      seed(p, { eventId: 'b', severity: 'S2', recommendation: 'watch' });
      runRouter(p, { now: nowFn, send });
      const d = await runDigest(p, {
        now: nowFn,
        send,
        sendPhoto: (png) => { photos.push(png); return true; },
        renderSvg: async () => '<svg xmlns="http://www.w3.org/2000/svg"/>',
        createCdpClient: async () => fake.client,
      });
      expect(d.count).toBe(2);
      expect(d.sent).toBe(true);
      expect(sent.length).toBe(1);        // 배치 = 1건으로 묶음
      expect(sent[0]!.kind).toBe('report');
      expect(photos.length).toBe(1);
      expect(p.listPendingDigest().length).toBe(0); // 소진
    } finally { p.close(); }
  });

  test('live — sendPhoto 미주입이어도 텍스트가 나갔으면 pending 소진', async () => {
    const p = new SignalPool({ path: ':memory:' });
    const sent: Array<{ text: string; kind: string }> = [];
    try {
      seed(p, { eventId: 'a', recommendation: 'watch' });
      runRouter(p, { now: nowFn, send: () => true });
      const d = await runDigest(p, {
        now: nowFn,
        send: (text, kind) => { sent.push({ text, kind }); return true; },
      });
      expect(d.sent).toBe(true);
      expect(sent.length).toBe(1);
      expect(sent[0]!.kind).toBe('report');
      // 소진 기준은 텍스트 배달 성공. sendPhoto 미주입은 부가 미시도이지 미소진이 아니다.
      expect(p.listPendingDigest().length).toBe(0);
      expect(d.photoError).toBeUndefined();
    } finally { p.close(); }
  });

  // ⛔⭐ 무인 리뷰 must-fix (2026-09-07): 종전엔 사진 작업을 «await 한 뒤»에 소진해서
  //   ***PNG 전송이 hang 하면 텍스트가 배달됐는데도 pending 이 남았다***(= 다음 사이클 중복 발송).
  //   ⇒ 이 시험이 「PNG 가 느려도 소진은 그것을 안 기다린다」를 «시간»이 아니라 «순서»로 문다:
  //     sendPhoto 가 «아직 안 끝난» 시점에 이미 소진돼 있어야 한다.
  test('⭐ PNG 가 늦어도 텍스트가 나갔으면 «그 전에» 소진된다 — hang 이 소진을 못 붙잡는다', async () => {
    const p = new SignalPool({ path: ':memory:' });
    const fake = fakeCdpClient();
    try {
      seed(p, { eventId: 'a', recommendation: 'watch' });
      runRouter(p, { now: nowFn, send: () => true });
      let pendingSeenInsidePhoto = -1;
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const running = runDigest(p, {
        now: nowFn,
        send: () => true,
        renderSvg: async () => '<svg xmlns="http://www.w3.org/2000/svg"/>',
        createCdpClient: async () => fake.client,
        // ⭐ sendPhoto «안»에서 그 순간의 pending 을 본다 — 소진이 이미 끝났어야 한다
        sendPhoto: async () => {
          pendingSeenInsidePhoto = p.listPendingDigest().length;
          await gate;
          return true;
        },
      });
      // 사진이 «아직 안 끝났는데» 소진은 끝나 있어야 한다
      await new Promise((r) => setTimeout(r, 10));
      release!();
      const d = await running;
      expect(d.sent).toBe(true);
      // ⛔ -1 이면 sendPhoto 가 «안 불린» 것이다 — 그건 이 시험이 조건을 못 세운 것이지 통과가 아니다
      expect(pendingSeenInsidePhoto).not.toBe(-1);
      expect(pendingSeenInsidePhoto).toBe(0);          // ⭐ 이 줄이 «순서»를 문다
      expect(p.listPendingDigest().length).toBe(0);
    } finally { p.close(); }
  });

  test('발송 실패 시 미소진(다음 사이클 재시도)', async () => {
    const p = new SignalPool({ path: ':memory:' });
    try {
      seed(p, { eventId: 'a', recommendation: 'watch' });
      runRouter(p, { now: nowFn, send: () => true });
      const d = await runDigest(p, { now: nowFn, send: () => false });
      expect(d.sent).toBe(false);
      expect(p.listPendingDigest().length).toBe(1); // 재시도 여지
    } finally { p.close(); }
  });

  test('대기 없으면 무발송', async () => {
    const p = new SignalPool({ path: ':memory:' });
    try {
      const d = await runDigest(p, { now: nowFn, send: () => true });
      expect(d.count).toBe(0);
      expect(d.sent).toBe(false);
    } finally { p.close(); }
  });
});

function fakeCdpClient(png: Buffer = Buffer.from('not-a-size-signal')): {
  client: CdpClient;
  navigated: string[];
  screenshotCalls: number;
  closed: number;
} {
  const navigated: string[] = [];
  let screenshotCalls = 0;
  let closed = 0;
  const client: CdpClient = {
    port: 0,
    pid: 0,
    isAlive: true,
    async navigate(url) { navigated.push(url); return { frameId: 'f1' }; },
    async screenshot() { screenshotCalls += 1; return png; },
    async evaluate() { return undefined; },
    async setScriptExecutionDisabled() {},
    async close() { closed += 1; },
  };
  return {
    client,
    navigated,
    get screenshotCalls() { return screenshotCalls; },
    get closed() { return closed; },
  };
}

describe('digest infographic SVG', () => {
  const labeled = [
    conf({ eventId: 'a', asset: '005930.KO', severity: 'S3', recommendation: 'watch', raw: '삼성전자 제재 발표' }),
  ];

  test('렌더된 SVG 에 한글 라벨이 그대로 들어 있다', async () => {
    const svg = await renderDigestSvg(labeled);
    expect(svg).toContain('삼성전자 제재 발표');
    expect(svg).toContain('005930.KO');
  });

  test('같은 입력을 연달아 두 번 렌더하면 SVG 문자열이 같다', async () => {
    const a = await renderDigestSvg(labeled);
    const b = await renderDigestSvg(labeled);
    expect(a).toBe(b);
  });

  test('구문에 라벨이 실리고 PNG 경로는 CdpClient.screenshot 을 탄다', async () => {
    const syntax = digestInfographicSyntax(labeled);
    expect(syntax).toContain('삼성전자 제재 발표');
    const fake = fakeCdpClient();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>삼성전자 제재 발표</text></svg>';
    const png = await rasterizeSvgViaCdp(svg, async () => fake.client);
    expect(fake.navigated[0]).toBe(svgDataHtmlUrl(svg));
    expect(fake.navigated[0]!.startsWith('data:text/html;charset=utf-8,')).toBe(true);
    expect(fake.screenshotCalls).toBe(1);
    expect(fake.closed).toBe(1);
    expect(Buffer.isBuffer(png)).toBe(true);
  });

});

describe('runDigest infographic photo delivery', () => {
  test('그림 생성 실패해도 텍스트 배달 인자는 그림 없이 부른 경우와 같다', async () => {
    const withoutPool = new SignalPool({ path: ':memory:' });
    const withPool = new SignalPool({ path: ':memory:' });
    const sentWith: string[] = [];
    const sentWithout: string[] = [];
    try {
      seed(withoutPool, { eventId: 'a', recommendation: 'watch', raw: '동일 본문' });
      runRouter(withoutPool, { now: nowFn, send: () => true });
      const without = await runDigest(withoutPool, { now: nowFn, send: (t) => { sentWithout.push(t); return true; } });
      seed(withPool, { eventId: 'a', recommendation: 'watch', raw: '동일 본문' });
      runRouter(withPool, { now: nowFn, send: () => true });
      const withFail = await runDigest(withPool, {
        now: nowFn,
        send: (t) => { sentWith.push(t); return true; },
        sendPhoto: async () => true,
        renderSvg: async () => { throw new Error('svg fail'); },
      });
      expect(sentWith[0]).toBe(sentWithout[0]);
      expect(withFail.preview).toBe(without.preview);
      expect(withFail.sent).toBe(true);
      expect(withoutPool.listPendingDigest().length).toBe(0);
      expect(withPool.listPendingDigest().length).toBe(0);
      expect(withFail.photoError).toBe('png-delivery-failure');
    } finally {
      withoutPool.close();
      withPool.close();
    }
  });

  test('live + sendPhoto 는 캡션=텍스트 미리보기 로 PNG 를 넘긴다', async () => {
    const p = new SignalPool({ path: ':memory:' });
    const photos: Array<{ png: Buffer; caption?: string }> = [];
    const fake = fakeCdpClient(Buffer.from('photo-payload'));
    try {
      seed(p, { eventId: 'a', recommendation: 'watch', raw: '캡션원문' });
      runRouter(p, { now: nowFn, send: () => true });
      const d = await runDigest(p, {
        now: nowFn,
        send: () => true,
        sendPhoto: (png, opts) => { photos.push({ png, caption: opts?.caption }); return true; },
        renderSvg: async () => '<svg xmlns="http://www.w3.org/2000/svg"/>',
        createCdpClient: async () => fake.client,
      });
      expect(photos.length).toBe(1);
      expect(photos[0]!.caption).toBe(d.preview);
      expect(photos[0]!.png.equals(Buffer.from('photo-payload'))).toBe(true);
      expect(fake.screenshotCalls).toBe(1);
      expect(d.sent).toBe(true);
      expect(p.listPendingDigest().length).toBe(0);
    } finally { p.close(); }
  });

  test('runDigest live 배달은 renderDigestSvg → CDP screenshot → sendPhoto 한 연쇄다', async () => {
    const p = new SignalPool({ path: ':memory:' });
    const photos: Array<{ png: Buffer; caption?: string }> = [];
    const fake = fakeCdpClient(Buffer.from('wired-png'));
    const renderedSyntax: string[] = [];
    try {
      seed(p, { eventId: 'a', asset: '005930.KO', recommendation: 'watch', raw: '연쇄원문' });
      runRouter(p, { now: nowFn, send: () => true });
      const pending = p.listPendingDigest();
      const expectedSyntax = digestInfographicSyntax(pending);
      const d = await runDigest(p, {
        now: nowFn,
        send: () => true,
        sendPhoto: (png, opts) => { photos.push({ png, caption: opts?.caption }); return true; },
        renderSvg: async (syntax) => {
          renderedSyntax.push(syntax);
          return '<svg xmlns="http://www.w3.org/2000/svg"><text>연쇄원문</text></svg>';
        },
        createCdpClient: async () => fake.client,
      });
      expect(renderedSyntax).toEqual([expectedSyntax]);
      expect(fake.navigated.length).toBe(1);
      expect(fake.navigated[0]!.startsWith('data:text/html;charset=utf-8,')).toBe(true);
      expect(fake.screenshotCalls).toBe(1);
      expect(photos.length).toBe(1);
      expect(photos[0]!.png.equals(Buffer.from('wired-png'))).toBe(true);
      expect(photos[0]!.caption).toBe(d.preview);
      expect(d.sent).toBe(true);
    } finally { p.close(); }
  });

  test('shadow / send 없는 모드는 그림 작업을 하지 않는다', async () => {
    const p = new SignalPool({ path: ':memory:' });
    let renderCalls = 0;
    let cdpCalls = 0;
    let photoCalls = 0;
    try {
      seed(p, { eventId: 'a', recommendation: 'watch' });
      runRouter(p, { now: nowFn, send: () => true });
      await runDigest(p, {
        now: nowFn,
        sendPhoto: () => { photoCalls += 1; return true; },
        renderSvg: async () => { renderCalls += 1; return '<svg/>'; },
        createCdpClient: async () => { cdpCalls += 1; return fakeCdpClient().client; },
      });
      expect(renderCalls).toBe(0);
      expect(cdpCalls).toBe(0);
      expect(photoCalls).toBe(0);
    } finally { p.close(); }
  });

  test('텍스트 성공 + sendPhoto() === false 여도 pending 소진, PNG 실패는 이름으로 관측', async () => {
    const p = new SignalPool({ path: ':memory:' });
    const logs: Array<{ category: string; event: string }> = [];
    const spy = spyOn(debug, 'log').mockImplementation((category: string, event: string, data?: Record<string, unknown>) => {
      logs.push({ category, event });
      return undefined as never;
    });
    try {
      seed(p, { eventId: 'a', recommendation: 'watch' });
      runRouter(p, { now: nowFn, send: () => true });
      const d = await runDigest(p, {
        now: nowFn,
        send: () => true,
        sendPhoto: () => false,
        renderSvg: async () => '<svg xmlns="http://www.w3.org/2000/svg"/>',
        createCdpClient: async () => fakeCdpClient().client,
      });
      expect(d.sent).toBe(true);
      expect(p.listPendingDigest().length).toBe(0);
      expect(d.photoError).toBe('png-delivery-failure');
      expect(logs.some((e) => e.category === 'signal.digest' && e.event === 'png-delivery-failure')).toBe(true);
    } finally {
      spy.mockRestore();
      p.close();
    }
  });

  // ⭐ PNG 연쇄는 «세 단계»다: renderSvg → CDP screenshot → sendPhoto.
  //    📏 2026-09-07 실측: 이 파일이 renderSvg 실패(위)와 sendPhoto 실패/false(위)는 물지만
  //       ***가운데 단계인 `screenshot` «실패»를 무는 시험은 0건***이었다(성공 경로만 셌다).
  //    ⇒ 아래는 그 빈칸이다. 중복이 아니라 «안 덮인 단계»다.
  test('텍스트 성공 + CDP screenshot 예외여도 pending 소진 — 마지막 단계는 아예 안 불린다', async () => {
    const p = new SignalPool({ path: ':memory:' });
    const logs: Array<{ category: string; event: string }> = [];
    let photoCalls = 0;
    const spy = spyOn(debug, 'log').mockImplementation((category: string, event: string, data?: Record<string, unknown>) => {
      logs.push({ category, event });
      return undefined as never;
    });
    try {
      seed(p, { eventId: 'a', recommendation: 'watch' });
      runRouter(p, { now: nowFn, send: () => true });
      const failingScreenshot: CdpClient = {
        ...fakeCdpClient().client,
        async screenshot() { throw new Error('cdp screenshot fail'); },
      };
      const d = await runDigest(p, {
        now: nowFn,
        send: () => true,
        sendPhoto: () => { photoCalls += 1; return true; },
        renderSvg: async () => '<svg xmlns="http://www.w3.org/2000/svg"/>',
        createCdpClient: async () => failingScreenshot,
      });
      expect(d.sent).toBe(true);
      expect(p.listPendingDigest().length).toBe(0);
      // 가운데 단계가 죽었으므로 마지막 단계는 «아예 불리지 않는다» —
      // 이 줄이 없으면 screenshot 이 «성공»해도 시험이 통과한다(실측으로 확인했다).
      expect(photoCalls).toBe(0);
      expect(d.photoError).toBe('png-delivery-failure');
      expect(logs.some((e) => e.category === 'signal.digest' && e.event === 'png-delivery-failure')).toBe(true);
    } finally {
      spy.mockRestore();
      p.close();
    }
  });

  test('텍스트 성공 + PNG 생성 예외여도 pending 소진, PNG 실패는 이름으로 관측', async () => {
    const p = new SignalPool({ path: ':memory:' });
    try {
      seed(p, { eventId: 'a', recommendation: 'watch' });
      runRouter(p, { now: nowFn, send: () => true });
      const d = await runDigest(p, {
        now: nowFn,
        send: () => true,
        sendPhoto: async () => true,
        renderSvg: async () => { throw new Error('svg fail'); },
      });
      expect(d.sent).toBe(true);
      expect(p.listPendingDigest().length).toBe(0);
      expect(d.photoError).toBe('png-delivery-failure');
    } finally { p.close(); }
  });

  test('텍스트 배달 실패면 PNG 결과와 무관하게 pending 유지', async () => {
    const p = new SignalPool({ path: ':memory:' });
    let photoCalls = 0;
    try {
      seed(p, { eventId: 'a', recommendation: 'watch' });
      runRouter(p, { now: nowFn, send: () => true });
      const d = await runDigest(p, {
        now: nowFn,
        send: () => false,
        sendPhoto: () => { photoCalls += 1; return true; },
        renderSvg: async () => '<svg xmlns="http://www.w3.org/2000/svg"/>',
        createCdpClient: async () => fakeCdpClient().client,
      });
      expect(d.sent).toBe(false);
      expect(photoCalls).toBe(0);
      expect(p.listPendingDigest().length).toBe(1);
      expect(d.photoError).toBeUndefined();
    } finally { p.close(); }
  });

  test('텍스트 배달 예외면 pending 미소진', async () => {
    const p = new SignalPool({ path: ':memory:' });
    try {
      seed(p, { eventId: 'a', recommendation: 'watch' });
      runRouter(p, { now: nowFn, send: () => true });
      const d = await runDigest(p, {
        now: nowFn,
        send: () => { throw new Error('text fail'); },
        sendPhoto: () => true,
      });
      expect(d.sent).toBe(false);
      expect(p.listPendingDigest().length).toBe(1);
      expect(d.photoError).toBeUndefined();
    } finally { p.close(); }
  });
});
