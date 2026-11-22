import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestEls } from './client.js';
import type { ElsPty } from './core.js';
import { elsSocketPath, startElsServer } from './server.js';

// A pane keeps its inherited ELANOUS_ELS_PANE_TOKEN across els server restarts. When the token goes
// stale (a new server generation minted fresh credentials), the server's denial must still reach
// the CLI as the server's own answer — never as «malformed answer from the els server».
// Observation 2026-11-22 02:17–02:23Z: every wake els-list from OP pane p23623d97 failed with
// «els-list: els: malformed answer from the els server» and ElsControl status answered
// lookup-failed «journal lookup failed» — the same requestEls('ls') path.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const noPty = (): ElsPty => { throw new Error('no PTY in this test'); };

test('a stale pane credential is delivered as the server denial, not reported as a malformed answer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-auth-ack-'));
  cleanups.push(() => { rmSync(root, { recursive: true, force: true }); });
  const started = await startElsServer({ stateRoot: root, spawn: noPty });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const savedToken = process.env.ELANOUS_ELS_PANE_TOKEN;
  process.env.ELANOUS_ELS_PANE_TOKEN = 'stale-token-from-a-previous-server-generation';
  try {
    const answer = await requestEls(elsSocketPath(root), { op: 'ls' });
    expect(answer.transport?.outcome).toBe('answered');
    expect(answer.exitCode).toBe(1);
    expect(answer.message).toContain('invalid credential');
    expect(answer.message).not.toBe('els: malformed answer from the els server');
  } finally {
    if (savedToken === undefined) delete process.env.ELANOUS_ELS_PANE_TOKEN;
    else process.env.ELANOUS_ELS_PANE_TOKEN = savedToken;
  }
});
