import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliPrincipal, controlledDo, hitlQuestion, journalControl, type ControlledDoDeps } from './control-cli.js';
import type { ElsResult } from './core.js';
import type { SpaceJournal } from './space.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const stateDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'els-control-cli-')); dirs.push(dir); return dir; };
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const shell = { workspace: 'HQ', pane: 'p1', shell: true };
const sent: { pane: string; text: string; from: string }[] = [];
afterEach(() => { sent.splice(0); });

function deps(dir: string, over: Partial<ControlledDoDeps> = {}): ControlledDoDeps {
  return {
    stateDir: dir,
    from: 'OP',
    uid: 501,
    ownerUid: () => 501,
    lookup: async () => shell,
    send: async (pane, text, from) => { sent.push({ pane, text, from }); return { exitCode: 0, message: 'els do: p1 delivered 7 chars from OP' }; },
    ...over,
  };
}

const rules = (dir: string, list: unknown[]): void => writeFileSync(join(dir, 'control-allow.json'), JSON.stringify({ rules: list }));

const audit = (dir: string): { result: string; principal: string; fromChars: number; fromSha256: string; text?: string }[] =>
  readFileSync(join(dir, 'control-audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { result: string; principal: string; fromChars: number; fromSha256: string; text?: string });

test('a local els do with no allow list is denied for the OS principal and never sent', async () => {
  const dir = stateDir();
  const done = await controlledDo(deps(dir), 'p1', 'echo hi');
  expect(done).toEqual({ exitCode: 1, message: 'els do: denied for local:501 (not in control-allow.json)' });
  expect(sent).toEqual([]);
  expect(audit(dir).map((row) => row.result)).toEqual(['denied']);
  expect(audit(dir)[0]!.text).toBeUndefined();
});

test('--from is only shown: a rule for the --from name does not authorize', async () => {
  const dir = stateDir();
  rules(dir, [{ principal: 'OP', workspace: '*', pane: '*', actions: ['do'] }]);
  const done = await controlledDo(deps(dir), 'p1', 'echo hi');
  expect(done).toEqual({ exitCode: 1, message: 'els do: denied for local:501 (not in control-allow.json)' });
  expect(sent).toEqual([]);
  expect(audit(dir)[0]).toMatchObject({ principal: 'local:501', fromChars: 'OP'.length, fromSha256: sha('OP'), result: 'denied' });
});

test('a state folder owned by another uid refuses before anything is looked up or sent', async () => {
  const dir = stateDir();
  rules(dir, [{ principal: '*', workspace: '*', pane: '*', actions: ['do'] }]);
  let looked = 0;
  const done = await controlledDo(deps(dir, { ownerUid: () => 0, lookup: async () => { looked += 1; return shell; } }), 'p1', 'echo hi');
  expect(done).toEqual({ exitCode: 1, message: `els do: denied (state folder ${dir} belongs to uid 0, not uid 501)` });
  expect(looked).toBe(0);
  expect(sent).toEqual([]);
  expect(cliPrincipal(dir, 501, () => undefined)).toEqual({ id: 'local:501', kind: 'cli' });
});

test('an unknown local pane is not sent', async () => {
  const dir = stateDir();
  const done = await controlledDo(deps(dir, { lookup: async () => undefined }), 'missing', 'echo hi');
  expect(done).toEqual({ exitCode: 1, message: 'els do: unknown pane missing' });
  expect(sent).toEqual([]);
});

test('an allowed safe line is sent once, with --from shown, and audited without the text', async () => {
  const dir = stateDir();
  rules(dir, [{ principal: 'local:501', workspace: 'HQ', pane: '*', actions: ['do'] }]);
  const done = await controlledDo(deps(dir), 'p1', 'echo hi');
  expect(done.exitCode).toBe(0);
  expect(sent).toEqual([{ pane: 'p1', text: 'echo hi', from: 'OP' }]);
  expect(audit(dir).map((row) => row.result)).toEqual(['executing', 'executed']);
  expect(audit(dir)[1]!.text).toBeUndefined();
});

test('a dangerous line is not sent on deny or timeout, and is sent once on approve; the question names who, where and what', async () => {
  const dir = stateDir();
  rules(dir, [{ principal: 'local:501', workspace: '*', pane: '*', actions: ['do'] }]);
  const questions: string[] = [];
  const deny = await controlledDo(deps(dir, { ask: async (q) => { questions.push(q); return 'deny'; } }), 'p1', 'sudo reboot');
  expect(deny).toEqual({ exitCode: 1, message: 'els do: deny, not sent (sudo)' });
  expect(questions).toEqual(['els do: sudo\n  by local:501 (shown as OP)\n  to HQ/p1\n  line "sudo reboot"\napprove? [y/N] ']);
  const late = await controlledDo(deps(dir, { ask: async () => 'timeout' }), 'p1', 'sudo reboot');
  expect(late).toEqual({ exitCode: 1, message: 'els do: timeout, not sent (sudo)' });
  const yes = await controlledDo(deps(dir, { ask: async () => 'approve' }), 'p1', 'sudo reboot');
  expect(yes.exitCode).toBe(0);
  expect(sent).toEqual([{ pane: 'p1', text: 'sudo reboot', from: 'OP' }]);
  expect(audit(dir).map((row) => row.result)).toEqual(['rejected', 'timeout', 'executing', 'executed']);
});

test('hitlQuestion shows control characters in the line instead of hiding them', () => {
  expect(hitlQuestion({ principal: { id: 'local:501', kind: 'cli' }, from: 'OP', action: 'do', target: shell, text: 'a\tb', reason: 'x' }))
    .toContain('line "a\\tb"');
});

test('a remote address skips this host door and is handed to send unchanged', async () => {
  const dir = stateDir();
  const done: ElsResult = await controlledDo(deps(dir), 'other:HQ/t1/p9', 'echo hi');
  expect(done.exitCode).toBe(0);
  expect(sent).toEqual([{ pane: 'other:HQ/t1/p9', text: 'echo hi', from: 'OP' }]);
});

const journal = {
  version: 1,
  workspaces: [{ id: 'ws-1', name: 'HQ', rootCwd: '/', purpose: '', host: '' }],
  tabs: [{ id: 'tb-1', workspaceId: 'ws-1', label: 't', focusPaneId: 'pn-1' }],
  panes: [
    { id: 'pn-1', tabId: 'tb-1', kind: 'pty', title: 'main', cwd: '/', command: [], state: 'running', restore: 'never', ptyId: '' },
    { id: 'pn-2', tabId: 'tb-1', kind: 'agent', title: 'bot', cwd: '/', command: [], state: 'running', restore: 'never', ptyId: '' },
  ],
} as unknown as SpaceJournal;

test('journal lookup gives ids: a pane named by title or id resolves to the same workspace id and pane id', async () => {
  const local = journalControl(journal);
  expect(await local.lookup('main')).toEqual({ workspace: 'ws-1', pane: 'pn-1', shell: true });
  expect(await local.lookup('pn-1')).toEqual({ workspace: 'ws-1', pane: 'pn-1', shell: true });
  expect(await local.lookup('pn-2')).toEqual({ workspace: 'ws-1', pane: 'pn-2', shell: false });
  expect(await local.lookup('nope')).toBeUndefined();
});

test('through the journal, an id rule and a name rule both authorize; a rule naming nothing real does not', async () => {
  for (const rule of [{ workspace: 'ws-1', pane: 'pn-1' }, { workspace: 'HQ', pane: 'main' }]) {
    const dir = stateDir();
    rules(dir, [{ principal: 'local:501', actions: ['do'], ...rule }]);
    const done = await controlledDo(deps(dir, journalControl(journal)), 'main', 'echo hi');
    expect(done.exitCode).toBe(0);
  }
  expect(sent).toEqual([{ pane: 'pn-1', text: 'echo hi', from: 'OP' }, { pane: 'pn-1', text: 'echo hi', from: 'OP' }]);
  const dir = stateDir();
  rules(dir, [{ principal: 'local:501', workspace: 'GONE', pane: '*', actions: ['do'] }]);
  const denied = await controlledDo(deps(dir, journalControl(journal)), 'main', 'echo hi');
  expect(denied.exitCode).toBe(1);
});
