import { test, expect, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import { debug } from '../debug/log.js';
import { dispatchGuardedCliTool } from './agent-cli.js';

test('Bash dispatch records the boundary command fingerprint without recording command text', async () => {
  const command = 'grep -n needle file.txt';
  const log = spyOn(debug, 'log');
  try {
    await dispatchGuardedCliTool({ name: 'Bash', args: { command }, dispatch: async () => 'ok' });
    const dispatch = log.mock.calls.find(([category, event]) => category === 'cli.agent' && event === 'tool-dispatch');
    const data = dispatch?.[2] as Record<string, unknown> | undefined;
    expect(data?.tool).toBe('Bash');
    const fingerprint = String(data?.commandHash ?? '');
    expect(fingerprint).not.toBe('');
    expect(fingerprint).toBe(createHash('sha256').update(command).digest('hex').slice(0, fingerprint.length));
    expect(data).not.toHaveProperty('command');
  } finally { log.mockRestore(); }
});
