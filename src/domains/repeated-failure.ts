import type { LogStoreRow } from '../mss/logging/log-store.js';
import { redactSecretText } from '../debug/log.js';

export interface RepeatedFailureGroup {
  key: string;
  area: string;
  reason: string;
  count: number;
  events: string[];
  firstTs: string;
  lastTs: string;
}

/** Only failure-shaped events with a structured reason count; severity is deliberately ignored. */
export function failureReason(row: Pick<LogStoreRow, 'event' | 'category' | 'data'>): string | null {
  const failureSuffix = /(?:^|[.\-_])(?:error|failed|fail|close|handshake-failed)$/i;
  if (!failureSuffix.test(row.event) && !failureSuffix.test(row.category)) return null;
  if (!row.data) return null;
  try {
    const data: unknown = JSON.parse(row.data);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const fields = data as Record<string, unknown>;
    for (const field of ['reason', 'error', 'message']) {
      if (typeof fields[field] !== 'string' || !fields[field].trim()) continue;
      const reason = fields[field].trim();
      if (/(?:^|[.\-_])close$/i.test(row.event) || /(?:^|[.\-_])close$/i.test(row.category)) {
        const socketCode = /\bsocket closed:\s*(\d+)\b/i.exec(reason);
        if (/\b(?:normal closure|going away|closed by (?:user|client)|client closed|clean close)\b/i.test(reason)) return null;
        if (socketCode && (socketCode[1] === '1000' || socketCode[1] === '1001')) return null;
        // Transport errors name themselves by code, not by the word «failed» (review must-fix: ECONNRESET was dropped).
        const explicitFailure = /(?:fail(?:ed|ure)?|error|reject(?:ed|ion)?|denied|timeout|timed out|refused|unauthori[sz]ed|lost|broken|reset|abort(?:ed)?|hang ?up|\bE[A-Z]{3,}\b)/i.test(reason);
        const failureCode = socketCode && /^(?:100[236789]|101[0-4])$/.test(socketCode[1]!);
        if (field !== 'error' && !explicitFailure && !failureCode) return null;
      }
      return reason;
    }
  } catch { /* malformed log data is not evidence of a failure reason */ }
  return null;
}

export function normalizeReason(s: string): string {
  return redactSecretText(s)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '#')
    .replace(/\b[0-9a-f]{8,}\b/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function detectRepeatedFailures(
  rows: readonly LogStoreRow[],
  { threshold = 20 }: { threshold?: number } = {},
): RepeatedFailureGroup[] {
  const groups = new Map<string, RepeatedFailureGroup>();
  for (const row of rows) {
    const rawReason = failureReason(row);
    if (!rawReason) continue;
    // The same socket failure may be serialized as `Error: ...` on one call site and plain text on another.
    const reason = normalizeReason(rawReason.replace(/^Error:\s*/i, ''));
    if (!reason) continue;
    const area = row.category.split('.').slice(0, 2).join('.');
    const key = `${area}:${reason}`;
    const current = groups.get(key);
    if (current) {
      current.count++;
      if (!current.events.includes(row.event)) current.events.push(row.event);
      if (Date.parse(row.ts) < Date.parse(current.firstTs)) current.firstTs = row.ts;
      if (Date.parse(row.ts) > Date.parse(current.lastTs)) current.lastTs = row.ts;
    } else {
      groups.set(key, { key, area, reason, count: 1, events: [row.event], firstTs: row.ts, lastTs: row.ts });
    }
  }
  return [...groups.values()].filter((g) => g.count >= threshold).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function explainFailure(group: RepeatedFailureGroup): string {
  // Any web-terminal area carrying the ACP socket's auth_failed close is the same cause — measured 2026-09-28 19:20:
  // the first live tick saw it as `webterm.tabs` (list errors re-raise the socket close) and sent the generic line.
  if (group.area.startsWith('webterm.') && /^socket closed: #: auth_failed$/i.test(group.reason)) {
    // Same words as the PWA banners (🅞 #21591·#21602 · 🅕 #21599) so the alert and the screen say one thing.
    return '이 기기(브라우저)에 소유자 토큰이 없거나 틀리거나 만료돼 데몬이 연결을 거절한다 — 이미 연결된 기기의 설정 › 연결 토큰 만들기 에서 토큰을 만들어, 이 기기의 설정 › 데몬 연결 › 연결 토큰 칸(/app/settings/#bearer-token)에 붙인다';
  }
  const span = Date.parse(group.lastTs) - Date.parse(group.firstTs);
  const minutes = Number.isFinite(span) ? Math.max(1, Math.ceil(span / 60_000)) : 10;
  const age = Date.now() - Date.parse(group.firstTs);
  const sinceMinutes = Number.isFinite(age) ? Math.max(1, Math.ceil(age / 60_000)) : 10;
  return `${group.area} 가 ${minutes}분에 ${group.count}번 같은 사유로 실패: ${group.reason} — \`elanous logs --category ${group.area} --since ${sinceMinutes}m\` 로 본다`;
}
