// NEXUS · /v1/nexus/edit-in-pwa endpoints (Phase N-3 cleanup PR β')
//
// POST /v1/nexus/edit-in-pwa
//   body: { switchId: string }
//   response: { token, url, expiresAt }
//
//   TUI calls this to mint a single-use token bound to the current
//   nexus origin. Returns the URL the user pastes / scans to land in
//   the PWA's edit surface.
//
// POST /v1/nexus/edit-in-pwa/consume
//   body: { token: string }
//   response: { valid, switchId?, expiresAt?, reason? }
//
//   PWA calls this on landing to verify the token + burn the nonce
//   before rendering the edit form. Subsequent calls with the same
//   token are rejected (single-use).

import { jsonResponse } from './json-response.js';
import {
  signEditInPwaToken,
  verifyEditInPwaToken,
  buildEditInPwaUrl,
  type NonceStore,
} from './edit-in-pwa-core.js';
import { getSwitch } from '../config/switch-registry.js';
import { debug } from '../../debug/log.js';

export interface EditInPwaCtx {
  signingKey: string;
  nonceStore: NonceStore;
  /** `host:port` audience. Default: derived from nexus http server. */
  audience: string;
  /** Origin used to build the URL (e.g., `http://127.0.0.1:31415`). */
  nexusOrigin: string;
  /** Override for tests / when PWA runs on a different origin. */
  pwaOrigin?: string;
  /** Override token TTL (tests). */
  ttlMs?: number;
}

interface EditInPwaPostBody {
  switchId?: string;
}

export async function handleEditInPwaPost(req: Request, ctx: EditInPwaCtx): Promise<Response> {
  let body: EditInPwaPostBody;
  try {
    body = (await req.json()) as EditInPwaPostBody;
  } catch {
    return jsonResponse({ error: 'invalid-json' }, 400);
  }
  if (!body.switchId || typeof body.switchId !== 'string') {
    return jsonResponse({ error: 'switchId-required' }, 400);
  }
  if (!isKnownSwitchId(body.switchId)) {
    return jsonResponse({ error: 'switch-not-found', id: body.switchId }, 404);
  }

  const signed = signEditInPwaToken({
    secret: ctx.signingKey,
    audience: ctx.audience,
    switchId: body.switchId,
    ...(ctx.ttlMs !== undefined ? { ttlMs: ctx.ttlMs } : {}),
  });

  const url = buildEditInPwaUrl({
    nexusOrigin: ctx.nexusOrigin,
    ...(ctx.pwaOrigin ? { pwaOrigin: ctx.pwaOrigin } : {}),
    token: signed.encoded,
    switchId: body.switchId,
  });

  if (debug.enabled) {
    debug.log('nexus.edit-in-pwa.mint', body.switchId, {
      exp: signed.payload.exp,
      aud: signed.payload.aud,
    });
  }

  return jsonResponse({
    token: signed.encoded,
    url,
    expiresAt: signed.payload.exp,
    switchId: body.switchId,
  }, 201);
}

interface EditInPwaConsumeBody {
  token?: string;
}

export async function handleEditInPwaConsume(req: Request, ctx: EditInPwaCtx): Promise<Response> {
  let body: EditInPwaConsumeBody;
  try {
    body = (await req.json()) as EditInPwaConsumeBody;
  } catch {
    return jsonResponse({ error: 'invalid-json' }, 400);
  }
  if (!body.token || typeof body.token !== 'string') {
    return jsonResponse({ error: 'token-required' }, 400);
  }

  const verdict = verifyEditInPwaToken({
    secret: ctx.signingKey,
    audience: ctx.audience,
    encoded: body.token,
  });
  if (!verdict.valid) {
    return jsonResponse({ valid: false, reason: verdict.reason }, 400);
  }
  // Single-use: burn the nonce. Replay (same token used twice) returns
  // 410 Gone with a `replay` reason.
  if (!ctx.nonceStore.consume(verdict.payload.nonce)) {
    return jsonResponse({ valid: false, reason: 'replay' }, 410);
  }

  if (debug.enabled) {
    debug.log('nexus.edit-in-pwa.consume', verdict.payload.switchId, {
      exp: verdict.payload.exp,
    });
  }

  return jsonResponse({
    valid: true,
    switchId: verdict.payload.switchId,
    expiresAt: verdict.payload.exp,
  }, 200);
}

function isKnownSwitchId(literalId: string): boolean {
  if (getSwitch(literalId)) return true;
  // Tab-scope ids may include a literal tab id — strip and try again
  // in template form. The N-3 PR μ registry currently bakes literal
  // ids (e.g., `tabs.daemon:1.tools`) so the direct lookup above covers
  // it; we keep this fall-back for any future migration to `<id>` form.
  const parts = literalId.split('.');
  if (parts[0] === 'tabs' && parts.length >= 3) {
    const templated = ['tabs', '<id>', ...parts.slice(2)].join('.');
    return !!getSwitch(templated);
  }
  return false;
}
