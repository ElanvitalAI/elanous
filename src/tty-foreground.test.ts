import { describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkForeground, decideForeground, type ForegroundDeps } from './tty-foreground.js';
import { bunNativePtyAvailable, bunSpawnPty } from './pty-shell/bun-native-pty.js';

const base = { ownPgid: 100, ttyPgid: 100, groupAlive: true, leaderAlive: true, leaderIsDescendant: false };

describe('decideForeground — TUI-SIGTTIN-SUSPEND', () => {
  test('we hold the terminal → ok', () => {
    expect(decideForeground(base)).toEqual({ action: 'ok' });
  });
  test('tcgetpgrp failed → unknown (do nothing)', () => {
    expect(decideForeground({ ...base, ttyPgid: -1 })).toEqual({ action: 'unknown' });
  });
  test('10-23 n8n shape: the capture shell exec\'d printenv and exited — the foreground group is empty → reclaim', () => {
    expect(decideForeground({ ...base, ttyPgid: 200, groupAlive: false, leaderAlive: false })).toEqual({ action: 'reclaim', reason: 'fg-group-gone', ttyPgid: 200 });
  });
  test('the shell was SIGKILLed but a grandchild (gitstatusd) lives in its group → reclaim', () => {
    expect(decideForeground({ ...base, ttyPgid: 200, leaderAlive: false })).toEqual({ action: 'reclaim', reason: 'fg-leader-gone', ttyPgid: 200 });
  });
  test('a live child of ours holds it → reclaim', () => {
    expect(decideForeground({ ...base, ttyPgid: 200, leaderIsDescendant: true })).toEqual({ action: 'reclaim', reason: 'fg-held-by-our-child', ttyPgid: 200 });
  });
  test('a live process that is not ours (the user\'s shell) holds it → yield, never fight', () => {
    expect(decideForeground({ ...base, ttyPgid: 300 })).toEqual({ action: 'yield', ttyPgid: 300 });
  });
});

function fakeDeps(over: Partial<ForegroundDeps> & { tty: number }): ForegroundDeps & { events: string[]; reclaims: number[] } {
  const events: string[] = [];
  const reclaims: number[] = [];
  return {
    tcgetpgrp: () => over.tty,
    getpgrp: () => 100,
    reclaim: over.reclaim ?? ((p) => { reclaims.push(p); return true; }),
    alive: over.alive ?? (() => false),
    isDescendant: over.isDescendant ?? (() => false),
    log: (e) => { events.push(e); },
    events,
    reclaims,
  };
}

describe('checkForeground — TUI-SIGTTIN-SUSPEND', () => {
  test('stolen by a dead group → tcsetpgrp(own) and a foreground-reclaimed log', () => {
    const d = fakeDeps({ tty: 200 });
    expect(checkForeground(d).action).toBe('reclaim');
    expect(d.reclaims).toEqual([100]);
    expect(d.events).toEqual(['foreground-reclaimed']);
  });
  test('held by the user\'s shell → no tcsetpgrp, background-tty logged once per holder', () => {
    const d = fakeDeps({ tty: 300, alive: () => true });
    const state = { yieldedTo: null as number | null };
    checkForeground(d, state);
    checkForeground(d, state);
    expect(d.reclaims).toEqual([]);
    expect(d.events).toEqual(['background-tty']);
  });
  test('we hold it → nothing is probed', () => {
    let probed = 0;
    const d = fakeDeps({ tty: 100, alive: () => { probed++; return true; } });
    expect(checkForeground(d).action).toBe('ok');
    expect(probed).toBe(0);
    expect(d.events).toEqual([]);
  });
});

// Opt-in real-PTY repro: an interactive zsh (job control on, like the user's terminal) runs a child that
// brings the shared TUI layer up (initTui — classic and `--tui next` both go through it) and then runs the
// login-env capture. We type one key afterwards: pre-fix the child is stopped (state T, «suspended»).
const SLOW = process.env.ELANOUS_N03_SLOW !== '1';
const ROOT = resolve(import.meta.dir, '..');

async function runRepro(mode: 'legacy' | 'current', guard: boolean): Promise<{ stat: string; got: boolean; screen: string }> {
  const home = mkdtempSync(join(tmpdir(), 'sigttin-'));
  writeFileSync(join(home, '.zshrc'), '');
  writeFileSync(join(home, '.zprofile'), '');
  const env = { PATH: process.env.PATH ?? '', HOME: home, SHELL: '/bin/zsh', TERM: 'xterm-256color', ZDOTDIR: home, PS1: '$ ', STEAL_MODE: mode, ELANOUS_TTY_FOREGROUND_GUARD: guard ? '1' : '0', ELANOUS_STATE_DIR: join(home, 'state'), ELANOUS_CONFIG_DIR: join(home, 'cfg') };
  const pty = bunSpawnPty('/bin/zsh', ['-f', '-i'], { cols: 160, rows: 40, cwd: ROOT, env });
  let screen = '';
  pty.onData((d) => { screen += d; });
  const wait = async (pred: () => boolean, ms: number): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return true; await Bun.sleep(50); }
    return pred();
  };
  try {
    await Bun.sleep(300);
    pty.write(`${process.execPath} src/ux-sim/tty-foreground-steal-child.ts\r`);
    await wait(() => screen.includes('READY'), 30_000);
    await Bun.sleep(800);
    pty.write('k');
    await wait(() => screen.includes('GOT:k') || /suspended/.test(screen), 3000);
    await Bun.sleep(300);
    const rows = execSync(`ps -A -o ppid=,pid=,stat=`).toString().split('\n').map((l) => l.trim().split(/\s+/));
    const child = rows.find((r) => r[0] === String(pty.pid));
    const stat = child?.[2] ?? 'exited';
    if (child) { try { process.kill(Number(child[1]), 'SIGKILL'); } catch { /* gone */ } }
    return { stat, got: screen.includes('GOT:k'), screen };
  } finally {
    try { pty.kill('SIGKILL'); } catch { /* gone */ }
    rmSync(home, { recursive: true, force: true });
  }
}

describe.skipIf(SLOW || !bunNativePtyAvailable() || process.platform === 'win32')('TUI-SIGTTIN-SUSPEND 10-23 n8n — real PTY', () => {
  test('pre-fix capture, no guard → the TUI is stopped (T) and never gets the key', async () => {
    const r = await runRepro('legacy', false);
    expect(r.stat.startsWith('T')).toBe(true);
    expect(r.got).toBe(false);
  }, 60_000);
  test('root fix: current capture (detached), no guard → running and the key arrives', async () => {
    const r = await runRepro('current', false);
    expect(r.stat.startsWith('T')).toBe(false);
    expect(r.got).toBe(true);
  }, 60_000);
  test('defence: pre-fix capture with the guard → the guard takes the terminal back, the key arrives', async () => {
    const r = await runRepro('legacy', true);
    expect(r.stat.startsWith('T')).toBe(false);
    expect(r.got).toBe(true);
  }, 60_000);
});
