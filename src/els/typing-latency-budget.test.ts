// ELS-LIGHTWEIGHT-BUDGET-GATE — typing through `els attach` must stay instant while the server is under today's load.
//
// The shape is the production one that made typing lag (OP measured ~200 ms per key, a 2.64 s backlog after 50 keys):
// a messages.db of 100 000 rows across 17 seats, 17 seat panes whose `ls` rows carry unread-mail badges, and 5 clients
// asking `ls` once a second. The server runs in its own child process (as `els serve` does); this process types 50 keys
// 120 ms apart into a scratch `/bin/zsh -f` pane through the product attach client and times each key from its
// SCHEDULED send time to the first frame that shows it, so a stalled loop cannot hide its backlog.
// Budget (대표 11-22), every line asserted: round-trip p50 < 10 ms, p99 < 30 ms, the last key on screen within 100 ms of
// its schedule, no key lost, server process CPU avg < 5 %. The load must be real INSIDE the typing window (warm-up
// excluded): at least 4 full `ls` listings per second sustained across the 5 pollers, and at least 80 % of the requests
// that completed in the window succeeded. The numbers are literals of the budget, not product constants.
// A second test is the instrument's negative control: the same budget against a server child that stalls its own main
// thread (200 ms every 250 ms, fixture-only injection) must report violations — a budget that cannot go RED proves nothing.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachEls } from './attach-client.js';
import { requestEls } from './client.js';
import { guardElsProcesses } from './test-support/els-process-guard.js';
import { measureTyping, spawnIsolatedEls, startPollers, targetCredential, withTarget, type IsolatedEls, type PollerStats, type TypingResult } from '../../scripts/els-typing-latency.js';

// Every env name the instrument or the product clients could touch; the file ends on the env it began with.
const WATCHED_ENV = ['ELANOUS_STATE_DIR', 'ELANOUS_ELS_PANE_TOKEN', 'ELANOUS_ELS_OWNER_TOKEN', 'ELANOUS_ELS_RUNTIME_TOKEN_FILE'];
const envAtStart = WATCHED_ENV.map((name) => [name, process.env[name]] as const);
const restoreEnv = (): void => { for (const [name, value] of envAtStart) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } };
afterAll(restoreEnv);
guardElsProcesses();

function budgetViolations(result: TypingResult, ls?: PollerStats): string[] {
  const violations: string[] = [];
  if (ls) {
    if (!(ls.okPerSec >= 4)) violations.push(`load: ${ls.okPerSec} successful ls/s in the window (need >= 4)`);
    if (!(ls.ok >= ls.attempts * 0.8)) violations.push(`load: ${ls.ok}/${ls.attempts} completed ls succeeded in the window (need >= 80 %)`);
  }
  if (result.keys !== 50) violations.push(`keys ${result.keys} != 50`);
  if (result.missing !== 0) violations.push(`missing ${result.missing} != 0`);
  if (!(result.p50 < 10)) violations.push(`p50 ${result.p50} ms >= 10 ms`);
  if (!(result.p99 < 30)) violations.push(`p99 ${result.p99} ms >= 30 ms`);
  // ELS-SERVER-MAINLOOP-STARVATION (OP #129204 ③): not one key may cross the starvation line, so the slowest single
  // key — not only p50/p99 — is a budget line of its own.
  if (!(result.max < 100)) violations.push(`max ${result.max} ms >= 100 ms`);
  if (!(result.backlogMsAfterLast < 100)) violations.push(`backlog ${result.backlogMsAfterLast} ms >= 100 ms`);
  if (result.serverCpuPct === null || !(result.serverCpuPct < 5)) violations.push(`server CPU ${result.serverCpuPct} % >= 5 %`);
  return violations;
}

const summary = (result: TypingResult, ls?: PollerStats) => JSON.stringify({ p50: result.p50, p95: result.p95, p99: result.p99, max: result.max,
  backlogMsAfterLast: result.backlogMsAfterLast, missing: result.missing, serverCpuPct: result.serverCpuPct, sendLagMaxMs: result.sendLagMaxMs,
  windowMs: Math.round(result.windowEndMs - result.windowStartMs), ...(ls ? { lsAttempts: ls.attempts, lsOk: ls.ok, lsOkPerSec: ls.okPerSec } : {}) });

// ELS-SERVER-MAINLOOP-STARVATION (OP #129147/#129204): the ledger fixture is the production SIZE — a body-length
// distribution (60 B .. ~2.3 KB, mean ≈ 1.2 KB) over 74_000 rows makes a real 131 MB-class messages.db (measured
// 131.9 MiB on this builder; asserted >= 130 MiB on disk by the test). The budget literals stay as they were; what
// changed is the load under them.
const LEDGER_MIN_BYTES = 130 * 1024 * 1024;

describe('typing budget under load', () => {
  let server: IsolatedEls;
  let pollers: ReturnType<typeof startPollers>;
  let ledgerBytes = 0;
  beforeAll(async () => {
    server = await spawnIsolatedEls({ load: true, rows: 74_000, seats: 17 });
    ledgerBytes = statSync(join(server.root, 'msg', 'messages.db')).size;
    pollers = startPollers(server.socketPath, server.credential, 5, 1_000, 18);   // 18 = the scratch pane + 17 seat panes
    await new Promise((resolve) => setTimeout(resolve, 1_500));   // warm-up: every poller has asked at least once
  }, 300_000);
  afterAll(async () => { await pollers?.stop(); await server?.stop(); }, 120_000);

  test('the fixture leaves this process env as it found it', () => {
    expect(WATCHED_ENV.map((name) => [name, process.env[name]])).toEqual(envAtStart.map(([name, value]) => [name, value]));
  });

  test('the ledger fixture is the production size (>= 130 MiB on disk)', () => {
    console.log(`[ledger-size] messages.db = ${(ledgerBytes / 1024 / 1024).toFixed(1)} MiB (min ${LEDGER_MIN_BYTES / 1024 / 1024} MiB)`);
    expect(ledgerBytes).toBeGreaterThanOrEqual(LEDGER_MIN_BYTES);
  });

  test('50 keys at 120 ms — max < 100 ms (every single key), p50 < 10 ms, p99 < 30 ms, backlog < 100 ms, missing 0, server CPU < 5 %, load >= 4 ls/s', async () => {
    const result = await measureTyping(server.socketPath, server.pane, server.credential, { keys: 50, intervalMs: 120, serverCpuMicros: server.serverCpuMicros });
    const ls = pollers.stats({ startMs: result.windowStartMs, endMs: result.windowEndMs });
    console.log(`[typing-budget] ${summary(result, ls)}`);
    expect(budgetViolations(result, ls)).toEqual([]);
  }, 300_000);

  test('each of the 5 one-second pollers completes its own round every second of the window (no poller starves)', async () => {
    const result = await measureTyping(server.socketPath, server.pane, server.credential, { keys: 50, intervalMs: 120, serverCpuMicros: server.serverCpuMicros });
    const ls = pollers.stats({ startMs: result.windowStartMs, endMs: result.windowEndMs });
    const seconds = (result.windowEndMs - result.windowStartMs) / 1000;
    console.log(`[poller-slices] window=${seconds.toFixed(1)}s perPoller=${JSON.stringify(ls.perPoller)}`);
    expect(ls.perPoller.length).toBe(5);
    // A poller that answered NOTHING in the window is a starved loop, not a light one.
    for (const [p, slice] of ls.perPoller.entries()) {
      expect(slice.ok).toBeGreaterThan(0);
    }
    // Over the whole window each poller averaged ~1 completed ok listing per second (floor = seconds - 1: a round
    // in flight at window start or end is not counted, one full round always is).
    for (const [p, slice] of ls.perPoller.entries()) {
      expect(slice.ok).toBeGreaterThanOrEqual(Math.max(1, Math.floor(seconds) - 1));
    }
  }, 300_000);
});

// ELS-SERVER-MAINLOOP-STARVATION (OP #129147 ②): a server this test started must never survive it — neither by a
// graceful stop (`stop` → the server closes its panes and exits) nor by losing the owner the hard way (SIGKILL, the
// ownership-lost path): once the fixture root is gone, no `bun` process of this run may still hold a socket or a cwd
// under that root. An orphaned `els serve` answering nobody is exactly the stall-restart hazard this gate pins.
describe('no orphan serve survives the fixture (ELS-SERVER-MAINLOOP-STARVATION)', () => {
  const roots: string[] = [];
  // The same fact on both gate hosts: a live process holds a cwd or an open socket file under the root. macOS has no
  // /proc, so `lsof` (the only portable answer) lists the root's holders; Linux additionally walks /proc/*/cwd.
  const orphansOf = async (root: string): Promise<{ pid: number; kind: string }[]> => {
    const out: { pid: number; kind: string }[] = [];
    if (typeof Bun !== 'undefined' && Bun.build === undefined && process.platform === 'linux') {
      for (const name of readdirSync('/proc').filter((row) => /^\d+$/.test(row))) {
        try { if (readlinkSync(join('/proc', name, 'cwd')).startsWith(root)) out.push({ pid: Number(name), kind: 'cwd' }); } catch { /* gone */ }
      }
    }
    // node-b gate runners PATH lacks /usr/sbin (lsof ENOENT killed r1 focused); absolute fallback first.
    const lsofBin = existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';
    const proc = Bun.spawnSync([lsofBin, '-w', '-F', 'pn', `+D`, root], { stdout: 'pipe', stderr: 'pipe' });
    if (proc.exitCode === 0) {
      const text = new TextDecoder().decode(proc.stdout);
      let pid: number | undefined;
      for (const line of text.split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1));
        else if (line.startsWith('n') && pid !== undefined && Number.isInteger(pid)) { out.push({ pid, kind: 'open' }); pid = undefined; }
      }
    }
    // This test process itself mentions the root constantly (it created it); only OTHER processes count.
    const mine = process.pid;
    return out.filter((row) => row.pid !== mine);
  };

  test('a graceful stop leaves no serve process on the fixture root', async () => {
    const server = await spawnIsolatedEls({ load: false });
    roots.push(server.root);
    expect(server.serverPid).toBeGreaterThan(0);
    await server.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));   // reaping is part of stopping
    expect(await orphansOf(server.root)).toEqual([]);
  }, 120_000);

  test('a hard ownership loss (SIGKILL) leaves no serve process on the fixture root', async () => {
    const server = await spawnIsolatedEls({ load: false });
    roots.push(server.root);
    await server.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await orphansOf(server.root)).toEqual([]);
  }, 120_000);

  afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
});

describe('negative control: an injected main-thread stall', () => {
  let server: IsolatedEls;
  beforeAll(async () => { server = await spawnIsolatedEls({ blockMs: 200, blockEveryMs: 250 }); }, 120_000);
  afterAll(async () => { await server?.stop(); }, 90_000);

  test('the same budget reports the stall (p99 and backlog violations)', async () => {
    const result = await measureTyping(server.socketPath, server.pane, server.credential, { keys: 50, intervalMs: 120, serverCpuMicros: server.serverCpuMicros });
    const violations = budgetViolations(result);
    console.log(`[typing-budget-injected] ${summary(result)} violations=${JSON.stringify(violations)}`);
    expect(violations.some((line) => line.startsWith('p99 '))).toBe(true);
    expect(violations.some((line) => line.startsWith('backlog ') || line.startsWith('p50 '))).toBe(true);
  }, 180_000);
});

// JUD security HOLD #39545: the instrument binds its credential to the verified target, per connection. A fake els
// socket (same user, private dir) records every byte it receives; this process carries operational-looking tokens in
// env. Only the target's own owner-token may arrive, and the env must be exactly as before afterwards.
describe('credential binding to the target socket', () => {
  let dir: string;
  let server: Server;
  const received: string[] = [];
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir().length > 40 ? '/tmp' : tmpdir(), 'els-lat-cred-'));
    chmodSync(dir, 0o700);
    writeFileSync(join(dir, 'owner-token'), 'target-owner-token-fixture\n', { mode: 0o600 });
    server = createServer((socket) => {
      socket.on('data', (chunk) => {
        received.push(chunk.toString('utf8'));
        if (chunk.toString('utf8').includes('"op":"auth"')) socket.write('{"exitCode":0,"message":"ok"}\n');
        if (chunk.toString('utf8').includes('"op":"ls"')) socket.end('{"exitCode":0,"message":"{\\"panes\\":[]}"}\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(join(dir, 'els.sock'), resolve));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    restoreEnv();
  });

  test('an env-provided owner/pane/runtime token is NOT sent to a different socket; the target token is, and env is restored', async () => {
    const runtimeFile = join(dir, 'operational-runtime-token');
    writeFileSync(runtimeFile, 'operational-runtime-secret', { mode: 0o600 });
    process.env.ELANOUS_ELS_OWNER_TOKEN = 'operational-owner-secret';
    process.env.ELANOUS_ELS_PANE_TOKEN = 'operational-pane-secret';
    process.env.ELANOUS_ELS_RUNTIME_TOKEN_FILE = runtimeFile;
    const socketPath = join(dir, 'els.sock');
    const credential = targetCredential(socketPath);
    expect(credential).toBe('target-owner-token-fixture');
    await withTarget(credential, () => requestEls(socketPath, { op: 'ls' }, 2_000));
    const attached = withTarget(credential, () => attachEls(socketPath, 'p1', { cols: 80, rows: 24 }, { onFrame: () => {}, onEnd: () => {} }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    attached.detach();
    const wire = received.join('');
    expect(wire).toContain('"token":"target-owner-token-fixture"');
    expect(wire).not.toContain('operational-owner-secret');
    expect(wire).not.toContain('operational-pane-secret');
    expect(wire).not.toContain('operational-runtime-secret');
    expect(process.env.ELANOUS_ELS_OWNER_TOKEN).toBe('operational-owner-secret');
    expect(process.env.ELANOUS_ELS_PANE_TOKEN).toBe('operational-pane-secret');
    expect(process.env.ELANOUS_ELS_RUNTIME_TOKEN_FILE).toBe(runtimeFile);
    restoreEnv();
  });

  test('a target without its own private owner-token is refused (missing, world-readable, not a socket)', () => {
    const other = mkdtempSync(join(tmpdir().length > 40 ? '/tmp' : tmpdir(), 'els-lat-cred2-'));
    try {
      chmodSync(other, 0o700);
      writeFileSync(join(other, 'els.sock'), 'not a socket');
      expect(() => targetCredential(join(other, 'els.sock'))).toThrow('not a unix socket');
      expect(() => targetCredential(join(other, 'absent.sock'))).toThrow('no socket at this path');
      chmodSync(join(dir, 'owner-token'), 0o644);
      expect(() => targetCredential(join(dir, 'els.sock'))).toThrow('not a private file of the current user');
      chmodSync(join(dir, 'owner-token'), 0o600);
      rmSync(join(dir, 'owner-token'));
      expect(() => targetCredential(join(dir, 'els.sock'))).toThrow('no owner-token next to the socket');
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
});
