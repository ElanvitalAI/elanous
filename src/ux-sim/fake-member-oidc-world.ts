import { createFakeGoogleOAuthWorld, FAKE_GOOGLE_ISSUER, type FakeGoogleIdentity, type FakeGoogleOAuthWorld } from './fake-google-oauth.js';
import { createGoogleSignin } from '../nexus/members/google-signin.js';
import { createMembersApi } from '../nexus/members/members-api.js';
import { createMemberStore } from '../nexus/members/member-store.js';
import { createAppLifecycleStore } from '../nexus/apps/app-db.js';
import type { NexusAppHost } from '../nexus/apps/app-host.js';
import { randomBytes } from 'node:crypto';

const CLIENT_ID = 'fake-member-oidc-world-client';
const REDIRECT_URI = 'https://members.example.test/v1/members/oauth/google/callback';

export interface FakeMemberOidcWorldOptions {
  readonly now?: () => number;
  readonly identity?: FakeGoogleIdentity | ((authorizationUrl: URL, sequence: number) => FakeGoogleIdentity);
  readonly successRedirectUri?: string;
  readonly runTryExample?: NonNullable<Parameters<typeof createMembersApi>[0]['runTryExample']>;
  /** Test-only app session issuer. Never configure this on a deployed members API. */
  readonly issueOwnerSession?: (appId: string, memberId: string) => { readonly sessionToken: string; readonly expiresAt: string };
  /** Explicit test-universe Nexus authority. Production boot never imports or configures this simulator seam. */
  readonly testOnlyNexus?: {
    readonly phase: 'test';
    readonly appHost: () => Pick<NexusAppHost, 'issueOwnerSession' | 'resolveVerifiedOwner' | 'resolveVerifiedMemberOwner'> | undefined;
    readonly publicUserSlug: string;
  };
}

export interface FakeMemberOidcWorld {
  readonly googleWorld: FakeGoogleOAuthWorld;
  readonly membersApi: ReturnType<typeof createMembersApi>;
  readonly memberStore: ReturnType<typeof createMemberStore>;
  readonly appLifecycle: ReturnType<typeof createAppLifecycleStore>;
  close(): void;
}

/** Fake only the Google/network edge; signup, member keys, app slots and lifecycle use production stores and handlers. */
export function createFakeMemberOidcWorld(options: FakeMemberOidcWorldOptions = {}): FakeMemberOidcWorld {
  const now = options.now ?? Date.now;
  const memberStore = createMemberStore({ path: ':memory:', now });
  const appLifecycle = createAppLifecycleStore(':memory:');
  const identity = options.identity ?? ((_url: URL, sequence: number) => ({
    sub: `fake-google-member-${sequence}`,
    email: `member-${sequence}@example.test`,
    emailVerified: true,
    name: `Fake Member ${sequence}`,
  }));
  const googleWorld = createFakeGoogleOAuthWorld({ clientId: CLIENT_ID, redirectUri: REDIRECT_URI, identity });
  const google = createGoogleSignin({
    clientId: async () => CLIENT_ID,
    clientSecret: async () => 'fake-google-client-secret',
    stateEncryptionKey: async () => 'fake-member-oidc-world-state-key-at-least-32-bytes',
    redirectUri: REDIRECT_URI,
    store: memberStore,
    now,
    fetch: googleWorld.fetch,
    authorizationEndpoint: `${FAKE_GOOGLE_ISSUER}/o/oauth2/v2/auth`,
    tokenEndpoint: `${FAKE_GOOGLE_ISSUER}/token`,
    userinfoEndpoint: `${FAKE_GOOGLE_ISSUER}/userinfo`,
  });
  const testNexus = options.testOnlyNexus;
  const testAppHost = () => {
    if (testNexus?.phase !== 'test') throw new Error('fake member session trust is test-universe only');
    const host = testNexus.appHost();
    if (!host) throw new Error('test Nexus app host is not ready');
    return host;
  };
  const membersApi = createMembersApi({
    store: memberStore,
    google,
    successRedirectUri: options.successRedirectUri ?? 'https://app.example.test/signup/complete',
    now,
    getAppLifecycle: () => appLifecycle,
    ...(options.runTryExample ? { runTryExample: options.runTryExample } : {}),
    appAuthRedirectUris: ['elanous://auth/callback'],
    issueOwnerSession: options.issueOwnerSession ?? (testNexus
      ? (appSlug, memberId) => testAppHost().issueOwnerSession(appSlug, memberId)
      : () => ({
        sessionToken: `aps_${randomBytes(32).toString('base64url')}`,
        // Match the app-slot exchange contract: test and production sessions are short lived.
        expiresAt: new Date(now() + 2 * 60_000).toISOString(),
      })),
    ...(testNexus ? {
      resolveVerifiedOwner: (appSlug, credential, members) => testAppHost().resolveVerifiedOwner(
        appSlug, credential, members, testNexus.publicUserSlug,
      ),
      resolveVerifiedMemberOwner: (credential, members) => testAppHost().resolveVerifiedMemberOwner(
        credential, members, testNexus.publicUserSlug,
      ),
    } : {}),
  });
  return { googleWorld, membersApi, memberStore, appLifecycle,
    close() { memberStore.close(); appLifecycle.close(); } };
}

export const FAKE_MEMBER_OIDC_REDIRECT_URI = REDIRECT_URI;
