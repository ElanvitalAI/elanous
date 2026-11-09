import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { applyMachineWslBootstrap, applyMachineWslProfile, buildMachineWslResumeCommand, buildMachineWslStartupTaskArgs, buildWslDockerPrerequisiteScript, buildWslDockerRepositoryScript, setWslConfiguration } from './machine-wsl-setup.js';
import { buildMachineSetupPlan } from './machine-setup-plan.js';
import { registerMachineApplyFromCaptureCommand } from './machine-apply-from-capture.js';

const hostProbe = (manufacturer = 'Contoso', product = 'Workstation') => (command: string, args: readonly string[]) => {
  if (command === 'systeminfo.exe') return { status: 0, stdout: `System Manufacturer: ${manufacturer}\nSystem Model: ${product}\n` };
  if (command === 'reg.exe' && args.includes('SystemManufacturer')) return { status: 0, stdout: `    SystemManufacturer    REG_SZ    ${manufacturer}\n` };
  if (command === 'reg.exe' && args.includes('SystemProductName')) return { status: 0, stdout: `    SystemProductName    REG_SZ    ${product}\n` };
  return undefined;
};

test('WSL bootstrap registers a startup resume before requesting distro installation', () => {
  const calls: string[][] = [];
  const events: string[] = [];
  let scheduled = '';
  const result = applyMachineWslBootstrap({ capture: 'C:\\Users\\User\\capture.json', profile: 'developer',
    distribution: 'Ubuntu-24.04', user: 'user', resume: false,
    deps: {
      platform: 'win32', executable: 'C:\\Program Files\\Elanous\\bun.exe', entry: 'C:\\Program Files\\Elanous\\elanous.mjs',
      env: { USERNAME: 'user' },
      run: (command, args) => {
        calls.push([command, ...args]);
        const probed = hostProbe()(command, args);
        if (probed) { events.push('probe'); return probed; }
        if (command === 'schtasks.exe') { scheduled = args.join(' '); events.push('schedule'); return { status: 0 }; }
        events.push('install'); return { status: 0 };
      },
    } });
  expect(result).toMatchObject({ status: 'resume-pending', distribution: 'Ubuntu-24.04', user: 'user' });
  expect(result.attempted).toBe(5);
  expect(scheduled).toContain('--resume');
  expect(scheduled).toContain('--resume-trigger onstart');
  expect(scheduled).toContain('/SC ONSTART');
  expect(scheduled).toContain('/NP');
  expect(result.detail).toContain('Reboot resumes setup automatically; sign in to Codex once on Windows. WSL does not create or refresh Codex credentials.');
  expect(scheduled).toContain('capture.json');
  expect(events).toEqual(['probe', 'probe', 'probe', 'schedule', 'install']);
  expect(calls.map(call => call[0])).toEqual(['systeminfo.exe', 'reg.exe', 'reg.exe', 'schtasks.exe', 'wsl.exe']);
  expect(calls.at(-1)).toEqual(['wsl.exe', '--install', '--distribution', 'Ubuntu-24.04', '--no-launch']);
});

test('startup resume task supports ONSTART S4U and ONLOGON interactive fallback without storing a password', () => {
  const command = buildMachineWslResumeCommand({ executable: 'C:\\Program Files\\Elanous\\bun.exe',
    entry: 'C:\\Program Files\\Elanous\\current\\node_modules\\elanous\\bin\\elanous.mjs',
    capture: 'C:\\Users\\User\\capture.json', profile: 'developer', distribution: 'Ubuntu-24.04', user: 'user' });
  expect(buildMachineWslStartupTaskArgs({ commandLine: command, windowsUser: 'user' })).toEqual([
    '/Create', '/TN', 'ElanousMachineSetupResume', '/SC', 'ONSTART', '/RU', 'user', '/NP', '/RL', 'HIGHEST', '/TR', command, '/F',
  ]);
  expect(buildMachineWslStartupTaskArgs({ commandLine: command, windowsUser: 'user', trigger: 'onlogon' })).toEqual([
    '/Create', '/TN', 'ElanousMachineSetupResume', '/SC', 'ONLOGON', '/RU', 'user', '/IT', '/RL', 'HIGHEST', '/TR', command, '/F',
  ]);
});

test('ONLOGON resume reports that signing in after reboot resumes setup', () => {
  const result = applyMachineWslBootstrap({ capture: 'capture.json', profile: 'default', distribution: 'Ubuntu',
    user: 'elanous', resume: false, resumeTrigger: 'onlogon', deps: { platform: 'win32', env: { USERNAME: 'user' },
      run: (command, args) => hostProbe()(command, args) ?? { status: 0 } } });
  expect(result).toMatchObject({ status: 'resume-pending', resumeTrigger: 'onlogon' });
  expect(result.detail).toContain('After reboot, Windows sign-in resumes setup automatically; complete Codex identity login on Windows.');
});

test('MACHINE-WSL-ZERO-TOUCH simulation resumes through fake schtasks and WSL without a guest password', () => {
  const calls: { command: string; args: string[] }[] = [];
  const events: string[] = [];
  let taskRegistered = false;
  let distroInstalled = false;
  let userCreated = false;
  const run = (command: string, args: readonly string[]) => {
    const row = { command, args: [...args] };
    calls.push(row);
    const line = args.join(' ');
    if (command === 'systeminfo.exe') return { status: 0, stdout: 'System Manufacturer: Dell Inc.\nSystem Model: Latitude\n' };
    if (command === 'reg.exe' && args.includes('SystemManufacturer')) return { status: 0, stdout: 'SystemManufacturer REG_SZ Dell Inc.\n' };
    if (command === 'reg.exe' && args.includes('SystemProductName')) return { status: 0, stdout: 'SystemProductName REG_SZ Latitude\n' };
    if (command === 'schtasks.exe' && args[0] === '/Create') { taskRegistered = true; events.push('startup-task-created'); return { status: 0 }; }
    if (command === 'schtasks.exe' && args[0] === '/Delete') { taskRegistered = false; events.push('startup-task-deleted'); return { status: 0 }; }
    if (command !== 'wsl.exe') return { status: 0 };
    if (args[0] === '--install') { distroInstalled = true; events.push('wsl-installed'); return { status: 0 }; }
    if (line === '--list --verbose') return { status: 0, stdout: distroInstalled ? 'NAME STATE VERSION\n* Ubuntu Stopped 2\n' : 'NAME STATE VERSION\n' };
    if (line.includes('/usr/bin/id -u')) return userCreated ? { status: 0, stdout: '1000\n' } : { status: 1, stderr: 'id: \'elanous\': no such user\n' };
    if (line.includes('/usr/sbin/useradd')) { userCreated = true; events.push('linux-user-created'); return { status: 0 }; }
    if (line.includes('/usr/bin/passwd') || line.includes('/usr/sbin/usermod')) return { status: 90, stderr: 'interactive guest password is not allowed' };
    if (line.includes('cat /etc/wsl.conf')) return { status: 0, stdout: '__ELANOUS_WSL_CONF_MISSING__' };
    if (line.includes('systemctl is-system-running')) return { status: 0, stdout: 'running\n' };
    if (args.includes('--user') && args[args.indexOf('--user') + 1] === 'root' && line.includes('apt-get')) { events.push('root-apt-batch'); return { status: 0 }; }
    if (args.includes('--user') && args[args.indexOf('--user') + 1] === 'elanous' && line.includes('install.sh')) { events.push('elanous-installed'); return { status: 0 }; }
    return { status: 0 };
  };
  const scheduleResume = (commandLine: string) => run('schtasks.exe', buildMachineWslStartupTaskArgs({ commandLine, windowsUser: 'user' }));
  const first = applyMachineWslBootstrap({ capture: 'C:\\Users\\User\\capture.json', profile: 'developer', distribution: 'Ubuntu',
    user: 'elanous', resume: false, deps: { platform: 'win32', env: { USERNAME: 'user' }, executable: 'C:\\Elanous\\bun.exe',
      entry: 'C:\\Elanous\\current\\node_modules\\elanous\\bin\\elanous.mjs', run, scheduleResume } });
  events.push('reboot-consented');
  const resumed = applyMachineWslBootstrap({ capture: 'C:\\Users\\User\\capture.json', profile: 'developer', distribution: 'Ubuntu',
    user: 'elanous', resume: true, deps: { platform: 'win32', env: { USERNAME: 'user' }, run } });
  const profile = applyMachineWslProfile({ plan: buildMachineSetupPlan({ profile: 'developer', platform: 'wsl' }),
    distribution: 'Ubuntu', user: 'elanous', run });

  expect(first.status).toBe('resume-pending');
  expect(resumed.status).toBe('complete');
  expect(profile.failures).toEqual([]);
  expect(taskRegistered).toBe(false);
  expect(calls.some(call => call.command === 'reg.exe' && call.args.some(arg => arg.includes('RunOnce')))).toBe(false);
  expect(calls.some(call => call.command === 'wsl.exe' && call.args.some(arg => arg.includes('/usr/bin/passwd')))).toBe(false);
  expect(calls.some(call => call.command === 'wsl.exe' && call.args.some(arg => arg.includes('/usr/sbin/usermod')))).toBe(false);
  expect(events).toEqual(['startup-task-created', 'wsl-installed', 'reboot-consented', 'linux-user-created', 'root-apt-batch', 'elanous-installed', 'startup-task-deleted']);
  expect(buildMachineSetupPlan({ profile: 'developer', platform: 'wsl' }).packages.map(item => item.name))
    .toEqual(expect.arrayContaining(['build-essential', 'python3-venv', 'unzip', 'curl']));
  expect(calls.flatMap(call => call.args).join(' ')).not.toMatch(/auth\.json|api[_-]?key|credential/i);
});

test('Google Cloud host preflight blocks before scheduled resume or WSL install without explicit approval', () => {
  const calls: string[][] = [];
  let scheduled = 0;
  const result = applyMachineWslBootstrap({ capture: 'capture.json', profile: 'default', distribution: 'Ubuntu',
    user: 'elanous', resume: false, deps: { platform: 'win32', run: (command, args) => {
      calls.push([command, ...args]);
      const probed = hostProbe('Google, Inc.', 'Google Compute Engine')(command, args);
      return probed ?? { status: 0 };
    }, scheduleResume: () => { scheduled++; return { status: 0 }; } } });
  expect(result).toMatchObject({ status: 'failed', detail: 'cloud-vm-confirmation-required', attempted: 3 });
  expect(result.failures[0]?.reason).toContain('--allow-cloud-vm');
  expect(calls).toHaveLength(3);
  expect(scheduled).toBe(0);
});

test('explicit cloud VM confirmation permits setup only after the warning probe', () => {
  const events: string[] = [];
  const result = applyMachineWslBootstrap({ capture: 'capture.json', profile: 'default', distribution: 'Ubuntu',
    user: 'elanous', resume: false, deps: { platform: 'win32', allowCloudVm: true,
      scheduleResume: () => { events.push('schedule'); return { status: 0 }; },
      run: (command, args) => { const probed = hostProbe('Google, Inc.', 'Google Compute Engine')(command, args);
        events.push(probed ? 'probe' : 'install'); return probed ?? { status: 0 }; } } });
  expect(result.status).toBe('resume-pending');
  expect(result.detail).toContain('Google Cloud Windows VM detected');
  expect(events).toEqual(['probe', 'probe', 'probe', 'schedule', 'install']);
});

test('AWS Nitro and Azure-compatible host signatures warn before any WSL or scheduled-task side effect', () => {
  const hosts = [
    { name: 'AWS Nitro', manufacturer: 'Amazon EC2', product: 'm7i.large', output: 'System Manufacturer: Amazon EC2\nSystem Model: m7i.large\n', warning: 'instance family' },
    { name: 'Azure-compatible', manufacturer: 'Microsoft Corporation', product: 'Virtual Machine', output: 'Fabricante del sistema: Microsoft Corporation\nModelo del sistema: Virtual Machine\n', warning: 'VM size' },
  ];
  for (const host of hosts) {
    const calls: string[][] = [];
    let scheduled = 0;
    const result = applyMachineWslBootstrap({ capture: 'capture.json', profile: 'default', distribution: 'Ubuntu',
      user: 'elanous', resume: false, deps: { platform: 'win32', run: (command, args) => {
        calls.push([command, ...args]);
        if (command === 'systeminfo.exe') return { status: 0, stdout: host.output };
        if (command === 'reg.exe' && args.includes('SystemManufacturer')) return { status: 0, stdout: `SystemManufacturer REG_SZ ${host.manufacturer}\n` };
        if (command === 'reg.exe' && args.includes('SystemProductName')) return { status: 0, stdout: `SystemProductName REG_SZ ${host.product}\n` };
        return { status: 0 };
      }, scheduleResume: () => { scheduled++; return { status: 0 }; } } });
    expect(result).toMatchObject({ status: 'failed', detail: 'cloud-vm-confirmation-required' });
    expect(result.failures[0]?.reason).toContain(host.warning);
    expect(result.failures[0]?.reason).toContain('--allow-cloud-vm');
    expect(calls).toHaveLength(3);
    expect(scheduled).toBe(0);
  }
});

test('English systeminfo Microsoft VM signature still blocks if registry probes fail', () => {
  const result = applyMachineWslBootstrap({ capture: 'capture.json', profile: 'default', distribution: 'Ubuntu',
    user: 'elanous', resume: false, deps: { platform: 'win32', run: command => command === 'systeminfo.exe'
      ? { status: 0, stdout: 'System Manufacturer: Microsoft Corporation\nSystem Model: Virtual Machine\n' }
      : command === 'reg.exe' ? { status: 1, stderr: 'registry unavailable' } : { status: 0 } } });
  expect(result).toMatchObject({ status: 'failed', detail: 'cloud-vm-confirmation-required' });
  expect(result.failures[0]?.reason).toContain('Azure');
});

test('explicit cloud confirmation can proceed when host probes fail and reports the remaining uncertainty', () => {
  const calls: string[] = [];
  const result = applyMachineWslBootstrap({ capture: 'capture.json', profile: 'default', distribution: 'Ubuntu',
    user: 'elanous', resume: false, deps: { platform: 'win32', allowCloudVm: true,
      scheduleResume: () => ({ status: 0 }),
      run: command => { calls.push(command); return command === 'systeminfo.exe'
        ? { status: 1, stderr: 'access denied' } : command === 'reg.exe'
          ? { status: 1, stderr: 'registry unavailable' } : { status: 0 }; } } });
  expect(result.status).toBe('resume-pending');
  expect(result.detail).toContain('Could not identify the Windows host');
  expect(calls).toEqual(['systeminfo.exe', 'reg.exe', 'reg.exe', 'wsl.exe']);
});

test('WSL resume creates the account without a password, enables systemd, and restarts the guest', () => {
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
  expect(interactiveCount).toBe(0);
  expect(calls.some(call => call.args.includes('/usr/sbin/usermod'))).toBe(false);
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
  const logonCommand = buildMachineWslResumeCommand({ executable: 'C:\\Program Files\\Bun\\bun.exe',
    entry: 'C:\\Elanous\\elanous.mjs', capture: 'C:\\Users\\Me\\capture.json', profile: 'default',
    distribution: 'Ubuntu', user: 'elanous', resumeTrigger: 'onlogon' });
  expect(logonCommand).toContain('--resume-trigger onlogon');
  expect(() => applyMachineWslBootstrap({ capture: 'x', profile: 'default', distribution: 'Ubuntu', user: 'Bad User', resume: false,
    deps: { platform: 'win32', scheduleResume: () => ({ status: 0 }), run: () => ({ status: 0 }) } })).toThrow('WSL username');
});

test('scheduled resume entry follows the stable current junction across self-updates', () => {
  const command = buildMachineWslResumeCommand({ executable: 'C:\\Users\\User\\.bun\\bin\\bun.exe',
    entry: 'C:\\Users\\User\\AppData\\Local\\elanous\\versions\\0.3.7-dev.0\\node_modules\\elanous\\bin\\elanous.mjs',
    capture: 'C:\\Users\\User\\capture.json', profile: 'default', distribution: 'Ubuntu', user: 'elanous' });
  expect(command).toContain('current\\node_modules\\elanous\\bin\\elanous.mjs');
  expect(command).not.toContain('versions\\0.3.7-dev.0');
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

test('WSL startup-task registration is included in the attempted command count', () => {
  const result = applyMachineWslBootstrap({ capture: 'capture.json', profile: 'default', distribution: 'Ubuntu',
    user: 'elanous', resume: false, deps: { platform: 'win32', allowCloudVm: true, scheduleResume: () => ({ status: 5 }), run: () => ({ status: 0 }) } });
  expect(result).toMatchObject({ status: 'failed', detail: 'register-resume', attempted: 4 });
});

test('WSL resume automatically installs an absent distro and leaves the startup task for reboot recovery', () => {
  const calls: string[] = [];
  let scheduled = '';
  const result = applyMachineWslBootstrap({ capture: 'capture.json', profile: 'default', distribution: 'Ubuntu',
    user: 'elanous', resume: true, deps: { platform: 'win32', entry: 'C:\\Elanous\\elanous.mjs',
      scheduleResume: command => { scheduled = command; return { status: 0 }; },
      run: (_command, args) => { calls.push(args.join(' ')); return args[0] === '--list'
        ? { status: 0, stdout: '  NAME STATE VERSION\n' } : { status: 0 }; } } });
  expect(result).toMatchObject({ status: 'resume-pending', attempted: 3 });
  expect(result.detail).toContain('reboot');
  expect(scheduled).toContain('--resume');
  expect(scheduled).toContain('--resume-trigger onlogon');
  expect(calls).toEqual(['--list --verbose', '--install --distribution Ubuntu --no-launch']);
});

test('WSL resume schedules recovery when a failed list command reports no installed distribution', () => {
  const calls: string[][] = [];
  let scheduled = '';
  const result = applyMachineWslBootstrap({ capture: 'capture.json', profile: 'default', distribution: 'Ubuntu',
    user: 'elanous', resume: true, deps: { platform: 'win32', scheduleResume: command => { scheduled = command; return { status: 0 }; },
      run: (command, args) => { calls.push([command, ...args]);
        return args[0] === '--list'
          ? { status: 255, stdout: '', stderr: 'No hay distribuciones instaladas para el Subsistema de Windows para Linux.' }
          : { status: 0 }; } } });
  expect(result).toMatchObject({ status: 'resume-pending', attempted: 3 });
  expect(result.detail).toContain('reboot');
  expect(calls).toEqual([['wsl.exe', '--list', '--verbose'], ['wsl.exe', '--install', '--distribution', 'Ubuntu', '--no-launch']]);
  expect(scheduled).toContain('--resume-trigger onlogon');
});

test('WSL exit 255 preserves a virtualization diagnostic without probing unrelated state', () => {
  const calls: string[][] = [];
  const result = applyMachineWslBootstrap({ capture: 'capture.json', profile: 'default', distribution: 'Ubuntu',
    user: 'elanous', resume: true, deps: { platform: 'win32', run: (command, args) => {
      calls.push([command, ...args]);
      return { status: 255, stderr: 'Wsl/Service/CreateInstance/HCS_E_HYPERV_NOT_INSTALLED' };
    } } });
  expect(result).toMatchObject({ status: 'failed', detail: 'list-distributions', attempted: 1 });
  expect(result.failures[0]?.reason).toContain('HCS_E_HYPERV_NOT_INSTALLED');
  expect(result.failures[0]?.reason).not.toContain('No WSL distributions are installed');
  expect(calls).toEqual([['wsl.exe', '--list', '--verbose']]);
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

test('WSL resume does not require a TTY or guest password', () => {
  const calls: string[] = [];
  const result = applyMachineWslBootstrap({ capture: 'capture.json', profile: 'default', distribution: 'Ubuntu',
    user: 'elanous', resume: true, deps: { platform: 'win32', stdinIsTTY: false, run: (_command, args) => {
      const line = args.join(' '); calls.push(line);
      if (line === '--list --verbose') return { status: 0, stdout: '* Ubuntu Stopped 2\n' };
      if (line.includes('/usr/bin/id -u')) return { status: 0, stdout: '1000\n' };
      if (line.includes('/usr/bin/passwd -S')) return { status: 0, stdout: 'elanous L 1970-01-01 0 99999 7 -1\n' };
      return { status: 0 };
    } } });
  expect(result).toMatchObject({ status: 'complete', attempted: 6 });
  expect(result.failures).toEqual([]);
  expect(calls.some(line => line.includes('/usr/bin/passwd'))).toBe(false);
});

test('WSL profile apply runs apt commands inside the selected distro and aggregates failures', () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const result = applyMachineWslProfile({
    plan: buildMachineSetupPlan({ profile: 'default', platform: 'wsl' }),
    distribution: 'Ubuntu',
    user: 'elanous',
    run: (command, args) => {
      calls.push({ command, args });
      return { status: 0 };
    },
  });
  expect(result).toMatchObject({ applied: true, failures: [] });
  const wslCalls = calls.filter(call => call.command === 'wsl.exe');
  expect(wslCalls.every(call => call.args[0] === '--distribution' && call.args[1] === 'Ubuntu')).toBe(true);
  expect(calls.some(call => call.args.join(' ').includes('apt-get'))).toBe(true);
  expect(calls.some(call => call.args[2] === '--user' && call.args[3] === 'root' && call.args.join(' ').includes('apt-get'))).toBe(true);
  expect(calls.some(call => call.args.some(arg => arg === 'sudo'))).toBe(false);
  const aptIndexes = calls.flatMap((call, index) => call.args.join(' ').includes('apt-get') ? [index] : []);
  const installIndex = calls.findIndex(call => call.args.some(value => value.includes('set -o pipefail; curl -fsSL https://github.com/ElanvitalAI/elanous/releases/latest/download/install.sh | bash -s -- --yes --no-setup')));
  const versionIndex = calls.findIndex(call => call.args.some(value => value.includes('"$prefix/bin/eln" --version')));
  expect(aptIndexes).not.toEqual([]);
  expect(Math.max(...aptIndexes)).toBeLessThan(installIndex);
  expect(installIndex).toBeLessThan(versionIndex);
  expect(result.manual).not.toContain('wsl-install');
  expect(result.manual).not.toContain('wsl-systemd');
  expect(result.manual).not.toContain('wsl-eln-install');
  expect(result.manual).not.toContain('wsl-eln-version-check');
});

test('Docker CE scripts execute in a blank fake guest and fetch its key only after curl is installed', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-wsl-curl-bootstrap-'));
  const bin = join(root, 'bin');
  const etcRoot = join(root, 'etc');
  const log = join(root, 'apt.log');
  const curlLog = join(root, 'curl.log');
  const curlTemplate = join(root, 'curl-template');
  mkdirSync(bin);
  mkdirSync(join(etcRoot, 'apt', 'sources.list.d'), { recursive: true });
  writeFileSync(join(etcRoot, 'os-release'), 'ID=ubuntu\nVERSION_CODENAME=noble\n');
  writeFileSync(curlTemplate, [
    '#!/bin/sh',
    'output=',
    'url=',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = -o ]; then shift; output=$1; elif [ "${1#https://}" != "$1" ]; then url=$1; fi',
    '  shift',
    'done',
    'printf "%s\\n" "$url" >> "$FAKE_CURL_LOG"',
    'printf fake-gpg > "$output"',
  ].join('\n'));
  const aptGet = join(bin, 'apt-get');
  writeFileSync(aptGet, [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$FAKE_APT_LOG"',
    'if [ "$1" = install ]; then',
    '  /bin/cp "$FAKE_CURL_TEMPLATE" "$FAKE_BIN/curl"',
    '  /bin/chmod 755 "$FAKE_BIN/curl"',
    'fi',
  ].join('\n'));
  chmodSync(aptGet, 0o755);
  const install = join(bin, 'install');
  writeFileSync(install, ['#!/bin/sh', 'target=', 'for arg in "$@"; do target=$arg; done', '/bin/mkdir -p "$target"'].join('\n'));
  chmodSync(install, 0o755);
  const chmod = join(bin, 'chmod');
  writeFileSync(chmod, '#!/bin/sh\nexit 0\n');
  chmodSync(chmod, 0o755);
  const dpkg = join(bin, 'dpkg');
  writeFileSync(dpkg, '#!/bin/sh\nprintf "amd64\\n"\n');
  chmodSync(dpkg, 0o755);
  try {
    const env = { PATH: bin, FAKE_BIN: bin, FAKE_APT_LOG: log, FAKE_CURL_LOG: curlLog, FAKE_CURL_TEMPLATE: curlTemplate };
    expect(existsSync(join(bin, 'curl'))).toBe(false);
    const prerequisites = spawnSync('/bin/bash', ['-c', buildWslDockerPrerequisiteScript()], { encoding: 'utf8', env });
    expect(prerequisites.status).toBe(0);
    expect(existsSync(join(bin, 'curl'))).toBe(true);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      'update',
      'install --yes --no-install-recommends ca-certificates curl',
    ]);
    const repository = spawnSync('/bin/bash', ['-c', buildWslDockerRepositoryScript(etcRoot)], { encoding: 'utf8', env });
    expect(repository.status).toBe(0);
    expect(readFileSync(curlLog, 'utf8').trim()).toBe('https://download.docker.com/linux/ubuntu/gpg');
    expect(readFileSync(join(etcRoot, 'apt', 'sources.list.d', 'docker.list'), 'utf8')).toContain('https://download.docker.com/linux/ubuntu noble stable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('WSL developer engine simulation installs Docker CE and k3d through fake WSL, apt, and systemd boundaries', () => {
  const plan = buildMachineSetupPlan({ profile: 'developer', platform: 'wsl' });
  const calls: { command: string; args: readonly string[] }[] = [];
  let k3dInstalled = false;
  let curlAvailable = false;
  let curlBootstrapInstalled = false;
  const result = applyMachineWslProfile({ plan, distribution: 'Ubuntu', user: 'elanous', run: (command, args) => {
    calls.push({ command, args });
    const joined = args.join(' ');
    if (joined.includes('command -v docker')) return { status: 44 };
    if (joined.includes('command -v k3d')) return { status: k3dInstalled ? 0 : 44 };
    if (joined.includes('command -v curl') && joined.includes('ca-certificates')) {
      if (!curlAvailable && joined.includes('apt-get install --yes --no-install-recommends ca-certificates curl')) {
        curlAvailable = true;
        curlBootstrapInstalled = true;
      }
      return { status: curlAvailable ? 0 : 1 };
    }
    if (joined.includes('download.docker.com/linux/')) return { status: curlAvailable ? 0 : 127 };
    if (joined.includes('apt-get install') && joined.includes('docker-ce')) return { status: 0 };
    if (joined.includes('/usr/bin/systemctl enable --now docker')) return { status: 0 };
    if (joined.includes('/usr/sbin/usermod --append --groups docker elanous')) return { status: 0 };
    if (joined.includes('docker info')) return { status: 0 };
    if (joined.includes('raw.githubusercontent.com/k3d-io/k3d/main/install.sh')) { k3dInstalled = true; return { status: 0 }; }
    if (joined.includes('k3d version')) return { status: k3dInstalled ? 0 : 1 };
    if (command === 'schtasks.exe' && args[0] === '/Query') return { status: 1, stdout: 'ERROR: cannot find task' };
    return { status: 0 };
  } });

  expect(result).toMatchObject({ applied: true, failures: [] });
  const indexOf = (text: string) => calls.findIndex(call => call.args.join(' ').includes(text));
  expect(curlBootstrapInstalled).toBe(true);
  // Source: 내부 문서 `MANUAL-windows-wsl-worker-setup-2026-10-11` §B1; indexOf returns -1 when the required call is absent.
  expect(indexOf('command -v curl')).toBeGreaterThanOrEqual(0);
  expect(indexOf('command -v curl')).toBeLessThan(indexOf('download.docker.com/linux/'));
  const dockerPackagesIndex = calls.findIndex(call => call.args.join(' ').includes('apt-get install') && call.args.join(' ').includes('docker-ce'));
  expect(indexOf('download.docker.com/linux/')).toBeLessThan(dockerPackagesIndex);
  expect(dockerPackagesIndex).toBeLessThan(indexOf('/usr/bin/systemctl enable --now docker'));
  expect(indexOf('/usr/bin/systemctl enable --now docker')).toBeLessThan(indexOf('/usr/sbin/usermod --append --groups docker elanous'));
  expect(indexOf('/usr/sbin/usermod --append --groups docker elanous')).toBeLessThan(indexOf('raw.githubusercontent.com/k3d-io/k3d/main/install.sh'));
  expect(calls.some(call => call.args.some(arg => arg === 'sudo'))).toBe(false);
});

test('WSL developer engine simulation reuses a healthy Docker Desktop integration without replacing it', () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const result = applyMachineWslProfile({ plan: buildMachineSetupPlan({ profile: 'developer', platform: 'wsl' }),
    distribution: 'Ubuntu', user: 'elanous', run: (command, args) => {
      calls.push({ command, args });
      const joined = args.join(' ');
      if (joined.includes('command -v docker')) return { status: 0 };
      if (joined.includes('command -v k3d')) return { status: 0 };
      if (joined.includes('docker info')) return { status: 0 };
      if (command === 'schtasks.exe' && args[0] === '/Query') return { status: 1, stdout: 'ERROR: cannot find task' };
      return { status: 0 };
    } });

  expect(result).toMatchObject({ applied: true, failures: [] });
  expect(calls.some(call => call.args.join(' ').includes('download.docker.com/linux/'))).toBe(false);
  expect(calls.some(call => call.args.join(' ').includes('systemctl enable --now docker'))).toBe(false);
  expect(calls.some(call => call.args.join(' ').includes('usermod --append --groups docker'))).toBe(false);
  expect(calls.some(call => call.args.join(' ').includes('apt-get install') && call.args.join(' ').includes('docker-ce'))).toBe(false);
});

test('WSL developer engine simulation preserves an unreachable existing Docker shim instead of overwriting it', () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const result = applyMachineWslProfile({ plan: buildMachineSetupPlan({ profile: 'developer', platform: 'wsl' }),
    distribution: 'Ubuntu', user: 'elanous', run: (command, args) => {
      calls.push({ command, args });
      if (args.join(' ').includes('command -v docker')) return { status: 45 };
      return { status: 0 };
    } });

  expect(result).toMatchObject({ applied: false, failures: [{ operation: 'wsl-docker-engine-probe' }] });
  expect(calls.some(call => call.args.join(' ').includes('download.docker.com/linux/'))).toBe(false);
  expect(calls.some(call => call.args.join(' ').includes('apt-get install'))).toBe(false);
});

test('WSL profile apply stops when the release download fails even if a prior guest eln remains available', () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const result = applyMachineWslProfile({
    plan: buildMachineSetupPlan({ profile: 'default', platform: 'wsl' }),
    distribution: 'Ubuntu',
    user: 'elanous',
    run: (command, args) => {
      calls.push({ command, args });
      return { status: args.some(value => value.includes('set -o pipefail; curl -fsSL https://github.com/ElanvitalAI/elanous/releases/latest/download/install.sh | bash -s -- --yes --no-setup')) ? 8 : 0 };
    },
  });
  expect(result).toMatchObject({ applied: false, failures: [{ operation: 'wsl-eln-install' }] });
  const installIndex = calls.findIndex(call => call.args.some(value => value.includes('set -o pipefail; curl -fsSL https://github.com/ElanvitalAI/elanous/releases/latest/download/install.sh | bash -s -- --yes --no-setup')));
  const aptIndexes = calls.flatMap((call, index) => call.args.join(' ').includes('apt-get') ? [index] : []);
  expect(aptIndexes).not.toEqual([]);
  expect(Math.max(...aptIndexes)).toBeLessThan(installIndex);
  expect(calls.some(call => call.args.some(value => value.includes('type -P eln')))).toBe(false);
  expect(calls.some(call => call.args.join(' ').includes('apt-get'))).toBe(true);
});

test('WSL profile apply stops when eln does not resolve to the new installation path', () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const result = applyMachineWslProfile({
    plan: buildMachineSetupPlan({ profile: 'default', platform: 'wsl' }),
    distribution: 'Ubuntu',
    user: 'elanous',
    run: (command, args) => {
      calls.push({ command, args });
      const joined = args.join(' ');
      return { status: joined.includes('apt-get') || joined.includes('install.sh') ? 0 : 4 };
    },
  });
  expect(result).toMatchObject({ applied: false, attempted: 3, succeeded: 2, failures: [{ operation: 'wsl-eln-version-check' }] });
  const installIndex = calls.findIndex(call => call.args.some(value => value.includes('set -o pipefail; curl -fsSL https://github.com/ElanvitalAI/elanous/releases/latest/download/install.sh | bash -s -- --yes --no-setup')));
  const versionCheck = calls.find(call => call.args.some(value => value.includes('test "$prefix/bin/eln" -ef "$resolved"')));
  const aptIndexes = calls.flatMap((call, index) => call.args.join(' ').includes('apt-get') ? [index] : []);
  expect(aptIndexes).not.toEqual([]);
  expect(Math.max(...aptIndexes)).toBeLessThan(installIndex);
  expect(versionCheck?.args.at(-1)).toContain('"$prefix/bin/eln" --version');
  expect(versionCheck?.args.at(-1)).toContain('type -P eln');
});

test('WSL eln verification checks the login-shell file identity and version under custom XDG data', () => {
  if (process.platform === 'win32') return;
  const root = mkdtempSync(join(tmpdir(), 'machine-wsl-eln-path-'));
  const home = join(root, 'home');
  const dataHome = join(root, 'custom-data') + '/';
  const installBin = join(dataHome, 'elanous', 'bin');
  const foreignBin = join(root, 'foreign-bin');
  const installedEln = join(installBin, 'eln');
  const foreignEln = join(foreignBin, 'eln');
  const command = buildMachineSetupPlan({ profile: 'default', platform: 'wsl' })
    .operations.find(item => item.id === 'wsl-eln-version-check')?.command?.[2];
  if (!command) throw new Error('WSL eln verification command missing');
  const run = (foreignFirst = false) => spawnSync('bash', ['-lc', command], {
    encoding: 'utf8',
    env: {
      HOME: home,
      XDG_DATA_HOME: dataHome,
      PATH: '/usr/bin:/bin',
      ...(foreignFirst ? { FOREIGN_BIN: foreignBin } : {}),
    },
  });
  const writeProfile = (foreignFirst = false, withFunction = false) => writeFileSync(join(home, '.profile'), [
    'export PATH="' + (foreignFirst ? '$FOREIGN_BIN:' : '') + '$XDG_DATA_HOME/elanous/bin:$PATH"',
    ...(withFunction ? ['cd "$XDG_DATA_HOME/elanous/bin"', 'eln() { printf shell-function; }'] : []),
    '',
  ].join(String.fromCharCode(10)));
  try {
    mkdirSync(home, { recursive: true });
    mkdirSync(installBin, { recursive: true });
    mkdirSync(foreignBin, { recursive: true });
    writeFileSync(installedEln, ['#!/bin/sh', 'printf "eln 0.3.8-test"', ''].join(String.fromCharCode(10)));
    chmodSync(installedEln, 0o755);
    writeProfile();
    const valid = run();
    expect(valid.status).toBe(0);
    expect(valid.stdout).toContain('eln 0.3.8-test');

    writeProfile(false, true);
    const functionOverride = run();
    expect(functionOverride.status).toBe(0);
    expect(functionOverride.stdout).toContain('eln 0.3.8-test');
    expect(functionOverride.stdout).not.toContain('shell-function');

    writeFileSync(foreignEln, ['#!/bin/sh', 'printf "old eln"', ''].join(String.fromCharCode(10)));
    chmodSync(foreignEln, 0o755);
    writeProfile(true);
    expect(run(true).status).not.toBe(0);

    writeFileSync(installedEln, ['#!/bin/sh', 'exit 7', ''].join(String.fromCharCode(10)));
    chmodSync(installedEln, 0o755);
    writeProfile();
    expect(run().status).toBe(7);

    rmSync(installedEln);
    expect(run().status).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
          if (command === 'systeminfo.exe') return { status: 0, stdout: 'System Manufacturer: Google, Inc.\nSystem Model: Google Compute Engine\n' };
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
    expect(output.join('\n')).toContain('cloud-vm-confirmation-required');
    expect(scheduled).toBe(0);

    output.length = 0;
    await parse(['--platform', 'wsl', '--distribution', 'Debian', '--yes', '--allow-cloud-vm']);
    expect(output.join('\n')).toContain('Reboot resumes setup automatically; sign in to Codex once on Windows. WSL does not create or refresh Codex credentials.');
    expect(scheduled).toBe(1);

    output.length = 0;
    await parse(['--platform', 'wsl', '--distribution', 'Ubuntu', '--resume', '--yes']);
    expect(output.join('\n')).toContain('manual steps:');
    expect(output.join('\n')).toContain('tailscale-login');
    expect(output.join('\n')).toContain('wsl-terminal-fonts');
    expect(calls.some(args => args.join(' ').includes('apt-get'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
