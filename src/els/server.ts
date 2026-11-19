// els server — the one owner process of the journal (`els serve`). Clients (`els ls/new/read/send`) only send
// requests over a Unix socket in the state dir; they never write the journal. Pane PTYs live in outside holder
// processes (D1a) — this server owns the journal and adopts the holders back after a restart.
// One server per state dir is the supervisor's job (launchd/systemd runs `els serve` once — OP 11-17). Ownership is
// the bound socket, taken BEFORE the journal is read:
//   - bind succeeds → this process is the owner;
//   - the path is taken and a connect succeeds (even a busy server that is slow to answer) → refuse;
//   - the path is taken and a connect is refused (a dead server's socket) → unlink → bind once more;
//   - two `serve` started at the same moment after a crash, both cleaning the dead socket, is NOT supported.

import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { createChildTabs, type ChildSource, type ChildTabs } from './child-tabs.js';
import { createElsCore, type ElsCore, type ElsPty, type ElsResult } from './core.js';
import { elsJournalPath, loadJournal, saveJournal } from './journal.js';
import { holderPty, reattachHolder } from './holder.js';
import { doPolicy, startElsHttp, type ElsHttpBind } from './http.js';
import { startStallAlert, type StallAlert, type StallAlertDeps } from './stall-alert.js';
import { createLineDecoder } from './wire.js';
import { foregroundOf, parsePs, type Foreground } from './foreground.js';
import { createControl } from './control.js';
import { journalControl } from './control-cli.js';
import { peerUid } from './peer-uid.js';
import { peerPid, processIdentity, baselineBeforePidLookup, resolvePeerSeat, type ProcessIdentity } from './peer-seat.js';
type SeatLookup = (pid: number | undefined, baseline?: ProcessIdentity) => ReturnType<typeof resolvePeerSeat> | { pane: string; seat: string } | undefined;

/** This host's name in addresses (`host:ws/tab/pane`): ELANOUS_ELS_HOST, else the short machine name. */
export function elsHostName(): string {
  return process.env.ELANOUS_ELS_HOST?.trim() || hostname().split('.')[0] || 'local';
}

export function elsSocketPath(stateRoot: string = elanousStateRoot()): string {
  return join(stateRoot, 'els', 'els.sock');
}

// 출처: sockaddr_un.sun_path is 104 bytes on macOS (108 on Linux) including the terminating NUL.
const MAX_SOCKET_PATH_BYTES = 103;

/** Why `socketPath` cannot be a Unix socket here, or undefined when it can. */
export function elsSocketPathProblem(socketPath: string): string | undefined {
  const bytes = Buffer.byteLength(socketPath);
  return bytes > MAX_SOCKET_PATH_BYTES
    ? `els: the state dir is too deep for a Unix socket (${socketPath} is ${bytes} bytes; at most ${MAX_SOCKET_PATH_BYTES})`
    : undefined;
}

export type ElsRequest =
  | { readonly op: 'ping' }
  | { readonly op: 'build'; readonly pane: string; readonly sha: string }
  | { readonly op: 'ls' }
  | { readonly op: 'grep'; readonly pattern: string }
  | { readonly op: 'new'; readonly ws: string; readonly cwd: string; readonly command: readonly string[]; readonly title?: string }
  | { readonly op: 'read'; readonly pane: string; readonly at?: { readonly ws: string; readonly tab: string } }
  | { readonly op: 'send'; readonly pane: string; readonly text: string }
  | { readonly op: 'status'; readonly pane: string }
  | { readonly op: 'send-verified'; readonly pane: string; readonly text: string; readonly requireEmpty?: boolean }
  | { readonly op: 'attach'; readonly pane: string; readonly cols?: number; readonly rows?: number }
  | { readonly op: 'input'; readonly bytes: string }
  | { readonly op: 'resize'; readonly cols: number; readonly rows: number }
  | { readonly op: 'reorder'; readonly kind: string; readonly id: string; readonly before?: string }
  | { readonly op: 'close'; readonly pane: string }
  | { readonly op: 'close-workspace'; readonly ws: string }
  | { readonly op: 'do'; readonly pane: string; readonly text: string; readonly from: string; readonly at?: { readonly ws: string; readonly tab: string } }
  | { readonly op: 'input-line'; readonly pane: string; readonly text: string; readonly from: string; readonly at?: { readonly ws: string; readonly tab: string } }
  | { readonly op: 'child'; readonly action: 'start' | 'progress' | 'status' | 'end' | 'pin' | 'unpin' | 'dismiss' | 'tree' | 'summary';
      readonly id?: string; readonly ws?: string; readonly cwd?: string; readonly source?: ChildSource; readonly label?: string;
      readonly parent?: string; readonly line?: string; readonly state?: 'working' | 'blocked' | 'idle'; readonly ok?: boolean; readonly summary?: string };

// 출처: a request line is a small JSON object (a pane ref, a command line or a short text to type); anything larger is
// not a client of this server.
const MAX_REQUEST_CHARS = 1 << 20;

/**
 * Is something listening on `socketPath`? Only a refused or missing socket counts as «nobody»: a connection that is
 * accepted is a live server, however long it takes to answer.
 */
export function elsSocketTaken(socketPath: string): Promise<'live' | 'dead' | 'none'> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.on('connect', () => { socket.destroy(); resolve('live'); });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve(error.code === 'ENOENT' ? 'none' : error.code === 'ECONNREFUSED' ? 'dead' : 'live');
    });
  });
}

const RESULTS_MAX_BYTES = 256 * 1024;
const childTabsOf = new WeakMap<ElsCore, ChildTabs>();
function dispatchChild(tabs: ChildTabs, r: Extract<ElsRequest, { op: 'child' }>): ElsResult {
  const id = r.id ?? '';
  switch (r.action) {
    case 'start': return tabs.start({ id, ws: r.ws ?? '', source: r.source ?? 'harness', label: r.label ?? '',
      ...(r.cwd ? { cwd: r.cwd } : {}), ...(r.parent ? { parent: r.parent } : {}) });
    case 'progress': return tabs.progress(id, r.line ?? '');
    case 'status': return tabs.status(id, r.state ?? 'working', r.line ?? '');
    case 'end': return typeof r.ok === 'boolean' ? tabs.end(id, r.ok, r.summary ?? '') : { exitCode: 2, message: 'els child: end needs ok true|false' };
    case 'pin': return tabs.pin(id);
    case 'unpin': return tabs.unpin(id);
    case 'dismiss': return tabs.dismiss(id);
    case 'tree': return { exitCode: 0, message: JSON.stringify(tabs.tree(r.ws ?? '')) };
    case 'summary': return { exitCode: 0, message: tabs.summary(r.ws ?? '') };
    default: return { exitCode: 2, message: 'els child: unknown action' };
  }
}

async function dispatch(core: ElsCore, request: ElsRequest, stateRoot: string, uid: number | undefined, pid: number | undefined, seatLookup: SeatLookup, baseline: ProcessIdentity | undefined): Promise<ElsResult> {
  switch (request.op) {
    case 'build': return typeof request.pane === 'string' && typeof request.sha === 'string' ? core.reportBuild(request.pane, request.sha) : { exitCode: 2, message: 'els build: pane and sha required' };
    case 'ping': return { exitCode: 0, message: `els server pid ${process.pid}` };
    case 'ls': return core.list();
    case 'grep': return core.grep(request.pattern);
    case 'new': return core.newPane({ ws: request.ws, cwd: request.cwd, command: request.command, ...(request.title ? { title: request.title } : {}) });
    case 'read': {
      // An address (ws/tab/pane) must name exactly that pane; a bare ref keeps the stage-1 lookup.
      if (!request.at) return core.read(request.pane);
      const paneId = core.locate(request.at.ws, request.at.tab, request.pane);
      return paneId ? core.read(paneId) : { exitCode: 1, message: `els read: unknown pane ${request.at.ws}/${request.at.tab}/${request.pane}` };
    }
    case 'send': return core.send(request.pane, request.text);
    case 'status': return core.status(request.pane);
    case 'send-verified': return core.sendVerified(request.pane, request.text, request.requireEmpty === true);
    case 'reorder': return core.reorder({ kind: request.kind, id: request.id, ...(request.before === undefined ? {} : { before: request.before }) });
    case 'close': return core.close(request.pane);
    case 'close-workspace': return core.closeWorkspace(request.ws);
    case 'do': {
      if (typeof request.text !== 'string' || typeof request.from !== 'string') return { exitCode: 2, message: 'els do: text and from are required' };
      if (!request.at) return core.do(request.pane, request.text, request.from);
      const paneId = core.locate(request.at.ws, request.at.tab, request.pane);
      return paneId ? core.do(paneId, request.text, request.from) : { exitCode: 1, message: `els do: unknown pane ${request.at.ws}/${request.at.tab}/${request.pane}` };
    }
    case 'input-line': {
      const at = request.at;
      const validAt = at === undefined || (at !== null && typeof at === 'object' && typeof at.ws === 'string' && typeof at.tab === 'string');
      const valid = typeof request.pane === 'string' && typeof request.text === 'string' && typeof request.from === 'string' && validAt;
      const lookup = journalControl(loadJournal(elsJournalPath(stateRoot)));
      const ref = valid ? (at ? core.locate(at.ws, at.tab, request.pane) : request.pane) : undefined;
      const target = ref ? await lookup.lookup(ref) : undefined;
      let seat: { pane: string; seat: string } | undefined;
      try { seat = uid === undefined ? undefined : await seatLookup(pid, baseline); } catch { seat = undefined; }
      const door = createControl({ stateDir: dirname(elsSocketPath(stateRoot)), resolve: lookup.resolve,
        guard: () => !valid || !target ? 'invalid input request or unknown target' : undefined,
        execute: async (input) => {
          // Authorization may have gone stale while intent audit was written. Re-resolve immediately
          // before enqueue/write; any ambiguity or changed caller fails closed.
          let current: { pane: string; seat: string } | undefined;
          try { current = uid === undefined ? undefined : await seatLookup(pid, baseline); } catch { /* deny */ }
          if (!seat || !current || current.pane !== seat.pane || current.seat !== seat.seat)
            return { exitCode: 1, message: 'els input: denied (caller pane changed)' };
          return core.inputLine(input.target.pane, input.text ?? '', request.from, input.queueAudit);
        } });
      const result = await door.run({ principal: { id: uid === undefined ? 'unauthenticated' : `local:${uid}`, kind: 'cli', ...(seat ? { callerPane: seat.pane, callerSeat: seat.seat } : {}) }, from: typeof request.from === 'string' ? request.from : '', action: 'input', target: target ?? { workspace: '', pane: '', shell: false }, text: typeof request.text === 'string' ? request.text : '' });
      return result.ok ? { exitCode: result.exitCode, message: result.message } : { exitCode: 1, message: result.message };
    }
    case 'child': {
      const tabs = childTabsOf.get(core);
      return tabs ? dispatchChild(tabs, request) : { exitCode: 1, message: 'els child: not available' };
    }
    default: return { exitCode: 2, message: 'els: unknown request' };
  }
}

// 출처: 내부 문서 `ELS-SIDETAB-SERVER` «attach» — 10 frames a second is smooth for typing and cheap: a frame is only
// sent when the rendered screen differs from the last one sent.
const ATTACH_POLL_MS = 100;
// 출처: orders/ELS-FIRST-RUN-UX-1119.md 6 «폴링은 목록 갱신에만» — with an output subscription the screen is never polled; a pane
// that ends without printing is still noticed this often (a liveness check only, no repaint).
const ATTACH_LIVENESS_MS = 1_000;
// 출처: 내부 문서 `ELS-SIDETAB-SERVER` «attach» — a client that does not read stops getting frames once this much is queued.
const ATTACH_MAX_QUEUED_BYTES = 1_048_576;

/** A long-lived connection for one pane: frames out (only when the screen changed), `input`/`resize` lines in. The
 *  pane is never touched by the client closing — detach is the connection ending. */
function serveAttach(core: ElsCore, socket: Socket, request: Extract<ElsRequest, { op: 'attach' }>, lines: { onLine: (handler: (line: string) => void) => void }): void {
  if (socket.destroyed) return;
  const paneId = typeof request.pane === 'string' ? core.paneExists(request.pane) : undefined;
  if (!paneId) { socket.end(`${JSON.stringify({ type: 'end', exitCode: 1, message: `els attach: unknown pane ${String(request.pane)}` })}\n`); return; }
  if (request.cols !== undefined && request.rows !== undefined) {
    const sized = core.resize(paneId, request.cols, request.rows);
    if (sized.exitCode !== 0 && sized.exitCode !== 1) { socket.end(`${JSON.stringify({ type: 'end', exitCode: sized.exitCode, message: sized.message })}\n`); return; }
  }
  let seq = 0;
  let lastKey: string | undefined;
  let busy = false;
  let closed = false;
  const send = (value: object): void => { if (!closed && !socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
  const tick = async (): Promise<void> => {
    if (busy || closed || socket.writableLength > ATTACH_MAX_QUEUED_BYTES) return;
    busy = true;
    try {
      const screen = await core.frame(paneId);
      if (closed) return;
      if (screen.exitCode !== 0) { send({ type: 'end', exitCode: 1, message: screen.message }); socket.end(); return; }
      const size = core.paneSize(paneId);
      // A resize alone is a change too: the client repaints at the new size even when the text is the same.
      const key = `${size.cols}x${size.rows}\n${screen.message}`;
      if (key !== lastKey) {
        lastKey = key;
        send({ type: 'frame', pane: paneId, seq: ++seq, cols: size.cols, rows: size.rows, screen: screen.message });
      }
      if (!core.paneIsLive(paneId)) { send({ type: 'end', exitCode: 0, message: 'pane exited' }); socket.end(); }
    } finally { busy = false; }
  };
  const poke = (): void => { tick().catch(() => { busy = false; }); };
  // 출처: seat-state/OP/orders/ELS-FIRST-RUN-UX-1119.md ④ p95 ≤ 50ms — PTY 데이터 이벤트 즉시 푸시 (attach 연결 = pane 스트림 구독)
  const sub = core.onOutput?.(paneId, () => poke());
  // ELS-FIRST-RUN-FU3 ②: subscribed → no screen poll (no re-render, no re-sent frame); only a liveness check. A PTY without
  // an output event keeps the old 100 ms poll.
  const liveness = (): void => {
    if (closed || core.paneIsLive(paneId)) return;
    poke();   // one last frame (the screen it left) and the «pane exited» end
  };
  const timer = sub ? setInterval(liveness, ATTACH_LIVENESS_MS) : setInterval(poke, ATTACH_POLL_MS);
  timer.unref?.();
  const stop = (): void => { closed = true; clearInterval(timer); sub?.dispose(); };
  socket.on('close', stop);
  socket.on('error', stop);
  poke();
  lines.onLine((line) => {
    let message: ElsRequest;
    try { message = JSON.parse(line) as ElsRequest; } catch { send({ type: 'error', message: 'els attach: malformed line' }); return; }
    if (!isRequestObject(message)) { send({ type: 'error', message: 'els attach: malformed line' }); return; }
    if (message.op === 'input') {
      const done = core.input(paneId, message.bytes);
      if (done.exitCode !== 0) send({ type: 'error', message: done.message });
    } else if (message.op === 'resize') {
      const done = core.resize(paneId, message.cols, message.rows);
      if (done.exitCode !== 0) send({ type: 'error', message: done.message });
      else poke();
    } else send({ type: 'error', message: 'els attach: only input and resize are accepted here' });
  });
}

const isRequestObject = (value: unknown): value is ElsRequest => typeof value === 'object' && value !== null && !Array.isArray(value);

function serveConnection(ready: Promise<ElsCore | undefined>, socket: Socket, stateRoot: string, seatLookup: SeatLookup): void {
  // Capture before any credential syscall; sampling afterward permits a newly reused PID.
  const beforePidLookup = Date.now();
  const uid = peerUid(socket);
  const pid = peerPid(socket);
  const baseline = baselineBeforePidLookup(processIdentity(pid), pid, beforePidLookup);
  let handled = false;
  /** Once the first line was `attach`: where later lines go. Until the owner is ready they are kept, then replayed in order. */
  let attachLine: ((line: string) => void) | undefined;
  const earlyLines: string[] = [];
  const answer = (result: ElsResult): void => { socket.end(`${JSON.stringify(result)}\n`); };
  const lines = createLineDecoder((line) => {
    if (attachLine) { attachLine(line); return; }
    if (handled) return;
    handled = true;
    let request: ElsRequest;
    try { request = JSON.parse(line) as ElsRequest; }
    catch { answer({ exitCode: 2, message: 'els: malformed request' }); return; }
    // Valid JSON that is not an object (null, 7, "x", [..]) has no `.op`: refuse this connection, never throw in the owner.
    if (!isRequestObject(request)) { answer({ exitCode: 2, message: 'els: malformed request' }); return; }
    if (request.op === 'attach') {
      // Lines can arrive in the same chunk as the attach line, before `ready` resolves: keep them, never drop them.
      attachLine = (next) => { earlyLines.push(next); };
      void ready.then((core) => {
        if (!core) { answer({ exitCode: 1, message: 'els: the server is stopping' }); return; }
        serveAttach(core, socket, request, { onLine: (handler) => {
          for (const early of earlyLines.splice(0)) handler(early);
          attachLine = handler;
        } });
      });
      return;
    }
    void ready
      .then((core) => core ? dispatch(core, request, stateRoot, uid, pid, seatLookup, baseline) : { exitCode: 1, message: 'els: the server is stopping' } as ElsResult)
      .catch((error: unknown): ElsResult => ({ exitCode: 1, message: `els: ${error instanceof Error ? error.message : String(error)}` }))
      .then(answer);
  });
  socket.on('data', (chunk: Buffer) => {
    lines.push(chunk);
    if (!handled && lines.pending() > MAX_REQUEST_CHARS) { handled = true; answer({ exitCode: 2, message: 'els: request too large' }); }
    else if (attachLine && lines.pending() > MAX_REQUEST_CHARS) socket.destroy();
  });
  socket.on('error', () => { /* the client went away; its request may still finish */ });
}

/** Pane PTYs live in outside holder processes (D1a): src/els/holder.ts holderPty is the default spawn; the
 *  registry-owned registryPty of the old contract is gone — a server stop now releases the panes instead of killing them. */

/** The real process table: one `ps` run (pid, the terminal's foreground group, the command line). */
function psSnapshot(): Promise<string> {
  return new Promise((resolve) => {
    const { execFile } = require('node:child_process') as typeof import('node:child_process');
    execFile('ps', ['-A', '-o', 'pid=,tpgid=,args='], { timeout: 2_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error ? '' : stdout));
  });
}

/** ELS-PANE-AGENT-DETECT: read every live pane's foreground (a failed `ps` changes nothing). */
export async function probeForegrounds(core: ElsCore, ps: () => Promise<string> = psSnapshot): Promise<string[]> {
  const panes = core.shellPids();
  if (panes.length === 0) return core.setForegrounds(new Map());
  const text = await ps();
  if (!text) return [];
  const table = parsePs(text);
  const next = new Map<string, Foreground>();
  for (const { pane, pid } of panes) { const fg = foregroundOf(pid, table); if (fg) next.set(pane, fg); }
  return core.setForegrounds(next);
}

function listen(server: Server, socketPath: string): Promise<NodeJS.ErrnoException | undefined> {
  return new Promise((resolve) => {
    const onError = (error: NodeJS.ErrnoException): void => { server.off('listening', onListening); resolve(error); };
    const onListening = (): void => { server.off('error', onError); resolve(undefined); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}

export interface ElsServerOptions {
  readonly stateRoot?: string;
  /** Dependency seam for isolated tests, never supplied by wire requests. */
  readonly seatLookup?: SeatLookup;
  readonly spawn?: (command: readonly string[], cwd: string, title: string, env: Readonly<Record<string, string>>) => ElsPty;
  /** Open the read-only HTTP window for federated els (stage 2). */
  readonly http?: ElsHttpBind;
  readonly hostName?: string;
  /** Where a finished child's one result line goes. Default: `<state>/els/child-results.jsonl` (one JSON line each). */
  readonly notifyParent?: (ws: string, line: string) => void;
  /** ELS-PANE-AGENT-DETECT: the process table (`ps -A -o pid=,tpgid=,args=`); tests hand in text. */
  readonly ps?: () => Promise<string>;
  /** Watch busy panes for stalls (mail + receipt). Overrides of the poller's own defaults for tests; `false` disables. */
  readonly stall?: StallAlertDeps | false;
}

/** Become the owner, then load the journal. Resolves to the running server, or to a refusal. */
export async function startElsServer(options: ElsServerOptions = {}): Promise<{ server: Server; core: ElsCore; close: () => Promise<void> } | ElsResult> {
  const stateRoot = options.stateRoot ?? elanousStateRoot();
  const socketPath = elsSocketPath(stateRoot);
  const journalPath = elsJournalPath(stateRoot);
  const tooLong = elsSocketPathProblem(socketPath);
  if (tooLong) return { exitCode: 1, message: tooLong };
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(socketPath), 0o700);

  let markReady: (core: ElsCore | undefined) => void = () => {};
  const ready = new Promise<ElsCore | undefined>((resolve) => { markReady = resolve; });
  const server = createServer((socket) => serveConnection(ready, socket, stateRoot, options.seatLookup ?? resolvePeerSeat));
  // 1. Own the socket first; the journal is not touched until this process owns it.
  let failed = await listen(server, socketPath);
  if (failed?.code === 'EADDRINUSE') {
    const taken = await elsSocketTaken(socketPath);
    if (taken === 'live') return { exitCode: 1, message: `els serve: a server already answers on ${socketPath}` };
    // A dead server's socket: connect was refused → unlink → bind once more.
    if (taken === 'dead') { try { unlinkSync(socketPath); } catch { /* removed meanwhile */ } }
    failed = await listen(server, socketPath);
  }
  if (failed) return { exitCode: 1, message: `els serve: cannot listen on ${socketPath}: ${failed.message}` };
  chmodSync(socketPath, 0o600);

  // 2. Owner now: load the journal (requests that arrived meanwhile wait for this).
  const core = createElsCore({ load: () => loadJournal(journalPath), save: (journal) => saveJournal(journalPath, journal),
    // D1a: pane PTYs live in outside holders — the default, no option flag. A restart adopts them back (reattachHolder).
    spawn: (command, cwd, title, env) => (options.spawn ?? holderPty(stateRoot))(command, cwd, title, { ...env, ELANOUS_ELS_SOCKET: socketPath }),
    reattach: (pane) => reattachHolder(stateRoot, pane.id) });
  const resultsPath = join(dirname(socketPath), 'child-results.jsonl');
  const notifyParent = options.notifyParent ?? ((ws: string, line: string) => {
    // Bounded: past 256 KiB the file becomes `.1` (one older generation), so unread results cannot grow without limit.
    try { if (statSync(resultsPath).size > RESULTS_MAX_BYTES) renameSync(resultsPath, `${resultsPath}.1`); } catch { /* no file yet */ }
    appendFileSync(resultsPath, `${JSON.stringify({ at: new Date().toISOString(), ws, line })}\n`, { mode: 0o600 });
  });
  childTabsOf.set(core, createChildTabs({ core, notifyParent }));
  let httpServer: Server | undefined;
  // The busy-pane stall watcher: started once the core owns the journal, stopped in close().
  let stallAlert: StallAlert | undefined;
  // Queued `do` lines go out once a pane's turn is no longer running.
  const drainTimer = setInterval(() => { void core.drain(); }, 1_000);
  // ELS-PANE-AGENT-DETECT: once a second, one `ps` snapshot → what each live pane runs in its foreground now.
  const foregroundTimer = setInterval(() => { void probeForegrounds(core, options.ps); }, 1_000);
  foregroundTimer.unref();
  drainTimer.unref();
  const close = async (): Promise<void> => {
    clearInterval(drainTimer);
    clearInterval(foregroundTimer);
    stallAlert?.stop();
    core.stopAll();
    if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { unlinkSync(socketPath); } catch { /* already gone */ }
  };
  const refused = core.start();
  if (refused) {
    markReady(undefined);
    await close();
    return refused;
  }
  // 2.5. Busy panes that produce no new output for STALL_MS alert the owner (mail + receipt);
  // `stall: false` or ELANOUS_ELS_STALL_MS=0 disables the watcher outright.
  if (options.stall !== false) stallAlert = startStallAlert(core, { stateRoot, ...(options.stall ?? {}) });
  // 3. The read window for federated hosts, when asked for: it answers from this owner's journal in memory.
  if (options.http) {
    try { httpServer = await startElsHttp(core, options.hostName ?? elsHostName(), options.http, doPolicy(stateRoot)); }
    catch (error) {
      markReady(undefined);
      await close();
      return { exitCode: 1, message: `els serve: cannot open --http ${options.http.host}:${options.http.port}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  markReady(core);
  return { server, core, close };
}
