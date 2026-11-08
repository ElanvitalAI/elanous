import type { LLMToolSpec } from '../../llm/tool-spec.js';
// Native LLM tools for the Terminal Matrix.
//
// Exposes T1-T7 matrix APIs (list / move / broadcast / channel /
// readonly / recharacter) through the ToolRuntime surface so the
// dashboard LLM can drive placement transitions, broadcast groups,
// IPC channels, read-only locking, and character mutation without
// going through /term slashes.
//
// The legacy `terminal_modal_*` family still exists and stays the
// preferred path when the caller only needs modal lifecycle — those
// dispatchers have the approval-modal plumbing wired. This file is
// additive: matrix-flavoured tools cover everything session e added
// *on top of* the session registry.


import { getTerminalMatrix, getChannelBus } from '../../terminal-matrix/index.js';
import { getSessionCwd } from '../../session/working-dir.js';
import type {
  TerminalCharacter,
  TerminalPlacement,
  TerminalTransport,
  TerminalInstance,
} from '../../terminal-matrix/index.js';
import { BroadcastBus, summarize } from '../../terminal-matrix/index.js';

// ─── shared helpers ─────────────────────────────────────────────

function resolveInstance(idOrSuffix: string): TerminalInstance | undefined {
  const matrix = getTerminalMatrix();
  if (!idOrSuffix) return undefined;
  if (idOrSuffix.startsWith('term:')) return matrix.get(idOrSuffix);
  return matrix.list({ includeExited: true })
    .find(i =>
      i.id.endsWith(`:${idOrSuffix}`)
      || i.legacySessionId === idOrSuffix
      || (i.legacySessionId ?? '').endsWith(idOrSuffix)
    );
}

function formatInstanceLine(i: TerminalInstance): string {
  const s = summarize(i);
  const place = s.placement.kind === 'vw'
    ? `vw:${s.placement.windowId}/${s.placement.slotId}`
    : s.placement.kind === 'modal'
      ? `modal:${s.placement.modalId}`
      : s.placement.kind;
  const groups = s.broadcastGroups.length > 0 ? ` groups=[${s.broadcastGroups.join(',')}]` : '';
  const ro = s.readOnly ? ' ro' : '';
  const dead = s.exitCode !== null ? ` exited=${s.exitCode}` : '';
  return `  ${s.id} char=${s.character.kind} transport=${s.transport.kind} placement=${place}${groups}${ro}${dead} title="${s.title}"`;
}

function parseCharacter(raw: string): TerminalCharacter | null {
  if (!raw) return null;
  const r = raw.trim();
  if (r === 'shell') return { kind: 'shell' };
  if (r === 'claude' || r === 'claude-code') return { kind: 'claude-code' };
  if (r === 'codex') return { kind: 'codex' };
  if (r.startsWith('custom:')) return { kind: 'custom', name: r.slice(7) };
  return null;
}

function parseTransport(raw: string | undefined, user?: string): TerminalTransport {
  if (!raw || raw === 'local') return { kind: 'local' };
  const m = raw.match(/^(tailscale|ssh):(.+?)(?::(\d+))?$/);
  if (!m) return { kind: 'local' };
  const kind = m[1] as 'tailscale' | 'ssh';
  const host = m[2]!;
  if (kind === 'tailscale') return user ? { kind, host, user } : { kind, host };
  const port = m[3] ? Number(m[3]) : undefined;
  return port
    ? (user ? { kind, host, user, port } : { kind, host, port })
    : (user ? { kind, host, user } : { kind, host });
}

function parsePlacement(raw: string, fallbackModalId: string): TerminalPlacement | null {
  const r = raw.trim().toLowerCase();
  if (r === 'background' || r === 'bg') return { kind: 'background' };
  if (r === 'preview') return { kind: 'preview' };
  if (r === 'modal') return { kind: 'modal', modalId: fallbackModalId };
  const vw = r.match(/^vw:([a-z0-9_-]+)\/([a-z0-9_-]+)$/i);
  if (vw) return { kind: 'vw', windowId: vw[1]!, slotId: vw[2]! };
  return null;
}

// ─── TerminalMatrixList ─────────────────────────────────────────

export function buildTerminalMatrixListTool(): LLMToolSpec {
  return {
    name: 'TerminalMatrixList',
    description:
      'List terminals in the unified matrix with optional filters. Returns id, character, transport, '
      + 'placement, broadcast groups, readOnly flag, exit code, title. Prefer this over TerminalModalList '
      + 'when you care about preview / vw placements or character / transport / group membership.',
    parameters: {
      type: 'object',
      properties: {
        transport: { type: 'string', enum: ['local', 'tailscale', 'ssh'], description: 'Filter by transport kind.' },
        character_kind: { type: 'string', enum: ['shell', 'claude-code', 'codex', 'custom'], description: 'Filter by character kind.' },
        placement_kind: { type: 'string', enum: ['background', 'preview', 'modal', 'vw'], description: 'Filter by placement kind.' },
        group: { type: 'string', description: 'Filter to members of this broadcast group.' },
        include_exited: { type: 'boolean', description: 'Include exited terminals. Default false.' },
      },
      additionalProperties: false,
    },
  };
}

export async function dispatchTerminalMatrixList(raw: Record<string, unknown>): Promise<{ output: string }> {
  const matrix = getTerminalMatrix();
  const list = matrix.list({
    transport: raw.transport as 'local' | 'tailscale' | 'ssh' | undefined,
    characterKind: raw.character_kind as 'shell' | 'claude-code' | 'codex' | 'custom' | undefined,
    placementKind: raw.placement_kind as 'background' | 'preview' | 'modal' | 'vw' | undefined,
    group: typeof raw.group === 'string' ? raw.group : undefined,
    includeExited: raw.include_exited === true,
  });
  if (list.length === 0) return { output: 'TerminalMatrixList (0 matches)' };
  const lines = [`TerminalMatrixList (${list.length} matches)`];
  for (const i of list) lines.push(formatInstanceLine(i));
  return { output: lines.join('\n') };
}

// ─── TerminalMatrixMove ─────────────────────────────────────────

export function buildTerminalMatrixMoveTool(): LLMToolSpec {
  return {
    name: 'TerminalMatrixMove',
    description:
      'Move a terminal between placements without respawning the PTY. Supported placements: background, '
      + 'preview, modal, vw:<windowId>/<slotId>. The PTY (cursor, scrollback, env) survives the move.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Terminal id (term:<N> or a legacy session id suffix).' },
        placement: { type: 'string', description: 'Target placement: background | preview | modal | vw:<win>/<slot>' },
      },
      required: ['id', 'placement'],
      additionalProperties: false,
    },
  };
}

export async function dispatchTerminalMatrixMove(raw: Record<string, unknown>): Promise<{ output: string }> {
  const id = typeof raw.id === 'string' ? raw.id : '';
  const placement = typeof raw.placement === 'string' ? raw.placement : '';
  const inst = resolveInstance(id);
  if (!inst) return { output: `TerminalMatrixMove: no terminal matched "${id}"` };
  const dest = parsePlacement(placement, inst.id);
  if (!dest) return { output: `TerminalMatrixMove: invalid placement "${placement}" (expected background|preview|modal|vw:<w>/<s>)` };
  try {
    getTerminalMatrix().move(inst.id, dest);
    return { output: `TerminalMatrixMove: ${inst.id} → ${placement}` };
  } catch (err) {
    return { output: `TerminalMatrixMove failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── TerminalBroadcastSend ──────────────────────────────────────

export function buildTerminalBroadcastSendTool(): LLMToolSpec {
  return {
    name: 'TerminalBroadcastSend',
    description:
      'Broadcast raw bytes (keyboard input, commands) to every alive, non-readonly member of a named '
      + 'broadcast group. Analogous to tmux synchronize-panes. Members must have joined via '
      + 'TerminalMatrixGroupJoin first. Newline "\\r" at the end executes the command.',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Broadcast group name.' },
        text: { type: 'string', description: 'Bytes to write to every member\'s PTY. Include \\r to submit.' },
      },
      required: ['group', 'text'],
      additionalProperties: false,
    },
  };
}

export async function dispatchTerminalBroadcastSend(raw: Record<string, unknown>): Promise<{ output: string }> {
  const group = typeof raw.group === 'string' ? raw.group : '';
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (!group || !text) return { output: 'TerminalBroadcastSend: group + text required' };
  const bus = new BroadcastBus(getTerminalMatrix());
  const r = bus.broadcastBytes(group, text);
  const lines = [
    `TerminalBroadcastSend: group=${group}`,
    `  delivered=${r.delivered.length} [${r.delivered.join(',')}]`,
    `  skipped_exited=${r.skippedExited.length} [${r.skippedExited.join(',')}]`,
    `  skipped_readonly=${r.skippedReadOnly.length} [${r.skippedReadOnly.join(',')}]`,
    `  errored=${r.errored.length}${r.errored.length ? ' ' + r.errored.map(e => `${e.id}:${e.error}`).join('; ') : ''}`,
  ];
  return { output: lines.join('\n') };
}

// ─── TerminalMatrixGroupJoin / Leave ────────────────────────────

export function buildTerminalMatrixGroupJoinTool(): LLMToolSpec {
  return {
    name: 'TerminalMatrixGroupJoin',
    description: 'Add a terminal to a named broadcast group so TerminalBroadcastSend reaches it.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Terminal id.' },
        group: { type: 'string', description: 'Group name.' },
      },
      required: ['id', 'group'],
      additionalProperties: false,
    },
  };
}

export async function dispatchTerminalMatrixGroupJoin(raw: Record<string, unknown>): Promise<{ output: string }> {
  const id = typeof raw.id === 'string' ? raw.id : '';
  const group = typeof raw.group === 'string' ? raw.group : '';
  const inst = resolveInstance(id);
  if (!inst) return { output: `TerminalMatrixGroupJoin: no terminal matched "${id}"` };
  if (!group) return { output: 'TerminalMatrixGroupJoin: group required' };
  getTerminalMatrix().joinGroup(inst.id, group);
  return { output: `TerminalMatrixGroupJoin: ${inst.id} → ${group}` };
}

export function buildTerminalMatrixGroupLeaveTool(): LLMToolSpec {
  return {
    name: 'TerminalMatrixGroupLeave',
    description: 'Remove a terminal from a named broadcast group.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Terminal id.' },
        group: { type: 'string', description: 'Group name.' },
      },
      required: ['id', 'group'],
      additionalProperties: false,
    },
  };
}

export async function dispatchTerminalMatrixGroupLeave(raw: Record<string, unknown>): Promise<{ output: string }> {
  const id = typeof raw.id === 'string' ? raw.id : '';
  const group = typeof raw.group === 'string' ? raw.group : '';
  const inst = resolveInstance(id);
  if (!inst) return { output: `TerminalMatrixGroupLeave: no terminal matched "${id}"` };
  if (!group) return { output: 'TerminalMatrixGroupLeave: group required' };
  getTerminalMatrix().leaveGroup(inst.id, group);
  return { output: `TerminalMatrixGroupLeave: ${inst.id} ← ${group}` };
}

// ─── TerminalChannelPublish ─────────────────────────────────────

export function buildTerminalChannelPublishTool(): LLMToolSpec {
  return {
    name: 'TerminalChannelPublish',
    description:
      'Publish a message on the terminal IPC channel bus. Subscribers (other terminals via tail, LLM '
      + 'tools, UI widgets) receive the payload. Channel names are free-form; convention is '
      + '<domain>:<topic> (e.g. k8s:logs).',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name.' },
        payload: { type: 'string', description: 'Message body.' },
        from: { type: 'string', description: 'Publisher id / label (defaults to "llm").' },
      },
      required: ['channel', 'payload'],
      additionalProperties: false,
    },
  };
}

export async function dispatchTerminalChannelPublish(raw: Record<string, unknown>): Promise<{ output: string }> {
  const channel = typeof raw.channel === 'string' ? raw.channel : '';
  const payload = typeof raw.payload === 'string' ? raw.payload : '';
  const from = typeof raw.from === 'string' ? raw.from : 'llm';
  if (!channel || !payload) return { output: 'TerminalChannelPublish: channel + payload required' };
  const n = getChannelBus().publish(channel, { from, payload });
  return { output: `TerminalChannelPublish: ${channel} → ${n} subscribers` };
}

// ─── TerminalReadonlySet ────────────────────────────────────────

export function buildTerminalReadonlySetTool(): LLMToolSpec {
  return {
    name: 'TerminalReadonlySet',
    description:
      'Toggle a terminal\'s read-only flag. When on, matrix.writeTo() drops all writes and '
      + 'broadcasts skip the member. PTY output still renders — useful for spectator / audit views.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Terminal id.' },
        on: { type: 'boolean', description: 'true = read-only, false = interactive. Omit to toggle.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  };
}

export async function dispatchTerminalReadonlySet(raw: Record<string, unknown>): Promise<{ output: string }> {
  const id = typeof raw.id === 'string' ? raw.id : '';
  const inst = resolveInstance(id);
  if (!inst) return { output: `TerminalReadonlySet: no terminal matched "${id}"` };
  const next = typeof raw.on === 'boolean' ? raw.on : !inst.readOnly;
  getTerminalMatrix().setReadOnly(inst.id, next);
  return { output: `TerminalReadonlySet: ${inst.id} readonly=${next ? 'on' : 'off'}` };
}

// ─── TerminalRecharacter ────────────────────────────────────────

export function buildTerminalRecharacterTool(): LLMToolSpec {
  return {
    name: 'TerminalRecharacter',
    description:
      'Swap a terminal\'s character + optionally exec the new binary inside the existing PTY. Preserves '
      + 'scrollback and cursor. Character values: shell, claude, codex, custom:<name>.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Terminal id.' },
        character: { type: 'string', description: 'shell | claude | codex | custom:<name>' },
        reexec: { type: 'boolean', description: 'Fire `exec <cmd>` into PTY (default true).' },
      },
      required: ['id', 'character'],
      additionalProperties: false,
    },
  };
}

export async function dispatchTerminalRecharacter(raw: Record<string, unknown>): Promise<{ output: string }> {
  const id = typeof raw.id === 'string' ? raw.id : '';
  const charRaw = typeof raw.character === 'string' ? raw.character : '';
  const reexec = raw.reexec === undefined ? true : raw.reexec === true;
  const inst = resolveInstance(id);
  if (!inst) return { output: `TerminalRecharacter: no terminal matched "${id}"` };
  const character = parseCharacter(charRaw);
  if (!character) return { output: `TerminalRecharacter: invalid character "${charRaw}"` };
  const r = getTerminalMatrix().recharacterAndReexec(inst.id, character, { reexec });
  return { output: `TerminalRecharacter: ${inst.id} character=${character.kind}${r.reexeced ? ' (reexeced)' : ''}` };
}

// ─── TerminalPipeToChannel / List / Unpipe ──────────────────────

export function buildTerminalPipeToChannelTool(): LLMToolSpec {
  return {
    name: 'TerminalPipeToChannel',
    description:
      'Tap a terminal\'s stdout and publish each chunk (or line, when line_mode=true) onto the ChannelBus. '
      + 'Use to build pipelines: Terminal A\'s output → channel → (other terminals via ChannelTail, or '
      + 'LLM subscribers, or UI widgets). Returns pipe_id for later Unpipe.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Terminal id.' },
        channel: { type: 'string', description: 'Destination channel name.' },
        line_mode: { type: 'boolean', description: 'Buffer until \\n; emit one message per line. Default false.' },
      },
      required: ['id', 'channel'],
      additionalProperties: false,
    },
  };
}

export async function dispatchTerminalPipeToChannel(raw: Record<string, unknown>): Promise<{ output: string }> {
  const id = typeof raw.id === 'string' ? raw.id : '';
  const channel = typeof raw.channel === 'string' ? raw.channel : '';
  const lineMode = raw.line_mode === true;
  const inst = resolveInstance(id);
  if (!inst) return { output: `TerminalPipeToChannel: no terminal matched "${id}"` };
  if (!channel) return { output: 'TerminalPipeToChannel: channel required' };
  try {
    const h = getTerminalMatrix().pipeToChannel(inst.id, channel, { lineMode });
    return { output: `TerminalPipeToChannel: pipe_id=${h.id} ${inst.id} → ${channel}${lineMode ? ' (line)' : ''}` };
  } catch (err) {
    return { output: `TerminalPipeToChannel failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function buildTerminalUnpipeFromChannelTool(): LLMToolSpec {
  return {
    name: 'TerminalUnpipeFromChannel',
    description: 'Detach a pipe started with TerminalPipeToChannel. Flushes any partial line in line-mode.',
    parameters: {
      type: 'object',
      properties: {
        pipe_id: { type: 'number', description: 'Pipe id returned from TerminalPipeToChannel.' },
      },
      required: ['pipe_id'],
      additionalProperties: false,
    },
  };
}

export async function dispatchTerminalUnpipeFromChannel(raw: Record<string, unknown>): Promise<{ output: string }> {
  const pipeId = typeof raw.pipe_id === 'number' ? raw.pipe_id : Number(raw.pipe_id);
  if (!Number.isFinite(pipeId)) return { output: 'TerminalUnpipeFromChannel: pipe_id required' };
  const p = getTerminalMatrix().listPipes().find(x => x.id === pipeId);
  if (!p) return { output: `TerminalUnpipeFromChannel: no active pipe #${pipeId}` };
  p.unsubscribe();
  return { output: `TerminalUnpipeFromChannel: detached #${pipeId} (${p.terminalId} ↛ ${p.channel})` };
}

export function buildTerminalPipeListTool(): LLMToolSpec {
  return {
    name: 'TerminalPipeList',
    description: 'Enumerate every active stdout → channel pipe. Returns pipe_id, terminal_id, channel, line_mode.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  };
}

export async function dispatchTerminalPipeList(): Promise<{ output: string }> {
  const all = getTerminalMatrix().listPipes();
  if (all.length === 0) return { output: 'TerminalPipeList (0 pipes)' };
  const lines = [`TerminalPipeList (${all.length} pipes)`];
  for (const p of all) {
    lines.push(`  #${p.id} ${p.terminalId} → ${p.channel}${p.lineMode ? ' (line)' : ''}`);
  }
  return { output: lines.join('\n') };
}

// ─── TerminalMatrixSpawn ────────────────────────────────────────

export function buildTerminalMatrixSpawnTool(): LLMToolSpec {
  return {
    name: 'TerminalMatrixSpawn',
    description:
      'Spawn a new terminal with full matrix options (character, transport, initial broadcast groups, '
      + 'read-only flag). For simple "run a command" cases prefer RunShell (mode="vw" auto-routes to '
      + 'the user-visible runner pane). Use TerminalMatrixSpawn when you need a remote '
      + '(tailscale/ssh) host, a coding-agent character, or an initial group / readOnly / background state.',
    parameters: {
      type: 'object',
      properties: {
        title:   { type: 'string', description: 'Display title.' },
        cwd:     { type: 'string', description: 'Working directory (local transport) / ignored for remote.' },
        command: { type: 'string', description: 'Optional initial command typed into the shell.' },
        character: { type: 'string', description: 'shell | claude | codex | custom:<name>' },
        transport: { type: 'string', description: 'local | tailscale:<host> | ssh:<host>[:<port>]' },
        transport_user: { type: 'string', description: 'Optional user@ override for remote transports.' },
        groups: { type: 'array', items: { type: 'string' }, description: 'Initial broadcast groups.' },
        readonly: { type: 'boolean', description: 'Spawn read-only (default false).' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  };
}

export async function dispatchTerminalMatrixSpawn(raw: Record<string, unknown>): Promise<{ output: string }> {
  const title = typeof raw.title === 'string' ? raw.title : '';
  if (!title) return { output: 'TerminalMatrixSpawn: title required' };
  // WD6 — default spawn cwd to the session working directory.
  const cwd = typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : getSessionCwd();
  const command = typeof raw.command === 'string' ? raw.command : undefined;
  const character = parseCharacter(typeof raw.character === 'string' ? raw.character : '') ?? undefined;
  const transport = parseTransport(
    typeof raw.transport === 'string' ? raw.transport : undefined,
    typeof raw.transport_user === 'string' ? raw.transport_user : undefined,
  );
  const groups = Array.isArray(raw.groups) ? raw.groups.filter((g): g is string => typeof g === 'string') : [];
  const readOnly = raw.readonly === true;
  try {
    const inst = getTerminalMatrix().spawn({
      title, cwd, command, character, transport,
      broadcastGroups: groups, readOnly,
    });
    return { output: `TerminalMatrixSpawn: ${inst.id} character=${inst.character.kind} transport=${inst.transport.kind}` };
  } catch (err) {
    return { output: `TerminalMatrixSpawn failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
