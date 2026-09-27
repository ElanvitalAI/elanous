import { expect, test } from 'bun:test';
import { join } from 'node:path';

const root = join(import.meta.dir, '../..');

test('isolated CLI ACP stdio answers initialize and session/new without boot tool cwd', async () => {
  const proc = Bun.spawn(['bun', 'bin/elanous.mjs', '--test', '--acp-server'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test', ELANOUS_TOOL_CWD: '' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const writer = proc.stdin;
  if (!writer || typeof writer === 'number') throw new Error('missing ACP stdin');
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
    { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } },
  ];
  for (const message of messages) writer.write(JSON.stringify(message) + '\n');
  writer.end();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let results: string;
  try {
    results = await Promise.race([
      new Response(proc.stdout).text(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => { proc.kill(); reject(new Error('ACP stdio timeout')); }, 20_000); }),
    ]);
    await proc.exited;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const responses = results.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
    id: number; result?: { sessionId?: string; protocolVersion?: number }; error?: unknown;
  });
  expect(responses.find((r) => r.id === 1)?.result?.protocolVersion).toBe(1);
  expect(responses.find((r) => r.id === 2)?.result?.sessionId).toMatch(/^elanous-session-/);
  expect(responses.some((r) => r.error)).toBe(false);
});
