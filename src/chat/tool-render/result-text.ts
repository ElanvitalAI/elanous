// Tool-result text extraction shared by the classic dashboard renderer (dispatch.ts)
// and the next TUI chat log (src/tui/chat/log-view.ts).
//
// TUI-NEXT-TOOL-RESULT-RENDER (0.2.36): the next TUI only has the persisted tool
// result — `JSON.stringify(result)` cut at 2000 chars (session/chat.ts
// truncateForPersist) — so it showed the raw envelope on one line with escaped
// `\n`. `parseToolResultEnvelope` turns that string back into the result value;
// `toolResultBodyText` / `toolResultErrorText` are classic's own extractors, moved
// here so both surfaces read the same «human text» out of a result.
//
// Pure, no imports: safe to load from either surface.

/** The persisted suffix `truncateForPersist` appends when it cuts a value. */
const PERSIST_TRUNCATION_SUFFIX = /… \(\+\d+ chars\)$/;

/** Body text of a tool result: a string as-is, the `output` field, else pretty JSON. */
export function toolResultBodyText(result: unknown): string | null {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && typeof (result as Record<string, unknown>).output === 'string') {
    return (result as Record<string, string>).output;
  }
  if (result === null || result === undefined) return null;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/** `error` field text of a tool result, or null. */
export function toolResultErrorText(result: unknown): string | null {
  if (result && typeof result === 'object' && typeof (result as Record<string, unknown>).error === 'string') {
    return String((result as Record<string, unknown>).error);
  }
  return null;
}

export interface ParsedToolResultEnvelope {
  /** The result value (an object for JSON envelopes; the raw string otherwise). */
  value: unknown;
  /** The persisted string was cut (by `truncateForPersist`) — the body is partial. */
  truncated: boolean;
}

/**
 * Turn a persisted tool result string back into the result value.
 * - Plain text (not a JSON object) stays the same string.
 * - A whole JSON object parses normally.
 * - A cut JSON object (`{"output":"…` ⊕ «… (+N chars)») keeps what can be read: the
 *   `output` string up to the cut, decoded (real newlines), marked `truncated`.
 */
export function parseToolResultEnvelope(raw: string): ParsedToolResultEnvelope {
  const text = raw.trim();
  if (!text.startsWith('{')) return { value: raw, truncated: false };
  try {
    const value: unknown = JSON.parse(text);
    return { value, truncated: false };
  } catch { /* fall through — maybe cut by truncateForPersist */ }
  if (!PERSIST_TRUNCATION_SUFFIX.test(text)) return { value: raw, truncated: false };
  const body = text.replace(PERSIST_TRUNCATION_SUFFIX, '');
  const output = readPartialJsonStringField(body, 'output');
  if (output === null) return { value: raw, truncated: false };
  return { value: { output }, truncated: true };
}

/** Decode the string value of `"<field>":"…` from a possibly cut JSON text (to its end or the cut). */
function readPartialJsonStringField(json: string, field: string): string | null {
  const key = `"${field}":"`;
  const at = json.indexOf(key);
  if (at < 0) return null;
  let i = at + key.length;
  let literal = '';
  while (i < json.length) {
    const ch = json[i]!;
    if (ch === '"') break;
    if (ch === '\\') {
      const next = json[i + 1];
      if (next === undefined) break; // escape cut in half
      if (next === 'u') {
        const hex = json.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        literal += json.slice(i, i + 6);
        i += 6;
        continue;
      }
      literal += json.slice(i, i + 2);
      i += 2;
      continue;
    }
    literal += ch;
    i += 1;
  }
  try {
    return JSON.parse(`"${literal}"`) as string;
  } catch {
    return null;
  }
}
