// OP #113435 — the ONE place that states which member-Nexus API paths a bare
// handle host (anonymous webchat) forwards. Relay (forwarding), Nexus (meta
// delivered to the PWA) and the PWA (central request gate) all read this set,
// so a poller on a bare host can never hit an endpoint the relay drops.
// The static/entry paths (/, /app/chat, static assets) are separate (document
// serving, not API) and stay in relay-server / bare-static-path.

export const BARE_WEBCHAT_FORWARDED_API_PATHS = ["/v1/prompt/stream", "/v1/chat/events"] as const;
// PWA capability only: one session ID segment. Relay matches this route with
// a separate GET gate, so this template must not enter the exact chat-pair set.
export const BARE_WEBCHAT_SESSION_ITEM_CAPABILITY = "/v1/sessions/store/:id";

export const BARE_CAPABILITIES_META_NAME = "elanous-bare-capabilities";

// This predicate is the relay's exact chat-pair check. The session item route
// is matched separately by relayHostSessionReadRouteAllowed with a GET gate.
export function isBareForwardedApiPath(pathname: string): boolean {
  return (BARE_WEBCHAT_FORWARDED_API_PATHS as readonly string[]).includes(pathname);
}

/** Meta `content`: comma-joined forwarded paths. */
export function bareCapabilitiesContent(): string {
  return [...BARE_WEBCHAT_FORWARDED_API_PATHS, BARE_WEBCHAT_SESSION_ITEM_CAPABILITY].join(",");
}

export function bareCapabilitiesMetaTag(): string {
  return `<meta name="${BARE_CAPABILITIES_META_NAME}" content="${bareCapabilitiesContent()}">`;
}

export function parseBareCapabilities(content: string | null | undefined): string[] {
  return (content ?? "").split(",").map((p) => p.trim()).filter(Boolean);
}
