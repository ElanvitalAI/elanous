// ── Request image normalizer (IMAGE-REQUEST-BUDGET · CEO 11-25 13:21) ──
//
// Every image that goes into an LLM request (a pasted/@-mentioned attachment, an image-bearing tool result such as
// Read on a PNG) passes through here first:
//   - downscale so neither side exceeds REQUEST_IMAGE_MAX_DIMENSION (2048 — upstream codex
//     codex-rs/utils/image/src/lib.rs MAX_DIMENSION, resized with a triangle/linear filter like FilterType::Triangle)
//   - re-encode a large result (PNG → JPEG q85, or WebP q85 when it has alpha; quality ladder down to 55)
//   - metadata is stripped (sharp drops EXIF/ICC unless asked to keep it); orientation is applied first
//   - still over the per-image budget → `dropped` (the caller sends the path as text instead of failing the turn)
// The original file on disk is never touched. Each call logs `image.normalized` with from/to dimensions and bytes.

import { debug } from '../debug/log.js';
import type { ContentBlock } from '../llm.js';
import { REQUEST_IMAGE_MAX_B64_CHARS, imageDroppedText } from '../llm-request-images.js';

/** Upstream codex MAX_DIMENSION (codex-rs/utils/image/src/lib.rs). */
export const REQUEST_IMAGE_MAX_DIMENSION = 2048;
/** Below this many bytes an un-resized PNG/JPEG/WebP is sent as its original bytes. */
export const REQUEST_IMAGE_REENCODE_ABOVE_BYTES = 512 * 1024;
const QUALITY_LADDER = [85, 70, 55] as const;

export interface ImageSize { w: number; h: number; bytes: number }

export type NormalizedRequestImage =
  | { kind: 'image'; mediaType: string; base64: string; from: ImageSize; to: ImageSize; resized: boolean }
  | { kind: 'dropped'; reason: 'too-large' | 'undecodable'; from: ImageSize };

let sharpModule: Promise<typeof import('sharp')> | null = null;
function loadSharp(): Promise<typeof import('sharp')> {
  sharpModule ??= import('sharp').then((m) => (m as unknown as { default?: typeof import('sharp') }).default ?? (m as unknown as typeof import('sharp')));
  return sharpModule;
}

function b64Len(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** Downscale/re-encode one image for a request. `maxB64Chars` defaults to the per-image request budget. */
export async function normalizeRequestImage(
  buf: Buffer,
  opts: { mediaType?: string; maxB64Chars?: number; maxDimension?: number; source?: string } = {},
): Promise<NormalizedRequestImage> {
  const maxB64Chars = opts.maxB64Chars ?? REQUEST_IMAGE_MAX_B64_CHARS;
  const maxDimension = opts.maxDimension ?? REQUEST_IMAGE_MAX_DIMENSION;
  const fallbackFrom: ImageSize = { w: 0, h: 0, bytes: buf.length };
  let result: NormalizedRequestImage;
  try {
    const sharp = await loadSharp();
    const meta = await sharp(buf, { failOn: 'none' }).metadata();
    const w0 = meta.autoOrient?.width ?? meta.width ?? 0;
    const h0 = meta.autoOrient?.height ?? meta.height ?? 0;
    const from: ImageSize = { w: w0, h: h0, bytes: buf.length };
    const format = meta.format;
    const needsResize = w0 > maxDimension || h0 > maxDimension;
    const keepOriginal = !needsResize
      && (format === 'png' || format === 'jpeg' || format === 'webp')
      && buf.length <= REQUEST_IMAGE_REENCODE_ABOVE_BYTES
      && b64Len(buf.length) <= maxB64Chars;
    if (keepOriginal) {
      result = { kind: 'image', mediaType: `image/${format}`, base64: buf.toString('base64'), from, to: { ...from }, resized: false };
    } else {
      const base = () => {
        const pipeline = sharp(buf, { failOn: 'none', animated: false }).rotate();
        return needsResize
          ? pipeline.resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true, kernel: 'linear' })
          : pipeline;
      };
      let out: { data: Buffer; info: { width: number; height: number } } | null = null;
      let mediaType = 'image/png';
      // A resized PNG that is already small stays PNG (lossless text in screenshots).
      if (format === 'png' || format === 'gif') {
        const png = await base().png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
        if (png.data.length <= REQUEST_IMAGE_REENCODE_ABOVE_BYTES) out = png;
      }
      if (!out) {
        for (const quality of QUALITY_LADDER) {
          const encoded = meta.hasAlpha
            ? await base().webp({ quality }).toBuffer({ resolveWithObject: true })
            : await base().jpeg({ quality, mozjpeg: false }).toBuffer({ resolveWithObject: true });
          mediaType = meta.hasAlpha ? 'image/webp' : 'image/jpeg';
          out = encoded;
          if (b64Len(encoded.data.length) <= maxB64Chars) break;
        }
      }
      const to: ImageSize = { w: out!.info.width, h: out!.info.height, bytes: out!.data.length };
      result = b64Len(out!.data.length) <= maxB64Chars
        ? { kind: 'image', mediaType, base64: out!.data.toString('base64'), from, to, resized: to.w !== w0 || to.h !== h0 }
        : { kind: 'dropped', reason: 'too-large', from };
    }
  } catch (error) {
    // No decoder (or sharp unavailable): small enough originals still go through untouched.
    const mediaType = opts.mediaType ?? 'image/png';
    result = b64Len(buf.length) <= maxB64Chars && buf.length <= REQUEST_IMAGE_REENCODE_ABOVE_BYTES * 2
      ? { kind: 'image', mediaType, base64: buf.toString('base64'), from: fallbackFrom, to: { ...fallbackFrom }, resized: false }
      : { kind: 'dropped', reason: 'undecodable', from: fallbackFrom };
    debug.log('image', 'image.normalize-error', {
      source: opts.source ?? null, bytes: buf.length, message: error instanceof Error ? error.message : String(error),
    }, { level: 'warn' });
  }
  if (result.kind === 'image') {
    debug.log('image', 'image.normalized', { source: opts.source ?? null, from: result.from, to: result.to, mediaType: result.mediaType });
  } else {
    debug.log('image', 'image.dropped', { source: opts.source ?? null, from: result.from, reason: result.reason }, { level: 'warn' });
  }
  return result;
}

/** Upstream codex `image_resize_notice` wording (core/tests/suite/view_image.rs) — tells the model the real size. */
export function imageResizeNotice(where: 'user message' | 'tool output', index: number, total: number, from: ImageSize, to: ImageSize): string {
  return `<image_resize_notice>\nImage ${index} of ${total} in the preceding ${where} was resized from ${from.w}x${from.h} to ${to.w}x${to.h} pixels.\n</image_resize_notice>`;
}

export interface PreparedRequestImage {
  /** The image block, or a text block naming the path when the image could not fit. */
  block: ContentBlock;
  /** Resize notice for the model (resized images only). */
  notice?: string;
  /** One-line note for the person's transcript when the image was dropped. */
  droppedNote?: string;
}

/** Normalize an attachment's bytes into the block the request carries. Never throws for an image problem. */
export async function prepareRequestImage(
  buf: Buffer,
  path: string,
  opts: { mediaType?: string; maxB64Chars?: number; index?: number; total?: number; where?: 'user message' | 'tool output' } = {},
): Promise<PreparedRequestImage> {
  const normalized = await normalizeRequestImage(buf, {
    ...(opts.mediaType ? { mediaType: opts.mediaType } : {}),
    ...(opts.maxB64Chars !== undefined ? { maxB64Chars: opts.maxB64Chars } : {}),
    source: path,
  });
  if (normalized.kind === 'dropped') {
    const text = imageDroppedText(path);
    return { block: { type: 'text', text }, droppedNote: text };
  }
  return {
    block: { type: 'image', mediaType: normalized.mediaType, base64: normalized.base64 },
    ...(normalized.resized
      ? { notice: imageResizeNotice(opts.where ?? 'user message', opts.index ?? 1, opts.total ?? 1, normalized.from, normalized.to) }
      : {}),
  };
}
