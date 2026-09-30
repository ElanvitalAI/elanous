export interface GraphApproval {
  graphId: string;
  runId: string;
  nodeId: string;
  message: string;
  since: string;
  path: string[];
  recent: Array<{ nodeId: string; ok: boolean; outcome?: string; summary?: string }>;
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
  };
}
