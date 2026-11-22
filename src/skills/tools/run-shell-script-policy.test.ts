import { expect, test } from 'bun:test';
import { runShellScript, scriptCommandPolicy } from './run-shell-script.js';

test('git and gh read argv are classified by exact subcommand and full argument grammar', () => {
  const localReads = [
    ['git', 'log', '--oneline', '-n', '20', 'HEAD~2'],
    ['git', 'show', '--stat', 'origin/main'], ['git', 'rev-parse', 'HEAD'],
  ];
  for (const argv of localReads) {
    expect(scriptCommandPolicy(argv)).toBe('read-local');
  }
  for (const argv of [['git', 'status'], ['git', 'status', '--short', '--branch'], ['git', 'diff'], ['git', 'diff', 'HEAD'],
    ['git', 'diff', 'HEAD~1', 'HEAD'], ['git', 'ls-remote', '.'], ['git', 'ls-remote', 'origin']]) {
    expect(scriptCommandPolicy(argv)).toBe('approval');
  }
  const networkReads = [
    ['gh', 'pr', 'view', '39505', '--json', 'title,state'],
    ['gh', 'pr', 'list', '--state', 'open', '--limit', '20'],
    ['gh', 'pr', 'diff', '39505', '--name-only'],
    ['gh', 'api', 'repos/team/repo/issues?state=open&b=2', '--method', 'GET'],
    ['gh', 'api', 'repos/team/repo?'],
  ];
  for (const argv of networkReads) {
    expect(scriptCommandPolicy(argv)).toBe('read-network');
  }
});

test('git and gh write flags, config injection, remote ref and non-GET API are denied', () => {
  const forbidden = [
    ['git', 'commit', '-m', 'x'], ['git', 'push', 'origin', 'main'],
    ['git', '-c', 'core.fsmonitor=sh'], ['git', 'status', '--output', '/tmp/x'],
    ['git', 'diff', '--ext-diff'], ['git', 'show', 'HEAD:/etc/passwd'],
    ['git', 'log', '--max-count', '1000', 'HEAD'],
    ['gh', 'pr', 'merge', '39505'], ['gh', 'issue', 'create'],
    ['gh', 'pr', 'diff', '39505', '--web'], ['gh', 'pr', 'diff', '39505', '--repo', 'other/repo'],
    ['gh', 'api', 'repos/team/repo', '--method', 'POST'],
    ['gh', 'api', 'graphql'],
    ['gh', 'api', 'repos/team/repo', '-f', 'body=x'],
    ['gh', 'api', 'https://outside.example/api'],
    ['gh', 'api', 'repos/team/repo', '--hostname', 'outside.example'],
  ];
  for (const argv of forbidden) expect(scriptCommandPolicy(argv)).toBe('deny');
});

test('a reference cannot change a gh GET step into POST after the first step', async () => {
  const calls: string[] = [];
  await expect(runShellScript([
    { id: 'first', command: ['eln', 'ops', 'status'], select: ['method'] },
    { id: 'second', command: ['gh', 'api', 'repos/team/repo', '--method', '$ref:first.method'] },
  ], undefined, 2000, async (command) => {
    calls.push(command.join(' '));
    return { output: '', outcome: 'exit', exitCode: 0, elapsedMs: 1, stdout: '{"method":"POST"}', stderr: '',
      truncated: false, approvalKey: 'test', sandboxed: false, sandboxTool: 'none' };
  })).rejects.toThrow('refuses CLI action or argument');
  expect(calls).toEqual(['eln ops status']);
});

test('a static gh write in a later step is refused before the first read runs', async () => {
  const calls: string[] = [];
  await expect(runShellScript([
    { id: 'first', command: ['git', 'status', '--short'] },
    { id: 'second', command: ['gh', 'api', 'repos/team/repo', '--method', 'POST'] },
  ], undefined, 2000, async (command) => {
    calls.push(command.join(' '));
    throw new Error('must not dispatch');
  })).rejects.toThrow('refuses CLI action or argument');
  expect(calls).toEqual([]);
});

test('eln and host read argv use exact verbs and options while kubectl always needs approval', () => {
  for (const argv of [
    ['eln', 'memory', 'index'], ['eln', 'memory', 'where'], ['eln', 'memory', 'list', '--limit', '20'],
    ['eln', 'release', 'status', '0.3.33'],
    ['hostname'], ['uname', '-a'], ['uptime'], ['whoami'], ['pwd'], ['date', '-u'],
  ]) expect(scriptCommandPolicy(argv)).toBe('read-local');
  for (const argv of [
    ['kubectl', 'get', 'pods', '-n', 'default', '-o', 'json'],
    ['kubectl', 'describe', 'node', 'node-1'],
    ['eln', 'fleet', 'list'], ['eln', 'msg', 'route', 'TC-H-CX-15'],
    ['eln', 'release', 'checklist', 'status', '--version', '0.3.33'],
    ['elanous', 'release', 'checklist', 'list', '--json'],
  ]) expect(scriptCommandPolicy(argv)).toBe('read-network');
  for (const argv of [['eln', 'ops', 'status'], ['elanous', 'ops', 'health', '--json'],
    ['eln', 'memory', 'status'], ['eln', 'memory', 'search', 'hello'],
    ['eln', 'release', 'status', '0.3.33', '--write'], ['eln', 'release', 'status', '../secret'], ['eln', 'session', 'list'],
    ['eln', 'release', 'schedule', 'list'], ['eln', 'decisions', 'list'],
    ['eln', 'msg', 'list', '--thread', '123'],
    ['df', '-h'], ['ps'], ['ps', '-A', '-f'],
    ['eln', 'memory', 'show', 'abc123'], ['eln', 'session', 'show', 'abc123'],
    ['eln', 'decisions', 'show', 'abc123', '--json']]) expect(scriptCommandPolicy(argv)).toBe('approval');
});

test('30-minute check permits only the exact eln argv and bounded options', () => {
  const base = ['eln', 'ops', 'check-30m'];
  for (const args of [
    ['--json'], ['--previous-green', '0', '--json'], ['--json', '--previous-green', '9999'],
    ['--expect-version', '1.2.3', '--json'], ['--expect-version', '1.2.3-dev.0', '--json'],
    ['--expect-version', '1.2.3-dev.42', '--json'],
    ['--previous-green', '12', '--expect-version', '1.2.3', '--json'],
    ['--expect-version', '1.2.3', '--json', '--previous-green', '1'],
  ]) expect(scriptCommandPolicy([...base, ...args])).toBe('read-local');
  for (const value of ['00', '01', '10000', '-1', '+1', '1.0', '1e2', ' 1', '1\n', '1\r\n']) {
    expect(scriptCommandPolicy([...base, '--json', '--previous-green', value])).toBe('approval');
  }
  for (const value of ['1.2', 'v1.2.3', '1.2.3-dev', '1.2.3-dev.-1', '1.2.3-rc.1', '1.2.3\n', '1.2.3\r\n']) {
    expect(scriptCommandPolicy([...base, '--json', '--expect-version', value])).toBe('approval');
  }
  for (const args of [
    ['--previous-green', '1', '--expect-version', '1.2.3'],
    ['--json', '--previous-green'], ['--json', '--expect-version'],
    ['--json', '--previous-green', '1', '--previous-green', '2'],
    ['--json', '--expect-version', '1.2.3', '--expect-version', '1.2.4'],
    ['--json', '--previous-green=1'], ['--json', '--expect-version=1.2.3'],
    ['--json', '--previous-green', '$ref:first.count'],
  ]) expect(scriptCommandPolicy([...base, ...args])).toBe('approval');
  for (const argv of [
    ['elanous', 'ops', 'check-30m', '--json'], ['eln', 'ops', 'check-30m'],
    ['eln', 'ops', 'check-30m', '--json', '--extra'], ['eln', 'ops', 'check-30m', '--json', '--json'],
    ['eln', 'ops', 'check-30m', '--json', 'extra'], ['eln', 'ops', 'check-30m-extra', '--json'],
    ['eln', 'ops', '--json', 'check-30m'], ['eln', 'ops', 'check-30m', '--json=true'],
    ['eln', 'ops', 'check-30m', '$ref:first.flag'],
  ]) expect(scriptCommandPolicy(argv)).toBe('approval');
});

test('mail body reads require human approval for both CLIs and all recipient forms', () => {
  for (const bin of ['eln', 'elanous']) {
    for (const args of [
      ['msg', 'list'], ['msg', 'list', '--to', 'OTHER'],
      ['msg', 'list', '--to', '$ref:first.seat'], ['msg', 'list', '--to=OTHER'],
      ['msg', 'list', '--to', 'SELF', '--to', 'OTHER'],
      ['msg', 'show', '123'], ['msg', 'show', '123', '--to', 'OTHER'],
    ]) expect(scriptCommandPolicy([bin, ...args])).toBe('approval');
    expect(scriptCommandPolicy([bin, 'msg', 'route', 'OTHER'])).toBe('read-network');
  }
});

test('read prefixes cannot hide writes, credential reads, path reads or network bypasses', () => {
  for (const argv of [
    ['kubectl', 'get', 'secrets'], ['kubectl', 'get', 'pods', '--raw', '/api/v1'],
    ['kubectl', 'get', 'pods', '-o', 'go-template={{.metadata.name}}'],
    ['kubectl', 'get', 'pods', '--kubeconfig', '/tmp/evil'],
    ['kubectl', 'describe', 'pods', '--context', 'prod'],
    ['kubectl', 'exec', 'pod', '--', 'sh'],
    ['uname', '-a', '--output', '/tmp/evil'], ['cat', '/etc/passwd'],
    ['date', '-f', '/tmp/evil'], ['df', '/tmp/evil'],
  ]) expect(scriptCommandPolicy(argv)).toBe('deny');
  expect(scriptCommandPolicy(['eln', 'memory', 'show', '--output', '/tmp/evil'])).toBe('approval');
});
