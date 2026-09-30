/** POST /v1/pod/credential/grok — Pod 가 만료 전에 새 grok access 만 받는 문.
 *
 *  인증은 넥서스 bearer 가 아니다. `mintGroundingToken({ scope: 'llm-credential' })` 만 통과한다.
 *  응답 키는 `key`·`expires_at` 둘뿐. refresh·계정 id·파일 경로는 응답·로그·에러에 싣지 않는다.
 */
import { debug } from '../../debug/log.js';
import { githubInstallationCredential } from '../../auth/github-app-token.js';
import { verifyGroundingToken, type GroundingTokenDeps, type GroundingTokenScope } from '../../grounding/token.js';
import { isGrokSubscriptionExpiring, readGrokSubscriptionAccess, refreshGrokSubscriptionToken } from '../../grok/credential.js';

export const POD_CREDENTIAL_GROK_PATH = '/v1/pod/credential/grok';
export const POD_CREDENTIAL_GITHUB_PATH = '/v1/pod/credential/github';
export const POD_GITHUB_CREDENTIAL_TOKEN_ENV = 'ELANOUS_POD_GITHUB_CREDENTIAL_TOKEN';
export const POD_GITHUB_CREDENTIAL_URL_ENV = 'ELANOUS_POD_GITHUB_CREDENTIAL_URL';
/** 만료까지 이 안이면 기존 호스트 갱신(`refreshGrokSubscriptionToken`)을 한 번 부른다. */
export const POD_CREDENTIAL_HOST_REFRESH_WINDOW_MS = 10 * 60 * 1000;
/** runId 당 분당 1회. */
export const POD_CREDENTIAL_PER_RUN_PER_MIN = 1;
/** ⓢ6 — 토큰이 새어 runId 를 늘려도 막는 프로세스 전역 분당 상한. */
export const POD_CREDENTIAL_GLOBAL_PER_MIN = 30;

export type PodCredentialReason = 'expired' | 'revoked' | 'scope' | 'rate' | 'unauthorized' | 'unavailable';

export interface PodCredentialDeps {
  readonly token?: GroundingTokenDeps;
  readonly now?: () => number;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** 테스트 심 — 호스트 grok 바이너리 대신. */
  readonly refreshExec?: (cmd: string, args: string[], timeoutMs: number) => void;
  readonly loadAccess?: (home: string | undefined, env: NodeJS.ProcessEnv) => { key: string; expiresAt: string } | null;
}

export interface PodGithubCredentialDeps {
  readonly token?: GroundingTokenDeps;
  readonly now?: () => number;
  readonly mintInstallation?: (repository: string) => { token: string; expires_at: string } | null;
  readonly installationRepositories?: (token: string) => Promise<readonly string[] | null>;
}

interface HitWindow {
  readonly stamps: number[];
}

const hitsByRun = new Map<string, HitWindow>();
const globalHits: number[] = [];
const githubHitsByRun = new Map<string, HitWindow>();
const githubGlobalHits: number[] = [];

export function resetPodCredentialRateForTesting(): void {
  hitsByRun.clear();
  globalHits.length = 0;
  githubHitsByRun.clear();
  githubGlobalHits.length = 0;
}

function prune(stamps: number[], now: number): number[] {
  return stamps.filter((t) => now - t < 60_000);
}

function takeRate(runId: string, now: number, byRun = hitsByRun, all = globalHits): boolean {
  const prev = prune(byRun.get(runId)?.stamps ?? [], now);
  const global = prune(all, now);
  all.length = 0;
  all.push(...global);
  if (prev.length >= POD_CREDENTIAL_PER_RUN_PER_MIN || all.length >= POD_CREDENTIAL_GLOBAL_PER_MIN) {
    byRun.set(runId, { stamps: prev });
    return false;
  }
  prev.push(now);
  all.push(now);
  byRun.set(runId, { stamps: prev });
  return true;
}

function bearerOf(req: Request): string | null {
  const raw = req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!raw) return null;
  const m = /^Bearer\s+(\S+)$/.exec(raw.trim());
  return m?.[1] ?? null;
}

function reasonResponse(status: number, reason: PodCredentialReason): Response {
  return Response.json({ reason }, { status });
}

function defaultLoad(home: string | undefined, _env: NodeJS.ProcessEnv, refreshExec?: PodCredentialDeps['refreshExec'], now?: () => number): { key: string; expiresAt: string } | null {
  if (isGrokSubscriptionExpiring({
    ...(home ? { home } : {}),
    bufferMs: POD_CREDENTIAL_HOST_REFRESH_WINDOW_MS,
    ...(now ? { now } : {}),
  })) {
    refreshGrokSubscriptionToken({
      ...(home ? { home } : {}),
      ...(refreshExec ? { execImpl: refreshExec } : {}),
    });
  }
  const access = readGrokSubscriptionAccess(home);
  if (!access?.expiresAt) return null;
  return { key: access.key, expiresAt: access.expiresAt };
}

/** 핸들러 몸. http-server 는 이 함수를 부르기 «전»에 `authenticatePodCredential` 을 먼저 부른다. */
export async function handlePodGrokCredential(req: Request, deps: PodCredentialDeps = {}): Promise<Response> {
  const gate = await authenticatePodCredential(req, deps);
  if (!gate.ok) return gate.response;
  const now = (deps.now ?? Date.now)();
  if (!takeRate(gate.runId, now)) return reasonResponse(429, 'rate');

  const env = deps.env ?? process.env;
  let loaded: { key: string; expiresAt: string } | null;
  try {
    loaded = deps.loadAccess
      ? deps.loadAccess(deps.home, env)
      : defaultLoad(deps.home, env, deps.refreshExec, deps.now);
  } catch {
    return reasonResponse(503, 'unavailable');
  }
  if (!loaded || !loaded.key) return reasonResponse(503, 'unavailable');

  const expiresAt = loaded.expiresAt;
  debug.log('pod.credential', 'grok-issued', { runId: gate.runId, job: gate.job, expiresAt });
  debug.log('pod.credential', 'issuance', { runId: gate.runId, job: gate.job, exp: gate.exp });
  return Response.json({ key: loaded.key, expires_at: expiresAt });
}

export async function installationRepositories(token: string): Promise<readonly string[] | null> {
  const response = await fetch('https://api.github.com/installation/repositories?per_page=100', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray((data as { repositories?: unknown }).repositories)) return null;
  const body = data as { total_count?: unknown; repositories: unknown[] };
  if (body.repositories.length !== 1 || body.total_count !== 1) return null;
  const name = body.repositories[0] && typeof body.repositories[0] === 'object' && !Array.isArray(body.repositories[0]) ? (body.repositories[0] as { full_name?: unknown }).full_name : undefined;
  return typeof name === 'string' ? [name] : null;
}

/** No repository is accepted from the request body: the host signed its owner/name into the run token. */
export async function handlePodGithubCredential(req: Request, deps: PodGithubCredentialDeps = {}): Promise<Response> {
  const gate = await authenticatePodCredential(req, deps, 'gh-credential');
  if (!gate.ok) return gate.response;
  if (!gate.repository || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(gate.repository)) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!takeRate(gate.runId, (deps.now ?? Date.now)(), githubHitsByRun, githubGlobalHits)) return reasonResponse(429, 'rate');

  let issued: { token: string; expires_at: string } | null;
  try {
    issued = (deps.mintInstallation ?? ((repository) => githubInstallationCredential({ scope: { repository: repository.split('/')[1]! } })))(gate.repository);
  } catch {
    return reasonResponse(503, 'unavailable');
  }
  if (!issued?.token || typeof issued.expires_at !== 'string' || !Number.isFinite(Date.parse(issued.expires_at)) || Date.parse(issued.expires_at) <= (deps.now ?? Date.now)()) return reasonResponse(503, 'unavailable');
  try {
    const available = await (deps.installationRepositories ?? installationRepositories)(issued.token);
    if (available?.length !== 1 || available[0]?.toLowerCase() !== gate.repository.toLowerCase()) return reasonResponse(503, 'unavailable');
  } catch {
    return reasonResponse(503, 'unavailable');
  }
  debug.log('pod.credential', 'github-issued', { runId: gate.runId, job: gate.job, expiresAt: issued.expires_at });
  return Response.json({ token: issued.token, expires_at: issued.expires_at });
}

/**
 * 쓰기 관문. 본문을 읽지 않는다. 토큰이 없거나 서명이 깨지면 401,
 * scope·만료·회수는 403 과 사유만.
 */
export async function authenticatePodCredential(
  req: Request,
  deps: Pick<PodCredentialDeps, 'token'> = {},
  expectedScope: GroundingTokenScope = 'llm-credential',
): Promise<
  | { readonly ok: true; readonly runId: string; readonly job: string; readonly repository?: string; readonly exp: number }
  | { readonly ok: false; readonly response: Response }
> {
  const token = bearerOf(req);
  if (!token) return { ok: false, response: Response.json({ error: 'unauthorized' }, { status: 401 }) };
  const verified = await verifyGroundingToken(token, { ...(deps.token ?? {}), expectedScope });
  if (!verified.ok) {
    if (verified.reason === 'expired' || verified.reason === 'revoked' || verified.reason === 'scope') {
      return { ok: false, response: reasonResponse(403, verified.reason) };
    }
    return { ok: false, response: Response.json({ error: 'unauthorized' }, { status: 401 }) };
  }
  return { ok: true, runId: verified.runId, job: verified.job, ...(verified.repository ? { repository: verified.repository } : {}), exp: verified.exp };
}
