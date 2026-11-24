// ELS-BUILD-BADGE: a pane that reports a build SHA which is a git ancestor of the desired SHA shows the badge
// `<sha7> older`, and `els ls --older` keeps exactly those panes. Real path end to end: a spawned `els serve` whose HOME holds a
// real bare git repo + DESIRED.json (the files the production resolver reads), real holder-hosted panes that hand their
// server-minted token to the test, the `build` report op over the socket, and the `side ls` / `side --list` CLI through simCli.
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestEls } from '../els/client.js';
import { simCli } from '../ux-sim/in-process-cli.js';

// 출처: a fresh `elanous` process boots, loads the journal and binds the socket in a few seconds on the gate hosts.
const SERVE_READY_MS = 20_000;
// 출처: the one scenario (one serve, four panes, a dozen client calls) finishes well inside this on the gate hosts.
const SCENARIO_MS = 120_000;
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();   // Unix socket paths are limited to 103 bytes; train TMPDIR is long
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const GIT_IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };

const dirs: string[] = [];
const stops: AbortController[] = [];
const tokenBefore = process.env.ELANOUS_ELS_PANE_TOKEN;
afterEach(() => {
  if (tokenBefore === undefined) delete process.env.ELANOUS_ELS_PANE_TOKEN; else process.env.ELANOUS_ELS_PANE_TOKEN = tokenBefore;
  for (const stop of stops.splice(0)) stop.abort();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix: string) => { const dir = realpathSync(mkdtempSync(join(SOCKET_SAFE_TMP, prefix))); dirs.push(dir); return dir; };

/** A bare repo where `older` is an ancestor of `desired` and `stray` is an unrelated root commit; DESIRED.json names `desired`. */
function makeHistory(home: string): { older: string; desired: string; stray: string } {
  const gitDir = join(home, 'elanous-hq', 'repo.git');
  mkdirSync(gitDir, { recursive: true });
  const git = (args: string[]) => {
    const done = spawnSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_IDENTITY } });
    expect(done.status, done.stderr).toBe(0);
    return done.stdout.trim();
  };
  git(['init', '--bare', '-q']);
  const older = git(['commit-tree', EMPTY_TREE, '-m', 'older']);
  const desired = git(['commit-tree', EMPTY_TREE, '-p', older, '-m', 'desired']);
  const stray = git(['commit-tree', EMPTY_TREE, '-m', 'stray']);
  const rail = join(home, 'elanous-hq', 'seat-state', 'OP', 'rail');
  mkdirSync(rail, { recursive: true });
  writeFileSync(join(rail, 'DESIRED.json'), JSON.stringify({ sha: desired }));
  return { older, desired, stray };
}

test('panes built from an ancestor of the desired SHA show the older badge and `els ls --older` keeps only them', async () => {
  const state = tempDir('els-bb-');
  const home = tempDir('els-bb-home-');
  const { older, desired, stray } = makeHistory(home);
  const cwd = tempDir('els-bb-cwd-');
  const env = { NODE_ENV: 'development', HERDR_ENV: '', HOME: home };   // the spawned server resolves $HOME/elanous-hq/... itself
  const side = (args: string[]) => simCli(['side', ...args], { mode: 'spawn', allowPaths: [['side']], stateRoot: state, cwd, env, timeoutMs: SCENARIO_MS });

  const stop = new AbortController();
  stops.push(stop);
  let served = '';
  void simCli(['side', 'serve'], {
    mode: 'spawn', allowPaths: [['side']], stateRoot: state, cwd: state, env, signal: stop.signal, killSignal: 'SIGKILL', timeoutMs: SCENARIO_MS,
    onStdout: (chunk) => { served += chunk; },
  });
  const deadline = Date.now() + SERVE_READY_MS;
  while (Date.now() < deadline && !served.includes('listening on')) await Bun.sleep(50);
  expect(served).toContain('listening on');
  const socket = join(state, 'els', 'els.sock');

  // A build report is mutating. The pane env does carry the server-minted 48-hex pane credential (registerSpawn — the pane
  // shell writes it out here; measured 11-24), but that credential is bound to its socket peer: a foreign process presenting
  // it is «auth: outsider» by design (server.ts paneRoleValid). So the report goes in as what the current door accepts from
  // this side of the socket — the same-uid credential-less caller (client.ts paneAuth → no auth frame, authorizeRequest).
  const open = async (title: string, sha: string | undefined): Promise<string> => {
    const tokenFile = join(cwd, `${title}.token`);
    const created = await side(['new', '--ws', 'HQ', '--cwd', cwd, '--title', title, '--', 'sh', '-c', `printf %s "$ELANOUS_ELS_PANE_TOKEN" > '${tokenFile}'; exec sh`]);
    expect(created.exitCode, created.stderr).toBe(0);
    const pane = (JSON.parse(created.stdout) as { pane: string }).pane;
    if (!sha) return pane;
    const tokenDeadline = Date.now() + SERVE_READY_MS;
    while (Date.now() < tokenDeadline && !(existsSync(tokenFile) && readFileSync(tokenFile, 'utf8').length > 0)) await Bun.sleep(20);
    // 실측 기대값(11-24): the pane env carries the minted 48-hex descent credential — the token is real; only the
    // test's presentation path was stale.
    expect(readFileSync(tokenFile, 'utf8')).toMatch(/^[0-9a-f]{48}$/);
    expect((await requestEls(socket, { op: 'build', pane, sha })).message).toBe('els build: recorded');
    return pane;
  };
  const paneOlder = await open('p-older', older);
  await open('p-current', desired);
  await open('p-stray', stray);
  await open('p-silent', undefined);

  type Row = { pane: string; title: string; build: { sha: string | null; age: string; desired: string | null; trusted: boolean } };
  // build-badge 의 createGitAncestor 는 비동기 캐시다(ELS-SERVER-MAINLOOP-STARVATION): 첫 ls 가 git
  // 자식의 답보다 빠르면 age 는 아직 'unknown' 이고 이후 macrotask 에 영구 memoize 된다. 확정될 때까지
  // 재요청한다 — deadline 폴(시험만, 제품 0행)이지 성능 단언이 아니다. --list 라인과 --older 필터는 이 확정 뒤에.
  const expectedAges: Record<string, string> = { 'p-older': 'older', 'p-current': 'current', 'p-stray': 'different', 'p-silent': 'unknown' };
  const settled = (rows: Row[]): boolean => (Object.keys(expectedAges) as string[]).every((title) => rows.find((row) => row.title === title)?.build.age === expectedAges[title]);
  let all = JSON.parse((await side(['ls'])).stdout) as { panes: Row[] };
  for (const deadline = Date.now() + 10_000; !settled(all.panes) && Date.now() < deadline;) {
    await Bun.sleep(50);
    all = JSON.parse((await side(['ls'])).stdout) as { panes: Row[] };
  }
  expect(Object.fromEntries(all.panes.map((row) => [row.title, row.build.age]))).toEqual(expectedAges);
  expect(all.panes.find((row) => row.pane === paneOlder)!.build).toMatchObject({ sha: older, desired, trusted: false });

  // The badge `els --list` prints: self-reported and unauthenticated, sha7 + age.
  const listed = await side(['--list']);
  expect(listed.exitCode, listed.stderr).toBe(0);
  const line = (title: string) => listed.stdout.split('\n').find((row) => row.includes(` ${title} `)) ?? '';
  expect(line('p-older')).toContain(`[자체보고·미인증:${older.slice(0, 7)} older]`);
  expect(line('p-current')).toContain(`[자체보고·미인증:${desired.slice(0, 7)} current]`);
  expect(line('p-stray')).toContain(`[자체보고·미인증:${stray.slice(0, 7)} different]`);
  expect(line('p-silent')).toContain('[자체보고·미인증:unknown unknown]');

  // --older: exactly the older panes, plus the notice that the badge is not a trust signal.
  const filtered = await side(['ls', '--older']);
  expect(filtered.exitCode, filtered.stderr).toBe(0);
  const only = JSON.parse(filtered.stdout) as { panes: Row[]; notice?: string };
  expect(only.panes.map((row) => row.title)).toEqual(['p-older']);
  expect(only.notice).toContain('미인증');
}, SCENARIO_MS);
