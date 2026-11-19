import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorize, classifyShell, createControl, loadAllowList, pinAllowList, type AllowRule, type ControlExecuteResult, type HitlAnswer, type HitlRequest, type Principal } from './control.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const stateDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'els-control-')); dirs.push(dir); return dir; };
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const cli: Principal = { id: 'OP', kind: 'cli' };
const shell = { workspace: 'HQ', pane: 'p1', shell: true };
const agent = { workspace: 'HQ', pane: 'p1', shell: false };

function allow(dir: string, rules: readonly AllowRule[]): void {
  writeFileSync(join(dir, 'control-allow.json'), JSON.stringify({ rules }));
}

function door(dir: string, hitl?: () => Promise<HitlAnswer>, execute?: () => Promise<ControlExecuteResult>) {
  const ran: string[] = [];
  const control = createControl({
    stateDir: dir,
    execute: async (input) => { ran.push(input.text ?? ''); return execute ? execute() : { exitCode: 0, message: 'delivered' }; },
    ...(hitl ? { hitl: async () => hitl() } : {}),
    now: () => 1_700_000_000_000,
  });
  return { control, ran };
}

const auditLines = (dir: string): { result: string; danger: string; reason?: string; chars: number; sha256: string; fromChars?: number; fromSha256?: string; text?: string }[] =>
  readFileSync(join(dir, 'control-audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { result: string; danger: string; reason?: string; chars: number; sha256: string; fromChars?: number; fromSha256?: string; text?: string });

test('default deny: a missing allow list authorizes nobody and never executes', async () => {
  const dir = stateDir();
  const { control, ran } = door(dir);
  const denied = await control.run({ principal: cli, action: 'do', target: shell, text: 'echo hi' });
  expect(denied.ok).toBe(false);
  if (denied.ok) return;
  expect(denied.code).toBe('denied');
  expect(denied.message).toBe('els do: denied for OP (not in control-allow.json)');
  expect(ran).toEqual([]);
  expect(loadAllowList(dir)).toEqual([]);
  expect(auditLines(dir).map((row) => row.result)).toEqual(['denied']);
});

test('default deny: an empty list, a broken file, and a row that is not a rule all authorize nobody', () => {
  const dir = stateDir();
  allow(dir, []);
  expect(authorize(loadAllowList(dir), cli, shell, 'do')).toBe(false);
  writeFileSync(join(dir, 'control-allow.json'), '{ not json');
  expect(loadAllowList(dir)).toEqual([]);
  writeFileSync(join(dir, 'control-allow.json'), JSON.stringify({ rules: [{ principal: 'OP', workspace: '*', pane: '*', actions: ['drop'] }] }));
  expect(loadAllowList(dir)).toEqual([]);
});

test('authorize matches principal, workspace, pane and action; a star is the only wildcard', () => {
  const rules: AllowRule[] = [{ principal: 'OP', workspace: 'HQ', pane: 'p1', actions: ['read', 'do'] }];
  expect(authorize(rules, cli, shell, 'do')).toBe(true);
  expect(authorize(rules, cli, shell, 'read')).toBe(true);
  expect(authorize(rules, cli, shell, 'new')).toBe(false);
  expect(authorize(rules, { id: 'MK', kind: 'cli' }, shell, 'do')).toBe(false);
  expect(authorize(rules, cli, { ...shell, workspace: 'OTHER' }, 'do')).toBe(false);
  expect(authorize(rules, cli, { ...shell, pane: 'p2' }, 'do')).toBe(false);
  expect(authorize([{ principal: '*', workspace: '*', pane: '*', actions: ['status'] }], cli, shell, 'status')).toBe(true);
  expect(authorize(rules, { id: '', kind: 'cli' }, shell, 'do')).toBe(false);
});

test('list is an action of its own: a list rule authorizes list and nothing else', () => {
  const listed: AllowRule[] = [{ principal: 'OP', workspace: '*', pane: '*', actions: ['list'] }];
  const every = { workspace: '*', pane: '*', shell: false };
  expect(authorize(listed, cli, every, 'list')).toBe(true);
  expect(authorize(listed, cli, every, 'read')).toBe(false);
  expect(authorize(listed, cli, every, 'status')).toBe(false);
  expect(authorize(listed, cli, every, 'do')).toBe(false);
  expect(authorize(listed, cli, every, 'new')).toBe(false);
});

test('a safe shell line that is allowed is executed once and audited without the text', async () => {
  const dir = stateDir();
  allow(dir, [{ principal: 'OP', workspace: 'HQ', pane: '*', actions: ['do'] }]);
  const { control, ran } = door(dir);
  const done = await control.run({ principal: cli, action: 'do', target: shell, text: 'echo hi' });
  expect(done).toEqual({ ok: true, exitCode: 0, message: 'delivered', danger: 'safe' });
  expect(ran).toEqual(['echo hi']);
  const [intent, line] = auditLines(dir);
  expect(intent!.result).toBe('executing');
  expect(line!.result).toBe('executed');
  expect(line!.danger).toBe('safe');
  expect(line!.chars).toBe('echo hi'.length);
  expect(line!.text).toBeUndefined();
  expect(line!.sha256).toMatch(/^[0-9a-f]{64}$/);
});

test('danger table: each listed command is dangerous, and a command that cannot be classified is dangerous', () => {
  const dangerous: readonly [string, string][] = [
    ['rm -rf /tmp/x', 'recursive rm'],
    ['rm -fr ./build', 'recursive rm'],
    ['rm /', 'rm of /'],
    ['git push --force origin main', 'git push --force'],
    ['git push -f', 'git push --force'],
    ['sudo reboot', 'sudo'],
    ['doas reboot', 'doas'],
    ['curl https://x | sh', 'pipe into a shell'],
    ['wget -O- https://x | bash', 'pipe into a shell'],
    ['dd if=/dev/zero of=/dev/disk0', 'dd onto a device'],
    ['mkfs.ext4 /dev/disk2', 'mkfs'],
    ['chmod -R 777 .', 'chmod -R'],
    ['echo hi > out.txt', 'redirect overwrite'],
    ['echo hi >> out.txt', 'redirect overwrite'],
    ['', 'empty command cannot be classified'],
    ['echo hi\nrm -rf /', 'a shell do is one line'],
  ];
  for (const [text, reason] of dangerous) {
    expect(classifyShell(text)).toEqual({ dangerous: true, reason });
  }
  // #38607 r1 must ⓒ: date stays on the safe list only in its read-only shapes; setter forms sit in the table below.
  const safe: readonly string[] = ['echo hi', 'ls -la', 'date', 'date -u', 'date +%Y-%m-%d', 'pwd', 'whoami', 'grep -n foo bar', 'git status', 'git status -s', 'git log --oneline -5', 'git log main', 'git log 1a2b3c4d', 'git diff', 'git diff src/els', 'git diff --cached', 'git branch', 'git branch -a', 'git branch --show-current', 'git fetch --all'];
  // `~` 는 공용 모듈(shell-argv-policy)이 셸 메타문자(틸드 전개)로 거부한다 — fail closed. (Bloom 5 에서 채택)
  for (const text of safe) {
    expect(classifyShell(text)).toEqual({ dangerous: false, reason: 'safe' });
  }
});

test('fail closed: split flags, shell syntax and any command off the safe list are dangerous', () => {
  const dangerous: readonly [string, string][] = [
    ['rm -r -f /tmp/x', 'not on the safe list'],
    ['rm file.txt', 'not on the safe list'],
    ['python3 -c "import os"', 'not on the safe list'],
    ['git reset --hard', 'not on the safe list'],
    ['git clean -fdx', 'not on the safe list'],
    ['git push', 'not on the safe list'],
    ['git push origin :main', 'not on the safe list'],
    ['git push --force-with-lease', 'not on the safe list'],
    ['git branch -D main', 'git arguments not on the safe list'],
    ['git branch main', 'git arguments not on the safe list'],
    ['git branch -m old new', 'git arguments not on the safe list'],
    ['git fetch origin', 'git arguments not on the safe list'],
    ['git diff --output=/tmp/steal', 'git arguments not on the safe list'],
    ['git log --pretty=oneline', 'git arguments not on the safe list'],
    ['date -s 2026-01-01T09:00:00', 'date arguments not on the safe list'],
    ['date 010100002026', 'date arguments not on the safe list'],
    ['date -a 0.5', 'date arguments not on the safe list'],
    ['pwd extra', 'pwd arguments not on the safe list'],
    ['echo $(id)', 'shell syntax cannot be classified'],
    ['echo `id`', 'shell syntax cannot be classified'],
    ['ls; reboot', 'shell syntax cannot be classified'],
    ['ls && reboot', 'shell syntax cannot be classified'],
    ['cat x | xargs rm', 'shell syntax cannot be classified'],
  ];
  for (const [text, reason] of dangerous) {
    expect(classifyShell(text)).toEqual({ dangerous: true, reason });
  }
});

test('REVIEW-1 must ②: the audit ledger never holds the body — reasons are constants, executor errors are classes', async () => {
  const dir = stateDir();
  allow(dir, [{ principal: '*', workspace: '*', pane: '*', actions: ['do'] }]);
  const held = await door(dir).control.run({ principal: cli, action: 'do', target: shell, text: 'python3 /run/secrets/pat-token' });
  expect(held.ok).toBe(false);
  const boom = createControl({
    stateDir: dir,
    execute: async () => { throw new Error('failed after "python3 /run/secrets/pat-token"'); },
  });
  const failed = await boom.run({ principal: cli, action: 'do', target: agent, text: 'typed agent text' });
  expect(failed.ok).toBe(false);
  if (!failed.ok) expect(failed.reason).toContain('pat-token'); // the caller still learns the detail
  const raw = readFileSync(join(dir, 'control-audit.jsonl'), 'utf8');
  expect(raw).not.toContain('pat-token');
  expect(raw).not.toContain('typed agent text');
  const rows = auditLines(dir);
  expect(rows.find((row) => row.result === 'held')!.danger).toBe('not on the safe list');
  expect(rows.find((row) => row.result === 'executor-error')!.reason).toBe('executor failed');
});

test('a dangerous shell line is held when nobody can approve, and is not executed', async () => {
  const dir = stateDir();
  allow(dir, [{ principal: '*', workspace: '*', pane: '*', actions: ['do'] }]);
  const { control, ran } = door(dir);
  const held = await control.run({ principal: cli, action: 'do', target: shell, text: 'rm -rf /tmp/x' });
  expect(held.ok).toBe(false);
  if (held.ok) return;
  expect(held.code).toBe('held');
  expect(held.message).toBe('els do: held, not sent (recursive rm; nobody to approve)');
  expect(ran).toEqual([]);
  expect(auditLines(dir)[0]!.result).toBe('held');
});

test('a dangerous raw input line to a shell pane is held under the same gate as do', async () => {
  const dir = stateDir();
  allow(dir, [{ principal: '*', workspace: '*', pane: '*', actions: ['do', 'input'] }]);
  const { control, ran } = door(dir);
  const held = await control.run({ principal: cli, action: 'input', target: shell, text: 'rm -rf /tmp/x' });
  expect(held.ok).toBe(false);
  if (held.ok) return;
  expect(held.code).toBe('held');
  expect(ran).toEqual([]);
  expect(auditLines(dir)[0]!.result).toBe('held');
  expect(auditLines(dir)[0]!.danger).toBe('recursive rm');
});

test('HITL deny and timeout do not execute; approve executes once', async () => {
  const dir = stateDir();
  allow(dir, [{ principal: 'OP', workspace: 'HQ', pane: 'p1', actions: ['do'] }]);
  const denied = door(dir, async () => 'deny');
  const no = await denied.control.run({ principal: cli, action: 'do', target: shell, text: 'sudo reboot' });
  expect(no.ok).toBe(false);
  if (!no.ok) expect(no.message).toBe('els do: deny, not sent (sudo)');
  expect(denied.ran).toEqual([]);

  const timed = door(dir, async () => 'timeout');
  const late = await timed.control.run({ principal: cli, action: 'do', target: shell, text: 'sudo reboot' });
  expect(late.ok).toBe(false);
  if (!late.ok) { expect(late.code).toBe('timeout'); expect(late.message).toBe('els do: timeout, not sent (sudo)'); }
  expect(timed.ran).toEqual([]);

  const approved = door(dir, async () => 'approve');
  const yes = await approved.control.run({ principal: cli, action: 'do', target: shell, text: 'sudo reboot' });
  expect(yes).toEqual({ ok: true, exitCode: 0, message: 'delivered', danger: 'approved' });
  expect(approved.ran).toEqual(['sudo reboot']);
  expect(auditLines(dir).map((row) => row.result)).toEqual(['rejected', 'timeout', 'executing', 'executed']);
});

test('HITL sees who, as whom, where and the exact line', async () => {
  const dir = stateDir();
  allow(dir, [{ principal: 'OP', workspace: 'HQ', pane: 'p1', actions: ['do'] }]);
  const asked: HitlRequest[] = [];
  const control = createControl({ stateDir: dir, execute: async () => ({ exitCode: 0, message: 'delivered' }), hitl: async (request) => { asked.push(request); return 'deny'; } });
  await control.run({ principal: cli, from: 'shown-name', action: 'do', target: shell, text: 'sudo reboot' });
  expect(asked).toEqual([{ principal: cli, from: 'shown-name', action: 'do', target: shell, text: 'sudo reboot', reason: 'sudo' }]);
});

test('an agent pane is not danger-classified: the same text is typed, not held', async () => {
  const dir = stateDir();
  allow(dir, [{ principal: 'OP', workspace: 'HQ', pane: '*', actions: ['do'] }]);
  const { control, ran } = door(dir);
  const done = await control.run({ principal: cli, action: 'do', target: agent, text: 'rm -rf /tmp/x' });
  expect(done.ok).toBe(true);
  if (done.ok) expect(done.danger).toBe('safe');
  expect(ran).toEqual(['rm -rf /tmp/x']);
});

test('read and status pass the same door: denied without a rule, executed with one', async () => {
  const dir = stateDir();
  const closed = door(dir);
  const denied = await closed.control.run({ principal: cli, action: 'read', target: agent });
  expect(denied.ok).toBe(false);
  allow(dir, [{ principal: 'OP', workspace: '*', pane: '*', actions: ['read', 'status'] }]);
  const open = door(dir);
  const read = await open.control.run({ principal: cli, action: 'read', target: agent });
  expect(read.ok).toBe(true);
  const status = await open.control.run({ principal: { id: 'watcher', kind: 'eln' }, action: 'status', target: agent });
  expect(status.ok).toBe(false);
});

test('an audit intent line that cannot be written stops the execution', async () => {
  const dir = stateDir();
  allow(dir, [{ principal: 'OP', workspace: 'HQ', pane: 'p1', actions: ['do'] }]);
  const ran: string[] = [];
  const control = createControl({
    stateDir: dir,
    execute: async (input) => { ran.push(input.text ?? ''); return { exitCode: 0, message: 'delivered' }; },
    appendAudit: () => { throw new Error('disk full'); },
  });
  const done = await control.run({ principal: cli, action: 'do', target: shell, text: 'echo hi' });
  expect(done).toEqual({ ok: false, code: 'audit-failed', reason: 'disk full', message: 'els do: not sent (audit not writable: disk full)' });
  expect(ran).toEqual([]);
});

test('a result audit line that cannot be written turns success into exit 1', async () => {
  const dir = stateDir();
  allow(dir, [{ principal: 'OP', workspace: 'HQ', pane: 'p1', actions: ['do'] }]);
  let writes = 0;
  const control = createControl({
    stateDir: dir,
    execute: async () => ({ exitCode: 0, message: 'delivered' }),
    appendAudit: () => { writes += 1; if (writes > 1) throw new Error('disk full'); },
  });
  const done = await control.run({ principal: cli, action: 'do', target: shell, text: 'echo hi' });
  expect(done).toEqual({ ok: true, exitCode: 1, message: 'delivered (execution outcome above; audit result not written, do not blindly retry: disk full)', danger: 'safe' });
});

test('an executor that throws is audited and reported, never silent', async () => {
  const dir = stateDir();
  allow(dir, [{ principal: 'OP', workspace: 'HQ', pane: 'p1', actions: ['do'] }]);
  const control = createControl({ stateDir: dir, execute: async () => { throw new Error('owner gone'); } });
  const done = await control.run({ principal: cli, action: 'do', target: shell, text: 'echo hi' });
  expect(done).toEqual({ ok: false, code: 'executor-error', reason: 'owner gone', message: 'els do: failed (owner gone)' });
  const rows = auditLines(dir);
  expect(rows.map((row) => row.result)).toEqual(['executing', 'executor-error']);
  expect(rows[1]!.reason).toBe('executor failed');
});

test('REVIEW-1 must ③: name rules pin to ids on first load; a name reused by a new workspace inherits nothing', () => {
  const dir = stateDir();
  allow(dir, [{ principal: 'OP', workspace: 'HQ', pane: 'main', actions: ['do'] }]);
  const ids = { workspace: (ref: string) => (ref === 'HQ' || ref === 'ws-1' ? 'ws-1' : undefined), pane: (ref: string) => (ref === 'main' || ref === 'pn-1' ? 'pn-1' : undefined) };
  const pinned = pinAllowList(dir, ids);
  expect(pinned).toEqual([{ principal: 'OP', workspace: 'ws-1', pane: 'pn-1', actions: ['do'] }]);
  expect(JSON.parse(readFileSync(join(dir, 'control-allow.json'), 'utf8'))).toEqual({ rules: [{ principal: 'OP', workspace: 'ws-1', pane: 'pn-1', actions: ['do'] }] });
  // the workspace is renamed, and a NEW workspace takes the name 'HQ'
  const reused = { workspace: (ref: string) => (ref === 'HQ' ? 'ws-2' : ref === 'ws-1' ? 'ws-1' : undefined), pane: ids.pane };
  expect(loadAllowList(dir, reused)).toEqual([{ principal: 'OP', workspace: 'ws-1', pane: 'pn-1', actions: ['do'] }]);
  expect(authorize(loadAllowList(dir, reused), cli, { workspace: 'ws-1', pane: 'pn-1', shell: true }, 'do')).toBe(true);
  expect(authorize(loadAllowList(dir, reused), cli, { workspace: 'ws-2', pane: 'pn-1', shell: true }, 'do')).toBe(false);
  // a name that does not resolve yet stays as written and authorizes nobody until it resolves
  const later = stateDir();
  allow(later, [{ principal: 'OP', workspace: 'LATER', pane: 'main', actions: ['do'] }]);
  expect(pinAllowList(later, { workspace: () => undefined, pane: ids.pane })).toEqual([]);
  expect(JSON.parse(readFileSync(join(later, 'control-allow.json'), 'utf8'))).toEqual({ rules: [{ principal: 'OP', workspace: 'LATER', pane: 'main', actions: ['do'] }] });
  const grow = { workspace: (ref: string) => (ref === 'LATER' ? 'ws-9' : undefined), pane: ids.pane };
  expect(loadAllowList(later, grow)).toEqual([{ principal: 'OP', workspace: 'ws-9', pane: 'pn-1', actions: ['do'] }]);
});

test('a495bddd8d review (audit from): the shown from is audited as chars and a sha256, never the free-input value', async () => {
  const dir = stateDir();
  allow(dir, [{ principal: '*', workspace: '*', pane: '*', actions: ['do'] }]);
  const { control } = door(dir);
  const held = await control.run({ principal: cli, from: 'secret-pat-token', action: 'do', target: shell, text: 'python3 /run/x' });
  expect(held.ok).toBe(false);
  const raw = readFileSync(join(dir, 'control-audit.jsonl'), 'utf8');
  expect(raw).not.toContain('secret-pat-token');
  const [line] = auditLines(dir);
  expect(line!.fromChars).toBe('secret-pat-token'.length);
  expect(line!.fromSha256).toBe(sha('secret-pat-token'));
});

test('a495bddd8d review (pin race): a revocation that lands while the list is pinned is kept, never overwritten', () => {
  const dir = stateDir();
  allow(dir, [{ principal: 'OP', workspace: 'HQ', pane: 'main', actions: ['do'] }]);
  const ids = { workspace: (ref: string) => (ref === 'HQ' || ref === 'ws-1' ? 'ws-1' : undefined), pane: (ref: string) => (ref === 'main' || ref === 'pn-1' ? 'pn-1' : undefined) };
  const revoked = `${JSON.stringify({ rules: [] })}\n`;
  expect(() => pinAllowList(dir, ids, { beforePin: () => { writeFileSync(join(dir, 'control-allow.json'), revoked); } })).toThrow();                                                    // this run fails closed
  expect(readFileSync(join(dir, 'control-allow.json'), 'utf8')).toBe(revoked);  // the revocation was not restored
});

test('pin failure closes the entire policy, including previously stable id rows', () => {
  const dir = stateDir();
  allow(dir, [
    { principal: 'OP', workspace: 'ws-1', pane: 'pn-1', actions: ['do'] },
    { principal: 'OP', workspace: 'HQ', pane: 'main', actions: ['do'] },
  ]);
  const ids = { workspace: (ref: string) => (ref === 'HQ' || ref === 'ws-1' ? 'ws-1' : undefined), pane: (ref: string) => (ref === 'main' || ref === 'pn-1' ? 'pn-1' : undefined) };
  chmodSync(dir, 0o555);  // the stash write fails
  try {
    expect(() => pinAllowList(dir, ids)).toThrow();
  } finally { chmodSync(dir, 0o700); }
});

test('list passes the same door: denied without a rule, executed with one, audited — and a list rule grants no read', async () => {
  const dir = stateDir();
  const every = { workspace: '*', pane: '*', shell: false };
  const closed = door(dir);
  const denied = await closed.control.run({ principal: cli, action: 'list', target: every });
  expect(denied.ok).toBe(false);
  if (denied.ok) return;
  expect(denied.code).toBe('denied');
  expect(denied.message).toBe('els list: denied for OP (not in control-allow.json)');
  expect(closed.ran).toEqual([]);
  allow(dir, [{ principal: 'OP', workspace: '*', pane: '*', actions: ['list'] }]);
  const open = door(dir);
  const listed = await open.control.run({ principal: cli, action: 'list', target: every });
  expect(listed.ok).toBe(true);
  expect(open.ran).toEqual(['']);
  const read = await open.control.run({ principal: cli, action: 'read', target: every });
  expect(read.ok).toBe(false);
  const rows = readFileSync(join(dir, 'control-audit.jsonl'), 'utf8').trim().split('\n')
    .map((row) => JSON.parse(row) as { action: string; result: string; text?: string });
  expect(rows.map((row) => [row.action, row.result])).toEqual([['list', 'denied'], ['list', 'executing'], ['list', 'executed'], ['read', 'denied']]);
  expect(rows.every((row) => row.text === undefined)).toBe(true);
});

// OP #17 OP-DIRECT-SEAT-INPUT — `input` is the operator's direct line into a seat: an allowlist row must name the
// action, and even then only OP and RES-INFRA pass the door. The audit keeps chars + sha256 only, never the text.
test('els input: an allow row without the input action keeps OP out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'els-input-allow-'));
  writeFileSync(join(dir, 'control-allow.json'), JSON.stringify({ rules: [{ principal: '*', workspace: '*', pane: '*', actions: ['read'] }] }));
  const door = createControl({ stateDir: dir, now: () => 1_700_000_000_000, execute: async () => ({ exitCode: 0, message: 'typed' }) });
  const outcome = await door.run({ principal: { id: 'OP', kind: 'cli' }, action: 'input', target: { workspace: 'ws', pane: 'p1', shell: true }, text: 'x' });
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error('expected denial');
  expect(outcome.code).toBe('denied');
  expect(outcome.reason).toBe('not in control-allow.json');
  expect(outcome.message).toBe('els input: denied for OP (not in control-allow.json)');
});

test('els input: OP with an input row reaches the executor and the audit says executed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'els-input-op-'));
  writeFileSync(join(dir, 'control-allow.json'), JSON.stringify({ rules: [{ principal: 'local:501', seat: 'OP', workspace: '*', pane: '*', actions: ['input'] }] }));
  const door = createControl({ stateDir: dir, now: () => 1_700_000_000_000, execute: async () => ({ exitCode: 0, message: 'typed' }) });
  const outcome = await door.run({ principal: { id: 'local:501', kind: 'cli', callerPane: 'w1:p2', callerSeat: 'OP' }, action: 'input', target: { workspace: 'ws', pane: 'p1', shell: true }, text: 'x' });
  expect(outcome.ok).toBe(true);
  const audit = await Bun.file(join(dir, 'control-audit.jsonl')).text();
  expect(audit).toContain('"action":"input"');
  expect(audit).toContain('"result":"executing"');
  expect(audit).toContain('"result":"executed"');
});

test('els input: an input row does not open the door to other principals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'els-input-gate-'));
  writeFileSync(join(dir, 'control-allow.json'), JSON.stringify({ rules: [{ principal: '*', workspace: '*', pane: '*', actions: ['input'] }] }));
  const door = createControl({ stateDir: dir, now: () => 1_700_000_000_000, execute: async () => ({ exitCode: 0, message: 'typed' }) });
  const outcome = await door.run({ principal: { id: 'HAND-X', kind: 'cli' }, action: 'input', target: { workspace: 'ws', pane: 'p1', shell: true }, text: 'x' });
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error('expected denial');
  expect(outcome.code).toBe('denied');
  expect(outcome.message).toBe('els input: denied for HAND-X (not in control-allow.json)');
  const audit = await Bun.file(join(dir, 'control-audit.jsonl')).text();
  expect(audit).toContain('"result":"denied"');
});

test('input built-in: authenticated seats only, explicit deny wins, other actions unchanged', async () => {
  const dir = stateDir();
  allow(dir, []);
  const { control, ran } = door(dir);
  const op: Principal = { id: 'local:501', kind: 'cli', callerPane: 'w1:p2', callerSeat: 'OP' };
  const run = (principal: Principal, action: 'input' | 'read' = 'input', from = 'OP') => control.run({ principal, action, target: agent, text: 'secret', from });
  expect((await run(op)).ok).toBe(true);
  expect((await run({ ...op, callerSeat: 'RES-INFRA' })).ok).toBe(true);
  expect((await run(op, 'read')).ok).toBe(false);
  for (const forged of [
    { ...op, callerSeat: undefined }, { ...op, callerPane: undefined },
    { ...op, callerSeat: 'HAND-X' }, { ...op, kind: 'http-token' as const },
    { ...op, id: 'OP' },
  ]) expect((await run(forged)).ok).toBe(false);
  allow(dir, [{ principal: 'local:501', workspace: 'HQ', pane: 'p1', actions: ['input'], effect: 'deny' }]);
  expect((await run(op)).ok).toBe(false);
  expect(ran).toEqual(['secret', 'secret']);
  const rows = readFileSync(join(dir, 'control-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(rows.slice(0, 4).every(row => row.authorization === 'builtin-input')).toBe(true);
  expect(rows.at(-1).reason).toBe('explicit input deny');
  expect(JSON.stringify(rows)).not.toContain('secret');
});

test('input deny survives pinning and does not grant other actions', async () => {
  const dir = stateDir();
  allow(dir, [{ principal: 'local:501', workspace: 'HQ', pane: 'main', actions: ['input', 'read'], effect: 'deny' }]);
  const ids = { workspace: () => 'ws-1', pane: () => 'pn-1' };
  const rules = pinAllowList(dir, ids);
  expect(rules[0]?.effect).toBe('deny');
  expect(JSON.parse(readFileSync(join(dir, 'control-allow.json'), 'utf8')).rules[0].effect).toBe('deny');
  expect(authorize(rules, { id: 'local:501', kind: 'cli' }, { workspace: 'ws-1', pane: 'pn-1', shell: false }, 'read')).toBe(false);
});

test('input default spans file presence; non-input revocation remains effective', async () => {
  const dir = stateDir();
  const { control } = door(dir);
  const principal: Principal = { id: 'local:501', kind: 'cli', callerPane: 'w1:p2', callerSeat: 'OP' };
  const run = (action: 'input' | 'read') => control.run({ principal, action, target: agent });
  expect((await run('input')).ok).toBe(true);
  expect((await run('read')).ok).toBe(false);
  allow(dir, [{ principal: 'local:501', workspace: '*', pane: '*', actions: ['read'] }]);
  expect((await run('input')).ok).toBe(true);
  expect((await run('read')).ok).toBe(true);
  allow(dir, []);
  expect((await run('input')).ok).toBe(true);
  expect((await run('read')).ok).toBe(false);
  allow(dir, [{ principal: 'local:501', workspace: '*', pane: '*', actions: ['read'] }]);
  rmSync(join(dir, 'control-allow.json'));
  expect((await run('input')).ok).toBe(true);
  expect((await run('read')).ok).toBe(false);
});

test('input deny overrides allows and survives a failed name pin', async () => {
  const dir = stateDir();
  const deny: AllowRule = { principal: '*', workspace: 'HQ', pane: 'main', actions: ['input'], effect: 'deny' };
  allow(dir, [{ principal: '*', workspace: '*', pane: '*', actions: ['input'] }, deny]);
  const ids = { workspace: (ref: string) => ref === 'HQ' || ref === 'ws-1' ? 'ws-1' : undefined, pane: (ref: string) => ref === 'main' || ref === 'pn-1' ? 'pn-1' : undefined };
  expect(() => pinAllowList(dir, ids, { beforePin: () => { throw new Error('simulated failure'); } })).toThrow();
  const control = createControl({ stateDir: dir, resolve: ids, execute: async () => ({ exitCode: 0, message: 'typed' }) });
  const result = await control.run({ principal: { id: 'local:501', kind: 'cli', callerPane: 'w1:p2', callerSeat: 'OP' }, action: 'input', target: { workspace: 'ws-1', pane: 'pn-1', shell: false } });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe('explicit input deny');
});

test('input policy errors fail closed, only missing file permits default', async () => {
  const principal: Principal = { id: 'local:501', kind: 'cli', callerPane: 'w1:p2', callerSeat: 'OP' };
  for (const raw of ['{', 'null', '{}', '{"rules":{}}', '{"rules":[{}]}', '{"rules":[{"principal":"*","workspace":"*","pane":"*","actions":["input"],"effect":"denyy"}]}', '{"rules":[{"principal":"*","workspace":"*","pane":"*","actions":["input"],"effect":"deny","seat":42}]}']) {
    const dir = stateDir();
    writeFileSync(join(dir, 'control-allow.json'), raw);
    const { control, ran } = door(dir);
    expect((await control.run({ principal, action: 'input', target: agent })).ok).toBe(false);
    expect(ran).toEqual([]);
  }
  const dir = stateDir();
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, 'control-allow.json'));
  const { control, ran } = door(dir);
  expect((await control.run({ principal, action: 'input', target: agent })).ok).toBe(false);
  expect(ran).toEqual([]);
});

test('deny resolution is stable for the whole authorization even if resolver changes', async () => {
  const dir = stateDir();
  allow(dir, [{ principal: '*', workspace: 'HQ', pane: 'main', actions: ['input'], effect: 'deny' }]);
  let workspaceCalls = 0;
  const control = createControl({ stateDir: dir, resolve: {
    workspace: () => ++workspaceCalls === 1 ? 'ws-1' : undefined,
    pane: () => 'pn-1',
  }, execute: async () => { throw new Error('must not execute'); } });
  const result = await control.run({ principal: { id: 'local:501', kind: 'cli', callerPane: 'w1:p2', callerSeat: 'OP' }, action: 'input', target: { workspace: 'ws-1', pane: 'pn-1', shell: false } });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe('explicit input deny');
  expect(workspaceCalls).toBe(1);
});

test('input denies malformed action mixtures and unresolved deny rules', async () => {
  const principal: Principal = { id: 'local:501', kind: 'cli', callerPane: 'w1:p2', callerSeat: 'OP' };
  for (const rule of [
    { principal: '*', workspace: '*', pane: '*', actions: ['input', 'unknown'], effect: 'deny' },
    { principal: '*', workspace: 'missing', pane: '*', actions: ['input'], effect: 'deny' },
  ]) {
    const dir = stateDir();
    writeFileSync(join(dir, 'control-allow.json'), JSON.stringify({ rules: [rule] }));
    let executed = false;
    const control = createControl({ stateDir: dir, resolve: { workspace: () => undefined, pane: () => undefined }, execute: async () => { executed = true; return { exitCode: 0, message: 'typed' }; } });
    const result = await control.run({ principal, action: 'input', target: agent });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('control policy unavailable');
    expect(executed).toBe(false);
    expect(auditLines(dir).map(row => row.result)).toEqual(['denied']);
  }
});

test('pin failure after concurrent deny change never uses old snapshot', () => {
  const dir = stateDir();
  allow(dir, [{ principal: '*', workspace: 'HQ', pane: 'main', actions: ['read'] }]);
  const ids = { workspace: () => 'ws-1', pane: () => 'pn-1' };
  expect(() => pinAllowList(dir, ids, { beforePin: () => {
    allow(dir, [{ principal: '*', workspace: '*', pane: '*', actions: ['input'], effect: 'deny' }]);
    throw new Error('simulated failure');
  } })).toThrow();
});

test('failed deny pin does not transiently bind a reusable name', () => {
  const dir = stateDir();
  allow(dir, [{ principal: '*', workspace: 'HQ', pane: 'main', actions: ['input'], effect: 'deny' }]);
  const ids = { workspace: () => 'ws-1', pane: () => 'pn-1' };
  expect(() => pinAllowList(dir, ids, { beforePin: () => { throw new Error('simulated failure'); } })).toThrow();
});
