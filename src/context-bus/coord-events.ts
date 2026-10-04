import type { Database } from 'bun:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { debug, redactSecretText } from '../debug/log.js';
import { openSurfaceEventsDb, recordEvent, surfaceEventsDbPath } from '../domains/surface-events.js';

export interface CoordEventInput {
  seat: string;
  recipients: string[];
  all: boolean;
  kind: string | null;
  slot: string | null;
  deadline: string | null;
  url: string | null;
  headline: string;
  at?: string;
}

export interface CoordEvent {
  id: string;
  at: string;
  text: string;
  summary: string;
  kind: string;
  refs: Pick<CoordEventInput, 'seat' | 'recipients' | 'all' | 'kind' | 'slot' | 'deadline' | 'url'> & { origin?: string; source?: string; ref?: string | null };
}

function seatIds(): Set<string> {
  return new Set((JSON.parse(readFileSync(resolve(import.meta.dir, '../../scripts/coord-tracks.json'), 'utf8')) as
    { tracks: Array<{ id: string }> }).tracks.map((track) => track.id));
}
const kinds = new Set(['요청', '결정', '사고', '보고', '정정']);

/** Mirror the sender's ordered envelope fields; only the first line enters this parser. */
export function parseCoordHeader(seat: string, header: string): Omit<CoordEventInput, 'url' | 'at'> {
  const first = header.split(/\r?\n/, 1)[0] ?? '';
  if (!first.startsWith(`**[${seat}]**`)) throw new Error('조율 글 신원 접두 불일치');
  const headline = first.slice(`**[${seat}]**`.length)
    .replace(/^\s*(?:📌안내\s*)?\d{4}-\d\d-\d\d\s+\d\d:\d\d\s+KST\s*/, '').trim();
  const headerBody = first.slice(`**[${seat}]**`.length);
  const arrow = headerBody.indexOf('→');
  const envelope = arrow >= 0 && !headerBody.slice(0, arrow).includes(' · ') ? headerBody.slice(arrow + 1).trim() : '';
  const fields = envelope ? envelope.split(' · ') : [];
  const ids = seatIds();
  const recipients: string[] = [];
  let all = false;
  let i = 0;
  for (; i < fields.length; i++) {
    const field = fields[i]!.trim().split(' — ')[0]!;
    const tokens = field.replaceAll(',', ' ').split(/\s+/).filter(Boolean);
    if (!tokens.length || !tokens.every((t) => t === '전원' || ids.has(t))) break;
    for (const token of tokens) {
      if (token === '전원') all = true;
      else recipients.push(token);
    }
    if (fields[i]!.includes(' — ')) { i++; break; }
  }
  const candidate = fields[i]?.trim() ?? '';
  const kind = kinds.has(candidate) ? candidate : null;
  const slot = fields[i + 1]?.trim() || null;
  const deadline = fields.slice(i + 1).map((f) => f.trim()).find((f) => /^기한\s+\S/.test(f)) ?? null;
  return { seat, recipients, all, kind, slot, deadline, headline };
}

/** Atomic lookup+insert makes retries safe, including URL-less posts in the same minute. */
export function recordCoordEvent(input: CoordEventInput, deps: { db?: Database } = {}): string {
  const hasUrl = !!input.url;
  let db: Database | undefined;
  try {
    db = deps.db ?? openSurfaceEventsDb();
    const at = input.at ?? new Date().toISOString();
    const first = input.headline.split(/\r?\n/, 1)[0] ?? '';
    const withoutPrefix = first.replace(/^\*\*\[[A-Z]+\]\*\*\s*/, '')
      .replace(/^(?:📌안내\s*)?\d{4}-\d\d-\d\d\s+\d\d:\d\d\s+KST\s*/, '');
    const headline = redactSecretText(withoutPrefix).trim().slice(0, 120);
    const safe = (value: string) => redactSecretText(value.split(/\r?\n/, 1)[0] ?? '');
    const refs = { seat: safe(input.seat), recipients: input.recipients.map(safe), all: input.all,
      kind: input.kind === null ? null : safe(input.kind), slot: input.slot === null ? null : safe(input.slot),
      deadline: input.deadline === null ? null : safe(input.deadline), url: input.url ? safe(input.url) : null };
    const result = db.transaction(() => {
      const prior = (refs.url
        ? db!.prepare(`SELECT id FROM events WHERE surface='coord:channel' AND json_extract(refs,'$.url')=? LIMIT 1`).get(refs.url)
        : db!.prepare(`SELECT id FROM events WHERE surface='coord:channel' AND json_extract(refs,'$.url') IS NULL
            AND json_extract(refs,'$.seat')=? AND summary=? AND substr(ts,1,16)=? LIMIT 1`)
          .get(refs.seat, headline, at.slice(0, 16))) as { id: string } | null;
      if (prior) return { id: prior.id, dedup: true };
      return { id: recordEvent(db!, { surface: 'coord:channel', direction: 'outbound', kind: refs.kind ?? 'unknown',
        domain: 'elanous', category: 'coordination', text: headline, summary: headline,
        refs: JSON.stringify(refs), ts: at }), dedup: false };
    }).immediate();
    try { debug.log('context.coord', result.dedup ? 'dedup' : 'recorded', { seat: refs.seat, kind: refs.kind, hasUrl }); }
    catch { /* observation cannot turn a successful write into a failed send */ }
    return result.id;
  } catch (error) {
    try { debug.log('context.coord', 'failed', { seat: redactSecretText(input.seat), kind: input.kind && redactSecretText(input.kind), hasUrl }); }
    catch { /* preserve the original write error */ }
    throw error;
  } finally { if (!deps.db) db?.close(); }
}

/** Read-only chronological list; a missing store is an empty ledger, not a newly created one. */
export function listCoordEvents(opts: { since: string; seat?: string }, deps: { db?: Database } = {}): CoordEvent[] {
  if (!deps.db && !existsSync(surfaceEventsDbPath())) return [];
  const db = deps.db ?? openSurfaceEventsDb();
  try {
    const rows = db.prepare(`SELECT id, ts, text, summary, kind, refs FROM events
      WHERE surface IN ('coord:channel', 'context:external', 'context:session') AND direction='outbound' AND ts>=?
      ${opts.seat ? "AND json_extract(refs,'$.seat')=?" : ''} ORDER BY ts ASC, rowid ASC`)
      .all(...(opts.seat ? [opts.since, opts.seat] : [opts.since])) as Array<{
        id: string; ts: string; text: string; summary: string; kind: string; refs: string;
      }>;
    return rows.map((r) => ({ id: r.id, at: r.ts, text: r.text, summary: r.summary, kind: r.kind,
      refs: JSON.parse(r.refs) as CoordEvent['refs'] }));
  } finally { if (!deps.db) db.close(); }
}
