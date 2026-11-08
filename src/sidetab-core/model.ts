import type { LLMToolSpec } from '../llm/tool-spec.js';
import { resolveInstanceName } from '../instance-identity.js';
import type { HarnessSpaceKind } from '../harness/harness-space.js';

import { listPtyManifestRows, type PtyManifestRow } from '../pty-shell/pty-manifest.js';
import { describePtyRunState } from '../pty-shell/tui-run-state.js';
import { ptyWriteControlState } from '../pty-shell/pty-write-provenance.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export type SidetabBadge = 'busy' | 'idle' | 'stale' | 'unknown' | 'exited';

export interface SidetabControlInput {
  readonly accessMode: 'read' | 'write' | 'auto';
  readonly lastWriter: 'agent' | 'human' | null;
  readonly activeMission: string | null;
}

export interface SidetabControlState {
  readonly actor: 'agent' | 'human' | 'waiting';
  readonly badge: '🤖' | '👤' | '⏸';
  readonly label: string;
  readonly title: string;
  readonly emphasized: boolean;
}

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
  readonly controlState?: SidetabControlState;
  readonly runId?: string;
  readonly spaceId?: string;
  readonly spaceKind?: HarnessSpaceKind | '';
  readonly virtual?: boolean;
  readonly attention?: boolean;
  readonly status?: string;
  readonly seat?: string;
  readonly host?: string;
  readonly remoteHost?: string;
  readonly lastActivityAt?: number;
  readonly cardId?: string;
  readonly version?: string;
}

export interface SidetabState {
  readonly open: boolean;
  readonly selected: number;
}

export interface SidetabScope {
  /** `all` is retained for existing callers; `mode` is the three-scope contract. */
  readonly mode?: 'mine' | 'runs' | 'all' | 'workspaces';
  readonly all?: boolean;
  readonly currentPtyId?: string;
  readonly currentPid?: number;
  /** Current classic chat session; classic shell rows carry it in their purpose tag. */
  readonly currentSessionId?: string;
  readonly controlByPtyId?: Readonly<Record<string, SidetabControlInput>>;
  readonly filters?: readonly string[];
  readonly crossInstanceParent?: readonly string[];
  readonly expandedRunIds?: readonly string[];
  readonly expandedWorkspaceIds?: readonly string[];
  readonly podRows?: readonly SidetabPodRow[];
  readonly harnessRuns?: readonly SidetabHarnessRun[];
  readonly maxTabs?: number;
}

export interface SidetabHarnessRun {
  readonly runId: string;
  readonly spaceId?: string;
  readonly spaceKind?: HarnessSpaceKind | '';
  readonly label?: string;
  readonly instance?: string;
  readonly parentPtyId?: string;
  readonly status?: string;
  readonly attention?: boolean;
  readonly seat?: string;
  readonly host?: string;
  readonly cardId?: string;
  readonly version?: string;
}

export interface SidetabPodRow {
  readonly id: string;
  readonly runId: string;
  readonly label: string;
  readonly status?: string;
  readonly seat?: string;
  readonly host?: string;
  readonly cardId?: string;
  readonly version?: string;
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

function sidetabControlState(input: SidetabControlInput): SidetabControlState {
  const actor = input.lastWriter === 'human'
    ? 'human'
    : input.lastWriter === 'agent' && input.accessMode === 'auto'
      ? 'agent'
      : 'waiting';
  if (actor === 'agent') {
    return {
      actor,
      badge: '🤖',
      label: '🤖 엘라누스 조작 중',
      title: input.activeMission ? '🤖 엘라누스가 미션 진행 중 · 입력하면 넘겨받기' : '🤖 엘라누스 조작 중 · 입력하면 넘겨받기',
      emphasized: true,
    };
  }
  return actor === 'human'
    ? { actor, badge: '👤', label: '사람', title: '', emphasized: false }
    : { actor, badge: '⏸', label: '대기', title: '', emphasized: false };
}

export function sidetabRowsFromManifest(
  rows: readonly PtyManifestRow[],
  instance: string,
  runState: (row: PtyManifestRow) => { turn: string; stale: boolean | null } = describePtyRunState,
  scope?: SidetabScope,
): SidetabRow[] {
  const mode = scope?.mode ?? (scope?.all ? 'all' : 'mine');
  const currentPid = scope?.currentPid ?? process.pid;
  const currentSessionId = scope?.currentSessionId;
  const eligible = rows.filter((row) => (row.instance === instance || scope?.crossInstanceParent?.includes(row.id)) && (
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
    if (mode === 'mine') {
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
    if (mode === 'mine') scoped = scoped.filter((row) => row.alive);
  }
  const basicRows = scoped
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
        ...(scope?.controlByPtyId?.[row.id]
          ? { controlState: sidetabControlState(scope.controlByPtyId[row.id]!) }
          : {}),
        ...(sessionId ? { sessionId } : classicTerminalSessionId ? { sessionId: classicTerminalSessionId } : {}),
        ...(row.runId ? { runId: row.runId } : {}),
        ...(row.spaceId ? { spaceId: row.spaceId } : {}),
        ...(row.spaceKind ? { spaceKind: row.spaceKind } : {}),
      };
    });
  if (!scope) return basicRows;

  // The pre-scope loader exposed manifest PTYs as selectable rows, even
  // when they carried a runId. Keep that contract for existing callers:
  // run grouping, filtering, expansion and tab caps are opt-in scope UI.
  // In particular, do not synthesize run: ids or more:tabs rows in the
  // classic all/mine list, whose actions target manifest PTY ids.
  const scopedRunView = scope.mode !== undefined
    || scope.harnessRuns !== undefined
    || scope.podRows !== undefined
    || scope.filters !== undefined
    || scope.expandedRunIds !== undefined
    || scope.expandedWorkspaceIds !== undefined
    || scope.maxTabs !== undefined;
  if (!scopedRunView) return basicRows;

  const runMeta = new Map((scope.harnessRuns ?? []).map((run) => [run.runId, run]));
  const visibleRunIds = new Set(basicRows.flatMap((row) => row.runId ? [row.runId] : []));
  for (const run of scope.harnessRuns ?? []) {
    if (mode === 'all' || mode === 'runs' || (run.parentPtyId && basicRows.some((row) => row.id === run.parentPtyId))) visibleRunIds.add(run.runId);
  }
  const runs: SidetabRow[] = [...visibleRunIds].map((runId) => {
    const members = basicRows.filter((row) => row.runId === runId);
    const meta = runMeta.get(runId);
    const pods = (scope.podRows ?? []).filter((row) => row.runId === runId);
    const status = meta?.status ?? (members.some((row) => row.badge === 'stale') ? 'stuck' : members.some((row) => row.badge === 'busy') ? 'running' : 'idle');
    const attention = meta?.attention ?? /^(asking|hitl|stuck|failed|error|blocked)$/i.test(status);
    return {
      id: `run:${runId}`, runId, label: meta?.label ?? runId, kind: 'harness-run', badge: status === 'failed' || status === 'error' ? 'stale' : members[0]?.badge ?? 'unknown',
      attention, status, ...(meta?.seat ? { seat: meta.seat } : {}), ...(meta?.host ? { host: meta.host } : {}),
      ...(meta?.cardId ? { cardId: meta.cardId } : {}), ...(meta?.version ? { version: meta.version } : {}),
      nestDepth: 0,
      ...(pods.length ? { sessionId: `${members.length} child · ${pods.length} pod` } : members.length ? { sessionId: `${members.length} child` } : {}),
    };
  });
  const filters = scope.filters ?? [];
  const filterRows = (items: readonly SidetabRow[]): SidetabRow[] => items.filter((row) => filters.every((raw) => {
    const colon = raw.indexOf(':');
    if (colon < 0) return true;
    const key = raw.slice(0, colon); const values = raw.slice(colon + 1).split('|').map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (values.length === 0) return true;
    if (key === 'status') return values.some((value) => row.status?.toLowerCase() === value || row.badge === value);
    if (key === 'label' || key === 'name') return values.some((value) => row.label.toLowerCase().includes(value));
    if (key === 'id') return values.some((value) => row.id.toLowerCase().includes(value));
    if (key === 'seat') return values.includes(row.seat?.toLowerCase() ?? '');
    if (key === 'host') return values.includes(row.host?.toLowerCase() ?? '');
    if (key === 'card') return values.includes(row.cardId?.toLowerCase() ?? '');
    if (key === 'version') return values.includes(row.version?.toLowerCase() ?? '');
    return true;
  }));
  let output: SidetabRow[];
  let workspaceMembersForExpansion = new Map<string, SidetabRow[]>();
  if (mode === 'workspaces') {
    const workspaceMembers = new Map<string, { members: SidetabRow[]; spaceKinds: Set<HarnessSpaceKind>; attention: boolean }>();
    const addWorkspaceMember = (spaceId: string, member?: SidetabRow, spaceKind?: HarnessSpaceKind | '') => {
      const workspace = workspaceMembers.get(spaceId) ?? { members: [], spaceKinds: new Set<HarnessSpaceKind>(), attention: false };
      if (member) workspace.members.push(member);
      if (spaceKind) workspace.spaceKinds.add(spaceKind);
      workspaceMembers.set(spaceId, workspace);
    };
    for (const row of basicRows) {
      if (row.spaceId) addWorkspaceMember(row.spaceId, row, row.spaceKind);
    }
    for (const run of scope.harnessRuns ?? []) {
      if (run.spaceId) {
        addWorkspaceMember(run.spaceId, undefined, run.spaceKind);
        if (run.attention) workspaceMembers.get(run.spaceId)!.attention = true;
      }
    }
    workspaceMembersForExpansion = new Map([...workspaceMembers].map(([spaceId, workspace]) => [
      spaceId,
      filterRows(workspace.members),
    ]));
    const workspaceRows: SidetabRow[] = [...workspaceMembers].map(([spaceId, workspace]) => {
      const spaceKind = workspace.spaceKinds.size === 1 ? [...workspace.spaceKinds][0] : undefined;
      const label = spaceKind === 'solve-mission' ? '미션' : spaceKind ? '하니스 런' : '워크스페이스';
      const matchingMembers = workspaceMembersForExpansion.get(spaceId) ?? [];
      const attention = workspace.attention || workspace.members.some((row) => row.attention || row.badge === 'stale');
      const badge: SidetabRow['badge'] = attention ? 'stale' : workspace.members.some((row) => row.badge === 'busy') ? 'busy' : 'unknown';
      return {
        id: `workspace:${spaceId}`, spaceId,
        label: `${label} · ${spaceId}`,
        kind: 'workspace', badge,
        ...(attention ? { attention: true } : {}),
        status: label === '미션' ? 'mission-workspace' : label === '하니스 런' ? 'harness-workspace' : 'workspace-unclassified',
        sessionId: `${workspace.members.length} 항목`, nestDepth: 0,
      };
    }).filter((row) => (workspaceMembersForExpansion.get(row.spaceId!)?.length ?? 0) > 0
      || filterRows([row]).length > 0);
    output = workspaceRows.sort((a, b) => a.label.localeCompare(b.label));
  } else if (mode === 'runs' || mode === 'all') {
    const orderedRuns = runs.sort((a, b) => Number(Boolean(b.attention)) - Number(Boolean(a.attention)) || a.label.localeCompare(b.label));
    output = mode === 'runs' ? orderedRuns : [...orderedRuns, ...basicRows.filter((row) => !row.runId)];
  } else {
    const runIds = new Set(runs.map((row) => row.runId!));
    const outsideAttention = (scope.harnessRuns ?? []).filter((run) => run.attention && !runIds.has(run.runId));
    output = [
      ...(outsideAttention.length ? [{
        id: 'attention:outside-runs', label: `${outsideAttention.length} 함대 주의 런`, kind: 'attention-badge', badge: 'stale' as const,
        attention: true, status: 'attention',
      }] : []),
      ...basicRows.filter((row) => !row.runId || !runIds.has(row.runId)),
      ...runs,
    ];
  }
  if (mode !== 'workspaces') output = filterRows(output);
  const expanded = new Set(scope.expandedRunIds ?? []);
  const expandedWorkspaces = new Set(scope.expandedWorkspaceIds ?? []);
  const expandedRows: SidetabRow[] = [];
  for (const row of output) {
    expandedRows.push(row);
    if (row.kind === 'workspace' && (scope.expandedWorkspaceIds === undefined || expandedWorkspaces.has(row.id))) {
      const spaceId = row.id.slice('workspace:'.length);
      expandedRows.push(...(workspaceMembersForExpansion.get(spaceId) ?? basicRows.filter((child) => child.spaceId === spaceId))
        .map((child) => ({ ...child, nestDepth: 1 })));
      continue;
    }
    if (row.kind !== 'harness-run' || !expanded.has(row.runId!)) continue;
    expandedRows.push(...filterRows(basicRows.filter((child) => child.runId === row.runId)).map((child) => ({ ...child, nestDepth: 1 })));
    expandedRows.push(...filterRows((scope.podRows ?? []).filter((pod) => pod.runId === row.runId).map((pod) => ({
      id: `pod:${pod.id}`, runId: pod.runId, label: pod.label, kind: 'pod', badge: 'unknown' as const, virtual: true, nestDepth: 1,
      ...(pod.status ? { status: pod.status } : {}), ...(pod.seat ? { seat: pod.seat } : {}), ...(pod.host ? { host: pod.host } : {}),
      ...(pod.cardId ? { cardId: pod.cardId } : {}), ...(pod.version ? { version: pod.version } : {}),
    }))));
  }
  const maxTabs = Math.max(1, scope.maxTabs ?? 8);
  if (mode !== 'workspaces' && expandedRows.length > maxTabs) {
    const visible = expandedRows.slice(0, Math.max(0, maxTabs - 1));
    visible.push({ id: 'more:tabs', label: `+${expandedRows.length - visible.length} 더`, kind: 'overflow', badge: 'unknown' });
    return visible;
  }
  return expandedRows;
}

export function loadSidetabRows(all = false, currentSessionId?: string, scopeOverrides?: Partial<SidetabScope>): SidetabRow[] {
  const manifestRows = listPtyManifestRows();
  const controlByPtyId = Object.fromEntries(manifestRows.flatMap((row) => {
    const control = ptyWriteControlState(row.id);
    if (!control) return [];
    // Purpose/nickname/kind identify a PTY, not its active task. Keep the
    // control indicator honest until a mission source is wired into this
    // loader; sidetabControlState will then show the generic control label.
    return [[row.id, { ...control, activeMission: null }]];
  }));
  return sidetabRowsFromManifest(manifestRows, resolveInstanceName(), describePtyRunState, {
    all,
    controlByPtyId,
    ...(currentSessionId ? { currentSessionId } : {}),
    ...scopeOverrides,
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
  const selectedControl = mode === 'list' ? rows[selected]?.controlState : undefined;
  const titleLine = fit(selectedControl?.title || (rows.some((row) => row.kind === 'workspace') ? ' 워크스페이스 · PTY' : ' 세션 · PTY'));
  const emphasizedTitle = selectedControl?.emphasized ? `\u001b[1;36m${titleLine}\u001b[0m` : titleLine;
  const lines = mode === 'new'
    ? [fit(' 새 PTY'), fit(' s shell · e elanous'), fit(' c codex · l claude · Esc')]
    : [emphasizedTitle, fit(' ↑↓ 전환 · 클릭 선택')];
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
    const controlBadge = row.controlState ? `${row.controlState.badge} ` : '';
    // `unknown` contributes no actionable state and made the pre-existing
    // classic PTY label truncate after adding the control badge. Keep the
    // known control actor and the complete selectable label visible.
    const runBadge = row.controlState && row.badge === 'unknown' ? '' : `${row.badge} `;
    const attentionBadge = row.attention ? '⚠ ' : '';
    const rowLine = fit(` ${marker} ${attentionBadge}${controlBadge}${runBadge}${row.label}`);
    lines.push(row.controlState?.emphasized && index === selected ? `\u001b[1;36m${rowLine}\u001b[0m` : rowLine);
  }
  if (mode === 'list' && lines.length < Math.floor(height)) lines.push(fit(' + new · /side new'));
  return lines;
}

/** NL/IPC side-tab contract and action policy, kept independent from either TUI renderer. */
export const NEXT_SIDETAB_TOOL_NAME = 'NextSidetab';
const NEXT_SIDETAB_CALL = 'elanous.sidetab.call';
const NEXT_SIDETAB_RESULT = 'elanous.sidetab.result';

export type NextSidetabAction = 'list' | 'switch' | 'attach' | 'detach' | 'new' | 'mission' | 'kill';
export interface NextSidetabRequest {
  action: NextSidetabAction;
  target?: string;
  character?: 'shell' | 'elanous';
  mission?: string;
  parallelMission?: string;
  agent?: 'codex' | 'claude' | 'grok';
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
  runMission?(agent: 'codex' | 'claude' | 'grok', mission: string): Promise<unknown>;
  runMissionPair?(agent: 'codex' | 'claude', mission: string, parallelMission: string): Promise<unknown>;
  kill(row: SidetabRow): unknown;
}
export interface NextSidetabIpcProcess {
  send?: (message: unknown) => boolean | void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
}

export const nextSidetabToolSpec: LLMToolSpec = {
  name: NEXT_SIDETAB_TOOL_NAME,
  description: 'Control the Next TUI side tab: list/view sessions and PTYs, switch sessions, attach or detach, start a local shell or elanous PTY, run one visible Codex, Claude, or Grok mission, or split one task into complementary graph branches that launch both visible agents concurrently. For a parallelMission, return both verified result files through the existing Codex + Claude pair-synthesis pipeline, with one comparison/adoption artifact and attribution table; do not create a second synthesis. Ask the user to confirm before calling kill with confirm=true.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'switch', 'attach', 'detach', 'new', 'mission', 'kill'] },
      target: { type: 'string', description: 'Optional exact or partial row id/label; required for targeted actions.' },
      character: { type: 'string', enum: ['shell', 'elanous'], description: 'Only used with action=new.' },
      mission: { type: 'string', description: 'Mission text to type visibly into a new Codex, Claude, or Grok side-tab PTY; the tool appends a result-file path and checks the completion marker.' },
      parallelMission: { type: 'string', description: 'Optional second mission. Starts the other agent concurrently and returns both verified result files together for synthesis.' },
      agent: { type: 'string', enum: ['codex', 'claude', 'grok'], description: 'Coding agent for action=mission; defaults to codex.' },
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
    if (!request || !['list', 'switch', 'attach', 'detach', 'new', 'mission', 'kill'].includes(request.action)) {
      return { error: '지원하지 않는 사이드탭 동작입니다' };
    }
    if (request.action === 'new') {
      if (request.character !== 'shell' && request.character !== 'elanous') return { error: 'character는 shell 또는 elanous여야 합니다' };
      return deps.spawn(request.character);
    }
    if (request.action === 'mission') {
      const mission = request.mission?.trim();
      if (!mission) return { error: 'mission 텍스트가 필요합니다' };
      if (!deps.runMission && !deps.runMissionPair) return { error: '사이드탭 미션 실행기가 연결되지 않았습니다' };
      if (request.agent !== undefined && request.agent !== 'codex' && request.agent !== 'claude' && request.agent !== 'grok') return { error: 'agent는 codex, claude 또는 grok이어야 합니다' };
      const parallelMission = request.parallelMission?.trim();
      if (request.parallelMission !== undefined && !parallelMission) return { error: 'parallelMission 텍스트가 비었습니다' };
      if (parallelMission) {
        if (request.agent === 'grok') return { error: 'parallelMission은 Codex/Claude pair에서만 지원합니다' };
        if (!deps.runMissionPair) return { error: 'Codex/Claude pair 실행기가 연결되지 않았습니다' };
        return deps.runMissionPair(request.agent ?? 'codex', mission, parallelMission);
      }
      if (!deps.runMission) return { error: '단일 사이드탭 미션 실행기가 연결되지 않았습니다' };
      return deps.runMission(request.agent ?? 'codex', mission);
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
  missionTimeoutMs = 420_000,
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
      const callTimeoutMs = args.action === 'mission' ? missionTimeoutMs : timeoutMs;
      const timer = setTimeout(() => {
        if (!waiting.delete(callId)) return;
        resolve({ error: 'Next TUI did not answer the side-tab request' });
      }, callTimeoutMs);
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
