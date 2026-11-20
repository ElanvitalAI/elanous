// ELN-ELS-NATIVE-TOOL · ElsControl — the eln daemon tool that drives els panes through the control door.
// Gate: ELANOUS_ELS_SOCKET — the socket of the els server this daemon runs inside. No socket → no tool.
// 우회 0: every action runs through createControl (control-allow.json · control-audit.jsonl · close human
// confirmation). The tool's only executor is requestEls over the els socket — it never touches panes directly.
import { dirname } from 'node:path';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import { requestEls } from './client.js';
import { audit, createControl, type ControlAction, type ControlTarget, type IdResolver, type StructPayload } from './control.js';
import type { ElsRequest } from './server.js';

export const ELS_CONTROL_TOOL_NAME = 'ElsControl';
export const ELS_CONTROL_ACTIONS = ['ls', 'status', 'read', 'new', 'do', 'send', 'close', 'rename', 'move', 'focus'] as const;
export type ElsControlAction = (typeof ELS_CONTROL_ACTIONS)[number];

/** Door action per tool action. focus: the door vocabulary + server focus pointer land in the follow-up
 * delta on this branch — until then ElsControl refuses focus locally (never a silent bypass). */
const DOOR_ACTION: Record<ElsControlAction, ControlAction | null> = {
  ls: 'list',
  status: 'status',
  read: 'read',
  new: 'new',
  do: 'do',
  send: 'input',
  close: 'close',
  rename: 'rename',
  move: 'move',
  focus: null,
};

/** ELANOUS_ELS_SOCKET gate — '' when the daemon is not running inside an els pane. */
export function elsControlSocketPath(env: Record<string, string | undefined> = process.env): string {
  const socket = env.ELANOUS_ELS_SOCKET ?? '';
  return typeof socket === 'string' && socket.trim() ? socket : '';
}

export interface ElsControlDeps {
  readonly socketPath: string;
  readonly stateDir: string;
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
interface ListedPane { readonly pane: string; readonly tab: string; readonly kind?: string }
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
function wireRequest(input: { action: ControlAction; target: ControlTarget; text?: string }, title?: string): ElsRequest {
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
        cwd: '',
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
      listed = await requestEls(deps.socketPath, { op: 'ls' });
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
  let confirm: boolean | undefined;
  if ((action === 'close' || action === 'move') && deps.ask) confirm = await deps.ask(`ElsControl ${action} ${target.pane} (workspace ${target.workspace}) — confirm closing?`);
  let sent: ElsRequest | undefined;
  const control = createControl({
    stateDir: deps.stateDir,
    ...(resolver ? { resolve: resolver } : {}),
    execute: async (input) => {
      sent = wireRequest(input, title);
      return requestEls(deps.socketPath, sent);
    },
  });
  const outcome = await control.run({
    principal: { id: 'eln:tool', kind: 'eln' },
    from: ELS_CONTROL_TOOL_NAME,
    action: doorAction,
    target,
    ...(text ? { text } : {}),
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
  const allowed = outcome as { exitCode?: number; message?: string };
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
    ...(sent ? { request: sent } : {}),
    ...(data !== undefined ? { data } : {}),
  };
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
  return JSON.stringify(await runElsControl(args, { socketPath, stateDir: dirname(socketPath) }));
}

export function buildElsControlTool(): LLMToolSpec {
  return {
    name: ELS_CONTROL_TOOL_NAME,
    description:
      'ELS panes·tabs 제어 — 모든 동작이 els 제어 문(control-allow.json 허용목록 · 감사 · close 사람 확인)을 경유합니다. 결과는 구조 JSON. 동작: ls·status·read·new·do·send·close·rename·move·focus(focus는 후속 델타).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ELS_CONTROL_ACTIONS], description: '수행 동작' },
        pane: { type: 'string', description: '대상 pane id — 유일한 대상 지정자입니다. workspace·tab·shell 은 els 저널에서 도구가 직접 조회하며 인자로 받지 않습니다 (new 는 이 pane 의 workspace 에 엽니다)' },
        title: { type: 'string', description: 'new: 새 탭 제목' },
        text: { type: 'string', description: '명령줄/입력 텍스트 (new·do·send)' },
        kind: { type: 'string', description: 'rename·move·close 구조 종류: workspace|tab' },
        id: { type: 'string', description: 'rename·move 구조 대상 id (pane 과 같은 workspace 안이어야 함)' },
        name: { type: 'string', description: 'rename: 새 이름' },
        before: { type: 'string', description: 'move: 이 항목 앞으로 이동 (형제 id)' },
      },
      required: ['action'],
    },
  };
}
