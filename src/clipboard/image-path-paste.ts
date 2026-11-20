/** Paste-time image-path attach: pasted text that is exactly one image file path is
 *  validated (exists · regular file · size gate · magic bytes) and attached through
 *  the existing clipboard image token contract (`[Image #N]`). Failures keep the
 *  pasted text as-is and return a reason the wiring can surface. */

import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { addAttachmentEx, resolveHome, type Attachment, type ContextRegistry } from '../context.js';

/** Paste-time size gate — generous screenshot ceiling; the submit-time resize in
 *  extractors still runs afterwards. Source: OP order #89839 (cell spec). */
export const IMAGE_PATH_PASTE_MAX_BYTES = 20 * 1024 * 1024;
/** Image subset of the EXT_TO_KIND table in context.ts (keep in sync). Source: OP order #89839. */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

export type ImagePathPasteFormat = 'png' | 'jpeg' | 'gif' | 'webp';
export type ImagePathPasteReason = 'not-a-path' | 'not-found' | 'not-a-file' | 'too-large' | 'not-an-image';
export type ImagePathPasteResult =
  | { readonly kind: 'image'; readonly token: string; readonly attachment: Attachment; readonly isNew: boolean; readonly format: ImagePathPasteFormat }
  | { readonly kind: 'text'; readonly text: string; readonly reason: ImagePathPasteReason; readonly note: string };

export interface ImagePathPasteDeps {
  readonly registry: ContextRegistry;
  readonly readHead?: (path: string, bytes: number) => Promise<Uint8Array>; // injectable head reader for tests
  readonly maxBytes?: number; // injectable size gate — default is the 20MB ceiling
}

/** Magic-byte signatures. Source: PNG, JPEG (SOI), GIF ("GIF8" prefixes both 87a and 89a), WebP (RIFF) format specs. */
const MAGIC_SIGNATURES: ReadonlyArray<{ readonly format: ImagePathPasteFormat; readonly bytes: readonly number[] }> = [
  { format: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { format: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { format: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { format: 'webp', bytes: [0x52, 0x49, 0x46, 0x46] }, // "RIFF" — checked with the WEBP tag below
];
const WEBP_TAG_OFFSET = 8; // "WEBP" follows the RIFF magic + 4-byte size. Source: WebP container spec.
const WEBP_TAG_BYTES = [0x57, 0x45, 0x42, 0x50]; // "WEBP"
const MAGIC_HEAD_BYTES = 12; // head length covering every signature above (WebP needs 12). Source: same specs.

/** Whole-paste path candidate: the paste must be exactly one path (Finder-style
 *  quotes allowed), absolute or ~/ ./ ../ relative, with a supported image
 *  extension. Multiline pastes and URLs never match. */
export function extractImagePathCandidate(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes('\n')) return null;
  const quoted = /^"(.+)"$/.exec(trimmed) ?? /^'(.+)'$/.exec(trimmed);
  const inner = quoted ? quoted[1] : trimmed;
  const ext = inner.split('.').pop()?.toLowerCase() ?? '';
  if (!IMAGE_EXTENSIONS.has(ext)) return null;
  return inner.startsWith('/') || inner.startsWith('~/') || inner.startsWith('./') || inner.startsWith('../') ? inner : null;
}

async function defaultReadHead(path: string, bytes: number): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function detectImageFormat(path: string, deps: ImagePathPasteDeps): Promise<ImagePathPasteFormat | null> {
  let head: Uint8Array;
  try {
    head = await (deps.readHead ?? defaultReadHead)(path, MAGIC_HEAD_BYTES);
  } catch {
    return null;
  }
  for (const signature of MAGIC_SIGNATURES) {
    if (signature.bytes.length > head.length || !signature.bytes.every((byte, index) => head[index] === byte)) continue;
    if (signature.format !== 'webp') return signature.format;
    const tagEnd = WEBP_TAG_OFFSET + WEBP_TAG_BYTES.length;
    return head.length >= tagEnd && WEBP_TAG_BYTES.every((byte, index) => head[WEBP_TAG_OFFSET + index] === byte) ? 'webp' : null;
  }
  return null;
}

/** Validate a pasted image path and attach it through the shared image token
 *  contract, or hand the text back untouched with the failure reason. */
export async function pasteImagePath(pastedText: string, deps: ImagePathPasteDeps): Promise<ImagePathPasteResult> {
  const candidate = extractImagePathCandidate(pastedText);
  if (!candidate) return { kind: 'text', text: pastedText, reason: 'not-a-path', note: '' };
  const resolved = resolveHome(candidate);
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    return { kind: 'text', text: pastedText, reason: 'not-found', note: `path not found: ${candidate}` };
  }
  if (!stat.isFile()) return { kind: 'text', text: pastedText, reason: 'not-a-file', note: `not a regular file: ${candidate}` };
  const maxBytes = deps.maxBytes ?? IMAGE_PATH_PASTE_MAX_BYTES;
  if (stat.size > maxBytes) return { kind: 'text', text: pastedText, reason: 'too-large', note: `file too large: ${stat.size} bytes` };
  const format = await detectImageFormat(resolved, deps);
  if (!format) return { kind: 'text', text: pastedText, reason: 'not-an-image', note: `not an image (magic bytes): ${candidate}` };
  let canonical = resolved;
  try { canonical = realpathSync(resolved); } catch { /* keep resolved */ }
  const result = addAttachmentEx(deps.registry, { kind: 'image', sourcePath: canonical, filename: basename(canonical), sizeBytes: stat.size, mtime: Math.floor(stat.mtimeMs) });
  return { kind: 'image', token: result.attachment.token, attachment: result.attachment, isNew: result.isNew, format };
}
