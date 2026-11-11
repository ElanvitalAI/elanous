import type { TaskCardEntry, TaskCardSection } from '../../apps/pwa/src/lib/task-card-model.js';

export type MemberBoardState = 'proposed' | 'approved' | 'developing' | 'testing' | 'deployed' | 'failed';

export interface MemberBoardCard {
  readonly id: string;
  readonly memberId: string;
  readonly title: string;
  readonly state: MemberBoardState;
  readonly progress?: string;
  readonly summary?: string;
  readonly reason?: string;
  readonly runId?: string;
  readonly resultUrl?: string;
  readonly publicUrl?: string;
  readonly updatedAt?: string;
}

export interface NexusBoardAdapterOptions {
  readonly baseUrl: string;
  readonly accessToken: () => string | undefined;
  readonly fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}

const SECTION_BY_STATE: Readonly<Record<MemberBoardState, TaskCardSection>> = {
  proposed: 'intake',
  approved: 'landing',
  developing: 'workspace',
  testing: 'release',
  deployed: 'release',
  failed: 'release',
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseCard(value: unknown): MemberBoardCard | undefined {
  const row = object(value);
  if (!row) return undefined;
  const id = string(row.id);
  const memberId = string(row.memberId);
  const title = string(row.title);
  const state = string(row.state) as MemberBoardState | undefined;
  if (!id || !memberId || !title || !state || !Object.prototype.hasOwnProperty.call(SECTION_BY_STATE, state)) return undefined;
  const optional = (key: string) => string(row[key]);
  return {
    id, memberId, title, state,
    ...(optional('progress') ? { progress: optional('progress') } : {}),
    ...(optional('summary') ? { summary: optional('summary') } : {}),
    ...(optional('reason') ? { reason: optional('reason') } : {}),
    ...(optional('runId') ? { runId: optional('runId') } : {}),
    ...(optional('resultUrl') ? { resultUrl: optional('resultUrl') } : {}),
    ...(optional('publicUrl') ? { publicUrl: optional('publicUrl') } : {}),
    ...(optional('updatedAt') ? { updatedAt: optional('updatedAt') } : {}),
  };
}

/** Convert the Nexus member-board wire row to the established shared journal event. */
export function memberBoardCardToTaskCardEntry(card: MemberBoardCard): TaskCardEntry {
  const parsedTs = card.updatedAt ? Date.parse(card.updatedAt) : NaN;
  const ts = Number.isFinite(parsedTs) ? parsedTs : 0;
  const summary = card.summary || card.progress || card.reason;
  return {
    ts,
    taskId: card.id,
    section: SECTION_BY_STATE[card.state],
    owner: 'member-board-api',
    key: `member-board:${card.id}:${card.state}:${card.updatedAt ?? ''}`,
    ...(card.runId ? { runId: card.runId.replace(/^run-/, '') } : {}),
    data: {
      title: card.title,
      ...(summary ? { summary } : {}),
      ...(card.state === 'testing' ? { status: 'testing' } : {}),
      ...(card.state === 'failed' ? { status: 'failed' } : {}),
      ...(card.state === 'deployed' ? {
        status: 'done',
        ...((card.resultUrl || card.publicUrl) ? { resultUrl: card.resultUrl || card.publicUrl } : {}),
      } : {}),
    },
  };
}

/**
 * Read the server-owned board only. The bearer is provided by the member-session
 * owner; this adapter never invents identity or persists a second card store.
 */
export function createNexusBoardAdapter(options: NexusBoardAdapterOptions) {
  const endpoint = new URL(options.baseUrl);
  const loopback = endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1' || endpoint.hostname === '[::1]';
  if (endpoint.protocol !== 'https:' && !loopback) {
    throw new Error('Nexus member board requires HTTPS or a loopback endpoint');
  }
  const base = endpoint.toString().replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = (): Headers => {
    const token = options.accessToken()?.trim();
    if (!token) throw new Error('eln login으로 회원 세션을 연결해 주세요.');
    return new Headers({ authorization: `Bearer ${token}`, accept: 'application/json' });
  };

  return {
    async read(memberId: string): Promise<TaskCardEntry[]> {
      if (!memberId.trim()) return [];
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
      try {
        const response = await fetchImpl(`${base}/v1/board`, {
          method: 'GET', headers: headers(), signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Nexus board 조회 실패 (HTTP ${response.status})`);
        const body: unknown = await response.json();
        const board = object(body);
        if (!board || !Array.isArray(board.cards)) {
          throw new Error('Nexus board 응답 형식이 올바르지 않습니다. cards 배열이 필요합니다.');
        }
        return board.cards
          .map(parseCard)
          .filter((card): card is MemberBoardCard => card !== undefined && card.memberId === memberId)
          .map(memberBoardCardToTaskCardEntry);
      } finally {
        clearTimeout(timeout);
      }
    },

    async watch(
      memberId: string,
      signal: AbortSignal,
      onBoardCard: () => void,
      onReady: () => void = () => {},
    ): Promise<void> {
      const url = new URL(`${base}/v1/events`);
      url.searchParams.set('topics', 'board.card');
      const requestHeaders = headers();
      requestHeaders.set('accept', 'text/event-stream');
      const response = await fetchImpl(url, {
        method: 'GET', headers: requestHeaders, signal,
      });
      if (!response.ok) throw new Error(`Nexus board SSE 연결 실패 (HTTP ${response.status})`);
      if (!response.body) throw new Error('Nexus board SSE 응답 본문이 없습니다.');
      onReady();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          pending += decoder.decode(value, { stream: !done });
          let boundary = /\r?\n\r?\n/.exec(pending);
          while (boundary?.index !== undefined) {
            const frame = pending.slice(0, boundary.index);
            pending = pending.slice(boundary.index + boundary[0].length);
            const eventName = frame.split(/\r?\n/).find((line) => line.startsWith('event:'))?.slice(6).trim();
            const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart()).join('\n');
            if (eventName === 'board.card' && data) {
              try {
                const payload = object(JSON.parse(data));
                const card = parseCard(payload?.card ?? payload);
                if (card?.memberId === memberId) onBoardCard();
              } catch { /* malformed frames are ignored; the next board snapshot is authoritative */ }
            }
            boundary = /\r?\n\r?\n/.exec(pending);
          }
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}
