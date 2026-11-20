// JUD must 4 (b): `els record` from the person's own terminal. The child runs in a real PTY (both ends a terminal) with a
// scrubbed env (no owner/pane token), so the only way the door can know it is the person is the gated adoption of the
// server's 0600 owner-token file (humanOwnerToken) that `els snapshot` already did and `els record` did not.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestEls } from '../els/client.js';
import { elsSocketPath, startElsServer } from '../els/server.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
// A Unix socket path holds at most 103 bytes (macOS): under a long TMPDIR the state dir falls back to /tmp (each test removes its own dir).
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const cleanups: (() => Promise<void> | void)[] = [];
const ORIGINAL_OWNER_TOKEN = process.env.ELANOUS_ELS_OWNER_TOKEN; // startElsServer publishes the owner token into this process's env
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { if (ORIGINAL_OWNER_TOKEN === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = ORIGINAL_OWNER_TOKEN; }
});

// 출처: a fresh `elanous` process boots and answers one socket call in a few seconds on the gate hosts (same bound as els-attach-pty).
const BOOT_MS = 30_000;
const TEST_MS = 120_000;

test('real terminal: els record starts and stops a recording for the person (owner token adopted from the 0600 file), no token in env', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-clirec-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const started = await startElsServer({ stateRoot: root });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  // The person's explicit `els seat set OP` (the door's rule for an owner terminal's `do` actions), presented with this server's owner token.
  expect((await requestEls(elsSocketPath(root), { op: 'seat-set', seat: 'OP' })).exitCode).toBe(0);
  const created = await requestEls(elsSocketPath(root), { op: 'new', ws: 'OP', cwd: root, command: ['/bin/sh'] });
  const { pane } = JSON.parse(created.message) as { pane: string };
  cleanups.push(async () => { await requestEls(elsSocketPath(root), { op: 'close', pane }); });
  const record = (label: string, until: RegExp) => mockSeatPtySequence({
    executable: process.execPath,
    args: [BIN, '--test-state-dir', '{root}', 'side', 'record', pane],
    root, rows: 20, cols: 200,
    ready: { label, timeoutMs: BOOT_MS, until },
    steps: [{ label: `${label}-printed`, until }], // no input: the one-shot command prints and exits
    quitKeys: '', exitTimeoutMs: BOOT_MS,
  });
  const first = await record('started', /recordingId/);
  expect(first.exitCode).toBe(0);
  expect(first.frames[0]?.screen).not.toContain('denied');
  const second = await record('saved', /\.cast/);
  expect(second.exitCode).toBe(0);
  const saved = (second.frames[0]?.screen.replace(/\s*\n\s*/g, '') ?? '').match(/(\/\S+\.cast)/)?.[1];
  expect(saved?.startsWith(join(root, 'artifacts'))).toBe(true);
  expect(existsSync(saved as string)).toBe(true);
  expect(statSync(saved as string).mode & 0o777).toBe(0o600);
  expect(readFileSync(saved as string, 'utf8')).toContain('"version"');
}, TEST_MS);
