// ── Request image budget (IMAGE-REQUEST-BUDGET · CEO 11-25 13:21) ──
//
// The Codex request-size guard caps the serialized request at N characters to protect the TEXT context. An inline
// image travels as a `data:image/…;base64,…` URL inside an `input_image` part, so a single 2576×168 screenshot
// (~1.1 MB PNG → ~1.5 M base64 chars) pushed a normal ~125 k-char request to 1.7 M chars: compaction ran (two
// ~190 k-token summarizer calls), could not shrink the image, and the turn ended `failed`.
//
// Images get their own budget here:
//   - text chars  = serialized length − inline image payload chars (the cap applies to this number only)
//   - per image   ≤ REQUEST_IMAGE_MAX_B64_CHARS base64 chars
//   - per request ≤ REQUEST_IMAGE_MAX_COUNT inline images (the newest are kept)
// An image over budget is replaced by a one-line text part instead of failing the turn.
//
// Pure functions only (no sharp, no I/O) — the pixel normalizer lives in src/image/request-image-normalize.ts.

/** Per-image ceiling after encoding (base64 chars ≈ 1.1 MB of bytes). */
export const REQUEST_IMAGE_MAX_B64_CHARS = 1_500_000;
/** Inline images per request. Older ones beyond this are replaced by a text note. */
export const REQUEST_IMAGE_MAX_COUNT = 8;
/** The visible note that replaces an image that could not fit the budget. */
export const IMAGE_DROPPED_NOTE = 'image too large — sent as path only';

export function imageDroppedText(path?: string): string {
  return path ? `[${IMAGE_DROPPED_NOTE}: ${path}]` : `[${IMAGE_DROPPED_NOTE}]`;
}

const INLINE_IMAGE_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=]+)/g;

/** Inline image payloads inside a serialized request: how many, and how many characters they take. */
export function measureInlineImageChars(serialized: string): { count: number; chars: number } {
  let count = 0;
  let chars = 0;
  for (const match of serialized.matchAll(INLINE_IMAGE_RE)) {
    count += 1;
    chars += match[1]!.length;
  }
  return { count, chars };
}

/** The request size the text cap is meant for: everything except inline image payloads. */
export function requestTextChars(serialized: string): number {
  return serialized.length - measureInlineImageChars(serialized).chars;
}

type Part = Record<string, unknown>;

function isInlineImagePart(value: unknown): value is Part & { image_url: string } {
  if (!value || typeof value !== 'object') return false;
  const part = value as Part;
  return part.type === 'input_image' && typeof part.image_url === 'string' && part.image_url.startsWith('data:');
}

/** Every array of content parts in a Responses `input` (message content · function_call_output output). */
function partArrays(input: readonly unknown[]): Part[][] {
  const arrays: Part[][] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Part;
    if (Array.isArray(record.content)) arrays.push(record.content as Part[]);
    if (Array.isArray(record.output)) arrays.push(record.output as Part[]);
  }
  return arrays;
}

export interface ImageBudgetResult<T> {
  input: T[];
  kept: number;
  dropped: number;
  droppedReasons: Array<'too-large' | 'too-many'>;
}

/**
 * Apply the image budget to a Codex Responses `input`. Walks newest → oldest; an inline image over the per-image
 * ceiling, or beyond the per-request count, becomes `{type:'input_text', text:'[image too large — sent as path only]'}`.
 * Returns a new array (items holding a replaced part are shallow-copied); the caller's input is not mutated.
 */
export function enforceResponsesImageBudget<T>(
  input: readonly T[],
  limits: { maxB64Chars?: number; maxCount?: number } = {},
): ImageBudgetResult<T> {
  const maxB64Chars = limits.maxB64Chars ?? REQUEST_IMAGE_MAX_B64_CHARS;
  const maxCount = limits.maxCount ?? REQUEST_IMAGE_MAX_COUNT;
  const out = input.slice() as T[];
  const droppedReasons: Array<'too-large' | 'too-many'> = [];
  let kept = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const item = out[i];
    if (!item || typeof item !== 'object') continue;
    const record = item as unknown as Part;
    let replaced: Part | null = null;
    for (const key of ['content', 'output'] as const) {
      const parts = record[key];
      if (!Array.isArray(parts) || !parts.some(isInlineImagePart)) continue;
      const next = (parts as unknown[]).slice();
      for (let j = next.length - 1; j >= 0; j--) {
        const part = next[j];
        if (!isInlineImagePart(part)) continue;
        const payload = part.image_url.slice(part.image_url.indexOf(',') + 1).length;
        const reason = payload > maxB64Chars ? 'too-large' : kept >= maxCount ? 'too-many' : null;
        if (reason) {
          next[j] = { type: 'input_text', text: imageDroppedText() };
          droppedReasons.push(reason);
        } else {
          kept += 1;
        }
      }
      replaced = { ...(replaced ?? record), [key]: next };
    }
    if (replaced) out[i] = replaced as unknown as T;
  }
  return { input: out, kept, dropped: droppedReasons.length, droppedReasons };
}

export interface RequestPartsShape {
  /** One entry per content part, in wire order (the newest `maxParts`): `input_text:<chars>` · `input_image:<base64 chars>` · `output_text:<chars>`. */
  parts: string[];
  inputImages: number;
  inputImageChars: number;
  /** A data:image URL found inside a TEXT part — an image sent as text (the 190 k-token failure shape). */
  base64InTextParts: number;
}

/** Success-path request shape for the log: part kinds and sizes only, never content. */
export function summarizeRequestParts(input: readonly unknown[], maxParts = 40): RequestPartsShape {
  const parts: string[] = [];
  let inputImages = 0;
  let inputImageChars = 0;
  let base64InTextParts = 0;
  const visit = (part: unknown): void => {
    if (!part || typeof part !== 'object') return;
    const p = part as Part;
    const type = typeof p.type === 'string' ? p.type : 'unknown';
    if (type === 'input_image' && typeof p.image_url === 'string') {
      const chars = p.image_url.startsWith('data:') ? p.image_url.length - p.image_url.indexOf(',') - 1 : 0;
      inputImages += 1;
      inputImageChars += chars;
      parts.push(`input_image:${chars}`);
      return;
    }
    const text = typeof p.text === 'string' ? p.text : '';
    if (text && measureInlineImageChars(text).count > 0) base64InTextParts += 1;
    parts.push(`${type}:${text.length}`);
  };
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Part;
    if (typeof record.content === 'string' && measureInlineImageChars(record.content).count > 0) base64InTextParts += 1;
    if (typeof record.output === 'string' && measureInlineImageChars(record.output).count > 0) base64InTextParts += 1;
  }
  for (const array of partArrays(input)) for (const part of array) visit(part);
  return {
    parts: parts.length > maxParts ? [`…${parts.length - maxParts} earlier`, ...parts.slice(-maxParts)] : parts,
    inputImages,
    inputImageChars,
    base64InTextParts,
  };
}
