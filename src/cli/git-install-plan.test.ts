import { describe, expect, test } from 'bun:test';
import { gitInstallPlan } from './git-install-plan.js';

test('git installation commands are platform-specific argv and unknown hosts get a manual link', () => {
  const plan = (platform: NodeJS.Platform, distro: string | undefined, available: string[]) => gitInstallPlan({ platform, distro, has: (name) => available.includes(name) });
  // brew finishes in the terminal; xcode-select only opens an installer window (it now waits — see below).
  expect(plan('darwin', undefined, ['xcode-select', 'brew'])).toMatchObject({ command: ['brew', 'install', 'git'], needsSudo: false });
  expect(plan('darwin', undefined, ['xcode-select'])).toMatchObject({ command: ['xcode-select', '--install'], needsSudo: false, waitForGit: true });
  expect(plan('darwin', undefined, ['brew'])).toMatchObject({ command: ['brew', 'install', 'git'], needsSudo: false });
  expect(plan('darwin', undefined, [])).toMatchObject({ command: null, display: expect.stringContaining('https://git-scm.com/downloads') });
  expect(plan('linux', 'ubuntu', ['sudo', 'apt-get'])).toMatchObject({ command: ['sudo', 'apt-get', 'install', '-y', 'git'], needsSudo: true });
  expect(plan('linux', 'fedora', ['sudo', 'dnf'])).toMatchObject({ command: ['sudo', 'dnf', 'install', '-y', 'git'], needsSudo: true });
  expect(plan('linux', 'arch', ['sudo', 'pacman'])).toMatchObject({ command: ['sudo', 'pacman', '-S', '--noconfirm', 'git'], needsSudo: true });
  expect(plan('linux', 'alpine', ['sudo', 'apk'])).toMatchObject({ command: ['sudo', 'apk', 'add', 'git'], needsSudo: true });
  expect(plan('win32', undefined, ['winget'])).toMatchObject({ command: ['winget', 'install', '--id', 'Git.Git', '-e', '--source', 'winget'], needsSudo: false });
  expect(plan('linux', 'unknown', ['sudo', 'apt-get'])).toMatchObject({ command: null, display: expect.stringContaining('https://git-scm.com/downloads') });
  for (const [distro, manager] of [['debian', 'apt-get'], ['fedora', 'dnf'], ['arch', 'pacman'], ['alpine', 'apk']]) {
    expect(plan('linux', distro, [manager])).toMatchObject({ command: null, needsSudo: false, display: expect.stringContaining('https://git-scm.com/downloads') });
    expect(plan('linux', distro, ['sudo'])).toMatchObject({ command: null, needsSudo: false, display: expect.stringContaining('https://git-scm.com/downloads') });
  }
  expect(plan('win32', undefined, [])).toMatchObject({ command: null, needsSudo: false, display: expect.stringContaining('https://git-scm.com/downloads') });
});

describe('gitInstallPlan — root containers, fresh apt lists, macOS installer window', () => {
  const has = (names: string[]) => (name: string) => names.includes(name);
  test('root without sudo runs apt-get directly and updates package lists first (measured: ubuntu:24.04 container)', () => {
    const plan = gitInstallPlan({ platform: 'linux', distro: 'ubuntu', has: has(['apt-get']), isRoot: true });
    expect(plan.command).toEqual(['apt-get', 'install', '-y', 'git']);
    expect(plan.preCommands).toEqual([['apt-get', 'update']]);
    expect(plan.needsSudo).toBe(false);
  });
  test('non-root without sudo stays manual', () => {
    expect(gitInstallPlan({ platform: 'linux', distro: 'ubuntu', has: has(['apt-get']), isRoot: false }).command).toBeNull();
  });
  test('non-root with sudo prefixes both commands', () => {
    const plan = gitInstallPlan({ platform: 'linux', distro: 'debian', has: has(['apt-get', 'sudo']) });
    expect(plan.preCommands).toEqual([['sudo', 'apt-get', 'update']]);
    expect(plan.command).toEqual(['sudo', 'apt-get', 'install', '-y', 'git']);
  });
  test('macOS prefers brew; xcode-select waits for git', () => {
    expect(gitInstallPlan({ platform: 'darwin', has: has(['brew', 'xcode-select']) }).command).toEqual(['brew', 'install', 'git']);
    const x = gitInstallPlan({ platform: 'darwin', has: has(['xcode-select']) });
    expect(x.command).toEqual(['xcode-select', '--install']);
    expect(x.waitForGit).toBe(true);
  });
});
