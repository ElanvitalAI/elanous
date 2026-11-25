// ELN-ELS-NATIVE-TOOL · ElsControl — the eln daemon tool that drives els panes through the control door.
// Gate: ELANOUS_ELS_SOCKET — the socket of the els server this daemon runs inside. No socket → no tool.
// 우회 0: every action runs through createControl (control-allow.json · control-audit.jsonl · close human
// confirmation). The tool's only executor is requestEls over the els socket — it never touches panes directly.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import { requestEls } from './client.js';
import { audit, createControl, type ControlAction, type ControlTarget, type IdResolver, type StructPayload } from './control.js';
import type { ElsRequest } from './server.js';

export const ELS_CONTROL_TOOL_NAME = 'ElsControl';
export const ELS_CONTROL_ACTIONS = ['ls', 'status', 'read', 'new', 'do', 'send', 'stop', 'close', 'rename', 'move', 'focus'] as const;
export type ElsControlAction = (typeof ELS_CONTROL_ACTIONS)[number];

/** Door action per tool action. focus: the door vocabulary + server focus pointer land in the follow-up
 * delta on this branch — until then ElsControl refuses focus locally (never a silent bypass). */
const DOOR_ACTION: Record<ElsControlAction, ControlAction | null> = {
  ls: 'list',
  status: 'status',
  read: 'read',
  new: 'new',
  do: 'do',
  // Tool-authored operations need the stricter do gate; the server independently authenticates input.
  send: 'do',
  stop: 'do',
  close: 'close',
  rename: 'rename',
  move: 'move',
  focus: null,
};

/** ELANOUS_ELS_SOCKET gate — '' when the daemon is not running inside an els pane. */
/** ELS-ORCH-PEER-IDENTITY 최소판: this process's seat from the env els set when it opened the seat tab. */
export function elsControlSeat(env: Record<string, string | undefined> = process.env): { readonly name: string; readonly workspaces?: readonly string[] } | undefined {
  const name = (env.ELANOUS_TRACK || env.ELANOUS_SEAT || '').trim();
  if (!name) return undefined;
  const ws = (env.ELANOUS_ELS_WS || '').trim();
  return ws ? { name, workspaces: [ws] } : { name };
}

export function elsControlSocketPath(env: Record<string, string | undefined> = process.env): string {
  const socket = env.ELANOUS_ELS_SOCKET ?? '';
  return typeof socket === 'string' && socket.trim() ? socket : '';
}

export interface ElsControlDeps {
  readonly socketPath: string;
  readonly stateDir: string;
  /** ELS-ORCH-PEER-IDENTITY 최소판(CEO 11-23 15:1x): the calling seat — the door's coded default rules key on it (OP → all panes · HAND-* → own workspaces). Absent ⇒ anonymous eln:tool (file rules only). */
  readonly seat?: { readonly name: string; readonly workspaces?: readonly string[] };
  /** Human confirmation channel — used only for close. Absent ⇒ close stays denied (door default). */
  readonly ask?: (question: string) => Promise<boolean>;
}

export interface ElsControlResult {
  readonly tool: string;
  readonly action: string;
  readonly allowed: boolean;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly message: string;
  readonly queued?: number;
  readonly code?: string;
  readonly reason?: string;
  readonly request?: ElsRequest;
  readonly data?: unknown;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function argsRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
}

function tryParse(message: string): unknown {
  try {
    return JSON.parse(message);
  } catch {
    return undefined;
  }
}


interface JournalRow { readonly id: string; readonly name?: string; readonly workspaceId?: string }
interface ListedPane { readonly pane: string; readonly tab: string; readonly kind?: string; readonly cwd?: string; readonly seat?: string | null }
interface Listing { readonly workspaces: readonly JournalRow[]; readonly tabs: readonly JournalRow[]; readonly panes: readonly ListedPane[] }

/** Pane kinds that take typed prose, not shell lines. Every other kind (pty, shell, other, remote, unknown) is
 * danger-classified — fail closed: an unrecognised kind is never the unclassified path. */
const NON_SHELL_KINDS: ReadonlySet<string> = new Set(['agent', 'harness-child', 'graph-view', 'codex', 'claude', 'grok', 'eln']);

function parseListing(message: string): Listing | undefined {
  const body = tryParse(message) as Partial<Listing> | undefined;
  if (!body || !Array.isArray(body.workspaces) || !Array.isArray(body.tabs) || !Array.isArray(body.panes)) return undefined;
  return body as Listing;
}

interface Resolved { readonly target: ControlTarget; readonly tabId: string; readonly listing: Listing }

/** Pane id → workspace id / tab / shell from the els journal (the `els ls --json` answer). Undefined = unknown pane. */
function resolvePane(listing: Listing, paneId: string): Resolved | undefined {
  const row = listing.panes.find((p) => p.pane === paneId);
  const tab = row ? listing.tabs.find((t) => t.id === row.tab) : undefined;
  const workspace = tab ? listing.workspaces.find((w) => w.id === tab.workspaceId) : undefined;
  if (!row || !tab || !workspace) return undefined;
  return { target: { workspace: workspace.id, tab: tab.id, pane: row.pane, shell: !NON_SHELL_KINDS.has(String(row.kind ?? '')) }, tabId: tab.id, listing };
}

/** Name-or-id → id from the same listing, so allow-list name rules pin exactly as they do for the CLI door. */
function listingResolver(listing: Listing): IdResolver {
  return {
    workspace: (ref) => listing.workspaces.find((w) => w.id === ref)?.id ?? listing.workspaces.find((w) => w.name === ref)?.id,
    pane: (ref) => listing.panes.find((p) => p.pane === ref)?.pane,
  };
}

/** A structural object the LLM names must live in the resolved pane's own workspace (no cross-space reach). */
function structIn(resolved: Resolved, kind: 'workspace' | 'tab' | 'pane', id: string): boolean {
  const { listing, target } = resolved;
  const inSpace = (tabId: string): boolean => listing.tabs.find((t) => t.id === tabId)?.workspaceId === target.workspace;
  if (kind === 'workspace') return id === target.workspace;
  if (kind === 'tab') return inSpace(id);
  const row = listing.panes.find((p) => p.pane === id);
  return !!row && inSpace(row.tab);
}

function refusal(action: string, code: string, reason: string, stateDir: string, paneId: string): ElsControlResult {
  audit(stateDir, { principal: 'eln:tool', kind: 'eln', pane: paneId, action, result: 'denied', danger: 'n/a', reason, at: Date.now() });
  return { tool: ELS_CONTROL_TOOL_NAME, action, allowed: false, ok: false, exitCode: 1, code, reason, message: `ElsControl ${action}: rejected (${reason}); nothing was sent` };
}

/** Door action → els wire request. The executor runs only when the door allowed the payload. */
function wireRequest(input: { action: ControlAction; target: ControlTarget; text?: string }, title?: string, cwd?: string): ElsRequest {
  const struct = (input as { struct?: StructPayload }).struct;
  switch (input.action) {
    case 'list':
      return { op: 'ls' };
    case 'status':
      return { op: 'status', pane: input.target.pane };
    case 'read':
      return { op: 'read', pane: input.target.pane };
    case 'new':
      return {
        op: 'new',
        ws: input.target.workspace,
        cwd: typeof cwd === 'string' ? cwd : '',
        command: (input.text ?? '').split(/\s+/).filter(Boolean),
        ...(title ? { title } : {}),
      };
    case 'do':
      return { op: 'do', pane: input.target.pane, text: input.text ?? '', from: 'ElsControl' };
    case 'input':
      return { op: 'input-line', pane: input.target.pane, text: input.text ?? '', from: 'ElsControl' };
    case 'close':
      // The door only reaches here with the human's confirm:true; the els socket gate asks for the same marker (#39143).
      return { op: 'close', pane: input.target.pane, confirmed: true };
    case 'rename':
      return { op: 'rename', kind: struct?.kind ?? 'tab', id: struct?.id ?? input.target.pane, name: struct?.name ?? '' };
    case 'move':
      return {
        op: 'reorder',
        kind: struct?.kind ?? 'tab',
        id: struct?.id ?? input.target.pane,
        ...(struct?.before ? { before: struct.before } : {}),
      };
  }
}

/** Core handler — tests inject deps directly; the daemon dispatch builds them from the env gate. */
export async function runElsControl(args: unknown, deps: ElsControlDeps): Promise<ElsControlResult> {
  const a = argsRecord(args);
  const action = str(a.action) as ElsControlAction;
  if (!(ELS_CONTROL_ACTIONS as readonly string[]).includes(action)) {
    return {
      tool: ELS_CONTROL_TOOL_NAME,
      action: str(a.action),
      allowed: false,
      ok: false,
      exitCode: 2,
      message: `ElsControl: unknown action ${JSON.stringify(str(a.action))} — actions: ${ELS_CONTROL_ACTIONS.join(' · ')}`,
    };
  }
  const doorAction = DOOR_ACTION[action];
  if (!doorAction) {
    return {
      tool: ELS_CONTROL_TOOL_NAME,
      action,
      allowed: false,
      ok: false,
      exitCode: 2,
      message:
        'ElsControl focus: the control door does not know this action yet — it lands in the follow-up delta on this branch (door vocabulary + server focus pointer). Nothing was executed.',
    };
  }
  // Journal-resolved target: the LLM names only a pane id. workspace / tab / shell are never read from its arguments
  // (JUD fail must ⓒ) — they come from the els journal, so allow rules, HITL and shell classification see real values.
  const paneId = str(a.pane);
  let resolved: Resolved | undefined;
  let resolver: IdResolver | undefined;
  if (paneId || doorAction !== 'list') {
    if (!paneId) return refusal(action, 'pane-required', 'pane id is required', deps.stateDir, '');
    let listed: { readonly exitCode: number; readonly message: string };
    try {
      listed = await requestEls(join(dirname(deps.socketPath), 'ctl.sock'), { op: 'ls' });
    } catch (error) {
      return refusal(action, 'lookup-failed', `journal lookup failed: ${error instanceof Error ? error.message : String(error)}`, deps.stateDir, paneId);
    }
    const listing = listed.exitCode === 0 ? parseListing(listed.message) : undefined;
    if (!listing) return refusal(action, 'lookup-failed', 'journal lookup failed', deps.stateDir, paneId);
    resolver = listingResolver(listing);
    resolved = resolvePane(listing, paneId);
    if (!resolved) return refusal(action, 'unknown-pane', `unknown pane ${paneId}`, deps.stateDir, paneId);
  }
  // ls without a pane asks about every space: only a wildcard rule authorizes it.
  const target: ControlTarget = resolved?.target ?? { workspace: '*', pane: '*', shell: false };
  const text = str(a.text);
  const title = str(a.title);
  let struct: StructPayload | undefined;
  if (resolved && (doorAction === 'rename' || doorAction === 'move' || doorAction === 'close')) {
    const kindArg = str(a.kind);
    const kind: 'workspace' | 'tab' | 'pane' = kindArg === 'workspace' || kindArg === 'pane' ? kindArg : 'tab';
    const own = kind === 'workspace' ? target.workspace : kind === 'pane' ? target.pane : resolved.tabId;
    const id = str(a.id) || own;
    const before = str(a.before);
    if (doorAction !== 'close' && (!structIn(resolved, kind, id) || (before && !structIn(resolved, kind, before)))) {
      return refusal(action, 'out-of-space', `${kind} ${id}${before ? ` / ${before}` : ''} is not in pane ${paneId}'s workspace`, deps.stateDir, paneId);
    }
    struct = { kind, id: doorAction === 'close' ? own : id, ...(str(a.name) ? { name: str(a.name) } : {}), ...(before ? { before } : {}) };
  }
  // ELS-OP-CLOSE-TAB (대표 11-24 «보안 기본 완화»): the OP coordinator closing a seat's tab is routine — no person is asked
  // and the whole tab closes (server `close-tab`: one `els.close` audit line with caller · label · pane count). The OP's
  // own tab is the exception: refused here, and again at the server, unless a person confirms it there.
  const coordinatorClose = action === 'close' && deps.seat?.name === 'OP' && !!resolved;
  if (coordinatorClose && resolved!.listing.panes.some((pane) => pane.tab === resolved!.tabId && pane.seat === 'OP')) {
    return refusal(action, 'op-tab', `tab ${resolved!.tabId} is the OP tab itself — closing it needs a person's confirmation`, deps.stateDir, paneId);
  }
  let confirm: boolean | undefined;
  if ((action === 'close' || action === 'move') && deps.ask && !coordinatorClose) confirm = await deps.ask(`ElsControl ${action} ${target.pane} (workspace ${target.workspace}) — confirm closing?`);
  let sent: ElsRequest | undefined;
  const control = createControl({
    stateDir: deps.stateDir,
    ...(resolver ? { resolve: resolver } : {}),
    execute: async (input) => {
      sent = action === 'stop' ? { op: 'interrupt', pane: input.target.pane }
        : action === 'send' ? { op: 'input-line', pane: input.target.pane, text: input.text ?? '', from: 'ElsControl' }
        : coordinatorClose && struct?.kind !== 'pane' ? { op: 'close-tab', tab: resolved!.tabId }
        : wireRequest(input, title, resolved?.listing.panes.find((pane) => pane.pane === paneId)?.cwd);
      return requestEls(join(dirname(deps.socketPath), 'ctl.sock'), sent);
    },
  });
  const outcome = await control.run({
    principal: { id: 'eln:tool', kind: 'eln', ...(deps.seat?.name ? { seat: deps.seat.name, callerSeat: deps.seat.name, ...(deps.seat.workspaces ? { workspaces: deps.seat.workspaces } : {}) } : {}) },
    from: action === 'stop' ? `${ELS_CONTROL_TOOL_NAME}:stop` : ELS_CONTROL_TOOL_NAME,
    action: doorAction,
    // stop sends a fixed Escape, not a shell command; it still needs the do allow rule and server input gate.
    target: action === 'stop' ? { ...target, shell: false } : target,
    ...(action === 'stop' ? {} : text ? { text } : {}),
    ...(struct ? { struct } : {}),
    ...(confirm !== undefined ? { confirm } : {}),
  });
  if (!outcome.ok) {
    const denied = outcome as { code?: string; reason?: string };
    return {
      tool: ELS_CONTROL_TOOL_NAME,
      action,
      allowed: false,
      ok: false,
      exitCode: 1,
      code: denied.code,
      reason: denied.reason,
      message: outcome.message,
    };
  }
  const allowed = outcome as { exitCode?: number; message?: string; queued?: number };
  const exitCode = allowed.exitCode ?? 0;
  const message = allowed.message ?? '';
  const data = action === 'ls' ? tryParse(message) : undefined;
  return {
    tool: ELS_CONTROL_TOOL_NAME,
    action,
    allowed: true,
    ok: exitCode === 0,
    exitCode,
    message,
    ...(allowed.queued !== undefined ? { queued: allowed.queued } : {}),
    ...(sent ? { request: sent } : {}),
    ...(data !== undefined ? { data } : {}),
  };
}

/** Actions that only look: they never need the caller's OP runtime registration. */
const LOOK_ACTIONS: ReadonlySet<string> = new Set(['ls', 'status', 'read']);
/** The server's tool-door answer when the caller's runtime is not (or no longer) registered (server.ts `new`). */
const UNVERIFIED_TOOL_SEAT = 'verified tool seat required';

export interface OpRuntimeRegistrationDeps {
  readonly env?: Record<string, string | undefined>;
  /** Run `els seat set OP` as a child of this process (the server verifies the child descends from the claimed runtime). */
  readonly run?: (argv: readonly string[], env: Record<string, string | undefined>) => Promise<{ readonly code: number; readonly out: string }>;
  readonly runtime?: () => { readonly pid: number; readonly start: string } | undefined;
  readonly entry?: string;
}

let opRuntimeRegistration: Promise<boolean> | undefined;

/** Test seam: forget this process's registration. */
export function resetOpRuntimeRegistrationForTesting(): void { opRuntimeRegistration = undefined; }

/**
 * DEMO-FANOUT-LIVE-OP-SEAT (demo-check 11-25 S2 «denied … an authorized OP pane is required»): the els tool door only
 * accepts an OP caller whose live runtime was registered with `els seat set OP` — before this, a person had to type that
 * line inside the OP pane. An eln running in the server-minted OP pane (ELANOUS_TRACK=OP ⊕ its pane credential) now does
 * the same registration itself, once, before its first acting ElsControl call. Nothing here grants authority: the server
 * still checks the pane credential's OP role, the claimed runtime's live process generation and that the registering
 * child descends from it (seat-runtime.ts). A pane without the credential, or another seat, never tries.
 */
export async function ensureOpRuntimeRegistered(deps: OpRuntimeRegistrationDeps = {}): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (elsControlSeat(env)?.name !== 'OP' || !(env.ELANOUS_ELS_PANE_TOKEN ?? '').trim() || !elsControlSocketPath(env)) return false;
  opRuntimeRegistration ??= (async () => {
    const runtime = (deps.runtime ?? (() => {
      const { runtimeProcessIdentity } = require('./seat-runtime.js') as typeof import('./seat-runtime.js');
      const self = runtimeProcessIdentity(process.pid);
      return self ? { pid: self.pid, start: self.start } : undefined;
    }))();
    if (!runtime) return false;
    const entry = deps.entry ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'elanous.mjs');
    const run = deps.run ?? runChild;
    try {
      const result = await run([process.execPath, entry, 'side', 'seat', 'set', 'OP'], { ...env, ELN_SEAT_RUNTIME: JSON.stringify(runtime) });
      return result.code === 0;
    } catch { return false; }
  })();
  const ok = await opRuntimeRegistration;
  if (!ok) opRuntimeRegistration = undefined;   // a refused or failed registration is retried on the next acting call
  return ok;
}

function runChild(argv: readonly string[], env: Record<string, string | undefined>): Promise<{ code: number; out: string }> {
  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* already gone */ } }, 15_000);
    child.on('error', () => { clearTimeout(timer); resolve({ code: 1, out }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out }); });
  });
}

/** Daemon dispatch — gated on ELANOUS_ELS_SOCKET (no socket ⇒ the tool is not on the surface at all). */
export async function dispatchElsControl(args: unknown): Promise<string> {
  const socketPath = elsControlSocketPath();
  if (!socketPath) {
    return JSON.stringify({
      tool: ELS_CONTROL_TOOL_NAME,
      allowed: false,
      ok: false,
      exitCode: 2,
      message: 'ElsControl: ELANOUS_ELS_SOCKET is not set — the tool is not available.',
    });
  }
  const seat = elsControlSeat();
  const acting = !LOOK_ACTIONS.has(str(argsRecord(args).action));
  if (acting) await ensureOpRuntimeRegistered();
  const deps = { socketPath, stateDir: dirname(socketPath), ...(seat ? { seat } : {}) };
  let result = await runElsControl(args, deps);
  // An els server restart forgets the registration this process made: register again once and retry the same call.
  if (acting && !result.ok && result.message.includes(UNVERIFIED_TOOL_SEAT)) {
    resetOpRuntimeRegistrationForTesting();
    if (await ensureOpRuntimeRegistered()) result = await runElsControl(args, deps);
  }
  return JSON.stringify(result);
}

export function buildElsControlTool(): LLMToolSpec {
  return {
    name: ELS_CONTROL_TOOL_NAME,
    description:
      'ELS panes·tabs 제어 — 모든 동작이 els 제어 문(control-allow.json 허용목록 · 감사 · close 사람 확인)을 경유합니다. 결과는 구조 JSON. 동작: ls·status·read·new·do·send·stop(중단 키 요청; 결과는 read로 확인)·close·rename·move·focus(focus는 후속 델타).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ELS_CONTROL_ACTIONS], description: '수행 동작' },
        pane: { type: 'string', description: '대상 pane id — 유일한 대상 지정자입니다. workspace·tab·shell 은 els 저널에서 도구가 직접 조회하며 인자로 받지 않습니다 (new 는 이 pane 의 workspace 에 엽니다)' },
        title: { type: 'string', description: 'new: 새 탭 제목' },
        text: { type: 'string', description: 'new: the command the new tab runs (e.g. "eln" for an agent tab) · do/send: the line to type into the pane' },
        kind: { type: 'string', description: 'rename·move·close 구조 종류: workspace|tab' },
        id: { type: 'string', description: 'rename·move 구조 대상 id (pane 과 같은 workspace 안이어야 함)' },
        name: { type: 'string', description: 'rename: 새 이름' },
        before: { type: 'string', description: 'move: 이 항목 앞으로 이동 (형제 id)' },
      },
      required: ['action'],
    },
  };
}
