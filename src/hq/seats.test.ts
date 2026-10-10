import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hqWork } from './seats.js';

let temp: string;
let home: string;
let remote: string;
let seed: string;
const cli = join(import.meta.dir, '../../bin/elanous.mjs');
function command(bin: string, args: string[], cwd = temp, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(bin, args, { cwd, env, encoding: 'utf8', timeout: 60_000 });
}
function git(args: string[], cwd = temp): string {
  const r = command('git', args, cwd);
  expect(r.status, `${args.join(' ')}: ${r.stderr}`).toBe(0);
  return r.stdout.trim();
}
function hq(...args: string[]) {
  return command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', ...args], temp, { ...process.env, HOME: home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
}
function fixture() {
  remote = join(temp, 'remote.git');
  seed = join(temp, 'seed');
  git(['init', '--bare', remote]);
  git(['init', '-b', 'main', seed]);
  git(['config', 'user.name', 'Fixture'], seed);
  git(['config', 'user.email', 'fixture@example.test'], seed);
  writeFileSync(join(seed, 'README'), 'base\n');
  git(['add', 'README'], seed);
  git(['commit', '-m', 'base'], seed);
  git(['remote', 'add', 'origin', remote], seed);
  git(['push', '-u', 'origin', 'main'], seed);
}
beforeEach(() => {
  // Real path: macOS tmpdir is a /var symlink, and house.json records resolved paths.
  temp = realpathSync(mkdtempSync(join(tmpdir(), 'hq-seats-')));
  home = join(temp, 'home');
  mkdirSync(home);
  fixture();
});
afterEach(() => rmSync(temp, { recursive: true, force: true }));

test('empty HOME: init → seat → work new → merge into bare remote → done, with premerge refusal', () => {
  const root = join(home, 'elanous-hq');
  // init reads the source remote of the invoking checkout; this fixture invokes from a local seed checkout.
  const actualHouse = join(home, 'configured-house');
  mkdirSync(actualHouse);
  const created = command('bun', [cli, `--test=${join(home, 'test-state')}`, '--config-dir', actualHouse, 'hq', 'init', '--root', root], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(created.status, created.stderr).toBe(0);
  expect(created.stdout).toContain('*/5 * * * *');
  expect(created.stdout).toContain('fetch origin');
  // cron's minimal PATH: the refresh command is named by absolute runtime and CLI paths, not a bare `elanous`.
  expect(created.stdout).toContain(`'${process.execPath}' '${cli}' hq seat TC --refresh`);
  expect(created.stdout).not.toContain('|| elanous ');
  expect(existsSync(join(root, 'repo.git', 'HEAD'))).toBe(true);
  expect(existsSync(join(home, '.elanous-hq', 'host'))).toBe(false);
  const again = command('bun', [cli, `--test=${join(home, 'test-state')}`, '--config-dir', actualHouse, 'hq', 'init', '--root', root], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(again.status, again.stderr).toBe(0);
  expect(again.stdout).toContain('already exists');
  expect(hq('seat', 'TC').status).toBe(0);
  const seat = join(root, 'seats', 'TC');
  expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], seat)).toBe('HEAD');
  expect(hq('seat', 'TC', '--refresh').status).toBe(0);
  // Seats are disposable: a seat folder deleted by hand is recreated by the same command.
  rmSync(seat, { recursive: true, force: true });
  // The remote moved on since the last fetch: a newly created seat must start from the new origin/main.
  writeFileSync(join(seed, 'ahead'), 'ahead\n');
  git(['add', 'ahead'], seed);
  git(['commit', '-m', 'ahead'], seed);
  git(['push', 'origin', 'main'], seed);
  const recreated = hq('seat', 'TC');
  expect(recreated.status, recreated.stderr).toBe(0);
  expect(recreated.stdout).toContain('created');
  expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], seat)).toBe('HEAD');
  expect(git(['rev-parse', 'HEAD'], seat)).toBe(git(['rev-parse', 'HEAD'], seed));
  expect(hq('work', 'new', 'TC', 'fix1').status).toBe(0);
  const work = join(root, 'work', 'TC-fix1');
  const ledger = JSON.parse(readFileSync(join(root, 'house.json'), 'utf8'));
  expect(ledger.home).toEqual({ kind: 'home', path: actualHouse, source: 'cli-resolved' });
  expect(existsSync(ledger.home.path)).toBe(true);
  expect(ledger.sandboxes[work]).toEqual({ kind: 'sandbox', path: join(work, '.elanous-test'), owner: 'TC' });
  expect(existsSync(ledger.sandboxes[work].path)).toBe(true);
  // Ordinary work fills the sandbox; it must neither dirty the work nor block a merged done.
  mkdirSync(join(work, '.elanous-test', 'state'));
  writeFileSync(join(work, '.elanous-test', 'state', 'run.log'), 'sandbox data\n');
  expect(git(['status', '--porcelain'], work)).toBe('');
  writeFileSync(join(work, 'fix'), 'fixed\n');
  git(['add', 'fix'], work);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fix1'], work);
  const refused = hq('work', 'done', 'TC', 'fix1');
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('not merged');
  expect(existsSync(work)).toBe(true);
  git(['remote', 'add', 'hq-work', join(root, 'repo.git')], seed);
  git(['fetch', 'hq-work', 'work/TC-fix1'], seed);
  git(['merge', '--ff-only', 'FETCH_HEAD'], seed);
  git(['push', 'origin', 'main'], seed);
  const done = hq('work', 'done', 'TC', 'fix1');
  expect(done.status, done.stderr).toBe(0);
  expect(existsSync(work)).toBe(false);
  expect(JSON.parse(readFileSync(join(root, 'house.json'), 'utf8')).sandboxes).toEqual({});
  expect(hq('seat', 'TC', '--refresh').status).toBe(0);
  expect(git(['rev-parse', 'HEAD'], seat)).toBe(git(['rev-parse', 'HEAD'], seed));
  // The printed cron command itself, run with cron's minimal environment, fetches and advances the seat.
  writeFileSync(join(seed, 'cron'), 'cron\n');
  git(['add', 'cron'], seed);
  git(['commit', '-m', 'cron'], seed);
  git(['push', 'origin', 'main'], seed);
  const cronCommand = created.stdout.split('\n').find(line => line.startsWith('*/5 * * * * '))!.slice('*/5 * * * * '.length);
  const cronRun = spawnSync('/bin/sh', ['-c', cronCommand], { cwd: home, env: { PATH: '/usr/bin:/bin', HOME: home }, encoding: 'utf8', timeout: 60_000 });
  expect(cronRun.status, cronRun.stderr).toBe(0);
  expect(git(['rev-parse', 'HEAD'], seat)).toBe(git(['rev-parse', 'HEAD'], seed));
}, 120_000);

test('work done accepts a clean squash-landed tip with a nonempty changed-file list', () => {
  const root = join(home, 'elanous-hq');
  const init = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(init.status, init.stderr).toBe(0);
  expect(hq('work', 'new', 'TC', 'squash').status).toBe(0);
  const work = join(root, 'work', 'TC-squash');
  writeFileSync(join(work, 'squashed'), 'landed\n');
  git(['add', 'squashed'], work);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'work'], work);
  const tip = git(['rev-parse', 'HEAD'], work);
  writeFileSync(join(seed, 'squashed'), 'landed\n');
  writeFileSync(join(seed, 'other-main-change'), 'unrelated\n');
  git(['add', 'squashed', 'other-main-change'], seed);
  git(['commit', '-m', 'squash landed'], seed);
  git(['push', 'origin', 'main'], seed);
  expect(git(['rev-parse', 'HEAD'], seed)).not.toBe(tip);
  const done = hq('work', 'done', 'TC', 'squash');
  expect(done.status, done.stderr).toBe(0);
  expect(existsSync(work)).toBe(false);
  expect(JSON.parse(readFileSync(join(root, 'house.json'), 'utf8')).sandboxes[work]).toBeUndefined();
}, 120_000);

test('work done keeps a worktree whose different attached branch has an unlanded current tip', () => {
  const root = join(home, 'elanous-hq');
  const init = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(init.status, init.stderr).toBe(0);
  expect(hq('work', 'new', 'TC', 'switched').status).toBe(0);
  const work = join(root, 'work', 'TC-switched');
  writeFileSync(join(work, 'landed'), 'landed\n');
  git(['add', 'landed'], work);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'landed'], work);
  const originalTip = git(['rev-parse', 'HEAD'], work);
  writeFileSync(join(seed, 'landed'), 'landed\n');
  git(['add', 'landed'], seed);
  git(['commit', '-m', 'squash landed'], seed);
  git(['push', 'origin', 'main'], seed);
  git(['switch', '-c', 'work/TC-different'], work);
  writeFileSync(join(work, 'not-landed'), 'unfinished\n');
  git(['add', 'not-landed'], work);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'unfinished'], work);
  const currentTip = git(['rev-parse', 'HEAD'], work);
  const refused = hq('work', 'done', 'TC', 'switched');
  expect(refused.status).toBe(1);
  expect(existsSync(work)).toBe(true);
  expect(git(['symbolic-ref', '--short', 'HEAD'], work)).toBe('work/TC-different');
  expect(git(['rev-parse', 'HEAD'], work)).toBe(currentTip);
  expect(git(['--git-dir', join(root, 'repo.git'), 'rev-parse', 'refs/heads/work/TC-switched'])).toBe(originalTip);
  expect(JSON.parse(readFileSync(join(root, 'house.json'), 'utf8')).sandboxes[work]).toBeDefined();
}, 120_000);

test('work done keeps an unlanded registered tip even if a different attached tip landed', () => {
  const root = join(home, 'elanous-hq');
  const init = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(init.status, init.stderr).toBe(0);
  expect(hq('work', 'new', 'TC', 'own-unlanded').status).toBe(0);
  const work = join(root, 'work', 'TC-own-unlanded');
  writeFileSync(join(work, 'unfinished'), 'keep this branch\n');
  git(['add', 'unfinished'], work);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'unfinished'], work);
  const originalTip = git(['rev-parse', 'HEAD'], work);
  git(['switch', '-c', 'work/TC-other-landed', 'refs/remotes/origin/main'], work);
  writeFileSync(join(work, 'finished'), 'landed\n');
  git(['add', 'finished'], work);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'finished'], work);
  const checkoutTip = git(['rev-parse', 'HEAD'], work);
  writeFileSync(join(seed, 'finished'), 'landed\n');
  git(['add', 'finished'], seed);
  git(['commit', '-m', 'squash finished'], seed);
  git(['push', 'origin', 'main'], seed);
  const refused = hq('work', 'done', 'TC', 'own-unlanded');
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('not merged');
  expect(existsSync(work)).toBe(true);
  expect(git(['symbolic-ref', '--short', 'HEAD'], work)).toBe('work/TC-other-landed');
  expect(git(['rev-parse', 'HEAD'], work)).toBe(checkoutTip);
  expect(git(['--git-dir', join(root, 'repo.git'), 'rev-parse', 'refs/heads/work/TC-own-unlanded'])).toBe(originalTip);
  expect(JSON.parse(readFileSync(join(root, 'house.json'), 'utf8')).sandboxes[work]).toBeDefined();
}, 120_000);

test('work done on a different attached branch proves its tip and preserves that branch', () => {
  const root = join(home, 'elanous-hq');
  const init = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(init.status, init.stderr).toBe(0);
  expect(hq('work', 'new', 'TC', 'switched-done').status).toBe(0);
  const work = join(root, 'work', 'TC-switched-done');
  const originalTip = git(['rev-parse', 'HEAD'], work);
  git(['switch', '-c', 'work/TC-landed'], work);
  writeFileSync(join(work, 'landed'), 'same contents\n');
  git(['add', 'landed'], work);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'work tip'], work);
  const currentTip = git(['rev-parse', 'HEAD'], work);
  writeFileSync(join(seed, 'landed'), 'same contents\n');
  git(['add', 'landed'], seed);
  git(['commit', '-m', 'squashed tip'], seed);
  git(['push', 'origin', 'main'], seed);
  const done = hq('work', 'done', 'TC', 'switched-done');
  expect(done.status, done.stderr).toBe(0);
  expect(existsSync(work)).toBe(false);
  expect(git(['--git-dir', join(root, 'repo.git'), 'rev-parse', 'refs/heads/work/TC-landed'])).toBe(currentTip);
  expect(command('git', ['--git-dir', join(root, 'repo.git'), 'rev-parse', '--verify', '--quiet', 'refs/heads/work/TC-switched-done']).status).toBe(1);
  expect(JSON.parse(readFileSync(join(root, 'house.json'), 'utf8')).sandboxes[work]).toBeUndefined();
  expect(currentTip).not.toBe(originalTip);
}, 120_000);

test('work done keeps a different attached branch when checkout is blocked by its work lock', () => {
  const root = join(home, 'elanous-hq');
  const init = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(init.status, init.stderr).toBe(0);
  expect(hq('work', 'new', 'TC', 'other-busy').status).toBe(0);
  const work = join(root, 'work', 'TC-other-busy');
  const ownTip = git(['rev-parse', 'HEAD'], work);
  git(['switch', '-c', 'work/TC-other-busy-tip'], work);
  writeFileSync(join(work, 'same'), 'landed\n');
  git(['add', 'same'], work);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'landed'], work);
  const checkoutTip = git(['rev-parse', 'HEAD'], work);
  writeFileSync(join(seed, 'same'), 'landed\n');
  git(['add', 'same'], seed);
  git(['commit', '-m', 'squash landed'], seed);
  git(['push', 'origin', 'main'], seed);
  const lock = join(git(['rev-parse', '--absolute-git-dir'], work), 'index.lock');
  writeFileSync(lock, '');
  const refused = hq('work', 'done', 'TC', 'other-busy');
  rmSync(lock);
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('index.lock');
  expect(existsSync(work)).toBe(true);
  expect(git(['symbolic-ref', '--short', 'HEAD'], work)).toBe('work/TC-other-busy-tip');
  expect(git(['rev-parse', 'HEAD'], work)).toBe(checkoutTip);
  expect(git(['--git-dir', join(root, 'repo.git'), 'rev-parse', 'refs/heads/work/TC-other-busy'])).toBe(ownTip);
  expect(JSON.parse(readFileSync(join(root, 'house.json'), 'utf8')).sandboxes[work]).toBeDefined();
}, 120_000);

test('work done resumes an interrupted different-branch removal using the recorded checkout tip', () => {
  const root = join(home, 'elanous-hq');
  const init = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(init.status, init.stderr).toBe(0);
  expect(hq('work', 'new', 'TC', 'resume-switched').status).toBe(0);
  const work = join(root, 'work', 'TC-resume-switched');
  const ownTip = git(['rev-parse', 'HEAD'], work);
  git(['switch', '-c', 'work/TC-resume-landed'], work);
  writeFileSync(join(work, 'resumed'), 'same contents\n');
  git(['add', 'resumed'], work);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'branch tip'], work);
  const checkoutTip = git(['rev-parse', 'HEAD'], work);
  writeFileSync(join(seed, 'resumed'), 'same contents\n');
  git(['add', 'resumed'], seed);
  git(['commit', '-m', 'landed contents'], seed);
  git(['push', 'origin', 'main'], seed);
  const ledgerFile = join(root, 'house.json');
  const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'));
  ledger.sandboxes[work] = { ...ledger.sandboxes[work], reclaiming: ownTip,
    checkoutBranch: 'work/TC-resume-landed', checkoutTip };
  writeFileSync(ledgerFile, JSON.stringify(ledger));
  git(['checkout', '--quiet', '--detach'], work);
  const resumed = hq('work', 'done', 'TC', 'resume-switched');
  expect(resumed.status, resumed.stderr).toBe(0);
  expect(existsSync(work)).toBe(false);
  expect(git(['--git-dir', join(root, 'repo.git'), 'rev-parse', 'refs/heads/work/TC-resume-landed'])).toBe(checkoutTip);
  expect(JSON.parse(readFileSync(ledgerFile, 'utf8')).sandboxes[work]).toBeUndefined();
}, 120_000);

test('work done refuses an empty changed-file list when main moves past an empty work commit', () => {
  const root = join(home, 'elanous-hq');
  const init = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(init.status, init.stderr).toBe(0);
  expect(hq('work', 'new', 'TC', 'empty').status).toBe(0);
  const work = join(root, 'work', 'TC-empty');
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'empty'], work);
  const tip = git(['rev-parse', 'HEAD'], work);
  writeFileSync(join(seed, 'main-only'), 'main changed\n');
  git(['add', 'main-only'], seed);
  git(['commit', '-m', 'advance main'], seed);
  git(['push', 'origin', 'main'], seed);
  const refused = hq('work', 'done', 'TC', 'empty');
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('not merged');
  expect(existsSync(work)).toBe(true);
  expect(git(['--git-dir', join(root, 'repo.git'), 'rev-parse', 'refs/heads/work/TC-empty'])).toBe(tip);
  expect(JSON.parse(readFileSync(join(root, 'house.json'), 'utf8')).sandboxes[work]).toBeDefined();
}, 120_000);

test('work done rejects a clean unlanded change despite equal unrelated paths and keeps branch and ledger', () => {
  const root = join(home, 'elanous-hq');
  const init = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(init.status, init.stderr).toBe(0);
  expect(hq('work', 'new', 'TC', 'unlanded').status).toBe(0);
  const work = join(root, 'work', 'TC-unlanded');
  writeFileSync(join(work, 'missing'), 'not landed\n');
  git(['add', 'missing'], work);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'not landed'], work);
  const tip = git(['rev-parse', 'HEAD'], work);
  writeFileSync(join(seed, 'unrelated'), 'new main path\n');
  git(['add', 'unrelated'], seed);
  git(['commit', '-m', 'unrelated'], seed);
  git(['push', 'origin', 'main'], seed);
  const refused = hq('work', 'done', 'TC', 'unlanded');
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('not merged');
  expect(existsSync(work)).toBe(true);
  expect(git(['symbolic-ref', '--short', 'HEAD'], work)).toBe('work/TC-unlanded');
  expect(git(['--git-dir', join(root, 'repo.git'), 'rev-parse', 'refs/heads/work/TC-unlanded'])).toBe(tip);
  expect(JSON.parse(readFileSync(join(root, 'house.json'), 'utf8')).sandboxes[work]).toBeDefined();
}, 120_000);

test('work done refuses a branch that gained an unmerged commit after its merge, keeping work and branch', () => {
  const root = join(home, 'elanous-hq');
  const init = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(init.status, init.stderr).toBe(0);
  expect(hq('work', 'new', 'TC', 'late').status).toBe(0);
  const work = join(root, 'work', 'TC-late');
  const commit = (file: string) => {
    writeFileSync(join(work, file), `${file}\n`);
    git(['add', file], work);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', file], work);
  };
  commit('merged');
  git(['remote', 'add', 'hq-work', join(root, 'repo.git')], seed);
  git(['fetch', 'hq-work', 'work/TC-late'], seed);
  git(['merge', '--ff-only', 'FETCH_HEAD'], seed);
  git(['push', 'origin', 'main'], seed);
  commit('unmerged');
  const tip = git(['rev-parse', 'HEAD'], work);
  const refused = hq('work', 'done', 'TC', 'late');
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('not merged');
  expect(existsSync(work)).toBe(true);
  expect(git(['--git-dir', join(root, 'repo.git'), 'rev-parse', 'refs/heads/work/TC-late'])).toBe(tip);
  expect(JSON.parse(readFileSync(join(root, 'house.json'), 'utf8')).sandboxes[work]).toBeDefined();
}, 120_000);

test('failed ledger saves roll back work new and done, and done reconciles a vanished registered work', () => {
  const root = join(home, 'elanous-hq');
  const init = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(init.status, init.stderr).toBe(0);
  const bare = join(root, 'repo.git');
  const work = join(root, 'work', 'TC-retry');
  // saveLedger writes house.json.<pid>.tmp exclusively; occupying that name makes this process's save fail.
  const blocker = join(root, `house.json.${process.pid}.tmp`);
  writeFileSync(blocker, '');
  expect(() => hqWork('new', 'TC', 'retry', { root })).toThrow('work registration failed (rolled back)');
  expect(existsSync(work)).toBe(false);
  expect(spawnSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/work/TC-retry']).status).toBe(1);
  // If something wrote into the fresh work before the save failed, the rollback keeps it instead of forcing.
  const hook = join(bare, 'hooks', 'post-checkout');
  writeFileSync(hook, '#!/bin/sh\necho hooked > hooked.txt\n');
  chmodSync(hook, 0o755);
  const kept = join(root, 'work', 'TC-kept');
  expect(() => hqWork('new', 'TC', 'kept', { root })).toThrow('work registration failed (work kept: it changed after creation');
  // Files the hook writes into the ignored sandbox count as changes too.
  writeFileSync(hook, '#!/bin/sh\nmkdir -p .elanous-test && echo hooked > .elanous-test/hooked.txt\n');
  const keptIgnored = join(root, 'work', 'TC-kept-ignored');
  expect(() => hqWork('new', 'TC', 'kept-ignored', { root })).toThrow('work kept: it changed after creation');
  expect(readFileSync(join(keptIgnored, '.elanous-test', 'hooked.txt'), 'utf8')).toBe('hooked\n');
  rmSync(hook);
  expect(readFileSync(join(kept, 'hooked.txt'), 'utf8')).toBe('hooked\n');
  expect(spawnSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/work/TC-kept']).status).toBe(0);
  rmSync(blocker);
  expect(hqWork('new', 'TC', 'retry', { root }).outcome).toBe('created');
  expect(JSON.parse(readFileSync(join(root, 'house.json'), 'utf8')).sandboxes[work]).toBeDefined();
  writeFileSync(join(work, 'retry'), 'retry\n');
  git(['add', 'retry'], work);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'retry'], work);
  git(['remote', 'add', 'hq-work', bare], seed);
  git(['fetch', 'hq-work', 'work/TC-retry'], seed);
  git(['merge', '--ff-only', 'FETCH_HEAD'], seed);
  git(['push', 'origin', 'main'], seed);
  const ref = 'refs/heads/work/TC-retry';
  const tip = git(['--git-dir', bare, 'rev-parse', ref]);
  writeFileSync(blocker, '');
  // A done whose ledger save fails removes nothing: work folder, branch, attached HEAD and registration stay.
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(() => hqWork('done', 'TC', 'retry', { root })).toThrow();
    expect(existsSync(work)).toBe(true);
    expect(git(['--git-dir', bare, 'rev-parse', ref])).toBe(tip);
    expect(git(['symbolic-ref', '--short', 'HEAD'], work)).toBe('work/TC-retry');
    expect(git(['status', '--porcelain'], work)).toBe('');
    expect(JSON.parse(readFileSync(join(root, 'house.json'), 'utf8')).sandboxes[work]).toBeDefined();
  }
  rmSync(blocker);
  expect(hqWork('done', 'TC', 'retry', { root }).outcome).toBe('removed');
  expect(existsSync(work)).toBe(false);
  expect(JSON.parse(readFileSync(join(root, 'house.json'), 'utf8')).sandboxes).toEqual({});
  expect(spawnSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', ref]).status).toBe(1);
  expect(() => hqWork('done', 'TC', 'retry', { root })).toThrow('work does not exist');
  // A registered work whose folder vanished but whose merged branch remains is reconciled by done.
  expect(hqWork('new', 'TC', 'gone', { root }).outcome).toBe('created');
  const gone = join(root, 'work', 'TC-gone');
  // The folder vanished without git knowing; another work is only briefly missing (moved aside) and must survive.
  rmSync(gone, { recursive: true, force: true });
  expect(hqWork('new', 'OP', 'away', { root }).outcome).toBe('created');
  const away = join(root, 'work', 'OP-away');
  const aside = join(temp, 'away-aside');
  renameSync(away, aside);
  // If deleting the branch fails after the merge check, the registration stays so done can be retried.
  const refHook = join(bare, 'hooks', 'reference-transaction');
  writeFileSync(refHook, '#!/bin/sh\nif [ "$1" = prepared ] && grep -q "refs/heads/work/TC-gone$"; then exit 1; fi\nexit 0\n');
  chmodSync(refHook, 0o755);
  expect(() => hqWork('done', 'TC', 'gone', { root })).toThrow('registration kept');
  rmSync(refHook);
  expect(JSON.parse(readFileSync(join(root, 'house.json'), 'utf8')).sandboxes[gone]).toBeDefined();
  expect(spawnSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/work/TC-gone']).status).toBe(0);
  expect(hqWork('done', 'TC', 'gone', { root }).outcome).toBe('removed');
  expect(JSON.parse(readFileSync(join(root, 'house.json'), 'utf8')).sandboxes[gone]).toBeUndefined();
  const listed = git(['--git-dir', bare, 'worktree', 'list', '--porcelain']);
  expect(listed).not.toContain(`worktree ${gone}\n`);
  expect(listed).toContain(`worktree ${away}\n`);
  renameSync(aside, away);
  expect(git(['symbolic-ref', '--short', 'HEAD'], away)).toBe('work/OP-away');
  expect(spawnSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/work/TC-gone']).status).toBe(1);
  // A registered work moved elsewhere is live work, not a vanished one: done refuses and keeps branch and entry.
  expect(hqWork('new', 'TC', 'moved', { root }).outcome).toBe('created');
  const moved = join(root, 'work', 'TC-moved');
  const elsewhere = join(temp, 'moved-elsewhere');
  git(['--git-dir', bare, 'worktree', 'move', moved, elsewhere]);
  expect(() => hqWork('done', 'TC', 'moved', { root })).toThrow('work branch work/TC-moved is checked out at');
  expect(existsSync(elsewhere)).toBe(true);
  expect(spawnSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/work/TC-moved']).status).toBe(0);
  expect(JSON.parse(readFileSync(join(root, 'house.json'), 'utf8')).sandboxes[moved]).toBeDefined();
  // With both the worktree and the branch gone, a leftover ledger entry has no merge proof: refuse, keep it.
  expect(hqWork('new', 'TC', 'orphan', { root }).outcome).toBe('created');
  const orphan = join(root, 'work', 'TC-orphan');
  git(['--git-dir', bare, 'worktree', 'remove', '--force', orphan]);
  git(['--git-dir', bare, 'update-ref', '-d', 'refs/heads/work/TC-orphan']);
  expect(() => hqWork('done', 'TC', 'orphan', { root })).toThrow('cannot verify merge: branch work/TC-orphan is missing');
  expect(JSON.parse(readFileSync(join(root, 'house.json'), 'utf8')).sandboxes[orphan]).toBeDefined();
}, 120_000);

test('work done refuses a merged worktree that hq work new did not register', () => {
  const root = join(home, 'elanous-hq');
  const init = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(init.status, init.stderr).toBe(0);
  const manual = join(root, 'work', 'TC-manual');
  git(['--git-dir', join(root, 'repo.git'), 'worktree', 'add', '-b', 'work/TC-manual', manual, 'refs/remotes/origin/main']);
  const result = hq('work', 'done', 'TC', 'manual');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('not registered in house.json');
  expect(existsSync(manual)).toBe(true);
  expect(git(['symbolic-ref', '--short', 'HEAD'], manual)).toBe('work/TC-manual');
}, 120_000);

test('work done removes nothing when the branch gains a commit after the merge check', () => {
  const root = join(home, 'elanous-hq');
  const init = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(init.status, init.stderr).toBe(0);
  expect(hq('work', 'new', 'TC', 'race').status).toBe(0);
  const work = join(root, 'work', 'TC-race');
  const bare = join(root, 'repo.git');
  // done detaches the work after its merge check; this hook lands a racing commit on the branch at that moment.
  const hook = join(bare, 'hooks', 'post-checkout');
  writeFileSync(hook, '#!/bin/sh\nc=$(git -c user.name=Race -c user.email=race@example.test commit-tree "HEAD^{tree}" -p HEAD -m race) && git update-ref refs/heads/work/TC-race "$c"\n');
  chmodSync(hook, 0o755);
  const result = hq('work', 'done', 'TC', 'race');
  rmSync(hook);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('work branch moved after the merge check');
  expect(result.stderr).toContain('nothing removed');
  expect(existsSync(work)).toBe(true);
  expect(git(['symbolic-ref', '--short', 'HEAD'], work)).toBe('work/TC-race');
  expect(git(['--git-dir', bare, 'log', '-1', '--format=%s', 'refs/heads/work/TC-race'])).toBe('race');
  expect(JSON.parse(readFileSync(join(root, 'house.json'), 'utf8')).sandboxes[work]).toBeDefined();
}, 120_000);

test('work done removes nothing while another git process holds the work lock', () => {
  const root = join(home, 'elanous-hq');
  const init = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(init.status, init.stderr).toBe(0);
  expect(hq('work', 'new', 'TC', 'busy').status).toBe(0);
  const work = join(root, 'work', 'TC-busy');
  const lock = join(git(['rev-parse', '--absolute-git-dir'], work), 'index.lock');
  writeFileSync(lock, '');
  const result = hq('work', 'done', 'TC', 'busy');
  rmSync(lock);
  expect(result.status).toBe(1);
  expect(existsSync(work)).toBe(true);
  expect(git(['symbolic-ref', '--short', 'HEAD'], work)).toBe('work/TC-busy');
  expect(git(['--git-dir', join(root, 'repo.git'), 'rev-parse', '--verify', 'refs/heads/work/TC-busy'])).not.toBe('');
  expect(JSON.parse(readFileSync(join(root, 'house.json'), 'utf8')).sandboxes[work]).toBeDefined();
  expect(hq('work', 'done', 'TC', 'busy').status).toBe(0);
  expect(existsSync(work)).toBe(false);
}, 120_000);

test('work done resumes from each interrupted removal state (states built by hand, not by killing a process)', () => {
  const root = join(home, 'elanous-hq');
  const init = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(init.status, init.stderr).toBe(0);
  const bare = join(root, 'repo.git');
  const ledgerFile = join(root, 'house.json');
  const record = (work: string, tip: string) => {
    const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'));
    ledger.sandboxes[work].reclaiming = tip;
    writeFileSync(ledgerFile, JSON.stringify(ledger));
  };
  // ① killed after the branch was deleted, before the worktree was removed (its locks left behind by a dead pid).
  expect(hq('work', 'new', 'TC', 'killed1').status).toBe(0);
  const first = join(root, 'work', 'TC-killed1');
  const tip1 = git(['rev-parse', 'HEAD'], first);
  record(first, tip1);
  git(['checkout', '--quiet', '--detach'], first);
  git(['--git-dir', bare, 'update-ref', '-d', 'refs/heads/work/TC-killed1', tip1]);
  const admin = git(['rev-parse', '--absolute-git-dir'], first);
  for (const name of ['HEAD.lock', 'index.lock']) writeFileSync(join(admin, name), 'hq-done 2147483646\n');
  // Locks left by the stopped done are never removed automatically; the error names them and nothing changes.
  const blocked = hq('work', 'done', 'TC', 'killed1');
  expect(blocked.status).toBe(1);
  expect(blocked.stderr).toContain('stale lock from a stopped hq work done (pid 2147483646)');
  expect(existsSync(first)).toBe(true);
  for (const name of ['HEAD.lock', 'index.lock']) rmSync(join(admin, name));
  const resumed = hq('work', 'done', 'TC', 'killed1');
  expect(resumed.status, resumed.stderr).toBe(0);
  expect(existsSync(first)).toBe(false);
  expect(JSON.parse(readFileSync(ledgerFile, 'utf8')).sandboxes[first]).toBeUndefined();
  // ⓪ stopped right after detaching, before the branch delete: branch still at the recorded tip.
  expect(hq('work', 'new', 'TC', 'killed0').status).toBe(0);
  const zeroth = join(root, 'work', 'TC-killed0');
  record(zeroth, git(['rev-parse', 'HEAD'], zeroth));
  git(['checkout', '--quiet', '--detach'], zeroth);
  const resumed0 = hq('work', 'done', 'TC', 'killed0');
  expect(resumed0.status, resumed0.stderr).toBe(0);
  expect(existsSync(zeroth)).toBe(false);
  expect(spawnSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/work/TC-killed0']).status).toBe(1);
  // ② killed after the worktree was removed, before the registration was dropped.
  expect(hq('work', 'new', 'TC', 'killed2').status).toBe(0);
  const second = join(root, 'work', 'TC-killed2');
  const tip2 = git(['rev-parse', 'HEAD'], second);
  record(second, tip2);
  git(['--git-dir', bare, 'worktree', 'remove', '--force', second]);
  git(['--git-dir', bare, 'update-ref', '-d', 'refs/heads/work/TC-killed2', tip2]);
  const reconciled = hq('work', 'done', 'TC', 'killed2');
  expect(reconciled.status, reconciled.stderr).toBe(0);
  expect(JSON.parse(readFileSync(ledgerFile, 'utf8')).sandboxes).toEqual({});
}, 120_000);

test('parallel work new retains both roles in house.json across processes', async () => {
  const root = join(home, 'elanous-hq');
  const init = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(init.status, init.stderr).toBe(0);
  const lock = join(root, 'house.json.lock');
  mkdirSync(lock);
  const launch = (role: string) => {
    const child = spawn('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'work', 'new', role, 'parallel'], {
      cwd: temp, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.resume();
    return { child, result: new Promise<{ status: number | null; stderr: string }>(resolve => {
      child.on('error', error => resolve({ status: null, stderr: String(error) }));
      child.on('close', status => resolve({ status, stderr }));
    }) };
  };
  const first = launch('OP');
  const second = launch('TC');
  try {
    // Worktree creation and the ledger write share one lock, so nothing appears while it is held.
    await Bun.sleep(3_000);
    const paths = ['OP', 'TC'].map(role => join(root, 'work', `${role}-parallel`));
    expect(paths.some(existsSync), 'work worktrees must not be created outside the house lock').toBe(false);
    expect(first.child.exitCode, 'OP must wait for the house lock').toBeNull();
    expect(second.child.exitCode, 'TC must wait for the house lock').toBeNull();
  } finally {
    rmdirSync(lock);
  }
  const [a, b] = await Promise.all([first.result, second.result]);
  expect(a.status, a.stderr).toBe(0);
  expect(b.status, b.stderr).toBe(0);
  const sandboxes = JSON.parse(readFileSync(join(root, 'house.json'), 'utf8')).sandboxes;
  for (const role of ['OP', 'TC']) {
    const path = join(root, 'work', `${role}-parallel`);
    expect(sandboxes[path]).toEqual({ kind: 'sandbox', path: join(path, '.elanous-test'), owner: role });
  }
}, 120_000);

test('concurrent init with different homes registers exactly one home under the ledger lock', async () => {
  const root = join(home, 'elanous-hq');
  mkdirSync(root);
  const lock = join(root, 'house.json.lock');
  mkdirSync(lock);
  const homes = ['first-config', 'second-config'].map(name => join(home, name));
  const launch = (configDir: string) => {
    const child = spawn('bun', [cli, `--test=${join(home, 'test-state')}`, '--config-dir', configDir, 'hq', 'init', '--root', root], {
      cwd: seed, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.resume();
    return { child, result: new Promise<{ status: number | null; stderr: string }>(resolve => {
      child.on('error', error => resolve({ status: null, stderr: String(error) }));
      child.on('close', status => resolve({ status, stderr }));
    }) };
  };
  const runs = homes.map(launch);
  try {
    // Both config dirs are created before the lock; nothing under root may appear while the lock is held.
    const deadline = Date.now() + 30_000;
    while (!homes.every(existsSync) && Date.now() < deadline && runs.every(run => run.child.exitCode === null)) await Bun.sleep(25);
    expect(homes.every(existsSync), 'both inits should reach the ledger lock').toBe(true);
    await Bun.sleep(500);
    expect(existsSync(join(root, 'repo.git')), 'repo.git must not be set up outside the ledger lock').toBe(false);
    expect(existsSync(join(root, 'house.json')), 'house.json must not be registered outside the ledger lock').toBe(false);
    expect(runs.map(run => run.child.exitCode)).toEqual([null, null]);
  } finally {
    rmdirSync(lock);
  }
  const results = await Promise.all(runs.map(run => run.result));
  const winners = results.flatMap((result, index) => result.status === 0 ? [homes[index]] : []);
  expect(winners, results.map(result => result.stderr).join('\n')).toHaveLength(1);
  const loser = results.find(result => result.status !== 0)!;
  expect(loser.status).toBe(1);
  expect(loser.stderr).toContain('house.json home mismatch:');
  expect(JSON.parse(readFileSync(join(root, 'house.json'), 'utf8')).home.path).toBe(winners[0]);
}, 120_000);

test('init resolves a relative local origin against the calling checkout', () => {
  const root = join(home, 'elanous-hq');
  git(['remote', 'set-url', 'origin', '../remote.git'], seed);
  // From a subdirectory: git resolves the relative origin from the checkout's top level, and so must init.
  mkdirSync(join(seed, 'sub'));
  git(['fetch', 'origin'], join(seed, 'sub'));
  const init = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], join(seed, 'sub'),
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(init.status, init.stderr).toBe(0);
  expect(git(['--git-dir', join(root, 'repo.git'), 'remote', 'get-url', 'origin'])).toBe(remote);
  expect(git(['--git-dir', join(root, 'repo.git'), 'rev-parse', '--verify', 'refs/remotes/origin/main'])).toBe(git(['rev-parse', 'HEAD'], seed));
}, 120_000);

test('init refuses a different resolved home without changing the house ledger', () => {
  const root = join(home, 'elanous-hq');
  const firstHome = join(home, 'first-config');
  const secondHome = join(home, 'second-config');
  const init = (configDir: string) => command('bun', [cli, `--test=${join(home, 'test-state')}`, '--config-dir', configDir, 'hq', 'init', '--root', root], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  const first = init(firstHome);
  expect(first.status, first.stderr).toBe(0);
  const registered = readFileSync(join(root, 'house.json'), 'utf8');
  expect(JSON.parse(registered).home.path).toBe(firstHome);
  const second = init(secondHome);
  expect(second.status).toBe(1);
  expect(second.stderr).toContain('house.json home mismatch:');
  expect(readFileSync(join(root, 'house.json'), 'utf8')).toBe(registered);
}, 120_000);

test('failed initial fetch can be retried after the bare remote becomes available', () => {
  const root = join(home, 'elanous-hq');
  const missing = join(temp, 'remote-temporarily-unavailable.git');
  git(['remote', 'set-url', 'origin', missing], seed);
  const first = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(first.status).toBe(1);
  expect(first.stderr).toContain('fetch origin');
  expect(existsSync(join(root, 'repo.git', 'HEAD'))).toBe(true);
  expect(existsSync(join(root, 'house.json'))).toBe(false);
  renameSync(remote, missing);
  const retried = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(retried.status, retried.stderr).toBe(0);
  expect(git(['--git-dir', join(root, 'repo.git'), 'rev-parse', '--verify', 'refs/remotes/origin/main'])).toBe(git(['rev-parse', 'HEAD'], seed));
  expect(JSON.parse(readFileSync(join(root, 'house.json'), 'utf8')).home.path).toBe(join(home, 'test-state'));
}, 120_000);

test('dirty seat --refresh preserves bytes and HEAD with rc 0 and one warning', () => {
  const root = join(home, 'elanous-hq');
  const init = command('bun', [cli, '--test', 'hq', 'init'], seed, { ...process.env, HOME: home });
  expect(init.status, init.stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(root, 'house.json'), 'utf8')).home.path).toBe(join(seed, '.elanous-test'));
  expect(hq('seat', 'TC').status).toBe(0);
  const seat = join(root, 'seats', 'TC');
  const head = git(['rev-parse', 'HEAD'], seat);
  writeFileSync(join(seat, 'README'), 'do not overwrite\n');
  writeFileSync(join(seed, 'next'), 'remote advanced\n');
  git(['add', 'next'], seed);
  git(['commit', '-m', 'next'], seed);
  git(['push', 'origin', 'main'], seed);
  const result = hq('seat', 'TC', '--refresh');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr.trim().split('\n')).toHaveLength(1);
  expect(result.stderr).toContain('dirty — refresh skipped');
  expect(readFileSync(join(seat, 'README'), 'utf8')).toBe('do not overwrite\n');
  expect(git(['rev-parse', 'HEAD'], seat)).toBe(head);
  expect(existsSync(join(seat, 'next'))).toBe(false);
}, 120_000);

test('seat refresh rejects a clean checkout owned by another repository without changing it', () => {
  const root = join(home, 'elanous-hq');
  const init = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(init.status, init.stderr).toBe(0);
  const seat = join(root, 'seats', 'TC');
  mkdirSync(join(root, 'seats'));
  git(['clone', '--branch', 'main', remote, seat]);
  const head = git(['rev-parse', 'HEAD'], seat);
  const before = readFileSync(join(seat, 'README'), 'utf8');
  const result = hq('seat', 'TC', '--refresh');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`not a worktree of ${join(root, 'repo.git')}`);
  expect(git(['rev-parse', 'HEAD'], seat)).toBe(head);
  expect(readFileSync(join(seat, 'README'), 'utf8')).toBe(before);
}, 120_000);

test('seat refresh rejects a symlink to another registered worktree without detaching that work', () => {
  const root = join(home, 'elanous-hq');
  const init = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(init.status, init.stderr).toBe(0);
  expect(hq('work', 'new', 'TC', 'fix1').status).toBe(0);
  const work = join(root, 'work', 'TC-fix1');
  mkdirSync(join(root, 'seats'));
  symlinkSync(work, join(root, 'seats', 'TC'));
  const result = hq('seat', 'TC', '--refresh');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('not a worktree of');
  expect(git(['symbolic-ref', '--short', 'HEAD'], work)).toBe('work/TC-fix1');
}, 120_000);

test('seat refresh refuses a same-repository work moved into the seat path', () => {
  const root = join(home, 'elanous-hq');
  const init = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(init.status, init.stderr).toBe(0);
  expect(hq('work', 'new', 'TC', 'fix1').status).toBe(0);
  const seat = join(root, 'seats', 'TC');
  mkdirSync(join(root, 'seats'));
  git(['--git-dir', join(root, 'repo.git'), 'worktree', 'move', join(root, 'work', 'TC-fix1'), seat]);
  const result = hq('seat', 'TC', '--refresh');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('not a seat');
  expect(git(['symbolic-ref', '--short', 'HEAD'], seat)).toBe('work/TC-fix1');
}, 120_000);

test('init refuses an existing mirror of another repository, and refresh keeps commits made on a seat', () => {
  const root = join(home, 'elanous-hq');
  const init = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(init.status, init.stderr).toBe(0);
  const other = join(temp, 'other');
  git(['init', '-b', 'main', other]);
  git(['remote', 'add', 'origin', join(temp, 'other-remote.git')], other);
  const wrong = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init'], other,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(wrong.status).toBe(1);
  expect(wrong.stderr).toContain('refusing to reuse');
  expect(git(['--git-dir', join(root, 'repo.git'), 'remote', 'get-url', 'origin'])).toBe(remote);
  // A non-empty bare repo without origin is not an interrupted init: it is not adopted.
  const foreignRoot = join(temp, 'foreign-hq');
  git(['clone', '--bare', remote, join(foreignRoot, 'repo.git')]);
  git(['--git-dir', join(foreignRoot, 'repo.git'), 'remote', 'remove', 'origin']);
  const adopted = command('bun', [cli, `--test=${join(home, 'test-state')}`, 'hq', 'init', '--root', foreignRoot], seed,
    { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'empty-gitconfig') });
  expect(adopted.status).toBe(1);
  expect(adopted.stderr).toContain('refusing to adopt');
  expect(hq('seat', 'TC').status).toBe(0);
  const seat = join(root, 'seats', 'TC');
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'on seat'], seat);
  const local = git(['rev-parse', 'HEAD'], seat);
  const refreshed = hq('seat', 'TC', '--refresh');
  expect(refreshed.status, refreshed.stderr).toBe(0);
  expect(refreshed.stderr).toContain('refresh skipped');
  expect(git(['rev-parse', 'HEAD'], seat)).toBe(local);
}, 120_000);

test('HQ lease status command help and local status remain available unchanged', () => {
  const help = hq('lease', '--help');
  expect(help.status, help.stderr).toBe(0);
  expect(help.stdout).toContain('Usage: elanous hq lease [options] <action>');
  expect(help.stdout).toContain('--expected-generation <number>');
  const config = join(temp, 'config');
  mkdirSync(config);
  writeFileSync(join(config, 'config.json'), JSON.stringify({ hq: { arbiter: 'local' } }));
  const status = command('bun', [cli, `--test=${join(home, 'test-state')}`, '--config-dir', config, 'hq', 'lease', 'status', '--json'], temp, { ...process.env, HOME: home });
  expect(status.status, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout.trim().split('\n').at(-1)!)).toEqual({ ok: true, action: 'status', record: null, ageSeconds: null, expired: null });
  for (const name of ['fence', 'fence-wrapper', 'fence-audit']) {
    const cmd = hq(name, '--help');
    expect(cmd.status, cmd.stderr).toBe(0);
    expect(cmd.stdout).toContain(`elanous hq ${name}`);
  }
}, 120_000);
