// ELN-AGENT-EVENT-PROTOCOL — the els side of the eln → els wire: encode / decode / validate one event frame.
// The schema itself lives in the neutral src/agent-events/protocol.ts (eln emits it without importing els; els reads it
// here). Names and bounded text only: a frame whose text looks like a secret is refused, not forwarded.
import { parseEventFrame, type AgentEventFrame, type ParsedFrame } from '../agent-events/protocol.js';

// 출처: #115920 — «이름만, 비밀 없음»: 흔한 토큰 꼴(접두 키·Bearer·긴 hex/base64 덩어리).
const SECRET_SHAPE = /\b(sk|pk|ghp|gho|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}|\bBearer\s+\S{8,}|\b[A-Fa-f0-9]{40,}\b|\b[A-Za-z0-9+/_-]{48,}={0,2}/;

export const looksSecret = (text: string): boolean => SECRET_SHAPE.test(text);

/** One JSON line (no trailing newline). */
export const encodeEventFrame = (frame: AgentEventFrame): string => JSON.stringify(frame);

/** Decode + validate one line. Never throws; bad JSON, bad shape and secret-shaped text are `ok:false`. */
export function decodeEventLine(line: string): ParsedFrame {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return { ok: false, ignore: false, reason: 'not json' }; }
  const parsed = parseEventFrame(raw);
  if (!parsed.ok) return parsed;
  const e = parsed.frame.event;
  const free = e.kind === 'state' ? e.message : e.kind === 'notice' ? e.text : e.kind === 'meta' ? e.title : undefined;
  const detail = e.kind === 'state' ? e.detail : undefined;
  if ((free !== undefined && looksSecret(free)) || (detail !== undefined && looksSecret(detail))) return { ok: false, ignore: false, reason: 'secret-shaped text' };
  return parsed;
}
