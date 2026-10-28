import { expect, test } from 'bun:test';
import { createPickerState } from '../chat/pickers/state.js';
import { SLASH_COMMANDS } from '../chat/index.js';
import { resolveDashboardChatMainSlashCommand } from './input/chat-main-slash-command.js';
import { SlashCommandRegistry } from './slash-runtime/registry.js';
import { registerClassicSideSlash } from './side-basic-runtime.js';
import type { SidetabRow } from '../tui/sidetab/list.js';

test('classic /side lists only active rows, spawns a shell, and attaches by displayed number', async () => {
  const rows: SidetabRow[] = [
    { id: 'tui:1', label: 'this session', kind: 'tui', badge: 'idle', currentProcess: true, sessionId: 'here' },
    { id: 'pty:2', label: 'child shell', kind: 'shell', badge: 'busy', sessionId: 'local-2' },
    { id: 'pty:3', label: 'finished', kind: 'shell', badge: 'exited', sessionId: 'local-3' },
  ];
  const lines: string[] = [];
  const calls: string[] = [];
  const ctx = {
    chatLines: lines, setChatScrollOffset: () => {},
    chatPersona: { sessionId: () => 'chat-session' },
    muted: (line: string) => line,
    warning: (line: string) => line,
    termSlash: {
      openNewTerminal: () => { calls.push('new'); },
      sessionRegistry: {
        get: (id: string) => id === 'local-2' ? { id, title: 'child shell' } : null,
        attach: (id: string) => { calls.push(`attach:${id}`); return { id, title: 'child shell', modal: {} }; },
      },
      openSession: (session: { id: string }) => { calls.push(`open:${session.id}`); },
    },
  };
  const registry = new SlashCommandRegistry<any, any>();
  const seenSessions: string[] = [];
  registerClassicSideSlash(registry, (sessionId) => { seenSessions.push(sessionId ?? ''); return rows; });
  await registry.dispatch('side', [], ctx);
  expect(lines.join('\n')).toContain('1.');
  expect(lines.join('\n')).toContain('2.');
  expect(lines.join('\n')).not.toContain('finished');
  await registry.dispatch('side', ['new'], ctx);
  await registry.dispatch('side', ['attach', '2'], ctx);
  expect(calls).toEqual(['new', 'attach:local-2', 'open:local-2']);
  expect(seenSessions).toEqual(['chat-session', 'chat-session']);
  await registry.dispatch('side', ['attach', '3'], ctx);
  expect(calls).toHaveLength(3);
});

test('classic /side attach shows a foreign child PTY snapshot without takeover', async () => {
  const lines: string[] = [];
  const actions: string[] = [];
  const row: SidetabRow = { id: 'pty:child', ptyId: 'pty:child', label: 'child', kind: 'shell', badge: 'busy' };
  const registry = new SlashCommandRegistry<any, any>();
  registerClassicSideSlash(registry, () => [row], async (id, action) => {
    actions.push(`${id}:${action}`);
    return { status: 'success', screen: 'child output\n' };
  });
  await registry.dispatch('side', ['attach', '1'], {
    chatLines: lines, setChatScrollOffset: () => {},
    muted: (line: string) => line, warning: (line: string) => line,
    termSlash: { sessionRegistry: { get: () => null } },
  });
  expect(actions).toEqual(['pty:child:snapshot']);
  expect(lines.join('\n')).toContain('child output');
  expect(lines.join('\n')).toContain('읽기 전용');
});

test('direct /side and slash-picker selection both reach the visible empty-list handler', async () => {
  expect(SLASH_COMMANDS.some((command) => command.name === 'side')).toBe(true);
  const picker = createPickerState({ commands: SLASH_COMMANDS });
  const typed = { lines: ['/side'], lineIdx: 0, colIdx: 5 };
  await picker.refresh(typed);
  const selected = await picker.dispatch({ name: 'enter', ctrl: false, shift: false }, typed);
  expect(selected).toMatchObject({ action: { kind: 'submit', text: '/side' } });

  for (const commandText of ['/side', (selected as any).action.text]) {
    const { cmdLower, args } = resolveDashboardChatMainSlashCommand(commandText);
    const lines: string[] = [];
    const registry = new SlashCommandRegistry<any, any>();
    registerClassicSideSlash(registry, () => []);
    await registry.dispatch(cmdLower, args, {
      chatLines: lines,
      setChatScrollOffset: () => {},
      muted: (line: string) => line,
      warning: (line: string) => line,
      termSlash: { openNewTerminal: () => {} },
    });
    expect(lines).toContain('  사이드탭 없음');
  }
});
