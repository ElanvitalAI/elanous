// ── Context pull tools — Phase C of PLAN-llm-active-context-and-control ──
//
// A family of read-only LLM tools that replace the dropped auto-inject
// snapshot. Each tool answers one question so the LLM can request
// only the context it needs.
//
// All outputs intentionally return JSON-friendly shapes + a short
// `output` string for the LLM's preview pane.
//
// Related:
//   • src/element-registry/         — single source of truth for addresses
//   • src/tool-runtime/context-runtime.ts — registry registration
//   • 내부 문서 `PLAN-llm-active-context-and-control` §4 Phase C

import type { LLMToolSpec } from '../../llm.js';
import {
  getGlobalElementRegistry,
  getGlobalElementStateStore,
  getGlobalElementEventBus,
  type ElementKind,
  type ElementEventType,
} from '../../element-registry/index.js';
import { listPty, getPty } from '../../pty-shell/registry.js';
import { nativeToolCatalog } from '../../native-tool-catalog.js';
import { NATIVE_TOOL_HOSTS } from '../../tool-surface.js';
import { getSessionCwd } from '../../session/working-dir.js';

// ── Helpers ────────────────────────────────────────────────────────

function workspaceBlob(deps?: ContextDeps): {
  cwd: string;
  platform: NodeJS.Platform;
  remoteHost?: string;
  sandboxAvailable?: boolean;
} {
  return {
    // WD6 — workspace blob reports the active session working
    // directory so LLM-visible context tracks Ctrl+W promotions.
    cwd: deps?.cwd ?? getSessionCwd(),
    platform: process.platform,
    remoteHost: deps?.remoteHost,
    sandboxAvailable: process.platform === 'darwin' || process.platform === 'linux',
  };
}

/** Optional DI for dashboard workspace and terminal-session state. */
export interface ContextDeps {
  cwd?: string;
  remoteHost?: string;
  getTerminalSessions?: () => Array<{ id: string; title: string; state: string }>;
}

// ── Tool specs ─────────────────────────────────────────────────────

export function buildContextTools(): LLMToolSpec[] {
  return [
    {
      name: 'ContextWorkspace',
      description:
        'Return workspace basics: cwd, platform, optional remote host, and whether a sandbox is available. Cheap — call once at turn start.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'ContextPtysList',
      description:
        'List live PTY shells: id, cmd, status (running|exited), ageSec. Use for "what background shells exist?".',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'ContextPtyDetail',
      description:
        'One PTY: full cmd, workdir, exitCode+signal (if any), optional tail of captured output.',
      parameters: {
        type: 'object',
        properties: {
          addr: { type: 'string' },
          tailBytes: { type: 'number' },
        },
        required: ['addr'],
        additionalProperties: false,
      },
    },
    {
      name: 'ContextSessionsList',
      description:
        'List terminal-modal sessions (coding agents + shells): id, title, state (foreground|background|exited).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'ContextWidgetsList',
      description: 'List currently-mounted widgets by id (tied to the active plugin, if any).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'ContextPluginsList',
      description: 'List active plugins by id.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'ContextToolsList',
      description:
        'List native tools in the catalog with host + safety flags. Helpful when you want to know what you can call before calling it.',
      parameters: {
        type: 'object',
        properties: {
          host: {
            type: 'string',
            enum: [...NATIVE_TOOL_HOSTS],
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'ContextEventsTail',
      description:
        'Read the most recent element events (create/update/delete/output/exit/...). Filter by kinds, types, addr, sinceTs. Use for "did anything happen since my last check?".',
      parameters: {
        type: 'object',
        properties: {
          sinceTs: { type: 'number' },
          kinds: { type: 'array', items: { type: 'string' } },
          types: { type: 'array', items: { type: 'string' } },
          addr: { type: 'string' },
          limit: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'ContextBootstrap',
      description:
        'One-shot context warmup: returns workspace + ptys.list + sessions.list + tools.list together. Call once at turn start if you need a broad picture, then drill in with the specialized tools as needed.',
      parameters: {
        type: 'object',
        properties: {
          includeEvents: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  ];
}

// ── Dispatchers ───────────────────────────────────────────────────

export async function dispatchContextWorkspace(
  _args: Record<string, unknown>,
  deps: ContextDeps = {},
): Promise<{ output: string; workspace: ReturnType<typeof workspaceBlob> }> {
  const w = workspaceBlob(deps);
  return {
    output: `cwd=${w.cwd} platform=${w.platform}${w.remoteHost ? ` remote=${w.remoteHost}` : ''} sandbox=${w.sandboxAvailable ? 'yes' : 'no'}`,
    workspace: w,
  };
}

export async function dispatchContextPtysList(): Promise<{
  output: string;
  ptys: Array<{ addr: string; id: string; cmd: string; status: 'running' | 'exited'; ageSec: number }>;
}> {
  const now = Date.now();
  const items = listPty().map(h => ({
    addr: `pty:${h.id}`,
    id: h.id,
    cmd: h.cmd,
    status: h.isAlive() ? 'running' as const : 'exited' as const,
    ageSec: Math.max(0, Math.floor((now - h.startedAt) / 1000)),
  }));
  const output = items.length
    ? items.map(p => `${p.addr}(${p.status}/${p.ageSec}s) ${p.cmd}`).join(', ')
    : '(no PTY shells)';
  return { output, ptys: items };
}

export async function dispatchContextPtyDetail(
  args: Record<string, unknown>,
): Promise<{ output: string; pty?: unknown }> {
  const addr = String(args.addr ?? '').replace(/^pty:/, '');
  if (!addr) return { output: 'missing pty addr' };
  const h = getPty(addr);
  if (!h) return { output: `unknown pty:${addr}` };
  const tailBytes = typeof args.tailBytes === 'number' ? args.tailBytes : 2048;
  const snap = h.snapshot();
  const tail = snap.length > tailBytes ? snap.slice(-tailBytes) : snap;
  return {
    output: `pty:${addr} ${h.isAlive() ? 'running' : `exited(${h.exitCode})`} cmd="${h.cmd}" tail=${tail.length}B`,
    pty: {
      addr: `pty:${addr}`, id: addr, cmd: h.cmd, workdir: h.workdir,
      startedAt: h.startedAt, exitCode: h.exitCode, exitSignal: h.exitSignal,
      alive: h.isAlive(), detach: h.detach, tail,
    },
  };
}

export async function dispatchContextSessionsList(
  _args: Record<string, unknown>,
  deps: ContextDeps = {},
): Promise<{ output: string; sessions: Array<{ addr: string; id: string; title: string; state: string }> }> {
  const list = deps.getTerminalSessions?.() ?? [];
  const sessions = list.map(s => ({ addr: `sess:${s.id}`, ...s }));
  return {
    output: sessions.length
      ? sessions.map(s => `${s.addr}(${s.state}) "${s.title}"`).join(', ')
      : '(no terminal sessions)',
    sessions,
  };
}

export async function dispatchContextWidgetsList(): Promise<{
  output: string;
  widgets: Array<{ addr: string; id: string }>;
}> {
  const widgets = getGlobalElementRegistry().list('widget').map(w => ({ addr: w.addr, id: w.id }));
  return {
    output: widgets.length ? widgets.map(w => w.addr).join(', ') : '(no widgets mounted)',
    widgets,
  };
}

export async function dispatchContextPluginsList(): Promise<{
  output: string;
  plugins: Array<{ addr: string; id: string }>;
}> {
  const plugins = getGlobalElementRegistry().list('plugin').map(p => ({ addr: p.addr, id: p.id }));
  return {
    output: plugins.length ? plugins.map(p => p.addr).join(', ') : '(no plugins active)',
    plugins,
  };
}

export async function dispatchContextToolsList(
  args: Record<string, unknown>,
): Promise<{
  output: string;
  tools: Array<{ id: string; host: string[]; safety: string[]; defaultEnabled: boolean }>;
}> {
  const host = typeof args.host === 'string' ? args.host : undefined;
  const tools = nativeToolCatalog
    .filter(t => !host || host === 'all' || t.host.includes('all') || t.host.includes(host as any))
    .map(t => ({
      id: t.id,
      host: t.host,
      safety: t.safety,
      defaultEnabled: t.defaultEnabled,
    }));
  return {
    output: tools.length ? `${tools.length} tools: ${tools.map(t => t.id).join(', ')}` : '(no tools)',
    tools,
  };
}

export async function dispatchContextEventsTail(
  args: Record<string, unknown>,
): Promise<{
  output: string;
  events: Array<{ ts: number; addr: string; kind: ElementKind; type: ElementEventType; payload?: unknown }>;
}> {
  const kinds = Array.isArray(args.kinds) ? (args.kinds as ElementKind[]) : undefined;
  const types = Array.isArray(args.types) ? (args.types as ElementEventType[]) : undefined;
  const sinceTs = typeof args.sinceTs === 'number' ? args.sinceTs : undefined;
  const addr = typeof args.addr === 'string' ? args.addr : undefined;
  const limit = typeof args.limit === 'number' ? args.limit : 64;
  const events = getGlobalElementEventBus().tail({ sinceTs, kinds, types, addr, limit });
  return {
    output: events.length ? `${events.length} events` : '(no events)',
    events: events.map(e => ({ ts: e.ts, addr: e.addr, kind: e.kind, type: e.type, payload: e.payload })),
  };
}

export async function dispatchContextBootstrap(
  args: Record<string, unknown>,
  deps: ContextDeps = {},
): Promise<{ output: string; [k: string]: unknown }> {
  const [workspace, ptys, sessions, tools] = await Promise.all([
    dispatchContextWorkspace({}, deps),
    dispatchContextPtysList(),
    dispatchContextSessionsList({}, deps),
    dispatchContextToolsList({}),
  ]);
  const events = args.includeEvents === true
    ? await dispatchContextEventsTail({ limit: 32 })
    : undefined;
  const storeSize = getGlobalElementStateStore().size();
  return {
    output: [
      workspace.output,
      `ptys: ${ptys.output}`,
      `sessions: ${sessions.output}`,
      tools.output,
      `state-store entries: ${storeSize}`,
    ].join(' | '),
    workspace: workspace.workspace,
    ptys: ptys.ptys,
    sessions: sessions.sessions,
    tools: tools.tools,
    events: events?.events,
  };
}
