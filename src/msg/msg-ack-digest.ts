// ── MSG-FILTERS-RELAX · bulk-ack digest ───────────────────────────────────────────────────────────────────────────
// A bulk ack (`eln msg ack --receipted` / `--through`, MsgAck `ids[]` / `receipted`) used to clear hundreds of mails with
// nothing left behind (11-23: 383 mails for OP). Before the set disappears from the unread view, it is compressed into a
// short digest — sender × class × receipt outcome counts, only the lines that carry meaning — printed, and saved as ONE
// seat memory entry, so the seat keeps the meaning of what it acked instead of the raw mail.
//
// Pure: the caller passes the messages and their outcomes; saving is an injected port (default = the `eln memory add`
// store, loaded lazily so the hot `msg` path does not load the memory module).
import type { Message } from './msg-store.js';

export const ACK_DIGEST_MAX_LINES = 20;

export type AckDigestCategory = 'decision' | 'alert' | 'request' | 'info';

export interface AckDigestInput {
  message: Pick<Message, 'id' | 'from' | 'body' | 'kind' | 'intent'>;
  /** Latest terminal receipt for the acking seat (accepted · rejected · done · expired), or undefined. */
  outcome?: string;
}

export interface AckDigest {
  seat: string;
  total: number;
  /** Meaningful grouped lines (cap {@link ACK_DIGEST_MAX_LINES}). */
  lines: string[];
  /** One-line summary (memory description). */
  summary: string;
  routineDropped: number;
  duplicatesDropped: number;
}

const ALERT_KINDS = new Set(['alert', 'incident', 'red', 'p0']);
const DECISION_KINDS = new Set(['decision']);
const REQUEST_KINDS = new Set(['request', 'question', 'ask']);

function categoryOf(message: AckDigestInput['message']): AckDigestCategory {
  const kind = (message.kind ?? '').toLowerCase();
  if (message.intent === 'alert' || ALERT_KINDS.has(kind)) return 'alert';
  if (message.intent === 'decision' || DECISION_KINDS.has(kind)) return 'decision';
  if (message.intent === 'request' || REQUEST_KINDS.has(kind)) return 'request';
  return 'info';
}

/** «[승인 요청 · SEAT] Bash · 이유 <reason>» approval mail → its command class; other requests → the first word of the body. */
function requestClass(body: string): string {
  const approval = /^\[승인 요청[^\]]*\]\s*(\S+)\s*·\s*이유\s+([^\n]+)/u.exec(body);
  if (approval) return `approval ${approval[1]}: ${approval[2]!.trim().slice(0, 60)}`;
  const head = /^\s*(\[[^\]\n]{1,40}\]|\S{1,40})/u.exec(body);
  return head ? head[1]! : 'request';
}

/** References an info line must name to be kept: a PR/mail #number, a cell id, a host, an incident word. */
const INFO_REF = /#\d{2,}|\b[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+\b|\b(?:mshq|node-b|minim5|node-c|mbp|gcp\d|aws\d)\b|incident|사고|장애|🔴|🚨/gu;

function infoRefs(body: string): string[] {
  return [...new Set(body.match(INFO_REF) ?? [])];
}

/** Build the digest. Duplicates (same sender ⊕ body) count once; routine info (no reference) is dropped. */
export function buildAckDigest(seat: string, inputs: readonly AckDigestInput[]): AckDigest {
  const seen = new Set<string>();
  const groups = new Map<string, { count: number; ids: number[]; refs: Set<string>; rank: number }>();
  let routineDropped = 0;
  let duplicatesDropped = 0;
  const rankOf: Record<AckDigestCategory, number> = { decision: 0, alert: 1, request: 2, info: 3 };
  for (const { message, outcome } of [...inputs].sort((a, b) => a.message.id - b.message.id)) {
    const dedupeKey = `${message.from}\u0000${message.body.trim()}`;
    if (seen.has(dedupeKey)) { duplicatesDropped += 1; continue; }
    seen.add(dedupeKey);
    const category = categoryOf(message);
    const result = outcome ?? 'acked';
    let key: string;
    let refs: string[] = [];
    if (category === 'request') key = `${message.from} · request [${requestClass(message.body)}] → ${result}`;
    else if (category === 'info') {
      refs = infoRefs(message.body);
      if (refs.length === 0) { routineDropped += 1; continue; }
      key = `${message.from} · info → ${result}`;
    } else key = `${message.from} · ${category} → ${result}`;
    const group = groups.get(key) ?? { count: 0, ids: [], refs: new Set<string>(), rank: rankOf[category] };
    group.count += 1;
    group.ids.push(message.id);
    for (const ref of refs) group.refs.add(ref);
    groups.set(key, group);
  }
  const ordered = [...groups.entries()].sort((a, b) => a[1].rank - b[1].rank || b[1].count - a[1].count || a[1].ids[0]! - b[1].ids[0]!);
  const render = ([key, group]: [string, { count: number; ids: number[]; refs: Set<string> }]): string => {
    const ids = group.ids.slice(0, 3).map(id => `#${id}`).join(' ') + (group.ids.length > 3 ? ' …' : '');
    const refs = group.refs.size === 0 ? '' : ` · ${[...group.refs].slice(0, 5).join(' ')}`;
    return `- ${group.count}× ${key} (${ids})${refs}`;
  };
  const lines = ordered.length <= ACK_DIGEST_MAX_LINES
    ? ordered.map(render)
    : [...ordered.slice(0, ACK_DIGEST_MAX_LINES - 1).map(render), `- +${ordered.length - (ACK_DIGEST_MAX_LINES - 1)} more groups`];
  const count = (category: AckDigestCategory) => inputs.filter(input => categoryOf(input.message) === category).length;
  const summary = `${seat} acked ${inputs.length} mails: ${count('decision')} decisions · ${count('alert')} alerts · ${count('request')} requests · `
    + `${count('info')} info (${routineDropped} routine · ${duplicatesDropped} duplicate dropped)`;
  return { seat, total: inputs.length, lines, summary, routineDropped, duplicatesDropped };
}

export interface AckDigestMemory { type: 'project'; name: string; description: string; body: string }

/** `mail-digest-<seat>-<YYYYMMDD-HHMM>` in local time. */
export function ackDigestMemoryName(seat: string, now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `mail-digest-${seat.replace(/[^A-Za-z0-9_-]+/g, '-')}-${stamp}`;
}

export function ackDigestMemory(digest: AckDigest, now: Date): AckDigestMemory {
  return { type: 'project', name: ackDigestMemoryName(digest.seat, now), description: digest.summary,
    body: [digest.summary, ...digest.lines].join('\n') };
}

/** Default saver — the same global store `eln memory add` writes. Loaded lazily (keeps `msg` startup light). */
export async function saveAckDigestMemory(entry: AckDigestMemory, seat: string): Promise<void> {
  const { saveMemory, memoryRoot } = await import('../memory.js');
  saveMemory(entry, memoryRoot(), { origin: 'msg-ack-digest', seat });
}

export interface AckDigestPorts {
  save?: (entry: AckDigestMemory, seat: string) => Promise<void> | void;
  now?: () => Date;
  warn?: (line: string) => void;
}

/**
 * Build, then save one memory entry — only when at least one meaningful line survived (a routine-only batch leaves the
 * printed summary, not a memory). A save failure is a warning — the ack itself never fails over it.
 */
export async function recordAckDigest(seat: string, inputs: readonly AckDigestInput[], ports: AckDigestPorts = {}): Promise<{ digest: AckDigest; memory: AckDigestMemory; saved: boolean } | null> {
  if (inputs.length < 2) return null;
  const digest = buildAckDigest(seat, inputs);
  const memory = ackDigestMemory(digest, (ports.now ?? (() => new Date()))());
  if (digest.lines.length === 0) return { digest, memory, saved: false };
  try { await (ports.save ?? saveAckDigestMemory)(memory, seat); return { digest, memory, saved: true }; }
  catch (error) {
    ports.warn?.(`msg ack: digest memory not saved: ${error instanceof Error ? error.message : String(error)}`);
    return { digest, memory, saved: false };
  }
}

const TERMINAL_ORDER = ['expired', 'accepted', 'rejected', 'done'];

/** Digest inputs for acked ids, read from the ledger (message ⊕ the seat's latest terminal receipt). Missing ids are skipped. */
export function ackDigestInputs(store: {
  getMessage(id: number): Message | null;
  listReceipts(query: { messageId: number }): Array<{ recipient: string; state: string }>;
}, seat: string, ids: readonly number[]): AckDigestInput[] {
  const inputs: AckDigestInput[] = [];
  for (const id of ids) {
    const message = store.getMessage(id);
    if (message === null) continue;
    let outcome: string | undefined;
    try {
      const states = store.listReceipts({ messageId: id }).filter(r => r.recipient === seat).map(r => r.state);
      outcome = [...TERMINAL_ORDER].reverse().find(state => states.includes(state));
    } catch { /* receipts are optional context */ }
    inputs.push({ message, ...(outcome === undefined ? {} : { outcome }) });
  }
  return inputs;
}
