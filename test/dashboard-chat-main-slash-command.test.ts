import { describe, expect, test } from 'bun:test';

import { resolveDashboardChatMainSlashCommand } from '../src/dashboard/input/chat-main-slash-command.js';

describe('dashboard chat main slash command', () => {
  test('normalizes command name to lowercase and preserves args', () => {
    expect(resolveDashboardChatMainSlashCommand('/LoG help now')).toEqual({
      cmdLower: 'log',
      args: ['help', 'now'],
    });
  });

  test('rewrites /resume into /session load', () => {
    expect(resolveDashboardChatMainSlashCommand('/resume abc123')).toEqual({
      cmdLower: 'session',
      args: ['load', 'abc123'],
    });
  });

  test('TUI-RESUME-PICKER: a bare /resume is left as resume (the picker handler), not rewritten', () => {
    expect(resolveDashboardChatMainSlashCommand('/resume')).toEqual({ cmdLower: 'resume', args: [] });
    expect(resolveDashboardChatMainSlashCommand('/resume   ')).toEqual({ cmdLower: 'resume', args: [] });
  });

  test('returns empty command metadata for bare slash', () => {
    expect(resolveDashboardChatMainSlashCommand('/')).toEqual({
      cmdLower: '',
      args: [],
    });
  });
});
