/** ⭐ 원격 그라운딩 토큰(P13 · 🅢 토큰·주입 / 🅣 엔드포인트 · 채널 합의 2026-09-26).
 *
 *  Pod 는 호스트 우주를 «직접» 읽지 않는다(4우주·최소 자격). 대신 호스트 `POST /v1/grounding/query` 에
 *  «질의 → 인용»만 묻는다. 그 문을 여는 것이 이 토큰이다.
 *  - 모양: `base64url(payload).base64url(HMAC-SHA256)` · payload = `{v:1, runId, job, scope, exp}`.
 *    scope 는 `'grounding'` 또는 `'llm-credential'` — 같은 서명·검증·회수. 문은 scope 를 엄격히 가른다.
 *  - 상태 없는 검증 — 엔드포인트는 `verifyGroundingToken` 하나만 부른다.
 *  - 키: 비밀 백엔드 `grounding/hmac`(없으면 처음 발급 때 무작위 32바이트로 만든다) — 호스트 밖으로 안 나간다.
 *  - 수명: `exp`(Job 기한) ⊕ 조기 회수 `revokeGroundingRun(runId)`(Job 이 끝나면 호스트가 부른다).
 *  ⛔ 토큰·키 값은 로그·원장에 싣지 않는다 — runId·job·exp·거절 사유만.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';

export const GROUNDING_TOKEN_ENV = 'ELANOUS_GROUNDING_TOKEN';
export const GROUNDING_URL_ENV = 'ELANOUS_GROUNDING_URL';
export const GROUNDING_HMAC_SECRET_ID = 'grounding/hmac';

export const GROUNDING_TOKEN_SCOPES = ['grounding', 'llm-credential'] as const;
export type GroundingTokenScope = (typeof GROUNDING_TOKEN_SCOPES)[number];

export interface GroundingClaims {
  readonly runId: string;
  readonly job: string;
  readonly scope: GroundingTokenScope;
  readonly exp: number;
}

export type GroundingVerifyResult =
  | ({ readonly ok: true } & GroundingClaims)
  | { readonly ok: false; readonly reason: 'malformed' | 'bad-signature' | 'expired' | 'revoked' | 'scope' | 'no-key' };

export interface GroundingTokenDeps {
  /** 서명 키(원문). 생략하면 비밀 백엔드에서 읽고, 없으면 만든다(발급 쪽만). */
  readonly key?: () => Promise<string | undefined>;
  readonly now?: () => number;
  readonly revokedPath?: string;
}

function revokedPathOf(deps: GroundingTokenDeps): string {
  return deps.revokedPath ?? join(getElanousConfigDir(), 'grounding', 'revoked.jsonl');
}

async function readKey(create: boolean): Promise<string | undefined> {
  const { getSecretAsync, setSecretAsync } = await import('../nexus/config/secrets/index.js');
  const existing = await getSecretAsync(GROUNDING_HMAC_SECRET_ID);
  if (existing || !create) return existing;
  const fresh = randomBytes(32).toString('base64url');
  await setSecretAsync(GROUNDING_HMAC_SECRET_ID, fresh);
  debug.log('grounding.token', 'key-created', { secretId: GROUNDING_HMAC_SECRET_ID });
  return fresh;
}

function sign(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

export async function mintGroundingToken(
  claims: { runId: string; job: string; ttlMs: number; scope?: GroundingTokenScope },
  deps: GroundingTokenDeps = {},
): Promise<{ token: string; exp: number }> {
  const key = await (deps.key ?? (() => readKey(true)))();
  if (!key) throw new Error('grounding: 서명 키를 만들 수 없다(비밀 백엔드)');
  const scope: GroundingTokenScope = claims.scope ?? 'grounding';
  const exp = (deps.now ?? Date.now)() + claims.ttlMs;
  const payload = Buffer.from(JSON.stringify({ v: 1, runId: claims.runId, job: claims.job, scope, exp })).toString('base64url');
  debug.log('grounding.token', 'minted', { runId: claims.runId, job: claims.job, scope, exp });
  return { token: `${payload}.${sign(payload, key)}`, exp };
}

/** 그라운딩 문은 scope `'grounding'` 만 받는다. `llm-credential` 은 `expectedScope` 로 따로 연다. */
export async function verifyGroundingToken(
  token: string,
  deps: GroundingTokenDeps & { readonly expectedScope?: GroundingTokenScope } = {},
): Promise<GroundingVerifyResult> {
  const reject = (reason: Extract<GroundingVerifyResult, { ok: false }>['reason'], runId?: string): GroundingVerifyResult => {
    debug.log('grounding.token', 'rejected', { reason, ...(runId ? { runId } : {}) });
    return { ok: false, reason };
  };
  const parts = token.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return reject('malformed');
  const key = await (deps.key ?? (() => readKey(false)))();
  if (!key) return reject('no-key');
  const want = Buffer.from(sign(parts[0], key));
  const got = Buffer.from(parts[1]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return reject('bad-signature');
  let claims: Partial<GroundingClaims> & { v?: number };
  try { claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return reject('malformed'); }
  if (claims.v !== 1 || typeof claims.runId !== 'string' || typeof claims.job !== 'string' || typeof claims.exp !== 'number') return reject('malformed');
  const expected: GroundingTokenScope = deps.expectedScope ?? 'grounding';
  if (claims.scope !== expected) return reject('scope', claims.runId);
  if ((deps.now ?? Date.now)() >= claims.exp) return reject('expired', claims.runId);
  if (isRevoked(claims.runId, deps)) return reject('revoked', claims.runId);
  return { ok: true, runId: claims.runId, job: claims.job, scope: expected, exp: claims.exp };
}

/** Job 이 끝나면 호스트가 부른다 — 그 런의 토큰은 기한 전이라도 더는 안 통한다. */
export function revokeGroundingRun(runId: string, deps: GroundingTokenDeps = {}): void {
  const path = revokedPathOf(deps);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ runId, at: (deps.now ?? Date.now)() })}\n`, { mode: 0o600 });
  debug.log('grounding.token', 'revoked', { runId });
}

function isRevoked(runId: string, deps: GroundingTokenDeps): boolean {
  const path = revokedPathOf(deps);
  if (!existsSync(path)) return false;
  return readFileSync(path, 'utf8').split('\n').some((line) => {
    if (!line) return false;
    try { return (JSON.parse(line) as { runId?: string }).runId === runId; } catch { return false; }
  });
}
