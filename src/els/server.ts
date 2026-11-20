// els server — the one owner process of the journal (`els serve`). Clients (`els ls/new/read/send`) only send
// requests over a Unix socket in the state dir; they never write the journal. Pane PTYs live in outside holder
// processes (D1a) — this server owns the journal and adopts the holders back after a restart.
// One server per state dir is the supervisor's job (launchd/systemd runs `els serve` once — OP 11-17). Ownership is
// the bound socket, taken BEFORE the journal is read:
//   - bind succeeds → this process is the owner;
//   - the path is taken and a connect succeeds (even a busy server that is slow to answer) → refuse;
//   - the path is taken and a connect is refused (a dead server's socket) → unlink → bind once more;
//   - two `serve` started at the same moment after a crash, both cleaning the dead socket, is NOT supported.

import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { createChildTabs, type ChildSource, type ChildTabs } from './child-tabs.js';
import { createElsCore, type ElsCore, type ElsPty, type ElsResult } from './core.js';
import { elsJournalPath, loadJournal, saveJournal } from './journal.js';
import { warmLoginEnv } from './login-env-handoff.js';
import { holderPty, consumeScreenSnapshot, reattachHolder, restoreScreenFromSnapshot } from './holder.js';
import { doPolicy, startElsHttp, type ElsHttpBind } from './http.js';
import { startStallAlert, type StallAlert, type StallAlertDeps } from './stall-alert.js';
import { startElsHttpV1 } from './http-v1.js';
import { appendSendAudit, type ControlExecute } from './control.js';
import { createLineDecoder } from './wire.js';
import { serveSubscribe } from './subscribe.js';
import { foregroundOf, parsePs, type Foreground } from './foreground.js';
import { createControl } from './control.js';
import { journalControl } from './control-cli.js';
import { peerUid } from './peer-uid.js';
import { peerPid, processIdentity, baselineBeforePidLookup, resolvePeerSeat, resolveAncestorPane, type ProcessIdentity } from './peer-seat.js';
type SeatLookup = (pid: number | undefined, baseline?: ProcessIdentity) => ReturnType<typeof resolvePeerSeat> | { pane: string; seat: string } | undefined;
import { createOutboundWebhooks } from './webhook-out.js';

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
  | { readonly op: 'auth'; readonly token?: string; readonly pid?: number }
  | { readonly op: 'build'; readonly pane: string; readonly sha: string }
  | { readonly op: 'ls' }
  | { readonly op: 'subscribe' }
  | { readonly op: 'grep'; readonly pattern: string }
  | { readonly op: 'new'; readonly ws: string; readonly cwd: string; readonly command: readonly string[]; readonly title?: string }
  | { readonly op: 'read'; readonly pane: string; readonly at?: { readonly ws: string; readonly tab: string } }
  | { readonly op: 'send'; readonly pane: string; readonly text: string }
  | { readonly op: 'status'; readonly pane: string }
  | { readonly op: 'send-verified'; readonly pane: string; readonly text: string; readonly requireEmpty?: boolean }
  | { readonly op: 'attach'; readonly pane: string; readonly cols?: number; readonly rows?: number }
  // #38608 REVIEW must ② — `input` is the raw person path (attach keystrokes, `els pane run`/`send-keys`):
  // control bytes stay raw by design. A top-level input names its pane; an attach stream supplies the attached pane.
  | { readonly op: 'input'; readonly bytes: string; readonly pane?: string }
  | { readonly op: 'resize'; readonly cols: number; readonly rows: number }
  /** Attach connection only: move this view `lines` up (positive) or down into the pane's scrollback; any typed input returns to the bottom. */
  | { readonly op: 'scroll'; readonly lines: number }
  | { readonly op: 'reorder'; readonly kind: string; readonly id: string; readonly before?: string }
  | { readonly op: 'rename'; readonly kind: string; readonly id: string; readonly name: string }
  /** `confirmed`: the person said yes (the view's y / button) — the control door refuses close without it (#39143). */
  | { readonly op: 'close'; readonly pane: string; readonly confirmed?: boolean }
  | { readonly op: 'close-workspace'; readonly ws: string; readonly confirmed?: boolean }
  | { readonly op: 'do'; readonly pane: string; readonly text: string; readonly from: string; readonly at?: { readonly ws: string; readonly tab: string } }
  | { readonly op: 'snapshot'; readonly pane: string }
  | { readonly op: 'record'; readonly pane: string }
  | { readonly op: 'input-line'; readonly pane: string; readonly text: string; readonly from: string; readonly at?: { readonly ws: string; readonly tab: string } }
  | { readonly op: 'seat-set'; readonly seat: string }
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
// #38610 REVIEW must ① — the outbound webhooks this owner server runs, on the real boot path.
const webhookOutOf = new WeakMap<ElsCore, ReturnType<typeof createOutboundWebhooks>>();
const childEventSeqs = new WeakMap<ElsCore, Map<string, number>>();

/**
 * #38610 REVIEW must ① — the real agent-event production point: a child lifecycle line this server
 * just produced is fanned out to every subscribed outbound webhook, non-blocking and fire-and-forget
 * (a webhook that fails, hangs or dies never slows the event flow and never kills the owner).
 */
function emitChildWebhook(core: ElsCore, request: Extract<ElsRequest, { op: 'child' }>): void {
  const webhooks = webhookOutOf.get(core);
  if (!webhooks) return;
  try {
    const seqs = childEventSeqs.get(core) ?? new Map<string, number>();
    childEventSeqs.set(core, seqs);
    const pane = request.id ? `child:${request.id}` : request.ws ? `ws:${request.ws}` : 'child';
    const seq = (seqs.get(pane) ?? 0) + 1;
    seqs.set(pane, seq);
    void webhooks.deliver({ op: 'event', v: 1, pane, seq, at: Date.now(), event: { kind: 'child', action: request.action, ...(typeof request.ok === 'boolean' ? { ok: request.ok } : {}) } })
      .catch(() => { /* a delivery failure is audited and dead-lettered inside; never the owner's problem */ });
  } catch { /* the webhook fan-out never breaks the child path */ }
}
export function dispatchChild(tabs: ChildTabs, r: Extract<ElsRequest, { op: 'child' }>): ElsResult {
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

// `els record`: pane -> the live recording and the dispose of its PTY tap (classic dispatch creates the recorder, this
// host pipes the pane's output in). A second `els record <pane>` stops it and saves the .cast; a server close drains the map.
// Contract (JUD-B #114149): the recordings map is looked up BEFORE the pane's existence is, by the pane id or by the exact
// ref the recording was started with, so «record → close pane → record» still returns the path of the saved .cast and
// leaves the store empty (a closed pane never strands its recording). The door still judges that stop by the pane's workspace,
// which a closed pane no longer has: the OP seat / owner-registered OP (who also does the confirmed close) can stop it; a HAND-* seat
// is refused fail-closed (a closed pane gives it no workspace to own). A pane that merely exits stays in the journal, so
// the same call stops it. Server close stops the recording and forgets it WITHOUT saving a .cast (nothing to answer to).
type LiveRecording = { recordingId: string; paneId: string; refs: ReadonlySet<string>; dispose: () => void };
const recordings = new WeakMap<ElsCore, Map<string, LiveRecording>>();

/** Server close: every recording still running is stopped (its handle ends) and its store entry removed, not just its tap released. */
function disposeRecordings(core: ElsCore): void {
  const { dispatchStopPtyRecording } = require('../tool-runtime/pty-recording-runtimes.js') as typeof import('../tool-runtime/pty-recording-runtimes.js');
  const { getRecordingStore } = require('../capture/recording-store.js') as typeof import('../capture/recording-store.js');
  const store = getRecordingStore();
  for (const live of recordings.get(core)?.values() ?? []) {
    try { live.dispose(); } catch { /* a tap that is already gone */ }
    try { dispatchStopPtyRecording({ recordingId: live.recordingId }, store); } catch { /* already stopped */ }
    store.forget(live.recordingId);
  }
  recordings.delete(core);
}

/** Artifacts live under the state root, owner-only; the file name is built from sanitized parts + random bytes, never from request text; a snapshot keeps one file per pane (latest overwrites, so calls cannot grow the directory). */
function writeArtifact(stateRoot: string, kind: string, paneId: string, ext: string, body: string | Buffer, latestOnly = false): string {
  const dir = join(stateRoot, 'artifacts');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${kind}-${paneId.replace(/[^A-Za-z0-9_-]/g, '_')}${latestOnly ? '' : `-${randomBytes(4).toString('hex')}`}.${ext}`);
  writeFileSync(path, body, { mode: 0o600 });
  // `mode` only applies to a NEW file/dir: an older file (snapshot overwrites one) or a wider artifacts dir keeps its permissions, so tighten both (best effort).
  try { chmodSync(path, 0o600); } catch { /* the write itself succeeded */ }
  try { chmodSync(dir, 0o700); } catch { /* not ours to change */ }
  return path;
}

async function dispatch(core: ElsCore, request: ElsRequest, parent: SpawnParent | undefined, stateRoot: string, uid: number | undefined, pid: number | undefined, seatLookup: SeatLookup, baseline: ProcessIdentity | undefined, firstSeat: (() => Promise<{ pane: string; seat: string } | undefined>) | undefined, sendAuditDir: string): Promise<ElsResult> {
  switch (request.op) {
    case 'build': return typeof request.pane === 'string' && typeof request.sha === 'string' ? core.reportBuild(request.pane, request.sha) : { exitCode: 2, message: 'els build: pane and sha required' };
    case 'ping': return { exitCode: 0, message: `els server pid ${process.pid}` };
    case 'rename': return typeof request.kind === 'string' && typeof request.id === 'string' && typeof request.name === 'string'
      ? core.rename({ kind: request.kind, id: request.id, name: request.name })
      : { exitCode: 2, message: 'els rename: kind, id and name are required' };
    case 'ls': return core.list();
    case 'grep': return core.grep(request.pattern);
    case 'new': return core.newPane({ ws: request.ws, cwd: request.cwd, command: request.command, ...(request.title ? { title: request.title } : {}), ...(parent ? { parent } : {}) });
    case 'read': {
      // An address (ws/tab/pane) must name exactly that pane; a bare ref keeps the stage-1 lookup.
      if (!request.at) return core.read(request.pane);
      const paneId = core.locate(request.at.ws, request.at.tab, request.pane);
      return paneId ? core.read(paneId) : { exitCode: 1, message: `els read: unknown pane ${request.at.ws}/${request.at.tab}/${request.pane}` };
    }
    case 'send': {
      // #90792 P0 ④ — every send that reaches the owner over its socket leaves one audit line in the door's
      // ledger (the door already audits its own requests; this is the socket path). Same line shape, and the
      // text only as its length and its sha256 — never the raw text.
      const done = await core.send(request.pane, request.text);
      const ws = core.workspaceOf(request.pane);
      appendSendAudit(sendAuditDir, { op: 'send', pane: request.pane, text: request.text, exitCode: done.exitCode, ...(ws ? { workspace: ws.name } : {}) });
      return done;
    }
    case 'status': return core.status(request.pane);
    case 'send-verified': return core.sendVerified(request.pane, request.text, request.requireEmpty === true);
    case 'input': {
      // #38608 REVIEW must ② — the person path (attach, `els pane run`/`send-keys`): raw bytes, no cleaning.
      // A top-level input names its pane; an attach stream routes input through its own pane binding instead.
      if (request.pane === undefined) return { exitCode: 2, message: 'els input: a pane is required' };
      const done = core.input(request.pane, request.bytes);
      // #90792 P0 ④ — send-keys/run are the send family too: one audit line per execution.
      const ws = core.workspaceOf(request.pane);
      appendSendAudit(sendAuditDir, { op: 'input', pane: request.pane, text: request.bytes, exitCode: done.exitCode, ...(ws ? { workspace: ws.name } : {}) });
      return done;
    }
    case 'reorder': return core.reorder({ kind: request.kind, id: request.id, ...(request.before === undefined ? {} : { before: request.before }) });
    case 'close': return core.close(request.pane);
    case 'close-workspace': return core.closeWorkspace(request.ws);
    case 'do': {
      if (typeof request.text !== 'string' || typeof request.from !== 'string') return { exitCode: 2, message: 'els do: text and from are required' };
      if (!request.at) return core.do(request.pane, request.text, request.from);
      const paneId = core.locate(request.at.ws, request.at.tab, request.pane);
      return paneId ? core.do(paneId, request.text, request.from) : { exitCode: 1, message: `els do: unknown pane ${request.at.ws}/${request.at.tab}/${request.pane}` };
    }
    case 'snapshot': {
      const paneId = core.paneExists(request.pane);
      if (!paneId) return { exitCode: 1, message: `els snapshot: unknown pane ${request.pane}` };
      // The owner's own render feeds the classic engine (captureImage = the call dispatchScreenshot makes once it has ANSI).
      const frame = await core.frame(paneId);
      if (frame.exitCode !== 0) return { exitCode: 1, message: `els snapshot: ${frame.message}` };
      try {
        const { captureImage } = require('../capture/engine.js') as typeof import('../capture/engine.js');
        const shot = await captureImage({ target: { kind: 'pane', paneId }, format: 'svg', dims: core.paneSize(paneId), source: () => frame.message }, {});
        return { exitCode: 0, message: JSON.stringify({ path: writeArtifact(stateRoot, 'snapshot', paneId, 'svg', shot.body, true) }) };
      } catch (error) {
        return { exitCode: 1, message: `els snapshot: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    case 'record': {
      // Stop path first: a recording is found by id/ref even when its pane was closed meanwhile (see `recordings`).
      // A pane that still resolves wins; the start-time ref only names a recording once its pane is gone (a reused name cannot hijack it).
      const resolved = core.paneExists(request.pane);
      const known = [...(recordings.get(core)?.values() ?? [])].find((r) => resolved === undefined ? r.paneId === request.pane || r.refs.has(request.pane) : r.paneId === resolved);
      const paneId = resolved ?? known?.paneId;
      if (!paneId) return { exitCode: 1, message: `els record: unknown pane ${request.pane}` };
      const { dispatchRecordPtyOutput, dispatchStopPtyRecording } = require('../tool-runtime/pty-recording-runtimes.js') as typeof import('../tool-runtime/pty-recording-runtimes.js');
      const { getRecordingStore } = require('../capture/recording-store.js') as typeof import('../capture/recording-store.js');
      const store = getRecordingStore();
      const live = known ?? recordings.get(core)?.get(paneId);
      if (live) { // second call: stop and keep the artifact
        live.dispose();
        recordings.get(core)?.delete(paneId);
        const out = dispatchStopPtyRecording({ recordingId: live.recordingId }, store);
        store.forget(live.recordingId); // the .cast is in `out`; a finished recording must not stay in the store
        if (out.asciicast === undefined) return { exitCode: 1, message: `els record: no asciicast for ${live.recordingId}` };
        return { exitCode: 0, message: JSON.stringify({ recordingId: live.recordingId, path: writeArtifact(stateRoot, 'record', paneId, 'cast', out.asciicast) }) };
      }
      const size = core.paneSize(paneId);
      const out = dispatchRecordPtyOutput({ source: { paneId }, cols: size.cols, rows: size.rows }, store);
      const entry = store.get(out.recordingId);
      const tap = entry ? core.onOutput?.(paneId, (data) => { try { entry.handle.write(data, 'o'); } catch { /* stopped meanwhile */ } }) : undefined;
      if (!tap) { // no stream to record: undo the store entry the start made, so failed calls cannot accumulate entries
        try { dispatchStopPtyRecording({ recordingId: out.recordingId }, store); } catch { /* already stopped */ }
        store.forget(out.recordingId);
        return { exitCode: 1, message: 'els record: the pane has no live PTY stream' };
      }
      const map = recordings.get(core) ?? new Map<string, LiveRecording>();
      map.set(paneId, { recordingId: out.recordingId, paneId, refs: new Set([request.pane, paneId]), dispose: () => tap.dispose() });
      recordings.set(core, map);
      return { exitCode: 0, message: JSON.stringify({ recordingId: out.recordingId, pane: paneId }) };
    }
    case 'input-line': {
      const at = request.at;
      const validAt = at === undefined || (at !== null && typeof at === 'object' && typeof at.ws === 'string' && typeof at.tab === 'string');
      const valid = typeof request.pane === 'string' && typeof request.text === 'string' && typeof request.from === 'string' && validAt;
      const lookup = journalControl(loadJournal(elsJournalPath(stateRoot)));
      const ref = valid ? (at ? core.locate(at.ws, at.tab, request.pane) : request.pane) : undefined;
      const target = ref ? await lookup.lookup(ref) : undefined;
      let seat: { pane: string; seat: string } | undefined;
      try { seat = uid === undefined ? undefined : firstSeat ? await firstSeat() : await seatLookup(pid, baseline); } catch { seat = undefined; }
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
      const result = tabs ? dispatchChild(tabs, request) : { exitCode: 1, message: 'els child: not available' } as ElsResult;
      // #38610 REVIEW must ① — a recorded child lifecycle line is a real agent event: it also goes
      // to the outbound webhooks, fire-and-forget, after the local result is already in hand.
      if (tabs && result.exitCode === 0) emitChildWebhook(core, request);
      return result;
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

// 출처: serveConnection 의 «els: the server is stopping» 과 같은 어휘 — attach-client.ts 의 SERVER_AWAY 가 기다려 넘기는
// 서버 떠남 말(코드 1: attach-app 과 `els attach` 뷰 모두 이 end 를 재기동 대기로 탄다).
// 출처: a stopping server waits this long for an attach peer to take its end line and close; the line is a few dozen bytes
// on a local socket, so a healthy client has it in well under a millisecond.
const ATTACH_STOP_GRACE_MS = 1_000;
const SERVER_STOPPING_END = `${JSON.stringify({ type: 'end', exitCode: 1, message: 'the server is stopping' })}\n`;

/** D1a must-1(JUD-B #107693 · OP #107696): 이 서버의 살아 있는 attach 연결들 — close() 는 stopAll() «앞에» 이들을
 *  «the server is stopping» 으로 끝낸다. 홀더가 pane 을 살려 두는 정지에서 «pane exited» 를 보내면 클라가 자식이 죽은
 *  줄로 뷰를 끊으므로, 그 end 는 진짜 자식 종료만 뜻해야 한다. */
interface AttachState {
  readonly sockets: Set<Socket>;
  stopping: boolean;
}

/** A long-lived connection for one pane: frames out (only when the screen changed), `input`/`resize` lines in. The
 *  pane is never touched by the client closing — detach is the connection ending. */
function serveAttach(core: ElsCore, socket: Socket, request: Extract<ElsRequest, { op: 'attach' }>, lines: { onLine: (handler: (line: string) => void) => void }, attachState: AttachState, judge?: (message: ElsRequest) => { readonly allow: boolean; readonly reason?: string }): void {
  if (socket.destroyed) return;
  if (attachState.stopping) { socket.end(SERVER_STOPPING_END); return; }
  const paneId = typeof request.pane === 'string' ? core.paneExists(request.pane) : undefined;
  if (!paneId) { socket.end(`${JSON.stringify({ type: 'end', exitCode: 1, message: `els attach: unknown pane ${String(request.pane)}` })}\n`); return; }
  if (request.cols !== undefined && request.rows !== undefined) {
    const sized = core.resize(paneId, request.cols, request.rows);
    if (sized.exitCode !== 0 && sized.exitCode !== 1) { socket.end(`${JSON.stringify({ type: 'end', exitCode: sized.exitCode, message: sized.message })}\n`); return; }
  }
  attachState.sockets.add(socket);
  let seq = 0;
  let lastKey: string | undefined;
  let shownBack = 0;
  let back = 0;                  // how far this view is scrolled above the live bottom
  let busy = false;
  let closed = false;
  const send = (value: object): void => { if (!closed && !socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
  const tick = async (): Promise<void> => {
    if (busy || closed || socket.writableLength > ATTACH_MAX_QUEUED_BYTES) return;
    busy = true;
    try {
      const asked = back;
      const screen = await core.frame(paneId, asked);
      if (closed) return;
      if (screen.exitCode !== 0) { send({ type: 'end', exitCode: 1, message: screen.message }); socket.end(); return; }
      const size = core.paneSize(paneId);
      // A resize alone is a change too: the client repaints at the new size even when the text is the same.
      const shown = Number(/^\[screen \d+x\d+ scrolled-back=(\d+)\]\n/.exec(screen.message)?.[1] ?? 0);
      shownBack = shown;
      back = Math.max(0, back - (asked - shown));   // the emulator clamps to what it kept; scrolls that arrived meanwhile stay
      const key = `${size.cols}x${size.rows}\n${screen.message}`;
      if (key !== lastKey) {
        lastKey = key;
        send({ type: 'frame', pane: paneId, seq: ++seq, cols: size.cols, rows: size.rows, back: shown, screen: screen.message });
      }
      if (attachState.stopping) { send({ type: 'end', exitCode: 1, message: 'the server is stopping' }); socket.end(); return; }
      if (!core.paneIsLive(paneId)) { send({ type: 'end', exitCode: 0, message: 'pane exited' }); socket.end(); }
    } finally { busy = false; }
    if (!closed && back !== shownBack) poke();      // a scroll arrived while this frame was rendering
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
  const stop = (): void => { closed = true; clearInterval(timer); sub?.dispose(); attachState.sockets.delete(socket); };
  socket.on('close', stop);
  socket.on('error', stop);
  poke();
  lines.onLine((line) => {
    let message: ElsRequest;
    try { message = JSON.parse(line) as ElsRequest; } catch { send({ type: 'error', message: 'els attach: malformed line' }); return; }
    if (!isRequestObject(message)) { send({ type: 'error', message: 'els attach: malformed line' }); return; }
    // JUD #39096 ⓒ: attach 뒤의 각 input/resize 줄도 문의 같은 판정을 통과한다 (principal 은 문에서 정한 역할).
    if (message.op === 'input' || message.op === 'resize') {
      const verdict = judge?.(message);
      if (verdict && !verdict.allow) { send({ type: 'error', message: verdict.reason ?? 'els: denied' }); return; }
    }
    if (message.op === 'scroll') {
      if (Number.isInteger(message.lines)) { back = Math.max(0, back + message.lines); poke(); }
    } else if (message.op === 'input') {
      if (back > 0) { back = 0; poke(); }                   // typing returns to the live bottom
      const done = core.input(paneId, message.bytes);
      if (done.exitCode !== 0) send({ type: 'error', message: done.message });
    } else if (message.op === 'resize') {
      const done = core.resize(paneId, message.cols, message.rows);
      if (done.exitCode !== 0) send({ type: 'error', message: done.message });
      else poke();
    } else send({ type: 'error', message: 'els attach: only input, resize and scroll are accepted here' });
  });
}

const isRequestObject = (value: unknown): value is ElsRequest => typeof value === 'object' && value !== null && !Array.isArray(value);

// JUD #39053 ⓒ1 — the door lives in the server. The role comes from the server's own ledger
// (a pane token it minted at spawn), never from what the client says about itself.
export interface RequestGuard {
  classify(claim: { token?: unknown; pid?: unknown }): ServerRole;
  authorize(role: ServerRole, request: ElsRequest): { readonly allow: boolean; readonly reason?: string };
  audit(request: ElsRequest, role: ServerRole, reason: string, pid: unknown): void;
  /** JUD #39057 ⓒ1② — record the requester's role so the pane spawned by this `new` inherits it. */
  /** JUD #39057 ⓒ1③ — `els seat set OP`: the owner's explicit OP registration. */
  seatSet(request: { op: 'seat-set'; seat: string }): ElsResult;
}

export function serveConnection(ready: Promise<ElsCore | undefined>, socket: Socket, stateRoot: string, seatLookup: SeatLookup, guardRef: { current: RequestGuard | undefined }, sendAuditDir: string = dirname(elsSocketPath(stateRoot)), attachState: AttachState = { sockets: new Set<Socket>(), stopping: false }): void {
  // Capture before any credential syscall; sampling afterward permits a newly reused PID.
  const beforePidLookup = Date.now();
  const uid = peerUid(socket);
  const pid = peerPid(socket);
  const baseline = baselineBeforePidLookup(processIdentity(pid), pid, beforePidLookup);
  let handled = false;
  let role: ServerRole = { kind: 'outsider', note: 'no pane credential' };
  let claimedPid: number | undefined;
  // JUD #39096 must ⓑ: settle `role` before the door judges — a no-token caller may be a
  // ledger-verified OS peer (peer 판정 함수 재사용). The connection's FIRST lookup is shared by the
  // role door and the control door's initial seat: one lookup, both doors (lookups are counted literally).
  let roleReady: Promise<void> = Promise.resolve();
  let doorSeat: Promise<{ pane: string; seat: string } | undefined> | undefined;
  const firstSeat = () => (doorSeat ??= (async () => { try { return await seatLookup(pid, baseline); } catch { return undefined; } })());
  /** Once the first line was `attach`: where later lines go. Until the owner is ready they are kept, then replayed in order. */
  let attachLine: ((line: string) => void) | undefined;
  const earlyLines: string[] = [];
  const answer = (result: ElsResult): void => { socket.end(`${JSON.stringify(result)}\n`); };
  /** Post-door handling: seat-set, then spawn-parent capture, attach, or dispatch (JUD #39096 ⓑ restructure). */
  const serveTail = (request: ElsRequest, guard: RequestGuard | undefined): void => {
    // seat-set never reaches core dispatch: it is the auth ledger's own mutation.
    if (request.op === 'seat-set' && guard) { answer(guard.seatSet(request)); return; }
    // The pane spawned by this `new` inherits the requester's role (JUD #39057 ⓒ1②) — as a direct argument (JUD #39071), no queue.
    const spawnParent = request.op === 'new' && guard ? spawnParentOf(role) : undefined;
    // ELS-DESKTOP-SIDETAB-SUBSCRIBE: read-only push of the list on this connection (never reaches dispatch).
    if (request.op === 'subscribe') {
      void ready.then((core) => { if (core) serveSubscribe(core, socket); else answer({ exitCode: 1, message: 'els: the server is stopping' }); });
      return;
    }
    if (request.op === 'attach') {
      // Lines can arrive in the same chunk as the attach line, before `ready` resolves: keep them, never drop them.
      attachLine = (next) => { earlyLines.push(next); };
      void ready.then((core) => {
        if (!core) { answer({ exitCode: 1, message: 'els: the server is stopping' }); return; }
        serveAttach(core, socket, request, { onLine: (handler) => {
          for (const early of earlyLines.splice(0)) handler(early);
          attachLine = handler;
        } }, attachState, guard ? (message) => guard.authorize(role, { ...message, pane: request.pane } as ElsRequest) : undefined);
      });
      return;
    }
    void ready
      .then((core) => core ? dispatch(core, request, spawnParent, stateRoot, uid, pid, seatLookup, baseline, firstSeat, sendAuditDir) : { exitCode: 1, message: 'els: the server is stopping' } as ElsResult)
      .catch((error: unknown): ElsResult => ({ exitCode: 1, message: `els: ${error instanceof Error ? error.message : String(error)}` }))
      .then(answer);
  };
  const lines = createLineDecoder((line) => {
    if (attachLine) { attachLine(line); return; }
    if (handled) return;
    let request: ElsRequest;
    try { request = JSON.parse(line) as ElsRequest; }
    catch { handled = true; answer({ exitCode: 2, message: 'els: malformed request' }); return; }
    // Valid JSON that is not an object (null, 7, "x", [..]) has no `.op`: refuse this connection, never throw in the owner.
    if (!isRequestObject(request)) { handled = true; answer({ exitCode: 2, message: 'els: malformed request' }); return; }
    const guard = guardRef.current;
    // First line of a CLI connection: present the pane token inherited from the pane's env.
    if (request.op === 'auth') {
      role = guard ? guard.classify(request) : { kind: 'outsider', note: 'no pane credential' };
      claimedPid = typeof request.pid === 'number' ? request.pid : undefined;
      socket.write(`${JSON.stringify({ exitCode: 0, message: `auth: ${role.kind}` })}\n`);
      return;
    }
    // JUD #39096 ⓒ (OP #106663): `attach` 는 이제 문 판정을 통과한다 — mutating op 의 하나로
    // 판정되고, 그 뒤의 input/resize 줄도 같은 판정을 받는다 (serveAttach judge).
    // Central server-side door: every mutating op of every client is judged here.
    if (isMutating(request)) {
      // JUD must ⓒ2-② (OP #104711): fail-closed — a mutating request that arrives before the guard
      // exists is denied, never waved through. (run() only listens after the guard is ready; this is the backstop.)
      if (!guard) { handled = true; answer({ exitCode: 1, message: `els: ${request.op} denied — not ready (no guard)` }); return; }
      handled = true;
      // JUD #39096 ⓒ: the door verdict is asynchronous; lines arriving in the same chunk as the attach
      // request must be buffered immediately or `handled` drops them. serveTail replays them after the door.
      if (request.op === 'attach') attachLine = (next) => { earlyLines.push(next); };
      // JUD #39096 must ⓑ (OP #105050·#105177): the door admits a «peer seat으로 확인된 OP/RES-INFRA»
      // caller as a principal («토큰 역할 ∨ peer seat», peer 판정 함수 결과, 자기신고 0). The role door
      // waits for the peer lookup to settle; the control 문 still makes the final adjudication.
      void Promise.all([roleReady, ready]).then(async ([, core]) => {
        // `new` needs no peer authority (spawn stays open, JUD #39060 main behavior) — skip the lookup
        // so its count stays literal for the doors that do need it (op-input-socket: lookups === 2).
        if ((role.kind === 'outsider' || role.kind === 'owner') && pid !== undefined && request.op !== 'new') {
          const peer = await firstSeat();
          if (peer && (peer.seat === 'OP' || peer.seat === 'RES-INFRA')) role = { kind: 'peer', pid, pane: peer.pane, seat: peer.seat, uid: uid as number };
          else {
            // JUD #39096 must ⓒ (OP #106966·#107197): 무토큰 연결의 프로세스 조상에 els pane 셸이 있으면
            // 그것은 사람이 아니라 pane 프로세스(손)다 — 사람 전용 outsider 허용에서 제외하고 거부한다.
            const ancestor = core && role.kind === 'outsider' && pid !== undefined ? await resolveAncestorPane(pid, baseline, core.shellPids()) : undefined;
            if (ancestor) {
              guard.audit(request, role, `els pane process (pane ${ancestor.pane}) without pane token`, claimedPid);
              answer({ exitCode: 1, message: `els: ${request.op} denied — caller is an els pane process (pane ${ancestor.pane}); present the pane token` });
              return;
            }
            // JUD #39096 ⓒ: 토큰 없이 연결했지만 pane 자손인 호출자 = env 를 벗겨낸 pane 프로세스다 (맨 터미널의
            // 사람이 아니다) — attach 를 거부한다; pane 프로세스는 자기 pane 토큰을 제시해야 한다.
            if (peer && request.op === 'attach') {
              guard.audit(request, role, `pane-descended caller (seat ${peer.seat}) without pane token`, claimedPid);
              answer({ exitCode: 1, message: `els: attach denied — caller is a pane process (seat ${peer.seat}); present the pane token` });
              return;
            }
          }
        }
        // JUD #39096 must ⓒ (OP #107371): a no-token connection cannot type —
        // input-line is denied by default (fail-closed); a human types with the owner token,
        // a pane process with its pane token, a peer seat via ledger-verified promotion.
        if (role.kind === 'outsider' && request.op === 'input-line') {
          guard.audit(request, role, 'no-token typing denied (owner token required)', claimedPid);
          answer({ exitCode: 1, message: 'els: input-line denied — present the owner token' });
          return;
        }
        const verdict = guard.authorize(role, request);
        if (!verdict.allow) {
          guard.audit(request, role, verdict.reason ?? 'denied', claimedPid);
          answer({ exitCode: 1, message: verdict.reason ?? 'els: denied' });
          return;
        }
        serveTail(request, guard);
      });
      return;
    }
    handled = true;
    serveTail(request, guard);
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
import { AUTH_OWNER_TOKEN_ENV, AUTH_PANE_TOKEN_ENV, authorizeRequest, denialAuditLine, isMutating, PaneRegistry, rulesLoader, spawnParentOf, type ServerRole, type SpawnParent } from './server-auth.js';

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
  /**
   * Open the /els/v1 API through the one control door (#38453 REVIEW must ①): the bind, the PAT store root and
   * the per-minute rate limit. Every request still walks authorize → classify → (HITL) → audit → execute.
   */
  readonly httpV1?: { readonly bind: ElsHttpBind; readonly patRoot: string; readonly rateLimitPerMinute?: number };
  readonly hostName?: string;
  /** Where a finished child's one result line goes. Default: `<state>/els/child-results.jsonl` (one JSON line each). */
  readonly notifyParent?: (ws: string, line: string) => void;
  /** ELS-PANE-AGENT-DETECT: the process table (`ps -A -o pid=,tpgid=,args=`); tests hand in text. */
  readonly ps?: () => Promise<string>;
  /** Watch busy panes for stalls (mail + receipt). Overrides of the poller's own defaults for tests; `false` disables. */
  readonly stall?: StallAlertDeps | false;
  /** Clock seam for tests (ELS-TAB-STATE-BADGE: stalled is a time rule); the server uses Date.now. */
  readonly now?: () => number;
}

/** Become the owner, then load the journal. Resolves to the running server, or to a refusal. */
export async function startElsServer(options: ElsServerOptions = {}): Promise<{ server: Server; core: ElsCore; close: () => Promise<void>; httpV1?: Server } | ElsResult> {
  const stateRoot = options.stateRoot ?? elanousStateRoot();
  const socketPath = elsSocketPath(stateRoot);
  const journalPath = elsJournalPath(stateRoot);
  const tooLong = elsSocketPathProblem(socketPath);
  if (tooLong) return { exitCode: 1, message: tooLong };
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(socketPath), 0o700);

  let markReady: (core: ElsCore | undefined) => void = () => {};
  const ready = new Promise<ElsCore | undefined>((resolve) => { markReady = resolve; });
  const paneRegistry = new PaneRegistry();
  const owner = paneRegistry.registerOwner();
  process.env[AUTH_OWNER_TOKEN_ENV] = owner.token;
  const guardRef: { current: RequestGuard | undefined } = { current: undefined };
  // ELS-START-PERF: the login-shell capture starts now, beside the journal load, so the first new pane does not pay for it alone.
  if (!options.spawn) void warmLoginEnv();
  // D1a must-1: 이 서버의 attach 연결 원장(서버마다 하나 — 시험의 두 서버가 서로의 연결을 건드리지 않는다).
  const attachState: AttachState = { sockets: new Set<Socket>(), stopping: false };
  const server = createServer((socket) => serveConnection(ready, socket, stateRoot, options.seatLookup ?? resolvePeerSeat, guardRef, dirname(socketPath), attachState));

  // 2. Owner now: load the journal (requests that arrived meanwhile wait for this).
  const core = createElsCore({ ...(options.now ? { now: options.now } : {}), load: () => loadJournal(journalPath), save: (journal) => saveJournal(journalPath, journal),
    // D1a: pane PTYs live in outside holders — the default, no option flag. A restart adopts them back (reattachHolder).
    // JUD #39096/#39053: registerSpawn 발급 pane 토큰·부모 역할 기록을 홀더 스폰 위에 얹는다.
    // OP #104178 ① — the parent role comes in as a direct argument (JUD #39071), so the token is
    // minted before the PTY call: a spawn that throws must not leave the minted token behind.
    spawn: (command, cwd, title, env, parent) => {
      const spawnEnv = paneRegistry.registerSpawn({ ...env, ELANOUS_ELS_SOCKET: socketPath }, cwd, parent);
      try {
        return (options.spawn ?? holderPty(stateRoot))(command, cwd, title, spawnEnv);
      } catch (error) {
        paneRegistry.forget(spawnEnv[AUTH_PANE_TOKEN_ENV]);
        throw error;
      }
    },
    reattach: (pane) => reattachHolder(stateRoot, pane.id),
    // D1b: a reboot-ended pane shows its saved screen instead of clearing to idle.
    restoreScreen: (paneId) => restoreScreenFromSnapshot(stateRoot, paneId),
    consumeScreenSnapshot: (paneId) => consumeScreenSnapshot(stateRoot, paneId) });
  const resultsPath = join(dirname(socketPath), 'child-results.jsonl');
  const notifyParent = options.notifyParent ?? ((ws: string, line: string) => {
    // Bounded: past 256 KiB the file becomes `.1` (one older generation), so unread results cannot grow without limit.
    try { if (statSync(resultsPath).size > RESULTS_MAX_BYTES) renameSync(resultsPath, `${resultsPath}.1`); } catch { /* no file yet */ }
    appendFileSync(resultsPath, `${JSON.stringify({ at: new Date().toISOString(), ws, line })}\n`, { mode: 0o600 });
  });
  childTabsOf.set(core, createChildTabs({ core, notifyParent }));
  // JUD #39053 ⓒ1: every socket request is judged here in the server. The role comes from the
  // server-minted pane-token ledger; the CLI's env never decides anything.
  const elsDir = dirname(journalPath);
  const loadRules = rulesLoader(elsDir);
  const workspaceOf = (request: ElsRequest): string | undefined => {
    if (request.op === 'new' || request.op === 'close-workspace') return request.ws;
    const ws = (request as { at?: { ws?: string } }).at?.ws;
    if (ws) return ws;
    const pane = (request as { pane?: string }).pane;
    if (!pane) return undefined;
    // core.list() emits {workspaces, tabs, panes} — panes is a flat array of {pane, workspace, …} rows.
    const { panes } = JSON.parse(core.list().message) as { panes: Array<{ pane: string; workspace: string }> };
    return panes.find((row) => row.pane === pane)?.workspace;
  };;
  guardRef.current = {
    classify: (claim) => paneRegistry.classify(claim),
    authorize: (role, request) => authorizeRequest(role, request, workspaceOf(request), loadRules()),
    audit: (request, role, reason, pid) => {
      try { appendFileSync(join(elsDir, 'control-audit.jsonl'), `${denialAuditLine(request, role, reason, pid)}\n`, { mode: 0o600 }); }
      catch { /* the door must not break on audit IO */ }
    },
    seatSet: (request) => paneRegistry.registerSeat(request.seat)
      ? { exitCode: 0, message: 'els seat: OP registered' }
      : { exitCode: 1, message: 'els seat set: only OP is supported' },
  };
  // JUD must ⓒ2-② (OP #104711): the socket starts listening only after the guard exists — no request
  // can arrive unjudged, and serveConnection denies a mutating request if the guard is somehow absent.
  // (loadJournal never writes, so a live-server refusal here leaves the journal untouched.)
  let failed = await listen(server, socketPath);
  if (failed?.code === 'EADDRINUSE') {
    const taken = await elsSocketTaken(socketPath);
    if (taken === 'live') { markReady(undefined); return { exitCode: 1, message: `els serve: a server already answers on ${socketPath}` }; }
    // A dead server's socket: connect was refused → unlink → bind once more.
    if (taken === 'dead') { try { unlinkSync(socketPath); } catch { /* removed meanwhile */ } }
    failed = await listen(server, socketPath);
  }
  if (failed) { markReady(undefined); return { exitCode: 1, message: `els serve: cannot listen on ${socketPath}: ${failed.message}` }; }
  chmodSync(socketPath, 0o600);
  // JUD #39057 ⓒ1③ — the person's explicit `els seat set OP` needs the owner credential outside this process env. Written only
  // once this run owns the socket (right after the bind, before any client can re-read it): a start refused above («already answers») must not overwrite the live server's token file.
  writeFileSync(join(dirname(journalPath), 'owner-token'), owner.token, { mode: 0o600 });

  // #38610 REVIEW must ① — outbound webhooks are part of the real boot: the same child events that
  // build the side tabs reach every subscribed URL (deliver is fire-and-forget inside).
  webhookOutOf.set(core, createOutboundWebhooks({ stateDir: dirname(socketPath) }));
  let httpServer: Server | undefined;
  // The busy-pane stall watcher: started once the core owns the journal, stopped in close().
  let stallAlert: StallAlert | undefined;
  let httpV1Server: Server | undefined;
  // Queued `do` lines go out once a pane's turn is no longer running.
  const drainTimer = setInterval(() => { void core.drain(); }, 1_000);
  // ELS-PANE-AGENT-DETECT: once a second, one `ps` snapshot → what each live pane runs in its foreground now.
  const foregroundTimer = setInterval(() => { void probeForegrounds(core, options.ps); }, 1_000);
  foregroundTimer.unref();
  drainTimer.unref();
  const close = async (): Promise<void> => {
    // D1a must-1(JUD-B #107693): attach 연결을 stopAll() «앞에» 서버 떠남으로 끝낸다 — 이 뒤 pane 들은 홀더에서 살아
    // 있고 새 서버가 입양한다. 이 경로에서 «pane exited» 를 보내면 클라가 자식이 죽은 줄로 뷰를 끊는다.
    attachState.stopping = true;
    for (const attach of attachState.sockets) {
      try { attach.end(SERVER_STOPPING_END); } catch { /* already gone */ }
      // A peer that neither reads nor closes its end must not hold the shutdown: the end line is already queued for it, so after
      // a short grace the connection is dropped (the pane is untouched — the holder keeps it).
      const drop = setTimeout(() => attach.destroy(), ATTACH_STOP_GRACE_MS);
      drop.unref?.();
    }
    attachState.sockets.clear();
    clearInterval(drainTimer);
    clearInterval(foregroundTimer);
    stallAlert?.stop();
    core.stopAll();
    if (httpV1Server) await new Promise<void>((resolve) => httpV1Server!.close(() => resolve()));
    disposeRecordings(core); // every `els record` tap dies with its server; `--stop` disposed its own earlier.
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
  // 3b. The /els/v1 API through the control door (#38453 REVIEW must ①): a real consumer on the real boot path —
  //     the execute is this core, so an allowed request drives the same panes `els do/send/read/ls` drive.
  if (options.httpV1) {
    // #38453 REVIEW must ② — the pane kind is the server's to say, never the request's: until the core exposes
    // its command ledger every pane counts as a shell, so a dangerous do waits for a person (fail closed; this
    // server does not wire an approver yet, so it is held, not sent).
    const paneIsShell = (): boolean => true;
    const execute: ControlExecute = async (input) => {
      // #38608 REVIEW must ① — a caller's workspace is a claim; the journal is the truth. Read and typing
      // (do, send) are refused when the named pane lives in another workspace, whatever the rule said
      // about the claimed pair.
      if (input.action === 'read' || input.action === 'do') {
        const owner = core.workspaceOf(input.target.pane);
        if (owner !== undefined && owner.id !== input.target.workspace && owner.name !== input.target.workspace) {
          return { exitCode: 2, message: `els http v1: pane ${input.target.pane} is not in workspace ${input.target.workspace} (it is in ${owner.name})` };
        }
      }
      if (input.action === 'read') return core.read(input.target.pane);
      if (input.action === 'status') return core.list();
      if (input.action === 'new') return { exitCode: 2, message: 'els http v1: new is not wired to this server yet' };
      const text = input.text ?? '';
      // #38453 REVIEW must ④ — the executor sees the path the caller used: /send is raw input, /do is a shell line.
      return input.path === '/els/v1/send' ? core.send(input.target.pane, text) : core.do(input.target.pane, text, `http ${input.principal.id}`);
    };
    try {
      httpV1Server = await startElsHttpV1({
        stateDir: dirname(socketPath),
        patRoot: options.httpV1.patRoot,
        execute,
        paneIsShell,
        // #38609 REVIEW must ⓑ — one nonce ledger for the life of this server.
        nonces: new Map(),
        ...(options.httpV1.rateLimitPerMinute !== undefined ? { rateLimitPerMinute: options.httpV1.rateLimitPerMinute } : {}),
      }, options.httpV1.bind);
    } catch (error) {
      markReady(undefined);
      await close();
      return { exitCode: 1, message: `els serve: cannot open the v1 API on ${options.httpV1.bind.host}:${options.httpV1.bind.port}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  markReady(core);
  return { server, core, close, ...(httpV1Server ? { httpV1: httpV1Server } : {}) };
}
