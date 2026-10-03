import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { isSeatDocRequest, submitSeatDocRequest, type SeatDocDeps } from './seat-doc-route.js';

const reportTo = { channel: 'telegram' as const, chatId: -100123, botId: 'bot-1' };

async function settled(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

describe('EV12d — no fitting graph: the seat answers itself', () => {
  const noGraph = { status: 'failed' as const, summary: 'CMO: 요청에 맞는 설치된 실행 그래프가 없습니다', results: [],
    seats: [{ seat: 'CMO', title: '리허설 준비 상황', status: 'failed' as const, graphId: '', reason: 'CMO: 요청에 맞는 설치된 실행 그래프가 없습니다' }] };

  test('the reply is the seat answer in the same channel, not «문서 요청 실패»', async () => {
    const deliveries: unknown[][] = [];
    const asked: string[][] = [];
    await submitSeatDocRequest({ text: '@CMO 오늘 리허설 준비 상황 알려줘', reportTo, deps: {
      submitExec: async () => ({ id: 'exec-77d8' }),
      getExec: async () => noGraph as never,
      seatAnswer: async (seat, question) => { asked.push([seat, question]); return { title: 'CMO', text: '리허설 준비: EV10 🟢 · EV12 🟡(디스코드 답 확인 중)' }; },
      sendOutbound: (...args) => { deliveries.push(args); return true; },
    } });
    await settled();
    expect(asked).toEqual([['CMO', '오늘 리허설 준비 상황 알려줘']]);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]![0]).toContain('CMO 답 (접수번호 exec-77d8)');
    expect(deliveries[0]![0]).toContain('리허설 준비: EV10 🟢');
    expect(deliveries[0]![0]).not.toContain('문서 요청 실패');
    expect(deliveries[0]!.slice(1)).toEqual(['report', reportTo]);
  });

  test('when the seat answer fails or is empty, the old failure reply still goes out', async () => {
    for (const seatAnswer of [async () => { throw new Error('llm down'); }, async () => null]) {
      const deliveries: unknown[][] = [];
      await submitSeatDocRequest({ text: '@CMO 상황 알려줘', reportTo, deps: {
        submitExec: async () => ({ id: 'exec-x' }), getExec: async () => noGraph as never, seatAnswer,
        sendOutbound: (...args) => { deliveries.push(args); return true; },
      } });
      await settled();
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]![0]).toContain('문서 요청 실패 — CMO: 요청에 맞는 설치된 실행 그래프가 없습니다');
    }
  });

  test('other failures (a graph that ran and failed) never trigger the seat answer', async () => {
    let called = 0;
    const deliveries: unknown[][] = [];
    await submitSeatDocRequest({ text: '@CMO 메모', reportTo, deps: {
      submitExec: async () => ({ id: 'exec-y' }),
      getExec: async () => ({ status: 'failed', summary: '그래프 실행 실패', results: [], seats: [{ seat: 'CMO', title: 't', status: 'failed', graphId: 'doc-draft', reason: '노드 실패' }] }) as never,
      seatAnswer: async () => { called += 1; return { title: 'CMO', text: 'x' }; },
      sendOutbound: (...args) => { deliveries.push(args); return true; },
    } });
    await settled();
    expect(called).toBe(0);
    expect(deliveries[0]![0]).toContain('문서 요청 실패 — 그래프 실행 실패');
  });
});

describe('seat document route', () => {
  test('requires a seat address and document language; code language wins', () => {
    for (const body of ['전략', '한 장', '원페이저', '기획', '보도자료', '글', '메모', '초안', 'one-pager', 'strategy', 'post', 'memo', 'draft']) {
      expect(isSeatDocRequest(`@CMO ${body} 써줘`)).toBe(true);
    }
    expect(isSeatDocRequest('@CMO PR #81 근거로 보도자료 써줘')).toBe(true);
    expect(isSeatDocRequest('마케팅 전략 한 장')).toBe(false);
    expect(isSeatDocRequest('@not-a-seat 전략 한 장')).toBe(false);
    for (const code of ['구현', '버그', '고쳐', 'fix', 'implement', 'PR']) {
      expect(isSeatDocRequest(`@TC 전략 글 ${code}`)).toBe(false);
    }
  });

  test('EV12a — status questions and report requests go to the seat doc path, not a code goal', () => {
    for (const text of [
      '@CMO 오늘 리허설 준비 상황 알려줘',
      '@CMO 행사 진행 어때?',
      '@CTO 버그 현황 정리해서 보고해 줘',
      '@CXO 이번 주 요약 공유해 줘',
      '@cmo what is the status of the launch',
    ]) expect(isSeatDocRequest(text)).toBe(true);
    for (const text of [
      '@CTO 로그인 버그 고쳐 줘',
      '@CTO 상황 페이지 구현해 줘',
      '@CTO fix the status page',
      '오늘 리허설 준비 상황 알려줘',
      '@not-a-seat 상황 알려줘',
    ]) expect(isSeatDocRequest(text)).toBe(false);
  });

  test('research once, submit once, then deliver a result and file link to the same chat once', async () => {
    const researched: string[] = [];
    const submitted: string[] = [];
    const polls: string[] = [];
    const deliveries: unknown[][] = [];
    const deps: SeatDocDeps = {
      research: async body => { researched.push(body); return Array.from({ length: 6 }, (_, i) => ({ title: `출처${i}`, url: `https://example.com/${i}` })); },
      submitExec: async text => { submitted.push(text); return { id: 'exec-1' }; },
      getExec: async id => {
        polls.push(id);
        return polls.length === 1 ? { status: 'running', summary: '', results: [] }
          : { status: 'done', summary: '초안 완성', results: [{ seat: 'CMO', title: 'draft.md', kind: 'report', url: '/v1/exec-requests/exec-1/files/run--draft.md' }] };
      },
      sleep: async ms => { expect(ms).toBe(5_000); },
      pwaUrl: () => 'https://phone.example.test/app/',
      getFile: async path => { expect(path).toBe('/v1/exec-requests/exec-1/files/run--draft.md'); return '# 문서 초안'; },
      publishFile: (content, key) => {
        expect(content).toBe('# 문서 초안');
        expect(key).toStartWith('seat-doc/exec-1/');
        return 'https://files.example.test/draft.md';
      },
      sendOutbound: (...args) => { deliveries.push(args); return true; },
    };
    expect(await submitSeatDocRequest({ text: '@CMO 10-28 마케팅 전략 한 장', reportTo, deps })).toEqual({ id: 'exec-1' });
    await settled();
    expect(researched).toEqual(['10-28 마케팅 전략 한 장']);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toContain('참고 자료\n출처0 · https://example.com/0');
    expect(submitted[0]).not.toContain('출처5');
    expect(polls).toEqual(['exec-1', 'exec-1']);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]![0]).toContain('draft.md (report) · https://files.example.test/draft.md');
    expect(deliveries[0]![0]).toContain('https://phone.example.test/app/ (접수번호 exec-1)');
    expect(deliveries[0]![0]).not.toContain('/v1/exec-requests/exec-1/files/');
    expect(deliveries[0]!.slice(1)).toEqual(['report', reportTo]);
  });

  test('cites verified supplied file, URL and PR figures in delivered document; keeps unsupported figures marked', async () => {
    const sources = new Map([
      ['brief.md', '매출 42%'],
      ['https://example.test/stats', '고객 320명'],
      ['PR #81', '응답 17건'],
    ]);
    const fetched: string[] = [];
    const delivered: string[] = [];
    const body = '매출 42%\n고객 320명\n응답 17건\n추정 99건\n공고 https://example.test/2026/10\n누적 42% [출처: https://example.test/2026/10]';
    await submitSeatDocRequest({ text: '@CMO brief.md https://example.test/stats PR #81 보고서', reportTo, deps: {
      readSource: async ref => { fetched.push(ref); return sources.get(ref) ?? null; },
      submitExec: async value => { expect(value).toContain('수치는 삭제하거나 바꾸지 말고 «확인 필요»'); return { id: 'exec-cited' }; },
      getExec: async () => ({ status: 'done', summary: '완료', results: [
        { seat: 'CMO', title: 'report.md', kind: 'report', url: '/v1/exec-requests/exec-cited/files/report.md' },
      ] }),
      getFile: async () => body,
      publishFile: content => { delivered.push(content); return 'https://files.example.test/report.md'; },
      sendOutbound: () => true,
    } });
    await settled();
    expect(fetched).toEqual(['brief.md', 'https://example.test/stats', 'PR #81']);
    expect(delivered).toEqual(['매출 42% [출처: brief.md]\n고객 320명 [출처: https://example.test/stats]\n응답 17건 [출처: PR #81]\n추정 99건 «확인 필요»\n공고 https://example.test/2026/10\n누적 42% «확인 필요»']);
  });

  test('a matching figure with the wrong claim subject is not cited', async () => {
    const delivered: string[] = [];
    await submitSeatDocRequest({ text: '@CMO brief.md 초안', deps: {
      readSource: async () => '매출 42%, 이탈률 17%',
      submitExec: async () => ({ id: 'exec-pair' }),
      getExec: async () => ({ status: 'done', summary: '완료', results: [
        { seat: 'CMO', title: 'draft.md', kind: 'report', url: '/v1/exec-requests/exec-pair/files/draft.md' },
      ] }),
      getFile: async () => '이탈률 42% [출처: brief.md]\n매출 42%\n이탈률 17%',
      publishFile: content => { delivered.push(content); return null; },
      sendOutbound: () => true,
    } });
    await settled();
    expect(delivered).toEqual(['이탈률 42% «확인 필요»\n매출 42% [출처: brief.md]\n이탈률 17% [출처: brief.md]']);
  });

  test('keeps percent units and particles intact and refuses reversed claim direction', async () => {
    const published: string[] = [];
    await submitSeatDocRequest({ text: '@CMO brief.md 초안', deps: {
      readSource: async () => '매출 42% 감소\n고객 17건 증가',
      submitExec: async () => ({ id: 'exec-direction' }),
      getExec: async () => ({ status: 'done', summary: '완료', results: [
        { seat: 'CMO', title: 'draft.md', kind: 'report', url: '/v1/exec-requests/exec-direction/files/draft.md' },
      ] }),
      getFile: async () => '매출 42%가 증가\n매출 42%가 감소\n고객 17건이 증가\n매출 42%가 증가했다가 감소',
      publishFile: content => { published.push(content); return null; },
      sendOutbound: () => true,
    } });
    await settled();
    expect(published).toEqual(['매출 42%가 «확인 필요» 증가\n매출 42%가 [출처: brief.md] 감소\n고객 17건이 [출처: brief.md] 증가\n매출 42%가 «확인 필요» 증가했다가 감소']);
    expect(published[0]).not.toContain('42 «확인 필요»%');
  });

  test('does not cite negated or forecast claims as observed claims, but cites the same decimal figure', async () => {
    const published: string[] = [];
    await submitSeatDocRequest({ text: '@CMO brief.md 초안', deps: {
      readSource: async () => '매출 42% 증가하지 않았다\n고객 17건 증가 예상\n마진 42.5% 증가\n이익 21% 증가',
      submitExec: async () => ({ id: 'exec-claim-meaning' }),
      getExec: async () => ({ status: 'done', summary: '완료', results: [
        { seat: 'CMO', title: 'draft.md', kind: 'report', url: '/v1/exec-requests/exec-claim-meaning/files/draft.md' },
      ] }),
      getFile: async () => '매출 42% 증가\n매출 42% 증가하지 않았다\n고객 17건 증가\n고객 17건 증가 전망\n마진 42.5% 증가\n이익 21% 증가 예상',
      publishFile: content => { published.push(content); return null; },
      sendOutbound: () => true,
    } });
    await settled();
    expect(published).toEqual(['매출 42% «확인 필요» 증가\n매출 42% [출처: brief.md] 증가하지 않았다\n고객 17건 «확인 필요» 증가\n고객 17건 [출처: brief.md] 증가 전망\n마진 42.5% [출처: brief.md] 증가\n이익 21% «확인 필요» 증가 예상']);
  });

  test('does not cite a figure whose range or approximation words differ from the source', async () => {
    const published: string[] = [];
    await submitSeatDocRequest({ text: '@CMO brief.md 초안', deps: {
      readSource: async () => '매출 42%\n고객 300명 이상\n응답 약 17건',
      submitExec: async () => ({ id: 'exec-claim-range' }),
      getExec: async () => ({ status: 'done', summary: '완료', results: [
        { seat: 'CMO', title: 'draft.md', kind: 'report', url: '/v1/exec-requests/exec-claim-range/files/draft.md' },
      ] }),
      getFile: async () => '매출 42% 미만\n매출 42%\n고객 300명\n고객 300명 이상\n응답 약 17건\n응답 최대 17건',
      publishFile: content => { published.push(content); return null; },
      sendOutbound: () => true,
    } });
    await settled();
    expect(published).toEqual(['매출 42% «확인 필요» 미만\n매출 42% [출처: brief.md]\n고객 300명 «확인 필요»\n고객 300명 [출처: brief.md] 이상\n응답 약 17건 [출처: brief.md]\n응답 최대 17건 «확인 필요»']);
  });

  test('URL reader stops at 200KB while streaming even without an honest Content-Length', async () => {
    const originalFetch = globalThis.fetch;
    try {
      for (const headers of [new Headers({ 'content-type': 'text/plain' }), new Headers({ 'content-type': 'text/plain', 'content-length': '1' })]) {
        let pulls = 0;
        let cancelled = false;
        const published: string[] = [];
        globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            controller.enqueue(new Uint8Array(100_001));
          },
          cancel() { cancelled = true; },
        }, { highWaterMark: 0 }), { headers })) as unknown as typeof fetch;
        await submitSeatDocRequest({ text: '@CMO https://github.com/example/brief.md 초안', deps: {
          submitExec: async () => ({ id: 'exec-large' }),
          getExec: async () => ({ status: 'done', summary: '완료', results: [
            { seat: 'CMO', title: 'draft.md', kind: 'report', url: '/v1/exec-requests/exec-large/files/draft.md' },
          ] }),
          getFile: async () => '매출 42%',
          publishFile: content => { published.push(content); return null; },
          sendOutbound: () => true,
        } });
        await settled();
        expect(pulls).toBe(2);
        expect(cancelled).toBe(true);
        expect(published).toEqual(['매출 42% «확인 필요»']);
      }
    } finally { globalThis.fetch = originalFetch; }
  });

  test('default source reader rejects outside files and symlinks and never fetches arbitrary URLs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seat-source-'));
    const outside = join(dir, 'private.md');
    const link = join(process.cwd(), `seat-source-link-${process.pid}.md`);
    const fetched: string[] = [];
    const originalFetch = globalThis.fetch;
    try {
      writeFileSync(outside, '매출 42%');
      symlinkSync(outside, link);
      globalThis.fetch = (async (input: RequestInfo | URL) => { fetched.push(String(input)); throw new Error('unexpected fetch'); }) as unknown as typeof fetch;
      const published: string[] = [];
      await submitSeatDocRequest({ text: `@CMO ${relative(process.cwd(), outside)} ${relative(process.cwd(), link)} http://127.0.0.1/private.md 초안`, deps: {
        submitExec: async () => ({ id: 'exec-restricted' }),
        getExec: async () => ({ status: 'done', summary: '완료', results: [
          { seat: 'CMO', title: 'draft.md', kind: 'report', url: '/v1/exec-requests/exec-restricted/files/draft.md' },
        ] }),
        getFile: async () => '매출 42%',
        publishFile: content => { published.push(content); return null; },
        sendOutbound: () => true,
      } });
      await settled();
      expect(fetched).toEqual([]);
      expect(published).toEqual(['매출 42% «확인 필요»']);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(link, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a stalled PR lookup is killed and its figure remains unverified', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seat-gh-'));
    const gh = join(dir, 'gh');
    const originalPath = process.env.PATH;
    const published: string[] = [];
    try {
      writeFileSync(gh, '#!/bin/sh\nsleep 30\n');
      chmodSync(gh, 0o755);
      process.env.PATH = `${dir}:${originalPath ?? ''}`;
      const started = Date.now();
      await submitSeatDocRequest({ text: '@CMO PR #81 초안', deps: {
        submitExec: async () => ({ id: 'exec-pr-timeout' }),
        getExec: async () => ({ status: 'done', summary: '완료', results: [
          { seat: 'CMO', title: 'draft.md', kind: 'report', url: '/v1/exec-requests/exec-pr-timeout/files/draft.md' },
        ] }),
        getFile: async () => '매출 42%',
        publishFile: content => { published.push(content); return null; },
        sendOutbound: () => true,
      } });
      await settled();
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(published).toEqual(['매출 42% «확인 필요»']);
    } finally {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 12_000);

  test('default source reader refuses a redirect from an allowed host to an internal address', async () => {
    const fetched: string[] = [];
    const originalFetch = globalThis.fetch;
    const published: string[] = [];
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
        fetched.push(String(input));
        expect(options?.redirect).toBe('manual');
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private.md' } });
      }) as unknown as typeof fetch;
      await submitSeatDocRequest({ text: '@CMO https://github.com/example/brief.md 초안', deps: {
        submitExec: async () => ({ id: 'exec-redirect' }),
        getExec: async () => ({ status: 'done', summary: '완료', results: [
          { seat: 'CMO', title: 'draft.md', kind: 'report', url: '/v1/exec-requests/exec-redirect/files/draft.md' },
        ] }),
        getFile: async () => '매출 42%',
        publishFile: content => { published.push(content); return null; },
        sendOutbound: () => true,
      } });
      await settled();
      expect(fetched).toEqual(['https://github.com/example/brief.md']);
      expect(published).toEqual(['매출 42% «확인 필요»']);
    } finally { globalThis.fetch = originalFetch; }
  });

  test('unavailable or ambiguous supplied evidence never invents a citation or drops a number', async () => {
    const delivered: string[] = [];
    await submitSeatDocRequest({ text: '@CMO a.md b.md missing.md 초안', deps: {
      readSource: async ref => ref === 'missing.md' ? null : '매출 42%\n기타 12건',
      submitExec: async () => ({ id: 'exec-unknown' }),
      getExec: async () => ({ status: 'done', summary: '완료', results: [
        { seat: 'CMO', title: 'draft.md', kind: 'report', url: '/v1/exec-requests/exec-unknown/files/draft.md' },
      ] }),
      getFile: async () => '매출 42% [출처: missing.md]\n기타 12건 [출처: a.md]\n미상 70명 «확인 필요»',
      publishFile: content => { delivered.push(content); return null; },
      sendOutbound: () => true,
    } });
    await settled();
    expect(delivered).toEqual(['매출 42% «확인 필요»\n기타 12건 «확인 필요»\n미상 70명 «확인 필요»']);
  });

  test('requests without supplied references keep their existing document bytes', async () => {
    const published: string[] = [];
    await submitSeatDocRequest({ text: '@CMO 초안', deps: {
      submitExec: async value => { expect(value).toBe('@CMO 초안'); return { id: 'exec-plain' }; },
      getExec: async () => ({ status: 'done', summary: '완료', results: [
        { seat: 'CMO', title: 'draft.md', kind: 'report', url: '/v1/exec-requests/exec-plain/files/draft.md' },
      ] }),
      getFile: async () => '2026년 목표 42건',
      publishFile: content => { published.push(content); return null; },
      sendOutbound: () => true,
    } });
    await settled();
    expect(published).toEqual(['2026년 목표 42건']);
  });

  test('a failed research still submits and explicitly reports proceeding without research', async () => {
    const submitted: string[] = [];
    const deliveries: string[] = [];
    const events: string[] = [];
    await submitSeatDocRequest({ text: '@cmo 경쟁 시장 전략 글', reportTo, deps: {
      research: async () => { throw new Error('offline'); },
      submitExec: async text => { submitted.push(text); return { id: 'exec-2' }; },
      getExec: async () => ({ status: 'done', summary: '완료', results: [] }),
      sendOutbound: text => { deliveries.push(text); return true; },
      log: event => { events.push(event); },
    } });
    await settled();
    expect(submitted).toEqual(['@cmo 경쟁 시장 전략 글']);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toContain('조사 없이');
    expect(events).toEqual(['research', 'submitted', 'settled', 'delivered']);
  });

  test('failed execution reports its reason once, even if sending fails', async () => {
    const deliveries: unknown[][] = [];
    const events: string[] = [];
    await submitSeatDocRequest({ text: '@cmo 메모', reportTo, deps: {
      submitExec: async () => ({ id: 'exec-3' }),
      getExec: async () => ({ status: 'failed', summary: '그래프 실행 실패', results: [] }),
      sendOutbound: (...args) => { deliveries.push(args); return false; },
      log: event => { events.push(event); },
    } });
    await settled();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]![0]).toContain('그래프 실행 실패');
    expect(deliveries[0]![2]).toEqual(reportTo);
    expect(events).toEqual(['submitted', 'settled', 'delivery-failed']);
  });

  test('at 30 minutes a running request receives one PWA status reply and polling stops', async () => {
    let now = 0;
    let polls = 0;
    const deliveries: string[] = [];
    await submitSeatDocRequest({ text: '@cmo 초안', reportTo, deps: {
      submitExec: async () => ({ id: 'exec-4' }),
      getExec: async () => { polls++; return { status: 'running', summary: '', results: [] }; },
      now: () => now,
      sleep: async ms => { now += ms; },
      sendOutbound: text => { deliveries.push(text); return true; },
    } });
    await settled();
    expect(now).toBe(30 * 60_000);
    expect(polls).toBe(360);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toContain('아직 도는 중 · PWA 에서 확인');
    expect(deliveries[0]).toContain('접수번호 exec-4 · 외부 접속 주소 없음');
    expect(deliveries[0]).not.toContain('/v1/exec-requests/');
  });

  test('temporary lookup errors retry until the real done status without sending a false failure', async () => {
    let polls = 0;
    const deliveries: string[] = [];
    await submitSeatDocRequest({ text: '@cmo 메모', reportTo, deps: {
      submitExec: async () => ({ id: 'exec-retry' }),
      getExec: async () => {
        if (++polls === 1) throw new Error('HTTP 503');
        return { status: 'done', summary: '초안 완성', results: [] };
      },
      sleep: async ms => { expect(ms).toBe(5_000); },
      pwaUrl: () => 'https://phone.example.test/app/',
      sendOutbound: text => { deliveries.push(text); return true; },
    } });
    await settled();
    expect(polls).toBe(2);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toContain('초안 완성');
    expect(deliveries[0]).not.toContain('HTTP 503');
  });

  test('when a file cannot be published, reply with its fetched contents instead of an inaccessible API URL', async () => {
    const deliveries: string[] = [];
    await submitSeatDocRequest({ text: '@cmo 초안', reportTo, deps: {
      submitExec: async () => ({ id: 'exec-inline' }),
      getExec: async () => ({ status: 'done', summary: '초안 완성', results: [
        { seat: 'CMO', title: 'draft.md', kind: 'report', url: '/v1/exec-requests/exec-inline/files/run--draft.md' },
      ] }),
      getFile: async () => '# 전략 초안',
      publishFile: () => null,
      sendOutbound: text => { deliveries.push(text); return true; },
    } });
    await settled();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toContain('draft.md (report) · \n# 전략 초안');
    expect(deliveries[0]).not.toContain('/v1/exec-requests/');
  });

  test('persistent lookup errors end as unknown at the deadline, not as running or failed', async () => {
    let now = 0;
    let polls = 0;
    const deliveries: unknown[][] = [];
    const settledEvents: Record<string, unknown>[] = [];
    await submitSeatDocRequest({ text: '@cmo 메모', reportTo, deps: {
      submitExec: async () => ({ id: 'exec-unavailable' }),
      getExec: async () => { polls++; throw new Error('network offline'); },
      now: () => now,
      sleep: async ms => { now += ms; },
      pwaUrl: () => 'http://127.0.0.1:31415/app/',
      sendOutbound: (...args) => { deliveries.push(args); return true; },
      log: (event, data) => { if (event === 'settled') settledEvents.push(data); },
    } });
    await settled();
    expect(polls).toBe(360);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]![0]).toContain('상태를 확인할 수 없어 확인을 종료했습니다 · PWA 에서 확인');
    expect(deliveries[0]![0]).not.toContain('아직 도는 중');
    expect(deliveries[0]![0]).not.toContain('문서 요청 실패');
    expect(deliveries[0]![0]).not.toContain('127.0.0.1');
    expect(deliveries[0]!.slice(1)).toEqual(['report', reportTo]);
    expect(settledEvents).toEqual([{ id: 'exec-unavailable', status: 'lookup-unavailable', lastConfirmedStatus: undefined }]);
  });

  test('a running snapshot followed by persistent lookup errors does not claim it is still running', async () => {
    let now = 0;
    let polls = 0;
    const deliveries: string[] = [];
    const settledEvents: Record<string, unknown>[] = [];
    await submitSeatDocRequest({ text: '@cmo 메모', reportTo, deps: {
      submitExec: async () => ({ id: 'exec-stale' }),
      getExec: async () => {
        if (++polls === 1) return { status: 'running', summary: '', results: [] };
        throw new Error('network offline');
      },
      now: () => now,
      sleep: async ms => { now += ms; },
      sendOutbound: text => { deliveries.push(text); return true; },
      log: (event, data) => { if (event === 'settled') settledEvents.push(data); },
    } });
    await settled();
    expect(polls).toBe(360);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toContain('상태를 확인할 수 없어 확인을 종료했습니다');
    expect(deliveries[0]).not.toContain('아직 도는 중');
    expect(deliveries[0]).not.toContain('문서 요청 실패');
    expect(settledEvents).toEqual([{ id: 'exec-stale', status: 'lookup-unavailable', lastConfirmedStatus: 'running' }]);
  });
});

test('CO1 — any non-code request to @coo goes to the planner; code requests and other seats do not', async () => {
  const { isCooPlannerRequest } = await import('./seat-doc-route.js');
  expect(isCooPlannerRequest('@coo 내일 행사 준비 나눠 줘')).toBe(true);
  expect(isCooPlannerRequest('@coo 마케터스 나이트 — AI 답변 점검, 임원 보고 한 장, 홍보 글')).toBe(true);
  expect(isCooPlannerRequest('@coo 로그인 버그 고쳐 줘')).toBe(false);
  expect(isCooPlannerRequest('@cto 내일 행사 준비 나눠 줘')).toBe(false);
  expect(isCooPlannerRequest('@coo')).toBe(false);
  expect(isCooPlannerRequest('내일 행사 준비 나눠 줘')).toBe(false);
});
