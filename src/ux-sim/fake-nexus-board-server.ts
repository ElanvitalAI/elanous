export interface FakeNexusBoardServer {
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requests(): readonly { path: string; authorization: string | null }[];
  eventConnections(): number;
  publishOwnedCard(): void;
}

/** Fake GET /v1/board + board.card SSE endpoint; binds no network socket. */
export function createFakeNexusBoardServer(options: {
  lineEnding?: '\n' | '\r\n';
  advanceOnOwnEvent?: boolean;
  autoEventOnConnect?: boolean;
  closeAfterEvent?: boolean;
} = {}): FakeNexusBoardServer {
  const seen: Array<{ path: string; authorization: string | null }> = [];
  const lineEnding = options.lineEnding ?? '\n';
  const encoder = new TextEncoder();
  let eventCount = 0;
  let cardState = options.advanceOnOwnEvent ? 'testing' : 'deployed';
  const eventStreams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const publishOwnedCard = () => {
    cardState = 'deployed';
    const separator = `${lineEnding}${lineEnding}`;
    const frame = encoder.encode([
      `event: board.card${lineEnding}data: {"memberId":"member-b","card":{"id":"card-b","memberId":"member-b","title":"다른 회원 앱","state":"proposed"}}${separator}`,
      `event: board.card${lineEnding}data: {"memberId":"member-a","card":{"id":"card-a","memberId":"member-a","title":"무대 앱","state":"deployed"}}${separator}`,
    ].join(''));
    for (const controller of eventStreams) {
      try {
        controller.enqueue(frame);
        if (options.closeAfterEvent !== false) {
          eventStreams.delete(controller);
          controller.close();
        }
      } catch { eventStreams.delete(controller); }
    }
  };
  const fetch: FakeNexusBoardServer['fetch'] = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    seen.push({ path: url.pathname, authorization: headers.get('authorization') });
    if (headers.get('authorization') !== 'Bearer fake-member-token') {
      return new Response('unauthorized', { status: 401 });
    }
    if (url.pathname === '/v1/board' && init?.method === 'GET') {
      return Response.json({ cards: [
        { id: 'card-a', memberId: 'member-a', title: '무대 앱', state: cardState, progress: cardState === 'deployed' ? '공개됨' : '실행 확인', runId: 'run-12345678', publicUrl: 'https://demo.example.test', updatedAt: '2026-11-09T08:00:00.000Z' },
        { id: 'card-b', memberId: 'member-b', title: '다른 회원 앱', state: 'proposed' },
        { id: 'bad-card', memberId: 'member-a', title: '잘못된 상태', state: 'unknown' },
      ] });
    }
    if (url.pathname === '/v1/events' && url.searchParams.get('topics') === 'board.card') {
      eventCount++;
      let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          eventStreams.add(controller);
          if (options.autoEventOnConnect !== false) publishOwnedCard();
        },
        cancel() { if (streamController) eventStreams.delete(streamController); },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('not-found', { status: 404 });
  };
  return { fetch, requests: () => seen.slice(), eventConnections: () => eventCount, publishOwnedCard };
}
