import { afterEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// In the isolated child, install the parent key before the gateway captures it.
import { testRunShellIssuer as issuer } from '../../shell-primitive/runshell-test-issuer.js';
import { buildRunShellTool, dispatchRunShell, scriptCommandPolicy } from './shell.js';
import { defaultCheckScript } from './run-shell-default-checks.js';
import { runShellScript } from './run-shell-script.js';
import { createRunShellApprovalIssuer, RUNSHELL_PUBLIC_KEY_ENV, RUNSHELL_APPROVAL_RESULT, type RunShellApprovalCall } from '../../tui-client/next-runshell-approval.js';
import { MsgStore } from '../../msg/msg-store.js';

const oldPath = process.env.PATH;
const oldState = process.env.ELANOUS_STATE_DIR;
let root = '';
afterEach(() => {
  if (oldPath === undefined) delete process.env.PATH;
  else process.env.PATH = oldPath;
  if (oldState === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = oldState;
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function fakeReadOnlyCli(): void {
  root = mkdtempSync(join(tmpdir(), 'default-check-'));
  process.env.ELANOUS_STATE_DIR = root;
  const cli = join(root, 'eln');
  writeFileSync(cli, `#!/bin/sh
printf '%s\\n' "$*" >> '${root}/calls'
case "$1:$2:$3" in
  msg:list:*) printf '[{"id":17,"to":"OP","body":"PRIVATE-MAIL-CANARY"}]' ;;
  msg:count:*) if [ -f '${root}/real-count.ts' ]; then exec '${process.execPath}' '${root}/real-count.ts' "$@"; fi; if [ -f '${root}/count-fail' ]; then exit 7; fi; cat '${root}/count.json' ;;
  msg:unread:*) printf '[{"recipient":"OP","count":1}]' ;;
  ops:status:*) printf '{"healthy":true}' ;;
  ops:check-30m:*) if [ -f '${root}/git-fail' ]; then printf '{"complete":false,"error":{"code":"GIT_FAILED","message":"git failed at /private/secret"},"private":"DO-NOT-PROJECT"}'; exit 1; fi; printf '{"originMainFreshness":"origin/main 기준 시각 2026-11-22T09:00:00.000Z(오래됐을 수 있음)","lastFetchAt":"2026-11-22T09:00:00.000Z","fetchStale":true,"legacyQueueRows":2,"version":"0.3.33","landings30m":12,"landingsWithoutPr30m":1,"landingTarget":10,"green":9,"greenDelta":6,"greenDeltaTarget":5,"reviewUnclaimed":1,"malformedQueueRows":0,"unknownQueueRows":2,"unclaimedUnknownQueueRows":1,"trainTickObserved":true,"landingSubObserved":true,"complete":false}' ;;
  release:checklist:status) printf '{"green":4,"yellow":1,"red":0,"done":2}' ;;
  release:checklist:landed-but-yellow) printf '{"snapshot":{"ageMs":1500,"stale":false},"results":[]}' ;;
  release:checklist:evidence) cat '${root}/evidence.json' ;;
  usage:runs:*) printf '[{"usdKnown":0.01,"unknownCostCalls":0,"estimatedCalls":0}]' ;;
  *) exit 8 ;;
esac
`);
  writeFileSync(join(root, 'count.json'), JSON.stringify({ status: 'unknown', count: null }));
  chmodSync(cli, 0o700);
  process.env.PATH = `${root}:${oldPath ?? ''}`;
}

const approval = async (command: string[]) => ({ allowed: true,
  priorHumanApproval: (command[1] === 'ops' && command[2] === 'check-30m')
    || (command[1] === 'release' && command[2] === 'checklist' && command[3] !== 'landed-but-yellow') });

test('mail count without a card is limited to the exact OP JSON argv', () => {
  expect(scriptCommandPolicy(['eln', 'msg', 'count', '--to', 'OP', '--json'])).toBe('read-local');
  expect(scriptCommandPolicy(['eln', 'msg', 'count', '--to', 'JUD-2', '--json'])).toBe('approval');
  expect(scriptCommandPolicy(['eln', 'msg', 'count', '--to', 'JUD-2'])).toBe('approval');
  expect(scriptCommandPolicy(['eln', 'msg', 'count', '--to', 'OP'])).toBe('approval');
});

test('default check input contract matches local policy and schema', async () => {
  const base = { check: '30-minute', checkSeat: 'OP', checkVersion: '1.2.3', checkPreviousGreen: 0 };
  for (const version of ['1.2.3', '1.2.3-dev.0', '1.2.3-dev.123']) {
    for (const previous of [0, 9999]) {
      const script = defaultCheckScript({ ...base, checkVersion: version, checkPreviousGreen: previous });
      const opCheck = script.find((step) => step.id === 'op_check')!;
      expect(scriptCommandPolicy(opCheck.command)).toBe('read-local');
      expect(opCheck.command).toContain(version);
    }
  }
  for (const version of ['1.2.3\n', '1.2.3\r\n', '1.2.3-dev.', '1.2.3-beta.1']) {
    expect(() => defaultCheckScript({ ...base, checkVersion: version })).toThrow('invalid release version');
  }
  for (const previous of [undefined, -1, 10000, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    expect(() => defaultCheckScript({ ...base, checkPreviousGreen: previous })).toThrow('previous green');
  }
  let approvals = 0;
  await expect(dispatchRunShell({ ...base, checkPreviousGreen: 10000 }, { scriptApproval: async () => { approvals++; return { allowed: true, priorHumanApproval: false }; } })).rejects.toThrow('previous green');
  expect(approvals).toBe(0);
  const schema = buildRunShellTool().parameters as { oneOf: Array<{ required: string[] }>; properties: { checkPreviousGreen: { minimum: number; maximum: number } } };
  expect(schema.oneOf.find((variant) => variant.required.includes('check'))?.required).toContain('checkPreviousGreen');
  expect(schema.properties.checkPreviousGreen).toMatchObject({ minimum: 0, maximum: 9999 });
});

test('OP 30-minute check runs all required reads through one product RunShell call', async () => {
  fakeReadOnlyCli();
  const result = await dispatchRunShell({ check: '30-minute', checkSeat: 'OP', checkVersion: '0.3.33', checkPreviousGreen: 3 }, { scriptApproval: async () => ({ allowed: true, priorHumanApproval: false }) });
  expect([result.outcome, result.exitCode]).toEqual(['exit', 0]);
  const summary = JSON.parse(result.stdout) as { inbox: unknown; steps: Array<{ id: string; selected?: Record<string, string | number | boolean> }> };
  expect(summary.inbox).toEqual({ status: 'unknown', count: null, complete: false });
  expect(summary.steps.map((step) => step.id)).toEqual(['inbox', 'op_check', 'cost']);
  expect(summary.steps[1]?.selected).toEqual({ originMainFreshness: 'origin/main 기준 시각 2026-11-22T09:00:00.000Z(오래됐을 수 있음)', lastFetchAt: '2026-11-22T09:00:00.000Z', fetchStale: true, legacyQueueRows: 2, version: '0.3.33', landings30m: 12, landingsWithoutPr30m: 1, landingTarget: 10,
    green: 9, greenDelta: 6, greenDeltaTarget: 5, reviewUnclaimed: 1, malformedQueueRows: 0,
    unknownQueueRows: 2, unclaimedUnknownQueueRows: 1, trainTickObserved: true, landingSubObserved: true, complete: false });
  const calls = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n');
  expect(calls).toEqual(['msg count --to OP --json', 'ops check-30m --previous-green 3 --expect-version 0.3.33 --json', 'usage runs --since 30m --by role --json']);
  expect(result.stdout).not.toContain('PRIVATE-MAIL-CANARY');
});

test('inbox count distinguishes known zero and positive from unknown and continues all checks', async () => {
  fakeReadOnlyCli();
  for (const [response, expected] of [
    [{ status: 'ok', count: 0 }, { status: 'ok', count: 0, complete: true }],
    [{ status: 'ok', count: 3 }, { status: 'ok', count: 3, complete: true }],
    [{ status: 'unknown', count: null }, { status: 'unknown', count: null, complete: false }],
    [{ status: 'ok', count: null }, { status: 'unknown', count: null, complete: false }],
  ] as const) {
    writeFileSync(join(root, 'count.json'), JSON.stringify(response));
    writeFileSync(join(root, 'calls'), '');
    const result = await dispatchRunShell({ check: '30-minute', checkSeat: 'OP', checkVersion: '0.3.33', checkPreviousGreen: 3 }, { scriptApproval: async () => ({ allowed: true, priorHumanApproval: false }) });
    expect([result.outcome, result.exitCode]).toEqual(['exit', 0]);
    const summary = JSON.parse(result.stdout);
    expect(summary.inbox).toEqual(expected);
    expect(summary.steps.map((step: { id: string }) => step.id)).toEqual(['inbox', 'op_check', 'cost']);
    expect(readFileSync(join(root, 'calls'), 'utf8').trim().split('\n')).toEqual([
      'msg count --to OP --json', 'ops check-30m --previous-green 3 --expect-version 0.3.33 --json', 'usage runs --since 30m --by role --json',
    ]);
  }
});

test('real count declaration reaches downstream inbox while later checks continue', async () => {
  fakeReadOnlyCli();
  // This process boundary exercises the real CLI and SQLite; only unrelated checks use fixtures.
  writeFileSync(join(root, 'real-count.ts'), `import { Command } from '${join(process.cwd(), 'node_modules/commander/index.js')}'; import { registerMsgCommands } from '${join(process.cwd(), 'src/cli/msg-cli.ts')}'; const cli = new Command(); registerMsgCommands(cli); await cli.parseAsync(process.argv.slice(2), { from: 'user' });`);
  const store = new MsgStore(join(root, 'msg', 'messages.db'));
  store.close();
  mkdirSync(join(root, 'seat-state'), { recursive: true });
  const registry = join(root, 'seat-state', 'seat-registry.json');
  for (const declared of [false, true]) {
    writeFileSync(registry, JSON.stringify({ version: 1, seats: declared ? [{ address: 'OP', host: 'local', wake: 'none', replyBody: 'agent', optIn: false }] : [] }));
    const result = await dispatchRunShell({ check: '30-minute', checkSeat: 'OP', checkVersion: '0.3.33', checkPreviousGreen: 3 }, { scriptApproval: async () => ({ allowed: true, priorHumanApproval: false }) });
    expect(result.exitCode).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.inbox).toEqual(declared ? { status: 'ok', count: 0, complete: true } : { status: 'unknown', count: null, complete: false });
    expect(summary.steps.map((step: { id: string }) => step.id)).toEqual(['inbox', 'op_check', 'cost']);
  }
});

test('count process failure or malformed JSON keeps inbox unknown and completes other checks', async () => {
  fakeReadOnlyCli();
  for (const failure of ['exit', 'malformed', 'missing-field']) {
    writeFileSync(join(root, 'calls'), '');
    if (failure === 'exit') writeFileSync(join(root, 'count-fail'), '');
    else {
      rmSync(join(root, 'count-fail'), { force: true });
      writeFileSync(join(root, 'count.json'), failure === 'malformed' ? '{bad' : '{"status":"ok"}');
    }
    const result = await dispatchRunShell({ check: '30-minute', checkSeat: 'OP', checkVersion: '0.3.33', checkPreviousGreen: 3 }, { scriptApproval: async () => ({ allowed: true, priorHumanApproval: false }) });
    const summary = JSON.parse(result.stdout);
    console.log('COUNT_FAILURE_EVENT', failure, JSON.stringify(result));
    expect([result.outcome, result.exitCode]).toEqual(['exit', 0]);
    expect(summary.inbox).toEqual({ status: 'unknown', count: null, complete: false });
    expect(summary.steps.map((step: { id: string }) => step.id)).toEqual(['inbox', 'op_check', 'cost']);
    expect(readFileSync(join(root, 'calls'), 'utf8').trim().split('\n')).toEqual([
      'msg count --to OP --json', 'ops check-30m --previous-green 3 --expect-version 0.3.33 --json', 'usage runs --since 30m --by role --json',
    ]);
  }
});

test('failed git check projects only the bounded safe error to the caller', async () => {
  fakeReadOnlyCli();
  writeFileSync(join(root, 'git-fail'), '');
  const result = await dispatchRunShell({ check: '30-minute', checkSeat: 'OP', checkVersion: '0.3.33', checkPreviousGreen: 3 }, { scriptApproval: async () => ({ allowed: true, priorHumanApproval: false }) });
  const summary = JSON.parse(result.stdout);
  expect(result.exitCode).toBe(1);
  expect(summary.steps[1].selected).toEqual({ complete: false, 'error.code': 'GIT_FAILED', 'error.message': 'git failed at [path]' });
  expect(result.stdout).not.toContain('DO-NOT-PROJECT');
  console.log('GIT_FAILURE_EVENT', JSON.stringify(result));
});

test('inbox tolerance never swallows gate errors, spawn errors, denial, cancellation or timeout', async () => {
  const steps = [{ id: 'inbox', command: ['eln', 'msg', 'count', '--to', 'OP'], select: ['status', 'count'] },
    { id: 'later', command: ['hostname'] }];
  for (const outcome of ['denied', 'aborted', 'timeout', 'spawn-error', 'throw'] as const) {
    let calls = 0;
    const result = await runShellScript(steps, undefined, 1000, async () => {
      calls++;
      if (outcome === 'throw') throw new Error('approval or security gate failed');
      return { output: '', exitCode: null, outcome, elapsedMs: 0, stdout: '', stderr: '',
        truncated: false, approvalKey: '', sandboxed: false, sandboxTool: 'none' };
    }, true);
    expect(result.outcome).toBe(outcome === 'throw' ? 'spawn-error' : outcome);
    expect(result.exitCode).toBeNull();
    expect(calls).toBe(1);
  }
});

test('message list and show require prior human approval; unrelated read policies stay intact', async () => {
  // Other test files may already have loaded the immutable gateway trust key.
  // Exercise the real signed path in a fresh process, not a mutable test override.
  if (process.env.RUNSHELL_DEFAULT_CHECKS_CHILD !== '1') {
    const child = spawnSync(process.execPath, ['test', import.meta.path, '--test-name-pattern', 'message list and show require prior human approval'], {
      env: { ...process.env, RUNSHELL_DEFAULT_CHECKS_CHILD: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(child.stderr).toContain('1 pass');
    expect(child.status).toBe(0);
    return;
  }
  fakeReadOnlyCli();
  for (const bin of ['eln', 'elanous']) {
    expect(scriptCommandPolicy([bin, 'msg', 'unread', '--to', 'OP', '--json'])).toBe('approval');
    expect(scriptCommandPolicy([bin, 'msg', 'count', '--to', 'OP'])).toBe('approval');
    expect(scriptCommandPolicy([bin, 'msg', 'count', '--to', 'OP', '--json'])).toBe(bin === 'eln' ? 'read-local' : 'approval');
    expect(scriptCommandPolicy([bin, 'msg', 'list', '--to', 'OP', '--json'])).toBe('approval');
    expect(scriptCommandPolicy([bin, 'msg', 'show', '17', '--json'])).toBe('approval');
    expect(scriptCommandPolicy([bin, 'ops', 'status', '--json'])).toBe('approval');
    expect(scriptCommandPolicy([bin, 'msg', 'post', '--to', 'OP'])).toBe('approval');
  }
  const unread = [{ id: 'mail', command: ['eln', 'msg', 'unread', '--to', 'OP', '--json'] }];
  const unreadDenied = await dispatchRunShell({ script: unread }, { scriptApproval: async () => ({ allowed: true, priorHumanApproval: false }) });
  expect(unreadDenied.outcome).toBe('denied');
  expect(() => readFileSync(join(root, 'calls'), 'utf8')).toThrow();
  // A policy approval is not a spawn grant. Exercise both failure without IPC
  // and the existing signed, single-use IPC grant path for private mail.
  const noGrant = await dispatchRunShell({ script: unread }, { scriptApproval: async () => ({ allowed: true, priorHumanApproval: true }), sessionId: 'test-session' });
  expect(noGrant.outcome).toBe('denied');
  expect(() => readFileSync(join(root, 'calls'), 'utf8')).toThrow();
  const prevHome = process.env.HOME, prevSeat = process.env.ELANOUS_TRACK, prevKey = process.env[RUNSHELL_PUBLIC_KEY_ENV];
  const prevSend = process.send;
  const connectedDescriptor = Object.getOwnPropertyDescriptor(process, 'connected');
  Object.defineProperty(process, 'connected', { configurable: true, value: true });
  process.env.HOME = root;
  process.env.ELANOUS_TRACK = 'test-seat';
  process.env[RUNSHELL_PUBLIC_KEY_ENV] = issuer.publicKey;
  let grants = 0;
  let useOtherKey = true;
  const otherIssuer = createRunShellApprovalIssuer();
  (process as any).send = (message: RunShellApprovalCall) => {
    grants++;
    const signed = (useOtherKey ? otherIssuer : issuer).issue(message.request);
    queueMicrotask(() => process.emit('message', { type: RUNSHELL_APPROVAL_RESULT, callId: message.callId, approval: signed }));
    return true;
  };
  try {
    const opts = { scriptApproval: async () => ({ allowed: true, priorHumanApproval: true }), sessionId: 'test-session' };
    const forged = await dispatchRunShell({ script: unread }, opts);
    expect(forged.outcome).not.toBe('exit');
    expect(() => readFileSync(join(root, 'calls'), 'utf8')).toThrow();
    useOtherKey = false;
    const unreadAllowed = await dispatchRunShell({ script: unread }, opts);
    expect([unreadAllowed.outcome, unreadAllowed.exitCode]).toEqual(['exit', 0]);
    expect(readFileSync(join(root, 'calls'), 'utf8').trim()).toBe('msg unread --to OP --json');
    writeFileSync(join(root, 'calls'), '');
    const script = [{ id: 'mail', command: ['eln', 'msg', 'list', '--to', 'OP', '--json'] }];
    const allowed = await dispatchRunShell({ script }, opts);
    expect([allowed.outcome, allowed.exitCode]).toEqual(['exit', 0]);
    expect(allowed.stdout).toContain('PRIVATE-MAIL-CANARY');
    expect(readFileSync(join(root, 'calls'), 'utf8').trim()).toBe('msg list --to OP --json');
    expect(grants).toBe(3);
  } finally {
    (process as any).send = prevSend;
    if (connectedDescriptor) Object.defineProperty(process, 'connected', connectedDescriptor);
    else delete (process as any).connected;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevSeat === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = prevSeat;
    if (prevKey === undefined) delete process.env[RUNSHELL_PUBLIC_KEY_ENV]; else process.env[RUNSHELL_PUBLIC_KEY_ENV] = prevKey;
  }
});


test('select is bounded to 18 fields; 19 is rejected before dispatch', async () => {
  let calls = 0;
  const dispatch = async () => { calls++; throw new Error('must not dispatch'); };
  const fields = Array.from({ length: 19 }, (_, index) => `field${index}`);
  await expect(runShellScript([{ id: 'bounded', command: ['hostname'], select: fields }], undefined, 1000, dispatch)).rejects.toThrow('select is invalid');
  expect(calls).toBe(0);
});
