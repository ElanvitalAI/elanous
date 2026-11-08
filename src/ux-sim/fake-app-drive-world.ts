import {
  DriveReadContractError,
  GOOGLE_DRIVE_MAX_PAGE_SIZE,
  GOOGLE_DRIVE_METADATA_READONLY_SCOPE,
  type DriveTenantAccess,
  type DriveTenantKey,
  type GoogleDriveFileListInput,
  type GoogleDriveFileListPage,
  type GoogleDriveFileMetadata,
  type GoogleDriveReadPort,
} from '../nexus/apps/drive-contract.js';

export interface FakeAppDriveIdentity {
  /** Verified issuer value. The fake world keys identity by the exact issuer/subject pair, never email. */
  readonly issuer: string;
  readonly subject: string;
}

export interface FakeAppDriveAccountSeed {
  readonly identity: FakeAppDriveIdentity;
  readonly files: readonly GoogleDriveFileMetadata[];
  readonly grantedScopes?: readonly string[];
}

export interface FakeAppDriveAccount {
  readonly tenantKey: DriveTenantKey;
  readonly auth: DriveTenantAccess;
  refresh(): void;
  expireAccessToken(): void;
  logout(): void;
  revoke(): void;
}

export interface FakeAppDriveObservations {
  readonly simulatedListCalls: number;
  readonly refreshes: number;
}

export interface FakeAppDriveCapabilities {
  readonly externalGoogleApi: 'absent';
  readonly credentialPersistence: 'absent';
}

export interface FakeAppDriveWorld {
  readonly port: GoogleDriveReadPort;
  createAccount(seed: FakeAppDriveAccountSeed): FakeAppDriveAccount;
  observations(): FakeAppDriveObservations;
  capabilities(): FakeAppDriveCapabilities;
  close(): void;
}

interface AccountRecord {
  readonly tenantKey: DriveTenantKey;
  readonly files: readonly GoogleDriveFileMetadata[];
  readonly scopes: ReadonlySet<string>;
  accessToken: string | undefined;
  refreshToken: string | undefined;
  loggedOut: boolean;
  revoked: boolean;
}

interface AccessTokenRecord {
  readonly account: AccountRecord;
  readonly expiresAt: number;
  revoked: boolean;
}

interface RefreshTokenRecord {
  readonly account: AccountRecord;
  revoked: boolean;
}

interface PageTokenRecord {
  readonly tenantKey: DriveTenantKey;
  readonly offset: number;
}

export interface FakeAppDriveWorldOptions {
  readonly now?: () => number;
  readonly accessTokenTtlMs?: number;
}

function identityKey(identity: FakeAppDriveIdentity): string {
  if (typeof identity.issuer !== 'string' || !identity.issuer.startsWith('https://')
    || typeof identity.subject !== 'string' || identity.subject.length === 0) {
    throw new DriveReadContractError('unauthenticated');
  }
  // Length framing prevents delimiter collisions; email is not an input to tenant identity.
  return `${identity.issuer.length}:${identity.issuer}${identity.subject.length}:${identity.subject}`;
}

function copyFiles(files: readonly GoogleDriveFileMetadata[]): GoogleDriveFileMetadata[] {
  return files.map(file => ({ id: file.id, name: file.name, mimeType: file.mimeType, modifiedTime: file.modifiedTime }));
}

/** In-memory Drive tenant fixture. It has no fetch, filesystem, or credential-store dependency. */
export function createFakeAppDriveWorld(options: FakeAppDriveWorldOptions = {}): FakeAppDriveWorld {
  const now = options.now ?? Date.now;
  const tokenTtlMs = options.accessTokenTtlMs ?? 60_000;
  if (!Number.isSafeInteger(tokenTtlMs) || tokenTtlMs <= 0) throw new RangeError('access token TTL must be positive');

  const accountsByIdentity = new Map<string, AccountRecord>();
  const accessTokens = new Map<string, AccessTokenRecord>();
  const refreshTokens = new Map<string, RefreshTokenRecord>();
  const pageTokens = new Map<string, PageTokenRecord>();
  let closed = false;
  let tenantSequence = 0;
  let tokenSequence = 0;
  let pageSequence = 0;
  let simulatedListCalls = 0;
  let refreshes = 0;

  function ensureOpen(): void {
    if (closed) throw new DriveReadContractError('closed');
  }

  function issueTokens(account: AccountRecord): void {
    const accessToken = `synthetic-access-${++tokenSequence}`;
    const refreshToken = `synthetic-refresh-${tokenSequence}`;
    account.accessToken = accessToken;
    account.refreshToken = refreshToken;
    accessTokens.set(accessToken, { account, expiresAt: now() + tokenTtlMs, revoked: false });
    refreshTokens.set(refreshToken, { account, revoked: false });
  }

  async function listFiles(input: GoogleDriveFileListInput): Promise<GoogleDriveFileListPage> {
    ensureOpen();
    const pageSize = input.pageSize ?? GOOGLE_DRIVE_MAX_PAGE_SIZE;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > GOOGLE_DRIVE_MAX_PAGE_SIZE) {
      throw new DriveReadContractError('invalid-page-size');
    }

    const token = await input.auth.getAccessToken(GOOGLE_DRIVE_METADATA_READONLY_SCOPE);
    const credential = accessTokens.get(token);
    if (!credential || credential.revoked || credential.account.loggedOut || credential.account.revoked || now() >= credential.expiresAt) {
      throw new DriveReadContractError('unauthenticated');
    }
    if (!credential.account.scopes.has(GOOGLE_DRIVE_METADATA_READONLY_SCOPE)) {
      throw new DriveReadContractError('scope-denied');
    }
    if (credential.account.tenantKey !== input.auth.tenantKey) throw new DriveReadContractError('tenant-mismatch');

    let offset = 0;
    if (input.pageToken !== undefined) {
      const continuation = pageTokens.get(input.pageToken);
      if (!continuation || continuation.tenantKey !== credential.account.tenantKey) {
        throw new DriveReadContractError('invalid-page-token');
      }
      offset = continuation.offset;
    }

    simulatedListCalls++;
    const files = credential.account.files.slice(offset, offset + pageSize);
    const nextOffset = offset + files.length;
    let nextPageToken: string | undefined;
    if (nextOffset < credential.account.files.length) {
      nextPageToken = `synthetic-page-${++pageSequence}`;
      pageTokens.set(nextPageToken, { tenantKey: credential.account.tenantKey, offset: nextOffset });
    }
    return { files: copyFiles(files), ...(nextPageToken ? { nextPageToken } : {}) };
  }

  const port: GoogleDriveReadPort = { listFiles };

  return {
    port,
    createAccount(seed) {
      ensureOpen();
      const key = identityKey(seed.identity);
      if (accountsByIdentity.has(key)) throw new Error('fake Drive identity already exists');
      const seenIds = new Set<string>();
      for (const file of seed.files) {
        if (!file.id || !file.name || !file.mimeType || !file.modifiedTime || seenIds.has(file.id)) {
          throw new Error('fake Drive metadata is invalid');
        }
        seenIds.add(file.id);
      }

      const account: AccountRecord = {
        tenantKey: `fake-drive-tenant-${++tenantSequence}` as DriveTenantKey,
        files: copyFiles(seed.files),
        scopes: new Set(seed.grantedScopes ?? [GOOGLE_DRIVE_METADATA_READONLY_SCOPE]),
        accessToken: undefined,
        refreshToken: undefined,
        loggedOut: false,
        revoked: false,
      };
      accountsByIdentity.set(key, account);
      issueTokens(account);

      const auth: DriveTenantAccess = Object.freeze({
        tenantKey: account.tenantKey,
        async getAccessToken(requiredScope: typeof GOOGLE_DRIVE_METADATA_READONLY_SCOPE) {
          ensureOpen();
          if (!account.scopes.has(requiredScope)) throw new DriveReadContractError('scope-denied');
          if (account.loggedOut || account.revoked || !account.accessToken) throw new DriveReadContractError('unauthenticated');
          const access = accessTokens.get(account.accessToken);
          if (!access || access.revoked || now() >= access.expiresAt) throw new DriveReadContractError('unauthenticated');
          return account.accessToken;
        },
      });

      return {
        tenantKey: account.tenantKey,
        auth,
        refresh() {
          ensureOpen();
          const current = account.refreshToken ? refreshTokens.get(account.refreshToken) : undefined;
          if (!current || current.revoked || account.loggedOut || account.revoked) throw new DriveReadContractError('unauthenticated');
          current.revoked = true;
          refreshes++;
          issueTokens(account);
        },
        expireAccessToken() {
          ensureOpen();
          const current = account.accessToken ? accessTokens.get(account.accessToken) : undefined;
          if (current) accessTokens.set(account.accessToken!, { ...current, expiresAt: now() });
        },
        logout() {
          ensureOpen();
          if (account.accessToken) {
            const current = accessTokens.get(account.accessToken);
            if (current) current.revoked = true;
          }
          if (account.refreshToken) {
            const current = refreshTokens.get(account.refreshToken);
            if (current) current.revoked = true;
          }
          account.accessToken = undefined;
          account.refreshToken = undefined;
          account.loggedOut = true;
        },
        revoke() {
          ensureOpen();
          account.revoked = true;
          for (const token of accessTokens.values()) if (token.account === account) token.revoked = true;
          for (const token of refreshTokens.values()) if (token.account === account) token.revoked = true;
          account.accessToken = undefined;
          account.refreshToken = undefined;
        },
      };
    },
    observations() {
      return { simulatedListCalls, refreshes };
    },
    capabilities() {
      return { externalGoogleApi: 'absent', credentialPersistence: 'absent' };
    },
    close() {
      if (closed) return;
      closed = true;
      accountsByIdentity.clear();
      accessTokens.clear();
      refreshTokens.clear();
      pageTokens.clear();
    },
  };
}
