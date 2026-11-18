import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { requestEls } from '../els/client.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');

// ELS-NESTING-RULE: bare `els` inside an els pane (its environment names this state dir's socket) draws no second frame:
// one line saying why, exit 1, and no server is started by it.
test('real terminal: bare els inside an els pane says so and exits 1 without starting a server; --list still works there', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-nest-'));
  let pid = 0;
  try {
    const socket = join(root, 'els', 'els.sock');
    const nested = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test-state-dir', '{root}', 'side'],
      root, rows: 12, cols: 140, env: { NODE_ENV: 'development', ELANOUS_ELS_SOCKET: socket },
      ready: { label: 'refused', timeoutMs: 30_000, until: (screen) => screen.includes('이미 els 안입니다') }, // 출처: #37153 live PTY readiness bound
      steps: [{ label: 'still-there', keys: '', until: (screen) => screen.includes('ctrl+b 로 이동하세요'), timeoutMs: 5_000 }], // 출처: #37153 live PTY readiness bound
      quitKeys: '',
    });
    expect(nested.exitCode).toBe(1);
    expect(existsSync(socket)).toBe(false);                    // nothing was started
    const listed = await mockSeatPtySequence({                 // `--list` is a plain request: it works inside too (and starts the isolated server)
      executable: process.execPath,
      args: [BIN, '--test-state-dir', '{root}', 'side', '--list'],
      root, rows: 12, cols: 140, env: { NODE_ENV: 'development', ELANOUS_ELS_SOCKET: socket },
      ready: { label: 'listed', timeoutMs: 30_000, until: (screen) => screen.includes('no panes yet') }, // 출처: #37153 live PTY readiness bound
      steps: [{ label: 'done', keys: '', until: (screen) => screen.includes('no panes yet'), timeoutMs: 5_000 }], // 출처: #37153 live PTY readiness bound
      quitKeys: '',
    });
    expect(listed.exitCode).toBe(0);
    pid = Number((await requestEls(socket, { op: 'ping' })).message.match(/pid (\d+)/)?.[1]);
  } finally {
    if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
