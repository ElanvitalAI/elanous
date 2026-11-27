// ELS-CHANNEL P0 CLI — a mistyped number is refused with the fix (Terra #40282 should), a good one reaches the server.
import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerChannelCommands } from './channel-cli.js';

// 출처: the argv below — the cursor and page size typed on the command line come back as numbers.
const AFTER = 7;
const LIMIT = 20; // 출처: #40282 Terra should — the page size typed in the argv below

test('bad --after/--limit/--timeout/--max are refused before any request; good ones are sent', async () => {
  const sent: unknown[] = [];
  const out: Array<{ exitCode: number; message: string }> = [];
  const program = new Command().exitOverride();
  registerChannelCommands(program, { emit: (r) => { out.push(r); }, request: async (r) => { sent.push(r); return { exitCode: 0, message: '{}' }; } });
  for (const argv of [['channel', 'read', 'ws:w1', '--after', '1O'], ['channel', 'read', 'ws:w1', '--limit', 'ten'], ['channel', 'wait', 'ws:w1', '--timeout', '5s'], ['channel', 'open', 'run:r1', '--max', '-3']]) {
    await program.parseAsync(argv, { from: 'user' });
  }
  expect(sent).toEqual([]);
  expect(out.map((r) => r.exitCode)).toEqual([2, 2, 2, 2]);
  expect(out[0]!.message).toBe('els channel: --after must be a whole number (got "1O")');
  await program.parseAsync(['channel', 'read', 'ws:w1', '--after', String(AFTER), '--limit', String(LIMIT)], { from: 'user' });
  expect(sent).toEqual([{ op: 'channel', action: 'read', channel: 'ws:w1', after: AFTER, limit: LIMIT }]);
});
