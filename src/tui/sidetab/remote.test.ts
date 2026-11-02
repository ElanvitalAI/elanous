import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { fetchRegisteredRemoteSidetabRows, markRemoteHostUnavailable, quoteShell } from './remote.js';

describe('remote sidetab discovery', () => {
  test('POSIX shell quoting preserves apostrophes and prevents command substitution', () => {
    const value = "literal ' apostrophe\n$(printf injected)";
    const actual = execFileSync('sh', ['-c', `printf %s ${quoteShell(value)}`], { encoding: 'utf8' });
    expect(actual).toBe(value);
  });
  test('reads only explicit registered live TUI rows', async () => {
    const calls: string[] = [];
    const hosts = await fetchRegisteredRemoteSidetabRows(['aws1'], async (_host, command) => {
      calls.push(command);
      return JSON.stringify([{ ptyId: 'tui-1', kind: 'tui', name: 'work', alive: true, registered: true, status: 'busy', lastActivityAt: 10_000 }]);
    });
    expect(calls).toEqual(['eln pty sidetab list --json']);
    expect(hosts[0]?.rows[0]).toMatchObject({
      id: 'remote:aws1:tui-1', ptyId: 'tui-1', remoteHost: 'aws1', badge: 'busy', host: 'aws1',
    });
  });

  test('rejects unregistered or non-TUI entries and distinguishes unavailable hosts', async () => {
    const malformed = await fetchRegisteredRemoteSidetabRows(['aws1'], async () =>
      JSON.stringify([{ ptyId: 'shell-1', kind: 'shell', name: 'shell', alive: true, registered: false }]));
    expect(malformed[0]?.error).toContain('malformed or ineligible');
    const stale = markRemoteHostUnavailable([{
      id: 'remote:aws1:tui-1', ptyId: 'tui-1', remoteHost: 'aws1', host: 'aws1',
      label: 'aws1:work · busy', kind: 'tui', badge: 'busy',
    }], 'aws1', 'connection timeout');
    expect(stale[0]).toMatchObject({ badge: 'stale', status: '측정 불가 · connection timeout' });
    expect(stale[0]?.label).toContain('측정 불가');
  });
});
