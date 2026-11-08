/** The only Drive OAuth capability in this draft: metadata listing, without file contents or writes. */
export const GOOGLE_DRIVE_METADATA_READONLY_SCOPE =
  'https://www.googleapis.com/auth/drive.metadata.readonly' as const;

/** Keep the projection fixed so file content, owners, emails, and other metadata are not returned. */
export const GOOGLE_DRIVE_FILES_LIST_FIELDS =
  'files(id,name,mimeType,modifiedTime),nextPageToken' as const;

export const GOOGLE_DRIVE_MAX_PAGE_SIZE = 100;

/** Opaque key supplied by the verified Nexus identity boundary; never read from a route or request body. */
export type DriveTenantKey = string & { readonly __driveTenantKey: unique symbol };

export interface DriveTenantAccess {
  readonly tenantKey: DriveTenantKey;
  /** Returns a short-lived bearer in memory for this tenant and exact scope; callers must not log it. */
  getAccessToken(requiredScope: typeof GOOGLE_DRIVE_METADATA_READONLY_SCOPE): Promise<string>;
}

export interface GoogleDriveFileMetadata {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly modifiedTime: string;
}

export interface GoogleDriveFileListPage {
  readonly files: readonly GoogleDriveFileMetadata[];
  /** Opaque continuation token; an adapter must bind it to the authenticated tenant. */
  readonly nextPageToken?: string;
}

export interface GoogleDriveFileListInput {
  /** Comes from the authenticated server context, not app input or host aliases. */
  readonly auth: DriveTenantAccess;
  readonly pageSize?: number;
  readonly pageToken?: string;
}

/** Read-only by surface: this port deliberately has no get-content, upload, update, or delete methods. */
export interface GoogleDriveReadPort {
  listFiles(input: GoogleDriveFileListInput): Promise<GoogleDriveFileListPage>;
}

export type DriveReadContractErrorCode =
  | 'unauthenticated'
  | 'scope-denied'
  | 'tenant-mismatch'
  | 'invalid-page-size'
  | 'invalid-page-token'
  | 'closed';

/** Safe, token-free failure contract for a future Nexus adapter and the fake world. */
export class DriveReadContractError extends Error {
  constructor(readonly code: DriveReadContractErrorCode) {
    super(`Drive read rejected: ${code}`);
    this.name = 'DriveReadContractError';
  }
}
