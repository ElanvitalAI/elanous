#!/usr/bin/env bun
/**
 * Release-loop ④ — run the PWA scenario suite on one commit, in isolation, and print one verdict.
 *
 *   bun scripts/release-loop/pwa-scenarios-node.ts --commit <sha> [--with-costly] [--reruns 2] [--json]
 *
 * Steps: temp worktree at <sha> → `nexus build` → isolated nexus (`--test`, leased test port)
 * → warm-up pass (discarded — the first page load after boot is slow and made T4a/N5a fail on the
 * 0.2.3 cut) → every scenario → rerun failed cells → stop nexus, remove worktree.
 * Never touches the production daemon or ~/.elanous.
 *
 * Exit: 0 = pass or flaky · 1 = fail · 2 = could not run (worktree, build, boot).
 * `--with-costly` adds scenarios that call a real model (C1).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, openSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decideVerdict, exitCodeFor, idsToRerun, type CellRun, type NodeVerdict } from './pwa-node-verdict';
import { envLiteral } from '../../src/platform/env-literal.js';

interface Options { commit: string; withCostly: boolean; reruns: number; json: boolean }

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { commit: '', withCostly: false, reruns: 2, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--commit') opts.commit = argv[++i] ?? '';
    else if (arg === '--with-costly') opts.withCostly = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--reruns') opts.reruns = Number(argv[++i] ?? '2');
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!/^[0-9a-f]{7,40}$/i.test(opts.commit)) throw new Error('--commit <sha> is required');
  if (!Number.isInteger(opts.reruns) || opts.reruns < 0 || opts.reruns > 5) throw new Error('--reruns must be 0..5');
  return opts;
}

const NO_PROXY_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?|all)_proxy$/i.test(k)));
const log = (msg: string) => process.stderr.write(`[pwa-node] ${msg}\n`);

function run(cmd: string, args: string[], cwd: string, timeoutMs = 600_000) {
  const r = spawnSync(cmd, args, { cwd, env: envLiteral(NO_PROXY_ENV), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { rc: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function scenarioRun(worktree: string, baseUrl: string, ids: readonly string[]): CellRun[] {
  const r = run('bun', ['scripts/pwa-scenarios.ts', '--base-url', baseUrl, '--only', ids.join(','), '--json'], worktree, 900_000);
  const line = r.stdout.split('\n').reverse().find((l) => l.trim().startsWith('{'));
  if (!line) throw new Error(`scenario runner produced no JSON (rc=${r.rc}): ${r.stderr.slice(-300)}`);
  const parsed = JSON.parse(line) as { results: Array<{ id: string; pass: boolean; blocked?: string }> };
  return parsed.results.map((c) => ({ id: c.id, pass: c.pass, blocked: Boolean(c.blocked) }));
}

async function main(): Promise<number> {
  let opts: Options;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { log(String(e)); return 2; }
  const repo = resolve('.');
  const work = mkdtempSync(join(tmpdir(), 'pwa-node-'));
  const worktree = join(work, 'tree');
  let nexusPid: number | undefined;
  let verdict: NodeVerdict | undefined;
  let failure: string | undefined;
  try {
    const add = run('git', ['worktree', 'add', '--detach', worktree, opts.commit], repo);
    if (add.rc !== 0) throw new Error(`worktree add failed: ${add.stderr.trim()}`);
    symlinkSync(join(repo, 'node_modules'), join(worktree, 'node_modules'));
    if (existsSync(join(repo, 'apps/pwa/node_modules'))) symlinkSync(join(repo, 'apps/pwa/node_modules'), join(worktree, 'apps/pwa/node_modules'));

    log(`build ${opts.commit.slice(0, 10)}`);
    const build = run('bun', ['bin/elanous.mjs', 'nexus', 'build'], worktree, 900_000);
    if (build.rc !== 0) throw new Error(`nexus build failed (rc=${build.rc})`);

    const nexusLog = join(work, 'nexus.log');
    const emptyCwd = mkdtempSync(join(work, 'cwd-'));
    const child = spawn('bun', ['bin/elanous.mjs', 'nexus', 'run', '--test', '--tool-cwd', emptyCwd], {
      cwd: worktree, env: envLiteral(NO_PROXY_ENV), detached: true, stdio: ['ignore', openSync(nexusLog, 'a'), openSync(nexusLog, 'a')],
    });
    child.unref();
    let port = '';
    await waitFor(() => {
      const m = /nexus +:(\d+)/.exec(existsSync(nexusLog) ? readFileSync(nexusLog, 'utf8') : '');
      if (m) port = m[1]!;
      const pid = /pid +(\d+)/.exec(existsSync(nexusLog) ? readFileSync(nexusLog, 'utf8') : '');
      if (pid) nexusPid = Number(pid[1]);
      return port !== '';
    }, 60_000, 'nexus port');
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(async () => {
      try { await fetch(`${baseUrl}/app/`); return true; } catch { return false; }
    }, 60_000, 'nexus http');
    log(`nexus up ${baseUrl} pid=${nexusPid ?? '?'}`);

    const list = run('bun', ['-e', `import('./scripts/lib/pwa-scenarios/scenarios.ts').then(m=>console.log(JSON.stringify(m.createScenarios().map(s=>({id:s.id,costly:!!s.costly})))))`], worktree);
    const all = JSON.parse(list.stdout.trim()) as Array<{ id: string; costly: boolean }>;
    const ids = all.filter((s) => opts.withCostly || !s.costly).map((s) => s.id);

    log('warm-up (discarded)');
    scenarioRun(worktree, baseUrl, ids.filter((id) => !all.find((s) => s.id === id)?.costly));

    log(`run ${ids.join(',')}`);
    const first = scenarioRun(worktree, baseUrl, ids);
    const reruns: CellRun[][] = [];
    let pending = idsToRerun(first);
    for (let i = 0; i < opts.reruns && pending.length > 0; i++) {
      log(`rerun ${i + 1}: ${pending.join(',')}`);
      const pass = scenarioRun(worktree, baseUrl, pending);
      reruns.push(pass);
      pending = pass.filter((r) => !r.pass || r.blocked).map((r) => r.id);
    }
    verdict = decideVerdict(first, reruns);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
    log(`could not run: ${failure}`);
  } finally {
    if (existsSync(worktree)) run('bun', ['bin/elanous.mjs', 'nexus', 'run', '--test', '--stop'], worktree, 60_000);
    if (nexusPid) { try { process.kill(nexusPid, 'SIGTERM'); } catch { /* already gone */ } }
    run('git', ['worktree', 'remove', '--force', worktree], repo);
  }

  const out = { verdict: verdict?.verdict ?? 'error', commit: opts.commit, withCostly: opts.withCostly, cells: verdict?.cells ?? [], ...(failure ? { error: failure } : {}) };
  if (opts.json) console.log(JSON.stringify(out));
  else {
    console.log(`pwa-node: ${out.verdict} · ${opts.commit.slice(0, 10)}`);
    for (const c of out.cells) console.log(`  ${c.id} ${c.final}${c.reruns.length ? ` (first ${c.first} · reruns ${c.reruns.join('/')})` : ''}`);
    if (failure) console.log(`  error: ${failure}`);
  }
  return verdict ? exitCodeFor(verdict.verdict) : 2;
}

process.exit(await main());
