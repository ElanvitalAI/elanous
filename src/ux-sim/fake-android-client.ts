export type FakeAndroidHttpMethod = 'GET' | 'POST';

export interface FakeAndroidRequest {
  method: FakeAndroidHttpMethod;
  path: string;
  bearer?: string;
  idempotencyKey?: string;
  body?: unknown;
}

export interface FakeAndroidResponse {
  status: number;
  body?: unknown;
}

export interface FakeAndroidEvent {
  event: 'briefing.ready' | 'board.card';
  data: unknown;
}

/** HTTP/SSE contract world for the Android briefing and mini-board surfaces. */
export interface FakeAndroidClientWorld {
  readonly requests: FakeAndroidRequest[];
  readonly networkAttempts: string[];
  request(input: FakeAndroidRequest): FakeAndroidResponse;
  events(bearer: string): FakeAndroidEvent[];
}

/** Generic HTTP adapter for replaying Android requests through an in-process API handler. */
export function createFakeAndroidApiClient(dispatch: (request: Request) => Promise<Response | undefined> | Response | undefined) {
  const requests: FakeAndroidRequest[] = [];
  return {
    requests,
    async request(input: FakeAndroidRequest): Promise<FakeAndroidResponse> {
      requests.push(structuredClone(input));
      const response = await dispatch(new Request(`http://nexus.test${input.path}`, {
        method: input.method,
        ...(input.bearer || input.idempotencyKey ? { headers: {
          ...(input.bearer ? { authorization: `Bearer ${input.bearer}` } : {}),
          ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {}),
        } } : {}),
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      }));
      return response
        ? { status: response.status, body: await response.json() }
        : { status: 404, body: { error: 'not_found' } };
    },
  };
}

export function createFakeAndroidClientWorld(): FakeAndroidClientWorld {
  const briefings = [
    { id: 'brief-a', memberId: 'member-a', day: '2026-11-09', trigger: 'daily', topics: [{ title: 'KAIST 강의 노트', scrapIds: ['scrap-a'], summary: '공유 자료를 강의 노트로 정리합니다.' }], todos: ['강의 노트 앱에 제안 반영'], suggestionIds: ['suggest-a'], createdAt: '2026-11-09T00:00:00.000Z' },
    { id: 'brief-b', memberId: 'member-b', day: '2026-11-09', trigger: 'daily', topics: [{ title: '개인 메모', scrapIds: ['scrap-b'], summary: '회원 B 전용 브리핑입니다.' }], todos: [], suggestionIds: [], createdAt: '2026-11-09T00:00:00.000Z' },
  ];
  const suggestions = new Map([['suggest-a', { id: 'suggest-a', memberId: 'member-a', briefingId: 'brief-a', appId: 'lecture-scrap', title: '강의 노트 앱에 공유 입력 추가', why: '공유한 자료를 한곳에서 읽기 위해', evidenceScrapIds: ['scrap-a'], change: { note: '공유 입력을 추가합니다.' }, state: 'proposed' as 'proposed' | 'approved' | 'dismissed' }]]);
  const cards = new Map([['card-a', { id: 'card-a', memberId: 'member-a', suggestionId: 'suggest-a', appId: 'lecture-scrap', title: '강의 노트 앱에 공유 입력 추가', state: 'proposed' as 'proposed' | 'approved' | 'dismissed' | 'developing' | 'testing' | 'deployed' | 'failed', progress: '제안됨', updatedAt: '2026-11-09T00:00:00.000Z' }]]);
  const tokens = new Map([['owner-a', 'member-a'], ['owner-b', 'member-b']]);
  const requests: FakeAndroidRequest[] = [];
  const networkAttempts: string[] = [];

  function authenticate(bearer: string | undefined): string | undefined {
    return bearer ? tokens.get(bearer) : undefined;
  }

  return {
    requests,
    networkAttempts,
    request(input) {
      const request = { ...input };
      requests.push(request);
      const memberId = authenticate(request.bearer);
      if (!memberId) return { status: 401, body: { error: 'unauthorized' } };

      const list = /^\/v1\/briefings\?day=(\d{4}-\d{2}-\d{2})$/.exec(request.path);
      if (request.method === 'GET' && list) {
        return { status: 200, body: { briefings: briefings.filter((row) => row.memberId === memberId && row.day === list[1]) } };
      }
      const briefing = /^\/v1\/briefings\/([a-z0-9-]+)$/.exec(request.path);
      if (request.method === 'GET' && briefing) {
        const row = briefings.find((candidate) => candidate.id === briefing[1] && candidate.memberId === memberId);
        return row ? { status: 200, body: row } : { status: 404, body: { error: 'not_found' } };
      }
      if (request.method === 'GET' && request.path === '/v1/board') {
        return { status: 200, body: [...cards.values()].filter((row) => row.memberId === memberId) };
      }
      const approve = /^\/v1\/board\/([a-z0-9-]+)\/approve$/.exec(request.path);
      if (request.method === 'POST' && approve) {
        const card = cards.get(approve[1]!);
        if (!card || card.memberId !== memberId) return { status: 404, body: { error: 'not_found' } };
        const suggestion = suggestions.get(card.suggestionId);
        if (!suggestion || suggestion.memberId !== memberId || suggestion.state !== 'proposed') {
          return { status: 409, body: { error: 'not_approvable' } };
        }
        suggestion.state = 'approved';
        card.state = 'approved';
        card.progress = '승인됨';
        return { status: 200, body: card };
      }
      return { status: 404, body: { error: 'not_found' } };
    },
    events(bearer) {
      const memberId = authenticate(bearer);
      if (!memberId) return [];
      return [
        ...briefings.filter((row) => row.memberId === memberId).map((data) => ({ event: 'briefing.ready' as const, data })),
        ...[...cards.values()].filter((row) => row.memberId === memberId).map((data) => ({ event: 'board.card' as const, data })),
      ];
    },
  };
}
