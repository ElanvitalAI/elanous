import { describe, expect, test } from 'bun:test';
import { isGithubGitRemote, runGithubRemoteCall } from './remote-call.js';

const call = {
  kind: 'rest' as const,
  caller: 'readPrFiles',
  route: 'repos/{owner}/{repo}/pulls/:number/files',
  method: 'GET',
  host: 'github.com',
};

describe('GithubRemoteCall', () => {
  test('runs the original call and emits one completion with safe metadata', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const times = [100, 115];
    const body = 'ghs_secret_response';
    const result = await runGithubRemoteCall(call, async () => body, {
      now: () => times.shift()!,
      status: () => 200,
      emit: (category, event, data) => events.push({ category, event, data }),
    });
    expect(result).toBe(body);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ category: 'github.transport', event: 'complete', data: {
      caller: 'readPrFiles', kind: 'rest', status: 200, ok: true, durationMs: 15, scopeId: 'unmeasured', retry: 'unmeasured',
    } });
    expect(JSON.stringify(events)).not.toContain(body);
  });

  test('records a failed call once and preserves the original error even if telemetry fails', async () => {
    const events: Array<Record<string, unknown>> = [];
    const failure = new Error('secret exception body');
    await expect(runGithubRemoteCall(call, async () => { throw failure; }, {
      status: () => 429,
      emit: (_category, _event, data) => { events.push(data); throw new Error('sink down'); },
    })).rejects.toBe(failure);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 429, ok: false });
    expect(JSON.stringify(events)).not.toContain('secret exception body');
  });

  test('a failing clock cannot prevent the original call or replace its result', async () => {
    const events: Array<Record<string, unknown>> = [];
    const result = await runGithubRemoteCall(call, async () => 'original', {
      now: () => { throw new Error('clock down'); },
      emit: (_category, _event, data) => { events.push(data); },
    });
    expect(result).toBe('original');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ durationMs: 'unmeasured', retry: 'unmeasured', status: 'unmeasured', ok: true });
  });

  test('even an undefined thrown value is recorded as a failure', async () => {
    const events: Array<Record<string, unknown>> = [];
    let caught = false;
    try {
      await runGithubRemoteCall(call, async () => { throw undefined; }, {
        status: ({ failed }) => failed ? 0 : 200,
        emit: (_category, _event, data) => { events.push(data); },
      });
    } catch (error) {
      caught = true;
      expect(error).toBeUndefined();
    }
    expect(caught).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ok: false, status: 0 });
  });

  test('excludes local Git fixtures from the remote denominator', () => {
    expect(isGithubGitRemote('https://github.com/acme/repo.git')).toBe(true);
    expect(isGithubGitRemote('git@github.com:acme/repo.git')).toBe(true);
    expect(isGithubGitRemote('ssh://git@ssh.github.com/acme/repo.git')).toBe(true);
    expect(isGithubGitRemote('/tmp/fixture.git')).toBe(false);
    expect(isGithubGitRemote('file:///tmp/fixture.git')).toBe(false);
    expect(isGithubGitRemote('file://github.com/fixture.git')).toBe(false);
    expect(isGithubGitRemote('git@localhost:fixture.git')).toBe(false);
  });
});
