export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // micro.1 (2026-05-09 · FU.4 envelope audit recommendation #2
      // enforce-by-default) — every JSON envelope now carries the
      // CORS allow-origin wildcard so PWA dev (cross-port) + future
      // remote dogfood (Tailscale URL) reach the daemon without
      // per-endpoint patching. Production same-origin is unaffected
      // (browsers ignore the header on same-origin requests). elanous
      // daemon uses bearer-token auth only (no cookies), so the
      // wildcard does not conflict with `credentials: include`.
      'access-control-allow-origin': '*',
    },
  });
}

/** OPTIONS preflight response for JSON-body POST/PUT/DELETE routes
 *  in the mutation block. Mirrors the audio-stt + role-judge pattern
 *  so any new POST endpoint gets cross-origin support with one line:
 *  `if (... && method === 'OPTIONS') return corsPreflight();`. */
export function corsPreflight(allowedMethods = 'POST, PUT, DELETE, OPTIONS'): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': allowedMethods,
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-max-age': '600',
    },
  });
}
