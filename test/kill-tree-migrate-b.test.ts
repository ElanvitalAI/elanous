// KILL-TREE-ONE PR-b — characterization of two migrated sites with REAL detached children.
// Written against the pre-migration code first (must be green there), then the sites move to the
// shared terminateTree and these stay green. Only exact pids this test wrote are ever signalled.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchBash } from '../src/skills/tools/index';
import { closeLocalChatSession, runLocalChatTurn } from '../src/tui-client/local-chat-turn';

const SHELL_TIMEOUT_MS = 1_000; // SHELL_MIN_TIMEOUT_MS — the smallest allowed Bash timeout
const RETURN_SLACK_MS = 6_000; // grace(2s) + forced-close(2s) + load headroom
const CLOSE_BOUND_MS = 8_000;  // SIGTERM → grace(2s) → SIGKILL + load headroom
const dirs: string[] = [];
const pids: number[] = [];

afterEach(() => {
  for (const pid of pids.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function readPid(file: string): Promise<number> {
  for (let i = 0; i < 300 && !existsSync(file); i++) await Bun.sleep(10);
  const pid = Number(readFileSync(file, 'utf8').trim());
  pids.push(pid);
  return pid;
}

test('Bash timeout kills the whole group — a SIGTERM-ignoring grandchild is SIGKILLed, result returns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ktb-bash-'));
  dirs.push(dir);
  const gcPid = join(dir, 'gc.pid');
  // The shell waits; the grandchild ignores TERM/HUP/INT and keeps running in the same group.
  const script = join(dir, 'gc.sh');
  writeFileSync(script, `trap '' TERM HUP INT\necho $$ > ${gcPid}\nwhile :; do sleep 1; done\n`);
  const command = `sh ${script} & wait`;
  const started = Date.now();
  const r = await dispatchBash({ command, timeout: SHELL_TIMEOUT_MS }, { cwd: dir });
  const elapsed = Date.now() - started;
  expect(r.timedOut).toBe(true);
  expect(elapsed).toBeLessThan(SHELL_TIMEOUT_MS + RETURN_SLACK_MS);
  const gc = await readPid(gcPid);
  for (let i = 0; i < 100 && alive(gc); i++) await Bun.sleep(50);
  expect(alive(gc)).toBe(false);
}, 20_000);

test('Bash abort stops the group — descendants of a plain sleep chain are gone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ktb-abort-'));
  dirs.push(dir);
  const pidFile = join(dir, 'sleep.pid');
  const ac = new AbortController();
  const pending = dispatchBash({ command: `sleep 60 & echo $! > ${JSON.stringify(pidFile)}; wait` }, { cwd: dir, signal: ac.signal });
  const sleepPid = await readPid(pidFile);
  ac.abort();
  await pending;
  for (let i = 0; i < 100 && alive(sleepPid); i++) await Bun.sleep(50);
  expect(alive(sleepPid)).toBe(false);
}, 20_000);

test('closing a Next TUI REPL child that ignores SIGTERM escalates to SIGKILL on that exact pid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ktb-repl-'));
  dirs.push(dir);
  const cli = join(dir, 'term-deaf-cli.ts');
  const pidFile = join(dir, 'pid');
  writeFileSync(cli, `
    import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => { /* deaf */ });
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    setInterval(() => {}, 1000);
  `);
  // A turn that never answers: abort it, then close — the child is wedged and deaf to SIGTERM.
  const ac = new AbortController();
  const turn = runLocalChatTurn('ktb-deaf', 'prompt', ac.signal, cli).catch(() => 'rejected');
  const pid = await readPid(pidFile);
  ac.abort();
  await turn;
  const started = Date.now();
  await closeLocalChatSession('ktb-deaf');
  expect(Date.now() - started).toBeLessThan(CLOSE_BOUND_MS);
  for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(50);
  expect(alive(pid)).toBe(false);
}, 30_000);
