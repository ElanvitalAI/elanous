// ── Image pipeline (M2) ──
//
// Load an image from disk, detect its format via magic bytes, and resize /
// recompress it so the resulting base64 fits a multimodal LLM call. The
// downscale strategy is a TypeScript port of Claude Code's
// `maybeResizeAndDownsampleImageBuffer` (see `ref/claude-code-fork`
// src/utils/imageResizer.ts:169-383) — PNG→JPEG transition, aspect-ratio
// preservation, and a 1000px floor are the core ideas we keep.
//
// Outputs are cached by `sourcePath + mtime` so a re-submit with the same
// file doesn't re-encode. Cache lives for the lifetime of the process.

import { readFile, stat } from 'fs/promises';
// IMPORT-DIET-LAZY-SDK (2026-11-05): sharp(네이티브)는 이미지를 실제로 줄일 때만 싣는다.
let sharpModule: Promise<typeof import('sharp')> | null = null;
function loadSharp(): Promise<typeof import('sharp')> {
  sharpModule ??= import('sharp').then((m) => m.default);
  return sharpModule;
}

export const IMAGE_MAX_WIDTH = 1568;
export const IMAGE_MAX_HEIGHT = 1568;
/** Target raw-byte cap after resize/compression (3 MB — well under most API limits). */
export const TARGET_RAW_BYTES = 3 * 1024 * 1024;
/** Minimum width we'll shrink to when 3 MB still isn't met. */
const MIN_FLOOR_WIDTH = 1000;

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ResizeResult {
  buf: Buffer;
  mediaType: ImageMediaType;
  width: number;
  height: number;
  /** True if the output buffer differs from input (resized or recompressed). */
  transformed: boolean;
}

export interface LoadedImage {
  base64: string;
  mediaType: ImageMediaType;
  dimensions: { w: number; h: number };
  sizeBytes: number;  // length of the raw (pre-base64) buffer
}

/**
 * Identify the image format from the leading bytes of `buf`. Falls back to
 * `image/png` when no magic matches — callers that care should validate via
 * sharp's metadata() instead of trusting this return value blindly.
 */
export function detectMediaType(buf: Buffer): ImageMediaType {
  if (buf.length < 4) return 'image/png';

  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF: 47 49 46 ('GIF')
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return 'image/gif';
  }
  // WebP: RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'image/webp';
  }

  return 'image/png';
}

function mediaTypeFromFormat(fmt: string | undefined, fallback: ImageMediaType): ImageMediaType {
  switch (fmt) {
    case 'png':  return 'image/png';
    case 'jpeg':
    case 'jpg':  return 'image/jpeg';
    case 'gif':  return 'image/gif';
    case 'webp': return 'image/webp';
    default:     return fallback;
  }
}

/**
 * Resize + recompress `buf` so the output respects `IMAGE_MAX_*` pixel
 * dimensions and `TARGET_RAW_BYTES` byte cap.
 *
 * Strategy (matches Claude Code's resizer — see header comment):
 *   1. If already within pixel + byte caps, return unchanged.
 *   2. Constrain to IMAGE_MAX_WIDTH/HEIGHT (aspect preserved, no upscale).
 *   3. If still over byte cap:
 *      - PNG with alpha → re-encode as PNG with max compression (keep transparency).
 *      - Otherwise → JPEG with quality ladder 85 / 70 / 55 / 40.
 *   4. If JPEG 40 still too big, downscale to 1000px floor + quality 40.
 *
 * If any step fails hard (sharp throws), rethrow — the caller (loadAttachment)
 * turns that into a graceful warning and leaves `att.loaded = false`.
 */
export async function resizeImage(
  buf: Buffer,
  hintedMediaType?: ImageMediaType,
): Promise<ResizeResult> {
  const sharp = await loadSharp();
  const image = sharp(buf);
  const metadata = await image.metadata();
  const mediaType = mediaTypeFromFormat(
    metadata.format,
    hintedMediaType ?? detectMediaType(buf),
  );

  const origW = metadata.width ?? 0;
  const origH = metadata.height ?? 0;
  const hasAlpha = !!metadata.hasAlpha;

  // (1) Happy path — fits both caps.
  if (
    buf.length <= TARGET_RAW_BYTES &&
    origW > 0 && origH > 0 &&
    origW <= IMAGE_MAX_WIDTH && origH <= IMAGE_MAX_HEIGHT
  ) {
    return { buf, mediaType, width: origW, height: origH, transformed: false };
  }

  // (2) Clamp dimensions while preserving aspect ratio.
  let targetW = origW;
  let targetH = origH;
  if (targetW > IMAGE_MAX_WIDTH) {
    targetH = Math.round((targetH * IMAGE_MAX_WIDTH) / Math.max(targetW, 1));
    targetW = IMAGE_MAX_WIDTH;
  }
  if (targetH > IMAGE_MAX_HEIGHT) {
    targetW = Math.round((targetW * IMAGE_MAX_HEIGHT) / Math.max(targetH, 1));
    targetH = IMAGE_MAX_HEIGHT;
  }

  // Fall back to a sensible box if metadata is missing.
  const resizeW = targetW > 0 ? targetW : IMAGE_MAX_WIDTH;
  const resizeH = targetH > 0 ? targetH : IMAGE_MAX_HEIGHT;

  const resized = await sharp(buf)
    .resize(resizeW, resizeH, { fit: 'inside', withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true });

  if (resized.data.length <= TARGET_RAW_BYTES) {
    return {
      buf: resized.data,
      mediaType: mediaTypeFromFormat(resized.info.format, mediaType),
      width: resized.info.width,
      height: resized.info.height,
      transformed: true,
    };
  }

  // (3) Still too big. PNG + alpha → keep PNG path, max compression.
  if (mediaType === 'image/png' && hasAlpha) {
    const pngCompressed = await sharp(buf)
      .resize(resizeW, resizeH, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9, palette: true })
      .toBuffer({ resolveWithObject: true });
    if (pngCompressed.data.length <= TARGET_RAW_BYTES) {
      return {
        buf: pngCompressed.data,
        mediaType: 'image/png',
        width: pngCompressed.info.width,
        height: pngCompressed.info.height,
        transformed: true,
      };
    }
    // If PNG still too fat, fall through to JPEG ladder — losing transparency
    // is preferable to dropping the image entirely.
  }

  // JPEG ladder: 85 → 70 → 55 → 40.
  for (const quality of [85, 70, 55, 40] as const) {
    const jpegBuf = await sharp(buf)
      .resize(resizeW, resizeH, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer({ resolveWithObject: true });
    if (jpegBuf.data.length <= TARGET_RAW_BYTES) {
      return {
        buf: jpegBuf.data,
        mediaType: 'image/jpeg',
        width: jpegBuf.info.width,
        height: jpegBuf.info.height,
        transformed: true,
      };
    }
  }

  // (4) Last resort — downscale to MIN_FLOOR_WIDTH + quality 40.
  const floorW = Math.min(resizeW, MIN_FLOOR_WIDTH);
  const floorH = resizeW > 0 ? Math.round((resizeH * floorW) / resizeW) : floorW;
  const floored = await sharp(buf)
    .resize(floorW, floorH, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 40 })
    .toBuffer({ resolveWithObject: true });

  return {
    buf: floored.data,
    mediaType: 'image/jpeg',
    width: floored.info.width,
    height: floored.info.height,
    transformed: true,
  };
}

// ── Resize cache ──────────────────────────────────────────
//
// Memoize by (sourcePath, mtime). Keeps repeated submits cheap without
// caching across file edits — mtime bumps when the user re-generates the
// screenshot / re-saves the figure.

interface CacheKey { path: string; mtime: number }
const cache = new Map<string, LoadedImage>();

function keyFor(k: CacheKey): string {
  return `${k.path}\u0000${k.mtime}`;
}

/** Test helper — clears the resize cache. */
export function clearImageCache(): void {
  cache.clear();
}

/**
 * Read an image file from disk, resize/compress it as needed, and return
 * the LLM-ready payload (base64 + mediaType + final dimensions).
 *
 * Results are cached by `path + mtime`; call `clearImageCache()` in tests
 * if you need to force a re-encode.
 */
export async function loadImageAsAttachment(path: string): Promise<LoadedImage> {
  const st = await stat(path);
  const mtime = Math.floor(st.mtimeMs);
  const k = keyFor({ path, mtime });

  const hit = cache.get(k);
  if (hit) return hit;

  const raw = await readFile(path);
  const resized = await resizeImage(raw, detectMediaType(raw));
  const result: LoadedImage = {
    base64: resized.buf.toString('base64'),
    mediaType: resized.mediaType,
    dimensions: { w: resized.width, h: resized.height },
    sizeBytes: resized.buf.length,
  };

  cache.set(k, result);
  return result;
}
