// ELS-ORPHAN-SERVE-REAP (OP #131393③ · 골 OP #132048③): a serve's stateRoot can keep holder
// residue nobody owns — a SIGKILL'd holder never runs its cleanup (meta·socket·snap stay), and a
// SIGKILL'd serve leaves its detached holders alive with no server that will ever adopt them.
// M1: a serve that starts on a stateRoot sweeps orphan holder residue (panes the journal does not
//     claim — reattach only ever looks at journal panes, so non-journal residue lived forever).
// M3: the live orphan holder is reaped the same way at the next startup — its PTY child is ended
//     (the holder's own exit path cleans up), and the residue files are removed.
// M2: when the spawning process sees a holder die (child.exited — an event, not a timer), the
//     residue that death could not clean (SIGKILL) is removed at once; the screen snapshot stays
//     (D1b restore still needs it). Only self-owned paths inside holdersDir(stateRoot) are touched.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { holderMetaPath, holderSnapshotPath, holderSocketPath, holdersDir, spawnHolderDetached } from './holder.js';
import { startElsServer } from './server.js';

const until = async (what: string, ms: number, probe: () => boolean): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A meta that passes loadHolderMeta's shape check but points at nothing alive.
const deadMeta = (stateRoot: string, paneId: string): string => JSON.stringify({
  paneId, ptyId: `pty-${paneId}`, pid: 400_000, cwd: stateRoot, command: ['sleep', '30'], title: 'orphan',
  socketPath: holderSocketPath(stateRoot, paneId), startedAt: Date.now(), cols: 80, rows: 24,
}, null, 2);

test('M1: a serve sweeps dead holder residue for panes the journal does not claim', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-reap-dead-'));
  try {
    mkdirSync(holdersDir(root), { recursive: true });
    const metaPath = holderMetaPath(root, 'orphan-dead');
    writeFileSync(metaPath, deadMeta(root, 'orphan-dead'));
    writeFileSync(holderSocketPath(root, 'orphan-dead'), 'leftover-by-a-sigkilled-holder');
    writeFileSync(holderSnapshotPath(root, 'orphan-dead'), '{"screen":"frozen"}');
    // a stray socket with no meta at all is residue too — nothing can adopt it
    writeFileSync(holderSocketPath(root, 'meta-less'), 'leftover-socket');
    const started = await startElsServer({ stateRoot: root, stall: false });
    if ('exitCode' in started) throw new Error(started.message);
    expect(existsSync(metaPath)).toBe(false);
    expect(existsSync(holderSocketPath(root, 'orphan-dead'))).toBe(false);
    expect(existsSync(holderSnapshotPath(root, 'orphan-dead'))).toBe(false);
    expect(existsSync(holderSocketPath(root, 'meta-less'))).toBe(false);
    await started.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("M3-in-M1: a live orphan holder (its serve was SIGKILL'd) is reaped by the next serve, not adopted", async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-reap-live-'));
  try {
    // a real detached holder for a pane that is NOT in the journal — exactly what a SIGKILL'd
    // serve leaves behind: alive, adoptable-looking, and owned by no server.
    // exitGraceMs 200: the default exit grace is 30 s (HOLDER_EXIT_GRACE_MS) — the test needs the holder's
    // own exit path observable well inside its 5 s budget.
    // ELANOUS_SKIP_LOGIN_ENV=1 (same contract as restart-pane-token-survive.test.ts): the gate's safe-bun
    // wrapper runs `env -i` with no SHELL, so the holder's self login-shell capture would fail-closed and
    // never write its meta. Opting out boots the holder with the fallback env this test actually needs.
    const holder = spawnHolderDetached({ stateRoot: root, paneId: 'orphan-live', cwd: root, title: 'orphan', exitGraceMs: 200, env: { ELANOUS_SKIP_LOGIN_ENV: '1' }, command: ['sleep', '30'] });
    const metaPath = holderMetaPath(root, 'orphan-live');
    await until('the orphan holder never wrote its meta', 5_000, () => existsSync(metaPath));
    expect(pidAlive(holder.pid)).toBe(true);
    const started = await startElsServer({ stateRoot: root, stall: false });
    if ('exitCode' in started) throw new Error(started.message);
    // the sweep ends the holder's PTY child (the holder's own exit path) and clears the residue.
    await until('the orphan holder outlived the reap', 5_000, () => !pidAlive(holder.pid));
    expect(existsSync(metaPath)).toBe(false);
    expect(existsSync(holderSocketPath(root, 'orphan-live'))).toBe(false);
    expect(existsSync(holderSnapshotPath(root, 'orphan-live'))).toBe(false);
    await started.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('M2: a SIGKILL\'d holder\'s residue is cleaned by its exit event — meta and socket go, the snapshot stays', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-reap-event-'));
  try {
    // ELANOUS_SKIP_LOGIN_ENV=1: see the M3-in-M1 note — the holder must boot even where no SHELL exists.
    const holder = spawnHolderDetached({ stateRoot: root, paneId: 'killed-holder', cwd: root, title: 'victim', env: { ELANOUS_SKIP_LOGIN_ENV: '1' }, command: ['sleep', '30'] });
    const metaPath = holderMetaPath(root, 'killed-holder');
    const sockPath = holderSocketPath(root, 'killed-holder');
    const snapPath = holderSnapshotPath(root, 'killed-holder');
    await until('the holder never wrote its meta', 5_000, () => existsSync(metaPath));
    const ptyPid = (JSON.parse(await Bun.file(metaPath).text()) as { pid: number }).pid;
    // A bare sleep prints nothing, so the holder's debounced write never fires and a SIGKILL runs no
    // flush — the frozen screen the reap must preserve is this fixture (real snapshots arrive the same way).
    writeFileSync(snapPath, JSON.stringify({ version: 1, paneId: 'killed-holder', ptyId: 'pty-killed-holder', cols: 80, rows: 24, screen: 'frozen', scrollback: '', savedAt: Date.now() }));
    process.kill(holder.pid, 'SIGKILL'); // the death that cannot clean up after itself
    await until('the exit event never cleaned the residue', 5_000, () => !existsSync(metaPath) && !existsSync(sockPath));
    expect(existsSync(snapPath)).toBe(true); // D1b: the frozen screen survives a dead holder
    await until('the holder\'s PTY child outlived the reap', 5_000, () => !pidAlive(ptyPid));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('M4 (OP #132417): the sweep never signals a reused pid — identity mismatch means skip the signal, reap the files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-reap-reuse-'));
  try {
    // A real holder writes a real meta, then we simulate the exact scenario the OP flagged: the PTY
    // child dies, its pid number is taken over by an innocent unrelated process, and the next serve
    // sweeps the residue. The reap must verify the pid still belongs to the recorded PTY generation
    // (processStart) before signaling — otherwise it would SIGTERM someone else's process.
    const holder = spawnHolderDetached({ stateRoot: root, paneId: 'reuse-pane', cwd: root, title: 'reuse', exitGraceMs: 200, env: { ELANOUS_SKIP_LOGIN_ENV: '1' }, command: ['sleep', '30'] });
    const metaPath = holderMetaPath(root, 'reuse-pane');
    const sockPath = holderSocketPath(root, 'reuse-pane');
    await until('the holder never wrote its meta', 5_000, () => existsSync(metaPath));
    const meta = JSON.parse(await Bun.file(metaPath).text()) as { pid: number; processStart?: string };
    expect(typeof meta.processStart).toBe('string'); // darwin: the holder records the PTY child's start time
    const innocent = Bun.spawn(['sleep', '300'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }); // async: returns at once, occupies its own pid through the sweep
    try {
      // Kill the real PTY child so its pid number is free; the innocent process is NOT at that pid —
      // what the sweep must refuse is signaling any live pid whose identity does not match the meta.
      process.kill(meta.pid, 'SIGKILL');
      await until('the PTY child did not die', 5_000, () => !pidAlive(meta.pid));
      // The holder died with its child (exit event cleans its own residue); rewrite the residue the
      // SIGKILL'd-server scenario leaves: a meta pointing at a now-reused-looking live pid + socket.
      const fakeSock = sockPath; // residue shape
      const innocentPid = innocent.pid ?? 0;
      expect(innocentPid).toBeGreaterThan(0);
      // Point the residue at the innocent process: pid alive + processStart mismatch = the reuse case.
      const forgery = JSON.stringify({ ...meta, pid: innocentPid, socketPath: fakeSock });
      writeFileSync(metaPath, forgery);
      const started = await startElsServer({ stateRoot: root, stall: false });
      if ('exitCode' in started) throw new Error(started.message);
      // The files are reaped (unclaimed residue)…
      await until('the residue was not swept', 5_000, () => !existsSync(metaPath) && !existsSync(fakeSock));
      // …but the innocent process is untouched — no signal was ever sent (OP #132417 필수 1).
      expect(pidAlive(innocentPid)).toBe(true);
      await started.close();
    } finally { try { process.kill(innocent.pid ?? -1, 'SIGKILL'); } catch { /* already gone */ } }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
