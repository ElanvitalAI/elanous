#!/usr/bin/env bun
/**
 * Release-loop ⑦ — boot the TUI of one commit in isolation and check it responds.
 *
 *   bun scripts/release-loop/tui-sim-node.ts --commit <sha> [--json]
 *
 * Steps: temp worktree at <sha> → `scripts/tui-sim.ts start --test` (that commit's code, the
 * repo's `.elanous-test` config so no first-run wizard) → first screen → `/help` → Esc → dump PNG
 * → stop, clean, remove worktree. Never touches the production daemon or ~/.elanous.
 * macOS only (the TUI PTY checks run on the mbp). One retry of the whole session → «flaky».
 *
 * Exit: 0 = pass or flaky · 1 = fail · 2 = could not run (not macOS, worktree).
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, openSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { tuiChecks, tuiVerdict, type TuiCheck } from './tui-node-checks';

const log = (msg: string) => process.stderr.write(`[tui-node] ${msg}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(args: string[], cwd: string, timeoutMs = 60_000) {
  const r = spawnSync('bun', args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return { rc: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function session(worktree: string, stateDir: string, id: string, work: string): Promise<{ checks: TuiCheck[]; png?: string }> {
  const sim = (...a: string[]) => run(['scripts/tui-sim.ts', ...a], worktree, 60_000);
  const startLog = join(work, `${id}.log`);
  const child = spawn('bun', ['scripts/tui-sim.ts', 'start', '--id', id, '--test', '--state-dir', stateDir, '--boot', '10'], {
    cwd: worktree, detached: true, stdio: ['ignore', openSync(startLog, 'a'), openSync(startLog, 'a')],
  });
  child.unref();
  const t0 = Date.now();
  let readyMs: number | null = null;
  try {
    while (Date.now() - t0 < 90_000) {
      if (/"ready": true/.test(sim('status', id).stdout)) { readyMs = Date.now() - t0; break; }
      await sleep(2000);
    }
    const text = () => sim('text', id).stdout;
    const first = readyMs === null ? '' : text();
    let help = '';
    let afterEsc = '';
    if (readyMs !== null) {
      sim('send', id, '/help');
      await sleep(3000);
      help = text();
      sim('key', id, 'esc');
      await sleep(1500);
      afterEsc = text();
    }
    const dump = readyMs === null ? '' : sim('dump', id, 'release-check').stderr;
    const inTree = /files: .*?(\S+\.png)/.exec(dump)?.[1];
    // The worktree is removed at the end — keep the screen next to it, in the temp work dir.
    let png: string | undefined;
    if (inTree && existsSync(inTree)) { png = join(work, basename(inTree)); copyFileSync(inTree, png); }
    return { checks: tuiChecks({ readyMs, first, help, afterEsc }), png };
  } finally {
    sim('stop', id);
    await sleep(3000);
    sim('clean', id);
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const commit = argv[argv.indexOf('--commit') + 1] ?? '';
  const json = argv.includes('--json');
  if (argv.indexOf('--commit') < 0 || !/^[0-9a-f]{7,40}$/i.test(commit)) { log('--commit <sha> is required'); return 2; }
  if (process.platform !== 'darwin') { log('macOS only — this node runs on the mbp'); return 2; }

  const repo = resolve('.');
  const stateDir = join(repo, '.elanous-test');
  const work = mkdtempSync(join(tmpdir(), 'tui-node-'));
  const worktree = join(work, 'tree');
  let attempts: Array<{ checks: TuiCheck[]; png?: string }> = [];
  let failure: string | undefined;
  try {
    const add = spawnSync('git', ['worktree', 'add', '--detach', worktree, commit], { cwd: repo, encoding: 'utf8' });
    if (add.status !== 0) throw new Error(`worktree add failed: ${(add.stderr ?? '').trim()}`);
    symlinkSync(join(repo, 'node_modules'), join(worktree, 'node_modules'));
    if (!existsSync(join(stateDir, 'config.json'))) log(`⚠ ${stateDir}/config.json missing — the TUI may open the first-run wizard`);
    const id = `rl-${commit.slice(0, 8)}-${Date.now().toString(36)}`;
    log(`session 1 (${id})`);
    attempts.push(await session(worktree, stateDir, id, work));
    if (tuiVerdict(attempts[0]!.checks) === 'fail') {
      log('session 2 (retry)');
      attempts.push(await session(worktree, stateDir, `${id}-r`, work));
    }
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
    log(`could not run: ${failure}`);
    attempts = [];
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repo });
  }

  const last = attempts.at(-1);
  const verdict = !last ? 'error' : tuiVerdict(last.checks) === 'fail' ? 'fail' : attempts.length > 1 ? 'flaky' : 'pass';
  const out = { verdict, commit, attempts: attempts.length, checks: last?.checks ?? [], png: last?.png, ...(failure ? { error: failure } : {}) };
  if (json) console.log(JSON.stringify(out));
  else {
    console.log(`tui-node: ${verdict} · ${commit.slice(0, 10)} · attempts ${attempts.length}`);
    for (const c of out.checks) console.log(`  ${c.pass ? '✓' : '✗'} ${c.id} — ${c.detail}`);
    if (out.png) console.log(`  screen: ${out.png}`);
    if (failure) console.log(`  error: ${failure}`);
  }
  return verdict === 'error' ? 2 : verdict === 'fail' ? 1 : 0;
}

process.exit(await main());
