/** POST /v1/pod/credential/grok — Pod 가 만료 전에 새 grok access 만 받는 문.
 *
 *  인증은 넥서스 bearer 가 아니다. `mintGroundingToken({ scope: 'llm-credential' })` 만 통과한다.
 *  응답 키는 `key`·`expires_at` 둘뿐. refresh·계정 id·파일 경로는 응답·로그·에러에 싣지 않는다.
 */
import { debug } from '../../debug/log.js';
import { verifyGroundingToken, type GroundingTokenDeps } from '../../grounding/token.js';
import { isGrokSubscriptionExpiring, readGrokSubscriptionAccess, refreshGrokSubscriptionToken } from '../../grok/credential.js';

export const POD_CREDENTIAL_GROK_PATH = '/v1/pod/credential/grok';
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

interface HitWindow {
  readonly stamps: number[];
}

const hitsByRun = new Map<string, HitWindow>();
const globalHits: number[] = [];

export function resetPodCredentialRateForTesting(): void {
  hitsByRun.clear();
  globalHits.length = 0;
}

function prune(stamps: number[], now: number): number[] {
  return stamps.filter((t) => now - t < 60_000);
}

function takeRate(runId: string, now: number): boolean {
  const prev = prune(hitsByRun.get(runId)?.stamps ?? [], now);
  const global = prune(globalHits, now);
  globalHits.length = 0;
  globalHits.push(...global);
  if (prev.length >= POD_CREDENTIAL_PER_RUN_PER_MIN || globalHits.length >= POD_CREDENTIAL_GLOBAL_PER_MIN) {
    hitsByRun.set(runId, { stamps: prev });
    return false;
  }
  prev.push(now);
  globalHits.push(now);
  hitsByRun.set(runId, { stamps: prev });
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

/**
 * 쓰기 관문. 본문을 읽지 않는다. 토큰이 없거나 서명이 깨지면 401,
 * scope·만료·회수는 403 과 사유만.
 */
export async function authenticatePodCredential(
  req: Request,
  deps: PodCredentialDeps = {},
): Promise<
  | { readonly ok: true; readonly runId: string; readonly job: string; readonly exp: number }
  | { readonly ok: false; readonly response: Response }
> {
  const token = bearerOf(req);
  if (!token) return { ok: false, response: Response.json({ error: 'unauthorized' }, { status: 401 }) };
  const verified = await verifyGroundingToken(token, { ...(deps.token ?? {}), expectedScope: 'llm-credential' });
  if (!verified.ok) {
    if (verified.reason === 'expired' || verified.reason === 'revoked' || verified.reason === 'scope') {
      return { ok: false, response: reasonResponse(403, verified.reason) };
    }
    return { ok: false, response: Response.json({ error: 'unauthorized' }, { status: 401 }) };
  }
  return { ok: true, runId: verified.runId, job: verified.job, exp: verified.exp };
}
