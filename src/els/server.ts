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
import { stateDirSourceForChild } from '../agent/identity-env.js';
import { openMsgStore } from '../msg/msg-store.js';
import { startCeoChannelWiring, type CeoChannelWiring } from './ceo-ingress-wiring.js';
import type { CeoClock } from '../agent-events/ceo-ingress.js';
import { createChildTabs, type ChildSource, type ChildTabs } from './child-tabs.js';
import { readCeoSideAlert } from './ceo-side-alert.js';
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
import { authorize, createControl, inputExplicitlyDenied, pinAllowList } from './control.js';
import { journalControl } from './control-cli.js';
import { peerUid } from './peer-uid.js';
import { runtimeProcessIdentity, SeatRuntimeRegistry, type RuntimeProcess, type RuntimeClaim } from './seat-runtime.js';
import { peerPid, processIdentity, baselineBeforePidLookup, resolvePeerSeatWithAnchor, resolveElsPeerSeat, resolveAncestorPane, inspectReadAncestry, verifyPanePeer, type ProcessIdentity } from './peer-seat.js';
type PeerSeat = { pane: string; seat: string; anchor?: ProcessIdentity; runtimeLive?: () => boolean };
type SeatLookup = (pid: number | undefined, baseline?: ProcessIdentity) => Promise<PeerSeat | undefined> | PeerSeat | undefined;
const sameSeatGeneration = (a: PeerSeat, b: PeerSeat): boolean => {
  if (a.pane !== b.pane || a.seat !== b.seat) return false;
  if (!a.anchor && !b.anchor) return true; // Test seams without an anchor cannot recover an exited peer.
  return !!a.anchor && !!b.anchor && a.anchor.pid === b.anchor.pid && a.anchor.start === b.anchor.start
    && a.anchor.session === b.anchor.session && a.anchor.tty === b.anchor.tty;
};
import { createOutboundWebhooks } from './webhook-out.js';

/** This host's name in addresses (`host:ws/tab/pane`): ELANOUS_ELS_HOST, else the short machine name. */
export function elsHostName(): string {
  return process.env.ELANOUS_ELS_HOST?.trim() || hostname().split('.')[0] || 'local';
}

export function elsSocketPath(stateRoot: string = elanousStateRoot()): string {
  return join(stateRoot, 'els', 'els.sock');
}

/** Tool routing is a separate door, not a security boundary against processes with the same OS uid. */
export function elsToolSocketPath(stateRoot: string = elanousStateRoot()): string {
  return join(stateRoot, 'els', 'ctl.sock');
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
  | { readonly op: 'auth'; readonly token?: string; readonly runtimeToken?: string; readonly pid?: number }
  | { readonly op: 'build'; readonly pane: string; readonly sha: string; readonly version?: string; readonly stamp?: string }
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
  | { readonly op: 'close-tab'; readonly tab: string; readonly confirmed?: boolean }
  | { readonly op: 'do'; readonly pane: string; readonly text: string; readonly from: string; readonly at?: { readonly ws: string; readonly tab: string } }
  | { readonly op: 'snapshot'; readonly pane: string }
  | { readonly op: 'record'; readonly pane: string }
  | { readonly op: 'input-line'; readonly pane: string; readonly text: string; readonly from: string; readonly at?: { readonly ws: string; readonly tab: string } }
  | { readonly op: 'interrupt'; readonly pane: string }
  | { readonly op: 'seat-set'; readonly seat: string; readonly runtime?: RuntimeClaim }
  | { readonly op: 'child'; readonly action: 'start' | 'progress' | 'status' | 'end' | 'pin' | 'unpin' | 'dismiss' | 'tree' | 'summary';
      readonly id?: string; readonly ws?: string; readonly cwd?: string; readonly source?: ChildSource; readonly label?: string;
      readonly parent?: string; readonly line?: string; readonly state?: 'working' | 'blocked' | 'idle'; readonly ok?: boolean; readonly summary?: string };

// 출처: a request line is a small JSON object (a pane ref, a command line or a short text to type); anything larger is
// not a client of this server.
const MAX_REQUEST_CHARS = 1 << 20;
// Bound per-line object overhead while authentication or attach readiness is pending.
const MAX_PENDING_LINES = 4096;

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
// leaves the store empty (a closed pane never strands its recording). The server snapshots its workspace and owner seat at
// start; a matching seat or the original pane credential can stop it, while another seat is denied. A pane that merely exits stays in the journal, so
// the same call stops it. Server close stops the recording and forgets it WITHOUT saving a .cast (nothing to answer to).
type LiveRecording = { recordingId: string; paneId: string; refs: ReadonlySet<string>; ownerSeat?: string; workspace?: string; dispose: () => void };
const recordings = new WeakMap<ElsCore, Map<string, LiveRecording>>();

function recordingFor(core: ElsCore, ref: string): LiveRecording | undefined {
  const resolved = core.paneExists(ref);
  return [...(recordings.get(core)?.values() ?? [])].find(r => resolved === undefined
    ? r.paneId === ref || r.refs.has(ref) : r.paneId === resolved);
}

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

async function dispatch(core: ElsCore, request: ElsRequest, parent: SpawnParent | undefined, stateRoot: string, uid: number | undefined, pid: number | undefined, seatLookup: SeatLookup, baseline: ProcessIdentity | undefined, firstSeat: (() => Promise<PeerSeat | undefined>) | undefined, sendAuditDir: string, toolDoor: boolean, toolDo = false, paneSeat?: string, callerPane?: string, auditDenial?: (request: ElsRequest, reason: string) => void, claimedPid?: number): Promise<ElsResult> {
  if ((paneSeat !== undefined && !['ping', 'ls', 'new'].includes(request.op)) ||
      (toolDoor && !['ping', 'ls', 'new', 'do', 'input-line', 'interrupt'].includes(request.op))) {
    const seat = paneSeat !== undefined ? { seat: paneSeat } : await firstSeat?.();
    const journal = loadJournal(elsJournalPath(stateRoot));
    const ownPane = (ref: string): boolean => {
      const id = core.paneExists(ref);
      return !!id && (id === callerPane || (!!seat && seat.seat !== 'unknown' && journal.panes.some(p => p.id === id && p.ownerSeat === seat.seat)));
    };
    const ownTab = (ref: string): boolean => {
      const tab = journal.tabs.find(t => t.id === ref);
      const panes = tab && journal.panes.filter(p => p.tabId === tab.id);
      return !!seat && seat.seat !== 'unknown' && !!panes?.length && panes.every(p => p.ownerSeat === seat.seat);
    };
    const ownWorkspace = (ref: string): boolean => {
      const ws = journal.workspaces.find(w => w.id === ref || w.name === ref);
      const tabs = ws && journal.tabs.filter(t => t.workspaceId === ws.id);
      return !!tabs?.length && tabs.every(t => ownTab(t.id));
    };
    // Child views are virtual and normally ownerless. They do not grant authority: at
    // least one real owned pane must anchor the workspace, and no foreign or unowned
    // real pane, foreign virtual pane, or empty tab may be present.
    const ownChildWorkspace = (ref: string): boolean => {
      if (!seat || seat.seat === 'unknown') return false;
      const ws = journal.workspaces.find(w => w.id === ref || w.name === ref);
      const tabs = ws && journal.tabs.filter(t => t.workspaceId === ws.id);
      if (!tabs?.length) return false;
      let realOwned = false;
      const allowed = tabs.every(t => {
        const panes = journal.panes.filter(p => p.tabId === t.id);
        return panes.length > 0 && panes.every(p => {
          if (p.kind === 'harness-child') return p.ownerSeat === undefined || p.ownerSeat === seat.seat;
          if (p.ownerSeat !== seat.seat) return false;
          realOwned = true;
          return true;
        });
      });
      return allowed && realOwned;
    };
    const ownKind = (kind: string, ref: string): boolean => kind === 'pane' ? ownPane(ref)
      : kind === 'tab' ? ownTab(ref) : kind === 'workspace' ? ownWorkspace(ref) : false;
    let allowed = false;
    if (request.op === 'read' || request.op === 'snapshot' || request.op === 'record' || request.op === 'status' || request.op === 'close' || request.op === 'build' || request.op === 'do' || request.op === 'input-line' || request.op === 'interrupt' || request.op === 'send' || request.op === 'send-verified' || request.op === 'input') {
      const recording = request.op === 'record' && typeof request.pane === 'string' ? recordingFor(core, request.pane) : undefined;
      allowed = typeof request.pane === 'string' && (ownPane(request.pane) || (request.op === 'record' &&
        ((!recording && request.pane === callerPane && callerPane !== undefined) || (!!recording &&
          (recording.paneId === callerPane || (!!seat && seat.seat !== 'unknown' && recording.ownerSeat === seat.seat))))));
      if (allowed && (request.op === 'read' || request.op === 'do' || request.op === 'input-line') && request.at) allowed = core.locate(request.at.ws, request.at.tab, request.pane) === core.paneExists(request.pane);
    } else if (request.op === 'child') {
      const tabs = childTabsOf.get(core);
      const ws = request.action === 'start' || request.action === 'tree' || request.action === 'summary'
        ? request.ws : request.id ? tabs?.workspaceOf(request.id) : undefined;
      const parentWs = request.action === 'start' && request.parent ? tabs?.workspaceOf(request.parent) : undefined;
      const workspaceId = (ref: string | undefined) => journal.workspaces.find(w => w.id === ref || w.name === ref)?.id;
      allowed = !!ws && ownChildWorkspace(ws) && (!request.parent || (!!parentWs && !!workspaceId(ws) && workspaceId(ws) === workspaceId(parentWs)));
    } else if (request.op === 'rename' || request.op === 'reorder') {
      allowed = ownKind(request.kind, request.id) && (request.op !== 'reorder' || request.before === undefined || request.before === '' || request.before === 'end' || ownKind(request.kind, request.before));
    } else if (request.op === 'close-workspace') allowed = ownWorkspace(request.ws);
    else if (request.op === 'close-tab') allowed = ownTab(request.tab);
    if (!allowed) {
      if (request.op === 'do') auditDenial?.(request, 'target is not owned by caller seat');
      return { exitCode: 1, message: `els: ${request.op} denied — target is not owned by caller seat${request.op === 'record' && typeof request.pane === 'string' ? ` (${JSON.stringify(request.pane)})` : ''}` };
    }
  }
  switch (request.op) {
    case 'build': return typeof request.pane === 'string' && typeof request.sha === 'string' ? core.reportBuild(request.pane, request.sha, request.version, request.stamp) : { exitCode: 2, message: 'els build: pane and sha required' };
    case 'ping': return { exitCode: 0, message: `els server pid ${process.pid}` };
    case 'rename': return typeof request.kind === 'string' && typeof request.id === 'string' && typeof request.name === 'string'
      ? core.rename({ kind: request.kind, id: request.id, name: request.name })
      : { exitCode: 2, message: 'els rename: kind, id and name are required' };
    case 'ls': {
      const listed = core.list();
      if (listed.exitCode !== 0) return listed;
      const side = readCeoSideAlert(stateRoot);
      if (side.kind === 'absent') return listed;
      const payload = JSON.parse(listed.message) as Record<string, unknown>;
      payload.ceoSide = side.kind === 'ok' ? { pendingRed: side.pendingRed } : { error: 'unavailable' };
      return { ...listed, message: JSON.stringify(payload) };
    }
    case 'grep': return core.grep(request.pattern);
    case 'new': {
      if (toolDoor) {
        // A human owner credential or a label-only registration is not a tool seat.
        if (!(await firstSeat?.())) return { exitCode: 1, message: 'els new: denied — verified tool seat required' };
        // The socket is reachable directly, so the client-side ElsControl door alone
        // cannot enforce tool grants. No pane or tab exists yet: only a rule broad
        // enough to match an empty pane/tab can authorize this request.
        const journal = loadJournal(elsJournalPath(stateRoot));
        const lookup = journalControl(journal);
        const workspace = lookup.resolve.workspace(request.ws) ?? request.ws;
        const rules = pinAllowList(dirname(elsSocketPath(stateRoot)), lookup.resolve);
        if (!authorize(rules, { id: 'eln:tool', kind: 'eln' }, { workspace, pane: '', shell: false }, 'new')) {
          return { exitCode: 1, message: 'els new: denied — no tool rule grants new for this workspace' };
        }
      }
      // Only a server-authenticated role or an independently verified local peer can own a pane.
      const peer = uid !== undefined && pid !== undefined && firstSeat ? await firstSeat() : undefined;
      // An unassigned pane credential must not override a verified peer with the sentinel
      // "unknown". Refuse rather than silently assigning a possibly conflicting identity.
      if (peer && parent?.kind === 'hand' && parent.seat === 'unknown') {
        return { exitCode: 1, message: 'els new: pane credential has unknown seat; resolve seat before creating a pane' };
      }
      const ownerSeat = parent ? (parent.kind === 'op' ? 'OP' : parent.seat) : peer?.seat;
      // An OP-owned worker remains owned by OP without inheriting an OP pane credential.
      const spawnParent = toolDoor && ownerSeat === 'OP' ? undefined : parent;
      return core.newPane({ ws: request.ws, cwd: request.cwd, command: request.command, ...(request.title ? { title: request.title } : {}), ...(spawnParent ? { parent: spawnParent } : {}), ...(ownerSeat ? { ownerSeat } : {}) });
    }
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
      appendSendAudit(sendAuditDir, { op: 'send', pane: request.pane, text: request.text, exitCode: done.exitCode, socketAudit: { peerPid: pid, claimedPid }, ...(ws ? { workspace: ws.name } : {}) });
      return done;
    }
    case 'status': return core.status(request.pane);
    case 'send-verified': {
      const done = await core.sendVerified(request.pane, request.text, request.requireEmpty === true);
      const ws = core.workspaceOf(request.pane);
      appendSendAudit(sendAuditDir, { op: 'send', pane: request.pane, text: request.text, exitCode: done.exitCode, socketAudit: { peerPid: pid, claimedPid }, ...(ws ? { workspace: ws.name } : {}) });
      return done;
    }
    case 'input': {
      // One-shot run/send-keys are machine input. The authenticated attach stream is the person key path.
      if (request.pane === undefined) return { exitCode: 2, message: 'els input: a pane is required' };
      const done = await core.machineInput(request.pane, request.bytes);
      // #90792 P0 ④ — send-keys/run are the send family too: one audit line per execution.
      const ws = core.workspaceOf(request.pane);
      appendSendAudit(sendAuditDir, { op: 'input', pane: request.pane, text: request.bytes, exitCode: done.exitCode, socketAudit: { peerPid: pid, claimedPid }, ...(ws ? { workspace: ws.name } : {}) });
      return done;
    }
    case 'reorder': return core.reorder({ kind: request.kind, id: request.id, ...(request.before === undefined ? {} : { before: request.before }) });
    case 'close': return core.close(request.pane);
    case 'close-workspace': return core.closeWorkspace(request.ws);
    case 'close-tab': return core.closeTab(request.tab);
    case 'do': {
      if (typeof request.text !== 'string' || typeof request.from !== 'string') return { exitCode: 2, message: 'els do: text and from are required' };
      if (toolDoor) return dispatch(core, { ...request, op: 'input-line' }, parent, stateRoot, uid, pid, seatLookup, baseline, firstSeat, sendAuditDir, true, true);
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
      const known = recordingFor(core, request.pane);
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
      const ownerSeat = loadJournal(elsJournalPath(stateRoot)).panes.find(p => p.id === paneId)?.ownerSeat;
      const workspace = core.workspaceOf(paneId)?.name;
      map.set(paneId, { recordingId: out.recordingId, paneId, refs: new Set([request.pane, paneId]), ...(ownerSeat ? { ownerSeat } : {}), ...(workspace ? { workspace } : {}), dispose: () => tap.dispose() });
      recordings.set(core, map);
      return { exitCode: 0, message: JSON.stringify({ recordingId: out.recordingId, pane: paneId }) };
    }
    case 'interrupt':
    case 'input-line': {
      const interrupt = request.op === 'interrupt';
      const at = request.op === 'input-line' ? request.at : undefined;
      const from = request.op === 'input-line' ? request.from : 'ElsControl interrupt';
      // Interrupt is a server-selected fixed byte, never client-supplied shell text.
      // Audit the byte actually sent, rather than a descriptive label.
      const text = request.op === 'input-line' ? request.text : '\x1b';
      const validAt = at === undefined || (at !== null && typeof at === 'object' && typeof at.ws === 'string' && typeof at.tab === 'string');
      const valid = typeof request.pane === 'string' && typeof text === 'string' && typeof from === 'string' && validAt;
      const lookup = journalControl(loadJournal(elsJournalPath(stateRoot)));
      const ref = valid ? (at ? core.locate(at.ws, at.tab, request.pane) : request.pane) : undefined;
      const target = ref ? await lookup.lookupWithTab(ref) : undefined;
      let seat: PeerSeat | undefined;
      try { seat = uid === undefined ? undefined : firstSeat ? await firstSeat() : await seatLookup(pid, baseline); } catch { seat = undefined; }
      const door = createControl({ stateDir: dirname(elsSocketPath(stateRoot)), resolve: lookup.resolve, inputUsesDoPolicy: toolDoor && !interrupt,
        guard: () => {
          if (!valid || !target) return 'invalid input request or unknown target';
          const owner = loadJournal(elsJournalPath(stateRoot)).panes.find(p => p.id === target.pane)?.ownerSeat;
          return toolDoor && (!seat || !owner || owner !== seat.seat) ? 'target pane owner is unknown or differs from caller seat' : undefined;
        },
        execute: async (input) => {
          // Authorization may have gone stale while intent audit was written. Re-resolve immediately
          // before enqueue/write; any ambiguity or changed caller fails closed.
          let current: PeerSeat | undefined;
          try { current = uid === undefined ? undefined : await seatLookup(pid, baseline); } catch { /* deny */ }
          if (!seat || !current || !sameSeatGeneration(seat, current))
            return { exitCode: 1, message: 'els input: denied (caller pane changed)' };
          const validate = async (): Promise<boolean> => {
            try {
              // The normal CLI is one-shot: its verified process can exit after enqueueing.
              // Preserve that accepted human identity while still rechecking target and policy.
              // Tool input may instead pin a still-live registered runtime generation.
              const resolved = await seatLookup(pid, baseline);
              // Only an actually exited process may retain its enqueue-time identity;
              // a live process or ambiguous process check remains denied.
              let exited = false;
              if (!resolved && pid !== undefined) {
                try { process.kill(pid, 0); } catch (error) { exited = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
              }
              // Re-resolve the verified pane shell generation, not the session leader,
              // against the current ledger and pane binding. Missing anchors fail closed.
              const anchor = current.anchor;
              const fresh = resolved ?? (exited && current.runtimeLive?.() ? current : exited && !toolDoor && anchor
                ? await seatLookup(anchor.pid, anchor) : undefined);
              const journal = loadJournal(elsJournalPath(stateRoot));
              const owner = journal.panes.find(p => p.id === input.target.pane)?.ownerSeat;
              const freshLookup = journalControl(journal);
              const currentTarget = await freshLookup.lookupWithTab(input.target.pane);
              if (!currentTarget || currentTarget.workspace !== input.target.workspace || currentTarget.tab !== input.target.tab) return false;
              const rules = pinAllowList(dirname(elsSocketPath(stateRoot)), freshLookup.resolve);
              // The server selects this route, never the caller-supplied display label.
              const toolGrant = !toolDoor || authorize(rules, { id: 'eln:tool', kind: 'eln' }, currentTarget, 'do');
              return !!fresh && sameSeatGeneration(seat, fresh) && (!toolDoor || owner === seat.seat)
                && toolGrant && !inputExplicitlyDenied(rules, input.principal, currentTarget);
            } catch { return false; }
          };
          if (interrupt) {
            if (!(await validate())) return { exitCode: 1, message: 'els input: authorization changed, not sent' };
            return core.machineInput(input.target.pane, '\x1b', true);
          }
          return toolDo
            ? core.do(input.target.pane, input.text ?? '', from, input.queueAudit, validate)
            : core.inputLine(input.target.pane, input.text ?? '', from, input.queueAudit, validate);
        } });
      const result = await door.run({ principal: { id: uid === undefined ? 'unauthenticated' : `local:${uid}`, kind: 'cli', ...(seat ? { callerPane: seat.pane, callerSeat: seat.seat } : {}) }, from: typeof from === 'string' ? from : '', action: 'input', target: target ?? { workspace: '', pane: '', shell: false }, text: typeof text === 'string' ? text : '', socketAudit: { peerPid: pid, claimedPid }, ...(interrupt ? { fixedKey: 'escape' as const } : {}) });
      return result.ok ? { exitCode: result.exitCode, message: result.message, ...(result.queued !== undefined ? { queued: result.queued } : {}) } : { exitCode: 1, message: result.message };
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
function serveAttach(core: ElsCore, socket: Socket, request: Extract<ElsRequest, { op: 'attach' }>, lines: { onLine: (handler: (line: string) => void) => void }, attachState: AttachState, auditDir: string, judge?: (message: ElsRequest) => { readonly allow: boolean; readonly reason?: string }, humanApprovalKeys = false): void {
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
      // A pane-token attach is a seat tool, not proof of a human. During HITL it takes the
      // same guarded machine lane; only the server-minted owner credential may type a decision key.
      if (humanApprovalKeys) {
        const done = core.input(paneId, message.bytes);
        if (done.exitCode !== 0) send({ type: 'error', message: done.message });
      } else {
        void core.machineInput(paneId, message.bytes).then(done => {
          appendSendAudit(auditDir, { op: 'input', pane: paneId, text: typeof message.bytes === 'string' ? message.bytes : '', exitCode: done.exitCode });
          if (done.exitCode !== 0) send({ type: 'error', message: done.message });
        }).catch(() => send({ type: 'error', message: 'els attach: input inspection failed; not sent' }));
      }
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
  paneBinding?(token: string): { readonly pid: number; readonly start: string; readonly generation: string } | undefined;
  authorize(role: ServerRole, request: ElsRequest): { readonly allow: boolean; readonly reason?: string; readonly verifiedRequest?: ElsRequest };
  audit(request: ElsRequest, role: ServerRole, reason: string, pid: number | undefined, claimedPid?: number): void;
  /** JUD #39057 ⓒ1② — record the requester's role so the pane spawned by this `new` inherits it. */
  /** JUD #39057 ⓒ1③ — `els seat set OP`: the owner's explicit OP registration. */
  seatSet(request: { op: 'seat-set'; seat: string }): ElsResult;
}

export function registerSeatRuntime(request: { op: 'seat-set'; seat: string; runtime?: RuntimeClaim }, guard: Pick<RequestGuard, 'seatSet'>,
  registry: (Pick<SeatRuntimeRegistry, 'register' | 'registrationToken' | 'clear'> & Partial<Pick<SeatRuntimeRegistry, 'checkpoint'>>) | undefined, pid: number | undefined, uid: number | undefined,
  baseline: RuntimeProcess | undefined, publish: (token: string) => void, paneBinding?: { pid: number; start: string }, bindingStillLive?: () => boolean): ElsResult {
  if (request.seat !== 'OP' || request.runtime === undefined) return guard.seatSet(request);
  const restore = registry?.checkpoint?.();
  if (!registry?.register(pid, uid, baseline, request.runtime, paneBinding)) return { exitCode: 1, message: 'els seat set: cannot verify the live OP runtime' };
  if (bindingStillLive && !bindingStillLive()) {
    if (restore) restore(); else registry.clear();
    return { exitCode: 1, message: 'els seat set: pane changed during registration' };
  }
  try {
    const token = registry.registrationToken();
    if (!token) throw new Error('missing registration credential');
    publish(token);
  } catch {
    if (restore) restore(); else registry.clear();
    return { exitCode: 1, message: 'els seat set: cannot publish OP runtime credential' };
  }
  return guard.seatSet(request);
}

export function serveConnection(ready: Promise<ElsCore | undefined>, socket: Socket, stateRoot: string, externalLookup: SeatLookup, guardRef: { current: RequestGuard | undefined }, sendAuditDir: string = dirname(elsSocketPath(stateRoot)), attachState: AttachState = { sockets: new Set<Socket>(), stopping: false }, toolDoor = false, runtimeRegistry?: SeatRuntimeRegistry, injectedSeatLookup = false): void {
  // Capture before any credential syscall; sampling afterward permits a newly reused PID.
  const beforePidLookup = Date.now();
  const uid = peerUid(socket);
  const pid = peerPid(socket);
  const baseline = baselineBeforePidLookup(processIdentity(pid), pid, beforePidLookup);
  const observedRuntimePeer = pid === undefined ? undefined : runtimeProcessIdentity(pid);
  const birth = observedRuntimePeer?.start.split(':').map(Number);
  const runtimeBaseline = birth && birth.length === 2 && birth.every(Number.isSafeInteger)
    && birth[0]! * 1000 + Math.floor(birth[1]! / 1000) < beforePidLookup ? observedRuntimePeer : undefined;
  let runtimeToken: string | undefined;
  const seatLookup: SeatLookup = async (lookupPid, lookupBaseline) => {
    const external = await externalLookup(lookupPid, lookupBaseline);
    const key = lookupPid === pid && runtimeRegistry?.matches(pid, uid, runtimeBaseline, runtimeToken) ? runtimeRegistry.key() : undefined;
    const descendant = runtimeRegistry?.isDescendant(pid, uid, runtimeBaseline) === true;
    if (!key) return (toolDoor || descendant) && !injectedSeatLookup && external?.seat === 'OP' ? undefined : external;
    if (external && external.seat !== 'OP') return undefined;
    return { seat: 'OP', pane: key, runtimeLive: () => runtimeRegistry?.isLiveGeneration(key) === true };
  };
  let handled = false;
  let role: ServerRole = { kind: 'outsider', note: 'no pane credential' };
  let claimedPid: number | undefined;
  let paneToken: string | undefined;
  // JUD #39096 must ⓑ: settle `role` before the door judges — a no-token caller may be a
  // ledger-verified OS peer (peer 판정 함수 재사용). The connection's FIRST lookup is shared by the
  // role door and the control door's initial seat: one lookup, both doors (lookups are counted literally).
  let roleReady: Promise<void> = Promise.resolve();
  let authPending = false;
  let authSeen = false;
  let rejectedPaneCredential = false;
  let boundCore: ElsCore | undefined;
  const deferredLines: string[] = [];
  let deferredChars = 0;
  let closed = false;
  let ending = false;
  const paneRoleValid = (): boolean => {
    if (isServerOwnerRole(role) || (role.kind !== 'op' && role.kind !== 'hand')) return true;
    const core = boundCore;
    const pane = role.pane;
    return !!core && !!paneToken && verifyPanePeer(pid, baseline, pane, () => {
      const minted = guardRef.current?.paneBinding?.(paneToken!);
      const live = core.paneProcessBinding(pane);
      return minted && live && minted.pid === live.pid && minted.start === live.start && minted.generation === live.generation ? minted : undefined;
    }, () => core.shellPids());
  };
  let doorSeat: Promise<PeerSeat | undefined> | undefined;
  const firstSeat = () => (doorSeat ??= (async () => { try { return await seatLookup(pid, baseline); } catch { return undefined; } })());
  /** Once the first line was `attach`: where later lines go. Until the owner is ready they are kept, then replayed in order. */
  let attachLine: ((line: string) => void) | undefined;
  const earlyLines: string[] = [];
  let earlyChars = 0;
  const answer = (result: ElsResult): void => {
    if (closed || ending || socket.destroyed) return;
    ending = true;
    deferredLines.length = 0;
    earlyLines.length = 0;
    socket.end(`${JSON.stringify(result)}\n`);
  };
  const bufferEarly = (line: string): void => {
    earlyChars += line.length + 1;
    if (earlyChars > MAX_REQUEST_CHARS || earlyLines.length >= MAX_PENDING_LINES) { answer({ exitCode: 2, message: 'els: request too large' }); return; }
    earlyLines.push(line);
  };
  /** Post-door handling: seat-set, then spawn-parent capture, attach, or dispatch (JUD #39096 ⓑ restructure). */
  const serveTail = (request: ElsRequest, guard: RequestGuard | undefined): void => {
    if (closed || ending || socket.destroyed) return;
    if (!paneRoleValid()) {
      answer({ exitCode: 1, message: 'els: pane credential denied — socket peer is not a live descendant of that pane' });
      return;
    }
    // Registered runtime descendants follow tool policy even through the human socket.
    // Classify by OS ancestry, not the optional token, which only grants authority.
    const effectiveToolDoor = toolDoor || (request.op !== 'seat-set' && runtimeRegistry?.isDescendant(pid, uid, runtimeBaseline) === true);
    if (effectiveToolDoor && (request.op === 'input' || request.op === 'attach' || request.op === 'send' || request.op === 'send-verified')) {
      answer({ exitCode: 2, message: 'els: raw input, send and attach are unavailable on the tool socket' });
      return;
    }
    // seat-set never reaches core dispatch: it is the auth ledger's own mutation.
    if (request.op === 'seat-set' && guard) {
      void ready.then((core): ElsResult => {
        if (!core) return { exitCode: 1, message: 'els: the server is stopping' };
        const pane = role.kind === 'op' && !isServerOwnerRole(role) ? role.pane : undefined;
        const binding = pane ? core.paneProcessBinding(pane) : undefined;
        if (pane && !binding) return { exitCode: 1, message: 'els seat set: cannot verify the live pane' };
        return registerSeatRuntime(request, guard, runtimeRegistry, pid, uid, runtimeBaseline, token => {
          const target = join(dirname(elsSocketPath(stateRoot)), 'runtime-token');
          const temp = `${target}.${randomBytes(12).toString('hex')}.tmp`;
          try {
            writeFileSync(temp, token, { mode: 0o600, flag: 'wx' });
            renameSync(temp, target);
          } finally { try { unlinkSync(temp); } catch { /* already renamed or never created */ } }
        }, binding, pane && binding ? () => {
          const live = core.paneProcessBinding(pane);
          return !!live && live.pid === binding.pid && live.start === binding.start && live.generation === binding.generation;
        } : undefined);
      }).catch((): ElsResult => ({ exitCode: 1, message: 'els seat set: cannot verify the live pane' })).then(answer);
      return;
    }
    // The pane spawned by this `new` inherits the requester's role (JUD #39057 ⓒ1②) — as a direct argument (JUD #39071), no queue.
    const spawnParent = request.op === 'new' && guard ? spawnParentOf(role) : undefined;
    // The server owner's registered OP role is not a pane credential (its provenance is server-owned).
    const paneSeat = !isServerOwnerRole(role) ? (role.kind === 'op' ? 'OP' : role.kind === 'hand' ? role.seat : undefined) : undefined;
    // ELS-DESKTOP-SIDETAB-SUBSCRIBE: read-only push of the list on this connection (never reaches dispatch).
    if (request.op === 'subscribe') {
      if (effectiveToolDoor || paneSeat !== undefined) { answer({ exitCode: 1, message: 'els: subscribe is unavailable to pane or tool callers' }); return; }
      void ready.then((core) => { if (core) serveSubscribe(core, socket); else answer({ exitCode: 1, message: 'els: the server is stopping' }); });
      return;
    }
    if (request.op === 'attach') {
      // Lines can arrive in the same chunk as the attach line, before `ready` resolves: keep them, never drop them.
      attachLine = bufferEarly;
      void ready.then((core) => {
        if (!core) { answer({ exitCode: 1, message: 'els: the server is stopping' }); return; }
        if (paneSeat !== undefined) {
          const id = core.paneExists(request.pane);
          const callerPane = role.kind === 'hand' || (role.kind === 'op' && !isServerOwnerRole(role)) ? role.pane : undefined;
          if (!id || (id !== callerPane && (paneSeat === 'unknown' || !loadJournal(elsJournalPath(stateRoot)).panes.some(p => p.id === id && p.ownerSeat === paneSeat)))) {
            answer({ exitCode: 1, message: 'els: attach denied — target is not owned by caller seat' });
            return;
          }
        }
        if (closed || ending || socket.destroyed) return;
        serveAttach(core, socket, request, { onLine: (handler) => {
          const queued = earlyLines.splice(0);
          earlyChars = 0;
          for (const early of queued) handler(early);
          attachLine = handler;
        } }, attachState, sendAuditDir, guard ? (message) => guard.authorize(role, { ...message, pane: request.pane } as ElsRequest) : undefined,
          isServerOwnerRole(role) && !effectiveToolDoor);
      });
      return;
    }
    void ready
      .then((core) => core ? dispatch(core, request, spawnParent, stateRoot, uid, pid, seatLookup, baseline, firstSeat, sendAuditDir, effectiveToolDoor, false, paneSeat, role.kind === 'hand' || (role.kind === 'op' && !isServerOwnerRole(role)) ? role.pane : undefined, (denied, reason) => guard?.audit(denied, role, reason, pid, claimedPid), claimedPid) : { exitCode: 1, message: 'els: the server is stopping' } as ElsResult)
      .catch((error: unknown): ElsResult => ({ exitCode: 1, message: `els: ${error instanceof Error ? error.message : String(error)}` }))
      .then(answer);
  };
  const handleLine = (line: string): void => {
    if (closed || ending || socket.destroyed) return;
    if (line.length > MAX_REQUEST_CHARS) { answer({ exitCode: 2, message: 'els: request too large' }); return; }
    if (authPending) {
      deferredChars += line.length + 1; // Include newlines, so even empty lines consume the budget.
      if (deferredChars > MAX_REQUEST_CHARS || deferredLines.length >= MAX_PENDING_LINES) answer({ exitCode: 2, message: 'els: request too large' });
      else deferredLines.push(line);
      return;
    }
    if (rejectedPaneCredential || !paneRoleValid()) {
      handled = true;
      answer({ exitCode: 1, message: 'els: pane credential denied — socket peer is not a live descendant of that pane' });
      return;
    }
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
      if (authSeen) { handled = true; answer({ exitCode: 1, message: 'els: repeated auth denied' }); return; }
      authSeen = true;
      runtimeToken = typeof request.runtimeToken === 'string' ? request.runtimeToken : undefined;
      paneToken = typeof request.token === 'string' ? request.token : undefined;
      role = guard ? guard.classify(request) : { kind: 'outsider', note: 'no pane credential' };
      claimedPid = typeof request.pid === 'number' ? request.pid : undefined;
      // Never downgrade an explicitly invalid token to the unauthenticated human TTY path.
      if (typeof request.token === 'string' && request.token.length > 0 && role.kind === 'outsider') {
        handled = true;
        // Audit only a fixed auth event, never the untrusted credential or other auth fields.
        guard?.audit({ op: 'auth' }, role, 'invalid credential', pid, claimedPid);
        answer({ exitCode: 1, message: 'els: invalid credential' });
        return;
      }
      authPending = true;
      roleReady = ready.then(core => {
        boundCore = core;
        if (!paneRoleValid()) {
          rejectedPaneCredential = true;
          role = { kind: 'outsider', note: 'pane credential does not match socket peer' };
        }
      }).catch(() => {
        rejectedPaneCredential = true;
        role = { kind: 'outsider', note: 'cannot verify socket peer' };
      }).then(() => {
        if (closed || ending || socket.destroyed) return;
        if (rejectedPaneCredential) { answer({ exitCode: 1, message: `auth: ${role.kind}` }); return; }
        socket.write(`${JSON.stringify({ exitCode: 0, message: `auth: ${role.kind}` })}\n`);
        authPending = false;
        const pendingLines = deferredLines.splice(0);
        deferredChars = 0;
        for (const pending of pendingLines) handleLine(pending);
      });
      return;
    }
    // JUD #39096 ⓒ (OP #106663): `attach` 는 이제 문 판정을 통과한다 — mutating op 의 하나로
    // 판정되고, 그 뒤의 input/resize 줄도 같은 판정을 받는다 (serveAttach judge).
    // A pane descendant cannot regain the human read path by omitting its pane credential.
    // Only positively verified human ancestry may use the uncredentialed read path.
    if (!toolDoor && role.kind === 'outsider' && (request.op === 'read' || request.op === 'status' || request.op === 'grep' || request.op === 'attach')) {
      handled = true;
      if (request.op === 'attach') attachLine = bufferEarly;
      void ready.then(async core => {
        if (!core) { answer({ exitCode: 1, message: 'els: server not ready' }); return; }
        const ancestry = inspectReadAncestry(pid, baseline, core.shellPids());
        if (ancestry.kind === 'pane') {
          guard?.audit(request, role, 'pane process without pane credential', pid, claimedPid);
          answer({ exitCode: 1, message: `els: ${request.op} denied — pane credential required` });
          return;
        }
        if (ancestry.kind === 'unknown') {
          answer({ exitCode: 1, message: 'els: 신원 확인 불가 — 사람 화면은 els 사이드에서·자리는 자격 경로로' });
          return;
        }
        serveTail(request, guard);
      }).catch(() => answer({ exitCode: 1, message: 'els: 신원 확인 불가 — 사람 화면은 els 사이드에서·자리는 자격 경로로' }));
      return;
    }
    // Central server-side door: every mutating op of every client is judged here.
    if (isMutating(request)) {
      // JUD must ⓒ2-② (OP #104711): fail-closed — a mutating request that arrives before the guard
      // exists is denied, never waved through. (run() only listens after the guard is ready; this is the backstop.)
      if (!guard) { handled = true; answer({ exitCode: 1, message: `els: ${request.op} denied — not ready (no guard)` }); return; }
      handled = true;
      // JUD #39096 ⓒ: the door verdict is asynchronous; lines arriving in the same chunk as the attach
      // request must be buffered immediately or `handled` drops them. serveTail replays them after the door.
      if (request.op === 'attach') attachLine = bufferEarly;
      // JUD #39096 must ⓑ (OP #105050·#105177): the door admits a «peer seat으로 확인된 OP/RES-INFRA»
      // caller as a principal («토큰 역할 ∨ peer seat», peer 판정 함수 결과, 자기신고 0). The role door
      // waits for the peer lookup to settle; the control 문 still makes the final adjudication.
      void Promise.all([roleReady, ready]).then(async ([, core]) => {
        // `new` needs no peer authority (spawn stays open, JUD #39060 main behavior) — skip the lookup
        // so its count stays literal for the doors that do need it (op-input-socket: lookups === 2).
        if ((role.kind === 'outsider' || (role.kind === 'owner' && request.op !== 'seat-set')) && pid !== undefined && request.op !== 'new') {
          const peer = await firstSeat();
          if (peer && (peer.seat === 'OP' || peer.seat === 'RES-INFRA')) role = { kind: 'peer', pid, pane: peer.pane, seat: peer.seat, uid: uid as number };
          else {
            // JUD #39096 must ⓒ (OP #106966·#107197): 무토큰 연결의 프로세스 조상에 els pane 셸이 있으면
            // 그것은 사람이 아니라 pane 프로세스(손)다 — 사람 전용 outsider 허용에서 제외하고 거부한다.
            const ancestor = core && role.kind === 'outsider' && pid !== undefined ? await resolveAncestorPane(pid, baseline, core.shellPids()) : undefined;
            if (ancestor) {
              guard.audit(request, role, `els pane process (pane ${ancestor.pane}) without pane token`, pid, claimedPid);
              answer({ exitCode: 1, message: `els: ${request.op} denied — caller is an els pane process (pane ${ancestor.pane}); present the pane token` });
              return;
            }
            // JUD #39096 ⓒ: 토큰 없이 연결했지만 pane 자손인 호출자 = env 를 벗겨낸 pane 프로세스다 (맨 터미널의
            // 사람이 아니다) — attach 를 거부한다; pane 프로세스는 자기 pane 토큰을 제시해야 한다.
            if (peer && request.op === 'attach') {
              guard.audit(request, role, `pane-descended caller (seat ${peer.seat}) without pane token`, pid, claimedPid);
              answer({ exitCode: 1, message: `els: attach denied — caller is a pane process (seat ${peer.seat}); present the pane token` });
              return;
            }
          }
        }
        // JUD #39096 must ⓒ (OP #107371): a no-token connection cannot type —
        // input-line is denied by default (fail-closed); a human types with the owner token,
        // a pane process with its pane token, a peer seat via ledger-verified promotion.
        if (role.kind === 'outsider' && request.op === 'input-line') {
          guard.audit(request, role, 'no-token typing denied (owner token required)', pid, claimedPid);
          answer({ exitCode: 1, message: 'els: input-line denied — present the owner token' });
          return;
        }
        const verdict = guard.authorize(role, request);
        if (!verdict.allow) {
          guard.audit(request, role, verdict.reason ?? 'denied', pid, claimedPid);
          answer({ exitCode: 1, message: verdict.reason ?? 'els: denied' });
          return;
        }
        serveTail(verdict.verifiedRequest ?? request, guard);
      });
      return;
    }
    handled = true;
    serveTail(request, guard);
  };
  const lines = createLineDecoder(handleLine);
  socket.on('data', (chunk: Buffer) => {
    lines.push(chunk);
    if (closed || ending) return;
    if ((authPending && deferredChars + lines.pending() > MAX_REQUEST_CHARS) ||
        (attachLine && earlyChars + lines.pending() > MAX_REQUEST_CHARS) ||
        (!handled && lines.pending() > MAX_REQUEST_CHARS)) {
      handled = true; answer({ exitCode: 2, message: 'els: request too large' });
    }
  });
  socket.on('close', () => { closed = true; deferredLines.length = 0; earlyLines.length = 0; });
  socket.on('error', () => { /* the client went away; its request may still finish */ });
}

/** Pane PTYs live in outside holder processes (D1a): src/els/holder.ts holderPty is the default spawn; the
 *  registry-owned registryPty of the old contract is gone — a server stop now releases the panes instead of killing them. */
import { AUTH_OWNER_TOKEN_ENV, AUTH_PANE_TOKEN_ENV, authorizeRequest, denialAuditLine, isMutating, isServerOwnerRole, PaneRegistry, resolveTabCloseScope, rulesLoader, spawnParentOf, type ServerRole, type SpawnParent } from './server-auth.js';
import { archiveExitedPane } from './exited-archive.js';

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
  /** Isolated Telegram transport for a product ELS boot test. */
  readonly ceoFetchImpl?: typeof fetch;
  /** Synthetic CEO SLA clock for an isolated product ELS boot test. */
  readonly ceoClock?: CeoClock;
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
  /** Isolated test clock cadence; production reaps once a minute. */
  readonly reapIntervalMs?: number;
}

/** Become the owner, then load the journal. Resolves to the running server, or to a refusal. */
export async function startElsServer(options: ElsServerOptions = {}): Promise<{ server: Server; core: ElsCore; close: () => Promise<void>; httpV1?: Server } | ElsResult> {
  const stateRoot = options.stateRoot ?? elanousStateRoot();
  const socketPath = elsSocketPath(stateRoot);
  const toolSocketPath = elsToolSocketPath(stateRoot);
  const journalPath = elsJournalPath(stateRoot);
  const tooLong = elsSocketPathProblem(socketPath) ?? elsSocketPathProblem(toolSocketPath);
  if (tooLong) return { exitCode: 1, message: tooLong };
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(socketPath), 0o700);

  let markReady: (core: ElsCore | undefined) => void = () => {};
  const ready = new Promise<ElsCore | undefined>((resolve) => { markReady = resolve; });
  const paneRegistry = new PaneRegistry();
  let ceoWiring: CeoChannelWiring | undefined;
  const owner = paneRegistry.registerOwner();
  process.env[AUTH_OWNER_TOKEN_ENV] = owner.token;
  const guardRef: { current: RequestGuard | undefined } = { current: undefined };
  // ELS-START-PERF: the login-shell capture starts now, beside the journal load, so the first new pane does not pay for it alone.
  if (!options.spawn) void warmLoginEnv();
  // D1a must-1: 이 서버의 attach 연결 원장(서버마다 하나 — 시험의 두 서버가 서로의 연결을 건드리지 않는다).
  const attachState: AttachState = { sockets: new Set<Socket>(), stopping: false };
  const lookup: SeatLookup = options.seatLookup ?? (async (pid, baseline) => {
    const core = await ready;
    if (!core) return undefined;
    const external = await resolvePeerSeatWithAnchor(pid, baseline);
    const internal = resolveElsPeerSeat(pid, baseline, () => core.seatBindings());
    // Distinct identities are ambiguous, never choose one by precedence.
    if (external && internal && (external.pane !== internal.pane || external.seat !== internal.seat)) return undefined;
    return external ?? internal;
  });
  const runtimeRegistry = new SeatRuntimeRegistry();
  const server = createServer((socket) => serveConnection(ready, socket, stateRoot, lookup, guardRef, dirname(socketPath), attachState, false, runtimeRegistry));
  // Explicit seatLookup is an in-process test dependency, never provided by a socket request.
  const toolServer = createServer((socket) => serveConnection(ready, socket, stateRoot, lookup, guardRef, dirname(socketPath), attachState, true, runtimeRegistry, options.seatLookup !== undefined));

  // 2. Owner now: load the journal (requests that arrived meanwhile wait for this).
  const core = createElsCore({ ...(options.now ? { now: options.now } : {}), load: () => loadJournal(journalPath), save: (journal) => saveJournal(journalPath, journal),
    archiveExited: (pane) => { archiveExitedPane(stateRoot, pane); },
    // D1a: pane PTYs live in outside holders — the default, no option flag. A restart adopts them back (reattachHolder).
    // JUD #39096/#39053: registerSpawn 발급 pane 토큰·부모 역할 기록을 홀더 스폰 위에 얹는다.
    // OP #104178 ① — the parent role comes in as a direct argument (JUD #39071), so the token is
    // minted before the PTY call: a spawn that throws must not leave the minted token behind.
    spawn: (command, cwd, title, env, parent) => {
      // Only the authenticated OP parent spawning its OP seat tab receives this tab's secret.
      // Load seat boot only for that spawn; CLI help must not pull in its classic dashboard dependency.
      const opTab = parent?.kind === 'op' &&
        (require('../seat/seat-boot-preamble.js') as typeof import('../seat/seat-boot-preamble.js'))
          .detectSeatTui(cwd, process.env.HOME ? { home: process.env.HOME } : {})?.seat === 'OP';
      const spawnEnv = paneRegistry.registerSpawn({ ...env, ELANOUS_ELS_SOCKET: socketPath, ELANOUS_STATE_DIR: stateRoot,
        ELANOUS_STATE_DIR_SOURCE: stateDirSourceForChild(stateRoot,
          { ...process.env, ...env, NODE_ENV: process.env.NODE_ENV ?? 'production' }),
        ...(opTab ? ceoWiring?.envFor('OP') : {}) }, cwd, parent);
      try {
        const pty = (options.spawn ?? holderPty(stateRoot))(command, cwd, title, spawnEnv);
        paneRegistry.bindSpawn(spawnEnv[AUTH_PANE_TOKEN_ENV], () => pty.processBinding);
        return pty;
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
    if (request.op === 'child') return request.action === 'start' || request.action === 'tree' || request.action === 'summary'
      ? request.ws : request.id ? childTabsOf.get(core)?.workspaceOf(request.id) : undefined;
    if (request.op === 'record' && typeof request.pane === 'string') return core.workspaceOf(request.pane)?.name ?? recordingFor(core, request.pane)?.workspace;
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
    paneBinding: (token) => paneRegistry.spawnBinding(token),
    authorize: (role, request) => {
      if (request.op === 'close-tab') {
        const scope = resolveTabCloseScope(JSON.parse(core.list().message), paneRegistry.entries(), request.tab);
        const verdict = authorizeRequest(role, request, scope?.workspace, loadRules(), scope);
        return verdict.allow && scope
          ? { allow: true, verifiedRequest: { op: 'close-tab', tab: scope.tabId, confirmed: true } }
          : verdict;
      }
      return authorizeRequest(role, request, workspaceOf(request), loadRules());
    },
    audit: (request, role, reason, pid, claimedPid) => {
      try { appendFileSync(join(elsDir, 'control-audit.jsonl'), `${denialAuditLine(request, role, reason, pid, claimedPid)}\n`, { mode: 0o600 }); }
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
  let toolFailed = await listen(toolServer, toolSocketPath);
  if (toolFailed && toolFailed.code === 'EADDRINUSE') {
    const taken = await elsSocketTaken(toolSocketPath);
    if (taken === 'dead') { try { unlinkSync(toolSocketPath); } catch { /* removed meanwhile */ } }
    if (taken !== 'live') toolFailed = await listen(toolServer, toolSocketPath);
  }
  if (toolFailed) {
    markReady(undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { unlinkSync(socketPath); } catch { /* already gone */ }
    return { exitCode: 1, message: `els serve: cannot listen on ${toolSocketPath}: ${toolFailed.message}` };
  }
  chmodSync(toolSocketPath, 0o600);
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
  const reapTimer = setInterval(() => { core.reapExited(); }, options.reapIntervalMs ?? 60_000);
  foregroundTimer.unref();
  drainTimer.unref();
  reapTimer.unref();
  const close = async (): Promise<void> => {
    ceoWiring?.stop();
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
    clearInterval(reapTimer);
    stallAlert?.stop();
    core.stopAll();
    if (httpV1Server) await new Promise<void>((resolve) => httpV1Server!.close(() => resolve()));
    disposeRecordings(core); // every `els record` tap dies with its server; `--stop` disposed its own earlier.
    if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    await Promise.all([server, toolServer].map((listener) => new Promise<void>((resolve) => listener.close(() => resolve()))));
    try { unlinkSync(socketPath); } catch { /* already gone */ }
    try { unlinkSync(toolSocketPath); } catch { /* already gone */ }
  };
  const refused = core.start();
  if (refused) {
    markReady(undefined);
    await close();
    return refused;
  }
  core.reapExited();
  // ELS owns the channel and the same durable mail ledger as its OP tab. A restart scans
  // pending rows before polling Telegram, even when the remote offset already advanced.
  const ceoMailPath = join(stateRoot, 'msg', 'messages.db');
  try {
    ceoWiring = startCeoChannelWiring({
      env: process.env,
      stateDir: join(stateRoot, 'ceo-channel'),
      sideStateRoot: stateRoot,
      mailPath: ceoMailPath,
      ...(options.ceoClock ? { clock: options.ceoClock } : {}),
      ws: process.env.ELANOUS_WS?.trim() || 'elanous-daemon',
      ...(options.ceoFetchImpl ? { fetchImpl: options.ceoFetchImpl } : {}),
      post: (envelope) => {
        const store = openMsgStore(ceoMailPath);
        try { return store.post(envelope); } finally { store.close(); }
      },
    });
    if (ceoWiring) void ceoWiring.run();
  } catch { /* CEO adapter failure never blocks the ELS control door. */ }
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
