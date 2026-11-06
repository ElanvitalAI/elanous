// NEXUS · /v1/nexus/chat-backend-detection (PWA mirror track PR 1)
//
// Read-only endpoint that surfaces the same `QuickSetupSnapshot` the
// TUI Settings tab renders so the PWA SettingsPanel (PR 2-3) can
// mirror the chat-backend Quick Setup card without duplicating the
// detection / probe logic.
//
// Wraps `buildQuickSetupSnapshot()` (the source of truth) and JSON-
// serializes the result. The snapshot's `entries[].paths[]` carry
// `detected: boolean` only — env / token values are never echoed
// (g.1 jsdoc policy preserved end-to-end).
//
// Auth model: same as the rest of the read-only routes (loopback
// noAuth · bearer token enforced when set). The handler itself is
// unauthed; the http-server layer handles auth as a wrapper concern.
//
// Cache: none. The probe re-reads env + token store on every call —
// cheap (4 fs reads + 1 OAuth probe) and a cache would defeat the
// PWA's "I just exported the env, refresh the card" flow (the
// SettingsPanel calls this on mount + on the explicit refresh button).

import { jsonResponse } from './json-response.js';
import {
  buildQuickSetupSnapshot,
  type QuickSetupRenderOpts,
  type QuickSetupSnapshot,
} from '../chat/quick-setup.js';

export interface ChatBackendDetectionResponseBody {
  detection: QuickSetupSnapshot['detection'];
  entries: QuickSetupSnapshot['entries'];
}

/** Compose the response body. Pure — split out so tests can lock the
 *  shape without driving the http-server.
 *
 *  `deps.envSource` / `deps.tokenLookup` are forwarded to
 *  `buildQuickSetupSnapshot` so tests can pin a synthetic env / token
 *  store. Production omits both → process.env + loadTokens. */
export function buildChatBackendDetectionBody(
  deps: QuickSetupRenderOpts = {},
): ChatBackendDetectionResponseBody {
  const snap = buildQuickSetupSnapshot(deps);
  return { detection: snap.detection, entries: snap.entries };
}

/** GET /v1/nexus/chat-backend-detection */
export function handleChatBackendDetection(
  deps: QuickSetupRenderOpts = {},
): Response {
  return jsonResponse(buildChatBackendDetectionBody(deps), 200);
}
