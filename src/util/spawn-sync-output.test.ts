import { expect, test } from 'bun:test';
import { spawnSyncText } from './spawn-sync-output.js';

test('spawnSyncText returns stdout with its original bytes and rejects failed commands', () => {
  expect(spawnSyncText('bun', ['-e', 'process.stdout.write("a\\0b\\n")'])).toBe('a\0b\n');
  expect(() => spawnSyncText('bun', ['-e', 'process.stderr.write("failed\\n"); process.exit(7)']))
    .toThrow(/status=7.*failed/);
  expect(() => spawnSyncText('no-such-spawn-sync-output-command', [])).toThrow(/ENOENT|not found/);
});
