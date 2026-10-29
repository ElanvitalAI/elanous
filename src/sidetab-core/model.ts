import { resolveInstanceName } from '../instance-identity.js';
import type { LLMToolSpec } from '../llm.js';
import { listPtyManifestRows, type PtyManifestRow } from '../pty-shell/pty-manifest.js';
import { describePtyRunState } from '../pty-shell/tui-run-state.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export type SidetabBadge = 'busy' | 'idle' | 'stale' | 'unknown' | 'exited';

export interface SidetabRow {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly badge: SidetabBadge;
  readonly sessionId?: string;
  readonly ptyId?: string;
  readonly nestDepth?: number;
  readonly ownerPid?: number;
  readonly currentProcess?: boolean;
}

export interface SidetabState {
  readonly open: boolean;
  readonly selected: number;
}

export interface SidetabScope {
  readonly all?: boolean;
  readonly currentPtyId?: string;
  readonly currentPid?: number;
  /** Current classic chat session; classic shell rows carry it in their purpose tag. */
  readonly currentSessionId?: string;
}

export type SidetabKey = 'toggle' | 'up' | 'down' | 'other';

export function createSidetabState(): SidetabState {
  return { open: false, selected: 0 };
}

export function sidetabWidthForTerminal(columns: number): number {
  return columns < 34 ? 0 : Math.min(28, Math.max(12, Math.floor(columns / 3)));
}

export function sidetabRowIndexAtTerminalRow(rowCount: number, selected: number, panelHeight: number, terminalRow: number): number | null {
  const rowCapacity = Math.max(0, Math.floor(panelHeight) - 3);
  const visibleCount = Math.min(rowCount, rowCapacity);
  const offset = terminalRow - 3;
  if (visibleCount === 0 || offset < 0 || offset >= visibleCount) return null;
  const start = rowCount <= visibleCount
    ? 0
    : Math.max(0, Math.min(selected - visibleCount + 1, rowCount - visibleCount));
  return start + offset;
}

export function applySidetabKey(state: SidetabState, key: SidetabKey, rowCount: number): SidetabState {
  if (key === 'toggle') return { ...state, open: !state.open, selected: Math.min(state.selected, Math.max(0, rowCount - 1)) };
  if (!state.open || rowCount === 0 || (key !== 'up' && key !== 'down')) return state;
  const delta = key === 'up' ? -1 : 1;
  return { ...state, selected: (state.selected + delta + rowCount) % rowCount };
}

export function sidetabRowsFromManifest(
  rows: readonly PtyManifestRow[],
  instance: string,
  runState: (row: PtyManifestRow) => { turn: string; stale: boolean | null } = describePtyRunState,
  scope?: SidetabScope,
): SidetabRow[] {
  const currentPid = scope?.currentPid ?? process.pid;
  const currentSessionId = scope?.currentSessionId;
  const eligible = rows.filter((row) => row.instance === instance && (
    (row.kind === 'tui' && Boolean(row.sessionId))
    || Boolean(row.parentPtyId)
    || row.purpose?.startsWith('next-tui-sidetab:')
    || (row.kind === 'shell'
      && currentSessionId !== undefined
      && row.parentPid === currentPid
      && row.purpose?.includes(`:session:${currentSessionId}:terminal:`))
  ));
  let scoped = eligible;
  if (scope) {
    const parent = eligible.find((row) => row.kind === 'tui'
      && (row.id === (scope.currentPtyId ?? `tui:${currentPid}`) || row.ownerPid === currentPid));
    if (!scope.all) {
      const includedIds = new Set<string>(parent ? [parent.id] : []);
      const includedPids = new Set<number>(parent ? [parent.ownerPid, parent.ptyPid, currentPid] : [currentPid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of eligible) {
          if (row.kind === 'tui' || includedIds.has(row.id)) continue;
          if ((row.parentPtyId && includedIds.has(row.parentPtyId)) || (row.parentPid > 0 && includedPids.has(row.parentPid))) {
            includedIds.add(row.id);
            if (row.ownerPid > 0) includedPids.add(row.ownerPid);
            if (row.ptyPid > 0) includedPids.add(row.ptyPid);
            changed = true;
          }
        }
      }
      scoped = eligible.filter((row) => includedIds.has(row.id));
    }
    if (!scope.all) scoped = scoped.filter((row) => row.alive);
  }
  return scoped
    .map((row) => {
      const badge: SidetabBadge = !row.alive
        ? 'exited'
        : (() => {
            const state = runState(row);
            return state.stale === true ? 'stale' : state.turn === 'busy' ? 'busy' : state.turn === 'idle' ? 'idle' : 'unknown';
          })();
      const sessionId = row.purpose?.startsWith('next-tui-sidetab:') ? row.purpose.slice('next-tui-sidetab:'.length) : undefined;
      const classicTerminalSessionId = currentSessionId !== undefined && row.kind === 'shell'
        ? row.purpose?.split(`:session:${currentSessionId}:terminal:`)[1]
        : undefined;
      return {
        id: row.id,
        label: `${'  '.repeat(Math.min(2, row.nestDepth ?? 0))}${row.nickname || row.purpose || row.cmd || row.kind}`,
        ...(row.sessionId ? { sessionId: row.sessionId } : {}),
        kind: row.kind,
        badge,
        ptyId: row.id,
        nestDepth: row.nestDepth,
        ownerPid: row.ownerPid,
        currentProcess: row.kind === 'tui' && row.ownerPid === process.pid,
        ...(sessionId ? { sessionId } : classicTerminalSessionId ? { sessionId: classicTerminalSessionId } : {}),
      };
    });
}

export function loadSidetabRows(all = false, currentSessionId?: string): SidetabRow[] {
  return sidetabRowsFromManifest(listPtyManifestRows(), resolveInstanceName(), describePtyRunState, {
    all,
    ...(currentSessionId ? { currentSessionId } : {}),
  });
}

export function formatSidetabLines(
  rows: readonly SidetabRow[],
  selected: number,
  width: number,
  height = Number.POSITIVE_INFINITY,
  mode: 'list' | 'new' = 'list',
): string[] {
  const fit = (value: string): string => {
    const segments = [...graphemes.segment(value)].map(({ segment }) => segment);
    const truncated = Bun.stringWidth(value) > width;
    const limit = truncated ? Math.max(0, width - 1) : width;
    let result = '';
    let used = 0;
    for (const segment of segments) {
      const cells = Bun.stringWidth(segment);
      if (used + cells > limit) break;
      result += segment;
      used += cells;
    }
    if (truncated && width > 0) { result += '…'; used++; }
    return result + ' '.repeat(Math.max(0, width - used));
  };
  const lines = mode === 'new'
    ? [fit(' 새 PTY'), fit(' s shell · e elanous'), fit(' c codex · l claude · Esc')]
    : [fit(' 세션 · PTY'), fit(' ↑↓ 전환 · 클릭 선택')];
  const rowCapacity = Math.max(0, Math.floor(height) - lines.length - (mode === 'list' ? 1 : 0));
  const visibleCount = Math.min(rows.length || 1, rowCapacity);
  const start = rows.length <= visibleCount
    ? 0
    : Math.max(0, Math.min(selected - visibleCount + 1, rows.length - visibleCount));
  if (mode === 'list' && rows.length === 0 && visibleCount > 0) lines.push(fit(' 항목 없음'));
  for (let offset = 0; offset < visibleCount && rows.length > 0; offset++) {
    const index = start + offset;
    const row = rows[index]!;
    const marker = index === selected ? '›' : ' ';
    lines.push(fit(` ${marker} ${row.badge} ${row.label}`));
  }
  if (mode === 'list' && lines.length < Math.floor(height)) lines.push(fit(' + new · /side new'));
  return lines;
}

/** NL/IPC side-tab contract and action policy, kept independent from either TUI renderer. */
export const NEXT_SIDETAB_TOOL_NAME = 'NextSidetab';
const NEXT_SIDETAB_CALL = 'elanous.sidetab.call';
const NEXT_SIDETAB_RESULT = 'elanous.sidetab.result';

export type NextSidetabAction = 'list' | 'switch' | 'attach' | 'detach' | 'new' | 'kill';
export interface NextSidetabRequest {
  action: NextSidetabAction;
  target?: string;
  character?: 'shell' | 'elanous';
  confirm?: boolean;
}
export interface NextSidetabCall { type: typeof NEXT_SIDETAB_CALL; callId: string; request: NextSidetabRequest }
export interface NextSidetabResult { type: typeof NEXT_SIDETAB_RESULT; callId: string; result: unknown }
export type NextSidetabHandler = (request: NextSidetabRequest) => Promise<unknown>;
export interface NextSidetabHostDeps {
  rows(): readonly SidetabRow[] | Promise<readonly SidetabRow[]>;
  selected(): number;
  switchSession(row: SidetabRow): Promise<unknown>;
  attach(row: SidetabRow): Promise<unknown>;
  detach(): unknown;
  spawn(character: 'shell' | 'elanous'): unknown;
  kill(row: SidetabRow): unknown;
}
export interface NextSidetabIpcProcess {
  send?: (message: unknown) => boolean | void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
}

export const nextSidetabToolSpec: LLMToolSpec = {
  name: NEXT_SIDETAB_TOOL_NAME,
  description: 'Control the Next TUI side tab: list/view sessions and PTYs, switch sessions, attach or detach, start a local shell or elanous PTY, or kill a PTY. Ask the user to confirm before calling kill with confirm=true. Starting coding agents is not supported.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'switch', 'attach', 'detach', 'new', 'kill'] },
      target: { type: 'string', description: 'Optional exact or partial row id/label; required for targeted actions.' },
      character: { type: 'string', enum: ['shell', 'elanous'], description: 'Only used with action=new.' },
      confirm: { type: 'boolean', description: 'Must be true only after the user explicitly confirmed killing the selected PTY.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

export function isNextSidetabCall(value: unknown): value is NextSidetabCall {
  const call = value as Partial<NextSidetabCall> | null;
  return Boolean(call && call.type === NEXT_SIDETAB_CALL && typeof call.callId === 'string'
    && call.request && typeof call.request === 'object');
}

export async function answerNextSidetabCall(handler: NextSidetabHandler, call: NextSidetabCall): Promise<NextSidetabResult> {
  try { return { type: NEXT_SIDETAB_RESULT, callId: call.callId, result: await handler(call.request) }; }
  catch (error) {
    return { type: NEXT_SIDETAB_RESULT, callId: call.callId, result: { error: error instanceof Error ? error.message : String(error) } };
  }
}

export function createNextSidetabHostHandler(deps: NextSidetabHostDeps): NextSidetabHandler {
  return async (request) => {
    if (!request || !['list', 'switch', 'attach', 'detach', 'new', 'kill'].includes(request.action)) {
      return { error: '지원하지 않는 사이드탭 동작입니다' };
    }
    if (request.action === 'new') {
      if (request.character !== 'shell' && request.character !== 'elanous') return { error: 'character는 shell 또는 elanous여야 합니다' };
      return deps.spawn(request.character);
    }
    if (request.action === 'detach') return deps.detach();
    const rows = await deps.rows();
    if (request.action === 'list') return rows.map(({ id, label, kind, badge, sessionId }) => ({ id, label, kind, badge, ...(sessionId ? { sessionId } : {}) }));
    const target = request.target?.trim();
    const exact = target ? rows.find((item) => item.id === target)
      ?? rows.find((item) => item.label.toLowerCase() === target.toLowerCase()) : undefined;
    const partial = target && !exact ? rows.filter((item) => item.label.toLowerCase().includes(target.toLowerCase())) : [];
    if (partial.length > 1) return { error: `사이드탭 항목이 여러 개 일치합니다: ${target}` };
    const row = exact ?? partial[0] ?? (target ? undefined : rows[deps.selected()]);
    if (!row) return { error: target ? `사이드탭 항목을 찾지 못했습니다: ${target}` : '선택된 사이드탭 항목이 없습니다' };
    if (request.action === 'switch') return row.kind === 'tui' ? deps.switchSession(row) : { error: 'Next TUI 세션만 전환할 수 있습니다' };
    if (request.action === 'attach') return deps.attach(row);
    if (row.currentProcess) return { error: '현재 TUI 세션은 사이드탭에서 종료할 수 없습니다' };
    if (request.confirm !== true) return { needsConfirmation: true, message: `PTY 종료 확인 필요: ${row.label}` };
    return deps.kill(row);
  };
}

export function createReplNextSidetabTool(
  proc: NextSidetabIpcProcess,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 15_000,
): { spec: LLMToolSpec; dispatch: (args: Record<string, unknown>) => Promise<unknown> } | null {
  if (env.ELANOUS_NEXT_TUI_SIDETAB_IPC !== '1' || typeof proc.send !== 'function') return null;
  const send = proc.send.bind(proc);
  const waiting = new Map<string, (result: unknown) => void>();
  let sequence = 0;
  const listener = (message: unknown): void => {
    const result = message as Partial<NextSidetabResult> | null;
    if (!result || result.type !== NEXT_SIDETAB_RESULT || typeof result.callId !== 'string') return;
    const resolve = waiting.get(result.callId);
    if (!resolve) return;
    waiting.delete(result.callId);
    resolve(result.result);
  };
  proc.on('message', listener);
  return {
    spec: nextSidetabToolSpec,
    dispatch: (args) => new Promise((resolve) => {
      const callId = `s${++sequence}`;
      const timer = setTimeout(() => {
        if (!waiting.delete(callId)) return;
        resolve({ error: 'Next TUI did not answer the side-tab request' });
      }, timeoutMs);
      waiting.set(callId, (result) => { clearTimeout(timer); resolve(result); });
      try {
        send({ type: NEXT_SIDETAB_CALL, callId, request: args as unknown as NextSidetabRequest } satisfies NextSidetabCall);
      } catch (error) {
        waiting.delete(callId);
        clearTimeout(timer);
        resolve({ error: `Next TUI IPC send failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }),
  };
}

export function registerNextSidetabReplTool(
  specs: LLMToolSpec[],
  dispatchByName: Map<string, (args: Record<string, unknown>) => Promise<unknown>>,
  proc: NextSidetabIpcProcess,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const tool = createReplNextSidetabTool(proc, env);
  if (!tool) return;
  specs.push(tool.spec);
  dispatchByName.set(tool.spec.name, tool.dispatch);
}
