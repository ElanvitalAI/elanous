// ELS-SECURITY-AUDIT-IMMEDIATE 회귀 1 (JUD-B #132138 HOLD · OP #132151): a decision key typed on
// the owner credential (humanApprovalKeys lane — the person's attach answering an approval) is a
// security event. Its audit row lands in the ledger the moment the key is typed — the branch used
// to write no audit row at all. Expected values are literals of THIS contract (independent of any
// product constant): one 'input' row, result 'executed', exitCode 0, chars 1, sha256('y').
import { expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { attachEls, type AttachFrame } from './attach-client.js';
import { requestEls } from './client.js';
import type { ElsPty } from './core.js';
import { elsSocketPath, startElsServer } from './server.js';
import { AUTH_OWNER_TOKEN_ENV, AUTH_PANE_TOKEN_ENV } from './server-auth.js';

// The seat running this file may itself live in an els pane (its env carries a pane token); a stale
// credential would make the 'new' request answer as a pane role instead of the owner. The test
// starts and ends on the env it began with (ratchet: env-without-restore).
const envPaneAtStart = process.env[AUTH_PANE_TOKEN_ENV];
const envOwnerAtStart = process.env[AUTH_OWNER_TOKEN_ENV];
beforeEach(() => { delete process.env[AUTH_PANE_TOKEN_ENV]; delete process.env[AUTH_OWNER_TOKEN_ENV]; });
afterEach(() => {
  if (envPaneAtStart === undefined) delete process.env[AUTH_PANE_TOKEN_ENV]; else process.env[AUTH_PANE_TOKEN_ENV] = envPaneAtStart;
  if (envOwnerAtStart === undefined) delete process.env[AUTH_OWNER_TOKEN_ENV]; else process.env[AUTH_OWNER_TOKEN_ENV] = envOwnerAtStart;
});

const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const until = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const stop = Date.now() + ms;
  while (!check()) { if (Date.now() > stop) throw new Error('timed out waiting'); await new Promise((resolve) => setTimeout(resolve, 10)); }
};

test('an owner-typed decision key (y) is audited immediately — the row is on disk before any 500 ms buffer could flush', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-hak-'));
  try {
    const state = { screen: 'Bash approval · Full command\n  echo isolated\ny run · n deny · Enter default N · Esc deny', writes: [] as string[], alive: true };
    const pty: ElsPty = { id: 'pty_1', isAlive: () => state.alive, write: (text) => { state.writes.push(text); }, renderScreen: async () => state.screen,
      onExit: () => {}, kill: () => {}, resize: () => {} };
    const started = await startElsServer({ stateRoot: root, spawn: () => pty });
    if ('exitCode' in started) throw new Error(started.message);
    // startElsServer put the owner token in this process env, so attachEls presents it: this attach
    // is the server-owner lane (humanApprovalKeys) — exactly the lane JUD-B #132138 held.
    const pane = (JSON.parse((await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: '/work', command: ['sh'] })).message) as { pane: string }).pane;
    const frames: AttachFrame[] = [];
    const attached = attachEls(elsSocketPath(root), pane, { cols: 80, rows: 24 }, { onFrame: (frame) => frames.push(frame), onEnd: () => {}, onError: () => {} });
    try {
      await until(() => frames.length > 0);
      attached.input('y');
      await until(() => state.writes.length === 1);          // the key reached the PTY (synchronous lane)
      expect(state.writes).toEqual(['y']);
      // The row must already be on disk — the burst buffer has not fired (well under 500 ms).
      const auditPath = join(root, 'els', 'control-audit.jsonl');
      const rows = (existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : '')
        .split('\n').filter((line) => line.includes('"action":"input"')).map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: 'input', result: 'executed', chars: 1, exitCode: 0, sha256: createHash('sha256').update('y').digest('hex') });
    } finally { attached.detach(); }
    await started.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 10_000);
