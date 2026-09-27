import { APPROVALS_MERGES_PATH } from '../../../../src/nexus/api/rest-route-paths';

export interface MergeApproval {
  number: number;
  title: string;
  url: string;
  headSha: string;
  base: string;
  draft: boolean;
  mergeable: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: string[];
  checks: { success: number; failure: number; pending: number };
  summary: string;
  createdAt: string;
  state: string;
  approvalPath: string;
}

export class MergeApprovalsApiError extends Error {
  constructor(public readonly status: number, public readonly error: string, public readonly reason?: string) {
    super(reason || error);
    this.name = 'MergeApprovalsApiError';
  }
}

export function createMergeApprovalsApi(opts: { baseUrl?: string; fetchImpl?: typeof fetch; authHeader?: string; client?: Pick<import('./daemon-client').DaemonClient, 'fetchResponse'> }) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? '').replace(/\/+$/, '');
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const request: RequestInit = {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(opts.authHeader ? { authorization: opts.authHeader } : {}),
      },
    };
    const response = opts.client
      ? await opts.client.fetchResponse(path, request)
      : await fetchImpl(`${baseUrl}${path}`, request);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const failure = body && typeof body === 'object' ? body as { error?: string; reason?: string } : {};
      throw new MergeApprovalsApiError(response.status, failure.error ?? 'request-failed', failure.reason);
    }
    return body as T;
  }
  return {
    list: () => call<{ items: MergeApproval[] }>(APPROVALS_MERGES_PATH),
    get: (number: number) => call<MergeApproval>(`${APPROVALS_MERGES_PATH}/${number}`),
    merge: (number: number, headSha: string) => call<{ merged: true; number: number }>(`${APPROVALS_MERGES_PATH}/${number}/merge`, {
      method: 'POST', body: JSON.stringify({ headSha }),
    }),
  };
}
