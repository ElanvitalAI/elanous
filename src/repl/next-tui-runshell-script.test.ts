import { afterEach, beforeAll, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { testRunShellIssuer as issuer } from '../shell-primitive/runshell-test-issuer.js';
import { RUNSHELL_APPROVAL_CALL, RUNSHELL_APPROVAL_RESULT, type RunShellApprovalCall } from '../tui-client/next-runshell-approval.js';
let buildReplTools: typeof import('./index.js').buildReplTools;
beforeAll(async () => { ({ buildReplTools } = await import('./index.js')); });
import { NEXT_TUI_SHELL_APPROVAL_IPC_ENV, type ShellApprovalIpcProcess } from '../tui-client/next-shell-approval.js';

const oldPath = process.env.PATH;
const oldHome = process.env.HOME, oldSeat = process.env.ELANOUS_TRACK, oldSend = process.send;
const connectedDescriptor = Object.getOwnPropertyDescriptor(process, 'connected');
function signedApprovals(commands: string[], approve: () => boolean) {
  process.env.HOME = root;
  process.env.ELANOUS_TRACK = 'test-seat';
  Object.defineProperty(process, 'connected', { configurable: true, value: true });
  (process as any).send = (message: RunShellApprovalCall) => {
    if (message.type === RUNSHELL_APPROVAL_CALL) {
      commands.push([basename(message.request.argv[0]!), ...message.request.argv.slice(1)].join(' '));
      const approval = approve() ? issuer.issue(message.request) : null;
      queueMicrotask(() => process.emit('message', { type: RUNSHELL_APPROVAL_RESULT, callId: message.callId, approval }));
    }
    return true;
  };
}
const oldApprovalIpc = process.env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV];
let root = '';
afterEach(() => {
  (process as any).send = oldSend;
  if (connectedDescriptor) Object.defineProperty(process, 'connected', connectedDescriptor);
  else delete (process as any).connected;
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldSeat === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = oldSeat;
  if (oldPath === undefined) delete process.env.PATH;
  else process.env.PATH = oldPath;
  if (oldApprovalIpc === undefined) delete process.env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV];
  else process.env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV] = oldApprovalIpc;
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

test('Next TUI requests approval for each script command and stops at a denial', async () => {
  root = mkdtempSync(join(tmpdir(), 'next-runshell-script-approval-'));
  const marker = join(root, 'calls');
  const cli = join(root, 'eln');
  writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' "$2" >> '${marker}'\nprintf '{"value":"%s"}' "$2"\n`);
  chmodSync(cli, 0o700);
  process.env.PATH = `${root}:${oldPath ?? ''}`;
  process.env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV] = '1';
  class ApprovalProcess extends EventEmitter implements ShellApprovalIpcProcess {
    readonly commands: string[] = [];
    send(message: unknown): boolean {
      const call = message as { type: string; callId: string; command: string };
      if (call.type === 'elanous.shell-approval.call') {
        this.commands.push(call.command);
        queueMicrotask(() => this.emit('message', { type: 'elanous.shell-approval.result',
          callId: call.callId, approved: this.commands.length === 1 }));
      }
      return true;
    }
  }
  const approval = new ApprovalProcess();
  const tools = buildReplTools({ shellApprovalProcess: approval, sessionId: 'test-session' });
  const result = await tools.dispatch('RunShell', { approval: 'always', script: [
    { id: 'one', command: ['eln', 'memory', 'index'] },
    { id: 'two', command: ['eln', 'memory', 'where'] },
  ] }) as { outcome: string; stdout: string };
  expect(result.outcome).toBe('denied');
  expect(approval.commands).toEqual(['eln memory index', 'eln memory where']);
  expect(readFileSync(marker, 'utf8')).toBe('index\n');
  expect(JSON.parse(result.stdout).steps.map((step: { id: string }) => step.id)).toEqual(['one', 'two']);
});

test('Next TUI RunShell route accepts script and consumes both CLI results', async () => {
  root = mkdtempSync(join(tmpdir(), 'next-runshell-script-'));
  const marker = join(root, 'calls');
  const cli = join(root, 'eln');
  writeFileSync(cli, `#!/bin/sh\nprintf 'call\\n' >> '${marker}'\nprintf '{"value":"%s"}' "$2"\n`);
  chmodSync(cli, 0o700);
  process.env.PATH = `${root}:${oldPath ?? ''}`;
  process.env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV] = '1';
  const channel = new EventEmitter() as EventEmitter & ShellApprovalIpcProcess;
  const requests: string[] = [];
  channel.send = (message: unknown) => {
    const call = message as { type: string; callId: string; command: string };
    if (call.type === 'elanous.shell-approval.call') {
      requests.push(call.command);
      queueMicrotask(() => channel.emit('message', { type: 'elanous.shell-approval.result', callId: call.callId, approved: false }));
    }
    return true;
  };
  const tools = buildReplTools({ shellApprovalProcess: channel, sessionId: 'test-session' });
  const result = await tools.dispatch('RunShell', { script: [
    { id: 'one', command: ['eln', 'memory', 'index'], select: ['value'] },
    { id: 'two', command: ['eln', 'memory', 'where'], select: ['value'] },
  ] }) as { outcome: string; exitCode: number; stdout: string };
  expect([result.outcome, result.exitCode]).toEqual(['exit', 0]);
  expect(JSON.parse(result.stdout).steps.map((step: { selected: { value: string } }) => step.selected.value)).toEqual(['index', 'where']);
  expect(readFileSync(marker, 'utf8')).toBe('call\ncall\n');
  expect(requests).toEqual([]);

  delete process.env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV];
  const denied = await buildReplTools().dispatch('RunShell', { script: [
    { id: 'blocked', command: ['eln', 'memory', 'index'] },
  ] }) as { outcome: string };
  expect(denied.outcome).toBe('denied');
  expect(readFileSync(marker, 'utf8')).toBe('call\ncall\n');
});

test('an unlisted script argv requests human approval with default options and denial prevents CLI execution', async () => {
  root = mkdtempSync(join(tmpdir(), 'next-runshell-script-unlisted-'));
  const marker = join(root, 'calls');
  const cli = join(root, 'eln');
  writeFileSync(cli, `#!/bin/sh\nprintf 'call\\n' >> '${marker}'\n`);
  chmodSync(cli, 0o700);
  process.env.PATH = `${root}:${oldPath ?? ''}`;
  process.env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV] = '1';
  class ApprovalProcess extends EventEmitter implements ShellApprovalIpcProcess {
    readonly commands: string[] = [];
    constructor(private readonly approved: boolean) { super(); }
    send(message: unknown): boolean {
      const call = message as { type: string; callId: string; command: string };
      if (call.type === 'elanous.shell-approval.call') {
        this.commands.push(call.command);
        queueMicrotask(() => this.emit('message', { type: 'elanous.shell-approval.result', callId: call.callId, approved: this.approved }));
      }
      return true;
    }
  }
  const approval = new ApprovalProcess(false);
  signedApprovals(approval.commands, () => false);
  const tools = buildReplTools({ shellApprovalProcess: approval, sessionId: 'test-session' });
  const result = await tools.dispatch('RunShell', { script: [
    { id: 'outside', command: ['eln', 'ops', 'status', '--output', '/tmp/unsafe'] },
  ] }) as { outcome: string };
  expect(result.outcome).toBe('denied');
  expect(approval.commands).toEqual(['eln ops status --output /tmp/unsafe']);
  expect(existsSync(marker)).toBe(false);

  const write = await tools.dispatch('RunShell', { script: [
    { id: 'write', command: ['eln', 'memory', 'delete', 'synthetic-id'] },
  ] }) as { outcome: string };
  expect(write.outcome).toBe('denied');
  expect(approval.commands).toEqual(['eln ops status --output /tmp/unsafe', 'eln memory delete synthetic-id']);
  expect(existsSync(marker)).toBe(false);

  const network = await tools.dispatch('RunShell', { network: 'inherit', script: [
    { id: 'network', command: ['eln', 'ops', 'status'] },
  ] }) as { outcome: string };
  expect(network.outcome).toBe('denied');
  expect(approval.commands).toEqual(['eln ops status --output /tmp/unsafe', 'eln memory delete synthetic-id', 'eln ops status']);
  expect(existsSync(marker)).toBe(false);

  const granted = new ApprovalProcess(true);
  signedApprovals(granted.commands, () => true);
  const accepted = await buildReplTools({ shellApprovalProcess: granted, sessionId: 'test-session' }).dispatch('RunShell', { script: [
    { id: 'outside', command: ['eln', 'memory', 'delete', 'synthetic-id'] },
  ] }) as { outcome: string; exitCode: number };
  expect([accepted.outcome, accepted.exitCode]).toEqual(['exit', 0]);
  expect(granted.commands).toEqual(['eln memory delete synthetic-id']);
  expect(readFileSync(marker, 'utf8')).toBe('call\n');
});

test('git local read needs no prompt while gh GET needs approval and gh write never runs', async () => {
  root = mkdtempSync(join(tmpdir(), 'next-runshell-git-gh-'));
  const gitCalls = join(root, 'git-calls');
  const gitArgs = join(root, 'git-args');
  const gitEnv = join(root, 'git-env');
  const ghCalls = join(root, 'gh-calls');
  writeFileSync(join(root, 'git'), `#!/bin/sh\nprintf 'git\\n' >> '${gitCalls}'\nprintf '%s\\n' "$@" > '${gitArgs}'\nprintf '%s:%s' "$GIT_NO_LAZY_FETCH" "$GIT_TERMINAL_PROMPT" > '${gitEnv}'\nprintf '{"kind":"git"}'\n`);
  writeFileSync(join(root, 'gh'), `#!/bin/sh\nprintf 'gh\\n' >> '${ghCalls}'\nprintf '{"kind":"gh"}'\n`);
  chmodSync(join(root, 'git'), 0o700);
  chmodSync(join(root, 'gh'), 0o700);
  process.env.PATH = `${root}:${oldPath ?? ''}`;
  process.env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV] = '1';
  class ApprovalProcess extends EventEmitter implements ShellApprovalIpcProcess {
    readonly commands: string[] = [];
    approved = false;
    send(message: unknown): boolean {
      const call = message as { type: string; callId: string; command: string };
      if (call.type === 'elanous.shell-approval.call') {
        this.commands.push(call.command);
        queueMicrotask(() => this.emit('message', { type: 'elanous.shell-approval.result', callId: call.callId, approved: this.approved }));
      }
      return true;
    }
  }
  const approval = new ApprovalProcess();
  signedApprovals(approval.commands, () => approval.approved);
  const tools = buildReplTools({ shellApprovalProcess: approval, sessionId: 'test-session' });
  const git = await tools.dispatch('RunShell', { script: [{ id: 'git', command: ['git', 'log', '--oneline', 'HEAD'], select: ['kind'] }] }) as { outcome: string; stdout: string };
  expect(git.outcome).toBe('exit');
  expect(JSON.parse(git.stdout).steps[0].selected.kind).toBe('git');
  expect(approval.commands).toEqual([]);
  expect(readFileSync(gitCalls, 'utf8')).toBe('git\n');
  expect(readFileSync(gitArgs, 'utf8')).toContain('--no-optional-locks\n');
  expect(readFileSync(gitArgs, 'utf8')).toContain('core.fsmonitor=false\n');
  expect(readFileSync(gitArgs, 'utf8')).toContain('diff.external=\n');
  expect(readFileSync(gitEnv, 'utf8')).toBe('1:0');

  const worktree = await tools.dispatch('RunShell', { script: [{ id: 'worktree', command: ['git', 'status', '--short'] }] }) as { outcome: string };
  expect(worktree.outcome).toBe('denied');
  expect(approval.commands).toEqual(['git status --short']);
  expect(readFileSync(gitCalls, 'utf8')).toBe('git\n');

  const remote = await tools.dispatch('RunShell', { script: [{ id: 'remote', command: ['git', 'ls-remote', '.'] }] }) as { outcome: string };
  expect(remote.outcome).toBe('denied');
  expect(approval.commands).toEqual(['git status --short', 'git ls-remote .']);
  expect(readFileSync(gitCalls, 'utf8')).toBe('git\n');

  const endpoint = 'repos/team/repo/issues?state=open&per_page=2';
  const denied = await tools.dispatch('RunShell', { script: [{ id: 'gh', command: ['gh', 'api', endpoint] }] }) as { outcome: string };
  expect(denied.outcome).toBe('denied');
  expect(approval.commands).toEqual(['git status --short', 'git ls-remote .', `gh api ${endpoint}`]);
  expect(existsSync(ghCalls)).toBe(false);

  approval.approved = true;
  const gh = await tools.dispatch('RunShell', { script: [{ id: 'gh', command: ['gh', 'api', endpoint], select: ['kind'] }] }) as { outcome: string; stdout: string };
  expect(gh.outcome).toBe('exit');
  expect(JSON.parse(gh.stdout).steps[0].selected.kind).toBe('gh');
  expect(approval.commands).toEqual(['git status --short', 'git ls-remote .', `gh api ${endpoint}`, `gh api ${endpoint}`]);
  expect(readFileSync(ghCalls, 'utf8')).toBe('gh\n');
});

test('TUI script consumes eln and host reads while kubectl needs prior approval', async () => {
  root = mkdtempSync(join(tmpdir(), 'next-runshell-read-bundle-'));
  const marker = join(root, 'calls');
  for (const binary of ['eln', 'hostname', 'kubectl', 'df']) {
    const file = join(root, binary);
    writeFileSync(file, `#!/bin/sh\nprintf '${binary}\\n' >> '${marker}'\nprintf '{"kind":"${binary}"}'\n`);
    chmodSync(file, 0o700);
  }
  process.env.PATH = `${root}:${oldPath ?? ''}`;
  process.env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV] = '1';
  const channel = new EventEmitter() as EventEmitter & ShellApprovalIpcProcess;
  const requests: string[] = [];
  let approved = false;
  channel.send = (message: unknown) => {
    const call = message as { type: string; callId: string; command: string };
    if (call.type === 'elanous.shell-approval.call') {
      requests.push(call.command);
      queueMicrotask(() => channel.emit('message', { type: 'elanous.shell-approval.result', callId: call.callId, approved }));
    }
    return true;
  };
  signedApprovals(requests, () => approved);
  const tools = buildReplTools({ shellApprovalProcess: channel, sessionId: 'test-session' });
  const local = await tools.dispatch('RunShell', { script: [
    { id: 'memory', command: ['eln', 'memory', 'index'], select: ['kind'] },
    { id: 'host', command: ['hostname'], select: ['kind'] },
  ] }) as { outcome: string; stdout: string };
  expect(local.outcome).toBe('exit');
  expect(JSON.parse(local.stdout).steps.map((step: { selected: { kind: string } }) => step.selected.kind)).toEqual(['eln', 'hostname']);
  expect(requests).toEqual([]);
  const denied = await tools.dispatch('RunShell', { script: [
    { id: 'cluster', command: ['kubectl', 'get', 'pods', '-n', 'default', '-o', 'json'] },
  ] }) as { outcome: string };
  expect(denied.outcome).toBe('denied');
  expect(readFileSync(marker, 'utf8')).toBe('eln\nhostname\n');
  const remoteMount = await tools.dispatch('RunShell', { script: [
    { id: 'mount', command: ['df', '-h'] },
  ] }) as { outcome: string };
  expect(remoteMount.outcome).toBe('denied');
  expect(readFileSync(marker, 'utf8')).toBe('eln\nhostname\n');
  approved = true;
  const accepted = await tools.dispatch('RunShell', { script: [
    { id: 'cluster', command: ['kubectl', 'get', 'pods', '-n', 'default', '-o', 'json'], select: ['kind'] },
  ] }) as { outcome: string; stdout: string };
  expect(accepted.outcome).toBe('exit');
  expect(JSON.parse(accepted.stdout).steps[0].selected.kind).toBe('kubectl');
  expect(requests).toEqual(['kubectl get pods -n default -o json', 'df -h', 'kubectl get pods -n default -o json']);
});

test('check uses the approval broker and denial prevents execution', async () => {
  root = mkdtempSync(join(tmpdir(), 'repl-check-deny-'));
  const marker = join(root, 'executed');
  writeFileSync(join(root, 'eln'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${marker}'\nprintf '{}\\n'\n`);
  chmodSync(join(root, 'eln'), 0o700);
  process.env.PATH = `${root}:${oldPath ?? ''}`;
  process.env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV] = '1';
  const channel = new EventEmitter() as EventEmitter & ShellApprovalIpcProcess;
  const prompts: string[] = [];
  channel.send = (message: unknown) => {
    const m = message as { type: string; callId: string; command: string };
    if (m.type === 'elanous.shell-approval.call') {
      prompts.push(m.command);
      queueMicrotask(() => channel.emit('message', { type: 'elanous.shell-approval.result', callId: m.callId, approved: false }));
    }
    return true;
  };
  const tools = buildReplTools({ shellApprovalProcess: channel });
  const result = await tools.dispatch('RunShell', { check: '30-minute', checkSeat: 'OP', checkVersion: '0.3.33', checkPreviousGreen: 3, approval: 'always' }) as { outcome: string; stdout: string };
  expect(result.outcome).toBe('denied');
  expect(prompts).toEqual(['eln msg count --to OP --json']);
  expect(existsSync(marker)).toBe(false);
  expect(JSON.parse(result.stdout).steps.map((s: { id: string; outcome: string }) => [s.id, s.outcome])).toEqual([['inbox', 'denied']]);
});

test('check default policy runs op check and cost without approval', async () => {
  root = mkdtempSync(join(tmpdir(), 'repl-check-step-'));
  const marker = join(root, 'executed');
  writeFileSync(join(root, 'eln'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${marker}'\nprintf '{\"originMainFreshness\":null,\"lastFetchAt\":null,\"fetchStale\":false,\"legacyQueueRows\":0,\"version\":\"0.3.33\",\"landings30m\":0,\"landingsWithoutPr30m\":0,\"landingTarget\":0,\"green\":0,\"greenDelta\":0,\"greenDeltaTarget\":0,\"reviewUnclaimed\":0,\"malformedQueueRows\":0,\"unknownQueueRows\":0,\"unclaimedUnknownQueueRows\":0,\"trainTickObserved\":true,\"landingSubObserved\":true,\"complete\":true}\\n'\n`);
  chmodSync(join(root, 'eln'), 0o700);
  process.env.PATH = `${root}:${oldPath ?? ''}`;
  process.env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV] = '1';
  const channel = new EventEmitter() as EventEmitter & ShellApprovalIpcProcess;
  const prompts: string[] = [];
  channel.send = (message: unknown) => {
    const m = message as { type: string; callId: string; command: string };
    if (m.type === 'elanous.shell-approval.call') {
      prompts.push(m.command);
      queueMicrotask(() => channel.emit('message', { type: 'elanous.shell-approval.result', callId: m.callId, approved: false }));
    }
    return true;
  };
  const result = await buildReplTools({ shellApprovalProcess: channel }).dispatch('RunShell', { check: '30-minute', checkSeat: 'OP', checkVersion: '0.3.33', checkPreviousGreen: 3 }) as { outcome: string; stdout: string };
  expect(result.outcome).toBe('exit');
  expect(prompts).toEqual([]);
  expect(readFileSync(marker, 'utf8')).toBe('msg count --to OP --json\nops check-30m --previous-green 3 --expect-version 0.3.33 --json\nusage runs --since 30m --by role --json\n');
  const summary = JSON.parse(result.stdout);
  expect(summary.inbox).toEqual({ status: 'unknown', count: null, complete: false });
  expect(summary.steps.map((s: { id: string; outcome: string }) => [s.id, s.outcome])).toEqual([['inbox', 'exit'], ['op_check', 'exit'], ['cost', 'exit']]);
});

test('without IPC only exact default check argv execute, all variants fail closed', async () => {
  root = mkdtempSync(join(tmpdir(), 'repl-exact-check-'));
  const marker = join(root, 'calls');
  writeFileSync(join(root, 'eln'), `#!/bin/sh\nprintf 'call\\n' >> '${marker}'\nprintf '{}\\n'\n`);
  chmodSync(join(root, 'eln'), 0o700);
  process.env.PATH = `${root}:${oldPath ?? ''}`;
  delete process.env[NEXT_TUI_SHELL_APPROVAL_IPC_ENV];
  const tools = buildReplTools();
  const op = ['eln', 'ops', 'check-30m', '--previous-green', '3', '--expect-version', '0.3.33', '--json'];
  const cost = ['eln', 'usage', 'runs', '--since', '30m', '--by', 'role', '--json'];
  const inbox = ['eln', 'msg', 'count', '--to', 'OP', '--json'];
  for (const command of [op, cost, inbox]) {
    const result = await tools.dispatch('RunShell', { script: [{ id: 'test', command }] }) as { outcome: string };
    expect(result.outcome).toBe('exit');
  }
  const variants = [
    ['eln', 'msg', 'count', '--to', 'MK', '--json'], inbox.slice(0, -1), [...inbox, '--extra'],
    ['elanous', ...inbox.slice(1)], ['eln', 'msg', 'unread', '--to', 'OP', '--json'],
    ['eln', 'usage', 'runs', '--since', '1d', '--by', 'role', '--json'],
    ['eln', 'usage', 'runs', '--since', '30m', '--by', 'run', '--json'],
    [...cost, '--extra'], cost.slice(0, -1),
    ['elanous', ...cost.slice(1)], ['eln', 'ops', 'status'],
    ['eln', 'ops', 'check-30m', '--json'], [...op, '--extra'],
    ['eln', 'ops', 'check-30m', '--expect-version', '0.3.33', '--previous-green', '3', '--json'],
  ];
  for (const command of variants) {
    const result = await tools.dispatch('RunShell', { script: [{ id: 'test', command }] }) as { outcome?: string; error?: string };
    expect(result.outcome === 'denied' || !!result.error).toBe(true);
  }
  for (const options of [{ approval: 'always' }, { approval: 'first-time' }, { network: 'inherit' }]) {
    const result = await tools.dispatch('RunShell', { ...options, script: [{ id: 'test', command: cost }] }) as { outcome: string };
    expect(result.outcome).toBe('denied');
  }
  expect(readFileSync(marker, 'utf8')).toBe('call\ncall\ncall\n');
});
