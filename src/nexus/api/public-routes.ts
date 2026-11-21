// NEXUS `/v1` default-deny allowlist — one code constant.
//
// `routeRequest` calls `isPublicRoute` before any handler. A `/v1/` path
// that is not listed here must pass the existing `checkAuth` (same-origin
// exemption + constant-time bearer). Static `/app/*` and `/` are outside
// `/v1` and are not gate subjects.
//
// Callbacks and webhooks stay off this static list. The HTTP gate checks
// active, exact graph webhook routes with their own auth separately:
//   - `handleHitlCallback` (`src/nexus/api/meta-api.ts`) calls `checkAuth`
//     itself; it does not verify a callback signature or token of its own.
//   - `checkAuth` (`src/workflow-runtime/triggers/webhook-router.ts`)
//     returns success when the registered trigger has no `auth`, so an
//     unauthenticated POST can still dispatch a workflow.

export type PublicRouteMatch = 'exact' | 'prefix' | 'grant-id' | 'approval-id';

export interface PublicRoute {
  method: string;
  match: PublicRouteMatch;
  path: string;
  suffix?: '/poll' | '/approve';
  why: string;
  /** The handler verifies its own credential (not the nexus bearer) and may answer 401 itself. */
  selfVerified?: true;
}

export const PUBLIC_ROUTES: Array<PublicRoute> = [
  { method: 'POST', match: 'exact', path: '/v1/members/deployment-approvals/intents', selfVerified: true,
    why: 'approval intent requires a fresh verified app owner session and active binding' },
  { method: 'POST', match: 'approval-id', path: '/v1/members/deployment-approvals/intents/', suffix: '/poll', selfVerified: true,
    why: 'approval poll requires the same fresh app owner session and exact server record' },
  { method: 'GET', match: 'approval-id', path: '/v1/members/deployment-approvals/', selfVerified: true,
    why: 'approval page verifies a fresh same-owner member cookie without approving' },
  { method: 'POST', match: 'approval-id', path: '/v1/members/deployment-approvals/', suffix: '/approve', selfVerified: true,
    why: 'approval confirmation verifies the same-owner cookie, exact origin and server CSRF nonce' },
  { method: 'POST', match: 'exact', path: '/v1/members/deployment-grants', selfVerified: true,
    why: 'grant issue verifies a fresh app owner session and live member, approval and relay key binding' },
  { method: 'POST', match: 'exact', path: '/v1/members/deployment-grants/introspect', selfVerified: true,
    why: 'grant introspection verifies the private credential against the live server ledger and binding' },
  { method: 'DELETE', match: 'grant-id', path: '/v1/members/deployment-grants/', selfVerified: true,
    why: 'grant revocation verifies a fresh app owner session and the exact owned grant record' },
  { method: 'PUT', match: 'exact', path: '/v1/members/handle', selfVerified: true,
    why: 'handle registration verifies its own member web session or app owner session before claiming a name' },
  { method: 'GET', match: 'exact', path: '/v1/members/handle', selfVerified: true,
    why: 'the handle confirmation page (MEMBER-JOURNEY S3) verifies its own revocable member session and answers 401 itself; other methods answer 405 at the handler' },
  { method: '*', match: 'exact', path: '/v1/members/handle/check', selfVerified: true,
    why: 'handle availability answers only a signed-in member (revocable member-session cookie), one candidate at a time, read-only; a non-GET must reach the handler so it answers 405 method-not-allowed instead of the auth gate' },
  { method: 'POST', match: 'exact', path: '/v1/tokens', selfVerified: true,
    why: 'member key bearer is checked by the token API before minting a scoped access token' },
  { method: 'POST', match: 'exact', path: '/v1/tokens/introspect', selfVerified: true,
    why: 'relay.connect bearer is checked against current expiry, key revocation, plan and audience' },
  { method: 'GET', match: 'exact', path: '/v1/member/keys', selfVerified: true,
    why: 'member key listing verifies the revocable member session' },
  { method: 'POST', match: 'exact', path: '/v1/member/keys', selfVerified: true,
    why: 'member key creation verifies the revocable member session' },
  { method: 'DELETE', match: 'prefix', path: '/v1/member/keys/', selfVerified: true,
    why: 'member key revocation verifies the revocable member session and owner' },
  { method: 'POST', match: 'prefix', path: '/v1/member/keys/', selfVerified: true,
    why: 'member key rotation verifies the revocable member session and owner' },
  { method: 'GET', match: 'exact', path: '/v1/member/tokens', selfVerified: true,
    why: 'member token listing verifies the revocable member session' },
  { method: 'DELETE', match: 'prefix', path: '/v1/member/tokens/', selfVerified: true,
    why: 'member token revocation verifies the revocable member session and owner' },
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
  { method: 'POST', match: 'exact', path: '/v1/members/connect/start', selfVerified: true,
    why: 'bounded short-lived PKCE request has no member credential and caps body and pending count' },
  { method: 'GET', match: 'exact', path: '/v1/members/connect/approve', selfVerified: true,
    why: 'approval page requires the revocable member cookie and binds the first viewing member' },
  { method: 'POST', match: 'exact', path: '/v1/members/connect/approve', selfVerified: true,
    why: 'explicit approval checks same origin, CSRF and the same revocable member cookie' },
  { method: 'POST', match: 'exact', path: '/v1/members/connect/poll', selfVerified: true,
    why: 'one-time approval code release requires a separate CLI-only poll secret hash match' },
  {
    method: 'POST', match: 'exact', path: '/v1/members', selfVerified: true,
    why: 'member signup starts a server-side state+PKCE Google OAuth flow; consent and code inputs are validated by member API',
  },
  {
    method: 'GET', match: 'exact', path: '/v1/scraps', selfVerified: true,
    why: 'scrap reads resolve the member owner from the server-verified session before querying the shared intake ledger',
  },
  {
    method: 'POST', match: 'exact', path: '/v1/scraps', selfVerified: true,
    why: 'scrap writes ignore request memberId and resolve owner from the server-verified member session',
  },
  {
    method: 'POST', match: 'exact', path: '/v1/telegram/member-enrollment', selfVerified: true,
    why: 'Telegram enrollment resolves the member from a revocable server session before issuing a one-use code',
  },
  {
    method: 'GET', match: 'exact', path: '/v1/members', selfVerified: true,
    why: 'member profile uses only the revocable HttpOnly member-session cookie',
  },
  {
    method: 'GET', match: 'exact', path: '/v1/members/home', selfVerified: true,
    why: 'member home verifies the revocable HttpOnly member-session cookie before rendering private profile data',
  },
  {
    method: 'GET', match: 'exact', path: '/v1/members/webchat-handoff', selfVerified: true,
    why: 'webchat handoff issuance verifies the revocable HttpOnly member-session cookie before issuing a one-use bound token',
  },
  { method: 'GET', match: 'exact', path: '/v1/members/secret-backups', selfVerified: true,
    why: 'E2E ciphertext listing derives owner from the revocable member session' },
  { method: 'POST', match: 'exact', path: '/v1/members/secret-backups', selfVerified: true,
    why: 'E2E ciphertext creation derives owner from the revocable member session and checks CAS' },
  { method: 'GET', match: 'prefix', path: '/v1/members/secret-backups/', selfVerified: true,
    why: 'E2E ciphertext read derives owner from the revocable member session' },
  { method: 'PUT', match: 'prefix', path: '/v1/members/secret-backups/', selfVerified: true,
    why: 'E2E ciphertext rotation derives owner from the revocable member session and checks CAS' },
  { method: 'DELETE', match: 'prefix', path: '/v1/members/secret-backups/', selfVerified: true,
    why: 'E2E ciphertext deletion derives owner from the revocable member session and checks CAS' },
  {
    method: 'GET', match: 'exact', path: '/v1/members/newsletter-preference', selfVerified: true,
    why: 'newsletter preference read verifies the revocable member-session cookie',
  },
  {
    method: 'PUT', match: 'exact', path: '/v1/members/newsletter-preference', selfVerified: true,
    why: 'newsletter preference update verifies the revocable member-session cookie and validates the explicit choice',
  },
  {
    method: 'GET', match: 'exact', path: '/v1/members/newsletter-preference/count', selfVerified: true,
    why: 'aggregate-only newsletter count verifies its separate private bearer token before reading the store',
  },
  {
    method: 'POST', match: 'exact', path: '/v1/members/referral-code', selfVerified: true,
    why: 'referral code rotation verifies the member session and revokes earlier invite links',
  },
  {
    method: 'DELETE', match: 'exact', path: '/v1/members/referral-code', selfVerified: true,
    why: 'referral code revocation verifies the member session',
  },
  {
    method: 'GET', match: 'exact', path: '/v1/members/app-slot', selfVerified: true,
    why: 'member app slot is scoped by the revocable HttpOnly member-session cookie',
  },
  {
    method: 'GET', match: 'exact', path: '/v1/members/owner', selfVerified: true,
    why: 'verified owner context is resolved from an app-bound session cookie or bearer by the member API',
  },
  {
    method: 'GET', match: 'exact', path: '/v1/members/sessions', selfVerified: true,
    why: 'member session list resolves the owner from the member cookie or aps_ bearer and never reads the shared store first',
  },
  {
    method: 'POST', match: 'exact', path: '/v1/members/sessions', selfVerified: true,
    why: 'member session save binds the turn to the member id resolved by server auth and ignores body owner fields',
  },
  {
    method: 'GET', match: 'prefix', path: '/v1/members/sessions/', selfVerified: true,
    why: 'one owned member session transcript uses the same verified principal and ownership check as the list',
  },
  {
    method: 'GET', match: 'exact', path: '/v1/board', selfVerified: true,
    why: 'member board data is filtered by the app-bound owner verified by /v1/members/owner',
  },
  {
    method: 'POST', match: 'prefix', path: '/v1/board/', selfVerified: true,
    why: 'board approval is accepted only from an app-bound owner session and an explicit approval decision',
  },
  {
    method: 'POST', match: 'exact', path: '/v1/members/app-slot', selfVerified: true,
    why: 'creating the one event-coded member app slot verifies its own member session',
  },
  {
    method: 'POST', match: 'exact', path: '/v1/members/app-slot/name', selfVerified: true,
    why: 'renaming the member app verifies the revocable member-session cookie, the member origin and that the app was never used',
  },
  {
    method: 'GET', match: 'exact', path: '/v1/members/app-slot/name-check', selfVerified: true,
    why: 'app-name availability answers only a signed-in member (revocable member-session cookie), one name at a time',
  },
  {
    method: 'POST', match: 'exact', path: '/v1/members/app-slot/session', selfVerified: true,
    why: 'mobile owner session verifies a Google ID token against the configured native audiences and resolves subject, member, and app slot server-side',
  },
  {
    method: 'POST', match: 'exact', path: '/v1/members/app-slot/exchange', selfVerified: true,
    why: 'native app-slot session exchange consumes a short-lived state-bound Google callback code once and resolves its member and app slot server-side',
  },
  {
    method: 'DELETE', match: 'exact', path: '/v1/members', selfVerified: true,
    why: 'member deletion request verifies and revokes its own member session',
  },
  {
    method: 'POST', match: 'exact', path: '/v1/members/validate-code', selfVerified: true,
    why: 'pre-signup referral and event code validation returns no member data',
  },
  {
    method: 'GET', match: 'exact', path: '/v1/members/oauth/google/callback', selfVerified: true,
    why: 'Google OAuth callback consumes one-use state and PKCE verifier before creating a member session',
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
    path: '/v1/log-federation/batch',
    selfVerified: true,
    why: 'remote log federation verifies the scoped instance ingest token and applies server-side redaction before storing',
  },
  {
    method: 'POST',
    match: 'exact',
    path: '/v1/log-federation/revoke',
    selfVerified: true,
    why: 'a federation token may revoke only itself; the token name binds it to one remote instance',
  },
  {
    method: 'POST',
    match: 'exact',
    path: '/v1/setup/claim',
    selfVerified: true,
    why: 'one-use setup link is verified by the claim handler without an owner bearer',
  },
  {
    method: 'POST',
    match: 'exact',
    path: '/v1/setup/credential-claim',
    selfVerified: true,
    why: 'slot-bound one-use link is claimed by its own token handler; generic setup bearers are rejected',
  },
  {
    method: 'POST',
    match: 'exact',
    path: '/v1/setup/credential-register',
    selfVerified: true,
    why: 'short-lived single-use bearer is consumed by the slot-bound registration handler',
  },
  {
    method: 'GET',
    match: 'prefix',
    path: '/v1/setup/',
    why: 'setup wizard routes; public only while setupMode is true (P24b)',
  },
  {
    method: 'POST', match: 'exact', path: '/v1/scraps/summary-requests', selfVerified: true,
    why: 'share summary requests verify the member session and scrap owner before recording a request',
  },
  {
    method: 'GET', match: 'prefix', path: '/v1/scraps/summary-requests/', selfVerified: true,
    why: 'share summary status verifies the member session and request owner before returning the result',
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
    if (route.method !== '*' && route.method !== method) continue;
    if (route.path.startsWith('/v1/setup/') && route.path !== '/v1/setup/claim' && !route.selfVerified && !ctx.setupMode) continue;
    if (route.match === 'exact') {
      if (pathname === route.path) return true;
    } else if (route.match === 'grant-id') {
      if (pathname.startsWith(route.path)
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(pathname.slice(route.path.length))) return true;
    } else if (route.match === 'approval-id') {
      if (pathname.startsWith(route.path)
        && new RegExp(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}${route.suffix ?? ''}$`)
          .test(pathname.slice(route.path.length))) return true;
    } else if (pathname === route.path || pathname.startsWith(route.path)) {
      return true;
    }
  }
  return false;
}
