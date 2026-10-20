// ── File extractors ──
//
// Each extractor returns plain text suitable for inlining into a user
// message. Outputs are capped at MAX_EXTRACT_BYTES (20KB) to keep
// prompts bounded.
//
// pdf-parse v2.x: class-based API (`new PDFParse({ data }).getText()`),
// not the v1 default-function export. Verified at Phase 0 smoke test.

import { readFile } from 'fs/promises';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

import type { Attachment, ContextRegistry } from './context';
import { loadImageAsAttachment } from './image/utils';

/** Hard cap on extracted text size. Decision: 20KB (PLAN §7 #2). */
export const MAX_EXTRACT_BYTES = 20 * 1024;

/** XLSX per-sheet row cap. Decision: 100 rows across every sheet (PLAN §7 #3). */
export const XLSX_MAX_ROWS_PER_SHEET = 100;

export interface ExtractResult {
  text: string;
  extractedBytes: number;    // byte length of the returned `text`
  truncated: boolean;        // true if the source exceeded MAX_EXTRACT_BYTES
  meta?: Record<string, unknown>; // extractor-specific (pages, sheets, …)
}

/**
 * Cut `buf` to at most `maxBytes`, walking back over any UTF-8 continuation
 * bytes so the result ends on a complete codepoint boundary (no U+FFFD
 * from a mid-sequence split).
 */
function safeUtf8Cut(buf: Buffer, maxBytes: number): Buffer {
  if (buf.length <= maxBytes) return buf;
  let end = maxBytes;
  // 0x80..0xBF = 10xxxxxx = continuation. Back up until we land on a lead byte.
  while (end > 0 && (buf[end]! & 0xC0) === 0x80) end--;
  return buf.subarray(0, end);
}

/**
 * Trim `text` to MAX_EXTRACT_BYTES (UTF-8 byte-accurate) and append a
 * truncation marker. Safe against splitting multi-byte codepoints.
 */
function finalize(text: string, meta?: Record<string, unknown>): ExtractResult {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= MAX_EXTRACT_BYTES) {
    return { text, extractedBytes: buf.length, truncated: false, meta };
  }
  const head = safeUtf8Cut(buf, MAX_EXTRACT_BYTES).toString('utf-8');
  const trailer = `\n\n...(truncated at ${MAX_EXTRACT_BYTES} bytes, original ${buf.length} bytes)`;
  const out = head + trailer;
  return {
    text: out,
    extractedBytes: Buffer.byteLength(out, 'utf-8'),
    truncated: true,
    meta,
  };
}

/** Plain-text read (UTF-8). Used for both `text` and `md` attachment kinds. */
export async function readText(path: string): Promise<ExtractResult> {
  const raw = await readFile(path, 'utf-8');
  return finalize(raw);
}

export async function extractPdf(path: string): Promise<ExtractResult> {
  const buf = await readFile(path);
  // pdf-parse loads pdfjs-dist and @napi-rs/canvas (system fonts) at import time.
  // A plain text/CLI help request must not pay for the PDF renderer.
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    return finalize(result.text, { pages: result.total });
  } finally {
    await parser.destroy().catch(() => { /* best-effort cleanup */ });
  }
}

export async function extractDocx(path: string): Promise<ExtractResult> {
  const result = await mammoth.extractRawText({ path });
  return finalize(result.value, { mammothMessages: result.messages.length });
}

/**
 * Extract every sheet as CSV, capped at XLSX_MAX_ROWS_PER_SHEET rows each.
 * Sheets are joined with a `# Sheet: <name>` header for LLM legibility.
 */
export async function extractXlsx(path: string): Promise<ExtractResult> {
  const wb = XLSX.readFile(path);
  const parts: string[] = [];

  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet || !sheet['!ref']) continue;

    const range = XLSX.utils.decode_range(sheet['!ref']);
    const totalRows = range.e.r - range.s.r + 1;
    const endRow = Math.min(range.s.r + XLSX_MAX_ROWS_PER_SHEET - 1, range.e.r);

    // `sheet_to_csv` honors the sheet's own `!ref` but ignores a
    // row-range option on the opts object. Copy the sheet with a
    // narrowed ref so the conversion sees only the rows we want.
    const clippedSheet = {
      ...sheet,
      '!ref': XLSX.utils.encode_range({ s: range.s, e: { r: endRow, c: range.e.c } }),
    };
    const csv = XLSX.utils.sheet_to_csv(clippedSheet);
    const note = totalRows > XLSX_MAX_ROWS_PER_SHEET
      ? ` (first ${XLSX_MAX_ROWS_PER_SHEET} of ${totalRows} rows)`
      : '';

    parts.push(`# Sheet: ${name}${note}`);
    parts.push(csv.trimEnd());
  }

  return finalize(parts.join('\n\n'), { sheets: wb.SheetNames.length });
}

// ── Attachment loader ─────────────────────────────────────
//
// Bridges the context registry to the extractors. Mutates the Attachment
// in place so callers holding references still see `loaded=true` and
// `.text` populated after the promise resolves.

/**
 * Extract (text-kinds) or resize+base64-encode (image) for `att`. Idempotent —
 * already-loaded attachments short-circuit.
 *
 * Image failures are non-fatal: the attachment stays `loaded=false` and a
 * warning is logged, so the caller can choose to drop it from the prompt
 * rather than aborting the whole submit.
 */
export async function loadAttachment(att: Attachment): Promise<Attachment> {
  if (att.loaded) return att;

  if (att.kind === 'image') {
    try {
      const img = await loadImageAsAttachment(att.sourcePath);
      att.base64 = img.base64;
      att.mediaType = img.mediaType;
      att.dimensions = img.dimensions;
      att.loaded = true;
    } catch (err) {
      // Graceful degrade (PLAN §6 Phase 10): instead of dropping the image
      // silently, mark the attachment loaded with a text placeholder so the
      // model at least sees "this file exists here but couldn't be loaded".
      // The placeholder flows through `buildMessagesWithContext`'s text path
      // since kind stays 'image' but base64 is absent.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[attachment] image load failed for ${att.filename}: ${msg}`);
      att.text = `[Image #${att.id}: unable to load — ${msg}. Source: ${att.sourcePath}]`;
      att.extractedBytes = Buffer.byteLength(att.text, 'utf-8');
      att.loaded = true;
    }
    return att;
  }

  let res;
  switch (att.kind) {
    case 'text':
    case 'md':   res = await readText(att.sourcePath);   break;
    case 'pdf':  res = await extractPdf(att.sourcePath); break;
    case 'docx': res = await extractDocx(att.sourcePath); break;
    case 'xlsx': res = await extractXlsx(att.sourcePath); break;
  }

  att.text = res.text;
  att.extractedBytes = res.extractedBytes;
  att.loaded = true;
  return att;
}

/**
 * Materialize every unloaded attachment in `reg` concurrently. Errors in
 * individual extractors are surfaced via `Promise.all` rejection — callers
 * should wrap in try/catch if partial-failure tolerance is needed.
 */
export async function loadAllAttachments(reg: ContextRegistry): Promise<void> {
  const pending = [...reg.attachments.values()].filter(a => !a.loaded);
  await Promise.all(pending.map(loadAttachment));
}
