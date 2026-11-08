export const GOOGLE_DRIVE_METADATA_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.metadata.readonly';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const PAGE_SIZE_MAX = 100;

export interface FakeDriveFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly modifiedTime: string;
}

export interface FakeGoogleDriveOptions {
  readonly files: readonly FakeDriveFile[];
  readonly grantedScopes?: readonly string[];
  readonly pageSizeMax?: number;
}

export interface FakeGoogleDriveWorld {
  readonly accessToken: string | null;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  readonly requests: readonly { method: string; url: string; hasAuthorization: boolean }[];
  readonly mutations: number;
}

/** In-memory Drive files.list world. It accepts no network or token-store dependency. */
export function createFakeGoogleDriveWorld(options: FakeGoogleDriveOptions): FakeGoogleDriveWorld {
  const files = options.files.map((file) => ({ ...file }));
  const grantedScopes = new Set(options.grantedScopes ?? [GOOGLE_DRIVE_METADATA_READONLY_SCOPE]);
  const pageSizeMax = options.pageSizeMax ?? PAGE_SIZE_MAX;
  const accessToken = grantedScopes.size > 0 ? 'fake-drive-metadata-readonly-token' : null;
  const requests: Array<{ method: string; url: string; hasAuthorization: boolean }> = [];
  let mutations = 0;

  return {
    accessToken,
    get requests() { return requests.map((request) => ({ ...request })); },
    get mutations() { return mutations; },
    async fetch(input, init = {}) {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
      const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
      const bearer = /^Bearer\s+(.+)$/i.exec(headers.get('authorization') ?? '')?.[1] ?? null;
      requests.push({ method, url: `${url.origin}${url.pathname}${url.search}`, hasAuthorization: bearer !== null });

      if (url.origin !== 'https://www.googleapis.com' || url.pathname !== '/drive/v3/files') {
        return json({ error: { code: 404, message: 'fake Drive endpoint not found' } }, 404);
      }
      if (!bearer || bearer !== accessToken) return json({ error: { code: 401, message: 'unauthorized' } }, 401);
      if (!grantedScopes.has(GOOGLE_DRIVE_METADATA_READONLY_SCOPE)) {
        return json({ error: { code: 403, message: 'insufficient authentication scope' } }, 403);
      }
      if (method !== 'GET') {
        return json({ error: { code: 403, message: 'read-only fake Drive world' } }, 403);
      }

      const requestedFields = url.searchParams.get('fields');
      if (requestedFields !== 'files(id,name,mimeType,modifiedTime),nextPageToken') {
        return json({ error: { code: 400, message: 'unsupported fields selector' } }, 400);
      }
      const pageSizeRaw = url.searchParams.get('pageSize') ?? '100';
      const pageSize = Number(pageSizeRaw);
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > pageSizeMax) {
        return json({ error: { code: 400, message: 'invalid pageSize' } }, 400);
      }
      const pageToken = url.searchParams.get('pageToken');
      const start = pageToken === null ? 0 : /^page:(\d+)$/.test(pageToken) ? Number(pageToken.slice(5)) : -1;
      if (start < 0 || start > files.length) return json({ error: { code: 400, message: 'invalid pageToken' } }, 400);
      const selected = files.slice(start, start + pageSize);
      const next = start + selected.length;
      return json({
        files: selected.map(({ id, name, mimeType, modifiedTime }) => ({ id, name, mimeType, modifiedTime })),
        ...(next < files.length ? { nextPageToken: `page:${next}` } : {}),
      });
    },
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
