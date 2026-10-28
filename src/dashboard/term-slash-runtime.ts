import { resolve } from 'node:path';

/** The workdir is the source of truth for a seat shell; env is only a fallback. */
export function resolveTuiShellSeat(cwd: string, coordId?: string): string {
  const parts = resolve(cwd).split(/[\\/]/);
  const seatIndex = parts.lastIndexOf('seats');
  const fromPath = seatIndex >= 0 ? parts[seatIndex + 1] : undefined;
  const valid = (value: string | undefined): value is string =>
    value !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(value);
  if (valid(fromPath)) return fromPath;
  const fromEnv = coordId?.trim();
  return valid(fromEnv) ? fromEnv : 'unknown';
}

export interface DashboardPersistedSessionEntry {
  id: string;
  title: string;
  command?: string | null;
  kind: string;
}

export interface DashboardTerminalListEntry {
  idSuffix: string;
  title: string;
  chip: string;
  agentBrand: string | null;
  attentionLevel: number;
  attentionLabel: string;
}

export interface DashboardShellHandleListEntry {
  idSuffix: string;
  chip: string;
  mode: string;
  label: string | null;
}

export interface DashboardTermSlashRuntimeDeps {
  accent: (text: string) => string;
  muted: (text: string) => string;
  warning: (text: string) => string;
  error: (text: string) => string;
  text: (text: string) => string;
}

export interface DashboardTermSlashRuntime {
  helpLines(): string[];
  experimentalHelpLines(): string[];
  terminalSessionsEmptyLine(): string;
  terminalSessionLine(entry: DashboardTerminalListEntry): string;
  shellRunnerSectionDividerLine(): string;
  shellRunnerFooterLine(): string;
  shellHandleLine(entry: DashboardShellHandleListEntry): string;
  detachEmptyLine(): string;
  detachedLine(title: string): string;
  attachUsageLine(): string;
  attachMissingLine(target: string): string;
  killEmptyLine(): string;
  killedLine(title: string): string;
  snapshotUsageLine(): string;
  snapshotUnknownIdLine(target: string): string;
  snapshotHeaderLine(id: string, state: string, title: string, mode: 'snapshot' | 'tail'): string;
  moveUsageLine(): string;
  moveMissingLine(target: string): string;
  moveMissingWindowTargetLine(): string;
  moveUnknownPlacementLine(destRaw: string): string;
  movedLine(terminalId: string, destLabel: string): string;
  moveFailedLine(message: string): string;
  matrixEmptyLine(): string;
  noPersistedSessionsLine(): string;
  resumeHelpLines(
    persisted: readonly DashboardPersistedSessionEntry[],
    options?: { maxItems?: number },
  ): string[];
  persistedSessionMissingLine(target: string): string;
  recharacterUsageLine(): string;
  terminalMissingLine(target: string): string;
  unknownCharacterLine(target: string): string;
  recharacterResultLine(terminalId: string, kind: string, reexeced: boolean): string;
  unknownSubcommandLine(sub: string): string;
  fullscreenMissingLine(): string;
  readonlyUsageLine(): string;
  readonlyResultLine(terminalId: string, next: boolean): string;
  vwBarMissingLine(target: string): string;
  vwBarResultLine(windowId: number, next: boolean): string;
  vwSyncUsageLine(): string;
  vwSyncResultLine(group: string, delivered: number, skipped: number, errored: number): string;
  channelTailResultLine(subId: number, channel: string, terminalId: string, replay: boolean): string;
  unknownChannelOpLine(op: string): string;
  pipeUsageLine(): string;
  pipeResultLine(pipeId: number, terminalId: string, channel: string, lineMode: boolean): string;
  pipeFailedLine(message: string): string;
  unpipeUsageLine(): string;
  activePipeMissingLine(pipeId: number): string;
  unpipeResultLine(pipeId: number, terminalId: string, channel: string): string;
  pipesEmptyLine(): string;
  groupUsageLine(op: 'join' | 'leave'): string;
  groupsEmptyLine(): string;
  groupHeaderLine(group: string, memberCount: number): string;
  groupMemberLine(id: string, title: string, readOnly: boolean): string;
  groupResultLine(terminalId: string, op: 'join' | 'leave', group: string): string;
  groupSendUsageLine(): string;
  groupSendResultLine(group: string, delivered: number, skipped: number, errored: number): string;
  unknownGroupOpLine(op: string): string;
  channelEmptyLine(): string;
  channelHeaderLine(): string;
  channelListLine(channel: string, subscriberCount: number, publishedCount: number, last: string): string;
  channelPubUsageLine(): string;
  channelPubResultLine(channel: string, subscribers: number): string;
  channelSnapshotUsageLine(): string;
  channelSnapshotEmptyLine(channel: string): string;
  channelSnapshotHeaderLine(channel: string, count: number): string;
  channelSnapshotEntryLine(from: string, preview: string): string;
  channelTailUsageLine(): string;
  pipesHeaderLine(): string;
  pipesEntryLine(id: number, terminalId: string, channel: string, lineMode: boolean): string;
}

export function createDashboardTermSlashRuntime(
  deps: DashboardTermSlashRuntimeDeps,
): DashboardTermSlashRuntime {
  return {
    helpLines: () => [
      '',
      deps.accent('\u276f /term'),
      deps.muted('Formal commands:'),
      deps.muted('  /term new [command]       Open a shell PTY (Ctrl+Shift+T or Alt+T).'),
      deps.muted('  /term list                List all alive sessions (fg / bg / exited).'),
      deps.muted('  /term attach <id>         Bring a backgrounded session to foreground.'),
      deps.muted('  /term detach              Send foreground session to background (PTY survives).'),
      deps.muted('  Ctrl+B (while streaming)  Background running child tasks; turn continues.'),
      deps.muted('  Ctrl+X c (chat input)     Enter control mode.'),
      deps.muted('  /term switch              Open the session picker modal.'),
      deps.muted('  /term kill <id>           Stop the PTY and remove the session.'),
      deps.muted('  /term snapshot <id> [tail [bytes]]   Capture current grid (snapshot) or last N bytes (tail).'),
      deps.muted('  /term resume <id>          Re-spawn a saved terminal session.'),
      deps.muted('  /term help experimental   Show experimental commands.'),
      deps.muted(''),
      deps.muted('Shell-runner handles (RunShell) — separate registry:'),
      deps.muted('  /shell list|kill|attach                See /shell help.'),
    ],
    experimentalHelpLines: () => [
      '',
      deps.accent('\u276f /term help experimental'),
      deps.muted('Experimental commands — behavior may change:'),
      deps.muted('  /term matrix              Show matrix-wide view.'),
      deps.muted('  /term move <id> bg|modal|preview   Move terminal between placements.'),
      deps.muted('  /term group list|join|leave|send    Coordinate terminal groups.'),
      deps.muted('  /term channel list|pub|tail|snapshot Manage terminal channels.'),
      deps.muted('  /term pipe|unpipe|pipes             Pipe terminal output to channels.'),
      deps.muted('  /term readonly <id> [on|off]        Toggle read-only.'),
      deps.muted('  /term recharacter <id> <character>  Change terminal character.'),
    ],
    terminalSessionsEmptyLine: () => deps.muted('  No terminal sessions.'),
    terminalSessionLine: (entry) => {
      const brand = entry.agentBrand ? ` [${entry.agentBrand}]` : '';
      const attn = entry.attentionLevel > 0 ? entry.attentionLabel : '';
      return `  ${entry.chip} ${entry.idSuffix} ${entry.title}${brand}${attn}`;
    },
    shellRunnerSectionDividerLine: () => deps.muted('  --- 🐚 shell-runner ---'),
    shellRunnerFooterLine: () => deps.muted('  (shell-runner handles managed via /shell list|kill|attach)'),
    shellHandleLine: (entry) => {
      const labelPart = entry.label ? ` ${entry.label}` : '';
      return `  ${entry.chip} ${entry.idSuffix} mode=${entry.mode}${labelPart}`;
    },
    detachEmptyLine: () => deps.muted('  No foreground session to detach.'),
    detachedLine: (title) => deps.text(`  Detached: ${title} (PTY still alive)`),
    attachUsageLine: () => deps.warning('  /term attach requires a session id (try /term list)'),
    attachMissingLine: (target) => deps.warning(`  No session matched "${target}".`),
    killEmptyLine: () => deps.muted('  No session to kill.'),
    killedLine: (title) => deps.text(`  Killed: ${title}`),
    snapshotUsageLine: () => deps.warning('  Usage: /term snapshot <id> [tail [bytes]]'),
    snapshotUnknownIdLine: (target) => deps.warning(`  No session matched "${target}" (try /term list).`),
    snapshotHeaderLine: (id, state, title, mode) => deps.muted(
      `  /term snapshot id=${id} state=${state} title="${title}" mode=${mode}`,
    ),
    moveUsageLine: () => deps.warning('  Usage: /term move <id> bg|background|modal|preview|vw'),
    moveMissingLine: (target) => deps.warning(`  No terminal matched "${target}" (try /term matrix).`),
    moveMissingWindowTargetLine: () => (
      deps.warning('  /term move ... vw requires a foreground virtual window target.')
    ),
    moveUnknownPlacementLine: (destRaw) => (
      deps.warning(`  Unknown placement "${destRaw}". Try bg | modal | preview | vw.`)
    ),
    movedLine: (terminalId, destLabel) => deps.text(`  Moved ${terminalId} → ${destLabel}`),
    moveFailedLine: (message) => deps.error(`  move failed: ${message}`),
    matrixEmptyLine: () => deps.muted('  (no terminals — RunShell auto-routes to runner VW pane)'),
    noPersistedSessionsLine: () => deps.muted('  No persisted sessions. Spawn some first.'),
    resumeHelpLines: (persisted, options) => {
      const maxItems = options?.maxItems ?? 20;
      const lines = [
        '',
        deps.accent('\u276f /term resume'),
        deps.muted('Usage: /term resume <id-suffix>   (re-spawn from persisted metadata)'),
        deps.muted('Persisted sessions:'),
      ];
      for (const entry of persisted.slice(0, maxItems)) {
        lines.push(`  ${entry.id.slice(-8)}  ${entry.title}  ${entry.command ?? ''}  (${entry.kind})`);
      }
      if (persisted.length > maxItems) {
        lines.push(deps.muted(`  … +${persisted.length - maxItems} more`));
      }
      return lines;
    },
    persistedSessionMissingLine: (target) => deps.warning(`  No persisted session matched "${target}".`),
    recharacterUsageLine: () => (
      deps.warning('  Usage: /term recharacter <id> shell|claude|codex|custom:<name>')
    ),
    terminalMissingLine: (target) => deps.warning(`  No terminal matched "${target}".`),
    unknownCharacterLine: (target) => deps.warning(`  Unknown character "${target}".`),
    recharacterResultLine: (terminalId, kind, reexeced) => (
      deps.text(`  ${terminalId} → character=${kind}${reexeced ? ' (reexeced)' : ''}`)
    ),
    unknownSubcommandLine: (sub) => deps.warning(`  Unknown /term subcommand: ${sub}. Try /term help.`),
    fullscreenMissingLine: () => deps.muted('  No terminal modal is open. Use RunShell or /term attach <id> first.'),
    readonlyUsageLine: () => (
      deps.warning('  Usage: /term readonly <id> [on|off]  (no state = toggle)')
    ),
    readonlyResultLine: (terminalId, next) => (
      deps.text(`  ${terminalId} readonly → ${next ? 'on' : 'off'}`)
    ),
    vwBarMissingLine: (target) => deps.warning(`  No window ${target}.`),
    vwBarResultLine: (windowId, next) => (
      deps.muted(`  vw:${windowId} sync-input bar: ${next ? 'on' : 'off'}`)
    ),
    vwSyncUsageLine: () => deps.warning('  Usage: /term vw-sync <windowId> <text...>'),
    vwSyncResultLine: (group, delivered, skipped, errored) => (
      deps.text(`  vw-sync ${group}: delivered=${delivered} skipped=${skipped} errored=${errored}`)
    ),
    channelTailResultLine: (subId, channel, terminalId, replay) => (
      deps.text(`  tail sub#${subId}: ${channel} → ${terminalId} (PTY stdin)${replay ? ' [replayed backlog]' : ''}`)
    ),
    unknownChannelOpLine: (op) => deps.warning(`  Unknown /term channel op: ${op}. Try list|pub|tail.`),
    pipeUsageLine: () => deps.warning('  Usage: /term pipe <id> <channel> [--line]'),
    pipeResultLine: (pipeId, terminalId, channel, lineMode) => (
      deps.text(`  pipe#${pipeId}: ${terminalId} stdout → ${channel}${lineMode ? ' (line)' : ''}`)
    ),
    pipeFailedLine: (message) => deps.error(`  pipe failed: ${message}`),
    unpipeUsageLine: () => deps.warning('  Usage: /term unpipe <pipeId>'),
    activePipeMissingLine: (pipeId) => deps.warning(`  No active pipe #${pipeId}.`),
    unpipeResultLine: (pipeId, terminalId, channel) => (
      deps.text(`  unpiped #${pipeId} (${terminalId} ↛ ${channel})`)
    ),
    pipesEmptyLine: () => deps.muted('  (no active pipes — /term pipe to start one)'),
    groupUsageLine: (op) => deps.warning(`  Usage: /term group ${op} <id> <group>`),
    groupsEmptyLine: () => deps.muted('  (no broadcast groups active)'),
    groupHeaderLine: (group, memberCount) => deps.accent(`  ${group}  (${memberCount} members)`),
    groupMemberLine: (id, title, readOnly) => {
      const ro = readOnly ? ' [ro]' : '';
      return deps.muted(`    ${id} ${title}${ro}`);
    },
    groupResultLine: (terminalId, op, group) => (
      deps.text(`  ${terminalId} ${op === 'join' ? '→ joined' : '← left'} group ${group}`)
    ),
    groupSendUsageLine: () => deps.warning('  Usage: /term group send <group> <text...>'),
    groupSendResultLine: (group, delivered, skipped, errored) => (
      deps.text(`  broadcast ${group}: delivered=${delivered} skipped=${skipped} errored=${errored}`)
    ),
    unknownGroupOpLine: (op) => deps.warning(`  Unknown /term group op: ${op}. Try list|join|leave|send.`),
    channelEmptyLine: () => deps.muted('  (no channels — /term channel pub to start)'),
    channelHeaderLine: () => deps.accent('  channel                 subs  pub  last'),
    channelListLine: (channel, subscriberCount, publishedCount, last) => (
      `  ${channel.padEnd(24)} ${String(subscriberCount).padStart(3)} ${String(publishedCount).padStart(4)} ${last}`
    ),
    channelPubUsageLine: () => deps.warning('  Usage: /term channel pub <channel> <text...>'),
    channelPubResultLine: (channel, subscribers) => deps.text(`  published ${channel} → ${subscribers} subscribers`),
    channelSnapshotUsageLine: () => deps.warning('  Usage: /term channel snapshot <channel> [N=10]'),
    channelSnapshotEmptyLine: (channel) => deps.muted(`  (channel ${channel}: empty replay buffer)`),
    channelSnapshotHeaderLine: (channel, count) => deps.accent(`  channel ${channel} — last ${count} messages:`),
    channelSnapshotEntryLine: (from, preview) => `    [${from}] ${preview}`,
    channelTailUsageLine: () => deps.warning('  Usage: /term channel tail <id> <channel>'),
    pipesHeaderLine: () => deps.accent('  pipe#  terminal      channel          mode'),
    pipesEntryLine: (id, terminalId, channel, lineMode) => (
      `  ${String(id).padStart(4)}  ${terminalId.padEnd(12)} ${channel.padEnd(16)} ${lineMode ? 'line' : 'raw'}`
    ),
  };
}
