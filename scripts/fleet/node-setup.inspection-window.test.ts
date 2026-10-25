import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = resolve(import.meta.dir, 'node-setup.sh');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runInspectionWindow(options: { lockHeld?: boolean; lockTimeoutSeconds?: number; parentCreationFails?: boolean; ownerWriteFails?: boolean; state?: 'active' | 'inactive' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-inspection-window-'));
  tempDirs.push(dir);
  const home = join(dir, 'remote-home');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  if (options.lockHeld) mkdirSync(join(home, '.elanous', 'inspection-window.lock'), { recursive: true });
  if (options.parentCreationFails) {
    mkdirSync(home);
    writeFileSync(join(home, '.elanous'), 'not a directory');
  }
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\necho 1.2.3\n', { mode: 0o755 });
  if (options.ownerWriteFails) {
    const mkdirPath = join(bin, 'mkdir');
    writeFileSync(mkdirPath, `#!/bin/sh
case "$*" in
  *inspection-window.lock*)
    /bin/mkdir "$@" || exit $?
    /bin/ln -s /dev/full "$REMOTE_HOME/.elanous/inspection-window.lock/owner"
    ;;
  *) exec /bin/mkdir "$@" ;;
esac
`, { mode: 0o755 });
  }
  writeFileSync(join(bin, 'ssh'), `#!/bin/bash
cmd="\${@: -1}"
printf '%s\\n' "$cmd" >> "$SSH_CALLS"
export HOME="$REMOTE_HOME"
exec sh -c "$cmd"
`, { mode: 0o755 });
  const result = spawnSync('bash', [SCRIPT, 'fixture-node', '--inspection-window', options.state ?? 'active'], {
    encoding: 'utf8',
    timeout: 5_000,
    env: {
      ...process.env,
      HOME: dir,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      REMOTE_HOME: home,
      SSH_CALLS: join(dir, 'ssh-calls'),
      FLEET_INSPECTION_LOCK_TIMEOUT_SECONDS: String(options.lockTimeoutSeconds ?? 1),
      FLEET_INSPECTION_LOCK_RETRY_SECONDS: '0.05',
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    remoteState: existsSync(join(home, '.elanous', 'inspection-window'))
      ? readFileSync(join(home, '.elanous', 'inspection-window'), 'utf8')
      : '',
    lockExists: existsSync(join(home, '.elanous', 'inspection-window.lock')),
    calls: existsSync(join(dir, 'ssh-calls')) ? readFileSync(join(dir, 'ssh-calls'), 'utf8') : '',
  };
}

describe('node-setup.sh --inspection-window remote lock', () => {
  test('creates remote ~/.elanous, writes state, and releases the lock on a new node', () => {
    const result = runInspectionWindow();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('inspection window state updated: active');
    expect(result.remoteState).toBe('active\n');
    expect(result.lockExists).toBe(false);
    expect(result.calls).toContain('mkdir -p "$HOME/.elanous"');
  });

  test('writes inactive state through the same bounded lock path', () => {
    const result = runInspectionWindow({ state: 'inactive' });
    expect(result.status).toBe(0);
    expect(result.remoteState).toBe('inactive\n');
    expect(result.lockExists).toBe(false);
  });

  test('fails explicitly within the lock deadline without modifying an occupied lock', () => {
    const result = runInspectionWindow({ lockHeld: true, lockTimeoutSeconds: 1 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('inspection window lock acquisition timed out');
    expect(result.remoteState).toBe('');
    expect(result.calls).toContain('while ! mkdir');
  });

  test('reports parent directory creation failure without retrying lock acquisition', () => {
    const result = runInspectionWindow({ parentCreationFails: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('inspection window lock parent creation failed: ~/.elanous');
    expect(result.stderr).not.toContain('inspection window lock acquisition timed out');
  });

  test('removes the acquired lock when owner recording fails after creating a file', () => {
    const result = runInspectionWindow({ ownerWriteFails: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('inspection window lock owner write failed');
    expect(result.stderr).not.toContain('inspection window lock cleanup failed');
    expect(existsSync(join(tempDirs[tempDirs.length - 1]!, 'remote-home', '.elanous', 'inspection-window.lock'))).toBe(false);
  });
});
