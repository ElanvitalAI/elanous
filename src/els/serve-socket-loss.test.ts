// ELS-SERVE-ORPHAN-EXIT (OP 11-22, 고아 23개): a `side serve` whose bound socket file disappears
// must end itself instead of lingering forever. Ownership is the bound socket (server.ts header):
// once the file is gone this process no longer owns anything, yet nothing in Node fires an event —
// the process used to stay alive with all its pane holders, which is how the 23 orphans looked.
// The guard: `startElsServer` watches both bound sockets and resolves `lost` after closing itself.
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { elsSocketPath, elsToolSocketPath, startElsServer } from './server.js';
import { simCli } from '../ux-sim/in-process-cli.js';

const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${what}`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });

test('a serve whose els.sock vanished closes itself and answers lost, so a fresh serve can take over', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-socket-loss-'));
  try {
    const started = await startElsServer({ stateRoot: root, stall: false, socketGuardIntervalMs: 25 });
    if ('exitCode' in started) throw new Error(started.message);
    unlinkSync(elsSocketPath(root));
    const reason = await within(started.lost, 2_000, 'lost did not fire after els.sock vanished');
    expect(reason).toContain('els.sock');
    // lost resolves only after the server closed itself: both socket files are gone, nothing lingers.
    expect(() => statSync(elsToolSocketPath(root))).toThrow();
    // the old process no longer owns anything: a fresh serve binds the same root without refusal.
    const fresh = await startElsServer({ stateRoot: root, stall: false });
    if ('exitCode' in fresh) throw new Error(`fresh serve refused: ${fresh.message}`);
    await fresh.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a serve whose ctl.sock vanished also ends itself (both bound sockets are ownership)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-tool-socket-loss-'));
  try {
    const started = await startElsServer({ stateRoot: root, stall: false, socketGuardIntervalMs: 25 });
    if ('exitCode' in started) throw new Error(started.message);
    unlinkSync(elsToolSocketPath(root));
    const reason = await within(started.lost, 2_000, 'lost did not fire after ctl.sock vanished');
    expect(reason).toContain('ctl.sock');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a socket that still exists never fires lost', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-socket-kept-'));
  try {
    const started = await startElsServer({ stateRoot: root, stall: false, socketGuardIntervalMs: 25 });
    if ('exitCode' in started) throw new Error(started.message);
    let fired = false;
    started.lost.then(() => { fired = true; });
    await new Promise((r) => setTimeout(r, 150));
    expect(fired).toBe(false);
    await started.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an idle client on els.sock cannot hold the end — loss cuts open connections (JUD-B: idle 연결 3.5s 생존)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-socket-idle-'));
  let cleanup: (() => Promise<void>) | undefined;
  let idle: ReturnType<typeof createConnection> | undefined;
  try {
    const started = await startElsServer({ stateRoot: root, stall: false, socketGuardIntervalMs: 25 });
    if ('exitCode' in started) throw new Error(started.message);
    cleanup = () => started.close();
    // a real client connects and then says nothing — it must not outlive the owner it lost.
    idle = createConnection(elsSocketPath(root));
    await new Promise<void>((resolve, reject) => { idle!.once('connect', () => resolve()); idle!.once('error', (e) => reject(e instanceof Error ? e : new Error(String(e)))); });
    unlinkSync(elsSocketPath(root));
    const t0 = Date.now();
    const reason = await within(started.lost, 1_500, 'lost did not fire — an idle client held the shutdown');
    expect(reason).toContain('els.sock');
    expect(Date.now() - t0).toBeLessThan(1_500);
    // the idle client sees the cut: its connection ends (the close reaches this side within the second).
    await within(new Promise<void>((resolve) => { idle!.once('close', () => resolve()); }), 1_000, 'the idle client was not cut');
  } finally {
    idle?.destroy();
    try { await cleanup?.(); } catch { /* the loss path already closed it */ }
    rmSync(root, { recursive: true, force: true });
  }
});

// OP #128538 → #129232 (contract rewritten): the dying owner's exit must never remove a socket it
// no longer owns. A live server (the replacer) takes the vacated path while the old owner still
// runs; the old owner's exit used to delete the replacer's socket file (bun's listener close
// unlinks the bound path unconditionally — it never checks the inode), so the path stayed free but
// els was severed. The exit now closes a listener ONLY while the path still holds its own bound
// inode; a lost or replaced socket is never closed at all — the fd dies with the process exit and
// the exit never touches a path it does not own.
test("the dying owner's exit keeps the live server that took the vacated path (OP #128538/#129232)", async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-socket-takeover-'));
  let replacer: ReturnType<typeof createServer> | undefined;
  try {
    const started = await startElsServer({ stateRoot: root, stall: false, socketGuardIntervalMs: 25 });
    if ('exitCode' in started) throw new Error(started.message);
    // the owner's socket file is removed → the path is vacated; a LIVE server takes it.
    unlinkSync(elsSocketPath(root));
    let answered = false;
    replacer = createServer((s) => { answered = true; s.end('pong'); });
    await new Promise<void>((resolve) => { replacer!.once('listening', () => resolve()); replacer!.listen(elsSocketPath(root)); });
    const inoReplacer = statSync(elsSocketPath(root)).ino;
    const reason = await within(started.lost, 2_000, 'lost did not fire after els.sock was removed');
    expect(reason).toContain('els.sock');
    // the exit is over: the replacer's socket file is exactly what it bound — not removed, not replaced.
    expect(statSync(elsSocketPath(root)).ino).toBe(inoReplacer);
    // and a real client connects through the path and reaches the replacer.
    const answer = await new Promise<string>((resolve) => {
      const probe = createConnection(elsSocketPath(root));
      let got = '';
      probe.on('data', (d) => { got += d; probe.destroy(); resolve(got.trim()); });
      probe.once('error', (e) => resolve('ERR ' + (e as NodeJS.ErrnoException).code));
      setTimeout(() => { probe.destroy(); resolve('SILENT ' + JSON.stringify(got)); }, 1_500);
    });
    expect(answered).toBe(true);
    expect(answer).toBe('pong');
  } finally {
    try { await new Promise<void>((resolve) => replacer?.close(() => resolve())); } catch { /* already gone */ }
    rmSync(root, { recursive: true, force: true });
  }
});

// JUD-B #128735 (mid-close, deterministic under #129232): the foreign socket — a live third
// server's, atomically renamed onto the path BEFORE the dying owner's guard even fires — sits on
// the path for the ENTIRE close. bun's listener close unlinks the bound path unconditionally and
// inode-blind (probed: evidence-bun-close-unlink-1122 — a foreign file at the path is GONE after
// a plain listener close), so the fix: the exit never closes a listener whose path is not its own
// bound inode. The foreign inode surviving the exit with its identity intact is the receipt —
// no path surgery, nothing to undo.
test('a foreign socket sits on the path for the dying owner\'s whole close and survives it (JUD-B #128735 · OP #129232)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-midclose-takeover-'));
  let third: ReturnType<typeof createServer> | undefined;
  try {
    const started = await startElsServer({ stateRoot: root, stall: false, socketGuardIntervalMs: 25 });
    if ('exitCode' in started) throw new Error(started.message);
    const sock = elsSocketPath(root);
    const thirdPath = join(root, 'third.sock');
    third = createServer((s) => s.end('pong'));
    await new Promise<void>((resolve) => { third!.once('listening', () => resolve()); third!.listen(thirdPath); });
    const boundIno = statSync(sock).ino;
    // atomic replacement — the guard fires on the foreign inode, never on a missing file, so the
    // file is already ON the path when the close's pin stage first stats it.
    renameSync(thirdPath, sock);
    const foreignIno = statSync(sock).ino;
    expect(foreignIno).not.toBe(boundIno);
    // the exit finishes with the foreign socket exactly as it was when the close began — without
    // the exit pin the raw listener close would have deleted it (probed).
    const reason = await within(started.lost, 5_000, 'the dying owner never finished its exit');
    expect(reason).toContain('els.sock');
    expect(statSync(sock).ino).toBe(foreignIno);
    const answer = await new Promise<string>((resolve) => {
      const probe = createConnection(sock);
      let got = '';
      probe.on('data', (d) => { got += d; probe.destroy(); resolve(got.trim()); });
      probe.once('error', (e) => resolve('ERR ' + (e as NodeJS.ErrnoException).code));
      setTimeout(() => { probe.destroy(); resolve('SILENT ' + JSON.stringify(got)); }, 1_500);
    });
    expect(answer).toBe('pong');
  } finally {
    try { await new Promise<void>((resolve) => third?.close(() => resolve())); } catch { /* already gone */ }
    rmSync(root, { recursive: true, force: true });
  }
});

// OP #129232: a serve whose socket file was removed exits — but its exit must never remove a socket
// it no longer owns. B (a live server) binds the VACATED path while A still runs; bun's listener
// close unlinks the bound path unconditionally (probed: evidence-bun-close-unlink-1122), so A's
// exit used to delete B's live socket file — every new connection to els hit ENOENT, i.e. the
// takeover severed els entirely. The contract: the dying owner unlinks only its own inode
// (dev:ino); a different inode at the path is left exactly as it is.
test("the dying owner never removes a socket it no longer owns — B survives A's exit (OP #129232)", async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-exit-foreign-inode-'));
  let b: ReturnType<typeof createServer> | undefined;
  try {
    const started = await startElsServer({ stateRoot: root, stall: false, socketGuardIntervalMs: 25 });
    if ('exitCode' in started) throw new Error(started.message);
    // owner A's socket file is removed → the path is vacated (the loss the guard will fire on).
    unlinkSync(elsSocketPath(root));
    // B — a live server — takes the vacated path and answers.
    b = createServer((s) => { s.end('pong'); });
    await new Promise<void>((resolve) => { b!.once('listening', () => resolve()); b!.listen(elsSocketPath(root)); });
    const inoB = statSync(elsSocketPath(root)).ino;
    // A notices the loss and finishes its whole exit (lost resolves after close()).
    const reason = await within(started.lost, 2_000, 'lost did not fire after els.sock was removed');
    expect(reason).toContain('els.sock');
    // A's exit is over: B's socket file must be exactly what B bound — not removed, not replaced.
    const st = statSync(elsSocketPath(root));
    expect(st.ino).toBe(inoB);
    // and a NEW connection through the path reaches B — the takeover never severed els.
    const answer = await new Promise<string>((resolve) => {
      const probe = createConnection(elsSocketPath(root));
      let got = '';
      probe.on('data', (d) => { got += d; probe.destroy(); resolve(got.trim()); });
      probe.once('error', (e) => resolve('ERR ' + (e as NodeJS.ErrnoException).code));
      setTimeout(() => { probe.destroy(); resolve('SILENT ' + JSON.stringify(got)); }, 1_500);
    });
    expect(answer).toBe('pong');
  } finally {
    try { await new Promise<void>((resolve) => b?.close(() => resolve())); } catch { /* already gone */ }
    rmSync(root, { recursive: true, force: true });
  }
});

// OP #129648 (JUD security HOLD on #39569): the old exit pinned a foreign file (hard link), let
// the listener close unlink the path, then relinked the pin — a check-then-act window in which a
// file swapped onto the path after the pin stage's stat was deleted by the listener close and the
// stale pin was restored (the race measured on the real serve path: 1 clobber in 6, window 1-3ms —
// evidence-race-3rdsocket-1122/04-verdict.json). The fix removes path surgery from the exit
// entirely: the exit closes a listener only while the path still holds its own bound inode. The
// pin/relink siblings only ever lived inside the close's sub-millisecond listener-drain window
// (probed unobservable in-process: evidence-bun-close-unlink-1122/02 — a 1ms poll never sees one
// while the relink's restore proves it ran), so this test cannot RED the old code in-process;
// it pins the END-STATE contract instead — no `exit-shield` sibling may ever persist and the
// foreign file must survive byte-identical — catching any regression that makes surgery visible.
test('the exit never does path surgery — a foreign file on a lost path is never pinned, unlinked or relinked (JUD HOLD on #39569)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-exit-no-surgery-'));
  let idle: ReturnType<typeof createConnection> | undefined;
  try {
    const started = await startElsServer({ stateRoot: root, stall: false, socketGuardIntervalMs: 25 });
    if ('exitCode' in started) throw new Error(started.message);
    // hold the els listener open: the OLD code parks inside listener.close() until this client
    // ends, with its pin link live the whole time — the poller below must catch it if it exists.
    idle = createConnection(elsSocketPath(root));
    await new Promise<void>((resolve, reject) => { idle!.once('connect', () => resolve()); idle!.once('error', (e) => reject(e instanceof Error ? e : new Error(String(e)))); });
    const sock = elsSocketPath(root);
    const foreignPath = join(root, 'attack-file');
    writeFileSync(foreignPath, 'attack');
    const inoForeign = statSync(foreignPath).ino;
    renameSync(foreignPath, sock); // foreign inode lands on the els.sock path
    let sawSurgery = false;
    const sockDir = dirname(sock);
    const poll = setInterval(() => {
      for (const name of readdirSync(sockDir)) {
        if (name.includes('exit-shield')) { sawSurgery = true; return; }
      }
    }, 1);
    poll.unref();
    const lostDone = within(started.lost, 2_000, 'lost did not fire');
    await new Promise((r) => setTimeout(r, 120)); // let the guard fire and the exit run its course
    idle!.end();
    const reason = await lostDone;
    clearInterval(poll);
    expect(reason).toContain('els.sock');
    expect(sawSurgery).toBe(false); // no pin, no shield, no relink — ever
    // the foreign inode survives the exit exactly as it was: never unlinked, never replaced.
    const st = statSync(sock);
    expect(st.ino).toBe(inoForeign);
    expect(st.size).toBe('attack'.length);
  } finally {
    idle?.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the real `els side serve` process ends itself when its socket vanishes — separate process, idle client (JUD-B 실제 CLI 종단)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-serve-exit-proc-'));
  let idle: ReturnType<typeof createConnection> | undefined;
  let cli: AbortController | undefined;
  try {
    const sock = elsSocketPath(root);
    const deadline = Date.now() + 15_000;
    // R-LIVE10: the process-boundary E2E goes through simCli's spawn mode (the single CLI gateway) —
    // it runs the real bin/elanous.mjs in a detached child with an isolated --test=<root> state.
    cli = new AbortController();
    const done = simCli(['side', 'serve'], { mode: 'spawn', allowPaths: [['side', 'serve']], stateRoot: root, timeoutMs: 60_000, signal: cli.signal });
    while (!existsSync(sock)) {
      if (Date.now() > deadline) throw new Error('the CLI serve never bound its socket');
      await new Promise((r) => setTimeout(r, 25));
    }
    idle = createConnection(sock);
    await new Promise<void>((resolve, reject) => { idle!.once('connect', () => resolve()); idle!.once('error', (e) => reject(e instanceof Error ? e : new Error(String(e)))); });
    unlinkSync(sock);
    const t0 = Date.now();
    const result = await done;
    expect(result.exitCode).toBe(1);
    expect(Date.now() - t0).toBeLessThan(3_000);
  } finally {
    idle?.destroy();
    cli?.abort();
    rmSync(root, { recursive: true, force: true });
  }
});
