import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SourceFileRawReceipt { readonly path: string; readonly sha256: string }

/** Store the untouched provider reply before normalization. The graph ledger
 * carries this private path and digest, never source bytes. */
export function writeSourceFileRaw(root: string, runId: string, text: string): SourceFileRawReceipt {
  if (!/^[A-Za-z0-9-]{1,128}$/u.test(runId) || Buffer.byteLength(text) > 512 * 1024) throw new Error('BUILD_MODEL_RAW_INVALID');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(root);
  const directory = lstatSync(canonical);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077
    || process.getuid && directory.uid !== process.getuid()) throw new Error('BUILD_MODEL_RAW_INVALID');
  const path = join(canonical, `${runId}-${randomUUID()}.raw`);
  writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.mode & 0o077
    || process.getuid && file.uid !== process.getuid()) throw new Error('BUILD_MODEL_RAW_INVALID');
  return { path, sha256: createHash('sha256').update(text).digest('hex') };
}

/** Strict per-file response contract. The requested path is fixed by the plan. */
export function sourceFileResponseFormat(path: string): {
  type: 'json_schema'; json_schema: { name: string; strict: true; schema: Record<string, unknown> } } {
  return { type: 'json_schema', json_schema: { name: 'source_file', strict: true, schema: {
    type: 'object', properties: { path: { type: 'string', enum: [path] }, content: { type: 'string' } },
    required: ['path', 'content'], additionalProperties: false,
  } } };
}

/** Accept a JSON object even when a model wraps it in a fence or leaves literal
 * control characters in its content string. Keep the original text on failure so
 * the bounded file-generation validator can reject it without inventing bytes. */
export function normalizeSourceFileJson(text: string, expectedPath: string): string {
  let candidate = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/iu.exec(candidate);
  if (fence) candidate = fence[1]!.trim();
  let quoted = false;
  let escaped = false;
  let normalized = '';
  for (const char of candidate) {
    if (escaped) { normalized += char; escaped = false; continue; }
    if (char === '\\') { normalized += char; escaped = true; continue; }
    if (char === '"') { normalized += char; quoted = !quoted; continue; }
    if (quoted && char === '\n') { normalized += '\\n'; continue; }
    if (quoted && char === '\r') { normalized += '\\r'; continue; }
    if (quoted && char === '\t') { normalized += '\\t'; continue; }
    normalized += char;
  }
  try {
    const parsed: unknown = JSON.parse(normalized);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return text;
    const row = parsed as Record<string, unknown>;
    if (Object.keys(row).sort().join(',') !== 'content,path' || row.path !== expectedPath || typeof row.content !== 'string') return text;
    return JSON.stringify(row);
  } catch { return text; }
}
