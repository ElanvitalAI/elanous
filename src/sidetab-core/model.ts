import { resolveInstanceName } from '../instance-identity.js';
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
