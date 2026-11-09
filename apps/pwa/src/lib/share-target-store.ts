// Service Worker Phase 2 — share-target file pickup.
//
// The SW (apps/pwa/public/sw.js) intercepts Share Target POST and
// stashes incoming files under a dedicated Cache Storage bucket.
// This module reads them back from the page side, drains the entry
// (so a refresh doesn't re-pop the same files), and returns Files
// the existing `uploadAttachment` helper can hand to the daemon.
//
// Design contract (mirror of sw.js):
//   - SHARE_CACHE name must match `elanous-pwa-share-target-<version>`
//   - Manifest is at `/__share/<id>/manifest.json`
//   - Each file is at `/__share/<id>/<index>/<encoded-filename>`
//
// We keep the version string out of this module — the SW writes
// `${CACHE_PREFIX}share-target-${CACHE_VERSION}` and we read by
// scanning `caches.keys()` for any cache that starts with the
// stable prefix. That way a future SW version bump doesn't require
// a coordinated client release; the page simply finds the latest.

import { debugLog } from './debug';

const SHARE_CACHE_PREFIX = 'elanous-pwa-share-target-';

interface ShareManifestFile {
  index: number;
  cacheUrl: string;
  filename: string;
  type: string;
  size: number;
}

interface ShareManifest {
  id: string;
  ts: number;
  title: string;
  text: string;
  url: string;
  files: ShareManifestFile[];
}

export interface SharedPayload {
  id: string;
  title: string;
  text: string;
  url: string;
  files: File[];
  /** Cache keys aligned by index with `files` for partial acknowledgement. */
  fileKeys: string[];
  /** Combined text the existing Level 1 flow already feeds into
   *  `/chat` as a prefill — we keep that contract so behaviour
   *  stays identical when no files are attached. */
  combinedText: string;
}

async function findShareCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  const keys = await caches.keys();
  // Pick the most-recent matching cache. There should usually be
  // exactly one, but a stale entry from a prior SW bump can linger
  // until activate cleanup runs — defensive sort keeps us from
  // reading the wrong one.
  const matches = keys
    .filter((k) => k.startsWith(SHARE_CACHE_PREFIX))
    .sort()
    .reverse();
  if (matches.length === 0) return null;
  return caches.open(matches[0]!);
}

function buildCombinedText(m: ShareManifest): string {
  const parts: string[] = [];
  if (m.title.trim()) parts.push(m.title.trim());
  if (m.text.trim()) parts.push(m.text.trim());
  if (m.url.trim()) parts.push(m.url.trim());
  return parts.join('\n\n');
}

/** Read a freshly-shared payload identified by `id` (the value of
 *  the `?shared=` query param). Returns `null` when the SW didn't
 *  store anything for this id (cache miss · stale link · SW not
 *  controlling the page yet). Drains the manifest + files on
 *  success so a reload doesn't re-pop the same payload. */
export async function takeSharedPayload(id: string, options: { drain?: boolean } = {}): Promise<SharedPayload | null> {
  if (!id) return null;
  const cache = await findShareCache();
  if (!cache) {
    debugLog('pwa.share.l2.cache-missing', { id });
    return null;
  }
  const manifestUrl = `/__share/${id}/manifest.json`;
  const manifestRes = await cache.match(manifestUrl);
  if (!manifestRes) {
    debugLog('pwa.share.l2.no-manifest', { id });
    return null;
  }
  const manifest = (await manifestRes.json()) as ShareManifest;
  const files: File[] = [];
  const fileKeys: string[] = [];
  for (const meta of manifest.files) {
    const fileRes = await cache.match(meta.cacheUrl);
    if (!fileRes) {
      debugLog('pwa.share.l2.file-missing', { id, cacheUrl: meta.cacheUrl });
      continue;
    }
    const blob = await fileRes.blob();
    files.push(new File([blob], meta.filename, { type: meta.type || blob.type }));
    fileKeys.push(meta.cacheUrl);
  }
  if (options.drain !== false) {
    await cache.delete(manifestUrl);
    for (const meta of manifest.files) await cache.delete(meta.cacheUrl);
  }
  debugLog('pwa.share.l2.delivered', {
    id,
    fileCount: files.length,
    titleLen: manifest.title.length,
    textLen: manifest.text.length,
  });
  return {
    id: manifest.id,
    title: manifest.title,
    text: manifest.text,
    url: manifest.url,
    files,
    fileKeys,
    combinedText: buildCombinedText(manifest),
  };
}

/** Remove only acknowledged uploads; failed files remain available for retry. */
export async function acknowledgeSharedPayloadFiles(id: string, fileKeys: readonly string[]): Promise<void> {
  const cache = await findShareCache();
  if (!cache) return;
  const manifestUrl = `/__share/${id}/manifest.json`;
  const manifestRes = await cache.match(manifestUrl);
  if (!manifestRes) return;
  const manifest = (await manifestRes.json()) as ShareManifest;
  const acknowledged = new Set(fileKeys);
  for (const meta of manifest.files) {
    if (acknowledged.has(meta.cacheUrl)) await cache.delete(meta.cacheUrl);
  }
  const remaining = manifest.files.filter((meta) => !acknowledged.has(meta.cacheUrl));
  if (remaining.length === 0) {
    await cache.delete(manifestUrl);
  } else if (acknowledged.size > 0) {
    await cache.put(manifestUrl, new Response(JSON.stringify({ ...manifest, files: remaining }), {
      headers: { 'content-type': 'application/json' },
    }));
  }
}

/** Test seam — synthesize a manifest in the Share Cache so unit tests
 *  can exercise `takeSharedPayload` end-to-end without driving the
 *  SW fetch handler. */
export async function _writeSharedPayloadForTest(
  id: string,
  manifest: ShareManifest,
  fileBlobs: Array<{ cacheUrl: string; blob: Blob; type: string }>,
): Promise<void> {
  if (typeof caches === 'undefined') return;
  const cache = await caches.open(`${SHARE_CACHE_PREFIX}test`);
  await cache.put(
    `/__share/${id}/manifest.json`,
    new Response(JSON.stringify(manifest), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  for (const f of fileBlobs) {
    await cache.put(
      f.cacheUrl,
      new Response(f.blob, { headers: { 'content-type': f.type } }),
    );
  }
}
