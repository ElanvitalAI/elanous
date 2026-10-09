// ── Sink-level redaction (MSS M2.3) ──
//
// Last-line defence against secret material leaking into log sinks.
// `redactSecrets()` in `src/debug/log.ts` is caller-driven — every LLM
// adapter / ACP layer must remember to call it, and any missed site is
// silently unsafe. This module applies a uniform pass in `DebugLog.log`
// after record enrichment and before every sink receives the record,
// so file / ring / mirror / extra sinks all observe the masked payload.
//
// Opt-in via `MSS_REDACT_LOGS=1` (flag default false). When off, the
// log path is byte-identical to pre-M2.3 behaviour.
//
// Design invariants:
//   • Never throws. Circular references short-circuit to a sentinel.
//   • Original `rec.data` is not mutated — the pass returns a shallow
//     copy with a redacted `data` tree.
//   • Top-level `LogRecord` fields (`trace_id`, `elanous_id`, `category`,
//     etc.) are IDs, not secrets — not touched.
//   • Key matching is case-insensitive against a blocklist shared in
//     spirit with `redactSecrets()` (same names, wider coverage).

import type { LogRecord } from './record.js';

/** Key names (lowercase) considered secrets. Matched exactly against
 *  object keys after `toLowerCase()`. Extend via `RedactOpts.keyBlocklist`. */
export const REDACT_KEY_BLOCKLIST: readonly string[] = [
  'authorization',
  'api-key', 'api_key', 'apikey', 'x-api-key', 'x_api_key',
  'openai-api-key', 'openai_api_key',
  'anthropic-api-key', 'anthropic_api_key',
  'cookie', 'set-cookie',
  'access_token', 'accesstoken',
  'refresh_token', 'refreshtoken',
  'password', 'secret', 'private_key',
  // LF6 dogfood 보강(2026-07-13) — 맨몸 'token' 등이 빠져 있어 ingest 프로브의
  // {token: "…"} 가 원문 통과(실측). 카운트류 오탐 가능성보다 유출 방지 우선.
  'token', 'bot_token', 'bottoken', 'bearer',
  'passwd', 'privatekey', 'private-key', 'credentials', 'session_token',
];

export interface RedactOpts {
  /** Key blocklist override. Defaults to `REDACT_KEY_BLOCKLIST`. */
  keyBlocklist?: readonly string[];
  /** Mask function applied to flagged string values. Defaults to
   *  head/tail retention for values longer than 12 chars, `<redacted>`
   *  otherwise. */
  mask?: (value: string) => string;
}

function defaultMask(v: string): string {
  if (v.length <= 12) return '<redacted>';
  return v.slice(0, 4) + '…' + v.slice(-4);
}

function buildBlockSet(opts: RedactOpts): Set<string> {
  const src = opts.keyBlocklist ?? REDACT_KEY_BLOCKLIST;
  return new Set(src.map((k) => k.toLowerCase()));
}

function redactValue(
  v: unknown,
  keyBlock: Set<string>,
  mask: (s: string) => string,
  seen: WeakSet<object>,
): unknown {
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t !== 'object') return v;
  if (seen.has(v as object)) return '<circular>';
  seen.add(v as object);
  if (Array.isArray(v)) {
    return v.map((item) => redactValue(item, keyBlock, mask, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (keyBlock.has(k.toLowerCase())) {
      out[k] = typeof val === 'string' ? mask(val) : '<redacted>';
    } else if (val !== null && typeof val === 'object') {
      out[k] = redactValue(val, keyBlock, mask, seen);
    } else {
      out[k] = val;
    }
  }
  return out;
}

/** Return a redacted shallow copy of `rec`. When `rec.data` is absent
 *  or not an object/array, the original record is returned unchanged. */
export function redactLogRecord(rec: LogRecord, opts: RedactOpts = {}): LogRecord {
  if (rec.data === undefined || rec.data === null) return rec;
  if (typeof rec.data !== 'object') return rec;
  const keyBlock = buildBlockSet(opts);
  const mask = opts.mask ?? defaultMask;
  return { ...rec, data: redactValue(rec.data, keyBlock, mask, new WeakSet()) };
}

/** Pre-bundle knowledge-pack DLP. Reasons are fixed labels, never source text or secret values.
 * This is separate from the opt-in log masking path above. */
const KNOWLEDGE_PACK_DLP_RULES: ReadonlyArray<{ reason: string; pattern: RegExp }> = [
  { reason: 'secret-value', pattern: /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY(?: BLOCK)?-----|\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}\b|\b(?:sk-[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|(?:AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}|AIza[A-Za-z0-9_-]{35})\b|\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|private[_-]?key|token)['"]?\s*[=:]\s*['"]?[A-Za-z0-9_./+~-]{16,}/iu },
  // A key that names a password/secret makes ANY assigned value secret: short or punctuated values count too.
  // Schema flags (`"secret": true`) are not values.
  { reason: 'secret-value', pattern: /\b(?:password|passwd|pwd|passphrase|client[_-]?secret|secret)['"]?\s*[=:]\s*(?!(?:true|false|null)\b)(?:"[^"\n]+"|'[^'\n]+'|[^\s'",;{}\[\]]{4,})/iu },
  { reason: 'personal-information', pattern: /\b01[016789]-?\d{3,4}-?\d{4}\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b\d{6}-[1-8]\d{6}\b/iu },
  { reason: 'internal-identifier', pattern: /(?:사번|사내\s*식별자|내부\s*식별자|employee[_ -]?id|internal[_ -]?id)\s*(?:[:=]|\s)\s*[A-Za-z0-9][A-Za-z0-9_-]{3,}/iu },
  { reason: 'sales-confidential', pattern: /영업\s*기밀|(?:sales\s+confidential|confidential\s+sales|영업\s*비밀)/iu },
];

export function scanKnowledgePackDlp(text: string): string[] {
  const reasons = KNOWLEDGE_PACK_DLP_RULES.filter(({ pattern }) => pattern.test(text)).map(({ reason }) => reason);
  return [...new Set(reasons)];
}
