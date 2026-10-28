import { describe, expect, test } from 'bun:test';

import { createDashboardTermSlashRuntime, resolveTuiShellSeat } from '../src/dashboard/term-slash-runtime.js';
import { KEYBINDINGS } from '../src/keybindings.js';

test('TUI shell seat comes from the workdir, then COORD_ID, then unknown', () => {
  expect(resolveTuiShellSeat('/tmp/hq/seats/OP', 'UX')).toBe('OP');
  expect(resolveTuiShellSeat('/tmp/worktree', 'UX')).toBe('UX');
  expect(resolveTuiShellSeat('/tmp/worktree')).toBe('unknown');
});

describe('createDashboardTermSlashRuntime', () => {
  test('builds matrix and resume feedback lines', () => {
    const runtime = createDashboardTermSlashRuntime({
      accent: (text) => `accent:${text}`,
      muted: (text) => `muted:${text}`,
      warning: (text) => `warning:${text}`,
      error: (text) => `error:${text}`,
      text: (text) => `text:${text}`,
    });

    expect(runtime.helpLines()[1]).toBe('accent:❯ /term');
    const basicHelp = runtime.helpLines().join('\n');
    expect(basicHelp).toContain('Formal commands:');
    for (const command of ['/term new', '/term list', '/term attach', '/term detach', '/term switch', '/term kill', '/term resume', '/term snapshot']) {
      expect(basicHelp).toContain(command);
    }
    expect(basicHelp).toContain('/term help experimental');
    const experimentalCommands = ['/term matrix', '/term move', '/term group', '/term channel', '/term pipe', '/term readonly', '/term recharacter'];
    for (const command of [...experimentalCommands, '/term vw-bar', '/term vw-sync']) {
      expect(basicHelp).not.toContain(command);
    }
    const experimental = runtime.experimentalHelpLines().join('\n');
    expect(experimental).toContain('Experimental commands');
    for (const command of experimentalCommands) {
      expect(experimental).toContain(command);
    }
    expect(experimental).not.toContain('/term vw-bar');
    expect(experimental).not.toContain('/term vw-sync');
    expect(runtime.helpLines()).toContain('muted:  Ctrl+B (while streaming)  Background running child tasks; turn continues.');
    expect(runtime.helpLines()).toContain('muted:  Ctrl+X c (chat input)     Enter control mode.');
    for (const [key, action] of [
      ['Ctrl+B', 'Background running child tasks'],
      ['Ctrl+X c', 'Enter control mode'],
    ]) {
      expect(KEYBINDINGS.find(binding => binding.keys.includes(key))?.action).toContain(action);
      expect(runtime.helpLines().filter(line => line.includes(key + ' ('))).toHaveLength(1);
      expect(runtime.helpLines().find(line => line.includes(key + ' ('))).toContain(action);
    }
    expect(runtime.terminalSessionsEmptyLine()).toBe('muted:  No terminal sessions.');
    expect(runtime.terminalSessionLine({
      idSuffix: '1234abcd',
      title: 'Claude',
      chip: '[running]',
      agentBrand: 'codex',
      attentionLevel: 2,
      attentionLabel: ' !2',
    })).toBe('  [running] 1234abcd Claude [codex] !2');
    expect(runtime.shellRunnerSectionDividerLine()).toBe('muted:  --- 🐚 shell-runner ---');
    expect(runtime.shellRunnerFooterLine()).toBe(
      'muted:  (shell-runner handles managed via /shell list|kill|attach)',
    );
    expect(runtime.shellHandleLine({
      idSuffix: 'abcd1234',
      chip: '[done]',
      mode: 'vw',
      label: 'runner',
    })).toBe('  [done] abcd1234 mode=vw runner');
    expect(runtime.detachEmptyLine()).toBe('muted:  No foreground session to detach.');
    expect(runtime.detachedLine('Claude')).toBe('text:  Detached: Claude (PTY still alive)');
    expect(runtime.attachUsageLine()).toBe(
      'warning:  /term attach requires a session id (try /term list)',
    );
    expect(runtime.attachMissingLine('abc')).toBe('warning:  No session matched "abc".');
    expect(runtime.killEmptyLine()).toBe('muted:  No session to kill.');
    expect(runtime.killedLine('Claude')).toBe('text:  Killed: Claude');
    expect(runtime.snapshotUsageLine()).toBe(
      'warning:  Usage: /term snapshot <id> [tail [bytes]]',
    );
    expect(runtime.snapshotUnknownIdLine('abc')).toBe(
      'warning:  No session matched "abc" (try /term list).',
    );
    expect(runtime.snapshotHeaderLine('abc12345', 'running', 'Claude', 'snapshot')).toBe(
      'muted:  /term snapshot id=abc12345 state=running title="Claude" mode=snapshot',
    );
    expect(runtime.moveUsageLine()).toBe(
      'warning:  Usage: /term move <id> bg|background|modal|preview|vw',
    );
    expect(runtime.moveMissingLine('abc')).toBe(
      'warning:  No terminal matched "abc" (try /term matrix).',
    );
    expect(runtime.moveMissingWindowTargetLine()).toBe(
      'warning:  /term move ... vw requires a foreground virtual window target.',
    );
    expect(runtime.moveUnknownPlacementLine('weird')).toBe(
      'warning:  Unknown placement "weird". Try bg | modal | preview | vw.',
    );
    expect(runtime.movedLine('term:1', 'vw:7')).toBe(
      'text:  Moved term:1 → vw:7',
    );
    expect(runtime.moveFailedLine('boom')).toBe('error:  move failed: boom');

    expect(runtime.matrixEmptyLine()).toBe('muted:  (no terminals — RunShell auto-routes to runner VW pane)');
    expect(runtime.noPersistedSessionsLine()).toBe('muted:  No persisted sessions. Spawn some first.');
    expect(runtime.persistedSessionMissingLine('abc')).toBe('warning:  No persisted session matched "abc".');
    expect(runtime.recharacterUsageLine()).toBe(
      'warning:  Usage: /term recharacter <id> shell|claude|codex|custom:<name>',
    );
    expect(runtime.terminalMissingLine('abc')).toBe('warning:  No terminal matched "abc".');
    expect(runtime.unknownCharacterLine('weird')).toBe('warning:  Unknown character "weird".');
    expect(runtime.recharacterResultLine('term:1', 'codex', true)).toBe(
      'text:  term:1 → character=codex (reexeced)',
    );
    expect(runtime.unknownSubcommandLine('zzz')).toBe(
      'warning:  Unknown /term subcommand: zzz. Try /term help.',
    );
    expect(runtime.fullscreenMissingLine()).toBe(
      'muted:  No terminal modal is open. Use RunShell or /term attach <id> first.',
    );
    expect(runtime.readonlyUsageLine()).toBe(
      'warning:  Usage: /term readonly <id> [on|off]  (no state = toggle)',
    );
    expect(runtime.readonlyResultLine('term:1', true)).toBe(
      'text:  term:1 readonly → on',
    );
    expect(runtime.vwBarMissingLine('(current)')).toBe(
      'warning:  No window (current).',
    );
    expect(runtime.vwBarResultLine(7, false)).toBe(
      'muted:  vw:7 sync-input bar: off',
    );
    expect(runtime.vwSyncUsageLine()).toBe(
      'warning:  Usage: /term vw-sync <windowId> <text...>',
    );
    expect(runtime.vwSyncResultLine('_vw:7', 3, 1, 0)).toBe(
      'text:  vw-sync _vw:7: delivered=3 skipped=1 errored=0',
    );
    expect(runtime.channelTailResultLine(4, 'alerts', 'term:1', true)).toBe(
      'text:  tail sub#4: alerts → term:1 (PTY stdin) [replayed backlog]',
    );
    expect(runtime.unknownChannelOpLine('bad')).toBe(
      'warning:  Unknown /term channel op: bad. Try list|pub|tail.',
    );
    expect(runtime.pipeUsageLine()).toBe(
      'warning:  Usage: /term pipe <id> <channel> [--line]',
    );
    expect(runtime.pipeResultLine(3, 'term:1', 'alerts', true)).toBe(
      'text:  pipe#3: term:1 stdout → alerts (line)',
    );
    expect(runtime.pipeFailedLine('boom')).toBe('error:  pipe failed: boom');
    expect(runtime.unpipeUsageLine()).toBe(
      'warning:  Usage: /term unpipe <pipeId>',
    );
    expect(runtime.activePipeMissingLine(9)).toBe(
      'warning:  No active pipe #9.',
    );
    expect(runtime.unpipeResultLine(9, 'term:1', 'alerts')).toBe(
      'text:  unpiped #9 (term:1 ↛ alerts)',
    );
    expect(runtime.pipesEmptyLine()).toBe(
      'muted:  (no active pipes — /term pipe to start one)',
    );
    expect(runtime.groupUsageLine('join')).toBe(
      'warning:  Usage: /term group join <id> <group>',
    );
    expect(runtime.groupsEmptyLine()).toBe(
      'muted:  (no broadcast groups active)',
    );
    expect(runtime.groupHeaderLine('alpha', 2)).toBe(
      'accent:  alpha  (2 members)',
    );
    expect(runtime.groupMemberLine('term:1', 'Claude', true)).toBe(
      'muted:    term:1 Claude [ro]',
    );
    expect(runtime.groupResultLine('term:1', 'leave', 'alpha')).toBe(
      'text:  term:1 ← left group alpha',
    );
    expect(runtime.groupSendUsageLine()).toBe(
      'warning:  Usage: /term group send <group> <text...>',
    );
    expect(runtime.groupSendResultLine('alpha', 2, 1, 0)).toBe(
      'text:  broadcast alpha: delivered=2 skipped=1 errored=0',
    );
    expect(runtime.unknownGroupOpLine('bad')).toBe(
      'warning:  Unknown /term group op: bad. Try list|join|leave|send.',
    );
    expect(runtime.channelEmptyLine()).toBe(
      'muted:  (no channels — /term channel pub to start)',
    );
    expect(runtime.channelHeaderLine()).toBe(
      'accent:  channel                 subs  pub  last',
    );
    expect(runtime.channelListLine('alerts', 3, 12, '12:34:56')).toBe(
      '  alerts                     3   12 12:34:56',
    );
    expect(runtime.channelPubUsageLine()).toBe(
      'warning:  Usage: /term channel pub <channel> <text...>',
    );
    expect(runtime.channelPubResultLine('alerts', 4)).toBe(
      'text:  published alerts → 4 subscribers',
    );
    expect(runtime.channelSnapshotUsageLine()).toBe(
      'warning:  Usage: /term channel snapshot <channel> [N=10]',
    );
    expect(runtime.channelSnapshotEmptyLine('alerts')).toBe(
      'muted:  (channel alerts: empty replay buffer)',
    );
    expect(runtime.channelSnapshotHeaderLine('alerts', 2)).toBe(
      'accent:  channel alerts — last 2 messages:',
    );
    expect(runtime.channelSnapshotEntryLine('slash', 'hello⏎world')).toBe(
      '    [slash] hello⏎world',
    );
    expect(runtime.channelTailUsageLine()).toBe(
      'warning:  Usage: /term channel tail <id> <channel>',
    );
    expect(runtime.pipesHeaderLine()).toBe(
      'accent:  pipe#  terminal      channel          mode',
    );
    expect(runtime.pipesEntryLine(4, 'term:1', 'alerts', true)).toBe(
      '     4  term:1       alerts           line',
    );

    const help = runtime.resumeHelpLines([
      { id: 'session-12345678', title: 'alpha', command: 'claude', kind: 'claude' },
      { id: 'session-87654321', title: 'beta', command: null, kind: 'shell' },
    ]);
    expect(help[1]).toBe('accent:❯ /term resume');
    expect(help.some((line) => line.includes('Persisted sessions:'))).toBe(true);
    expect(help.some((line) => line.includes('12345678  alpha  claude  (claude)'))).toBe(true);
  });

  test('adds overflow line when persisted sessions exceed the limit', () => {
    const runtime = createDashboardTermSlashRuntime({
      accent: (text) => text,
      muted: (text) => `muted:${text}`,
      warning: (text) => text,
      error: (text) => text,
      text: (text) => text,
    });
    const help = runtime.resumeHelpLines(
      Array.from({ length: 3 }, (_, index) => ({
        id: `session-0000000${index}`,
        title: `title-${index}`,
        command: 'cmd',
        kind: 'shell',
      })),
      { maxItems: 2 },
    );
    expect(help.at(-1)).toBe('muted:  … +1 more');
  });
});
