#!/usr/bin/env bun
// ELS-LIGHTWEIGHT-BUDGET-GATE — the keyboard latency instrument for the els server.
//
// It types N keys into a scratch `/bin/zsh -f` pane through the product attach client (`attachEls`, the same wire
// `els attach` speaks) and times each key from its SCHEDULED send time (t0 + i·interval) to the first frame that shows
// that character — a late send counts against the server, never hides a backlog. The isolated server runs in its own
// child process (as `els serve` does), so a blocked server loop cannot also delay the typist or the clock; the child
// reports its own process CPU (main thread + workers) for the server CPU budget. With `--load` the child's state root
// holds today's production shape: a messages.db of ~100k rows across 17 seats (the real msg-store schema), 17 seat panes
// whose `ls` rows carry unread-mail badges; this process runs 5 list pollers asking `ls` once a second each and counts
// only the answers that really came back as a listing.
//
// Usage:
//   bun scripts/els-typing-latency.ts                         isolated server (temp state root, child process), no load
//   bun scripts/els-typing-latency.ts --load                  isolated server + load fixture (the regression shape)
//   bun scripts/els-typing-latency.ts --socket <path>         a running server (e.g. ~/.elanous/els/els.sock):
//                                                             a scratch zsh pane is opened there and closed after.
//                                                             Credential = that socket's own owner-token only (socket,
//                                                             dir and file must be the current user's); env tokens unused
//   options: --keys 50 --interval 120 --rows 100000 --seats 17 --pollers 5 --poll-ms 1000
//   --block-ms 150 [--block-every-ms 300]: violation injection — the server child stalls its own main thread (must go RED)
// Prints one JSON line: {p50,p95,p99,max,backlogMsAfterLast,keys,intervalMs,missing,serverCpuPct,ls…}.

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Database } from 'bun:sqlite';
import { attachEls, type AttachFrame } from '../src/els/attach-client.js';
import { requestEls } from '../src/els/client.js';
import { elsSocketPath, startElsServer } from '../src/els/server.js';
import { AUTH_OWNER_TOKEN_ENV, AUTH_PANE_TOKEN_ENV } from '../src/els/server-auth.js';
import { reapElsProcesses, trackElsServer } from '../src/els/test-support/els-process-guard.js';
import { openMsgStore } from '../src/msg/msg-store.js';

export interface TypingResult {
  readonly keys: number;
  readonly intervalMs: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  /** From the last key's scheduled send time to the frame that shows every typed key. */
  readonly backlogMsAfterLast: number;
  /** Keys never seen in a frame before the wait ran out (each counted at the wait limit in the percentiles). */
  readonly missing: number;
  /** The largest delay between a key's scheduled and actual send (the typist's own lag; informational). */
  readonly sendLagMaxMs: number;
  /** Server process CPU over the typing window, percent of one core (null when the server pid is not ours). */
  readonly serverCpuPct: number | null;
  readonly latenciesMs: readonly number[];
  /** The measurement window on this process's performance.now() clock: first key's schedule → every key shown (or the wait ran out). */
  readonly windowStartMs: number;
  readonly windowEndMs: number;
}

const PROMPT = 'LAT> ';
const KEYSET = 'abcdefghijklmnopqrstuvwxyz';
const SEATS = ['OP', 'OPC', 'OPT', 'TC', 'MK', 'UX', 'JUD', 'JUD-B', 'RES', 'RES-INFRA', 'REL', 'REVIEW', 'CC-1', 'CC-2', 'HAND-1', 'HAND-2', 'HAND-3'];
// Unix sockets hold at most 103 bytes on macOS; a long TMPDIR falls back to /tmp (same rule as the els tests).
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const TAG = 'els-lat';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const round = (ms: number): number => Math.round(ms * 100) / 100;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

/** What follows the last prompt marker on the screen — the line the person is typing on. */
function typedLine(screen: string): string | undefined {
  const at = screen.lastIndexOf(PROMPT);
  if (at < 0) return undefined;
  const rest = screen.slice(at + PROMPT.length);
  const end = rest.indexOf('\n');
  return (end < 0 ? rest : rest.slice(0, end)).replace(/\s+$/, '');
}

// The env the product clients read a credential from (attach-client.ts attachAuth · client.ts paneAuth).
const CREDENTIAL_ENV = [AUTH_PANE_TOKEN_ENV, AUTH_OWNER_TOKEN_ENV, 'ELANOUS_ELS_RUNTIME_TOKEN_FILE'] as const;

/**
 * The owner credential of exactly this socket's server: the `owner-token` file next to `socketPath`, and only when the
 * socket, its directory and the token file all belong to the current user (directory not group/world writable, token
 * file a regular non-symlink file readable by its owner only). Anything else is refused — never a token from this
 * process's env, never a token of another server.
 */
export function targetCredential(socketPath: string): string {
  const uid = process.getuid?.();
  const refuse = (why: string): never => { throw new Error(`els-typing-latency: refusing ${socketPath}: ${why}`); };
  let socket;
  try { socket = lstatSync(socketPath); } catch { return refuse('no socket at this path'); }
  if (!socket.isSocket()) refuse('not a unix socket');
  if (uid !== undefined && socket.uid !== uid) refuse('the socket is not owned by the current user');
  const dir = lstatSync(dirname(socketPath));
  if (!dir.isDirectory() || (uid !== undefined && dir.uid !== uid) || (dir.mode & 0o022) !== 0) refuse('the socket directory is not private to the current user');
  let fd: number | undefined;
  try {
    try { fd = openSync(join(dirname(socketPath), 'owner-token'), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch { return refuse('no owner-token next to the socket'); }
    const stat = fstatSync(fd);
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0 || stat.size > 256) refuse('the owner-token file is not a private file of the current user');
    const token = readFileSync(fd, 'utf8').trim();
    if (!token) refuse('the owner-token file is empty');
    return token;
  } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * Open one connection with exactly `credential`: the product clients read their credential from env synchronously
 * when a connection starts, so the env is cleared of every inherited credential, holds this one for that synchronous
 * call only, and is restored before returning — an operational token of this process never reaches the target, and
 * the target's token never stays behind for another connection.
 */
export function withTarget<T>(credential: string, connect: () => T): T {
  const saved = CREDENTIAL_ENV.map((name) => [name, process.env[name]] as const);
  for (const name of CREDENTIAL_ENV) delete process.env[name];
  process.env[AUTH_OWNER_TOKEN_ENV] = credential;
  try { return connect(); }
  finally { for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
}

/**
 * Type `keys` characters into `pane`, key i scheduled at t0 + i·intervalMs, and time each one from its scheduled time to
 * the frame that first shows it. `serverCpuMicros` (optional) reads the server process's total CPU in µs.
 */
export async function measureTyping(socketPath: string, pane: string, credential: string,
  options: { keys?: number; intervalMs?: number; waitMs?: number; serverCpuMicros?: () => Promise<number> } = {}): Promise<TypingResult> {
  const keys = options.keys ?? 50;
  const intervalMs = options.intervalMs ?? 120;
  const waitMs = options.waitMs ?? 10_000;
  const text = Array.from({ length: keys }, (_, i) => KEYSET[i % KEYSET.length]).join('');
  const dueAt: number[] = [];
  const sentAt: number[] = [];
  const seenAt: (number | undefined)[] = new Array(keys).fill(undefined);
  let latest = '';
  let ended: string | undefined;
  let onFrame: () => void = () => {};
  const attached = withTarget(credential, () => attachEls(socketPath, pane, { cols: 220, rows: 40 }, {
    onFrame: (frame: AttachFrame) => {
      const now = performance.now();
      latest = frame.screen;
      const line = typedLine(frame.screen);
      if (line !== undefined && sentAt.length > 0) {
        let n = 0;
        while (n < line.length && n < keys && line[n] === text[n]) n++;
        for (let i = 0; i < n; i++) if (seenAt[i] === undefined && sentAt[i] !== undefined) seenAt[i] = now;
      }
      onFrame();
    },
    onEnd: (_code, reason) => { ended = reason; },
  }));
  const until = async (check: () => boolean, ms: number, what: string): Promise<void> => {
    const stop = performance.now() + ms;
    while (!check()) {
      if (ended !== undefined) throw new Error(`els-typing-latency: attach ended while waiting for ${what}: ${ended}`);
      if (performance.now() > stop) throw new Error(`els-typing-latency: timed out waiting for ${what}; last screen tail: ${JSON.stringify(latest.slice(-300))}`);
      await new Promise<void>((resolve) => { onFrame = resolve; setTimeout(resolve, 20); });
    }
  };
  try {
    await until(() => latest.length > 0, waitMs, 'the first frame');
    // A known, empty prompt line to type on (zsh -f has no rc files, so this is the only prompt it shows).
    attached.input(`PS1='${PROMPT}'\r`);
    await until(() => typedLine(latest) === '', waitMs, 'the measurement prompt');
    await sleep(200);
    const cpu0 = options.serverCpuMicros ? await options.serverCpuMicros() : undefined;
    const t0 = performance.now();
    for (let i = 0; i < keys; i++) {
      const due = t0 + i * intervalMs;
      dueAt.push(due);
      const lag = due - performance.now();
      if (lag > 0) await sleep(lag);
      sentAt.push(performance.now());
      attached.input(text[i]!);
    }
    try { await until(() => seenAt.every((at) => at !== undefined), waitMs, 'every typed key in a frame'); } catch { /* counted as missing below */ }
    const cpu1 = options.serverCpuMicros ? await options.serverCpuMicros() : undefined;
    const windowEndMs = performance.now();
    const wall = windowEndMs - t0;
    const shownAt = seenAt.map((at, i) => at ?? sentAt[i]! + waitMs);
    const latenciesMs = dueAt.map((due, i) => round(shownAt[i]! - due));
    const missing = seenAt.filter((at) => at === undefined).length;
    const sorted = [...latenciesMs].sort((a, b) => a - b);
    attached.input('\u0015');   // clear the typed line (Ctrl-U) so the pane is left as found
    await sleep(50);
    return {
      keys, intervalMs,
      p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted.at(-1) ?? 0,
      backlogMsAfterLast: round(Math.max(0, Math.max(...shownAt) - dueAt[keys - 1]!)),
      missing,
      sendLagMaxMs: round(Math.max(...sentAt.map((at, i) => at - dueAt[i]!))),
      serverCpuPct: cpu0 !== undefined && cpu1 !== undefined ? round(((cpu1 - cpu0) / 1000 / wall) * 100) : null,
      latenciesMs,
      windowStartMs: t0, windowEndMs,
    };
  } finally { attached.detach(); }
}

/**
 * A messages.db with `rows` rows across `seats` (plus ALL broadcasts) and spread read cursors, on the real msg-store
 * schema. ELS-SERVER-MAINLOOP-STARVATION (OP #129147): the bodies follow a length distribution (60 B .. ~2.3 KB,
 * mean ≈ 1.2 KB), so 127_000 rows make a real 131 MB-class ledger (≥ 130 MiB on disk, asserted by the test) — not
 * 100k short lines (~10 MB). The draw is a fixed-seed LCG, so a given (rows, seats) always builds the same bytes.
 */
export function buildMailFixture(path: string, rows = 100_000, seats: readonly string[] = SEATS): void {
  mkdirSync(dirname(path), { recursive: true });
  openMsgStore(path).close();   // the product creates and migrates the schema
  const db = new Database(path);
  try {
    const insert = db.prepare('INSERT INTO msg_messages (sender, recipient, body, kind, created_at) VALUES (?, ?, ?, ?, ?)');
    const start = Date.parse('2026-11-01T00:00:00.000Z');
    let seed = 0x2f6e2b1;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
    const bodyOf = (i: number): string => {
      const filler = 'seat-mail line of ordinary length for the typing budget fixture — ';
      const target = 60 + Math.floor(rnd() * 2_300);
      let text = `synthetic load row ${i} — ${filler}`;
      while (text.length < target) text += filler;
      return text.slice(0, target);
    };
    db.transaction(() => {
      for (let i = 0; i < rows; i++) {
        const to = i % 50 === 0 ? 'ALL' : seats[i % seats.length]!;
        const from = seats[(i * 7 + 3) % seats.length]!;
        insert.run(from, to, bodyOf(i), 'info', new Date(start + i * 1_000).toISOString());
      }
      // Read cursors spread like the live ledger (some seats caught up, some far behind, one never read): seat k has read
      // the first k/seats of the rows, so an `ls` badge read walks about half the table per seat, as it does today.
      const cursor = db.prepare('INSERT OR REPLACE INTO msg_cursors (recipient, last_id) VALUES (?, ?)');
      seats.forEach((seat, k) => { if (k > 0) cursor.run(seat, Math.floor((rows * k) / seats.length)); });
    })();
  } finally { db.close(); }
}

export interface FixtureOptions {
  readonly load?: boolean; readonly rows?: number; readonly seats?: number;
  /**
   * Violation injection (the instrument's negative control, fixture only — the product has no such seam): the server
   * child busy-blocks its own main thread for `blockMs` every `blockEveryMs`, the way a synchronous ledger read on the
   * server thread did. A budget run against it must go RED.
   */
  readonly blockMs?: number; readonly blockEveryMs?: number;
}

/**
 * Child-process side: an isolated els server on a temp state root with one scratch `/bin/zsh -f` pane (and, with `load`,
 * the mail fixture and 17 seat panes at `<root>/seats/<SEAT>`). The parent starts this child with ELANOUS_STATE_DIR =
 * the temp root (the ls badge read resolves the ledger through it) and no inherited els credential. Prints one ready line, then answers `cpu` lines with its process CPU and ends on
 * `stop` (or stdin closing).
 */
async function serveFixture(root: string, options: FixtureOptions): Promise<number> {
  const seats = SEATS.slice(0, options.seats ?? SEATS.length);
  if (options.load) buildMailFixture(join(root, 'msg', 'messages.db'), options.rows ?? 100_000, seats);
  if ((options.blockMs ?? 0) > 0) {
    const blockMs = options.blockMs!;
    setInterval(() => { const end = performance.now() + blockMs; while (performance.now() < end) { /* injected main-thread stall */ } },
      options.blockEveryMs ?? 300).unref();
  }
  const started = await startElsServer({ stateRoot: root, stall: false });
  if ('exitCode' in started) { console.error(started.message); return 1; }
  const socketPath = elsSocketPath(root);
  const panes: string[] = [];
  const openPane = async (cwd: string, command: string[]): Promise<string> => {
    mkdirSync(cwd, { recursive: true });
    const created = await requestEls(socketPath, { op: 'new', ws: 'LAT', cwd, command });
    if (created.exitCode !== 0) throw new Error(`els-typing-latency: new pane refused: ${created.message}`);
    const pane = (JSON.parse(created.message) as { pane: string }).pane;
    panes.push(pane);
    return pane;
  };
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const id of panes) await requestEls(socketPath, { op: 'close', pane: id, confirmed: true }).catch(() => undefined);
    await started.close();
    await reapElsProcesses();   // close() detaches holders (they outlive a server by design): this fixture's own ones die here
  };
  try {
    const pane = await openPane(join(root, 'scratch'), ['/bin/zsh', '-f']);
    if (options.load) for (const seat of seats) await openPane(join(root, 'seats', seat), ['/bin/cat']);
    console.log(JSON.stringify({ [TAG]: 'ready', socketPath, pane, panes: panes.length, pid: process.pid }));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); await stop(); return 1; }
  const done = new Promise<void>((resolve) => {
    const input = createInterface({ input: process.stdin });
    input.on('line', (line) => {
      if (line === 'cpu') { const cpu = process.cpuUsage(); console.log(JSON.stringify({ [TAG]: 'cpu', micros: cpu.user + cpu.system })); }
      else if (line === 'stop') { input.close(); }
    });
    input.on('close', () => resolve());
  });
  await done;
  await stop();
  return 0;
}

export interface IsolatedEls {
  /** The temp state root the server child runs on (the 131 MB-class ledger lives at `<root>/msg/messages.db`). */
  readonly root: string;
  readonly socketPath: string;
  readonly pane: string;
  /** Panes the server listed at start (scratch + seat panes). */
  readonly panes: number;
  readonly serverPid: number;
  /** This server's owner credential (targetCredential of its socket) — pass it to measureTyping / startPollers. */
  readonly credential: string;
  readonly serverCpuMicros: () => Promise<number>;
  readonly stop: () => Promise<void>;
  /** Lose the server the hard way (SIGKILL — the ownership-lost path), reap it, remove the root. */
  readonly kill: () => Promise<void>;
}

/** Start the isolated server in a child process (`serveFixture`) and wait for its ready line. */
export async function spawnIsolatedEls(options: FixtureOptions = {}): Promise<IsolatedEls> {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-lat-'));
  const args = [process.execPath, import.meta.path, '--serve-fixture', root, ...(options.load ? ['--load'] : []),
    '--rows', String(options.rows ?? 100_000), '--seats', String(options.seats ?? SEATS.length),
    '--block-ms', String(options.blockMs ?? 0), '--block-every-ms', String(options.blockEveryMs ?? 300)];
  // The child gets its state root by env and none of this process's els credentials; this process's env is not touched.
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !(CREDENTIAL_ENV as readonly string[]).includes(name)) env[name] = value;
  env.ELANOUS_STATE_DIR = root;
  const child = Bun.spawn(args, { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit', env });
  trackElsServer(child);
  const waiters: ((value: Record<string, unknown>) => void)[] = [];
  const queued: Record<string, unknown>[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let value: Record<string, unknown>;
        try { value = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (value === null || typeof value !== 'object' || !(TAG in value)) continue;
        const waiter = waiters.shift();
        if (waiter) waiter(value); else queued.push(value);
      }
    }
  })();
  const next = (ms: number, what: string): Promise<Record<string, unknown>> => {
    const ready = queued.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`els-typing-latency: the server child did not answer (${what})`)), ms);
      waiters.push((value) => { clearTimeout(timer); resolve(value); });
      void child.exited.then((code) => { clearTimeout(timer); reject(new Error(`els-typing-latency: the server child exited (${code}) before ${what}`)); });
    });
  };
  let ready: Record<string, unknown>;
  try { ready = await next(120_000, 'ready'); } catch (error) { child.kill(); rmSync(root, { recursive: true, force: true }); throw error; }
  const socketPath = String(ready.socketPath);
  // A signal death (SIGKILL below) leaves exitCode null in Bun; `exited` resolves either way.
  const waitGone = async (): Promise<void> => { await child.exited; };
  return {
    root, socketPath, pane: String(ready.pane), panes: Number(ready.panes), serverPid: Number(ready.pid), credential: targetCredential(socketPath),
    serverCpuMicros: async () => { child.stdin.write('cpu\n'); child.stdin.flush(); return Number((await next(60_000, 'cpu')).micros); },
    stop: async () => {
      try { child.stdin.write('stop\n'); child.stdin.flush(); child.stdin.end(); } catch { /* already gone */ }
      const exited = await Promise.race([child.exited.then(() => true), sleep(30_000).then(() => false)]);
      if (!exited) child.kill();
      rmSync(root, { recursive: true, force: true });
    },
    kill: async () => { child.kill('SIGKILL'); await waitGone(); rmSync(root, { recursive: true, force: true }); },
  };
}

/**
 * `attempts` = COMPLETED requests only (answered, refused, failed or timed out); one still in flight is not counted yet.
 * With a window, only requests that completed inside it count; `okPerSec` is the sustained rate of full listings there.
 */
export interface PollerStats {
  readonly attempts: number; readonly ok: number; readonly okPerSec: number; readonly okMs: readonly number[];
  /**
   * ELS-SERVER-MAINLOOP-STARVATION (OP #129204 ④): per-poller slices of the same windowed sample. `perPoller[p]` =
   * { attempts, ok } for poller p only; a poller that answered nothing inside the window has an empty slice, so the
   * «each of the 5 completes every second» assertion sees it as 0, not as an average hidden by the others.
   */
  readonly perPoller: ReadonlyArray<{ attempts: number; ok: number }>;
}

/**
 * `count` clients asking `ls` every `pollMs`. An answer counts as ok only when it is a listing of at least
 * `expectPanes` panes — a refused, failed or timed-out request is an attempt, not load.
 */
export function startPollers(socketPath: string, credential: string, count: number, pollMs: number, expectPanes: number):
  { stats: (window?: { startMs: number; endMs: number }) => PollerStats; stop: () => Promise<void> } {
  let polling = true;
  const startedAt = performance.now();
  const done: { at: number; ok: boolean; ms: number; p: number }[] = [];
  const loops = Array.from({ length: count }, (_, p) => (async () => {
    await sleep((pollMs / count) * p);   // spread like independent clients
    while (polling) {
      const t0 = performance.now();
      const answer = await withTarget(credential, () => requestEls(socketPath, { op: 'ls' })).catch(() => undefined);
      let listed = 0;
      if (answer?.exitCode === 0) {
        try { listed = ((JSON.parse(answer.message) as { panes?: unknown[] }).panes ?? []).length; } catch { listed = 0; }
      }
      // Recorded on completion, so a request still in flight when stats are read is neither ok nor failed.
      const at = performance.now();
      done.push({ at, ok: listed >= expectPanes, ms: round(at - t0), p });
      await sleep(Math.max(0, pollMs - (performance.now() - t0)));
    }
  })());
  return {
    stats: (window) => {
      const startMs = window?.startMs ?? startedAt;
      const endMs = window?.endMs ?? performance.now();
      const inside = done.filter((row) => row.at >= startMs && row.at <= endMs);
      const okMs = inside.filter((row) => row.ok).map((row) => row.ms);
      const seconds = Math.max(0.001, (endMs - startMs) / 1000);
      const perPoller = Array.from({ length: count }, (_, p) => { const mine = inside.filter((row) => row.p === p); return { attempts: mine.length, ok: mine.filter((row) => row.ok).length }; });
      return { attempts: inside.length, ok: okMs.length, okPerSec: round(okMs.length / seconds), okMs, perPoller };
    },
    stop: async () => { polling = false; await Promise.all(loops); },
  };
}

function lsSummary(stats: PollerStats): { lsAttempts: number; lsOk: number; lsOkPerSec: number; lsOkP50Ms: number; lsOkMaxMs: number } {
  const sorted = [...stats.okMs].sort((a, b) => a - b);
  return { lsAttempts: stats.attempts, lsOk: stats.ok, lsOkPerSec: stats.okPerSec, lsOkP50Ms: percentile(sorted, 50), lsOkMaxMs: sorted.at(-1) ?? 0 };
}

async function main(argv: readonly string[]): Promise<number> {
  const flag = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const num = (name: string, fallback: number): number => { const v = flag(name); return v === undefined ? fallback : Number(v); };
  const load = argv.includes('--load');
  const block = { blockMs: num('--block-ms', 0), blockEveryMs: num('--block-every-ms', 300) };
  if (argv.includes('--serve-fixture')) return serveFixture(argv[argv.indexOf('--serve-fixture') + 1]!, { load, rows: num('--rows', 100_000), seats: num('--seats', SEATS.length), ...block });
  const keys = num('--keys', 50);
  const intervalMs = num('--interval', 120);
  const socket = flag('--socket');
  if (socket) {
    // Only the credential of exactly this socket's server, verified; this process's own els tokens are never sent.
    let credential: string;
    try { credential = targetCredential(socket); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
    const scratch = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-lat-pane-'));
    const created = await withTarget(credential, () => requestEls(socket, { op: 'new', ws: 'LAT', cwd: scratch, command: ['/bin/zsh', '-f'] }));
    if (created.exitCode !== 0) { console.error(created.message); rmSync(scratch, { recursive: true, force: true }); return 1; }
    const pane = (JSON.parse(created.message) as { pane: string }).pane;
    try {
      const result = await measureTyping(socket, pane, credential, { keys, intervalMs });
      console.log(JSON.stringify({ mode: 'socket', socket, ...result }));
    } finally {
      await withTarget(credential, () => requestEls(socket, { op: 'close', pane, confirmed: true })).catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
    return 0;
  }
  const server = await spawnIsolatedEls({ load, rows: num('--rows', 100_000), seats: num('--seats', SEATS.length), ...block });
  const pollers = load ? startPollers(server.socketPath, server.credential, num('--pollers', 5), num('--poll-ms', 1_000), server.panes) : undefined;
  try {
    if (load) await sleep(1_500);   // let every poller run at least once
    const result = await measureTyping(server.socketPath, server.pane, server.credential, { keys, intervalMs, serverCpuMicros: server.serverCpuMicros });
    const window = { startMs: result.windowStartMs, endMs: result.windowEndMs };
    console.log(JSON.stringify({ mode: load ? 'isolated+load' : 'isolated', ...(block.blockMs > 0 ? block : {}), ...result,
      ...(pollers ? lsSummary(pollers.stats(window)) : {}) }));
  } finally {
    await pollers?.stop();
    await server.stop();
  }
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
