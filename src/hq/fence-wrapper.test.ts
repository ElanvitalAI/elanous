import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { installHqFenceWrapper, renderHqFenceWrapper, repositoryWorktreeCdWarning, resolveHqFenceBun } from './fence-wrapper.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const dir = mkdtempSync(join(tmpdir(), 'hq-fence-wrapper-')); roots.push(dir); return dir; }

test('installed entrypoint only, missing/broken symlink fails once with rc 1, never uses a repository worktree', () => {
  const dir = root();
  const alerts = join(dir, 'alerts');
  const entry = join(dir, 'current', 'node_modules', 'elanous', 'bin', 'elanous.mjs');
  mkdirSync(join(dir, 'current', 'node_modules', 'elanous', 'bin'), { recursive: true });
  symlinkSync(join(dir, 'absent'), entry);
  // The entry is gone, so the alert can only take the PATH fallback.
  const fakeBin = join(dir, 'fake-bin'); mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'elanous'), `#!/bin/sh\necho "$*" >> '${alerts}'\n`, { mode: 0o755 });
  const body = renderHqFenceWrapper({ entry, configDir: join(dir, 'config'), bun: process.execPath });
  expect(body).toContain(entry);
  expect(body).not.toContain('wt-ops-hq');
  expect(repositoryWorktreeCdWarning(body)).toBeUndefined();
  const path = join(dir, 'hq-fence'); writeFileSync(path, body, { mode: 0o755 });
  const result = spawnSync('/bin/sh', [path, 'cron', 'echo', 'ok'], { encoding: 'utf8', env: { ...process.env, HOME: dir, PATH: `${fakeBin}${delimiter}/usr/bin${delimiter}/bin` } });
  expect(result.status).toBe(1);
  expect(readFileSync(alerts, 'utf8').trim().split('\n')).toHaveLength(1);
});

test('fence exit 0 (stub bun stands in for a lease skip) does not alert; nonzero alerts exactly once and keeps rc and installed cwd', () => {
  const dir = root();
  const bin = join(dir, 'package', 'bin'); mkdirSync(bin, { recursive: true });
  const entry = join(bin, 'elanous.mjs'); writeFileSync(entry, 'entry');
  const alerts = join(dir, 'alerts');
  const calls = join(dir, 'calls');
  const fakeBin = join(dir, 'fake-bin'); mkdirSync(fakeBin);
  // One fake bun serves both calls: the fence (exits FAKE_RC) and the alert through the same entry (exits 0).
  writeFileSync(join(fakeBin, 'bun'), `#!/bin/sh\ncase "$*" in *"fence-wrapper alert"*) echo "$*" >> '${alerts}'; exit 0;; esac\npwd > '${calls}'\nexit "\${FAKE_RC:-0}"\n`, { mode: 0o755 });
  const body = renderHqFenceWrapper({ entry, configDir: dir, bun: join(fakeBin, 'bun') });
  const wrapper = join(dir, 'hq-fence'); writeFileSync(wrapper, body, { mode: 0o755 });
  // cron PATH: bun is not on it — the wrapper must use the baked absolute path.
  const env = { ...process.env, PATH: `/usr/bin${delimiter}/bin`, FAKE_RC: '0' };
  const skipped = spawnSync('/bin/sh', [wrapper, 'cron', 'echo', 'skip'], { encoding: 'utf8', env });
  expect(skipped.status).toBe(0);
  expect(existsSync(alerts)).toBe(false);
  expect(readFileSync(calls, 'utf8').trim()).toBe(join(dir, 'package'));
  const failed = spawnSync('/bin/sh', [wrapper, 'cron', 'false'], { encoding: 'utf8', env: { ...env, FAKE_RC: '7' } });
  expect(failed.status).toBe(7);
  const alertCalls = readFileSync(alerts, 'utf8').trim().split('\n');
  expect(alertCalls).toHaveLength(1);
  expect(alertCalls[0]).toContain(entry);
});

test('dry-run leaves wrapper untouched; yes creates mode 0755, backs up original once', () => {
  const dir = root();
  const path = join(dir, 'bin', 'hq-fence'); mkdirSync(join(dir, 'bin'));
  writeFileSync(path, '#!/bin/sh\nold\n');
  const before = installHqFenceWrapper(dir, '#!/bin/sh\nnew\n', false);
  expect(before.preview).toContain('-old');
  expect(before.preview).toContain('+new');
  expect(readFileSync(path, 'utf8')).toContain('old');
  expect(existsSync(join(dir, 'backups'))).toBe(false);
  const installed = installHqFenceWrapper(dir, '#!/bin/sh\nnew\n', true, { now: () => new Date('2026-10-06T01:02:03Z') });
  expect(readFileSync(installed.backup!, 'utf8')).toContain('old');
  expect(readdirSync(join(dir, 'backups'))).toHaveLength(1);
  expect(readFileSync(path, 'utf8')).toContain('new');
  expect(lstatSync(path).mode & 0o777).toBe(0o755);
});

test('isolated HOME: real installed entry, no elanous on PATH — a failing fence lands one owner alert through the entry', () => {
  const dir = root();
  const configDir = join(dir, '.elanous');
  const repoRoot = join(import.meta.dir, '../..');
  const repoEntry = join(repoRoot, 'bin', 'elanous.mjs');
  // ~/.local/share/elanous/current/node_modules/elanous -> this checkout, so the installed entry really exists.
  const pkg = join(dir, '.local', 'share', 'elanous', 'current', 'node_modules');
  mkdirSync(pkg, { recursive: true });
  symlinkSync(repoRoot, join(pkg, 'elanous'));
  // bun only — its own directory may also hold an `elanous` shim, so link bun alone into a fresh directory.
  const bunOnly = join(dir, 'bun-only'); mkdirSync(bunOnly);
  symlinkSync(process.execPath, join(bunOnly, 'bun'));
  const path = `${bunOnly}${delimiter}/usr/bin${delimiter}/bin`;
  const env = { ...process.env, HOME: dir, PATH: path, ELANOUS_STATE_DIR: configDir };
  expect(spawnSync('/bin/sh', ['-c', 'command -v elanous'], { env, encoding: 'utf8' }).status).not.toBe(0);
  const args = [repoEntry, '--test', '--config-dir', configDir, 'hq', 'fence-wrapper', 'install'];
  const preview = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 60_000 });
  expect(preview.status, preview.stderr).toBe(0);
  expect(preview.stdout).toContain('hq-fence proposed:');
  expect(existsSync(join(configDir, 'bin', 'hq-fence'))).toBe(false);
  const installed = spawnSync(process.execPath, [...args, '--yes'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(installed.status, installed.stderr).toBe(0);
  const wrapper = join(configDir, 'bin', 'hq-fence');
  expect(lstatSync(wrapper).mode & 0o777).toBe(0o755);
  // An unknown role makes `hq fence` exit 1 — a real fence failure, not a lease skip.
  // The installed wrapper names bun by absolute path; run it under the bare cron PATH.
  expect(readFileSync(wrapper, 'utf8')).toContain(`BUN='${realpathSync(process.execPath)}'`);
  const cronEnv = { ...env, PATH: `/usr/bin${delimiter}/bin` };
  const result = spawnSync('/bin/sh', [wrapper, 'not-a-role', 'echo', 'hello'], { env: cronEnv, encoding: 'utf8', timeout: 120_000 });
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).not.toContain('owner alert failed');
  const journal = join(configDir, 'seat-requests', 'requests.jsonl');
  const rows = readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { seat: string; source: string });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ seat: 'TC', source: 'loop-checker' });
  // Falsifier: take the installed entry away — with no elanous on PATH the alert cannot land, so no new row.
  rmSync(join(pkg, 'elanous'));
  const gone = spawnSync('/bin/sh', [wrapper, 'not-a-role', 'echo', 'hello'], { env: cronEnv, encoding: 'utf8', timeout: 60_000 });
  expect(gone.status).toBe(1);
  expect(gone.stderr).toContain('owner alert failed');
  expect(readFileSync(journal, 'utf8').trim().split('\n')).toHaveLength(1);
}, 300_000); // spawns the real CLI four times (each spawn has its own 60–120s cap)

test('missing role alerts once and exits 2 instead of a silent shell abort', () => {
  const dir = root();
  const bin = join(dir, 'package', 'bin'); mkdirSync(bin, { recursive: true });
  const entry = join(bin, 'elanous.mjs'); writeFileSync(entry, 'entry');
  const alerts = join(dir, 'alerts');
  const fakeBin = join(dir, 'fake-bin'); mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'bun'), `#!/bin/sh\ncase "$*" in *"fence-wrapper alert"*) echo "$*" >> '${alerts}'; exit 0;; esac\nexit 9\n`, { mode: 0o755 });
  const wrapper = join(dir, 'hq-fence'); writeFileSync(wrapper, renderHqFenceWrapper({ entry, configDir: dir, bun: join(fakeBin, 'bun') }), { mode: 0o755 });
  const result = spawnSync('/bin/sh', [wrapper], { encoding: 'utf8', env: { ...process.env, PATH: `/usr/bin${delimiter}/bin` } });
  expect(result.status).toBe(2);
  expect(readFileSync(alerts, 'utf8').trim().split('\n')).toHaveLength(1);
});

test('entry present but its alert fails: report on stderr, never fall back to PATH elanous', () => {
  const dir = root();
  const bin = join(dir, 'package', 'bin'); mkdirSync(bin, { recursive: true });
  const entry = join(bin, 'elanous.mjs'); writeFileSync(entry, 'entry');
  const pathAlerts = join(dir, 'path-alerts');
  const fakeBin = join(dir, 'fake-bin'); mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'bun'), `#!/bin/sh\nexit 5\n`, { mode: 0o755 });
  writeFileSync(join(fakeBin, 'elanous'), `#!/bin/sh\necho "$*" >> '${pathAlerts}'\n`, { mode: 0o755 });
  const wrapper = join(dir, 'hq-fence'); writeFileSync(wrapper, renderHqFenceWrapper({ entry, configDir: dir, bun: join(fakeBin, 'bun') }), { mode: 0o755 });
  const result = spawnSync('/bin/sh', [wrapper, 'cron', 'true'], { encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}${delimiter}/usr/bin${delimiter}/bin` } });
  expect(result.status).toBe(5);
  expect(result.stderr).toContain('owner alert failed');
  expect(existsSync(pathAlerts)).toBe(false);
});

test('a dangling symlink at the wrapper path is refused, not silently replaced', () => {
  const dir = root();
  mkdirSync(join(dir, 'bin'));
  symlinkSync(join(dir, 'nowhere'), join(dir, 'bin', 'hq-fence'));
  expect(() => installHqFenceWrapper(dir, '#!/bin/sh\nnew\n', true)).toThrow('non-regular');
});

test('audit detection warns only for wrapper worktree cd, not installed build cd', () => {
  expect(repositoryWorktreeCdWarning('cd /Users/example/src/wt-ops-hq || exit 1')).toContain('warning');
  expect(repositoryWorktreeCdWarning('cd /home/ubuntu/repo.worktrees/wt-ops-hq && bun entry')).toContain('warning');
  expect(repositoryWorktreeCdWarning('cd /home/ubuntu/.local/share/elanous/current/node_modules/elanous && bun entry')).toBeUndefined();
  expect(repositoryWorktreeCdWarning('cd /Users/example/src/wt-ops-hq # fence tree')).toContain('warning');
  expect(repositoryWorktreeCdWarning('cd /Users/example/src/wt-ops-hq#x')).toContain('warning');
  // Known limit: a worktree path assembled from a variable is not detected.
  expect(repositoryWorktreeCdWarning('WT=/Users/x/wt-ops-hq\ncd "$WT"')).toBeUndefined();
});

test('wrapper names bun by absolute path only — no bare `bun ` call — and refuses a relative bun', () => {
  const body = renderHqFenceWrapper({ entry: '/x/bin/elanous.mjs', configDir: '/cfg', bun: '/opt/bun/bin/bun' });
  expect(body).toContain("BUN='/opt/bun/bin/bun'");
  // Command position only: comments and quoted text (messages) may mention bun.
  const code = body.split('\n').map(line => line.replace(/#.*$/, '').replace(/"[^"]*"|'[^']*'/g, '""'));
  expect(code.some(line => /(^|[;|&(]|then|else|do)\s*bun\s/.test(line))).toBe(false);
  expect(() => renderHqFenceWrapper({ entry: '/x', configDir: '/cfg', bun: 'bun' })).toThrow('absolute');
});

test('resolveHqFenceBun: bun process uses execPath; otherwise the install-time lookup; never a relative name', () => {
  expect(resolveHqFenceBun({ isBun: true, execPath: process.execPath })).toBe(realpathSync(process.execPath));
  expect(resolveHqFenceBun({ isBun: false, lookup: () => `${process.execPath}\n` })).toBe(realpathSync(process.execPath));
  expect(() => resolveHqFenceBun({ isBun: false, lookup: () => '' })).toThrow('absolute bun');
  expect(() => resolveHqFenceBun({ isBun: false, lookup: () => 'bun' })).toThrow('absolute bun');
});

test('bun path missing under cron PATH: exit 127, the log line is always written, and the alert still lands via an absolute fallback bun', () => {
  const dir = root();
  const bin = join(dir, 'package', 'bin'); mkdirSync(bin, { recursive: true });
  const entry = join(bin, 'elanous.mjs'); writeFileSync(entry, 'entry');
  const log = join(dir, 'logs', 'hq-fence.log');
  const wrapper = join(dir, 'hq-fence');
  writeFileSync(wrapper, renderHqFenceWrapper({ entry, configDir: dir, bun: join(dir, 'gone', 'bun'), logFile: log }), { mode: 0o755 });
  // No fallback bun under this HOME and a PATH elanous that must NOT be used: exactly one log line.
  const pathAlerts = join(dir, 'path-alerts');
  const fakeBin = join(dir, 'fake-bin'); mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'elanous'), `#!/bin/sh\necho "$*" >> '${pathAlerts}'\n`, { mode: 0o755 });
  const bare = spawnSync('/bin/sh', [wrapper, 'cron', 'true'], { encoding: 'utf8', env: { HOME: dir, PATH: `${fakeBin}${delimiter}/usr/bin${delimiter}/bin` } });
  expect(bare.status).toBe(127);
  expect(existsSync(pathAlerts)).toBe(false);
  const first = readFileSync(log, 'utf8').trim().split('\n');
  expect(first).toHaveLength(1);
  expect(first[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ bun missing or not executable: .*\(rc=127\)$/);
  // A bun at $HOME/.bun/bin (absolute, not PATH) delivers the alert; the bun-missing line is still logged.
  const alerts = join(dir, 'alerts');
  mkdirSync(join(dir, '.bun', 'bin'), { recursive: true });
  writeFileSync(join(dir, '.bun', 'bin', 'bun'), `#!/bin/sh\necho "$*" >> '${alerts}'\n`, { mode: 0o755 });
  rmSync(log);
  const fallback = spawnSync('/bin/sh', [wrapper, 'cron', 'true'], { encoding: 'utf8', env: { HOME: dir, PATH: `/usr/bin${delimiter}/bin` } });
  expect(fallback.status).toBe(127);
  expect(readFileSync(alerts, 'utf8')).toContain('fence-wrapper alert hq-fence: bun missing or not executable');
  expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
});
