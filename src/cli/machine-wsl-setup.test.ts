import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { applyMachineWslBootstrap, applyMachineWslProfile, buildMachineWslResumeCommand, setWslConfiguration } from './machine-wsl-setup.js';
import { buildMachineSetupPlan } from './machine-setup-plan.js';
import { registerMachineApplyFromCaptureCommand } from './machine-apply-from-capture.js';

test('WSL bootstrap registers a one-time resume before requesting distro installation', () => {
  const calls: string[][] = [];
  const events: string[] = [];
  let scheduled = '';
  const result = applyMachineWslBootstrap({ capture: 'C:\\Users\\User\\capture.json', profile: 'developer',
    distribution: 'Ubuntu-24.04', user: 'user', resume: false,
    deps: {
      platform: 'win32', executable: 'C:\\Program Files\\Elanous\\bun.exe', entry: 'C:\\Program Files\\Elanous\\elanous.mjs',
      scheduleResume: command => { scheduled = command; events.push('schedule'); return { status: 0 }; },
      run: (command, args) => { calls.push([command, ...args]); events.push('install'); return { status: 0 }; },
    } });
  expect(result).toMatchObject({ status: 'resume-pending', distribution: 'Ubuntu-24.04', user: 'user' });
  expect(result.attempted).toBe(2);
  expect(scheduled).toContain('--resume');
  expect(scheduled).toContain('capture.json');
  expect(events).toEqual(['schedule', 'install']);
  expect(calls).toEqual([['wsl.exe', '--install', '--distribution', 'Ubuntu-24.04', '--no-launch']]);
});

test('WSL resume creates the account, enables systemd, and reboots the guest before returning', () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const outputByCall: string[] = ['', ''];
  let interactiveCount = 0;
  const result = applyMachineWslBootstrap({ capture: 'C:\\capture.json', profile: 'default', distribution: 'Ubuntu',
    user: 'elanous', resume: true,
    deps: {
      platform: 'win32',
      stdinIsTTY: true,
      scheduleResume: () => ({ status: 0 }),
      run: (command, args, captureOutput) => {
        calls.push({ command, args });
        const joined = args.join(' ');
        if (joined === '--list --verbose') return { status: 0, stdout: '  NAME                   STATE           VERSION\r\n* Ubuntu                 Stopped         2\r\n' };
        if (joined.includes('/usr/bin/id -u elanous')) return { status: 1, stderr: 'id: elanous: no such user' };
        if (joined.includes('/usr/bin/passwd -S elanous')) return { status: 0, stdout: 'elanous L 1970-01-01 0 99999 7 -1\n' };
        if (joined.includes('/usr/bin/passwd elanous')) { interactiveCount += 1; return { status: 0 }; }
        if (joined.includes('cat /etc/wsl.conf')) return { status: 0, stdout: '[network]\ngenerateResolvConf=false\n' };
        if (joined.includes('base64 --decode')) {
          const encoded = /printf '%s' '([A-Za-z0-9+/=]+)'/.exec(joined)?.[1] ?? '';
          outputByCall[0] = Buffer.from(encoded, 'base64').toString('utf8');
        }
        if (joined.endsWith('systemctl is-system-running')) return { status: 0, stdout: 'running\n' };
        return { status: 0, stdout: captureOutput ? '' : undefined };
      },
    } });
  expect(result.status).toBe('complete');
  expect(interactiveCount).toBe(1);
  expect(calls.find(call => call.args[0] === '--terminate' && call.args[1] === 'Ubuntu')).toBeDefined();
  expect(outputByCall[0]).toContain('[network]\ngenerateResolvConf=false');
  expect(outputByCall[0]).toContain('[boot]\nsystemd=true');
  expect(outputByCall[0]).toContain('[user]\ndefault=elanous');
  expect(calls.at(-1)?.args).toContain('is-system-running');
});

test('WSL ini update preserves unrelated settings and replaces prior boot/user values', () => {
  expect(setWslConfiguration('[boot]\nsystemd=false\n[network]\nhostAddressLoopback=true\n[user]\ndefault=root\n', 'dev'))
    .toBe('[boot]\nsystemd=true\n[network]\nhostAddressLoopback=true\n[user]\ndefault=dev\n');
});

test('WSL setup fails closed when an existing configuration cannot be read', () => {
  const calls: string[][] = [];
  const result = applyMachineWslBootstrap({ capture: 'capture.json', profile: 'default', distribution: 'Ubuntu',
    user: 'elanous', resume: true, deps: { platform: 'win32', run: (command, args) => {
      calls.push([command, ...args]);
      const joined = args.join(' ');
      if (joined === '--list --verbose') return { status: 0, stdout: '  NAME                   STATE           VERSION\n* Ubuntu                 Stopped         2\n' };
      if (joined.includes('/usr/bin/id -u')) return { status: 0, stdout: '1000\n' };
      if (joined.includes('/usr/bin/passwd -S')) return { status: 0, stdout: 'elanous P 2026-01-01 0 99999 7 -1\n' };
      if (joined.includes('user-mod')) return { status: 0 };
      if (joined.includes('cat /etc/wsl.conf')) return { status: 1, errorCode: 'EACCES' };
      return { status: 0 };
    } } });
  expect(result).toMatchObject({ status: 'failed', detail: 'read-wsl-configuration' });
  expect(calls.some(args => args.join(' ').includes('base64 --decode'))).toBe(false);
});

test('WSL resume command quotes paths with spaces and rejects unsafe identifiers', () => {
  const command = buildMachineWslResumeCommand({ executable: 'C:\\Program Files\\Bun\\bun.exe',
    entry: 'C:\\Elanous\\elanous.mjs', capture: 'C:\\Users\\Me\\My Capture.json',
    profile: 'default', distribution: 'Ubuntu', user: 'elanous' });
  expect(command).toContain('"C:\\Program Files\\Bun\\bun.exe"');
  expect(command).toContain('"C:\\Users\\Me\\My Capture.json"');
  expect(() => applyMachineWslBootstrap({ capture: 'x', profile: 'default', distribution: 'Ubuntu', user: 'Bad User', resume: false,
    deps: { platform: 'win32', scheduleResume: () => ({ status: 0 }), run: () => ({ status: 0 }) } })).toThrow('WSL username');
});

test('WSL resume preserves the virtualization diagnostic when WSL2 cannot start', () => {
  const result = applyMachineWslBootstrap({ capture: 'capture.json', profile: 'default', distribution: 'Ubuntu',
    user: 'elanous', resume: true, deps: { platform: 'win32', run: (_command, args) => args[0] === '--list'
      ? { status: 1, stdout: '', stderr: 'Wsl/Service/CreateInstance/HCS_E_HYPERV_NOT_INSTALLED' }
      : { status: 0 } } });
  expect(result).toMatchObject({ status: 'failed', detail: 'list-distributions', attempted: 1 });
  expect(result.failures[0]?.reason).toContain('HCS_E_HYPERV_NOT_INSTALLED');
});

test('WSL account startup preserves HCS failure instead of treating it as a missing user', () => {
  const calls: string[] = [];
  const result = applyMachineWslBootstrap({ capture: 'capture.json', profile: 'default', distribution: 'Ubuntu',
    user: 'elanous', resume: true, deps: { platform: 'win32', run: (_command, args) => {
      const line = args.join(' '); calls.push(line);
      if (line === '--list --verbose') return { status: 0, stdout: '* Ubuntu Stopped 2\n' };
      if (line.includes('/usr/bin/id -u')) return { status: 1, stderr: 'HCS_E_HYPERV_NOT_INSTALLED' };
      return { status: 0 };
    } } });
  expect(result).toMatchObject({ status: 'failed', detail: 'start-distribution', attempted: 2 });
  expect(result.failures[0]?.reason).toContain('HCS_E_HYPERV_NOT_INSTALLED');
  expect(calls.some(line => line.includes('/usr/sbin/useradd'))).toBe(false);
});

test('WSL account probe does not treat a root lookup error as the requested user missing', () => {
  const calls: string[] = [];
  const result = applyMachineWslBootstrap({ capture: 'capture.json', profile: 'default', distribution: 'Ubuntu',
    user: 'elanous', resume: true, deps: { platform: 'win32', run: (_command, args) => {
      const line = args.join(' '); calls.push(line);
      if (line === '--list --verbose') return { status: 0, stdout: '* Ubuntu Stopped 2\n' };
      if (line.includes('/usr/bin/id -u')) return { status: 1, stderr: 'id: root: no such user' };
      return { status: 0 };
    } } });
  expect(result).toMatchObject({ status: 'failed', detail: 'start-distribution', attempted: 2 });
  expect(result.failures[0]?.reason).toContain('id: root: no such user');
  expect(calls.some(line => line.includes('/usr/sbin/useradd'))).toBe(false);
});

test('WSL RunOnce registration is included in the attempted command count', () => {
  const result = applyMachineWslBootstrap({ capture: 'capture.json', profile: 'default', distribution: 'Ubuntu',
    user: 'elanous', resume: false, deps: { platform: 'win32', scheduleResume: () => ({ status: 5 }), run: () => ({ status: 0 }) } });
  expect(result).toMatchObject({ status: 'failed', detail: 'register-resume', attempted: 1 });
});

test('WSL resume stops on an absent distro instead of reinstalling and rescheduling forever', () => {
  const calls: string[] = [];
  let scheduled = false;
  const result = applyMachineWslBootstrap({ capture: 'capture.json', profile: 'default', distribution: 'Ubuntu',
    user: 'elanous', resume: true, deps: { platform: 'win32', scheduleResume: () => { scheduled = true; return { status: 0 }; },
      run: (_command, args) => { calls.push(args.join(' ')); return { status: 0, stdout: '  NAME STATE VERSION\n' }; } } });
  expect(result).toMatchObject({ status: 'failed', detail: 'verify-wsl2', attempted: 1 });
  expect(result.failures[0]?.reason).toContain('automatic reinstall is stopped');
  expect(calls).toEqual(['--list --verbose']);
  expect(scheduled).toBe(false);
});

test('WSL1 is rejected before account or systemd changes', () => {
  const calls: string[] = [];
  const result = applyMachineWslBootstrap({ capture: 'capture.json', profile: 'default', distribution: 'Ubuntu',
    user: 'elanous', resume: true, deps: { platform: 'win32', run: (_command, args) => {
      calls.push(args.join(' '));
      return { status: 0, stdout: '  NAME STATE VERSION\n* Ubuntu Stopped 1\n' };
    } } });
  expect(result).toMatchObject({ status: 'failed', detail: 'verify-wsl2', attempted: 1 });
  expect(result.failures[0]?.reason).toContain('WSL 2 is required');
  expect(calls).toEqual(['--list --verbose']);
});

test('WSL resume reports a TTY-less password prompt instead of hanging', () => {
  const calls: string[] = [];
  const result = applyMachineWslBootstrap({ capture: 'capture.json', profile: 'default', distribution: 'Ubuntu',
    user: 'elanous', resume: true, deps: { platform: 'win32', stdinIsTTY: false, run: (_command, args) => {
      const line = args.join(' '); calls.push(line);
      if (line === '--list --verbose') return { status: 0, stdout: '* Ubuntu Stopped 2\n' };
      if (line.includes('/usr/bin/id -u')) return { status: 0, stdout: '1000\n' };
      if (line.includes('/usr/bin/passwd -S')) return { status: 0, stdout: 'elanous L 1970-01-01 0 99999 7 -1\n' };
      return { status: 0 };
    } } });
  expect(result).toMatchObject({ status: 'failed', detail: 'set-user-password', attempted: 3 });
  expect(result.failures[0]?.reason).toContain('no interactive terminal');
  expect(calls.some(line => line === '--distribution Ubuntu --user root --exec /usr/bin/passwd elanous')).toBe(false);
});

test('WSL profile apply runs apt commands inside the selected distro and aggregates failures', () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const result = applyMachineWslProfile({
    plan: buildMachineSetupPlan({ profile: 'default', platform: 'wsl' }),
    distribution: 'Ubuntu',
    user: 'elanous',
    run: (command, args) => {
      calls.push({ command, args });
      return { status: args.includes('sudo') && args.includes('-v') ? 0 : 9 };
    },
  });
  expect(result.failures.length).toBeGreaterThan(0);
  expect(calls.every(call => call.command === 'wsl.exe' && call.args[0] === '--distribution'
    && call.args[1] === 'Ubuntu' && call.args[2] === '--user' && call.args[3] === 'elanous')).toBe(true);
  expect(calls.some(call => call.args.includes('apt-get'))).toBe(true);
  expect(result.manual).not.toContain('wsl-install');
  expect(result.manual).not.toContain('wsl-systemd');
});

test('machine apply shows the selected distro before approval and prints manual steps after resume', async () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-wsl-cli-'));
  const capture = join(root, 'capture.json');
  writeFileSync(capture, JSON.stringify({ kind: 'machine-capture', schemaVersion: 1, platform: 'darwin', packages: {
    tapsStatus: 'captured', taps: [], formulaeStatus: 'captured', formulae: [], casksStatus: 'captured', casks: [],
  } }));
  const output: string[] = [];
  const calls: string[][] = [];
  let scheduled = 0;
  const parse = async (args: string[]) => {
    const program = new Command();
    registerMachineApplyFromCaptureCommand(program.command('apply'), {
      platform: () => 'wsl',
      wsl: {
        platform: 'win32',
        stdinIsTTY: true,
        executable: 'C:\\Elanous\\bun.exe',
        entry: 'C:\\Elanous\\elanous.mjs',
        scheduleResume: () => { scheduled += 1; return { status: 0 }; },
        run: (command, argv) => {
          calls.push([command, ...argv]);
          const line = argv.join(' ');
          if (line === '--install --distribution Debian --no-launch' || line === '--install --distribution Ubuntu --no-launch') return { status: 0 };
          if (line === '--list --verbose') return { status: 0, stdout: '  NAME                   STATE           VERSION\r\n* Ubuntu                 Stopped         2\r\n' };
          if (line.includes('/usr/bin/id -u elanous')) return { status: 0, stdout: '1000\n' };
          if (line.includes('/usr/bin/passwd -S elanous')) return { status: 0, stdout: 'elanous P 2026-01-01 0 99999 7 -1\n' };
          if (line.includes('cat /etc/wsl.conf')) return { status: 0, stdout: '[network]\ngenerateResolvConf=false\n' };
          if (line.includes('systemctl is-system-running')) return { status: 0, stdout: 'running\n' };
          if (line.includes('sudo -v')) return { status: 0 };
          if (line.includes('apt-get')) return { status: 9 };
          return { status: 0 };
        },
      },
      out: { log: value => output.push(value) },
      err: { error: value => output.push(value) },
      setExitCode: code => output.push(`exit:${code}`),
    });
    await program.parseAsync(['node', 'eln', 'apply', '--from', capture, ...args]);
  };
  try {
    await parse(['--platform', 'wsl', '--distribution', 'Debian']);
    expect(output[0]).toContain('wsl.exe --install --distribution Debian --no-launch');
    expect(scheduled).toBe(0);

    output.length = 0;
    await parse(['--platform', 'wsl', '--distribution', 'Debian', '--yes']);
    expect(output[0]).toContain('reboot, then sign in or run this resume command over SSH');
    expect(output[0]).toContain('--resume');
    expect(scheduled).toBe(1);

    output.length = 0;
    await parse(['--platform', 'wsl', '--distribution', 'Ubuntu', '--resume', '--yes']);
    expect(output.join('\n')).toContain('manual steps:');
    expect(output.join('\n')).toContain('tailscale-login');
    expect(output.join('\n')).toContain('wsl-terminal-fonts');
    expect(calls.some(args => args.includes('apt-get'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
