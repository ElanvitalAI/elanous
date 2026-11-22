import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchRunShell } from './shell.js';

const oldPath = process.env.PATH;
let root = '';
afterEach(() => {
  if (oldPath === undefined) delete process.env.PATH;
  else process.env.PATH = oldPath;
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function fakeCli(): string {
  root = mkdtempSync(join(tmpdir(), 'run-shell-script-'));
  const executable = join(root, 'eln');
  writeFileSync(executable, `#!/bin/sh
printf 'call\\n' >> '${root}/calls'
if [ "$1:$2" = 'memory:index' ]; then
  printf '{"host":"user","state":"ready","cwd":"%s"}' "$PWD"
elif [ "$1:$2" = 'memory:where' ]; then
  printf '{"checked":"%s"}' "$3"
elif [ "$1:$2" = 'memory:list' ]; then
  if [ "$3" = 'project' ]; then sleep 10; fi
  if [ "$3" = 'reference' ]; then sleep 1.1; fi
  if [ "$3" = 'feedback' ]; then printf '{"checked":"/tmp/unsafe"}'; elif [ "$3" = 'user' ]; then printf '{"checked":"user"}'; else printf '{"checked":"%s"}' "$3"; fi
elif [ "$1:$2" = 'memory:search' ]; then
  printf '{"checked":"%s"}' "$3"
else
  touch '${root}/unexpected-execution'
  exit 3
fi
`);
  chmodSync(executable, 0o700);
  symlinkSync(executable, join(root, 'elanous'));
  process.env.PATH = `${root}:${oldPath ?? ''}`;
  return root;
}

const allow = async () => ({ allowed: true, priorHumanApproval: false });

test('product RunShell dispatch chains two read-only CLI calls and returns selected scalars', async () => {
  const dir = fakeCli();
  const result = await dispatchRunShell({ script: [
    { id: 'first', command: ['eln', 'memory', 'index'], select: ['host'] },
    { id: 'second', command: ['eln', 'memory', 'list', '$ref:first.host'], select: ['checked'] },
  ] }, { scriptApproval: allow });
  expect(result.outcome).toBe('exit');
  expect(result.exitCode).toBe(0);
  const summary = JSON.parse(result.stdout) as { steps: Array<{ selected?: Record<string, string> }> };
  expect(summary.steps.map((step) => step.selected)).toEqual([{ host: 'user' }, { checked: 'user' }]);
  expect(result.stdout).not.toContain('unexpected-execution');
  expect(existsSync(join(dir, 'unexpected-execution'))).toBe(false);
});

test('read-local policy denial prevents even an allowlisted host command from spawning', async () => {
  let spawned = false;
  const result = await dispatchRunShell({ script: [{ id: 'host', command: ['hostname'] }] }, {
    scriptApproval: async () => ({ allowed: false, priorHumanApproval: false }),
    onSpawn: () => { spawned = true; },
  });
  expect(result.outcome).toBe('denied');
  expect(spawned).toBe(false);
});

test('missing approval callback denies before the first CLI call', async () => {
  const dir = fakeCli();
  const result = await dispatchRunShell({ script: [{ id: 'first', command: ['eln', 'memory', 'index'] }] });
  expect(result.outcome).toBe('denied');
  expect(existsSync(join(dir, 'calls'))).toBe(false);
});

test('read-only action with an output path is refused before any CLI call', async () => {
  const dir = fakeCli();
  const result = await dispatchRunShell({ script: [{ id: 'unsafe', command: ['eln', 'memory', 'index', '--output', '/tmp/unsafe'] }] },
    { scriptApproval: allow });
  expect(result.outcome).toBe('denied');
  expect(existsSync(join(dir, 'calls'))).toBe(false);
});

test('reference substitution is checked against the full argv grammar before the next CLI call', async () => {
  const dir = fakeCli();
  const result = await dispatchRunShell({ script: [
    { id: 'first', command: ['eln', 'memory', 'list', 'feedback'], select: ['checked'] },
    { id: 'second', command: ['eln', 'memory', 'list', '$ref:first.checked'] },
  ] }, { scriptApproval: allow });
  expect(result.outcome).toBe('denied');
  expect(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')).toHaveLength(1);
});

test('mail body is denied without signed approval, including resolved argv', async () => {
  const dir = fakeCli();
  const gates: string[][] = [];
  const result = await dispatchRunShell({ script: [
    { id: 'first', command: ['eln', 'memory', 'list', 'user'], select: ['checked'] },
    { id: 'mail', command: ['eln', 'msg', 'list', '--to', '$ref:first.checked'] },
  ] }, { scriptApproval: async (command) => {
    gates.push(command);
    return { allowed: true, priorHumanApproval: false };
  } });
  expect(result.outcome).toBe('denied');
  expect(gates).toEqual([['eln', 'memory', 'list', 'user'], ['eln', 'msg', 'list', '--to', 'user']]);
  expect(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')).toHaveLength(1);
  expect(existsSync(join(dir, 'unexpected-execution'))).toBe(false);
});

test('mail list and show do not spawn when the approval callback is only automatic', async () => {
  const dir = fakeCli();
  let spawned = false;
  for (const command of [
    ['eln', 'msg', 'list'], ['eln', 'msg', 'list', '--to', 'OTHER'],
    ['eln', 'msg', 'show', '123'], ['elanous', 'msg', 'list', '--to', 'OTHER'],
    ['elanous', 'msg', 'show', '123'],
  ]) {
    const result = await dispatchRunShell({ script: [{ id: 'mail', command }] }, { scriptApproval: allow, onSpawn: () => { spawned = true; } });
    expect(result.outcome).toBe('denied');
  }
  expect(spawned).toBe(false);
  expect(existsSync(join(dir, 'calls'))).toBe(false);
});

test('memory search usage write cannot run with only automatic approval', async () => {
  const dir = fakeCli();
  const result = await dispatchRunShell({ script: [
    { id: 'query', command: ['eln', 'memory', 'search', 'notes &b=2'], select: ['checked'] },
  ] }, { scriptApproval: allow });
  expect(result.outcome).toBe('denied');
  expect(existsSync(join(dir, 'calls'))).toBe(false);
});

test('unregistered CLI action is denied after the preceding local read', async () => {
  const dir = fakeCli();
  const result = await dispatchRunShell({ script: [
    { id: 'first', command: ['eln', 'memory', 'index'] },
    { id: 'unsafe', command: ['eln', 'release', 'publish'] },
  ] }, { scriptApproval: allow });
  expect(result.outcome).toBe('denied');
  expect(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')).toHaveLength(1);
  expect(existsSync(join(dir, 'unexpected-execution'))).toBe(false);
});

test('unlisted CLI action requires a prior human approval even when callback allows it', async () => {
  const dir = fakeCli();
  const result = await dispatchRunShell({ script: [{ id: 'unsafe', command: ['eln', 'release', 'publish'] }] },
    { scriptApproval: allow });
  expect(result.outcome).toBe('denied');
  expect(existsSync(join(dir, 'calls'))).toBe(false);
});

test('prior policy approval preserves local legacy behavior but cannot authorize an outside step', async () => {
  const dir = fakeCli();
  const approved = async () => ({ allowed: true, priorHumanApproval: true });
  const local = await dispatchRunShell({ approval: 'always', script: [
    { id: 'first', command: ['eln', 'memory', 'index'] },
  ] }, { scriptApproval: approved });
  expect(local.outcome).toBe('exit');
  expect(local.exitCode).toBe(0);
  const outside = await dispatchRunShell({ approval: 'none', script: [
    { id: 'outside', command: ['eln', 'release', 'publish'] },
  ] }, { scriptApproval: approved });
  expect(outside.outcome).toBe('denied');
  expect(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')).toHaveLength(1);
  expect(existsSync(join(dir, 'unexpected-execution'))).toBe(false);
});

test('each script command still reaches the ordinary approval gate', async () => {
  const dir = fakeCli();
  const result = await dispatchRunShell({ approval: 'always', script: [
    { id: 'first', command: ['eln', 'memory', 'index'] },
    { id: 'second', command: ['eln', 'memory', 'where'] },
  ] }, { scriptApproval: allow });
  expect(result.outcome).toBe('denied');
  expect(JSON.parse(result.stdout).steps).toHaveLength(1);
  expect(existsSync(join(dir, 'unexpected-execution'))).toBe(false);
});

test('every script step uses the caller cwd', async () => {
  const dir = fakeCli();
  const result = await dispatchRunShell({ cwd: dir, script: [
    { id: 'first', command: ['eln', 'memory', 'index'], select: ['cwd'] },
  ] }, { scriptApproval: allow });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).steps[0].selected.cwd).toBe(realpathSync(dir));
  expect(result.approvalKey).toMatch(/^script:/);
});

test('an unresponsive CLI step times out and prevents the next step', async () => {
  fakeCli();
  const result = await dispatchRunShell({ timeoutMs: 1000, script: [
    { id: 'hung', command: ['eln', 'memory', 'list', 'project'] },
    { id: 'later', command: ['eln', 'memory', 'index'] },
  ] }, { scriptApproval: allow });
  expect(result.outcome).toBe('timeout');
  expect(JSON.parse(result.stdout).steps.map((step: { id: string }) => step.id)).toEqual(['hung']);
});

test('one deadline covers all script steps', async () => {
  fakeCli();
  const result = await dispatchRunShell({ timeoutMs: 2000, script: [
    { id: 'first', command: ['eln', 'memory', 'list', 'reference'] },
    { id: 'second', command: ['eln', 'memory', 'list', 'reference'] },
    { id: 'later', command: ['eln', 'memory', 'index'] },
  ] }, { scriptApproval: allow });
  expect(result.outcome).toBe('timeout');
  const executed = JSON.parse(result.stdout).steps.map((step: { id: string }) => step.id);
  expect(executed).toEqual(['first', 'second']);
});
