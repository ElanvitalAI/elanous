import { describe, expect, test } from 'bun:test';
import { isSeatDocRequest, submitSeatDocRequest, type SeatDocDeps } from './seat-doc-route.js';

const reportTo = { channel: 'telegram' as const, chatId: -100123, botId: 'bot-1' };

async function settled(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

describe('seat document route', () => {
  test('requires a seat address and document language; code language wins', () => {
    for (const body of ['전략', '한 장', '원페이저', '기획', '보도자료', '글', '메모', '초안', 'one-pager', 'strategy', 'post', 'memo', 'draft']) {
      expect(isSeatDocRequest(`@CMO ${body} 써줘`)).toBe(true);
    }
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
