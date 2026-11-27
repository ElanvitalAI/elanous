// THROUGHPUT-GIT-CWD-E4 — real-process proof of #40332 (THROUGHPUT-GIT-CWD).
// Reviewed before this file:
//   src/loops/throughput-repo-root.test.ts — temp git init, origin/main via update-ref, cleanup.
//   src/cli/land-graph-cli.e2e.test.ts — scratch universe, fake gh, isolated state/seat-state, cleanup.
//   src/loops/op-pulse-cli.ts — `pulse throughput` is read-only unless --execute; --json prints the live verdict.
// Expectations are literals. Product constants and render helpers are not imported.
// Caller the child hits: bin/elanous.mjs → src/index.ts runCli → registerPulseCommands
//   → pulse throughput → liveThroughputSnapshot → resolveDevRepoRoot (throughput-controller-live.ts).
import { simCli } from '../ux-sim/in-process-cli.js';
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const WORKTREE = resolve(import.meta.dir, '../..');
const scratch = mkdtempSync(join(tmpdir(), 'tp-cwd-e4-'));
const repo = join(scratch, 'repo');
const code = join(scratch, 'code');
const outside = join(scratch, 'cwd');
const home = join(scratch, 'home');
const stateDir = join(scratch, 'state');
const seatState = join(scratch, 'seat-state');
const ghDir = join(scratch, 'fake-bin');
const ghLog = join(scratch, 'gh.log');
const entry = join(code, 'bin', 'elanous.mjs');

// The scratch holds a full copy of the tree (node_modules included) — removing it can take longer than bun's 5 s hook default on a loaded host.
afterAll(() => rmSync(scratch, { recursive: true, force: true }), 120_000);

function originMain(dir: string): boolean {
  return spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', 'origin/main'], { encoding: 'utf8' }).status === 0;
}

function git(cwd: string, args: string[], dates?: string): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(scratch, 'empty-gitconfig'),
  };
  if (dates) {
    env.GIT_AUTHOR_DATE = dates;
    env.GIT_COMMITTER_DATE = dates;
  }
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function copyCodeTree(): void {
  const cloned = spawnSync('/bin/cp', ['-cR', WORKTREE, code], { encoding: 'utf8' });
  if (cloned.status !== 0) {
    const plain = spawnSync('/bin/cp', ['-R', WORKTREE, code], { encoding: 'utf8' });
    if (plain.status !== 0) throw new Error(`cp code tree: ${cloned.stderr || plain.stderr}`);
  }
  rmSync(join(code, '.git'), { recursive: true, force: true });
}

function childEnv(elanousRepo?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: `${ghDir}${delimiter}${process.env.PATH ?? ''}`,
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: process.env.LANG ?? 'C',
    NODE_ENV: 'test',
    ELANOUS_SEAT_STATE: seatState,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(scratch, 'empty-gitconfig'),
    GH_LOG: ghLog,
  };
  if (process.env.USER) env.USER = process.env.USER;
  if (elanousRepo) env.ELANOUS_REPO = elanousRepo;
  return env;
}

async function runThroughput(env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  // R-LIVE10 — the CLI child goes through the simCli single door (spawn mode · the copied tree's entry · isolated state root).
  const r = await simCli(['pulse', 'throughput', '--json'], {
    mode: 'spawn', entrypoint: entry, stateRoot: stateDir, cwd: outside, env,
    allowPaths: [['pulse', 'throughput']], timeoutMs: 150_000, stdinText: '',
  });
  return { status: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

function landsOf(stdout: string): { lands: unknown; unmeasured: string[] } {
  const line = stdout.split('\n').map(s => s.trim()).filter(s => s.startsWith('{')).at(-1);
  if (!line) throw new Error(`stdout had no JSON:\n${stdout.slice(0, 800)}`);
  const body = JSON.parse(line) as { verdict?: { measured?: { lands?: unknown }; unmeasured?: string[] } };
  return { lands: body.verdict?.measured?.lands, unmeasured: body.verdict?.unmeasured ?? [] };
}

describe('THROUGHPUT-GIT-CWD-E4: 저장소 밖 CLI가 병합 2건을 측정하고 저장소 미발견을 미측정으로 표시한다', () => {
  test('저장소 밖 cwd 실프로세스가 착지 2를 읽고, 후보가 없으면 0이 아닌 미측정이다', async () => {
    mkdirSync(repo, { recursive: true });
    mkdirSync(outside, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(seatState, { recursive: true });
    mkdirSync(ghDir, { recursive: true });
    writeFileSync(join(scratch, 'empty-gitconfig'), '');
    writeFileSync(join(stateDir, 'config.json'), '{}\n');
    writeFileSync(join(ghDir, 'gh'), '#!/bin/sh\nif [ -n "$GH_LOG" ]; then printf \'%s\\n\' "$*" >> "$GH_LOG"; fi\nprintf \'%s\\n\' \'[]\'\nexit 0\n');
    chmodSync(join(ghDir, 'gh'), 0o755);
    copyCodeTree();

    const when = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'init'], when);
    git(repo, ['checkout', '-q', '-b', 'side-a']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'side a'], when);
    git(repo, ['checkout', '-q', 'main']);
    git(repo, ['merge', '--no-ff', '-q', '-m', 'land (#101)', 'side-a'], when);
    git(repo, ['checkout', '-q', '-b', 'side-b']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'side b'], when);
    git(repo, ['checkout', '-q', 'main']);
    git(repo, ['merge', '--no-ff', '-q', '-m', 'land (#202)', 'side-b'], when);
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    expect(existsSync(entry)).toBe(true);
    expect(existsSync(join(code, '.git'))).toBe(false);
    expect(originMain(repo)).toBe(true);
    expect(originMain(code)).toBe(false);
    expect(originMain(join(home, 'elanous-hq', 'repo.git'))).toBe(false);
    expect(JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8')).repo?.path).toBeUndefined();
    expect(outside.startsWith(repo)).toBe(false);
    expect(outside.startsWith(code)).toBe(false);
    expect(git(repo, ['rev-list', '--merges', '--count', 'origin/main'])).toBe('2');
    const tagged = git(repo, ['log', 'origin/main', `--since=${new Date(Date.now() - 3_600_000).toISOString()}`, '--format=%s'])
      .split('\n').filter(line => /\(#\d+\)\s*$/u.test(line));
    expect(tagged).toEqual(['land (#202)', 'land (#101)']);

    const found = await runThroughput(childEnv(repo));
    if (found.status !== 0) throw new Error(`found exit ${found.status}\n${found.stdout.slice(-1200)}\n${found.stderr.slice(-1200)}`);
    expect(found.stdout).toContain('"lands":2');
    expect(landsOf(found.stdout).lands).toBe(2);
    expect(readFileSync(ghLog, 'utf8')).toContain('pr list');

    rmSync(ghLog, { force: true });
    const missingEnv = childEnv();
    expect(missingEnv.ELANOUS_REPO).toBeUndefined();
    const missing = await runThroughput(missingEnv);
    if (missing.status !== 0) throw new Error(`missing exit ${missing.status}\n${missing.stdout.slice(-1200)}\n${missing.stderr.slice(-1200)}`);
    const unread = landsOf(missing.stdout);
    expect(missing.stdout).toContain('"lands":null');
    expect(missing.stdout).not.toContain('"lands":0');
    expect(unread.lands).toBe(null);
    expect(unread.lands).not.toBe(0);
    expect(unread.unmeasured.some(item => item.includes('lands'))).toBe(true);
  }, 300_000);
});
