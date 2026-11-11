export interface VerifiedMemberOwner {
  memberId: string;
  appSlug: string;
}

type MemberFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type MemberEventSource = Pick<EventSource, 'addEventListener' | 'close'>;
type MemberEventSourceFactory = (url: string, init: EventSourceInit) => MemberEventSource;

export interface MemberMiniBoardApi {
  getVerifiedOwner(): Promise<VerifiedMemberOwner>;
  getBoard(): Promise<unknown>;
  approveCard?(cardId: string): Promise<{ dispatch?: { acceptanceId: string } }>;
  getBriefings(day: string): Promise<unknown>;
  subscribe(memberId: string, onChange: () => void): () => void;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function json(fetchImpl: MemberFetch, url: string): Promise<unknown> {
  const response = await fetchImpl(url, { credentials: 'include', headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(response.status === 401 ? '회원 로그인 후 본인 보드를 확인해 주세요.' : `회원 보드 조회 실패 (HTTP ${response.status})`);
  return response.json();
}

/** Reads only the revocable member cookie and asks NEXUS to attest the app-bound owner. */
export function createMemberMiniBoardApi(
  baseUrl: string,
  fetchImpl: MemberFetch = fetch,
  eventSource: MemberEventSourceFactory = (url, init) => new EventSource(url, init),
): MemberMiniBoardApi {
  const base = baseUrl.replace(/\/$/, '');
  const get = (path: string) => json(fetchImpl, `${base}${path}`);
  return {
    async getVerifiedOwner() {
      const profile = record(await get('/v1/members'));
      const memberId = record(profile?.member)?.id;
      const appSlug = record(profile?.appSlot)?.appSlug;
      if (typeof memberId !== 'string' || !memberId || typeof appSlug !== 'string' || !appSlug) {
        throw new Error('회원 앱 슬롯을 찾을 수 없습니다. 회원 계정과 앱 연결을 확인해 주세요.');
      }
      const owner = record(await get(`/v1/members/owner?appSlug=${encodeURIComponent(appSlug)}`));
      if (owner?.memberId !== memberId) throw new Error('본인 앱 소유권을 확인하지 못했습니다.');
      return { memberId, appSlug };
    },
    getBoard: () => get('/v1/board'),
    async approveCard(cardId) {
      // Source: /v1/board/:id/approve CARD_ID contract in src/nexus/api/board-api.ts.
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(cardId)) throw new Error('유효하지 않은 카드 ID입니다.');
      const response = await fetchImpl(`${base}/v1/board/${encodeURIComponent(cardId)}/approve`, {
        method: 'POST', credentials: 'include', headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approved' }),
      });
      if (!response.ok) throw new Error(`제안 승인 실패 (HTTP ${response.status})`);
      return response.json() as Promise<{ dispatch?: { acceptanceId: string } }>;
    },
    getBriefings: (day) => get(`/v1/briefings?day=${encodeURIComponent(day)}`),
    subscribe(memberId, onChange) {
      const url = new URL(`${base}/v1/events`);
      url.searchParams.set('topics', 'briefing.ready,board.card');
      const source = eventSource(url.toString(), { withCredentials: true });
      const receive = (event: Event) => {
        if (!(event instanceof MessageEvent)) return;
        try {
          if (record(JSON.parse(event.data))?.memberId === memberId) onChange();
        } catch { /* Ignore malformed events; the next valid event or manual refresh recovers. */ }
      };
      source.addEventListener('briefing.ready', receive);
      source.addEventListener('board.card', receive);
      return () => source.close();
    },
  };
}
