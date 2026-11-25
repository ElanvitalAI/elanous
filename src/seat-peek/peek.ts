// ELS-PEEK-WATCH — lives outside src/els on purpose (the els↔eln import boundary): it reads the eln session store and
// the mail store, which src/els must not import. (CEO 11-25 18:4x «seats observe each other's panes — history several pages at once AND a watch-like
// live stream; a CLI, not a shell script»). The pure half of `els peek` / `els watch`: which pane a seat name means,
// which eln session that pane is running (from the process tree + the PTY manifest the eln TUI writes for itself —
// never guessed from logs), the last N turns of that session, the screen tail, the new-line diff of two screens and the
// recent mail window. Everything here is read-only and takes its inputs as data, so the fixtures in peek.test.ts drive
// it without an els server, a session store or a mail database.

import type { SerializedMessage } from '../session/index.js';

// ── text hygiene ────────────────────────────────────────────────────────────────────────────────────────────────────

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// C0/C1 controls except tab and newline; DEL.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g;

/** Bytes → text that is always valid UTF-16: invalid UTF-8 becomes U+FFFD (never a throw, never a split code point). */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** One printable line: escapes and control bytes removed, lone surrogates replaced, tabs as spaces. */
export function sanitizeLine(text: string): string {
  let out = text.replace(ANSI, '').replace(/\t/g, '  ').replace(CONTROL, '');
  // Lone surrogates (a string cut in the middle of a pair somewhere upstream) → U+FFFD.
  out = out.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');
  return out.replace(/\s+$/, '');
}

/** Clip to `max` code points (a surrogate pair is never cut) and mark the cut with «…». */
export function clip(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, Math.max(0, max - 1)).join('')}…`;
}

const oneLine = (text: string): string => sanitizeLine(text.replace(/\s+/g, ' ').trim());

// ── which pane ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The fields of an `els ls` pane row this file reads. */
export interface PeekPaneRow {
  readonly pane: string;
  readonly address: string;
  readonly title?: string;
  readonly seat?: string;
  readonly workspace?: string;
  readonly tab?: string;
  readonly state?: string;
  readonly activityState?: string;
  readonly kind?: string;
  readonly reach?: string;
  readonly host?: string;
  readonly pid?: number;
  readonly fgCommand?: readonly string[];
  readonly model?: string;
  readonly status?: { readonly state?: string; readonly reason?: string; readonly since?: string };
}

export type PaneMatch = { readonly ok: true; readonly row: PeekPaneRow; readonly note?: string } | { readonly ok: false; readonly message: string };

/** A seat title (OP, TC-H-CX-2), a pane id, `ws/tab/pane` or `host:ws/tab/pane` → one pane row. A live pane wins over an
 *  exited one with the same title; two live panes with one title is reported (the first is used, the rest are named). */
export function resolvePane(rows: readonly PeekPaneRow[], ref: string): PaneMatch {
  const want = ref.trim();
  if (!want) return { ok: false, message: 'needs a seat title or a pane id' };
  const exact = rows.find((row) => row.pane === want || row.address === want || row.address.endsWith(`:${want}`)
    || `${row.workspace ?? ''}/${row.tab ?? ''}/${row.pane}` === want);
  if (exact) return { ok: true, row: exact };
  const upper = want.toUpperCase();
  const named = rows.filter((row) => (row.title ?? '').toUpperCase() === upper || (row.seat ?? '').toUpperCase() === upper && !row.title);
  if (named.length === 0) return { ok: false, message: `no pane titled ${want} (try \`els ls\`)` };
  const live = named.filter((row) => row.state !== 'exited');
  const pool = live.length > 0 ? live : named;
  const local = pool.filter((row) => row.reach === 'local');
  const pick = (local.length > 0 ? local : pool)[0]!;
  const others = pool.filter((row) => row !== pick).map((row) => row.address);
  return { ok: true, row: pick, ...(others.length > 0 ? { note: `${pool.length} panes are titled ${want}; showing ${pick.address} (others: ${others.join(', ')})` } : {}) };
}

// ── which session ───────────────────────────────────────────────────────────────────────────────────────────────────

/** `ps -A -o pid=,ppid=` text → pid → parent pid. */
export function parsePsParents(text: string): Map<number, number> {
  const parents = new Map<number, number>();
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) parents.set(Number(match[1]), Number(match[2]));
  }
  return parents;
}

/** The pane's own process and every process below it. */
export function processTree(root: number, parents: ReadonlyMap<number, number>): Set<number> {
  const tree = new Set<number>([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of parents) if (!tree.has(pid) && tree.has(ppid)) { tree.add(pid); grew = true; }
  }
  return tree;
}

/** The PTY-manifest fields this file reads (src/pty-shell/pty-manifest.ts PtyManifestRow). */
export interface PeekManifestRow {
  readonly id: string;
  readonly kind: string;
  readonly ownerPid: number;
  readonly sessionId: string;
  readonly alive: boolean;
  readonly closedAt: number;
  readonly updatedAt: number;
}

export interface PaneSession { readonly sessionId: string; readonly source: 'pty-manifest' | 'argv'; readonly pid?: number }

const SESSION_FLAGS = new Set(['--resume', '-r', '--session', '--session-id']);

/** The session the eln in this pane is running NOW. First the eln TUI's own report (its `tui:<pid>` manifest row, which it
 *  rewrites on every session switch) for a process inside the pane; else the `--resume <id>` it was started with.
 *  Nothing found → undefined (the caller says so; it never falls back to «the seat's latest session» from logs). */
export function paneSession(input: { readonly panePid?: number; readonly parents: ReadonlyMap<number, number>; readonly manifest: readonly PeekManifestRow[];
  readonly fgCommand?: readonly string[] }): PaneSession | undefined {
  if (input.panePid && input.panePid > 0) {
    const tree = processTree(input.panePid, input.parents);
    const own = input.manifest
      .filter((row) => row.kind === 'tui' && row.alive && !row.closedAt && row.sessionId && tree.has(row.ownerPid))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (own) return { sessionId: own.sessionId, source: 'pty-manifest', pid: own.ownerPid };
  }
  const argv = input.fgCommand ?? [];
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at]!;
    const eq = /^(--resume|--session|--session-id)=(.+)$/.exec(word);
    if (eq) return { sessionId: eq[2]!, source: 'argv' };
    if (SESSION_FLAGS.has(word) && argv[at + 1] && !argv[at + 1]!.startsWith('-')) return { sessionId: argv[at + 1]!, source: 'argv' };
  }
  return undefined;
}

// ── session history ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A jsonl transcript (bytes) → messages. Invalid UTF-8 is replaced, a malformed line is skipped (counted). */
export function parseTranscript(bytes: Uint8Array): { readonly messages: SerializedMessage[]; readonly skipped: number } {
  const messages: SerializedMessage[] = [];
  let skipped = 0;
  for (const line of decodeUtf8(bytes).split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && typeof (parsed as { role?: unknown }).role === 'string') messages.push(parsed as SerializedMessage);
      else skipped++;
    } catch { skipped++; }
  }
  return { messages, skipped };
}

export interface TurnView {
  readonly index: number;
  readonly rows: readonly { readonly role: string; readonly at: string; readonly lines: readonly string[] }[];
  readonly clipped: number;
}

/** An ISO time → local HH:MM:SS (the clock the reader's screen shows); unparsable → as stored. */
export function localClock(ts: string, seconds = true): string {
  const at = Date.parse(ts);
  if (!Number.isFinite(at)) return ts.slice(0, 8);
  return new Date(at).toTimeString().slice(0, seconds ? 8 : 5);
}
const hhmmss = (ts: string): string => localClock(ts);
const asText = (value: unknown): string => typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value) ?? '';

/** One tool row as a single line: name · args → result. */
export function toolLine(message: SerializedMessage, width: number): string {
  const args = oneLine(asText(message.toolArgs));
  const result = oneLine(asText(message.toolResult ?? message.content));
  return clip(`⚙ ${message.toolName ?? 'tool'} ${clip(args, 80)} → ${result}`, width);
}

/** The last `turns` turns (a turn = a user message and everything after it up to the next one), each clipped to
 *  `lines` printed lines. System rows are skipped; tool rows only with `tools`. */
export function lastTurns(messages: readonly SerializedMessage[], opts: { readonly turns: number; readonly lines: number; readonly tools: boolean; readonly width: number }): TurnView[] {
  const groups: SerializedMessage[][] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user' || groups.length === 0) groups.push([]);
    groups[groups.length - 1]!.push(message);
  }
  const first = Math.max(0, groups.length - Math.max(0, opts.turns));
  return groups.slice(first).map((group, offset) => {
    let budget = Math.max(1, opts.lines);
    let clipped = 0;
    const rows: { role: string; at: string; lines: string[] }[] = [];
    for (const message of group) {
      if (message.role === 'tool' && !opts.tools) continue;
      const body = message.role === 'tool' ? [toolLine(message, opts.width)]
        : asText(message.content).split('\n').map(sanitizeLine).filter((line) => line.trim() !== '').map((line) => clip(line, opts.width));
      const kept = body.slice(0, budget);
      clipped += body.length - kept.length;
      budget -= kept.length;
      if (kept.length > 0 || budget > 0) rows.push({ role: message.role, at: hhmmss(message.ts ?? ''), lines: kept });
    }
    return { index: first + offset + 1, rows, clipped };
  });
}

export function formatTurns(turns: readonly TurnView[]): string[] {
  const out: string[] = [];
  for (const turn of turns) {
    out.push(`── turn ${turn.index} ──`);
    for (const row of turn.rows) {
      out.push(`  ${row.role} @ ${row.at}`);
      for (const line of row.lines) out.push(`    ${line}`);
    }
    if (turn.clipped > 0) out.push(`    … ${turn.clipped} more line(s) (raise --lines)`);
  }
  return out;
}

// ── screen ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const SPINNER = /[⠁-⣿◐◓◑◒⏳✻✶✳✢·•●○◦]/gu;
/** Footer, status and usage rows a TUI repaints all the time — never news. */
const NOISE: readonly RegExp[] = [
  /^[\s─━═\-_]+$/,
  /^\s*[❯>›]\s*$/,
  // the header `els read` puts above the screen text
  /^\[screen \d+x\d+ cursor=/,
  /esc to interrupt/i,
  /\bEnter send\b/i,
  /Ctrl\+[A-Z] (quit|exit)/i,
  /\b\d+(\.\d+)?[kKmM]? tokens?\b/,
  /\b(context|ctx)\b.*\d+%/i,
  /\b\d+% (left|used)\b/i,
  /\$\d+\.\d{2}\b.*\b(today|session|spent)\b/i,
  /^\s*[│|].*[│|]\s*$/,
  // the header `els read` puts above the screen text
  /^\[screen \d+x\d+ cursor=/,
  // eln footer rows: queue/background counters, the drive line, the goal line, the provider budget line.
  /^\s*Queue \d+\b.*\bBg \d+/,
  /^\s*🚗 /u,
  /^\s*🎯 /u,
  /\b(codex|team|third|glm)\b[^│]*\d+%.*(│|·)/,
  /│\s*OR \$\d/,
];

export function isNoiseLine(line: string): boolean {
  return line.trim() === '' || NOISE.some((pattern) => pattern.test(line));
}

/** The dedupe key of a line: spinner glyphs and running clocks removed, so «⠋ Working 12s» and «⠙ Working 13s» are one. */
export function lineKey(line: string): string {
  return line.replace(SPINNER, '').replace(/\b\d+(\.\d+)?\s?(ms|s|m|h)\b/g, '#').replace(/\(\s*#[^)]*\)/g, '(#)').replace(/\s+/g, ' ').trim();
}

/** Screen text → its meaningful lines (sanitized, noise removed). */
export function screenLines(screen: string): string[] {
  return screen.split('\n').map(sanitizeLine).filter((line) => !isNoiseLine(line));
}

export function screenTail(screen: string, count: number, width: number): string[] {
  return screenLines(screen).slice(-Math.max(0, count)).map((line) => clip(line, width));
}

/** The watch diff: lines of `current` whose key was not on the previous screen and was not printed recently.
 *  `recent` is updated in place and kept to `memory` keys (oldest dropped). */
export function newScreenLines(previous: readonly string[], current: readonly string[], recent: Set<string>, memory = 400): string[] {
  const before = new Set(previous.map(lineKey));
  const fresh: string[] = [];
  for (const line of current) {
    const key = lineKey(line);
    if (!key || before.has(key) || recent.has(key)) continue;
    recent.add(key);
    fresh.push(line);
  }
  while (recent.size > memory) recent.delete(recent.values().next().value as string);
  return fresh;
}

// ── mail ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PeekMail { readonly id: number; readonly from: string; readonly to: string; readonly kind?: string | null; readonly body: string; readonly createdAt: string }

/** The read surface of the mail store this file needs (MsgStore.latestId / listAfter — ascending, ≤1000 a call). */
export interface MailWindowSource { latestId(): number; listAfter(after: number, limit: number): readonly PeekMail[] }

const sameSeat = (address: string, seat: string): boolean => address.toUpperCase() === seat.toUpperCase();

/** The last `count` mails received by and sent from `seat`, newest window first: `msg list` reads oldest-first, so the
 *  window walks back from the latest id in steps of `step` until both lists are full or `maxScan` ids were read. */
export function recentMail(source: MailWindowSource, seat: string, count: number, opts: { readonly step?: number; readonly maxScan?: number } = {}):
  { readonly received: PeekMail[]; readonly sent: PeekMail[]; readonly scannedFrom: number; readonly latest: number } {
  const step = Math.min(1000, Math.max(1, opts.step ?? 1000));
  const maxScan = opts.maxScan ?? 40_000;
  const latest = source.latestId();
  const received: PeekMail[] = [];
  const sent: PeekMail[] = [];
  let upper = latest;
  while (upper > 0 && latest - upper < maxScan && (received.length < count || sent.length < count)) {
    const lower = Math.max(0, upper - step);
    const rows = source.listAfter(lower, step).filter((row) => row.id <= upper);
    const inWindowReceived = rows.filter((row) => sameSeat(row.to, seat));
    const inWindowSent = rows.filter((row) => sameSeat(row.from, seat) && !sameSeat(row.to, seat));
    received.unshift(...inWindowReceived);
    sent.unshift(...inWindowSent);
    upper = lower;
  }
  return { received: received.slice(-count), sent: sent.slice(-count), scannedFrom: upper, latest };
}

export function mailLine(mail: PeekMail, width: number): string {
  return clip(`#${mail.id} ${localClock(mail.createdAt, false)} ${mail.from}→${mail.to} [${mail.kind ?? '-'}] ${oneLine(mail.body)}`, width);
}

/** New mails since `after` that touch `seat` (to it or from it), ascending. */
export function mailSince(source: MailWindowSource, seat: string, after: number): { readonly mails: PeekMail[]; readonly last: number } {
  const mails: PeekMail[] = [];
  let cursor = after;
  for (let page = 0; page < 20; page++) {
    const rows = source.listAfter(cursor, 1000);
    if (rows.length === 0) break;
    for (const row of rows) if (sameSeat(row.to, seat) || sameSeat(row.from, seat)) mails.push(row);
    cursor = rows[rows.length - 1]!.id;
    if (rows.length < 1000) break;
  }
  return { mails, last: cursor };
}

// ── session tail (watch --follow-session) ───────────────────────────────────────────────────────────────────────────

/** Incremental jsonl tail over raw bytes: a chunk may end mid-line or mid-code-point; only complete lines are parsed. */
export function createTranscriptTail(): { push(chunk: Uint8Array): SerializedMessage[] } {
  let pending = new Uint8Array(0);
  return {
    push(chunk) {
      const joined = new Uint8Array(pending.length + chunk.length);
      joined.set(pending, 0); joined.set(chunk, pending.length);
      const lastNewline = joined.lastIndexOf(0x0a);
      if (lastNewline < 0) { pending = joined; return []; }
      pending = joined.slice(lastNewline + 1);
      return parseTranscript(joined.slice(0, lastNewline + 1)).messages;
    },
  };
}

/** One streamed session message as watch lines. */
export function sessionMessageLines(message: SerializedMessage, opts: { readonly lines: number; readonly width: number }): string[] {
  if (message.role === 'system') return [];
  if (message.role === 'tool') return [toolLine(message, opts.width)];
  const body = asText(message.content).split('\n').map(sanitizeLine).filter((line) => line.trim() !== '');
  const head = body.slice(0, Math.max(1, opts.lines)).map((line, at) => clip(at === 0 ? `${message.role}: ${line}` : `  ${line}`, opts.width));
  if (body.length > head.length) head.push(`  … ${body.length - head.length} more line(s)`);
  return head.length > 0 ? head : [`${message.role}: (empty)`];
}
