import { describe, expect, test } from 'bun:test';
import { collectEnvProfile } from './env-profile.js';

describe('collectEnvProfile', () => {
  test('reports exactly the available package managers and CLI tools in the requested order', () => {
    const lookedUp: string[] = [];
    const profile = collectEnvProfile({
      env: { SHELL: '/bin/zsh' },
      which: (name) => { lookedUp.push(name); return ['brew', 'bun', 'git', 'jq', 'curl', 'claude'].includes(name); },
      exec: (command) => command === 'df'
        ? { status: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 200 150 50 75% /\n' }
        : { status: 0, stdout: '' },
    });
    expect(lookedUp).toEqual([
      'brew', 'apt', 'npm', 'pip', 'bun',
      'git', 'jq', 'rg', 'sed', 'awk', 'curl', 'ffmpeg', 'docker', 'kubectl', 'gh', 'codex', 'claude',
    ]);
    expect(profile).toEqual({
      os: process.platform, shell: '/bin/zsh', packageManagers: ['brew', 'bun'],
      tools: ['git', 'jq', 'curl', 'claude'],
      credentials: { github: false, openai: false, anthropic: false },
      network: true, disk: { availableKb: 50 },
    });
  });

  test('reads available space when a long filesystem name wraps onto a separate line', () => {
    const calls: string[][] = [];
    const profile = collectEnvProfile({
      env: {},
      which: () => false,
      exec: (command, args) => {
        calls.push([command, ...args]);
        return { status: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/a-very-long-filesystem-name\n 200 150 50 75% /\n' };
      },
    });
    expect(calls).toEqual([['df', '-kP', '.']]);
    expect(profile.disk).toEqual({ availableKb: 50 });
  });

  test('does not mistake a usage percentage for available space in malformed df output', () => {
    const profile = collectEnvProfile({
      env: {}, which: () => false,
      exec: () => ({ status: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/long-name\n200 150 50 75%\n' }),
    });
    expect(profile.disk).toBeNull();
  });

  test('checks credential presence without leaking values, including empty values', () => {
    const secret = 'must-never-appear-in-profile';
    const profile = collectEnvProfile({
      env: { GH_TOKEN: '', OPENAI_API_KEY: secret, ANTHROPIC_API_KEY: secret },
      which: () => false,
      exec: () => ({ status: 1, stdout: secret }),
    });
    expect(profile.credentials).toEqual({ github: true, openai: true, anthropic: true });
    expect(JSON.stringify(profile)).not.toContain(secret);
    expect(profile.network).toBe(false);
    expect(profile.disk).toBeNull();
  });

  test('recognizes the alternate GitHub credential name and failed curl probe', () => {
    const calls: string[][] = [];
    const profile = collectEnvProfile({
      env: { GITHUB_TOKEN: 'private' },
      which: (name) => name === 'curl',
      exec: (command, args) => {
        calls.push([command, ...args]);
        return { status: 1, stdout: 'private' };
      },
    });
    expect(profile.credentials).toEqual({ github: true, openai: false, anthropic: false });
    expect(profile.network).toBe(false);
    expect(JSON.stringify(profile)).not.toContain('private');
    expect(calls.map(([command]) => command)).toEqual(['curl', 'df']);
  });

  test('does not invoke network commands without curl and handles failed probes', () => {
    const calls: string[][] = [];
    const profile = collectEnvProfile({
      env: {},
      which: (name) => { if (name === 'rg') throw new Error('missing'); return false; },
      exec: (command, args) => { calls.push([command, ...args]); throw new Error('unavailable'); },
    });
    expect(profile.tools).toEqual([]);
    expect(profile.network).toBe(false);
    expect(profile.disk).toBeNull();
    expect(calls).toEqual([['df', '-kP', '.']]);
  });
});
