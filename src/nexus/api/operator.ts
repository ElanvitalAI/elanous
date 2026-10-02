// OPS1·OPS2 — who is an «operator» (sees the ops area). Off unless this daemon's config says `operator.enabled: true`
// (only our own machines); an external install never reports an operator, whatever header or token arrives.
// Design: 내부 문서 `DESIGN-pwa-menu-reorg-and-ops-area-2026-10-02` §2.
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { debug } from '../../debug/log.js';
import { getUserConfig } from '../../user-config.js';
import { checkAuth, type MetaApiOpts } from './meta-api.js';

/** Set by the op.elanous.ai proxy (Caddy) after Google sign-in, server side; the proxy strips any incoming copy. */
export const OPERATOR_HEADER = 'x-elanous-operator';

export type OperatorSource = 'op-proxy' | 'owner' | null;
export interface OperatorSignal { operator: boolean; operatorSource: OperatorSource }
export interface OperatorConfig { enabled: boolean; proxySecretFile?: string }

export function readOperatorConfig(raw: unknown = getUserConfig().raw?.operator): OperatorConfig {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    enabled: o.enabled === true,
    ...(typeof o.proxySecretFile === 'string' && o.proxySecretFile.trim() ? { proxySecretFile: o.proxySecretFile.trim() } : {}),
  };
}

/** The proxy secret, only from a regular file nobody but the owner can read (mode 600); anything else turns the header path off. */
export function readProxySecret(path: string | undefined): string | null {
  if (!path) return null;
  try {
    const st = statSync(path);
    if (!st.isFile() || (st.mode & 0o077) !== 0) return null;
    const value = readFileSync(path, 'utf8').trim();
    return value.length >= 16 ? value : null;
  } catch { return null; }
}

function sameSecret(offered: string, secret: string): boolean {
  const a = Buffer.from(offered);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface OperatorDeps { config?: OperatorConfig; readSecret?: (path: string | undefined) => string | null; isOwner?: (req: Request) => boolean }

export function operatorSignal(req: Request, opts: MetaApiOpts, deps: OperatorDeps = {}): OperatorSignal {
  const config = deps.config ?? readOperatorConfig();
  if (!config.enabled) return { operator: false, operatorSource: null };
  const offered = req.headers.get(OPERATOR_HEADER);
  if (offered) {
    const secret = (deps.readSecret ?? readProxySecret)(config.proxySecretFile);
    if (secret && sameSecret(offered, secret)) return { operator: true, operatorSource: 'op-proxy' };
  }
  if ((deps.isOwner ?? ((r: Request) => checkAuth(r, opts)))(req)) return { operator: true, operatorSource: 'owner' };
  return { operator: false, operatorSource: null };
}

/** `GET /v1/me` — answers every caller (no auth needed: it only says whether to draw the ops area). */
export function handleMe(req: Request, opts: MetaApiOpts, deps: OperatorDeps = {}): Response {
  const signal = operatorSignal(req, opts, deps);
  debug.log('ops.api', 'me', { operator: signal.operator, source: signal.operatorSource });
  return Response.json(signal, { headers: { 'cache-control': 'no-store' } });
}
