// DEMO-1121-WEBCHAT-ATTACH — browser-side note attachments for the bare webchat origin.
//
// The bare relay forwards only the chat pair (POST /v1/prompt/stream, GET /v1/chat/events),
// so /v1/attachments (upload + ?extract=text) is unreachable there. Text notes are therefore
// read in the browser, secret-masked, and inlined in the prompt body. Nothing is uploaded.
//
// Fail-closed: oversize / unsupported / binary files are refused with a notice; they are never
// truncated and sent. Masking runs before the text is stored, so no later path (chips, debug
// logs, prompt body) ever sees the raw secret.

import type { AttachmentMeta } from './upload-attachment';

export const LOCAL_NOTE_MAX_BYTES = 100 * 1024;
export const LOCAL_NOTE_TOTAL_MAX_BYTES = 300 * 1024;
export const LOCAL_NOTE_EXT = /\.(txt|md|docx)$/i;
export const LOCAL_NOTE_LIMIT_NOTICE = 'txt·md·docx 알려진 형식만 · 파일당 100KB · 합계 300KB까지';
export const DOCX_MAX_INPUT_BYTES = 2 * 1024 * 1024;
export const DOCX_MAX_XML_BYTES = 5 * 1024 * 1024;
const MASK = '[가림]';

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b\d{6}-[1-4]\d{6}\b/g,
];
// key = value / key: value — keep the key so the note still reads, drop the value.
const KEY_VALUE = /((?:api[_-]?key|secret|token|passw(?:or)?d|pwd|access[_-]?key|비밀번호|암호|시크릿|토큰)[\w-]*\s*[:=]\s*)(["']?)[^\s"',;]{4,}\2/gi;

/** Idempotent: masking masked text is a no-op. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, MASK);
  return out.replace(KEY_VALUE, (_m, key: string) => `${key}${MASK}`);
}

const u16 = (v: DataView, o: number): number => v.getUint16(o, true);
const u32 = (v: DataView, o: number): number => v.getUint32(o, true);

async function inflateRaw(data: Uint8Array, maxOut: number): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxOut) { await reader.cancel(); throw new Error('too-large'); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return XML_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Text of <w:t> runs; </w:p> -> newline, <w:tab/> -> tab. */
export function docxXmlToText(xml: string): string {
  const out: string[] = [];
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<\/w:p>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[1] !== undefined) out.push(decodeXml(m[1]));
    else out.push(m[0] === '</w:p>' ? '\n' : '\t');
  }
  return out.join('').trim();
}

/** Minimal ZIP reader: returns word/document.xml text. Throws on corrupt/oversize/unsupported. */
export async function readDocxText(buf: ArrayBuffer): Promise<string> {
  if (buf.byteLength > DOCX_MAX_INPUT_BYTES) throw new Error('input-too-large');
  const bytes = new Uint8Array(buf);
  const v = new DataView(buf);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (u32(v, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no-eocd');
  const count = u16(v, eocd + 10);
  let p = u32(v, eocd + 16);
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || u32(v, p) !== 0x02014b50) throw new Error('bad-central');
    const method = u16(v, p + 10);
    const csize = u32(v, p + 20);
    const usize = u32(v, p + 24);
    const nameLen = u16(v, p + 28);
    const extraLen = u16(v, p + 30);
    const commentLen = u16(v, p + 32);
    const local = u32(v, p + 42);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== 'word/document.xml') continue;
    if (usize > DOCX_MAX_XML_BYTES) throw new Error('xml-too-large');
    if (local + 30 > bytes.length || u32(v, local) !== 0x04034b50) throw new Error('bad-local');
    const start = local + 30 + u16(v, local + 26) + u16(v, local + 28);
    if (start + csize > bytes.length) throw new Error('truncated');
    const data = bytes.subarray(start, start + csize);
    let xml: Uint8Array;
    if (method === 0) xml = data;
    else if (method === 8) xml = await inflateRaw(data, DOCX_MAX_XML_BYTES);
    else throw new Error('unsupported-method');
    if (xml.length > DOCX_MAX_XML_BYTES) throw new Error('xml-too-large');
    return docxXmlToText(new TextDecoder().decode(xml));
  }
  throw new Error('no-document-xml');
}

export type LocalNote = { meta: AttachmentMeta; text: string };
export type LocalNoteIngest = { accepted: LocalNote[]; refused: { filename: string; reason: string }[] };

let seq = 0;

/** Read, vet and mask picked/dropped files. `usedBytes` = bytes already queued as local notes. */
export async function ingestLocalNotes(files: readonly File[], usedBytes = 0): Promise<LocalNoteIngest> {
  const result: LocalNoteIngest = { accepted: [], refused: [] };
  let used = usedBytes;
  for (const file of files) {
    const refuse = (reason: string): void => { result.refused.push({ filename: file.name, reason }); };
    if (!LOCAL_NOTE_EXT.test(file.name)) {
      refuse(/\.pdf$/i.test(file.name) ? 'pdf는 지원하지 않습니다 (txt·md·docx만)' : 'txt·md·docx 알려진 형식만 첨부할 수 있습니다');
    } else if (/\.docx$/i.test(file.name)) {
      if (file.size > DOCX_MAX_INPUT_BYTES) { refuse('docx 원본은 최대 2MB입니다'); continue; }
      let text: string;
      try { text = await readDocxText(await file.arrayBuffer()); } catch (e) {
        refuse(e instanceof Error && /too-large/.test(e.message) ? 'docx 내용이 너무 큽니다' : 'docx를 읽지 못했습니다 (손상되었거나 지원하지 않는 형식)');
        continue;
      }
      const size = new TextEncoder().encode(text).length;
      if (size > LOCAL_NOTE_MAX_BYTES) { refuse('파일당 최대 100KB입니다'); continue; }
      if (used + size > LOCAL_NOTE_TOTAL_MAX_BYTES) { refuse('첨부 합계 300KB를 넘습니다'); continue; }
      used += size;
      seq += 1;
      result.accepted.push({
        text: maskSecrets(text),
        meta: { id: `local-${Date.now().toString(36)}-${seq}`, filename: file.name, mediaType: 'text/plain', size, downloadUrl: '' },
      });
    } else if (file.size > LOCAL_NOTE_MAX_BYTES) {
      refuse('파일당 최대 100KB입니다');
    } else if (used + file.size > LOCAL_NOTE_TOTAL_MAX_BYTES) {
      refuse('첨부 합계 300KB를 넘습니다');
    } else {
      let raw: string;
      try { raw = await file.text(); } catch { refuse('파일을 읽지 못했습니다'); continue; }
      if (raw.includes('\u0000')) { refuse('텍스트 파일이 아닙니다'); continue; }
      used += file.size;
      seq += 1;
      result.accepted.push({
        text: maskSecrets(raw),
        meta: { id: `local-${Date.now().toString(36)}-${seq}`, filename: file.name, mediaType: 'text/plain', size: file.size, downloadUrl: '' },
      });
    }
  }
  return result;
}

export const isLocalNoteId = (id: string): boolean => id.startsWith('local-');

/** Prompt block for one local note; masks again so a store bug cannot leak. */
export function formatLocalNote(filename: string, text: string): string {
  return `[강의 노트: ${filename}]\n${maskSecrets(text)}`;
}

/** The single place the outgoing turn text is assembled (notes, then path lines, then user text). */
export function composeTurnText(parts: { notes: readonly string[]; attachLines: readonly string[]; text: string }): string {
  return [...parts.notes, ...parts.attachLines, parts.text].filter(Boolean).join('\n\n');
}
