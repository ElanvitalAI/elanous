export interface GraphApproval {
  graphId: string;
  runId: string;
  nodeId: string;
  message: string;
  since: string;
  path: string[];
  recent: Array<{ nodeId: string; ok: boolean; outcome?: string; summary?: string }>;
  /** EV10d — a «게시 대기» feed draft (only for feed-preview approvals). */
  feed?: FeedDraft;
}

export interface FeedSlide { image: string; caption: string; include: boolean }
export interface FeedDraft {
  revision: number;
  updatedBy: string;
  brand?: { name?: string; handle?: string; avatar?: string | null };
  cover: { text: string; sub: string; image?: string };
  slides: FeedSlide[];
  caption: { hook: string; body: string };
  hashtags: string[];
  location: string | null;
  reel: string | null;
}
/** What «수정 저장» sends — the server keeps every other field as it was. */
export interface FeedEdit {
  slides: Array<{ image: string; caption: string; include: boolean }>;
  caption: { hook: string; body: string };
  hashtags: string[];
  cover: { text: string; sub: string };
  location: string | null;
}

export function feedEditOf(draft: FeedDraft): FeedEdit {
  return {
    slides: draft.slides.map(({ image, caption, include }) => ({ image, caption, include })),
    caption: { hook: draft.caption.hook, body: draft.caption.body },
    hashtags: [...draft.hashtags],
    cover: { text: draft.cover.text, sub: draft.cover.sub },
    location: draft.location,
  };
}

export type GraphApprovalDecision = 'approved' | 'rejected';

export class GraphApprovalsApiError extends Error {
  constructor(public readonly status: number, code: string) {
    super(code);
    this.name = 'GraphApprovalsApiError';
  }
}

export function graphApprovalErrorText(error: unknown): string {
  if (error instanceof GraphApprovalsApiError) {
    if (error.status === 401) return '소유자 인증이 필요합니다. 설정에서 연결 토큰을 확인해 주세요.';
    if (error.status === 403) return '이 기기에서 승인하려면 페어링이 필요합니다. 설정에서 연결 토큰을 넣어 주세요.';
    if (error.status === 404) return '이 실행을 찾지 못했습니다. 목록을 다시 확인해 주세요.';
    if (error.status === 409) return '이미 결정된 실행입니다. 목록을 다시 확인해 주세요.';
    if (error.status === 400) return '결정 내용을 확인한 뒤 다시 시도해 주세요.';
    return '승인 요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
  }
  if (error instanceof TypeError) return '서버에 연결하지 못했습니다. 연결 상태를 확인해 주세요.';
  return '승인 요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
}

const PATH = '/v1/graph-approvals';

export function createGraphApprovalsApi(opts: { baseUrl?: string; fetchImpl?: typeof fetch; authHeader?: string; client?: Pick<import('./daemon-client').DaemonClient, 'fetchResponse'> }) {
  const baseUrl = (opts.baseUrl ?? '').replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const request: RequestInit = {
      ...init,
      headers: { 'content-type': 'application/json', ...(opts.authHeader ? { authorization: opts.authHeader } : {}) },
    };
    const response = opts.client ? await opts.client.fetchResponse(path, request) : await fetchImpl(`${baseUrl}${path}`, request);
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'request-failed';
      throw new GraphApprovalsApiError(response.status, code);
    }
    return body as T;
  }
  return {
    list: () => call<{ items: GraphApproval[] }>(PATH),
    decide: (graphId: string, runId: string, decision: GraphApprovalDecision) => call<{ graphId: string; runId: string; decision: GraphApprovalDecision }>(
      `${PATH}/${encodeURIComponent(graphId)}/${encodeURIComponent(runId)}`, { method: 'POST', body: JSON.stringify({ decision }) },
    ),
    /** EV10d «수정 저장» — overwrites the run's draft; the approval stays pending. */
    saveFeedDraft: (graphId: string, runId: string, edit: FeedEdit) => call<{ graphId: string; runId: string; feed: FeedDraft }>(
      `${PATH}/${encodeURIComponent(graphId)}/${encodeURIComponent(runId)}/feed-draft`, { method: 'PUT', body: JSON.stringify(edit) },
    ),
    /** Draft media as a blob (images need the owner bearer, so <img src> cannot fetch them directly). */
    feedMedia: async (graphId: string, runId: string, path: string): Promise<Blob> => {
      const target = `${PATH}/${encodeURIComponent(graphId)}/${encodeURIComponent(runId)}/media?path=${encodeURIComponent(path)}`;
      const request: RequestInit = { headers: opts.authHeader ? { authorization: opts.authHeader } : {} };
      const response = opts.client ? await opts.client.fetchResponse(target, request) : await fetchImpl(`${baseUrl}${target}`, request);
      if (!response.ok) throw new GraphApprovalsApiError(response.status, 'media-failed');
      return response.blob();
    },
  };
}
