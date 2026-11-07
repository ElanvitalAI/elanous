import { appObjectKey, createObjectStore, type ObjectStore, type StorageConfig } from '../../storage/object-store.js';

const DEFAULT_CONTENT_TYPES = ['application/json', 'audio/mpeg', 'audio/wav', 'audio/webm', 'image/jpeg', 'image/png'];

export interface AppUploadOptions {
  readonly store?: ObjectStore;
  readonly config?: StorageConfig;
  readonly maxUploadBytes?: number;
  readonly allowedContentTypes?: readonly string[];
}

export interface AppUploadResult { readonly status: number; readonly bytes?: number; readonly reason?: string }
export interface AppUpload {
  upload(input: { appSlug: string; key: string; body: Uint8Array; contentType: string }): AppUploadResult;
  list(appSlug: string): string[];
}

function canonicalContentType(value: string): string { return value.split(';', 1)[0]!.trim().toLowerCase(); }

/** Owner-authenticated, per-file app uploads; app keys cannot select another namespace. */
export function createAppUpload(options: AppUploadOptions): AppUpload {
  const store: ObjectStore = options.store ?? (options.config ? createObjectStore(options.config) : (() => {
    throw new Error('app upload object store is required');
  })());
  const maxUploadBytes = options.maxUploadBytes ?? 10 * 1024 * 1024;
  const allowedTypes = new Set((options.allowedContentTypes ?? DEFAULT_CONTENT_TYPES).map(canonicalContentType));

  return {
    upload(input) {
      let fullKey: string;
      try { fullKey = appObjectKey(input.appSlug, input.key); }
      catch { return { status: 400, reason: 'invalid app slug or app-relative object key' }; }
      const contentType = canonicalContentType(input.contentType);
      if (!allowedTypes.has(contentType)) return { status: 415, reason: 'content type is not allowed' };
      if (!(input.body instanceof Uint8Array)) return { status: 400, reason: 'body must be bytes' };
      if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 0) return { status: 500, reason: 'invalid upload size limit' };
      if (input.body.byteLength > maxUploadBytes) return { status: 413, reason: 'upload size limit exceeded' };
      try {
        store.put(fullKey, input.body, { contentType });
        return { status: 201, bytes: input.body.byteLength };
      } catch { return { status: 503, reason: 'storage provider rejected upload' }; }
    },
    list(appSlug) {
      const prefix = `apps/${appSlug}/`;
      appObjectKey(appSlug, 'probe');
      return store.list(prefix).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)).sort();
    },
  };
}
