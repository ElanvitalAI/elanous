// P-3 §6.9 (2026-05-07) — composer attachment → ACP ContentBlock[]
// converter.
//
// Bridges the PWA composer's `pendingAttachments[]` (uploaded via
// `/v1/attachments`) into the daemon's `userContent` wire field added
// in P4-spec. Q1=B convention: the user-typed text comes first, then
// each attachment as its own block in the order the user attached them.
//
// Image attachments fetch their bytes from `attachment.downloadUrl`,
// base64-encode, and emit `{type:'image', mimeType, data}` matching ACP
// SDK's `ImageContent` shape. Non-image attachments stay as
// `resource_link` so the agent can choose to read them via fs tools
// (existing `[attached] <path>` flow keeps the on-disk path visible
// for legacy renderers; this module is the multi-part replacement).

import type { AttachmentMeta } from './upload-attachment';
import type { PromptUserContentBlock } from './daemon-client';

/** True for image attachments — the only shape the LLM stack treats
 *  as inline binary data on the userMessage axis (ACP `ImageContent`). */
export function isImageAttachment(meta: AttachmentMeta): boolean {
  return typeof meta.mediaType === 'string'
    && meta.mediaType.toLowerCase().startsWith('image/');
}

/** Lecture notes are extracted and redacted by the authenticated daemon. */
export function isLectureNoteAttachment(meta: AttachmentMeta): boolean {
  return /\.(txt|md|pdf|docx)$/i.test(meta.filename);
}

export async function fetchLectureNote(
  meta: AttachmentMeta,
  opts: { baseUrl: string; token?: string },
): Promise<{ text: string; truncated: boolean }> {
  if (!/^att-[a-z0-9]+-[a-z0-9]+$/.test(meta.id)) throw new Error('invalid attachment');
  const url = `${opts.baseUrl.replace(/\/$/, '')}/v1/attachments/${meta.id}?extract=text`;
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error('attachment extraction failed');
  const data = await response.json();
  if (typeof data.text !== 'string' || typeof data.truncated !== 'boolean') throw new Error('invalid extraction response');
  return data;
}

/** Fetch an attachment's bytes, base64-encode, and return the
 *  data string. Throws on transport / encoding failures so the
 *  caller can fall back to the legacy text-only path. */
export async function fetchAttachmentAsBase64(
  meta: AttachmentMeta,
  opts: { baseUrl: string; token?: string },
): Promise<string> {
  const url = meta.downloadUrl.startsWith('http')
    ? meta.downloadUrl
    : `${opts.baseUrl.replace(/\/$/, '')}${meta.downloadUrl}`;
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`fetch attachment ${meta.id} failed: ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  return arrayBufferToBase64(buf);
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  // Chunk to keep `String.fromCharCode(...)` argument list small —
  // a 30 MB image would otherwise blow the call stack.
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Build the daemon-bound `userContent` ContentBlock[] for the active
 *  turn. Q1=B order: text first, then each attachment block.
 *
 *  Image attachments turn into `{type:'image', mimeType, data}` with
 *  base64 bytes fetched from the daemon. Non-image attachments emit
 *  `{type:'resource_link', uri, mimeType, name}` so the agent can read
 *  via fs tools while the block survives the wire round-trip.
 *
 *  Returns `null` when there are no attachments (caller can skip the
 *  multi-part path and use `userText` only). When at least one image
 *  fetch fails, that image is replaced by a `text` block describing the
 *  error so the turn doesn't get blocked entirely. */
export async function buildPromptUserContentFromAttachments(
  text: string,
  attachments: readonly AttachmentMeta[],
  opts: { baseUrl: string; token?: string },
): Promise<PromptUserContentBlock[] | null> {
  if (attachments.length === 0) return null;
  const blocks: PromptUserContentBlock[] = [];
  // Q1=B — text first.
  if (text.length > 0) {
    blocks.push({ type: 'text', text });
  }
  for (const att of attachments) {
    if (isImageAttachment(att)) {
      try {
        const data = await fetchAttachmentAsBase64(att, opts);
        blocks.push({
          type: 'image',
          mimeType: att.mediaType,
          data,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        blocks.push({
          type: 'text',
          text: `[image fetch failed: ${att.filename} — ${msg}]`,
        });
      }
    } else {
      // Non-image attachment — emit a resource_link so the agent can
      // discover + read via fs tools, but keep the wire shape valid.
      blocks.push({
        type: 'resource_link',
        uri: att.path
          ? `file://${att.path}`
          : att.downloadUrl,
        mimeType: att.mediaType,
        name: att.filename,
      });
    }
  }
  return blocks;
}

/** Conservative composer-side vision capability heuristic. Composer
 *  Q3=B uses this to decide whether to emit a "vision not supported"
 *  toast. The daemon's wire layer (P4-anthropic / codex / gemini /
 *  openai / local) is the authoritative gate — this is purely UX
 *  pre-flight so users get an early signal instead of seeing the LLM
 *  describe a "[image: model not vision-capable]" placeholder.
 *
 *  Returns `true` when the composer can't determine non-vision
 *  (default-permissive — better to show no toast than a false alarm).
 *  Mirrors the brand allowlist from `src/llm-vision-capability.ts`
 *  but stays string-pattern-only since PWA can't import the cross-
 *  package module. */
export function isProviderUserMessageVisionCapable(provider: string | undefined): boolean {
  if (!provider) return true; // unknown — defer to daemon-side gate
  const p = provider.toLowerCase();
  if (p === 'auto') return true;
  if (p.startsWith('anthropic') || p === 'anthropic') return true;
  if (p.startsWith('codex') || p === 'openai-codex') return true;
  if (p.startsWith('openai') || p === 'openai') return true;
  if (p.startsWith('gemini') || p === 'gemini') return true;
  if (p.startsWith('grok') || p === 'grok') return true;
  // local-llm:<host>:<model> — model id determines vision capability,
  // which we can't probe from PWA. Default-permissive; daemon strips
  // images and emits the text placeholder when the local model is
  // text-only (qwen-coder · llama · phi).
  if (p.startsWith('local')) return true;
  return false;
}
