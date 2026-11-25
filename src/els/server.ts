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
import { buildCommitTime, cliBuildIdentity } from '../version/build-stamp.js';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { dirname, basename, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { stateDirSourceForChild } from '../agent/identity-env.js';
import { openMsgStore } from '../msg/msg-store.js';
import { declaredFederationSeats } from '../msg/seat-mail-trust.js';
import { loadFederationLadder } from '../msg/hand-raise-ladder.js';
import { ledgerEventsPath } from '../msg/ledger-events.js';
import { createMailEventHub } from './mail-event-hub.js';
import { decodeEventLine } from './agent-events.js';
import { createMailBadgeState } from './mail-badge-state.js';
import type { MailBadgeCompute } from './mail-badge-cache.js';
import { startCeoChannelWiring, type CeoChannelWiring } from './ceo-ingress-wiring.js';
import type { CeoClock } from '../agent-events/ceo-ingress.js';
import { createChildTabs, type ChildScene, type ChildSource, type ChildTabs, type ChildTabsDeps } from './child-tabs.js';
import { readCeoSideAlert } from './ceo-side-alert.js';
import { ActorBindings } from './actor-binding.js';
import { BatonLease, type BatonActor, type BatonAlert } from './baton.js';
import { readUnreadCount } from '../msg/msg-store.js';
import { createElsCore, type ElsCore, type ElsPty, type ElsResult } from './core.js';
import { elsJournalPath, loadJournal, saveJournal } from './journal.js';
import { warmLoginEnv } from './login-env-handoff.js';
import { holderPty, consumeScreenSnapshot, reattachHolder, restoreScreenFromSnapshot, sweepOrphanHolderResidue } from './holder.js';
import { doPolicy, startElsHttp, type ElsHttpBind } from './http.js';
import { startStallAlert, type StallAlert, type StallAlertDeps } from './stall-alert.js';
import { startMailWakeWatcher, type MailWakeDeps, type MailWakeWatcher } from './mail-wake-watcher.js';
import { startElsHttpV1 } from './http-v1.js';
import { appendSendAudit, type ControlExecute } from './control.js';
import { createLineDecoder } from './wire.js';
import { serveSubscribe } from './subscribe.js';
import { foregroundOf, parsePs, type Foreground } from './foreground.js';
import { audit as controlAudit, authorize, classifyShell, createControl, inputExplicitlyDenied, pinAllowList } from './control.js';
import { journalControl } from './control-cli.js';
import { peerUid } from './peer-uid.js';
import { auditOperator, localOperatorAllowed, LOCAL_OPERATOR_OPS } from './local-operator.js';
import { runtimeProcessIdentity, SeatRuntimeRegistry, type RuntimeProcess, type RuntimeClaim } from './seat-runtime.js';
import { peerPid, processIdentity, processStartStamp, baselineBeforePidLookup, resolvePeerSeatWithAnchor, resolveElsPeerSeat, resolveAncestorPane, inspectReadAncestry, verifyPanePeer, type ProcessIdentity } from './peer-seat.js';
type PeerSeat = { pane: string; seat: string; anchor?: ProcessIdentity; runtimeLive?: () => boolean };
type SeatLookup = (pid: number | undefined, baseline?: ProcessIdentity) => Promise<PeerSeat | undefined> | PeerSeat | undefined;
const sameSeatGeneration = (a: PeerSeat, b: PeerSeat): boolean => {
  if (a.pane !== b.pane || a.seat !== b.seat) return false;
  if (!a.anchor && !b.anchor) return true; // Test seams without an anchor cannot recover an exited peer.
  return !!a.anchor && !!b.anchor && a.anchor.pid === b.anchor.pid && a.anchor.start === b.anchor.start
    && a.anchor.session === b.anchor.session && a.anchor.tty === b.anchor.tty;
};
import { createOutboundWebhooks } from './webhook-out.js';

// ELS-STALE-CLIENT: this server process's build (sha + build time), read once — the code a running process executes never changes.
let serverBuildJson: string | undefined;
function withServerBuild(message: string): string {
  if (!message.trimEnd().endsWith('}')) return message;
  if (serverBuildJson === undefined) {
    try { const build = cliBuildIdentity(); const builtAt = buildCommitTime(build); serverBuildJson = JSON.stringify({ sha: build.sha, ...(builtAt !== undefined ? { builtAt } : {}) }); }
    catch { serverBuildJson = ''; }
  }
  if (!serverBuildJson) return message;
  const body = message.trimEnd();
  return `${body.slice(0, -1)}${body.endsWith('{}') ? '' : ','}"serverBuild":${serverBuildJson}}`;
}

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
  | { readonly op: 'baton'; readonly action: 'hand' | 'take' | 'return' | 'status' | 'auto-hand' | 'auto-return' | 'auto-skip'; readonly owner?: string; readonly acting?: string; readonly reason?: string; readonly ttlMs?: number; readonly handoff?: string; readonly exclude?: readonly number[] }
  | { readonly op: 'ping' }
  | { readonly op: 'event'; readonly pane?: string }
  | { readonly op: 'auth'; readonly token?: string; readonly runtimeToken?: string; readonly pid?: number }
  /** OP #128880: a holder verifies a credential-request nonce against this server process (kernel peer pid +
   *  holder generation start + the memory-only generation nonce) before its pane token ever leaves the holder. */
  | { readonly op: 'adopt-verify'; readonly pane: string; readonly holderPid: number; readonly holderStart?: string; readonly nonce: string; readonly challenge?: string }
  | { readonly op: 'build'; readonly pane: string; readonly sha: string; readonly version?: string; readonly stamp?: string }
  | { readonly op: 'ls' }
  | { readonly op: 'subscribe' }
  | { readonly op: 'grep'; readonly pattern: string }
  | { readonly op: 'new'; readonly ws: string; readonly cwd: string; readonly command: readonly string[]; readonly title?: string; readonly uniqueSeat?: string }
  | { readonly op: 'read'; readonly pane: string; readonly at?: { readonly ws: string; readonly tab: string } }
  | { readonly op: 'send'; readonly pane: string; readonly text: string }
  | { readonly op: 'status'; readonly pane: string }
  | { readonly op: 'send-verified'; readonly pane: string; readonly text: string; readonly requireEmpty?: boolean }
  | { readonly op: 'attach'; readonly pane: string; readonly cols?: number; readonly rows?: number; readonly diff?: boolean; readonly focusEvents?: boolean }
  | { readonly op: 'seat-focus'; readonly pane: string }
  | { readonly op: 'focus-empty'; readonly ws: string }
  | { readonly op: 'focus-ack'; readonly id: string; readonly accepted: boolean }
  // #38608 REVIEW must ② — `input` is the raw person path (attach keystrokes, `els pane run`/`send-keys`):
  // control bytes stay raw by design. A top-level input names its pane; an attach stream supplies the attached pane.
  | { readonly op: 'input'; readonly bytes: string; readonly pane?: string }
  | { readonly op: 'resize'; readonly cols: number; readonly rows: number }
  /** Attach connection only: move this view `lines` up (positive) or down into the pane's scrollback; any typed input — or new pane output — returns to the bottom. */
  | { readonly op: 'scroll'; readonly lines: number }
  | { readonly op: 'coordinator'; readonly ws: string; readonly seat?: string }
  | { readonly op: 'hq-coordinator'; readonly seat: string }
  | { readonly op: 'move-tab'; readonly tab: string; readonly ws: string }
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
  | { readonly op: 'seat-bind'; readonly seat: string; readonly pane: string }
  | { readonly op: 'child'; readonly action: 'start' | 'progress' | 'status' | 'end' | 'scene' | 'pin' | 'unpin' | 'dismiss' | 'tree' | 'summary';
      readonly id?: string; readonly ws?: string; readonly cwd?: string; readonly source?: ChildSource; readonly label?: string;
      readonly parent?: string; readonly line?: string; readonly state?: 'working' | 'blocked' | 'idle'; readonly ok?: boolean; readonly summary?: string;
      readonly scene?: ChildScene };

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
    case 'scene': return r.scene ? tabs.scene(id, r.scene) : { exitCode: 2, message: 'els child: scene needs a scene' };
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

/** The `ps` the server was started with (tests inject a fixed table); absent = the real process table. */
const psOf = new WeakMap<ElsCore, () => Promise<string>>();

/** ELS-OP-PROSE-INPUT-HOLD: does the pane run an agent (eln/codex/claude/grok) in its foreground right now? A fresh
 *  `ps` decides, never the cached listing; an unknown pid, a failed `ps` or any other foreground answers no. */
async function agentForeground(core: ElsCore, pane: string): Promise<boolean> {
  const pid = core.shellPids().find(row => row.pane === pane)?.pid;
  if (!pid) return false;
  let text = '';
  try { text = await (psOf.get(core) ?? psSnapshot)(); } catch { return false; }
  const kind = text ? foregroundOf(pid, parsePs(text))?.kind : undefined;
  return kind === 'eln' || kind === 'codex' || kind === 'claude' || kind === 'grok';
}

/**
 * ELS-OP-PROSE-INPUT-HOLD: a plain-language line the HQ coordinator typed into another seat's tab is also posted to that
 * seat's mailbox (kind info, «[typed into your tab]» + the text), so the instruction survives a lost screen. The audit
 * ledger gets one row with the mail id or the reason it was not posted — the text only as its length and sha256.
 */
function typedMailCopy(stateRoot: string, elsDir: string, callerSeat: string | undefined, pane: string, text: string): void {
  const journal = loadJournal(elsJournalPath(stateRoot));
  const from = callerSeat && callerSeat !== 'unknown' ? callerSeat : journal.hqCoordinatorSeat || 'OP';
  const to = journal.panes.find(p => p.id === pane)?.ownerSeat;
  const row = { principal: 'hq-typed-mail', kind: 'cli', seat: from, pane, action: 'input', chars: text.length, sha256: createHash('sha256').update(text).digest('hex'), at: Date.now() };
  if (!to || to === 'unknown' || to === from) { controlAudit(elsDir, { ...row, result: 'mail-skipped', reason: to === from ? 'target pane is the caller seat' : 'target pane has no seat' }); return; }
  try {
    const store = openMsgStore(join(stateRoot, 'msg', 'messages.db'));
    try {
      const posted = store.post({ from, to, kind: 'info', intent: 'info', body: `[typed into your tab] ${text}` });
      controlAudit(elsDir, { ...row, to, result: 'mail-posted', mailId: posted.id });
    } finally { store.close(); }
  } catch (error) {
    controlAudit(elsDir, { ...row, to, result: 'mail-failed', reason: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * OP-HANDLES-L2 — the coordinator grant for a caller seat on one request, read from the live journal and the declared
 * federation (seat registry ⊕ federation.yaml, cached 30 s). Undefined = the ordinary own-pane rules decide.
 */
function coordinatorGrantForSeat(core: ElsCore, stateRoot: string, seat: string | undefined, callerPane: string | undefined, request: ElsRequest): CoordinatorGrant | undefined {
  try {
    const journal = loadJournal(elsJournalPath(stateRoot));
    const fed = journal as unknown as FederationJournal;
    const authority = coordinatorAuthority(seat, callerPane, fed, declaredHqCoordinator());
    if (!authority) return undefined;
    return coordinatorGrant(authority, request as { op: string }, fed, declaredFederationSeats(), ref => core.paneExists(ref) || undefined);
  } catch { return undefined; }
}

/** DEMO-FANOUT-LIVE-OP-SEAT: a worker child's folder — the requested one, unless that is a seat's folder (then a fresh
 *  folder under this els state: `<els>/workers/<id>`). The seat test is the seat boot's own (detectSeat), with no env. */
export function workerChildCwd(stateRoot: string, requested: string): string {
  const { detectSeat } = require('../seat/seat-boot-preamble.js') as typeof import('../seat/seat-boot-preamble.js');
  if (!detectSeat(requested, {} as NodeJS.ProcessEnv)) return requested;
  const dir = join(dirname(elsSocketPath(stateRoot)), 'workers', `w${Date.now().toString(36)}${randomBytes(3).toString('hex')}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function declaredHqCoordinator(): string | undefined {
  try { return loadFederationLadder().hq; } catch { return undefined; }
}

async function dispatch(core: ElsCore, request: ElsRequest, parent: SpawnParent | undefined, stateRoot: string, uid: number | undefined, pid: number | undefined, seatLookup: SeatLookup, baseline: ProcessIdentity | undefined, firstSeat: (() => Promise<PeerSeat | undefined>) | undefined, sendAuditDir: string, toolDoor: boolean, toolDo = false, paneSeat?: string, callerPane?: string, auditDenial?: (request: ElsRequest, reason: string) => void, claimedPid?: number, actorCurrent?: () => boolean, actorSeat?: string, reauthorize?: (request: ElsRequest) => { readonly allow: boolean; readonly reason?: string }): Promise<ElsResult> {
  // JUD #39484 ② — a tool-door actor is re-verified on EVERY message, never once per connection.
  if (toolDoor && actorCurrent && !actorCurrent()) {
    return { exitCode: 1, message: 'els: denied — actor binding is stale' };
  }
  // Coordinator is a global OP action, not a workspace-owned operation; tool callers
  // still go through the tool door below and are denied.
  // ELS-OP-CLOSE-TAB (대표 11-24): closing a seat's tab is the same kind of global OP action — the guard has already
  // judged it (server-auth: coordinator closes a non-OP tab · the OP tab itself needs a person).
  const opCoordinator = (request.op === 'coordinator' || request.op === 'hq-coordinator' || request.op === 'close-tab')
    && (paneSeat === 'OP' || isActingSeat(dirname(elsSocketPath(stateRoot)), paneSeat));
  const tabRenameAuthority = request.op === 'rename' && request.kind === 'tab' && (() => {
    const journal = loadJournal(elsJournalPath(stateRoot));
    const tab = journal.tabs.find(t => t.id === request.id);
    const ws = journal.workspaces.find(w => w.id === tab?.workspaceId);
    const seat = paneSeat ?? actorSeat;
    return !!seat && (seat === 'OP' || (!!ws && ws.coordinatorSeat === seat));
  })();
  if ((paneSeat !== undefined && !opCoordinator && !tabRenameAuthority && !['ping', 'ls', 'new'].includes(request.op)) ||
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
    // OP-HANDLES-L2: the coordinator grant (journal ⊕ federation) covers typing / close / close-tab on federation seat panes.
    const coordinatorGranted = (): boolean => !!coordinatorGrantForSeat(core, stateRoot, seat?.seat, (seat as { pane?: string } | undefined)?.pane ?? callerPane, request);
    if (request.op === 'read' || request.op === 'snapshot' || request.op === 'record' || request.op === 'status' || request.op === 'close' || request.op === 'build' || request.op === 'do' || request.op === 'input-line' || request.op === 'interrupt' || request.op === 'send' || request.op === 'send-verified' || request.op === 'input') {
      const recording = request.op === 'record' && typeof request.pane === 'string' ? recordingFor(core, request.pane) : undefined;
      allowed = typeof request.pane === 'string' && (ownPane(request.pane) || ((request.op === 'read' || request.op === 'status' || hqTypingRequest(request)) && !!core.paneExists(request.pane) && hqReadObserver(seat?.seat, callerPane, journal)) || (request.op === 'record' &&
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
      const scoped = seat && request.op === 'reorder' ? coordinatorTabScope({ kind: 'hand', pane: callerPane ?? '', seat: seat.seat, workspaces: [] }, request, journal) : undefined;
      allowed = scoped ? scoped.allow : (request.op === 'rename' && request.kind === 'tab' ? tabRenameAuthority : ownKind(request.kind, request.id)) && (request.op !== 'reorder' || request.before === undefined || request.before === '' || request.before === 'end' || ownKind(request.kind, request.before));
    } else if (request.op === 'close-workspace') allowed = ownWorkspace(request.ws);
    else if (request.op === 'close-tab') allowed = ownTab(request.tab);
    if (!allowed && (request.op === 'close' || request.op === 'close-tab' || request.op === 'do' || request.op === 'input-line' || request.op === 'send' || request.op === 'send-verified' || request.op === 'input')) allowed = coordinatorGranted();
    if (!allowed) {
      if (request.op === 'do' || request.op === 'coordinator') auditDenial?.(request, 'target is not owned by caller seat');
      return { exitCode: 1, message: `els: ${request.op} denied — target is not owned by caller seat${request.op === 'record' && typeof request.pane === 'string' ? ` (${JSON.stringify(request.pane)})` : ''}` };
    }
  }
  switch (request.op) {
    case 'build': {
      if (typeof request.pane !== 'string' || typeof request.sha !== 'string') return { exitCode: 2, message: 'els build: pane and sha required' };
      const reported = core.reportBuild(request.pane, request.sha, request.version, request.stamp);
      // ELS-BATON-AUTO-ON-RESTART: a TUI booting in the OP seat pane reports its build — that is the new OP registering.
      if (reported.exitCode === 0 && pid !== undefined && callerPane === request.pane
        && loadJournal(elsJournalPath(stateRoot)).panes.find(p => p.id === request.pane)?.ownerSeat === 'OP')
        noteOpRegistration(dirname(elsSocketPath(stateRoot)), stateRoot, pid, `new OP pane ${request.pane} registered (pid ${pid})`);
      return reported;
    }
    case 'ping': return { exitCode: 0, message: `els server pid ${process.pid}` };
    case 'hq-coordinator': return typeof request.seat === 'string' && request.seat.trim()
      ? core.setHqCoordinator(request.seat)
      : { exitCode: 2, message: 'els hq coordinator: seat required' };
    case 'coordinator': return typeof request.ws === 'string' && request.ws.trim()
      ? request.seat === undefined ? core.setCoordinator(request.ws, pid) : core.setSpaceCoordinator(request.ws, request.seat)
      : { exitCode: 2, message: 'els ws coordinator: workspace required' };
    case 'rename': return typeof request.kind === 'string' && typeof request.id === 'string' && typeof request.name === 'string'
      ? core.rename({ kind: request.kind, id: request.id, name: request.name })
      : { exitCode: 2, message: 'els rename: kind, id and name are required' };
    case 'ls': {
      const listed = core.list();
      if (listed.exitCode !== 0) return listed;
      const side = readCeoSideAlert(stateRoot);
      // ELS-STALE-CLIENT: the server's own build rides every listing, so a client started before an update can see it is older.
      if (side.kind === 'absent') return { ...listed, message: withServerBuild(listed.message) };
      const payload = JSON.parse(withServerBuild(listed.message)) as Record<string, unknown>;
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
        const toolSeat = await firstSeat?.();
        if (!authorize(rules, { id: 'eln:tool', kind: 'eln' }, { workspace, pane: '', shell: false }, 'new')
          && !coordinatorGrantForSeat(core, stateRoot, toolSeat?.seat, toolSeat?.pane, request)) {
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
      const scopedSeat = parent?.kind === 'hand' ? parent.seat : !parent ? peer?.seat : undefined;
      if (scopedSeat) {
        const scoped = coordinatorTabScope({ kind: 'hand', seat: scopedSeat, workspaces: [], pane: callerPane ?? peer?.pane ?? '' }, request, loadJournal(elsJournalPath(stateRoot)));
        if (scoped && !scoped.allow) return { exitCode: 1, message: scoped.reason };
      }
      // An OP-owned worker remains owned by OP without inheriting an OP pane credential.
      const spawnParent = toolDoor && ownerSeat === 'OP' ? undefined : parent;
      // Check and spawn synchronously in the single owner, after all asynchronous authorization.
      // Parallel seat-open clients cannot both observe an empty list and create duplicates.
      if (request.uniqueSeat !== undefined) {
        if (!/^[A-Z][A-Z0-9_-]{0,63}$/.test(request.uniqueSeat) || !request.cwd.endsWith(`/seats/${request.uniqueSeat}`))
          return { exitCode: 2, message: 'els seat: invalid unique seat' };
        const listed = core.list();
        if (listed.exitCode !== 0) return listed;
        const panes = (JSON.parse(listed.message) as { panes: { seat: string | null; state: string; ptyId: string; pane: string; address: string }[] }).panes;
        const existing = panes.filter(p => p.seat === request.uniqueSeat && p.state !== 'exited' && p.ptyId && p.pane);
        if (existing.length > 1) return { exitCode: 1, message: `els seat: multiple live tabs for ${request.uniqueSeat}; choose one explicitly` };
        if (existing.length === 1) return { exitCode: 0, message: JSON.stringify({ pane: existing[0]!.pane, address: existing[0]!.address, existing: true }) };
      }
      const currentVerdict = reauthorize?.(request);
      if (currentVerdict && !currentVerdict.allow) return { exitCode: 1, message: currentVerdict.reason ?? 'els: new denied' };
      // DEMO-FANOUT-LIVE-OP-SEAT: a pane an agent opens through the tool door is that caller pane's worker child — the
      // verified caller pane (its server-minted credential), never a pane named in the request. A seat tab is never a child.
      const childOf = toolDoor && request.uniqueSeat === undefined && callerPane ? core.paneExists(callerPane) : undefined;
      // A worker child opened from a seat's folder would read that folder as its own seat (boot card, seat loop, «from»
      // of its mail — mail to the parent then folds as self-mail). It works in its own folder under this els instead.
      const cwd = childOf ? workerChildCwd(stateRoot, request.cwd) : request.cwd;
      return core.newPane({ ws: request.ws, cwd, command: request.command, ...(request.title ? { title: request.title } : {}), ...(spawnParent ? { parent: spawnParent } : {}), ...(ownerSeat ? { ownerSeat } : {}), ...(request.uniqueSeat ? { seatIdentity: request.uniqueSeat } : {}), ...(childOf ? { parentPane: childOf } : {}) });
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
    case 'move-tab': return core.moveTab(request.tab, request.ws);
    case 'reorder': return core.reorder({ kind: request.kind, id: request.id, ...(request.before === undefined ? {} : { before: request.before }) });
    case 'close': return core.close(request.pane);
    case 'close-workspace': return core.closeWorkspace(request.ws);
    case 'close-tab': return core.closeTab(request.tab);
    case 'do': {
      if (typeof request.text !== 'string' || typeof request.from !== 'string') return { exitCode: 2, message: 'els do: text and from are required' };
      if (toolDoor) return dispatch(core, { ...request, op: 'input-line' }, parent, stateRoot, uid, pid, seatLookup, baseline, firstSeat, sendAuditDir, true, true, undefined, callerPane);
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
      // ELS-OP-CROSS-SPACE-SEND: the HQ observer may type a line into any pane; interrupt (Escape) stays owner-only.
      // OP-HANDLES-L2: a space coordinator types into federation seat panes of its own spaces the same way.
      const hqTyping = (who: PeerSeat | undefined): boolean => !interrupt && !!who && (hqReadObserver(who.seat, who.pane, loadJournal(elsJournalPath(stateRoot)))
        || (typeof request.pane === 'string' && !!coordinatorGrantForSeat(core, stateRoot, who.seat, who.pane, { op: 'input-line', pane: request.pane, text: '', from: '' } as ElsRequest)));
      const hq = hqTyping(seat);
      const elsDir = dirname(elsSocketPath(stateRoot));
      // ELS-OP-PROSE-INPUT-HOLD: the HQ coordinator hands a task to a seat's tab in plain words. A line the safe-shell
      // list would hold (prose) keeps only the danger table — a destructive line is still held — and only while the pane
      // runs an agent right now (fresh process probe, never the listing): prose never reaches a bare shell. Everyone
      // else, and the HQ caller on a shell pane, keeps the tool's safe-shell policy.
      const hqProse = hq && toolDoor && valid && !!target && typeof text === 'string' && classifyShell(text).dangerous
        && await agentForeground(core, target.pane);
      const door = createControl({ stateDir: elsDir, resolve: lookup.resolve, inputUsesDoPolicy: toolDoor && !interrupt && !hqProse,
        isActingOperator: principal => !!seat && uid !== undefined && principal.id === `local:${uid}`
          && principal.callerPane === seat.pane && principal.callerSeat === seat.seat && (hq || isActingSeat(elsDir, seat.seat)),
        guard: () => {
          if (!valid || !target) return 'invalid input request or unknown target';
          const owner = loadJournal(elsJournalPath(stateRoot)).panes.find(p => p.id === target.pane)?.ownerSeat;
          return toolDoor && (!seat || (!hq && (!owner || owner !== seat.seat))) ? 'target pane owner is unknown or differs from caller seat' : undefined;
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
              const hqFresh = hqTyping(fresh);
              // OP-HANDLES-L2: a coordinator grant is the rule for federation seat panes; other targets still need a tool rule.
              // DEMO-FANOUT-LIVE-OP-SEAT: the caller's own worker child — opened by this verified caller pane through the tool
              // door (server-set parentPane) and owned by the same seat — takes the caller's typed task like any owned pane.
              const ownWorker = toolDoor && !!callerPane && !!fresh && owner === fresh.seat
                && journal.panes.find(p => p.id === currentTarget.pane)?.parentPane === callerPane;
              const toolGrant = !toolDoor || authorize(rules, { id: 'eln:tool', kind: 'eln' }, currentTarget, 'do') || ownWorker
                || (!!fresh && !!coordinatorGrantForSeat(core, stateRoot, fresh.seat, fresh.pane, { op: 'input-line', pane: currentTarget.pane, text: '', from: '' } as ElsRequest));
              return !!fresh && sameSeatGeneration(seat, fresh) && (!toolDoor || owner === seat.seat || hqFresh)
                && (fresh.seat === 'OP' || fresh.seat === 'RES-INFRA' || isActingSeat(elsDir, fresh.seat) || hqFresh)
                && toolGrant && !inputExplicitlyDenied(rules, input.principal, currentTarget)
                && (!hqProse || await agentForeground(core, currentTarget.pane));
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
      if (result.ok && result.exitCode === 0 && hqProse && target && typeof text === 'string')
        typedMailCopy(stateRoot, elsDir, seat?.seat, target.pane, text);
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
  /** Only owner-authenticated full views opt into focus events. */
  readonly focusViews?: Map<string, Set<Socket>>;
  readonly focusPending?: Map<string, { socket: Socket; resolve: (accepted: boolean) => void }>;
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
    if (sized.exitCode === 0) childTabsOf.get(core)?.redraw(paneId);
    if (sized.exitCode !== 0 && sized.exitCode !== 1) { socket.end(`${JSON.stringify({ type: 'end', exitCode: sized.exitCode, message: sized.message })}\n`); return; }
  }
  attachState.sockets.add(socket);
  // Only the full, authenticated human view represents selection; one-pane
  // attaches and machine clients must not replace the remembered location.
  if (request.focusEvents && humanApprovalKeys) core.rememberFocus(paneId);
  if (request.focusEvents && humanApprovalKeys && attachState.focusViews) {
    const views = attachState.focusViews.get(paneId) ?? new Set<Socket>();
    views.add(socket);
    attachState.focusViews.set(paneId, views);
  }
  let seq = 0;
  let lastKey: string | undefined;
  let shownBack = 0;
  let back = 0;                  // how far this view is scrolled above the live bottom
  let busy = false;
  // ELS-TYPING-LATENCY: a poke that lands while a frame is in flight (or while the socket is backed up) is remembered,
  // not dropped — otherwise the echo of the last typed key waited for the pane's NEXT output (an idle pane: forever).
  let dirty = false;
  let drainWait = false;
  let closed = false;
  // ELS-ATTACH-FRAME-DIFF (OP #127484 ③ — herdr protocol/render_ansi.rs pattern): an opted-in client gets only the
  // rows that changed since the frame it last received. `lastRows` is that frame's body; a full frame (the first
  // one, and any size/scroll-back change, where rows are not comparable) resets it and is what `lastKey` still keys on.
  const wantsDiff = request.diff === true;
  let lastRows: readonly string[] | undefined;
  const send = (value: object): void => { if (!closed && !socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
  // ELS-INPUT-FAST-PATH (b): a per-key audit write is not part of typing. Accepted keys buffer here
  // and flush together — one disk write per burst (the first key starts a 500 ms unref'd timer; the
  // attach ending flushes the rest). A REFUSED input is a security event (ELS-SECURITY-AUDIT-IMMEDIATE,
  // OP #130745): it bypasses this buffer and lands in the ledger the moment the refusal happens —
  // never delayed, never dropped by a close race.
  const inputAudit: { op: 'input'; pane: string; text: string; exitCode: 0 | 1 | 2 }[] = [];
  let inputAuditTimer: ReturnType<typeof setTimeout> | undefined;
  const flushInputAudit = (): void => {
    if (inputAuditTimer !== undefined) { clearTimeout(inputAuditTimer); inputAuditTimer = undefined; }
    for (const record of inputAudit.splice(0)) appendSendAudit(auditDir, record);
  };
  const auditInputOutcome = (text: string, exitCode: 0 | 1 | 2): void => {
    if (exitCode === 0) {
      inputAudit.push({ op: 'input', pane: paneId, text, exitCode: 0 });
      if (inputAuditTimer === undefined) {
        inputAuditTimer = setTimeout(flushInputAudit, 500);
        inputAuditTimer.unref?.();
      }
    } else {
      appendSendAudit(auditDir, { op: 'input', pane: paneId, text, exitCode });
    }
  };
  // ELS-INPUT-FAST-PATH (OP #129755 / JUD-B #129747): a guarded delivery is async — its inspection
  // renders the screen — so a key typed behind it would overtake it on the PTY and in the audit
  // ledger. This attach chains its input lines in typed order while a guarded delivery is in
  // flight; with the chain empty a fast key stays fully synchronous (the latency budget lane).
  let inputFlight: Promise<void> | undefined;
  const settleInputFlight = (flight: Promise<void>): void => {
    const clear = (): void => { if (inputFlight === flight) inputFlight = undefined; };
    void flight.then(clear, clear);
  };
  const deliverGuarded = (text: string, raw: string): Promise<void> =>
    core.machineInput(paneId, raw).then(
      (done) => {
        auditInputOutcome(text, done.exitCode === 0 ? 0 : done.exitCode === 2 ? 2 : 1);
        if (done.exitCode !== 0) send({ type: 'error', message: done.message });
      },
      () => send({ type: 'error', message: 'els attach: input inspection failed; not sent' }),
    );
  const runInputLine = (text: string, raw: string): Promise<void> => {
    const fast = core.machineFastInput(paneId, raw);
      if (!('redirectToGuard' in fast)) {
        if (fast.exitCode !== 0) { send({ type: 'error', message: fast.message }); auditInputOutcome(text, fast.exitCode === 2 ? 2 : 1); }
        else auditInputOutcome(text, 0);
        return Promise.resolve();
      }
    return deliverGuarded(text, raw);
  };
  const tick = async (): Promise<void> => {
    if (closed) return;
    if (busy) { dirty = true; return; }
    if (socket.writableLength > ATTACH_MAX_QUEUED_BYTES) {
      dirty = true;
      if (!drainWait) { drainWait = true; socket.once('drain', () => { drainWait = false; if (dirty) poke(); }); }
      return;
    }
    dirty = false;
    busy = true;
    try {
      const asked = back;
      const screen = await core.frame(paneId, asked);
      if (closed) return;
      if (screen.exitCode !== 0) { send({ type: 'end', exitCode: 1, message: screen.message }); socket.end(); return; }
      const size = core.paneSize(paneId);
      // ELS-WHEEL-SCROLLBACK (OP #136704): the pane's own wheel lane — true while the pane's emulator is on an alternate
      // screen tracking its own mouse. The flag rides every frame, and a mode flip repaints, so the next frame carries it.
      const wheelPassthrough = core.wheelPassthrough?.(paneId) === true;
      // ELS-WHEEL-HISTORY: the full route (mouse report · ↑/↓ · els scrollback) — read after the frame's snapshot, so it is current.
      const wheelRoute = core.wheelRoute?.(paneId) ?? 'host';
      // A resize alone is a change too: the client repaints at the new size even when the text is the same.
      const shown = Number(/^\[screen \d+x\d+ scrolled-back=(\d+)\]\n/.exec(screen.message)?.[1] ?? 0);
      shownBack = shown;
      back = Math.max(0, back - (asked - shown));   // the emulator clamps to what it kept; scrolls that arrived meanwhile stay
      const key = `${size.cols}x${size.rows}\n${wheelRoute}\n${screen.message}`;
      if (key !== lastKey) {
        lastKey = key;
        const body = screen.message.replace(/^\[screen \d+x\d+ scrolled-back=\d+\]\n/, '').split('\n');
        let sentDiff = false;
        if (wantsDiff && lastRows !== undefined && lastRows.length === body.length && shown === 0) {
          const changed: { i: number; t: string }[] = [];
          for (let i = 0; i < body.length; i++) if (body[i] !== lastRows[i]) changed.push({ i: i + 1, t: body[i]! });
          // A rewrite of most of the screen pays more in JSON per row than one full frame — send the full frame instead.
          if (changed.length > 0 && changed.length <= Math.ceil(body.length * 0.6)) {
            send({ type: 'frame-diff', pane: paneId, seq: ++seq, cols: size.cols, rows: size.rows, back: shown, ...(wheelPassthrough ? { wheelPassthrough: true } : {}), ...(wheelRoute !== 'host' ? { wheelRoute } : {}), count: body.length, lines: changed });
            sentDiff = true;
          }
        }
        if (!sentDiff) send({ type: 'frame', pane: paneId, seq: ++seq, cols: size.cols, rows: size.rows, back: shown, ...(wheelPassthrough ? { wheelPassthrough: true } : {}), ...(wheelRoute !== 'host' ? { wheelRoute } : {}), screen: screen.message });
        lastRows = body;
      }
      if (attachState.stopping) { send({ type: 'end', exitCode: 1, message: 'the server is stopping' }); socket.end(); return; }
      if (!core.paneIsLive(paneId)) { send({ type: 'end', exitCode: 0, message: 'pane exited' }); socket.end(); }
    } finally { busy = false; }
    if (!closed && (dirty || back !== shownBack)) poke();      // output or a scroll arrived while this frame was rendering
  };
  const poke = (): void => { tick().catch(() => { busy = false; }); };
  // 출처: seat-state/OP/orders/ELS-FIRST-RUN-UX-1119.md ④ p95 ≤ 50ms — PTY 데이터 이벤트 즉시 푸시 (attach 연결 = pane 스트림 구독)
  // ELS-WHEEL-SCROLLBACK completion (JUD-C #137142 / JUD-B #137144): a scrolled view returns to the live bottom when
  // the pane prints — the person is reading history and new output means the story moved on without them. Typed input
  // already returns (the scroll contract); this is the pane's own voice getting the same return, the offset dropped
  // before the push so the next frame renders the live bottom whatever a mid-render tick had asked for.
  const sub = core.onOutput?.(paneId, () => { if (back > 0) back = 0; poke(); });
  // ELS-FIRST-RUN-FU3 ②: subscribed → no screen poll (no re-render, no re-sent frame); only a liveness check. A PTY without
  // an output event keeps the old 100 ms poll.
  const liveness = (): void => {
    if (closed || core.paneIsLive(paneId)) return;
    poke();   // one last frame (the screen it left) and the «pane exited» end
  };
  const timer = sub ? setInterval(liveness, ATTACH_LIVENESS_MS) : setInterval(poke, ATTACH_POLL_MS);
  timer.unref?.();
  const stop = (): void => {
    closed = true;
    clearInterval(timer);
    sub?.dispose();
    attachState.sockets.delete(socket);
    const views = attachState.focusViews?.get(paneId);
    views?.delete(socket);
    if (views?.size === 0) attachState.focusViews?.delete(paneId);
    // The close flush waits for an in-flight guarded delivery: every input line leaves exactly one row.
    void (inputFlight ?? Promise.resolve()).then(flushInputAudit);
  };
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
    if (message.op === 'focus-ack') {
      const pending = typeof message.id === 'string' ? attachState.focusPending?.get(message.id) : undefined;
      if (pending?.socket === socket && typeof message.accepted === 'boolean') pending.resolve(message.accepted);
    } else if (message.op === 'scroll') {
      if (Number.isInteger(message.lines)) { back = Math.max(0, back + message.lines); poke(); }
    } else if (message.op === 'input') {
      if (back > 0) { back = 0; poke(); }                   // typing returns to the live bottom
      // ELS-INPUT-FAST-PATH (OP #128948 1순위): a typed key is latency itself — the door already authenticated this
      // attach line, so an ordinary key goes straight to the PTY: no screen render, no pane lock (never queues behind
      // a `do`), no synchronous audit write. Approval letters and control bytes keep the guarded machine lane, and
      // only the server-minted owner credential may type a decision key (humanApprovalKeys above).
      // ELS-TYPING-LATENCY: the app view turns bracketed paste on at the person's terminal (ENTER_VIEW ?2004h), so a
      // paste arrives as ONE input line wrapped in ESC[200~ … ESC[201~. The owner's markers stay only when the pane
      // program asked for bracketed paste; a pane-credential attach never carries them (its guarded lane treats ESC as
      // a control byte and would refuse the whole paste).
      const keepPaste = humanApprovalKeys && core.bracketedPaste?.(paneId) === true;
      const typed = typeof message.bytes === 'string' && !keepPaste && message.bytes.includes('\u001b[20') ? stripPasteMarkers(message.bytes) : message.bytes;
      if (humanApprovalKeys) {
        const done = core.input(paneId, typed);
        // ELS-SECURITY-AUDIT-IMMEDIATE (JUD-B #132138 / OP #132151): a decision key typed on the
        // owner credential is a security event — its row lands in the ledger the moment it is
        // typed. The 500 ms burst buffer belongs to ordinary typing, not to approvals/risk keys.
        appendSendAudit(auditDir, { op: 'input', pane: paneId, text: typeof typed === 'string' ? typed : '', exitCode: done.exitCode === 0 ? 0 : done.exitCode === 2 ? 2 : 1 });
        if (done.exitCode !== 0) send({ type: 'error', message: done.message });
      } else {
        const text = typeof typed === 'string' ? typed : '';
        if (inputFlight === undefined) {
          // The chain is empty: a fast key takes no async hop (the latency budget); a guarded key starts now.
          const fast = core.machineFastInput(paneId, typed);
          if (!('redirectToGuard' in fast)) {
            if (fast.exitCode !== 0) { send({ type: 'error', message: fast.message }); auditInputOutcome(text, fast.exitCode === 2 ? 2 : 1); }
            else auditInputOutcome(text, 0);
          } else {
            const flight = deliverGuarded(text, typed);
            inputFlight = flight;
            settleInputFlight(flight);
          }
        } else {
          // A guarded delivery is in flight: this key waits behind it, in typed order.
          const flight = inputFlight.then(() => runInputLine(text, typed));
          inputFlight = flight;
          settleInputFlight(flight);
        }
      }
    } else if (message.op === 'resize') {
      const done = core.resize(paneId, message.cols, message.rows);
      if (done.exitCode !== 0) send({ type: 'error', message: done.message });
      else { childTabsOf.get(core)?.redraw(paneId); poke(); }
    } else send({ type: 'error', message: 'els attach: only input, resize and scroll are accepted here' });
  });
}

const PASTE_BEGIN = '\u001b[200~';
const PASTE_END = '\u001b[201~';
/** ELS-TYPING-LATENCY: a paste's bracketed-paste markers removed — the pasted text itself is kept as typed. */
export const stripPasteMarkers = (bytes: string): string => bytes.split(PASTE_BEGIN).join('').split(PASTE_END).join('');

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

/** JUD #39484 — owner-issued actor binding. The client names only a pane; PID and generation come from this server's live holder ledger. */
export function handleSeatBind(request: { op: 'seat-bind'; seat: string; pane: string }, role: ServerRole,
  core: Pick<ElsCore, 'seatBindings' | 'paneProcessBinding'>,
  bindings: { issue(seat: string, paneId: string, primaryPid: number, generation: string,
    approvedChild?: number | { pid: number; start: string }): boolean },
  requesterPid?: number): ElsResult {
  if (request.seat !== 'OP') return { exitCode: 2, message: 'els seat bind: only OP is supported' };
  if (!isServerOwnerRole(role)) return { exitCode: 1, message: 'els seat bind: server owner credential required' };
  const seats = core.seatBindings().filter(row => row.pane === request.pane);
  if (seats.some(row => row.seat !== 'OP') || seats.length > 1)
    return { exitCode: 1, message: 'els seat bind: pane belongs to another seat' };
  const current = core.paneProcessBinding(request.pane);
  if (!current) return { exitCode: 1, message: 'els seat bind: live holder required' };
  const seat = seats[0];
  if (seat && (current.pid !== seat.pid || current.start !== seat.start || current.generation !== seat.generation))
    return { exitCode: 1, message: 'els seat bind: pane generation changed' };
  // JUD #128532: bind the requesting peer — the pane holder itself, or exactly the direct child
  // it approves — at issuance. A same-shell sibling never becomes the authority subject.
  try {
    if (!bindings.issue('OP', request.pane, current.pid, current.generation,
      requesterPid !== undefined && requesterPid !== current.pid ? requesterPid : undefined))
      return { exitCode: 1, message: 'els seat bind: actor binding refused' };
  } catch { return { exitCode: 1, message: 'els seat bind: actor binding refused' }; }
  return { exitCode: 0, message: `els seat: OP actor bound to ${request.pane}` };
}

export function serveConnection(ready: Promise<ElsCore | undefined>, socket: Socket, stateRoot: string, externalLookup: SeatLookup, guardRef: { current: RequestGuard | undefined }, sendAuditDir: string = dirname(elsSocketPath(stateRoot)), attachState: AttachState = { sockets: new Set<Socket>(), stopping: false }, toolDoor = false, runtimeRegistry?: SeatRuntimeRegistry, injectedSeatLookup = false, actorBindings?: ActorBindings, adoptNonce?: () => string | undefined, adoptSecret?: (pane: string) => string | undefined, serverIdentity?: { readonly pid: number; readonly start: string }): void {
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
  let localOperatorJudged = false;
  const seatLookup: SeatLookup = async (lookupPid, lookupBaseline) => {
    const external = await externalLookup(lookupPid, lookupBaseline);
    // JUD #39484 — an owner-issued actor binding wins only when it matches the external
    // lookup; disagreement is ambiguity, never a choice by precedence.
    const issued = verifiedActor(lookupPid, lookupBaseline);
    if (issued) {
      if (external && external.seat !== 'unknown' && (external.pane !== issued.role.pane || external.seat !== issued.role.seat)) return undefined;
      return { pane: issued.role.pane, seat: issued.role.seat, anchor: lookupBaseline, runtimeLive: issued.current };
    }
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
  /** JUD #39484 — capture the exact issuance once, then re-verify that same capture per message. */
  function verifiedActor(lookupPid: number | undefined, lookupBaseline: ProcessIdentity | undefined):
    { role: Extract<ServerRole, { kind: 'peer' }>; current: () => boolean } | undefined {
    if (!actorBindings || uid === undefined || lookupPid === undefined || lookupPid !== pid || !lookupBaseline
      || (role.kind !== 'op' && role.kind !== 'hand') || !paneRoleValid()) return undefined;
    const captured = actorBindings.capture(lookupPid, lookupBaseline);
    if (!captured || captured.pane !== role.pane || captured.seat !== 'OP' || !actorBindings.isCurrent(captured)) return undefined;
    return { role: { kind: 'peer', pid: lookupPid, pane: captured.pane, seat: captured.seat, uid },
      current: () => actorBindings.isCurrent(captured) };
  }
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
  const serveTail = (request: ElsRequest, guard: RequestGuard | undefined,
    authorizedActor?: ReturnType<typeof verifiedActor>): void => {
    if (closed || ending || socket.destroyed) return;
    if (!paneRoleValid()) {
      answer({ exitCode: 1, message: 'els: pane credential denied — socket peer is not a live descendant of that pane' });
      return;
    }
    // JUD #39484 ②③ — the captured actor is re-checked at execution, not only at the door.
    const issued = authorizedActor ?? verifiedActor(pid, baseline);
    if (issued && !issued.current()) {
      answer({ exitCode: 1, message: 'els: denied — actor binding is stale' });
      return;
    }
    const effectiveRole = issued?.role ?? role;
    // Registered runtime descendants follow tool policy even through the human socket.
    // Classify by OS ancestry, not the optional token, which only grants authority.
    const effectiveToolDoor = toolDoor || issued !== undefined
      || (request.op !== 'seat-set' && runtimeRegistry?.isDescendant(pid, uid, runtimeBaseline) === true);
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
        const registered = registerSeatRuntime(request, guard, runtimeRegistry, pid, uid, runtimeBaseline, token => {
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
        // ELS-BATON-AUTO-ON-RESTART: an explicit OP registration also ends an automatic hand.
        if (registered.exitCode === 0 && request.seat === 'OP')
          noteOpRegistration(dirname(elsSocketPath(stateRoot)), stateRoot, undefined, 'OP registered (els seat set OP)');
        return registered;
      }).catch((): ElsResult => ({ exitCode: 1, message: 'els seat set: cannot verify the live pane' })).then(answer);
      return;
    }
    // The pane spawned by this `new` inherits the requester's role (JUD #39057 ⓒ1②) — as a direct argument (JUD #39071), no queue.
    const spawnParent = request.op === 'new' && guard ? spawnParentOf(role) : undefined;
    // The server owner's registered OP role is not a pane credential (its provenance is server-owned).
    const paneSeat = !isServerOwnerRole(role) ? (role.kind === 'op' ? 'OP' : role.kind === 'hand' ? role.seat : undefined) : undefined;
    if (request.op === 'focus-empty') {
      if (!isServerOwnerRole(role) || effectiveToolDoor || typeof request.ws !== 'string') { answer({ exitCode: 1, message: 'els: focus requires owner' }); return; }
      void ready.then(core => { if (!core) return answer({ exitCode: 1, message: 'els: the server is stopping' }); core.rememberEmptyWorkspace(request.ws); answer({ exitCode: 0, message: 'focus recorded' }); });
      return;
    }
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
      .then((core) => core ? dispatch(core, request, spawnParent, stateRoot, uid, pid, seatLookup, baseline, firstSeat, sendAuditDir, effectiveToolDoor, false, paneSeat, role.kind === 'hand' || (role.kind === 'op' && !isServerOwnerRole(role)) ? role.pane : undefined, (denied, reason) => guard?.audit(denied, effectiveRole, reason, pid, claimedPid), claimedPid, issued?.current, issued && (effectiveRole.kind === 'hand' || effectiveRole.kind === 'peer' ? effectiveRole.seat : effectiveRole.kind === 'op' ? 'OP' : undefined), guard ? r => guard.authorize(effectiveRole, r) : undefined) : { exitCode: 1, message: 'els: the server is stopping' } as ElsResult)
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
    // OP #128880: holder-side nonce confirmation — pre-door by design (a holder holds no els role),
    // fail-closed without the live server's memory-only nonce. The peer pid is kernel-provided and the
    // holder start string binds the asker to the live holder generation (pid reuse fails closed).
    if (request.op === 'adopt-verify') {
      handled = true;
      const identity = processIdentity(pid);
      const pidOk = typeof request.holderPid === 'number' && request.holderPid === pid;
      const startOk = request.holderStart === undefined || (identity !== undefined && identity.pid === pid && identity.start === request.holderStart);
      const nonce = typeof request.nonce === 'string' ? request.nonce : '';
      // 보안 HOLD 수리(OP #129232): exitCode 단독 신뢰 폐지 — 매 요청 새 challenge 에 대한 per-pane 입양
      // 비밀의 HMAC-SHA256 증명과 이 서버의 pid+시작시각을 함께 실어 담는다. 비밀을 모르는 가짜
      // els.sock 리스너(unlink+bind, 같은 UID)는 증명을 낼 수 없다 — 홀더가 답변자를 검증한다.
      const pane = typeof request.pane === 'string' ? request.pane : '';
      const challenge = typeof request.challenge === 'string' ? request.challenge : '';
      const secret = adoptSecret !== undefined && pane !== '' ? adoptSecret(pane) : undefined;
      const proof = secret !== undefined && challenge !== '' && nonce !== ''
        ? createHmac('sha256', secret).update(challenge + nonce + pane).digest('hex') : undefined;
      const ok = pidOk && startOk && pane !== '' && nonce !== '' && (adoptNonce?.() ?? '') === nonce && proof !== undefined;
      if (!ok) guard?.audit({ op: 'adopt-verify', pane, holderPid: typeof request.holderPid === 'number' ? request.holderPid : -1, nonce }, role, 'adopt-verify denied', pid, claimedPid);
      // proof 는 승인(ok)일 때만 실린다 — 거부 답에 증명을 실으면, 비밀을 아는 진짜 서버가 위조 nonce 를
      // 거부(exitCode 1)한 답에서조차 홀더가 증명을 맞춰버린다(이 파일 RED 196: 'f'×48 위조에 실 토큰).
      // 홀더는 exitCode:0 + proof 일치 + 커널 peer + 자기신고 정체를 모두 요구한다(holder.ts).
      answer({ exitCode: ok ? 0 : 1, message: ok ? 'adopt-verify: ok' : 'adopt-verify: denied',
        ...(ok && proof !== undefined ? { proof } : {}),
        ...(serverIdentity !== undefined ? { serverPid: serverIdentity.pid, serverStart: serverIdentity.start } : {}) });
      return;
    }
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
        // The answer travels on a connection whose client is awaiting the auth ack: it must keep
        // the `auth: ` ack shape (client.ts rejects any other first answer as malformed — the
        // 2026-11-22 «malformed answer from the els server» wake failures).
        answer({ exitCode: 1, message: 'auth: invalid credential' });
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
    // Local operator (CEO 11-24 «불필요한 보안 강화 금지»): a same-UID caller with no pane credential and no
    // provable ancestry (e.g. Claude OP outside els) may read, status and send. No key file, no parent check —
    // the kernel peer UID is the only gate, and every call leaves one audit line. Known human or pane ancestry,
    // registered runtimes and issued actors keep their existing doors (the line is replayed).
    if (!localOperatorJudged && !toolDoor && role.kind === 'outsider' && LOCAL_OPERATOR_OPS.includes(request.op)
      && localOperatorAllowed(uid, process.getuid?.())) {
      handled = true;
      void ready.then(async core => {
        const ancestry = core ? inspectReadAncestry(pid, baseline, core.shellPids()) : undefined;
        // An els pane process keeps the existing rule: it presents its own pane token (not added hardening).
        const paneProcess = core ? await resolveAncestorPane(pid, baseline, core.shellPids()) : undefined;
        if (!core || ancestry?.kind !== 'unknown' || paneProcess || runtimeRegistry?.isDescendant(pid, uid, runtimeBaseline) === true || verifiedActor(pid, baseline)) {
          localOperatorJudged = true; handled = false;
          handleLine(line);
          return;
        }
        const pane = 'pane' in request && typeof request.pane === 'string' ? request.pane : undefined;
        const chars = request.op === 'send' && typeof request.text === 'string' ? request.text.length : undefined;
        const audit = (result: string): true => { auditOperator(sendAuditDir, { op: request.op, ...(pane ? { pane } : {}), uid, pid, ...(chars !== undefined ? { chars } : {}), result }); return true; };
        if (request.op !== 'send') { audit('allowed'); serveTail(request, guard); return; }
        if (!pane || typeof request.text !== 'string') { audit('denied'); answer({ exitCode: 2, message: 'els: send needs a pane and text' }); return; }
        // A pane mid-turn gets the line queued for its next turn — the in-progress answer is preserved.
        const result = await core.do(pane, request.text, `local-operator:${uid}:${pid}`, audit);
        audit(result.exitCode === 0 ? 'accepted' : 'failed');
        answer(result);
      }).catch(() => answer({ exitCode: 1, message: 'els: local operator request failed' }));
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
    // Dedicated issuance door: only the live peer/pane identity, never an owner file or request label.
    if (request.op === 'baton') {
      handled = true;
      void Promise.all([roleReady, ready]).then(async ([, core]): Promise<ElsResult> => {
        const lease = batonLeases.get(dirname(elsSocketPath(stateRoot)));
        if (!core || !guard || !lease || !paneRoleValid()) return { exitCode: 1, message: 'els baton: server or identity unavailable' };
        if (request.action === 'status') return { exitCode: 0, message: JSON.stringify(lease.active()) };
        const peer = uid !== undefined && pid !== undefined ? await seatLookup(pid, baseline) : undefined;
        // #39875 local operator (same host + same OS user, no pane credential, not a pane/runtime process):
        // Claude OP's terminal may hand/take/return without a TTY and without an extra flag.
        const operator = !peer && (role.kind === 'outsider' || isServerOwnerRole(role)) && !toolDoor
          && localOperatorAllowed(uid, process.getuid?.())
          && runtimeRegistry?.isDescendant(pid, uid, runtimeBaseline) !== true
          && !(await resolveAncestorPane(pid, baseline, core.shellPids()));
        if (!paneRoleValid()) return { exitCode: 1, message: 'els baton: stale pane' };
        const issued = verifiedActor(pid, baseline);
        if (issued && !issued.current()) return { exitCode: 1, message: 'els baton: stale actor' };
        let seat: string | undefined;
        if (!isServerOwnerRole(role) && role.kind === 'op') seat = 'OP';
        else if (role.kind === 'hand') seat = role.seat;
        else if (peer && uid !== undefined) seat = peer.seat;
        if (peer && seat && peer.seat !== seat) return { exitCode: 1, message: 'els baton: ambiguous identity' };
        const actor: BatonActor = seat === 'OP' ? { kind: 'op' } : seat ? { kind: 'seat', seat } : operator ? { kind: 'operator' } : { kind: 'other' };
        if (operator) auditOperator(sendAuditDir, { op: `baton-${request.action}`, uid, pid, result: 'allowed' });
        if (request.action === 'auto-hand' || request.action === 'auto-return' || request.action === 'auto-skip') {
          // The restart runtime (update-all run by OP / RES-INFRA, or the local operator) drives the automatic baton.
          if (actor.kind !== 'op' && actor.kind !== 'operator' && !(actor.kind === 'seat' && actor.seat === 'RES-INFRA'))
            return { exitCode: 1, message: 'els baton: restart runtime (OP, RES-INFRA or local operator) required' };
          const elsDir = dirname(elsSocketPath(stateRoot));
          if (request.action === 'auto-skip') { batonAutoSkip(elsDir, stateRoot, request.reason ?? ''); return { exitCode: 0, message: JSON.stringify(lease.active()) }; }
          if (request.action === 'auto-return') {
            batonAutoReturn(elsDir, stateRoot, request.handoff ?? 'OP restart verified by the restart runtime');
            return { exitCode: 0, message: JSON.stringify(lease.active()) };
          }
          return batonAutoHand(elsDir, request.reason ?? '', (request.exclude ?? []).filter(n => Number.isSafeInteger(n) && n > 0));
        }
        try {
          if (request.action === 'hand') lease.hand(actor, request.owner ?? '', request.acting ?? '', request.reason ?? '', request.ttlMs ?? 0);
          else if (request.action === 'take' || request.action === 'return') lease.end(request.action, actor, request.owner ?? '', request.handoff ?? '');
          else return { exitCode: 2, message: 'els baton: unknown action' };
          publishBatonSnapshot(dirname(elsSocketPath(stateRoot)), lease);
          return { exitCode: 0, message: JSON.stringify(lease.active()) };
        } catch (error) { return { exitCode: 1, message: `els baton: ${error instanceof Error ? error.message : String(error)}` }; }
      }).catch((): ElsResult => ({ exitCode: 1, message: 'els baton: identity verification failed' })).then(answer);
      return;
    }
    // JUD #39484 — this op issues authority: never peer promotion, never the mutating door.
    if (request.op === 'seat-bind') {
      handled = true;
      void Promise.all([roleReady, ready]).then(([, core]) => {
        if (closed || ending || socket.destroyed) return;
        if (!guard || !core || !actorBindings || toolDoor || runtimeRegistry?.isDescendant(pid, uid, runtimeBaseline) === true || !isServerOwnerRole(role)) {
          guard?.audit(request, role, 'seat-bind requires server owner', pid, claimedPid);
          answer({ exitCode: 1, message: 'els seat bind: server owner credential required' });
          return;
        }
        if (typeof request.pane !== 'string' || !request.pane.trim() || typeof request.seat !== 'string') {
          answer({ exitCode: 2, message: 'els seat bind: seat and pane required' });
          return;
        }
        answer(handleSeatBind(request, role, core, actorBindings, pid));
      }).catch(() => answer({ exitCode: 1, message: 'els seat bind: unable to verify owner' }));
      return;
    }
    // A pane may ask only the owner view currently showing that same verified pane to switch.
    // No credential, caller-supplied source pane, or view on a different pane can route this request.
    if (request.op === 'event') {
      handled = true;
      void Promise.all([roleReady, ready]).then(([, core]) => {
        if (!core || !paneRoleValid() || isServerOwnerRole(role) || (role.kind !== 'op' && role.kind !== 'hand') || request.pane !== role.pane)
          return { exitCode: 1, message: 'event: verified source pane required' } as ElsResult;
        const decoded = decodeEventLine(line);
        return decoded.ok ? core.agentEvent(role.pane, decoded.frame) : { exitCode: 2, message: 'event: invalid frame' } as ElsResult;
      }).catch(() => ({ exitCode: 1, message: 'event: verification failed' } as ElsResult)).then(answer);
      return;
    }
    if (request.op === 'seat-focus') {
      handled = true;
      void Promise.all([roleReady, ready]).then(async ([, core]) => {
        if (!core || !paneRoleValid() || isServerOwnerRole(role) || (role.kind !== 'op' && role.kind !== 'hand'))
          return { exitCode: 1, message: 'els seat: verified source pane required' } as ElsResult;
        const target = typeof request.pane === 'string' ? core.paneExists(request.pane) : undefined;
        if (!target || !core.paneIsLive(target)) return { exitCode: 1, message: 'els seat: target pane is not live' } as ElsResult;
        const views = [...(attachState.focusViews?.get(role.pane) ?? [])].filter(view => !view.destroyed);
        if (views.length !== 1 || !attachState.focusPending)
          return { exitCode: 1, message: 'els seat: exactly one active owner view of this pane is required' } as ElsResult;
        const view = views[0]!;
        const id = randomBytes(16).toString('hex');
        const accepted = await new Promise<boolean>(resolve => {
          const timer = setTimeout(() => { attachState.focusPending?.delete(id); resolve(false); }, 3000);
          attachState.focusPending!.set(id, { socket: view, resolve: ok => { clearTimeout(timer); attachState.focusPending?.delete(id); resolve(ok); } });
          view.write(`${JSON.stringify({ type: 'focus', pane: target, id })}\n`);
        });
        return accepted ? { exitCode: 0, message: `els seat: focused ${target}` } as ElsResult
          : { exitCode: 1, message: 'els seat: view did not confirm focus; inspect tabs before retrying' } as ElsResult;
      }).catch((): ElsResult => ({ exitCode: 1, message: 'els seat: focus outcome unknown' })).then(answer);
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
          if (peer && uid !== undefined && (peer.seat === 'OP' || peer.seat === 'RES-INFRA' || isActingSeat(dirname(elsSocketPath(stateRoot)), peer.seat))) role = { kind: 'peer', pid, pane: peer.pane, seat: peer.seat, uid };
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
        const issued = verifiedActor(pid, baseline);
        const authorizationRole = issued?.role ?? role;
        if (issued && !issued.current()) {
          guard.audit(request, authorizationRole, 'els: denied — actor binding is stale', pid, claimedPid);
          answer({ exitCode: 1, message: 'els: denied — actor binding is stale' });
          return;
        }
        const verdict = guard.authorize(authorizationRole, request);
        if (!verdict.allow) {
          guard.audit(request, authorizationRole, verdict.reason ?? 'denied', pid, claimedPid);
          answer({ exitCode: 1, message: verdict.reason ?? 'els: denied' });
          return;
        }
        serveTail(verdict.verifiedRequest ?? request, guard, issued);
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
import { AUTH_OWNER_TOKEN_ENV, AUTH_PANE_TOKEN_ENV, authorizeRequest, closeTabAuditLine, coordinatorAuthority, coordinatorGrant, coordinatorTabScope, type CoordinatorGrant, type FederationJournal, denialAuditLine, hqReadObserver, hqTypingRequest, isMutating, isServerOwnerRole, PaneRegistry, resolveTabCloseScope, rulesLoader, spawnParentOf, type ServerRole, type SpawnParent } from './server-auth.js';
import { archiveExitedPane } from './exited-archive.js';

// The map is populated only after this server owns both sockets; snapshots never confer authority.
const batonLeases = new Map<string, BatonLease>();
function publishBatonSnapshot(dir: string, lease: BatonLease): void {
  // Display-only; readers cannot use this file as a credential. Failure never changes the lease.
  try {
    const path = join(dir, 'baton.json');
    const tmp = `${path}.${randomBytes(12).toString('hex')}.tmp`;
    try { writeFileSync(tmp, `${JSON.stringify(lease.active())}\n`, { mode: 0o600, flag: 'wx' }); renameSync(tmp, path); }
    finally { try { unlinkSync(tmp); } catch { /* renamed */ } }
  } catch { /* display snapshot unavailable */ }
}
function isActingSeat(elsDir: string, seat: string | undefined): boolean {
  return !!seat && batonLeases.get(elsDir)?.active()?.acting === seat;
}

// ELS-BATON-AUTO-ON-RESTART (대표 11-24 04:4x «바톤 자동으로»): the runtime hands the OP lease to the acting seat
// right before OP stops and takes it back when the new OP pane registers. Observation = baton-audit.jsonl
// (auto-hand · auto-return · auto-extend) and one `els.baton …` stderr line per transition.
/** PIDs that reported a build from the OP seat pane — an automatic hand excludes them, so only a NEW OP returns it. */
const opReporters = new Map<string, number[]>();
const autoExcluded = new Map<string, Set<number>>();
function batonLog(line: string): void { try { process.stderr.write(`els.baton ${line}\n`); } catch { /* observation is best effort */ } }
function batonAutoHand(elsDir: string, reason: string, exclude: readonly number[]): ElsResult {
  const lease = batonLeases.get(elsDir);
  if (!lease) return { exitCode: 1, message: 'els baton: server unavailable' };
  try {
    const { baton, handed } = lease.autoHand(reason);
    if (handed) autoExcluded.set(elsDir, new Set([...(opReporters.get(elsDir) ?? []), ...exclude]));
    else for (const pid of exclude) autoExcluded.get(elsDir)?.add(pid);
    publishBatonSnapshot(elsDir, lease);
    batonLog(`auto-hand${handed ? '' : ' (kept)'} acting=${baton.acting} reason=${JSON.stringify(baton.reason)} expires=${baton.expiresAt}`);
    return { exitCode: 0, message: JSON.stringify(baton) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    batonLog(`auto-hand refused reason=${JSON.stringify(message)}`);
    return { exitCode: 1, message: `els baton: ${message}` };
  }
}
/** Mail to OP during the gap is not moved: it stays unread in OP's durable box and the new OP pane gets it — the memo counts it. */
function batonAutoReturn(elsDir: string, stateRoot: string, source: string): boolean {
  const lease = batonLeases.get(elsDir);
  const auto = lease?.autoState();
  const baton = lease?.active();
  if (!lease || !auto || !baton) return false;
  let unread: number | null = null;
  try { unread = readUnreadCount('OP', join(stateRoot, 'msg', 'messages.db')); } catch { unread = null; }
  const memo = `auto-return · ${source} · ${baton.acting} held OP ${new Date(auto.since).toISOString()}..${new Date().toISOString()} for ${JSON.stringify(auto.reason)} · OP unread mail ${unread ?? 'unknown'} held for the new OP pane`;
  const returned = lease.autoReturn(memo);
  if (returned) {
    autoExcluded.delete(elsDir);
    publishBatonSnapshot(elsDir, lease);
    batonLog(`auto-return acting=${baton.acting} source=${JSON.stringify(source)} opUnread=${unread ?? 'unknown'}`);
  }
  return returned;
}
function noteOpRegistration(elsDir: string, stateRoot: string, pid: number | undefined, source: string): void {
  const excluded = autoExcluded.get(elsDir);
  if (pid === undefined || !excluded?.has(pid)) batonAutoReturn(elsDir, stateRoot, source);
  if (pid === undefined) return;
  const seen = opReporters.get(elsDir) ?? [];
  if (!seen.includes(pid)) { seen.push(pid); if (seen.length > 64) seen.shift(); opReporters.set(elsDir, seen); }
}
function batonAlertMail(stateRoot: string, to: string, body: string): void {
  try {
    const store = openMsgStore(join(stateRoot, 'msg', 'messages.db'));
    try { store.post({ from: 'OP', to, kind: 'alert', intent: 'alert', body }); } finally { store.close(); }
  } catch (error) { batonLog(`alert-mail failed reason=${JSON.stringify(error instanceof Error ? error.message : String(error))}`); }
}
function batonAutoSkip(elsDir: string, stateRoot: string, reason: string): void {
  const why = reason.replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || 'acting-unhealthy';
  batonLog(`auto-hand skipped reason=${why}`);
  try { appendFileSync(join(elsDir, 'baton-audit.jsonl'), `${JSON.stringify({ action: 'auto-hand-skipped', at: new Date().toISOString(), reason: why, actor: 'runtime' })}\n`, { mode: 0o600 }); } catch { /* audit best effort */ }
  batonAlertMail(stateRoot, 'OP', `🚨 [baton] OP restart skipped this wave — ${why}: the acting seat is not healthy, so OP was not stopped. Restart OP after the acting seat is back.`);
}
function batonTick(elsDir: string, stateRoot: string, lease: BatonLease): void {
  let alert: BatonAlert | null = null;
  try { alert = lease.tick(); } catch { /* expiry already revoked */ }
  if (!alert) return;
  batonLog(`auto-return missed acting=${alert.acting} keeps lease until ${alert.expiresAt} reason=${JSON.stringify(alert.reason)}`);
  batonAlertMail(stateRoot, alert.acting, `🚨 [baton] the new OP pane did not register within 15m after ${JSON.stringify(alert.reason)} (since ${alert.since}). ${alert.acting} keeps the OP acting lease (extended to ${alert.expiresAt}). Check the OP pane (els list · els seat OP); the lease returns by itself when OP registers.`);
}
/** The last live OP-seat pane ended (crash, watchdog relaunch, `els seat OP` replacing it): hand before the gap opens. */
function batonOnPaneRelease(elsDir: string, journalPath: string, pane: string): void {
  try {
    const panes = loadJournal(journalPath).panes;
    if (panes.find(p => p.id === pane)?.ownerSeat !== 'OP') return;
    if (panes.some(p => p.id !== pane && p.ownerSeat === 'OP' && p.state !== 'exited')) return;
    batonAutoHand(elsDir, `OP pane ${pane} exited`, []);
  } catch { /* a release hook never breaks exit recording */ }
}

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
  /** Clock seam of the child tabs for isolated tests (tab-after / close-delay / repaint period), never supplied by wire requests. */
  readonly childTabs?: Pick<ChildTabsDeps, 'tabAfterMs' | 'closeDelayMs' | 'tickMs' | 'paneSize' | 'colorMode'>;
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
  /** ELS-CODEX-SEAT-MAIL-WAKE: knock a non-eln seat pane when its mail goes unread (receipt per knock); `false` disables. */
  readonly mailWake?: MailWakeDeps | false;
  /** Clock seam for tests (ELS-TAB-STATE-BADGE: stalled is a time rule); the server uses Date.now. */
  readonly now?: () => number;
  /** Isolated test clock cadence; production reaps once a minute. */
  readonly reapIntervalMs?: number;
  /** ELS-SERVE-ORPHAN-EXIT: how often the bound sockets are checked to still exist (test seam; production 1s). */
  readonly socketGuardIntervalMs?: number;
  /** ELS-SERVER-EVENT-HUB-NO-DB-POLL — badge ledger path override for isolated tests; default is the server's own stateRoot ledger. */
  readonly mailBadgeLedgerPath?: string;
  /** JUD-B #132880 mustFix ① — badge compute seam: off-thread by default (base #39546 worker); tests inject a double. */
  readonly mailBadgeCompute?: MailBadgeCompute;
}

/** OP #128343(OP 승인 #128469): 입양 pane 의 workspace 이름 — 저널 tabId → workspaceId → name(재기동 전 서버가 적은 값). */
function adoptedWorkspaceName(journalPath: string, tabId: string): string {
  try {
    const journal = loadJournal(journalPath);
    const workspaceId = journal.tabs.find((tab) => tab.id === tabId)?.workspaceId;
    return journal.workspaces.find((ws) => ws.id === workspaceId)?.name ?? '';
  } catch { return ''; }
}

/** Become the owner, then load the journal. Resolves to the running server, or to a refusal.
 *  `lost` resolves (after this owner has closed itself) when a bound socket disappears at runtime —
 *  a Unix socket file can be removed without any event reaching this process, so without the guard
 *  a serve that lost its socket lingered forever with every pane holder still attached. */
export async function startElsServer(options: ElsServerOptions = {}): Promise<{ server: Server; core: ElsCore; close: () => Promise<void>; lost: Promise<string>; httpV1?: Server } | ElsResult> {
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
  const attachState: AttachState = { sockets: new Set<Socket>(), focusViews: new Map(), focusPending: new Map(), stopping: false };
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
  let actorBindings: ActorBindings;
  // OP #128880: this serve generation's adoption nonce — memory only (never a file, never env): a holder
  // returns its pane token only when this process confirms the nonce back over els.sock.
  const generationNonce = randomBytes(24).toString('hex');
  // 보안 HOLD 수리(OP #129232): 이 세대의 per-pane 입양 비밀 원장(메모리만 — 재기동하면 잊는다)과
  // 이 서버 자신의 pid+시작시각(홀더가 adopt-verify 답변자를 검증할 기록값). 비밀은 오직 spawn env(신뢰
  // 경로 — PANE_TOKEN 을 실어 나르는 그 환경)과 재결속 핸드셰이크(adopt-renew, JUD #128534 신뢰 경로)
  // 로만 홀더에게 나간다 — 디스크·els.sock 경로로는 절대 못 나간다.
  const adoptionSecrets = new Map<string, string>();
  const serverStartStamp = processStartStamp(process.pid);
  const serverIdentity = serverStartStamp !== undefined ? { pid: process.pid, start: serverStartStamp } : undefined;
  const server = createServer((socket) => serveConnection(ready, socket, stateRoot, lookup, guardRef, dirname(socketPath), attachState, false, runtimeRegistry, false, actorBindings, () => generationNonce, (pane) => adoptionSecrets.get(pane), serverIdentity));
  // Explicit seatLookup is an in-process test dependency, never provided by a socket request.
  const toolServer = createServer((socket) => serveConnection(ready, socket, stateRoot, lookup, guardRef, dirname(socketPath), attachState, true, runtimeRegistry, options.seatLookup !== undefined, actorBindings, () => generationNonce, (pane) => adoptionSecrets.get(pane), serverIdentity));
  // ELS-SERVE-EXIT-NOW (JUD-B #127564 ② · OP #127681): every open connection is remembered so a loss can
  // cut the ones that would otherwise hold `close()` forever — an idle client must not delay the end.
  const liveSockets = new Set<Socket>();
  const trackSockets = (listener: Server): void => { listener.on('connection', (socket: Socket) => { liveSockets.add(socket); socket.once('close', () => liveSockets.delete(socket)); }); };
  trackSockets(server);
  trackSockets(toolServer);

  // ELS-SERVER-EVENT-HUB-NO-DB-POLL (OP #127680 2단계): 배지 상태의 정본은 메모리 — 재계산은 원장 옆 이벤트
  // 파일의 완전한 새 줄이 올 때만(주기 DB 조회 0). JUD-B #132880 mustFix ①: compute 는 base #39546 Worker
  // (오프스레드)를 기본으로 — 이벤트 구동 갱신도 서버 스레드 위에서 돌지 않는다. judb-39675 ①: 허브의 유실 마커
  // 사건이 사이드카 유실을 후속 우편 0통·주기 타이머 0으로 회복한다(② 계산 중 이벤트는 dirty 보존).
  const mailBadgeLedgerPath = options.mailBadgeLedgerPath ?? join(stateRoot, 'msg', 'messages.db');
  const mailHub = createMailEventHub({ eventsPath: ledgerEventsPath(mailBadgeLedgerPath) });
  const mailBadgeState = createMailBadgeState({
    dbPath: mailBadgeLedgerPath,
    ...(options.mailBadgeCompute ? { compute: options.mailBadgeCompute } : {}),
  });
  mailBadgeState.attach(mailHub);
  mailHub.start();

  // ELS-SERVER-MAINLOOP-STARVATION (이 가지 한정): 배지 공급은 이제 이벤트형 상태(mailBadgeState)가
  // 단일 소스다 — 첫 착석 1회 계산 후 메모리, 재계산은 원장 옆 사이드카 줄이 올 때만. main의 Worker
  // 스냅샷 캐시(mailBadgeCache — 스냅샷마다 원장 읽기 예약)는 이벤트 허브가 대체하므로 여기서 뺀다.
  // JUD #39484 ③ — every pane release/replacement revokes its actor binding at once.
  const releaseHook = { onPaneRelease: (pane: string) => { actorBindings?.revoke(pane); batonOnPaneRelease(dirname(socketPath), journalPath, pane); } };
  const core = createElsCore({ ...releaseHook, ...(options.now ? { now: options.now } : {}), load: () => loadJournal(journalPath), save: (journal) => saveJournal(journalPath, journal),
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
        ELANOUS_EVENT_SOCKET: socketPath, ELANOUS_EVENT_WS: env.ELANOUS_ELS_WS ?? '', ELANOUS_EVENT_PANE: env.ELANOUS_ELS_PANE ?? '',
        ELANOUS_STATE_DIR_SOURCE: stateDirSourceForChild(stateRoot,
          { ...process.env, ...env, NODE_ENV: process.env.NODE_ENV ?? 'production' }),
        ...(opTab ? ceoWiring?.envFor('OP') : {}) }, cwd, parent);
      // 보안 HOLD 수리(OP #129232): 이 판의 입양 비밀을 스폰 시 뽑아 원장(메모리)에 두고, 홀더 스폰
      // env(신뢰 경로 — PANE_TOKEN 과 같은 길)로만 내려 보낸다. 주입된 options.spawn 테스트 경로에는
      // 실리지 않는다(pane 자식 env 로 비밀이 샐 수 있는 길). 스폰 실패 시 비밀도 회수한다.
      const adoptionPane = spawnEnv['ELANOUS_ELS_PANE'];
      const adoptionSecret = adoptionPane !== undefined && serverStartStamp !== undefined ? randomBytes(32).toString('hex') : undefined;
      if (adoptionPane !== undefined && adoptionSecret !== undefined) adoptionSecrets.set(adoptionPane, adoptionSecret);
      try {
        const pty = options.spawn !== undefined
          ? options.spawn(command, cwd, title, spawnEnv)
          : holderPty(stateRoot)(command, cwd, title, {
            ...spawnEnv,
            ...(adoptionSecret !== undefined && serverStartStamp !== undefined ? {
              ELANOUS_ELS_ADOPTION_SECRET: adoptionSecret,
              ELANOUS_ELS_SERVER_PID: String(process.pid),
              ELANOUS_ELS_SERVER_START: serverStartStamp } : {}) });
        paneRegistry.bindSpawn(spawnEnv[AUTH_PANE_TOKEN_ENV], () => pty.processBinding);
        return pty;
      } catch (error) {
        paneRegistry.forget(spawnEnv[AUTH_PANE_TOKEN_ENV]);
        if (adoptionPane !== undefined && adoptionSecret !== undefined) adoptionSecrets.delete(adoptionPane);
        throw error;
      }
    },
    reattach: (pane) => {
      // 보안 HOLD 수리(OP #129232): 재기동 세대는 이 판의 입양 비밀을 새로 뽑아 재결속 핸드셰이크
      // (adopt-renew — proof 는 이 홀더의 세대 nonce, JUD #128534 신뢰 경로)로 설치한다.
      const renewAdoptionSecret = serverStartStamp !== undefined ? randomBytes(32).toString('hex') : undefined;
      if (renewAdoptionSecret !== undefined) adoptionSecrets.set(pane.id, renewAdoptionSecret);
      const adopted = reattachHolder(stateRoot, pane.id, renewAdoptionSecret);
      if (!adopted) return undefined;
      // OP #128343(승인 #128469) P0 — 재기동 입양: 살아남은 홀더가 증명한 pane 토큰을 원장에 재등록한다.
      // 토큰은 홀더의 credential 답만(registerAdopted 가 회수·충돌 거부), 자리·workspace 는 저널
      // ownerSeat·tabId 로 복원한다. 비동기 — 입양은 즉시, 재등록은 홀더 응답 착지 때(시험은 until 로 기다린다).
      const workspace = adoptedWorkspaceName(journalPath, pane.tabId);
      void Promise.resolve(adopted.credential?.(generationNonce))
        .then((token) => { if (token) paneRegistry.registerAdopted(
          { token, pane: pane.id, workspace, role: pane.ownerSeat === 'OP' ? 'op' : 'hand', seat: pane.ownerSeat },
          () => adopted.processBinding); })
        .catch(() => { /* 홀더가 답하지 못하면 입양만 유지되고 재등록은 없다 */ });
      return adopted;
    },
    // OP #128343(승인 #128469): 닫힌 pane 의 발급 토큰은 회수한다 — 남은 자손도 그 자격을 다시 쓰지 못한다.
    // OP #128343(승인 #128469) + 보안 HOLD 수리(OP #129232): 닫힌 판의 입양 비밀도 원장(메모리)에서 회수한다.
    onTabMoved: (panes, workspace) => paneRegistry.movePanes(panes, workspace),
    onPaneClosed: (paneId) => { paneRegistry.forgetPane(paneId); adoptionSecrets.delete(paneId); },
    // D1b: a reboot-ended pane shows its saved screen instead of clearing to idle.
    restoreScreen: (paneId) => restoreScreenFromSnapshot(stateRoot, paneId),
    consumeScreenSnapshot: (paneId) => consumeScreenSnapshot(stateRoot, paneId),
    // ELS-SERVER-EVENT-HUB-NO-DB-POLL — 목록 배지는 메모리 상태만 읽는다(재계산은 허브 이벤트 때만).
    mailBadges: (seats) => mailBadgeState.badges(seats) });
  actorBindings = new ActorBindings(pane => core.paneProcessBinding(pane), processIdentity, () => core.shellPids());
  const resultsPath = join(dirname(socketPath), 'child-results.jsonl');
  const notifyParent = options.notifyParent ?? ((ws: string, line: string) => {
    // Bounded: past 256 KiB the file becomes `.1` (one older generation), so unread results cannot grow without limit.
    try { if (statSync(resultsPath).size > RESULTS_MAX_BYTES) renameSync(resultsPath, `${resultsPath}.1`); } catch { /* no file yet */ }
    appendFileSync(resultsPath, `${JSON.stringify({ at: new Date().toISOString(), ws, line })}\n`, { mode: 0o600 });
  });
  childTabsOf.set(core, createChildTabs({ core, notifyParent, paneSize: (pane) => core.paneSize(pane), ...(options.childTabs ?? {}) }));
  if (options.ps) psOf.set(core, options.ps);
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
  // OP-HANDLES-L2: a coordinator grant (HQ everywhere · space coordinator in its spaces) for a pane role, audited per use.
  const grantFor = (role: ServerRole, request: ElsRequest): boolean => {
    if (role.kind !== 'hand' && role.kind !== 'peer') return false;
    const granted = coordinatorGrantForSeat(core, stateRoot, role.seat, role.pane, request);
    if (granted) {
      try { appendFileSync(join(elsDir, 'control-audit.jsonl'), `${JSON.stringify({ ...granted.audit, principal: role.kind === 'peer' ? `local:${role.uid}(${role.seat})` : `els-pane:${role.pane}(${role.seat})` })}\n`, { mode: 0o600 }); }
      catch { /* the door must not break on audit IO */ }
    }
    return !!granted;
  };
  guardRef.current = {
    classify: (claim) => paneRegistry.classify(claim),
    paneBinding: (token) => paneRegistry.spawnBinding(token),
    authorize: (role, request) => {
      const acting = (role.kind === 'hand' || role.kind === 'peer') && isActingSeat(elsDir, role.seat);
      const granted = grantFor(role, request);
      if (!acting && !granted && (request.op === 'new' || request.op === 'reorder')) {
        const scoped = coordinatorTabScope(role, request, loadJournal(journalPath));
        if (scoped) return scoped;
      }
      if (request.op === 'rename' && request.kind === 'workspace') {
        const listed = JSON.parse(core.list().message) as { workspaces: Array<{ id: string; name: string }> };
        // Match core's name-or-id lookup exactly; execute the authorized stable id.
        const target = listed.workspaces.find(row => row.id === request.id) ?? listed.workspaces.find(row => row.name === request.id);
        const verdict = authorizeRequest(role, request, target?.name, loadRules(), undefined, acting);
        return verdict.allow && target
          ? { allow: true, verifiedRequest: { ...request, id: target.id } }
          : verdict;
      }
      if (request.op === 'rename' && request.kind === 'tab') {
        const listed = JSON.parse(core.list().message) as { workspaces: Array<{ id: string; name: string; coordinatorSeat?: string }>; tabs: Array<{ id: string; workspaceId: string; label: string }> };
        const matches = listed.tabs.filter(row => row.id === request.id);
        const named = listed.tabs.filter(row => row.label === request.id);
        const target = matches[0] ?? (named.length === 1 ? named[0] : undefined);
        const ws = listed.workspaces.find(row => row.id === target?.workspaceId);
        const seat = role.kind === 'op' ? 'OP' : role.kind === 'hand' || role.kind === 'peer' ? role.seat : undefined;
        if (!target || !ws) return { allow: false, reason: 'els: tab rename denied — target not found or name is ambiguous' };
        if (seat !== 'OP' && (!seat || ws.coordinatorSeat !== seat))
          return { allow: false, reason: 'els: tab rename denied — only OP or the workspace coordinator may rename tabs' };
        return { allow: true, verifiedRequest: { ...request, id: target.id } };
      }
      if (request.op === 'close-tab') {
        const scope = resolveTabCloseScope(JSON.parse(core.list().message), paneRegistry.entries(), request.tab);
        const verdict = authorizeRequest(role, request, scope?.workspace, loadRules(), scope, acting, granted);
        // ELS-OP-CLOSE-TAB: every allowed tab close leaves one `els.close` line — who, which tab, how many panes, and
        // whether a person confirmed it (a coordinator close without a person is the routine path, still on record).
        if (verdict.allow && scope) {
          try {
            appendFileSync(join(elsDir, 'control-audit.jsonl'), `${JSON.stringify(closeTabAuditLine(role, scope, request.confirmed === true, acting))}\n`, { mode: 0o600 });
          } catch { /* the door must not break on audit IO */ }
        }
        return verdict.allow && scope
          ? { allow: true, verifiedRequest: { op: 'close-tab', tab: scope.tabId, confirmed: true } }
          : verdict;
      }
      return authorizeRequest(role, request, workspaceOf(request), loadRules(), undefined, acting, granted);
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
  const batonDir = dirname(socketPath);
  const batonLease = new BatonLease(event => appendFileSync(join(batonDir, 'baton-audit.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 }), options.now ?? Date.now);
  batonLeases.set(batonDir, batonLease);
  publishBatonSnapshot(batonDir, batonLease);
  const batonTimer = setInterval(() => { batonTick(batonDir, stateRoot, batonLease); try { publishBatonSnapshot(batonDir, batonLease); } catch { /* expiry already revoked */ } }, 1000);
  batonTimer.unref();
  // ELS-SERVE-ORPHAN-EXIT (OP 11-22): ownership is the bound socket, yet removing the socket file
  // fires no event in Node — a serve that lost els.sock or ctl.sock used to stay alive forever with
  // every pane holder still attached (23 orphans). The guard: while both files sit exactly as bound
  // nothing happens; the first disappearance or replacement ends this owner — `lost` resolves only
  // after the self-close has finished, so the CLI's exit races nothing.
  let markLost: (reason: string) => void = () => {};
  const lost = new Promise<string>((resolve) => { markLost = resolve; });
  // JUD-B #127595 (startup race): a loss that fires while startup still awaits its HTTP listeners must stop
  // the boot — `lostReason` is what the tail of this function checks before markReady.
  let lostReason: string | undefined;
  const triggerLost = (reason: string): void => {
    if (attachState.stopping) return; // a deliberate close is not a loss
    lostReason ??= reason;
    clearInterval(socketGuardTimer);
    void close().then(() => markLost(reason), () => markLost(reason));
  };
  const boundSockets = new Map<string, { ino: number; dev: number }>(
    [socketPath, toolSocketPath].map((p) => {
      const st = statSync(p);
      return [p, { ino: st.ino, dev: st.dev }] as const;
    }));
  const socketGuardTimer = setInterval(() => {
    for (const p of [socketPath, toolSocketPath]) {
      const bound = boundSockets.get(p)!;
      let held = false;
      try {
        const st = statSync(p);
        held = !st.isSymbolicLink() && st.ino === bound.ino && st.dev === bound.dev;
      } catch { held = false; }
      if (!held) {
        triggerLost(`els serve: the bound socket ${basename(p)} disappeared — this owner ended itself`);
        return;
      }
    }
  }, options.socketGuardIntervalMs ?? 1_000);
  socketGuardTimer.unref();
  // A runtime listener error used to become an unhandled 'error' crash; it is a loss of the same kind.
  server.on('error', (error) => triggerLost(`els serve: els.sock listener failed: ${error instanceof Error ? error.message : String(error)}`));
  toolServer.on('error', (error) => triggerLost(`els serve: ctl.sock listener failed: ${error instanceof Error ? error.message : String(error)}`));
  // JUD #39057 ⓒ1③ — the person's explicit `els seat set OP` needs the owner credential outside this process env. Written only
  // once this run owns the socket (right after the bind, before any client can re-read it): a start refused above («already answers») must not overwrite the live server's token file.
  writeFileSync(join(dirname(journalPath), 'owner-token'), owner.token, { mode: 0o600 });

  // #38610 REVIEW must ① — outbound webhooks are part of the real boot: the same child events that
  // build the side tabs reach every subscribed URL (deliver is fire-and-forget inside).
  webhookOutOf.set(core, createOutboundWebhooks({ stateDir: dirname(socketPath) }));
  let httpServer: Server | undefined;
  // The busy-pane stall watcher: started once the core owns the journal, stopped in close().
  let stallAlert: StallAlert | undefined;
  // ELS-CODEX-SEAT-MAIL-WAKE: the unread-mail knock watcher, same lifetime as the stall watcher.
  let mailWakeWatcher: MailWakeWatcher | undefined;
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
    clearInterval(batonTimer);
    if (batonLeases.get(batonDir) === batonLease) { batonLeases.delete(batonDir); opReporters.delete(batonDir); autoExcluded.delete(batonDir); }
    ceoWiring?.stop();
    mailHub.stop(); // ELS-SERVER-EVENT-HUB-NO-DB-POLL — the watcher dies with its server; the badge state keeps its memory.
    mailBadgeState.dispose(); // JUD-B #132880 — frees the resync timer and the off-thread compute worker.
    // D1a must-1(JUD-B #107693): attach 연결을 stopAll() «앞에» 서버 떠남으로 끝낸다 — 이 뒤 pane 들은 홀더에서 살아
    // 있고 새 서버가 입양한다. 이 경로에서 «pane exited» 를 보내면 클라가 자식이 죽은 줄로 뷰를 끊는다.
    attachState.stopping = true;
    const attachSockets = new Set(attachState.sockets);
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
    clearInterval(socketGuardTimer);
    stallAlert?.stop();
    mailWakeWatcher?.stop();
    core.stopAll();
    // ELS-SERVE-EXIT-NOW (JUD-B #127564 ② · OP #127681): an idle client holds `close()` forever (idle 연결이
    // 소켓 삭제 뒤 3.5s 생존) — every remaining open connection is cut now; attach sockets keep the queued
    // stop line + grace above, so the end is immediate without breaking the pane handoff.
    for (const socket of liveSockets) {
      if (attachSockets.has(socket)) continue;
      try { socket.destroy(); } catch { /* already gone */ }
    }
    liveSockets.clear();
    if (httpV1Server) await new Promise<void>((resolve) => httpV1Server!.close(() => resolve()));
    disposeRecordings(core); // every `els record` tap dies with its server; `--stop` disposed its own earlier.
    if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    // OP #129648 (JUD security HOLD on #39569): bun's `listener.close()` unlinks the bound PATH
    // unconditionally — it never checks the inode (probed: evidence-bun-close-unlink-1122). The old
    // pin-and-relink shield still had a check-then-act window: a file swapped onto the path after
    // the pin stage's stat was deleted by the listener close, then the stale pin was relinked —
    // a takeover during the exit could be severed by the exit itself. Prescription: a listener is
    // closed ONLY while the path still holds this process's own bound inode — that close removes
    // our own file and nothing else. A socket this serve no longer owns (lost or replaced) is
    // never closed here at all: the fd dies with the process exit, and the exit never unlinks,
    // links or otherwise touches a path it does not own.
    const closeListenerIfOwned = (listener: Server, p: string): Promise<void> => {
      const bound = boundSockets.get(p)!;
      try {
        const st = statSync(p);
        if (st.isSymbolicLink() || st.ino !== bound.ino || st.dev !== bound.dev) return Promise.resolve(); // not ours — untouched
      } catch { return Promise.resolve(); } // absent — nothing to remove; the fd dies with the process
      return new Promise<void>((resolve) => listener.close(() => resolve()));
    };
    await Promise.all([closeListenerIfOwned(server, socketPath), closeListenerIfOwned(toolServer, toolSocketPath)]);
  };
  const refused = core.start();
  if (refused) {
    markReady(undefined);
    await close();
    return refused;
  }
  core.reapExited();
  // ELS-ORPHAN-SERVE-REAP (OP #131393③ · 골 #132048③): a stateRoot can keep holder residue nobody owns —
  // a SIGKILL'd holder never runs its cleanup, and a SIGKILL'd serve leaves live detached holders no server
  // will ever adopt (reattach only ever looks at journal panes). Now that the journal load has judged the
  // claimed panes, the boot sweeps the rest: dead residue is unlinked, and a live orphan holder's PTY child
  // is ended so its own exit path finishes the cleanup. A journal that cannot be read fails closed — no reap.
  try {
    const claimedPanes = new Set(loadJournal(journalPath).panes.map((pane) => pane.id));
    sweepOrphanHolderResidue(stateRoot, (paneId) => claimedPanes.has(paneId));
  } catch { /* fail-closed: an unreadable journal owns everything — nothing is reaped */ }
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
  // 2.6. ELS-CODEX-SEAT-MAIL-WAKE: a non-eln seat pane (codex CLI 등) that cannot watch its own inbox
  // gets one «우편 확인» knock when the mail ledger records a change — event subscription(fs.watch),
  // 주기 폴링·env 스위치 없음(OP #132156) · idle pane only · one per episode · receipt.
  // `mailWake: false`(시험 솔기) disables the watcher outright.
  if (options.mailWake !== false) mailWakeWatcher = startMailWakeWatcher(core, { receiptsPath: join(dirname(socketPath), 'mail-wake.jsonl'), ...(options.mailWake ?? {}) });
  // 3. The read window for federated hosts, when asked for: it answers from this owner's journal in memory.
  if (options.http) {
    try { httpServer = await startElsHttp(core, options.hostName ?? elsHostName(), options.http, doPolicy(stateRoot)); trackSockets(httpServer); }
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
      trackSockets(httpV1Server);
    } catch (error) {
      markReady(undefined);
      await close();
      return { exitCode: 1, message: `els serve: cannot open the v1 API on ${options.httpV1.bind.host}:${options.httpV1.bind.port}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  // JUD-B #127595 (static risk, unreproduced): a loss that fired while startup awaited its HTTP listeners
  // used to fall through to markReady — this owner has already ended; it must not come back ready.
  if (lostReason !== undefined) {
    markReady(undefined);
    if (httpV1Server) await new Promise<void>((resolve) => httpV1Server!.close(() => resolve()));
    if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    return { exitCode: 1, message: lostReason };
  }
  markReady(core);
  return { server, core, close, lost, ...(httpV1Server ? { httpV1: httpV1Server } : {}) };
}
