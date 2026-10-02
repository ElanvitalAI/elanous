import { APPROVALS_MERGES_PATH } from '../../../../src/nexus/api/rest-route-paths';

export interface ApprovalGate {
  status: 'none' | 'running' | 'passed' | 'failed' | 'unmeasured';
  failures: string[];
  startedAt?: string;
  finishedAt?: string;
  os?: string;
  /** 검사한 뒤 main 이 움직였다 — 서버가 머지 때 겹치는 파일을 다시 본다. */
  baseDrifted?: boolean;
}

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
  gate: ApprovalGate;
  summary: string;
  brief: string | null;
  lineage: string | null;
  createdAt: string;
  state: string;
  mergedAt?: string | null;
  approvalPath: string;
}

export class MergeApprovalsApiError extends Error {
  constructor(public readonly status: number, public readonly error: string, public readonly reason?: string) {
    super(reason || error);
    this.name = 'MergeApprovalsApiError';
  }
}

/** A failed call as «cause sentence + what to do» — the raw code alone ("unauthorized", "gh-failed") told the owner nothing. */
export function approvalErrorText(err: unknown, fallback: string): { text: string; href?: string } {
  if (err instanceof MergeApprovalsApiError) {
    if (err.status === 401 || err.error === 'unauthorized') {
      return { text: '이 기기에 소유자 토큰이 없어 승인 목록을 못 읽었습니다 — 이미 연결된 기기의 설정 › 연결 토큰 만들기 에서 토큰을 만들어, 이 기기의 설정 › 데몬 연결 › 연결 토큰 칸에 붙이면 바로 보입니다.', href: '/app/settings/#bearer-token' };
    }
    if (err.error === 'gh-failed') {
      return { text: `데몬이 GitHub 를 읽지 못했습니다(데몬 기계의 gh 로그인·네트워크) — 잠시 뒤 다시 열어 보세요.${err.reason ? ` 사유: ${err.reason.split('\n')[0]!.slice(0, 160)}` : ''}` };
    }
    if (err.error === 'gh-invalid-response') return { text: 'GitHub 응답을 해석하지 못했습니다 — 잠시 뒤 다시 열어 보세요.' };
    if (err.error === 'approvals-repo-unknown') {
      return { text: '승인할 저장소를 모릅니다 — 데몬 설정 intake.approvals.repo(예: owner/repo)를 채워 주세요.', href: '/app/settings/' };
    }
    if (err.reason) return { text: err.reason };
    return { text: `${fallback} (${err.status} ${err.error})` };
  }
  if (err instanceof TypeError) return { text: '데몬에 닿지 못했습니다 — 데몬이 켜져 있는지, 이 기기가 같은 네트워크(tailnet)에 있는지 확인하세요.' };
  return { text: err instanceof Error && err.message ? err.message : fallback };
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
    list: (state: 'open' | 'merged' = 'open') => call<{ items: MergeApproval[] }>(state === 'merged' ? `${APPROVALS_MERGES_PATH}?state=merged` : APPROVALS_MERGES_PATH),
    get: (number: number) => call<MergeApproval>(`${APPROVALS_MERGES_PATH}/${number}`),
    check: (number: number, headSha: string) => call<{ gate: ApprovalGate }>(`${APPROVALS_MERGES_PATH}/${number}/check`, {
      method: 'POST', body: JSON.stringify({ headSha }),
    }),
    merge: (number: number, headSha: string) => call<{ merged: true; number: number }>(`${APPROVALS_MERGES_PATH}/${number}/merge`, {
      method: 'POST', body: JSON.stringify({ headSha }),
    }),
  };
}
