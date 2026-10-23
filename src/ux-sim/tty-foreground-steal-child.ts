// TUI-SIGTTIN-SUSPEND (10-23 n8n) — child for the opt-in real-PTY repro in src/tty-foreground.test.ts.
// Brings the shared TUI layer up (initTui), then runs a login-env capture that steals the terminal:
//   STEAL_MODE=legacy  → the pre-fix spawn (no `detached`) · STEAL_MODE=current → runPrintenvCapture().
// Then reports its group vs. the tty's foreground group and echoes stdin so the parent can type a key.
import { spawnSync, execSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { initTui } from '../tui.js';
import { runPrintenvCapture } from '../shell-env-bootstrap.js';

initTui(false);
process.stdin.on('data', (d) => { process.stdout.write(`\r\nGOT:${String(d)}\r\n`); });
if (process.env.STEAL_MODE === 'legacy') {
  const opts: SpawnSyncOptionsWithStringEncoding = {
    env: { ...process.env, TERM: 'xterm' }, encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
  };
  spawnSync(process.env.SHELL ?? '/bin/zsh', ['-l', '-i', '-c', 'printenv'], opts);
} else {
  runPrintenvCapture();
}
const st = execSync(`ps -o pgid=,tpgid= -p ${process.pid}`).toString().trim().split(/\s+/);
process.stdout.write(`\r\nREADY pgid=${st[0]} tpgid=${st[1]}\r\n`);
setTimeout(() => process.exit(0), 15_000);
