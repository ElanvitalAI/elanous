// ── KGP image preview pipeline ──
//
// End-to-end render for a single image into the four artefacts the UI
// layer needs: upload APC bytes, a placeholder-cell grid, a delete APC,
// and the image id used by both. The pipeline handles decode + resize
// (via sharp), imageId allocation, and short-lived per-session caching
// so repainting the same file in the same pane is free.
//
// Consumers:
//   - dashboard-preview-modal.ts (Phase 3): writes uploadBytes to
//     stdout before pushing the modal, uses placeholderLines as modal
//     body, fires cleanupSeq on modal dispose.
//   - dashboard.ts preview pane (future): same pattern, per-pane
//     imageId tracking so cursor moves erase the prior image.
//
// If KGP isn't available the caller is expected to fall through to
// src/image-preview.ts (chafa/viu). isKgpTerminal() is the guard.

import { statSync } from 'node:fs';
// IMPORT-DIET-LAZY-SDK (2026-11-05): sharp(네이티브)는 실제로 그릴 때만 싣는다.
import { cellsToPixels, cellSize } from './cell-size.js';
import {
  uploadSequence,
  placeholderGrid,
  deleteSequence,
  wrapForTmux,
  type ImageFrame,
} from './encoder.js';

export interface KgpRenderResult {
  imageId: number;
  /** Bytes to write directly to stdout to transmit the image. The
   *  terminal will cache by imageId; subsequent redraws of the same
   *  placeholder grid don't re-send the bytes (but we don't rely on
   *  that — we always include uploadBytes on first render of an id). */
  uploadBytes: string;
  /** Printable lines that occupy `rows` cells vertically and `cols`
   *  cells horizontally. Safe to embed in any ANSI-passthrough pane
   *  paint. Kitty renders the image into these cells. */
  placeholderLines: string[];
  /** APC to erase this image from the terminal cache. Call on pane
   *  close or when the user navigates off this preview. */
  cleanupSeq: string;
  /** Actual rendered rows/cols — may be smaller than requested if the
   *  image's native aspect ratio couldn't fill the requested rect. */
  renderedRows: number;
  renderedCols: number;
}

export interface KgpRenderOpts {
  /** Target preview rect in terminal cells. Image scales to fit,
   *  preserving aspect ratio. */
  rows: number;
  cols: number;
  /** Override the derived imageId (tests). Otherwise derived from
   *  path + mtime — stable across repaints, unique per file revision. */
  imageId?: number;
}

interface CacheEntry {
  key: string;
  value: KgpRenderResult;
}

const cache: Map<string, CacheEntry> = new Map();
const CACHE_MAX = 64;

export async function renderImageKGP(
  absPath: string,
  opts: KgpRenderOpts,
): Promise<KgpRenderResult | null> {
  const rows = Math.max(1, Math.floor(opts.rows));
  const cols = Math.max(1, Math.floor(opts.cols));

  let mtime = 0;
  try { mtime = Math.floor(statSync(absPath).mtimeMs); } catch { return null; }

  const imageId = opts.imageId ?? deriveImageId(absPath, mtime);

  const key = `${absPath}|${mtime}|${rows}x${cols}|${imageId}`;
  const hit = cache.get(key);
  if (hit) return hit.value;

  let rendered: KgpRenderResult;
  try {
    rendered = await encodeFromFile(absPath, { rows, cols, imageId });
  } catch {
    return null;
  }

  // LRU-ish: drop the oldest entry when the map is full. Map iteration
  // order is insertion order, so the first key is the oldest.
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { key, value: rendered });
  return rendered;
}

async function encodeFromFile(
  absPath: string,
  opts: { rows: number; cols: number; imageId: number },
): Promise<KgpRenderResult> {
  const { rows, cols, imageId } = opts;
  const { w: pxW, h: pxH } = cellsToPixels(cols, rows);
  const { cellW, cellH } = cellSize();

  // sharp pipeline:
  //   1. auto-orient (honor EXIF so phone photos aren't sideways)
  //   2. resize to fit max box; preserve aspect; no enlargement
  //   3. emit raw RGBA for the encoder
  const { default: sharp } = await import('sharp');
  const pipeline = sharp(absPath).rotate(); // rotate() w/o args applies EXIF orientation
  const resized = pipeline.resize({
    width: pxW,
    height: pxH,
    fit: 'inside',
    withoutEnlargement: true,
  });
  const { data, info } = await resized
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const frame: ImageFrame = {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    w: info.width,
    h: info.height,
    format: 32, // ensureAlpha() guarantees RGBA
    imageId,
  };

  // Back-convert the rendered px box to cells to get the actual grid
  // size (the image likely didn't use the full requested rect because
  // of aspect preservation).
  const renderedCols = Math.max(1, Math.ceil(info.width / cellW));
  const renderedRows = Math.max(1, Math.ceil(info.height / cellH));
  const boundedCols = Math.min(renderedCols, cols);
  const boundedRows = Math.min(renderedRows, rows);

  const uploadRaw = uploadSequence(frame);
  const cleanupRaw = deleteSequence(imageId);
  // Under tmux, wrap both APC streams so they survive the mux DCS
  // passthrough. Requires `allow-passthrough on` (see KGP-PREVIEW.md);
  // without it, the image renders as empty placeholder cells — the
  // chafa fallback isn't selected because isKgpTerminal() still
  // succeeds on the inner terminal. We rely on the user having
  // followed the setup doc; there's no runtime detection of whether
  // the passthrough option is enabled.
  const underTmux = !!process.env.TMUX;
  const uploadBytes  = underTmux ? wrapForTmux(uploadRaw)  : uploadRaw;
  const cleanupSeq   = underTmux ? wrapForTmux(cleanupRaw) : cleanupRaw;

  return {
    imageId,
    uploadBytes,
    placeholderLines: placeholderGrid({ rows: boundedRows, cols: boundedCols, imageId }),
    cleanupSeq,
    renderedRows: boundedRows,
    renderedCols: boundedCols,
  };
}

/** FNV-1a over path + mtime → 24-bit id. Stable for a given file
 *  revision, deterministic across processes, ≈ collision-free at the
 *  scale of a preview session. 0 is avoided because yazi reserves it. */
function deriveImageId(absPath: string, mtime: number): number {
  const s = `${absPath}|${mtime}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  const id = h & 0xFFFFFF;
  return id === 0 ? 1 : id;
}

/** Test-only — wipe the cache + probes. */
export function _resetForTest(): void {
  cache.clear();
}
