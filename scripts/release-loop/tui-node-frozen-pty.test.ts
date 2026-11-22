import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tuiChecks } from './tui-node-checks';

// OP #129723 / JUD-C #129739 mustFix regression (esc-alive): a SIGSTOPed (frozen) TUI redraws
// nothing, so the old help-closes screen-remainder check passed vacuously on the already-seen
// /help frame (node-b isolation probe: frozen 2/2 → help-closes=true, marker never shown; live
// control 2/2 → marker shown). esc-alive types a unique marker after Esc: a live session echoes
// it on the ❯ input line with the footer still «Turn idle»; a frozen screen shows no fresh
// frame (afterMarker == afterEsc) and must fail. Real PTY — macOS hosts only (the gate runs here).

const repoRoot = resolve(import.meta.dir, '../..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function descendantsOf(pid: number): number[] {
  // Walk the daemon's process tree: the TUI child and any fast-repl children it owns.
  const out: number[] = [];
  const walk = (p: number) => {
    const r = spawnSync('pgrep', ['-P', String(p)], { encoding: 'utf8' });
    for (const line of (r.stdout ?? '').split('\n').filter(Boolean)) {
      const child = Number(line);
      if (Number.isInteger(child) && child > 0) { out.push(child); walk(child); }
    }
  };
  walk(pid);
  return out;
}

test('a frozen (SIGSTOP) TUI cannot pass esc-alive — the marker never echoes, while the screen remainder still passes (OP #129723)', async () => {
  const work = mkdtempSync(join(tmpdir(), 'tui-node-frozen-'));
  const stateDir = join(work, 'state');
  mkdirSync(join(stateDir, 'sessions'), { recursive: true });
  // Completed onboarding so the first-run wizard never opens (same shape the queue-wait PTY suites use).
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  const id = `frozen-${Date.now().toString(36)}`;
  const logFd = openSync(join(work, `${id}.log`), 'a');
  // Exactly the tui-sim-node.ts session() daemon: start --test --state-dir <dir> --boot 10.
  const daemon = spawn('bun', ['scripts/tui-sim.ts', 'start', '--id', id, '--test', '--state-dir', stateDir, '--boot', '10'],
    { cwd: repoRoot, detached: true, stdio: ['ignore', logFd, logFd] });
  daemon.unref();
  const sim = (...a: string[]) => {
    // 출처: #39559 — tui-sim CLI 호출 계약(각 동사 20s 상한, session() 과 동일 여유).
    const r = spawnSync('bun', ['scripts/tui-sim.ts', ...a], { cwd: repoRoot, encoding: 'utf8', timeout: 20_000 });
    return r.stdout ?? '';
  };
  let frozen: number[] = [];
  try {
    // Ready poll — 출처: #39559 — session() 의 ready 루프와 동일(2s 간격, 90s 상한).
    let readyMs: number | null = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 90_000) {
      if (/"ready": true/.test(sim('status', id))) { readyMs = Date.now() - t0; break; }
      await sleep(2000);
    }
    expect(readyMs).not.toBeNull();
    const text = () => sim('text', id);
    const first = text();
    sim('send', id, '/help');
    await sleep(3000); // 출처: #39559 — session() 의 /help 정착 3s 와 동일.
    const help = text();
    // Freeze the TUI (and any fast-repl children): the PTY master still accepts writes, but a
    // stopped process never reads them, so the screen cannot change anymore.
    frozen = descendantsOf(daemon.pid!);
    expect(frozen.length).toBeGreaterThan(0);
    for (const pid of frozen) { try { process.kill(pid, 'SIGSTOP'); } catch { /* raced exit */ } }
    sim('key', id, 'esc');
    await sleep(1500); // 출처: #39559 — session() 의 Esc 정착 1.5s 와 동일.
    const afterEsc = text();
    const marker = `esc-alive-${id}`;
    sim('type', id, marker);
    await sleep(1500); // 출처: #39559 — session() 의 마커 정착 1.5s 와 동일.
    const afterMarker = text();
    const checks = tuiChecks({ readyMs, first, help, afterEsc, marker, afterMarker });
    // The frozen screen never echoed the marker and produced no fresh frame …
    expect(afterMarker).not.toContain(marker);
    expect(afterMarker).toBe(afterEsc);
    // … the screen-remainder check still passes on the frozen frame (the vacuous hole, kept as
    // the documented behavior OP's probe proved) …
    expect(checks.find((c) => c.id === 'help-closes')!.pass).toBe(true);
    // … and esc-alive fails: a frozen session can never fake liveness.
    expect(checks.find((c) => c.id === 'esc-alive')!.pass).toBe(false);
  } finally {
    // Resume first so the daemon's SIGTERM can be delivered, then the regular teardown.
    for (const pid of frozen) { try { process.kill(pid, 'SIGCONT'); } catch { /* already gone */ } }
    spawnSync('bun', ['scripts/tui-sim.ts', 'stop', id], { cwd: repoRoot, encoding: 'utf8' });
    await sleep(3000); // 출처: #39559 — session() 의 stop 정착 3s 와 동일.
    spawnSync('bun', ['scripts/tui-sim.ts', 'clean', id], { cwd: repoRoot, encoding: 'utf8' });
    try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}, 120_000); // 출처: #39559 — boot 10s + ready 안정 + help 3s + esc 1.5s + marker 1.5s + teardown 3s 여유.