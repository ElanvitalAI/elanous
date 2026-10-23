import type { AgentTask } from '../agent/types.js';
import { agentColor } from '../agent/color-map.js';
import { formatDuration } from '../log-entry.js';
import { C, truncate, visibleWidth } from '../tui.js';
import { colorize, type ThemeTokens } from '../theme/tokens.js';

export type AgentSurfaceStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'error'
  | 'cancelled';

export interface AgentLogEntry {
  level: 'info' | 'tool' | 'result' | 'error';
  text: string;
  at?: number;
}

export interface AgentSurfaceState {
  id: string;
  name: string;
  definitionName: string;
  status: AgentSurfaceStatus;
  elapsedMs: number;
  toolCount: number;
  summary?: string;
  error?: string;
  result?: string;
  attention?: {
    level: 'info' | 'warning' | 'error' | 'needs-input';
    message: string;
  };
  log: AgentLogEntry[];
  updatedAt: number;
  /** P5.1: correlation ID the caller stamped on the AgentTask so
   *  debug-log payloads + display events for this agent can be
   *  cross-referenced. */
  correlationId?: string;
  /** P5.1: parent's correlation ID for nested spawns. roster view
   *  uses this to draw the tree. */
  parentCorrelationId?: string;
}

export interface AgentSurfaceChange {
  id: string;
  status: AgentSurfaceStatus | 'removed';
  state?: AgentSurfaceState;
}

export interface AgentSurfaceRenderOptions {
  theme?: ThemeTokens;
  /** PFC-S2 P2: callback the caller uses to mark rows that have just
   *  completed. Signals a brief visual pulse (prefix glyph + success
   *  color on the status column) without requiring the renderer to
   *  own its own timer. Returns false for steady-state rows — the
   *  no-flash path is the fast path. */
  isFlashing?: (id: string) => boolean;
}

interface ScanCache {
  count: Map<string, { len: number; count: number }>;
  trail: Map<string, { len: number; limit: number; trail: AgentLogEntry[] }>;
}

export class AgentSurfaceStore {
  private agents = new Map<string, AgentSurfaceState>();
  private signatures = new Map<string, string>();
  private readonly cache: ScanCache = {
    count: new Map(),
    trail: new Map(),
  };

  syncTasks(tasks: readonly AgentTask[], now = Date.now()): AgentSurfaceState[] {
    const sorted = sortAgentTasks(tasks);
    const seen = new Set<string>();
    for (const task of sorted) {
      seen.add(task.id);
      this.agents.set(task.id, agentTaskToSurfaceState(task, {
        now,
        cache: this.cache,
      }));
    }
    for (const id of this.agents.keys()) {
      if (!seen.has(id)) {
        this.agents.delete(id);
        this.cache.count.delete(id);
        this.cache.trail.delete(id);
      }
    }
    return sorted.map(task => this.agents.get(task.id)!).filter(Boolean);
  }

  syncTasksWithChanges(tasks: readonly AgentTask[], now = Date.now()): {
    states: AgentSurfaceState[];
    changes: AgentSurfaceChange[];
  } {
    const previous = new Map(this.signatures);
    const states = this.syncTasks(tasks, now);
    const changes: AgentSurfaceChange[] = [];
    const seen = new Set<string>();
    for (const state of states) {
      seen.add(state.id);
      const sig = agentSurfaceSignature(state);
      if (previous.get(state.id) !== sig) {
        changes.push({ id: state.id, status: state.status, state });
      }
      this.signatures.set(state.id, sig);
    }
    for (const id of previous.keys()) {
      if (!seen.has(id)) {
        this.signatures.delete(id);
        changes.push({ id, status: 'removed' });
      }
    }
    return { states, changes };
  }

  list(): AgentSurfaceState[] {
    return [...this.agents.values()].sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
  }

  get(id: string): AgentSurfaceState | null {
    return this.agents.get(id) ?? null;
  }

  clear(): void {
    this.agents.clear();
    this.signatures.clear();
    this.cache.count.clear();
    this.cache.trail.clear();
  }
}

function agentSurfaceSignature(state: AgentSurfaceState): string {
  const lastLog = state.log.at(-1)?.text ?? '';
  return [
    state.status,
    state.toolCount,
    state.summary ?? '',
    state.error ?? '',
    state.result ?? '',
    state.log.length,
    lastLog,
  ].join('\x1f');
}

export function sortAgentTasks(tasks: readonly AgentTask[]): AgentTask[] {
  return tasks.slice().sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id));
}

export function agentTaskToSurfaceState(
  task: AgentTask,
  opts: { now?: number; cache?: ScanCache } = {},
): AgentSurfaceState {
  const now = opts.now ?? Date.now();
  const cache = opts.cache ?? { count: new Map(), trail: new Map() };
  const name = (task.label && task.label.trim())
    || task.definition.description
    || task.definition.name;
  const finishedAt = task.finishedAt ?? now;
  const startedAt = task.startedAt || now;
  const status = agentStatus(task.state);
  const toolCount = countToolUses(task, cache);
  const log = recentToolTrail(task, 8, cache);
  const attention = status === 'error'
    ? { level: 'error' as const, message: task.error ?? 'agent error' }
    : undefined;
  return {
    id: task.id,
    name,
    definitionName: task.definition.name,
    status,
    elapsedMs: Math.max(0, finishedAt - startedAt),
    toolCount,
    ...(task.result ? { result: task.result, summary: firstNonEmptyLine(task.result) } : {}),
    ...(task.error ? { error: task.error } : {}),
    ...(attention ? { attention } : {}),
    log,
    updatedAt: finishedAt,
    ...(task.correlationId ? { correlationId: task.correlationId } : {}),
    ...(task.parentCorrelationId ? { parentCorrelationId: task.parentCorrelationId } : {}),
  };
}

/** PFC-S2 P3: 8-line roster cheatsheet rendered below the agent list
 *  when the operator toggles `?`. Ordering mirrors the key-binding
 *  intent groups (navigation · filter · actions · help) rather than
 *  alphabetical — reading left-to-right matches the three most common
 *  workflows: move cursor → filter view → act on selection. The 8
 *  rows are the height ceiling; the widget skips the overlay entirely
 *  if the remaining body budget is smaller. */
export function renderRosterCheatsheet(theme?: ThemeTokens): string[] {
  const colors = agentColors(theme);
  const k = (key: string) => colors.success(key.padEnd(4));
  const d = (desc: string) => colors.muted(desc);
  return [
    colors.muted('  keys ──────────────────────────────────────────────'),
    `  ${k('j/k')} ${d('move cursor')}    ${k('s')} ${d('sort cycle')}     ${k('x')} ${d('abort running')}`,
    `  ${k('g/G')} ${d('top/bottom')}     ${k('F')} ${d('filter cycle')}   ${k('d')} ${d('detach → bg')}`,
    `  ${k('l/→')} ${d('open detail')}    ${k('/')} ${d('search')}          ${k('a')} ${d('attach bg task')}`,
    `  ${k('h/←')} ${d('back')}           ${k('?')} ${d('toggle help')}    ${k('⏎')} ${d('open detail')}`,
    '',
    colors.muted('  chords ────────────────────────────────────────────'),
    `  ${k('C-m g')} ${d('jump to Agents view')}     ${k('C-m b')} ${d('plugin mailbox (if active)')}`,
  ];
}

export function renderAgentRoster(
  states: readonly AgentSurfaceState[],
  cursor: number,
  opts: AgentSurfaceRenderOptions = {},
): string[] {
  const colors = agentColors(opts.theme);
  if (states.length === 0) {
    return [
      colors.muted('  (no sub-agents spawned yet)'),
      '',
      colors.muted('  When a skill spawns Agent() calls, they appear here.'),
      colors.muted('  Use j/k to move the cursor; the selected agent\'s'),
      colors.muted('  output is mirrored into the Preview pane.'),
    ];
  }

  const header = colors.muted('  status     agent                              elapsed   tools');
  const lines: string[] = [header, ''];

  // P5.4: build a compact tree index from parentCorrelationId.
  // When ≥ one agent has a parentCorrelationId that matches another
  // agent's correlationId, we draw a `  ├─` / `  └─` glyph next to
  // the child's name. Falls back to flat listing when no nesting is
  // present (the common case). O(N) single pass — cheap at any
  // realistic agent count.
  const cidToIdx = new Map<string, number>();
  for (let i = 0; i < states.length; i++) {
    const cid = states[i]!.correlationId;
    if (cid) cidToIdx.set(cid, i);
  }
  const childrenByParent = new Map<number, number[]>();
  for (let i = 0; i < states.length; i++) {
    const pcid = states[i]!.parentCorrelationId;
    if (!pcid) continue;
    const parentIdx = cidToIdx.get(pcid);
    if (parentIdx === undefined) continue;
    const siblings = childrenByParent.get(parentIdx) ?? [];
    siblings.push(i);
    childrenByParent.set(parentIdx, siblings);
  }

  for (let i = 0; i < states.length; i++) {
    const agent = states[i]!;
    const selected = i === cursor;
    const flashing = opts.isFlashing?.(agent.id) ?? false;
    // PFC-S2 P2: flashing row swaps the leading gutter to a bright
    // success glyph so the completion pulse is legible even when the
    // cursor is elsewhere. Selected + flashing prefers the cursor
    // glyph (selection dominates) so focus stays obvious.
    const prefix = selected
      ? colors.cursor(' \u25B8 ')
      : flashing ? colors.success(' \u2726 ') : '   ';
    const statusCol = renderStatusColumn(agent.status, colors);
    const statusPadding = '         '.slice(
      Math.min('         '.length, visibleWidth(statusCol) - 2),
    );
    // Nest glyph: find this agent's parent (if any); if present,
    // prefix with the appropriate tree glyph. Indentation is fixed
    // at 2 chars since we don't support deeper than 2 levels yet.
    const parentIdx = agent.parentCorrelationId
      ? cidToIdx.get(agent.parentCorrelationId)
      : undefined;
    let nameCol = agentColor(agent.definitionName)(agent.name);
    let nameBudget = 34;
    if (parentIdx !== undefined) {
      const siblings = childrenByParent.get(parentIdx) ?? [];
      const posInSiblings = siblings.indexOf(i);
      const isLast = posInSiblings === siblings.length - 1;
      const glyph = isLast ? '\u2514\u2500' : '\u251C\u2500';
      nameCol = `${colors.muted(glyph)} ${nameCol}`;
      nameBudget = 31; // tree glyph + space
    }
    const truncatedName = visibleWidth(nameCol) > nameBudget
      ? truncate(nameCol, nameBudget)
      : nameCol.padEnd(nameBudget + (nameCol.length - visibleWidth(nameCol)));
    const tools = agent.toolCount > 0 ? `${agent.toolCount}` : '\u00B7';
    const elapsed = formatDuration(agent.elapsedMs);
    lines.push(
      `${prefix}${statusCol}${statusPadding}${truncatedName}  `
      + `${colors.dim(elapsed.padStart(8))}   `
      + `${colors.muted(tools.padStart(5))}`,
    );
  }
  return lines;
}

/** Small LRU memo keyed on agent identity + mutation-visible state.
 *  The wd-preview mirror and the wd-agent-detail widget BOTH call
 *  renderAgentDetail() every frame for the same agent — without this
 *  cache, we rebuild the same ~5 ANSI-styled lines twice per draw
 *  (once per consumer). Cache the result by a compact signature so
 *  the second caller returns the cached string. Map keyed by agent
 *  id; entries overwritten on any state change. */
const _detailCache = new Map<string, { sig: string; rendered: string }>();
const DETAIL_CACHE_MAX = 32;

function agentDetailSignature(agent: AgentSurfaceState, opts: AgentSurfaceRenderOptions = {}): string {
  return [
    opts.theme?.name ?? '',
    agent.status,
    agent.updatedAt,
    agent.toolCount,
    agent.log.length,
    agent.summary ?? '',
    agent.error ?? '',
    (agent.result ?? '').length,
  ].join('\x1f');
}

export function renderAgentDetail(agent: AgentSurfaceState, opts: AgentSurfaceRenderOptions = {}): string {
  const sig = agentDetailSignature(agent, opts);
  const cached = _detailCache.get(agent.id);
  if (cached && cached.sig === sig) return cached.rendered;
  const colors = agentColors(opts.theme);

  const headerLine = `${C.bold(agentColor(agent.definitionName)(agent.name))} ${colors.muted(`[${agent.definitionName}]`)}`;
  const statusLine = renderDetailStatus(agent, colors);
  const separator = colors.muted('\u2500'.repeat(48));
  let body: string;
  if (agent.status === 'running') {
    if (agent.log.length > 0) {
      body = [
        colors.muted('(working — recent tool calls)'),
        '',
        ...agent.log.map(entry => entry.text),
      ].join('\n');
    } else {
      body = colors.muted('(working — no tool calls yet)');
    }
  } else if (agent.result) {
    body = agent.result;
  } else if (agent.error) {
    body = colors.error(agent.error);
  } else {
    body = colors.muted('(no output captured)');
  }
  const rendered = [headerLine, statusLine, separator, '', body].join('\n');

  // Simple LRU eviction — when the map grows past the cap, delete
  // the oldest entry (Map iteration order is insertion order in
  // JS). Keeps the cache bounded without a full LRU implementation.
  if (_detailCache.size >= DETAIL_CACHE_MAX) {
    const firstKey = _detailCache.keys().next().value;
    if (firstKey !== undefined) _detailCache.delete(firstKey);
  }
  _detailCache.set(agent.id, { sig, rendered });
  return rendered;
}

/** Test-only hook: clear the memo so each test starts from a known
 *  state. Production callers never need this. */
export function _clearAgentDetailCacheForTests(): void {
  _detailCache.clear();
}

function agentStatus(state: AgentTask['state']): AgentSurfaceStatus {
  switch (state) {
    case 'pending': return 'queued';
    case 'running': return 'running';
    case 'done': return 'done';
    case 'error': return 'error';
    case 'aborted': return 'cancelled';
  }
}

function renderStatusColumn(status: AgentSurfaceStatus, colors = agentColors()): string {
  switch (status) {
    case 'running': return `${colors.warning('\u25C7')} ${colors.warning('working')}`;
    case 'done': return `${colors.success('\u2714')} ${colors.success('done')}`;
    case 'error': return `${colors.error('\u2718')} ${colors.error('error')}`;
    case 'cancelled': return `${colors.muted('\u229B')} ${colors.muted('aborted')}`;
    case 'queued': return `${colors.muted('\u25CB')} ${colors.muted('spawned')}`;
  }
}

function renderDetailStatus(agent: AgentSurfaceState, colors = agentColors()): string {
  const elapsed = formatDuration(agent.elapsedMs);
  const tools = agent.toolCount;
  const toolText = `${tools} tool ${tools === 1 ? 'use' : 'uses'}`;
  switch (agent.status) {
    case 'running':
      return `${colors.warning('◇ working')} \u00B7 ${elapsed} \u00B7 ${toolText}`;
    case 'done':
      return `${colors.success('✔ done')}    \u00B7 ${elapsed} \u00B7 ${toolText}`;
    case 'error':
      return `${colors.error('✘ error')}   \u00B7 ${agent.error ?? 'unknown error'}`;
    case 'cancelled':
      return `${colors.muted('⊛ aborted')} \u00B7 ${elapsed}`;
    case 'queued':
      return `${colors.muted('○ spawned')} \u00B7 waiting to start`;
  }
}

function agentColors(theme?: ThemeTokens) {
  if (!theme) {
    return {
      muted: C.muted,
      dim: C.subtext,
      cursor: C.cursor,
      success: C.success,
      warning: C.warning,
      error: C.error,
    };
  }
  return {
    muted: colorize(theme.colors.muted),
    dim: colorize(theme.colors.dim),
    cursor: colorize(theme.cursor.focused, { bold: true }),
    success: colorize(theme.colors.success),
    warning: colorize(theme.colors.warning),
    error: colorize(theme.colors.error),
  };
}

function recentToolTrail(task: AgentTask, limit: number, cache: ScanCache): AgentLogEntry[] {
  const len = task.messages?.length ?? 0;
  if (len === 0) return [];
  const cached = cache.trail.get(task.id);
  if (cached && cached.len === len && cached.limit === limit) return cached.trail;

  const calls: Array<{ name: string; args: unknown }> = [];
  for (const m of task.messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const block of m.content) {
      if (block.type !== 'tool_use') continue;
      calls.push({ name: block.name, args: block.input });
    }
  }
  const trail = calls.slice(-limit).map(c => {
    let argStr: string;
    try { argStr = JSON.stringify(c.args); } catch { argStr = '(unrenderable)'; }
    const shown = argStr.length > 80 ? argStr.slice(0, 77) + '\u2026' : argStr;
    return {
      level: 'tool' as const,
      text: `  ${C.muted('⎿')} ${C.bold(c.name)}${C.subtext(` ${shown}`)}`,
    };
  });
  cache.trail.set(task.id, { len, limit, trail });
  return trail;
}

/** Tool calls the child made: the live counter (bumped as each call starts) or the
 *  tool_use blocks in its history, whichever is larger — history lags until a tool
 *  loop completes and stays short when the run is aborted or errors. */
function countToolUses(task: AgentTask, cache: ScanCache): number {
  return Math.max(task.toolCallCount ?? 0, countHistoryToolUses(task, cache));
}

function countHistoryToolUses(task: AgentTask, cache: ScanCache): number {
  const len = task.messages?.length ?? 0;
  if (len === 0) return 0;
  const cached = cache.count.get(task.id);
  if (cached && cached.len === len) return cached.count;
  let n = 0;
  for (const m of task.messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const block of m.content) {
      if (block.type === 'tool_use') n++;
    }
  }
  cache.count.set(task.id, { len, count: n });
  return n;
}

function firstNonEmptyLine(text: string): string | undefined {
  return text.split(/\r?\n/).map(s => s.trim()).find(Boolean);
}
