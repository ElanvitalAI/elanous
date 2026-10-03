import { expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Launching the install CLI through a shell can exceed Bun's 5 s test default under gate-pod load.
setDefaultTimeout(60_000);

for (const [os, path] of [
  ['Darwin', 'Library/LaunchAgents/com.elanous.role-watch.plist'],
  ['Linux', '.config/systemd/user/elanous-role-watch.service'],
] as const) {
  test(`${os} dry-run prints role watch unit but writes no files`, () => {
    const home = mkdtempSync(join(tmpdir(), 'role-watch-install-'));
    try {
      const result = spawnSync('bash', ['scripts/install-role-watch.sh', '--dry-run'], {
        cwd: join(import.meta.dir, '..'), encoding: 'utf8',
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), ROLE_WATCH_OS: os },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(join(home, path));
      expect(result.stdout).toContain('role watch');
      if (os === 'Linux') expect(result.stdout).toContain('loginctl enable-linger');
      expect(existsSync(join(home, path))).toBe(false);
      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test('Linux apply enables lingering before installing; failure leaves no user unit', () => {
  const home = mkdtempSync(join(tmpdir(), 'role-watch-apply-'));
  try {
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const cli = join(bin, 'elanous');
    const events = join(home, 'events');
    const unit = join(home, '.config/systemd/user/elanous-role-watch.service');
    const executable = (name: string, body: string) => {
      const path = join(bin, name);
      writeFileSync(path, `#!/bin/sh\n${body}\n`);
      chmodSync(path, 0o755);
    };
    executable('elanous', `echo "cli $*" >> "${events}"; echo 'watch: observe'`);
    executable('loginctl', `echo "loginctl $*" >> "${events}"
if [ "$1" = show-user ]; then
  if [ -e "${home}/linger" ]; then echo yes; else echo no; fi
elif [ "$1" = enable-linger ]; then
  [ ! -e "${home}/deny" ] || exit 1
  touch "${home}/linger"
fi`);
    executable('systemctl', `echo "systemctl $*" >> "${events}"`);
    const run = () => spawnSync('bash', ['scripts/install-role-watch.sh', '--apply'], {
      cwd: join(import.meta.dir, '..'), encoding: 'utf8',
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), ROLE_WATCH_OS: 'Linux',
        ROLE_WATCH_CLI: cli, PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    writeFileSync(join(home, 'deny'), '');
    const denied = run();
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toContain('boot watch not configured');
    expect(existsSync(unit)).toBe(false);
    rmSync(join(home, 'deny'));
    writeFileSync(events, '');
    const installed = run();
    expect(installed.status).toBe(0);
    expect(installed.stdout).toContain('watch: observe');
    expect(existsSync(unit)).toBe(true);
    expect(readFileSync(unit, 'utf8')).toContain(`ExecStart="${cli}" role watch`);
    const calls = readFileSync(events, 'utf8').trim().split('\n');
    expect(calls.map((s) => s.split(' ')[0])).toEqual(['loginctl', 'loginctl', 'loginctl', 'systemctl', 'systemctl', 'cli']);
    expect(calls[1]).toContain('enable-linger');
    expect(calls[4]).toContain('enable --now');
    expect(calls[5]).toBe('cli role watch --once');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
