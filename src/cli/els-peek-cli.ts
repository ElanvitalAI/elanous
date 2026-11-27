// ELS-PEEK-WATCH — `els peek <seat|pane>` (a snapshot: pane + state, the last N turns of the session the eln in that pane
// is running, the screen tail, recent mail to and from the seat) and `els watch <seat|pane>` (a live stream: new screen
// lines with a time, ✉ lines for new mail, and with --follow-session the session's new messages as they are persisted).
// Read-only by construction: the only els requests are `ls` and `read`; nothing is ever typed into a pane.
// `eln seat peek|watch` are the same runners (registered from src/index.ts).

import type { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, watch, writeSync, type FSWatcher } from 'node:fs';
import { sessionFile, sessionRoot } from '../session/index.js';
import { listPtyManifestRowsAt, ptyManifestDbPath } from '../pty-shell/pty-manifest.js';
import { openMsgStoreReadOnly } from '../msg/msg-store.js';
import { defaultArchivePath } from '../msg/msg-archive.js';
import {
  clip, createTranscriptTail, formatTurns, lastTurns, mailLine, mailSince, newScreenLines, paneSession, parsePsParents, parseTranscript,
  recentMail, resolvePane, screenLines, screenTail, sessionMessageLines, type MailWindowSource, type PaneSession, type PeekPaneRow,
} from '../seat-peek/peek.js';

export interface PeekDeps {
  /** Every pane on this host and the registered hosts (`els ls` rows). */
  listPanes(): Promise<PeekPaneRow[]>;
  /** One pane's screen text (`els read`). */
  readScreen(address: string): Promise<{ readonly ok: boolean; readonly text: string }>;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Seams for tests; real defaults below. */
  psParents?: () => Map<number, number>;
  manifestRows?: () => ReturnType<typeof listPtyManifestRowsAt>;
  sessionBytes?: (sessionId: string) => Uint8Array | null;
  mail?: () => (MailWindowSource & { close?(): void }) | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

const WIDTH = 220;

const realPs = (): Map<number, number> => {
  const run = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5_000 });
  return parsePsParents(run.stdout ?? '');
};
const realSessionBytes = (sessionId: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9._-]{4,128}$/.test(sessionId)) return null;
  const file = sessionFile(sessionId);
  return existsSync(file) ? readFileSync(file) : null;
};
const realMail = (): (MailWindowSource & { close(): void }) | null => {
  try {
    const store = openMsgStoreReadOnly(undefined, { archivePath: defaultArchivePath() });
    return { latestId: () => store.latestId(), listAfter: (after, limit) => store.listAfter(after, limit), close: () => store.close() };
  } catch { return null; }
};

const stamp = (date: Date): string => date.toTimeString().slice(0, 8);
const hr = (title: string): string => `━━━━ ${title} ━━━━`;

function sessionOf(row: PeekPaneRow, deps: PeekDeps): PaneSession | undefined {
  if (row.reach && row.reach !== 'local') return undefined;
  let manifest: ReturnType<typeof listPtyManifestRowsAt> = [];
  try { manifest = (deps.manifestRows ?? (() => listPtyManifestRowsAt(ptyManifestDbPath())))(); } catch { /* unreadable manifest → argv only */ }
  let parents = new Map<number, number>();
  try { parents = (deps.psParents ?? realPs)(); } catch { /* no ps → argv only */ }
  return paneSession({ ...(row.pid ? { panePid: row.pid } : {}), parents, manifest, ...(row.fgCommand ? { fgCommand: row.fgCommand } : {}) });
}

function stateWords(row: PeekPaneRow): string {
  const seat = row.status?.state ? `${row.status.state}${row.status.reason ? `/${row.status.reason}` : ''}` : row.activityState ?? row.state ?? 'unknown';
  return [seat, row.kind, row.model].filter(Boolean).join(' · ');
}

async function findPane(ref: string, deps: PeekDeps): Promise<{ row: PeekPaneRow; note?: string } | { error: string }> {
  let rows: PeekPaneRow[];
  try { rows = await deps.listPanes(); } catch (error) { return { error: `cannot list panes: ${error instanceof Error ? error.message : String(error)}` }; }
  const match = resolvePane(rows, ref);
  return match.ok ? { row: match.row, ...(match.note ? { note: match.note } : {}) } : { error: match.message };
}

export interface PeekOptions { turns?: string | number; lines?: string | number; tools?: boolean; mail?: string | number; screen?: string | number; json?: boolean }

const int = (value: string | number | undefined, fallback: number, name: string): number => {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${name} must be a whole number ≥ 0 (got ${String(value)})`);
  return parsed;
};

/** `els peek` — returns the exit code. */
export async function runPeek(ref: string, opts: PeekOptions, deps: PeekDeps): Promise<number> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  let turns: number, lines: number, mailCount: number, screenCount: number;
  try {
    turns = int(opts.turns, 6, 'turns'); lines = int(opts.lines, 30, 'lines'); mailCount = int(opts.mail, 5, 'mail'); screenCount = int(opts.screen, 14, 'screen');
  } catch (error) { err(`els peek: ${(error as Error).message}`); return 2; }
  const found = await findPane(ref, deps);
  if ('error' in found) { err(`els peek: ${found.error}`); return 1; }
  const { row } = found;
  const seat = row.title || row.seat || ref;

  const session = sessionOf(row, deps);
  let history: ReturnType<typeof lastTurns> = [];
  let sessionNote: string | undefined;
  if (!session) sessionNote = row.reach && row.reach !== 'local' ? `session history is read on the pane's own host (${row.host ?? 'remote'}); showing screen and mail only`
    : row.kind === 'eln' || (row.fgCommand ?? []).some((word) => /elanous|eln/.test(word)) ? 'no session found for the eln in this pane (it has not reported one yet)'
    : `no eln session: the pane runs ${row.kind ?? 'something else'}`;
  else {
    const bytes = (deps.sessionBytes ?? realSessionBytes)(session.sessionId);
    if (!bytes) sessionNote = `session ${session.sessionId} has no transcript in ${sessionRoot()}`;
    else history = lastTurns(parseTranscript(bytes).messages, { turns, lines, tools: opts.tools === true, width: WIDTH });
  }

  const screen = await deps.readScreen(row.address).catch((error: unknown) => ({ ok: false, text: String(error) }));
  const tail = screen.ok ? screenTail(screen.text, screenCount, WIDTH) : [];

  let mail: ReturnType<typeof recentMail> | undefined;
  let mailNote: string | undefined;
  if (mailCount > 0) {
    const source = (deps.mail ?? realMail)();
    if (!source) mailNote = 'mail store unavailable';
    else try { mail = recentMail(source, seat, mailCount); } catch (error) { mailNote = `mail read failed: ${(error as Error).message}`; } finally { source.close?.(); }
  }

  if (opts.json) {
    out(JSON.stringify({
      pane: { address: row.address, pane: row.pane, title: row.title ?? null, seat, state: stateWords(row) },
      ...(found.note ? { note: found.note } : {}),
      session: session ? { id: session.sessionId, source: session.source, turns: history } : null,
      ...(sessionNote ? { sessionNote } : {}),
      screen: screen.ok ? tail : null, ...(screen.ok ? {} : { screenError: screen.text.slice(0, 300) }),
      mail: mail ? { received: mail.received, sent: mail.sent } : null, ...(mailNote ? { mailNote } : {}),
    }, null, 2));
    return 0;
  }
  const now = (deps.now ?? (() => new Date()))();
  out(hr(`${seat} · ${row.address} · ${stateWords(row)} · ${stamp(now)}`));
  if (found.note) out(`(${found.note})`);
  if (session) out(hr(`session ${session.sessionId.slice(0, 8)} (${session.source}) · last ${history.length} turn(s) · ≤${lines} lines each`));
  if (sessionNote) out(`(${sessionNote})`);
  for (const line of formatTurns(history)) out(line);
  out(hr(`screen (last ${tail.length} lines)`));
  if (!screen.ok) out(`(cannot read the pane: ${clip(screen.text.replace(/\s+/g, ' '), 200)})`);
  for (const line of tail) out(line);
  if (mailCount > 0) {
    if (mailNote) out(`(${mailNote})`);
    if (mail) {
      out(hr(`mail to ${seat} (last ${mail.received.length})`));
      for (const m of mail.received) out(mailLine(m, WIDTH));
      out(hr(`mail from ${seat} (last ${mail.sent.length})`));
      for (const m of mail.sent) out(mailLine(m, WIDTH));
    }
  }
  return 0;
}

export interface WatchOptions { interval?: string; mail?: boolean; followSession?: boolean; lines?: string | number; tools?: boolean }

/** «3s» · «500ms» · «2» (seconds) → ms; at least 500 ms. */
export function parseInterval(value: string | undefined): number {
  if (value === undefined) return 3_000;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(value.trim());
  if (!match) throw new Error(`--interval: use 3s, 500ms or 1m (got ${value})`);
  const amount = Number(match[1]);
  const ms = match[2] === 'ms' ? amount : match[2] === 'm' ? amount * 60_000 : amount * 1_000;
  return Math.max(500, Math.round(ms));
}

/** ELS-WATCH-UNBUFFERED (대표 11-27): one synchronous write(2) per line on the raw fd, TTY or not — a pipe or a file
 *  (`els watch p.. | grep --line-buffered …`, a Monitor's output file) gets each line the moment it is made, never a
 *  batch held in a stream buffer. EAGAIN (a non-blocking pipe that is full) waits for the reader; EPIPE/EBADF (the reader
 *  is gone) is quiet: `onClosed` fires once and later lines are dropped. */
export function lineWriter(fd: number, onClosed: () => void = () => {}): (line: string) => void {
  let closed = false;
  return (line: string): void => {
    if (closed) return;
    let rest = Buffer.from(`${line}\n`, 'utf8');
    let spins = 0;
    while (rest.length > 0) {
      try {
        const n = writeSync(fd, rest);
        rest = rest.subarray(n);
        spins = 0;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EAGAIN' && ++spins < 2_000) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); continue; }
        closed = true;
        if (code === 'EPIPE' || code === 'EBADF' || code === 'EAGAIN') { onClosed(); return; }
        throw error;
      }
    }
  };
}

/** `els watch` — streams until the signal aborts (Ctrl-C) or the reader of stdout goes away. Returns the exit code. */
export async function runWatch(ref: string, opts: WatchOptions, deps: PeekDeps): Promise<number> {
  let readerGone = false;
  const out = deps.out ?? lineWriter(1, () => { readerGone = true; });
  const err = deps.err ?? lineWriter(2);
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let interval: number, msgLines: number;
  try { interval = parseInterval(opts.interval); msgLines = int(opts.lines, 6, 'lines'); } catch (error) { err(`els watch: ${(error as Error).message}`); return 2; }
  const signal = deps.signal;
  const emit = (text: string): void => { out(`${stamp(now())} │ ${clip(text, WIDTH)}`); };

  const first = await findPane(ref, deps);
  if ('error' in first) { err(`els watch: ${first.error}`); return 1; }
  let row = first.row;
  const seat = row.title || row.seat || ref;

  const mailSource: (MailWindowSource & { close?(): void }) | null = opts.mail ? (deps.mail ?? realMail)() : null;
  let mailCursor = 0;
  if (opts.mail) {
    if (!mailSource) err('els watch: mail store unavailable; streaming the screen only');
    else try { mailCursor = mailSource.latestId(); } catch { /* starts at 0 → first tick reads forward */ }
  }

  // --follow-session: an fs.watch on the session folder (the store's append is the event) plus the tick as the backstop.
  let session: PaneSession | undefined;
  let offset = 0;
  let tail = createTranscriptTail();
  let watcher: FSWatcher | null = null;
  const readSessionTail = (): void => {
    if (!session) return;
    const file = sessionFile(session.sessionId);
    let size: number;
    try { size = statSync(file).size; } catch { return; }
    if (size < offset) { offset = 0; tail = createTranscriptTail(); }
    if (size <= offset) return;
    const chunk = Buffer.alloc(size - offset);
    const fd = openSync(file, 'r');
    try { readSync(fd, chunk, 0, chunk.length, offset); } finally { closeSync(fd); }
    offset = size;
    for (const message of tail.push(chunk)) {
      if (message.role === 'tool' && !opts.tools) continue;
      for (const line of sessionMessageLines(message, { lines: msgLines, width: WIDTH - 12 })) emit(`◆ ${line}`);
    }
  };
  const bindSession = (next: PaneSession | undefined): void => {
    if (next?.sessionId === session?.sessionId) return;
    session = next;
    watcher?.close(); watcher = null;
    if (!session) return;
    try { offset = statSync(sessionFile(session.sessionId)).size; } catch { offset = 0; }
    tail = createTranscriptTail();
    emit(`◆ following session ${session.sessionId} (${session.source})`);
    const name = `${session.sessionId}.jsonl`;
    try { watcher = watch(sessionRoot(), (_event, filename) => { if (!filename || filename === name) readSessionTail(); }); } catch { watcher = null; }
  };

  out(hr(`watch ${seat} · ${row.address} · every ${interval / 1000}s${opts.mail ? ` · mail after #${mailCursor}` : ''}${opts.followSession ? ' · session' : ''} · Ctrl-C ends · read-only`));
  if (first.note) out(`(${first.note})`);
  let previous: string[] | null = null;
  const recent = new Set<string>();
  let tick = 0;
  let readFailures = 0;
  try {
    while (!signal?.aborted && !readerGone) {
      if (tick > 0 && tick % 20 === 0) {
        const again = await findPane(row.address, deps);
        if ('row' in again) row = again.row;
      }
      if (opts.followSession && (tick % 10 === 0)) bindSession(sessionOf(row, deps));
      const screen = await deps.readScreen(row.address).catch((error: unknown) => ({ ok: false, text: String(error) }));
      if (screen.ok) {
        readFailures = 0;
        const current = screenLines(screen.text);
        // The first screen is the baseline: its last 5 lines are printed for context, the rest only seeds the diff.
        const fresh = previous === null ? newScreenLines([], current.slice(-5), recent) : newScreenLines(previous, current, recent);
        for (const line of fresh) emit(line);
        previous = current;
      } else if (++readFailures === 1 || readFailures % 20 === 0) emit(`(cannot read the pane: ${screen.text.replace(/\s+/g, ' ').slice(0, 160)})`);
      if (mailSource) {
        try {
          const next = mailSince(mailSource, seat, mailCursor);
          for (const mail of next.mails) emit(`✉ ${mailLine(mail, WIDTH - 14)}`);
          mailCursor = Math.max(mailCursor, next.last);
        } catch (error) { if (tick % 20 === 0) emit(`(mail read failed: ${(error as Error).message.slice(0, 120)})`); }
      }
      if (opts.followSession) readSessionTail();
      tick++;
      await sleep(interval);
    }
  } finally {
    // assigned inside bindSession: TS narrows the outer `let` to null here, so read it through its declared type
    (watcher as FSWatcher | null)?.close();
    mailSource?.close?.();
  }
  return 0;
}

/** Wire `peek` and `watch` onto a commander group (`els` and `eln seat`). */
export function registerPeekWatchCommands(group: Command, deps: () => PeekDeps): void {
  group.command('peek <pane>')
    .description('Snapshot of a seat or pane: state, the last turns of the eln session it runs, the screen tail and recent mail (read-only)')
    .option('--turns <n>', 'conversation turns to show', '6')
    .option('--lines <n>', 'lines per turn', '30')
    .option('--screen <n>', 'screen tail lines', '14')
    .option('--tools', 'include tool-call rows')
    .option('--mail <n>', 'last N mails to and from the seat (0 = none)', '5')
    .option('--json', 'one JSON object')
    .action(async (pane: string, opts: PeekOptions) => { process.exitCode = await runPeek(pane, opts, deps()); });
  group.command('watch <pane>')
    .description('Live stream of a seat or pane: new screen lines with a time, ✉ mail lines, session messages (read-only; Ctrl-C ends)')
    .option('--interval <time>', 'poll interval (3s · 500ms · 1m)', '3s')
    .option('--mail', 'interleave new mail to and from the seat')
    .option('--follow-session', 'stream new session messages (user/assistant, --tools for tool rows) as they are persisted')
    .option('--tools', 'with --follow-session: include tool rows')
    .option('--lines <n>', 'with --follow-session: lines per message', '6')
    .action(async (pane: string, opts: WatchOptions) => {
      const controller = new AbortController();
      const stop = (): void => { controller.abort(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try { process.exitCode = await runWatch(pane, opts, { ...deps(), signal: controller.signal, sleep: (ms) => abortableSleep(ms, controller.signal) }); }
      finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); lineWriter(1)(''); }
    });
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', done); resolve(); }, ms);
    const done = (): void => { clearTimeout(timer); resolve(); };
    signal.addEventListener('abort', done, { once: true });
  });
}

export type { PeekPaneRow } from '../seat-peek/peek.js';
