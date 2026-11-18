// CONTEXT-OWNER-ISOLATION-AUDIT H-1 (2026-11-18) — who may open the operator-only debug envelope.
// Same credential rule as the operator SSE topics (`bearerCredential`, http-server `/v1/events`):
// only an owner bearer or an owner-issued temp token is an operator. Same-origin, noAuth and
// member cookies are not. A verified member owner always wins (member = never). Else 'unknown'.
import type { AcpAudience } from '../../acp/transport/types.js';
import { offeredAcpTokenFromUpgrade } from '../../boot/ws-bridge.js';
import { bearerCredential, promptVerifiedOwner, type MetaApiOpts } from './meta-api.js';

export function requestDebugAudience(req: Request, opts: MetaApiOpts | undefined): AcpAudience {
  if (!opts) return 'unknown';
  if (promptVerifiedOwner(req, opts)) return 'member';
  // WS upgrades carry the token in `Sec-WebSocket-Protocol: bearer.<t>`; HTTP in Authorization.
  const offered = offeredAcpTokenFromUpgrade(req);
  const probe = offered ? new Request(req.url, { headers: { authorization: `Bearer ${offered}` } }) : req;
  const credential = bearerCredential(probe, opts);
  return credential === 'bearer-match' || credential === 'temp-token' ? 'operator' : 'unknown';
}
