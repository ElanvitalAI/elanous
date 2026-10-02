// NEXUS `/v1` default-deny allowlist — one code constant.
//
// `routeRequest` calls `isPublicRoute` before any handler. A `/v1/` path
// that is not listed here must pass the existing `checkAuth` (same-origin
// exemption + constant-time bearer). Static `/app/*` and `/` are outside
// `/v1` and are not gate subjects.
//
// Callbacks and webhooks stay off this list:
//   - `handleHitlCallback` (`src/nexus/api/meta-api.ts`) calls `checkAuth`
//     itself; it does not verify a callback signature or token of its own.
//   - `checkAuth` (`src/workflow-runtime/triggers/webhook-router.ts`)
//     returns success when the registered trigger has no `auth`, so an
//     unauthenticated POST can still dispatch a workflow.

export type PublicRouteMatch = 'exact' | 'prefix';

export interface PublicRoute {
  method: string;
  match: PublicRouteMatch;
  path: string;
  why: string;
  /** The handler verifies its own credential (not the nexus bearer) and may answer 401 itself. */
  selfVerified?: true;
}

export const PUBLIC_ROUTES: Array<PublicRoute> = [
  {
    method: 'GET',
    match: 'exact',
    path: '/v1/health',
    why: 'liveness probe and setup-mode signal (F condition 2)',
  },
  {
    method: 'GET',
    match: 'exact',
    path: '/v1/push/vapid-public-key',
    why: 'PWA fetches the VAPID public key before a bearer is pasted',
  },
  {
    method: 'GET',
    match: 'exact',
    path: '/v1/me',
    why: 'operator signal only (draw the ops area or not); false unless operator.enabled, no other data',
  },
  {
    method: 'GET',
    match: 'exact',
    path: '/v1/nexus/connect-info',
    why: 'connect metadata only; auto_token removed in #20782',
  },
  {
    method: 'POST',
    match: 'exact',
    path: '/v1/pod/credential/grok',
    selfVerified: true,
    why: 'Pod grok access relay (#20789); Pods hold no nexus bearer — pod-credential-api.ts verifies its own llm-credential token (verifyGroundingToken expectedScope) before reading the body',
  },
  {
    method: 'POST',
    match: 'exact',
    path: '/v1/pod/credential/github',
    selfVerified: true,
    why: 'Pod GitHub App credential relay verifies its own run-scoped gh-credential token before minting a repository-scoped installation token',
  },
  {
    method: 'POST',
    match: 'exact',
    path: '/v1/setup/claim',
    selfVerified: true,
    why: 'one-use setup link is verified by the claim handler without an owner bearer',
  },
  {
    method: 'GET',
    match: 'prefix',
    path: '/v1/setup/',
    why: 'setup wizard routes; public only while setupMode is true (P24b)',
  },
];

export interface PublicRouteContext {
  setupMode: boolean;
}

/** True when this method+pathname is on the public allowlist. */
export function isPublicRoute(
  method: string,
  pathname: string,
  ctx: PublicRouteContext,
): boolean {
  for (const route of PUBLIC_ROUTES) {
    if (route.method !== method) continue;
    if (route.path.startsWith('/v1/setup/') && route.path !== '/v1/setup/claim' && !ctx.setupMode) continue;
    if (route.match === 'exact') {
      if (pathname === route.path) return true;
    } else if (pathname === route.path || pathname.startsWith(route.path)) {
      return true;
    }
  }
  return false;
}
