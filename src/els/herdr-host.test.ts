import { expect, test } from 'bun:test';
import { elsRowsFromList } from '../tui/sidetab/els-rows.js';
import { createFederation } from './federation.js';
import { withHerdrHost } from './herdr-host.js';
import type { HerdrCliRunner } from '../pty-shell/herdr-prompt.js';

// A trimmed real `herdr api snapshot` (herdr 0.9.1): workspaces/tabs/panes live under result.snapshot.
const SNAPSHOT = { id: 'cli:api:snapshot', result: { snapshot: {
  workspaces: [{ workspace_id: 'w1', label: 'OP' }, { workspace_id: 'w2', label: 'REL' }, { workspace_id: 'w4', label: 'HAND-TUI-C' }],
  tabs: [],
  panes: [
    { pane_id: 'w1:p2', tab_id: 'w1:t2', workspace_id: 'w1', agent: 'elanous', agent_status: 'idle', cwd: '/seats/OP', terminal_title_stripped: 'mshq 주 OP' },
    { pane_id: 'w2:p2', tab_id: 'w2:t1', workspace_id: 'w2', agent: 'elanous', agent_status: 'working', display_agent: 'eln·gpt-6-sol', cwd: '/seats/REL' },
    { pane_id: 'w4:pK', tab_id: 'w4:tJ', workspace_id: 'w4', agent: 'claude', agent_status: 'blocked', cwd: '/seats/TUI' },
    { pane_id: 'w4:pL', tab_id: 'w4:tJ', workspace_id: 'w4', agent_status: 'done', terminal_title: 'zsh' },
    { pane_id: 'w4:pM', tab_id: 'w4:tJ', workspace_id: 'w4', terminal_title: 'zsh plain shell' }, // no agent_status at all: unknown
    { pane_id: 'w9:p1', tab_id: 'w1:t9', workspace_id: 'w1', agent_status: 'idle' }, // pane id not prefixed by its workspace: left out
  ] } } };

function rig(options: { env?: NodeJS.ProcessEnv; snapshot?: unknown; snapshotFails?: boolean; enterFails?: boolean; hosts?: { name: string; baseUrl: string }[] } = {}) {
  const calls: string[][] = [];
  const run: HerdrCliRunner = async (argv) => {
    calls.push([...argv]);
    if (argv[0] === 'api') return options.snapshotFails ? { code: 1, stdout: '', stderr: 'socket refused' } : { code: 0, stdout: JSON.stringify(options.snapshot ?? SNAPSHOT), stderr: '' };
    if (argv[0] === 'pane' && argv[1] === 'read') return argv[2] === 'w1:p2' ? { code: 0, stdout: 'SCREEN OF OP', stderr: '' } : { code: 1, stdout: '', stderr: 'pane not found' };
    if (options.enterFails && argv[1] === 'send-keys') return { code: 1, stdout: '', stderr: 'keys refused' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const remoteCalls: string[] = [];
  const wired = withHerdrHost({ env: options.env ?? { HERDR_ENV: '1' }, run, registry: { hosts: options.hosts ?? [], rejected: [] },
    fetchJson: async (host, path) => { remoteCalls.push(`GET ${host.name}${path}`); return { status: 200, body: { host: host.name, panes: [] } }; },
    postJson: async (host, path) => { remoteCalls.push(`POST ${host.name}${path}`); return { status: 200, body: { message: 'remote ok' } }; } });
  const federation = createFederation({ localHost: 'here', askLocal: async () => ({ exitCode: 0, message: JSON.stringify({ workspaces: [], tabs: [], panes: [] }) }), ...wired });
  return { calls, remoteCalls, federation, wired };
}

test('herdr panes join the same list as the host `herdr`: addresses, titles with the workspace label, shared status words', async () => {
  const { federation } = rig();
  const listed = JSON.parse((await federation.list()).message) as { hosts: unknown[]; panes: { address: string; title: string; state: string; host: string; reach: string }[] };
  expect(listed.hosts).toEqual([{ name: 'here', reach: 'local' }, { name: 'herdr', reach: 'up' }]);
  expect(listed.panes.map((pane) => `${pane.address} | ${pane.title} | ${pane.state}`)).toEqual([
    'herdr:w1/t2/p2 | OP · mshq 주 OP | idle',
    'herdr:w2/t1/p2 | REL · eln·gpt-6-sol | working',
    'herdr:w4/tJ/pK | HAND-TUI-C · claude | blocked',
    'herdr:w4/tJ/pL | HAND-TUI-C · zsh | done',
    'herdr:w4/tJ/pM | HAND-TUI-C · zsh plain shell | unknown',
  ]);
});

test('the sidetab draws those panes as ⇄herdr rows with the working / blocked / idle / done words', async () => {
  const { federation } = rig();
  const rows = elsRowsFromList((await federation.list()).message, 'here');
  expect(rows.map((row) => `${row.label} | ${row.agentState ?? row.badge}`)).toEqual([
    '⇄herdr OP · mshq 주 OP | idle', '⇄herdr REL · eln·gpt-6-sol | working', '⇄herdr HAND-TUI-C · claude | blocked', '⇄herdr HAND-TUI-C · zsh | done', '⇄herdr HAND-TUI-C · zsh plain shell | unknown']);
});

test('read: the els address becomes the herdr pane id; an unknown pane is the usual els answer', async () => {
  const { federation, calls } = rig();
  expect(await federation.read('herdr:w1/t2/p2')).toEqual({ exitCode: 0, message: 'SCREEN OF OP' });
  expect(calls.at(-1)).toEqual(['pane', 'read', 'w1:p2', '--source', 'visible', '--format', 'text']);
  expect(await federation.read('herdr:w2/t1/p9')).toEqual({ exitCode: 1, message: 'els read: unknown pane herdr:w2/t1/p9' });
});

test('do types «⇢ from · line» then Enter into an idle pane, with control characters dropped', async () => {
  const { federation, calls } = rig();
  const done = await federation.do('herdr:w1/t2/p2', 'run the\u001b[2J tests\u0007', 'HAND-CLAUDE-ELS2');
  expect(done.exitCode).toBe(0);
  expect(calls.filter((call) => call[0] === 'pane')).toEqual([['pane', 'send-text', 'w1:p2', '⇢ here/HAND-CLAUDE-ELS2 · run the [2J tests'], ['pane', 'send-keys', 'w1:p2', 'enter']]);
});

test('do never types into a working or blocked pane, an unknown pane, or when the state cannot be read', async () => {
  const working = rig();
  expect((await working.federation.do('herdr:w2/t1/p2', 'hi', 'x')).message).toContain('is working, not sent');
  const blocked = rig();
  expect((await blocked.federation.do('herdr:w4/tJ/pK', 'hi', 'x')).message).toContain('is blocked, not sent');
  const unknown = rig();
  expect((await unknown.federation.do('herdr:w1/t2/p7', 'hi', 'x')).message).toContain('unknown pane');
  const down = rig({ snapshotFails: true });
  expect((await down.federation.do('herdr:w1/t2/p2', 'hi', 'x')).message).toContain('not sent');
  for (const r of [working, blocked, unknown, down]) expect(r.calls.some((call) => call[1] === 'send-text' || call[1] === 'send-keys')).toBe(false);
});

test('herdr not running is one «down» host row, not an error; HERDR_ENV unset or a registered host named herdr means no pane host of ours', async () => {
  const down = rig({ snapshotFails: true });
  expect(JSON.parse((await down.federation.list()).message).hosts).toEqual([{ name: 'here', reach: 'local' }, { name: 'herdr', reach: 'down', reason: 'http 502' }]);
  const off = rig({ env: {} });
  expect(JSON.parse((await off.federation.list()).message).hosts).toEqual([{ name: 'here', reach: 'local' }]);
  expect(off.calls).toEqual([]);
  const taken = rig({ hosts: [{ name: 'herdr', baseUrl: 'http://100.64.0.9:8790' }] });
  await taken.federation.list();
  expect(taken.calls).toEqual([]); // the registered tailnet host of that name is the one asked
  expect(taken.remoteCalls).toEqual(['GET herdr/els/ls']);
});

test('other hosts still go to the real transport, reads and input alike', async () => {
  const { federation, remoteCalls } = rig({ hosts: [{ name: 'node-b', baseUrl: 'http://100.64.0.5:8790' }] });
  await federation.list();
  const sent = await federation.do('node-b:w1/t1/p1', 'hello', 'seat');
  expect(sent.message).toBe('remote ok');
  expect(remoteCalls).toEqual(['GET node-b/els/ls', 'POST node-b/els/do']);
});

test('a pane with no agent status (a plain shell) is listed as unknown and is never typed into', async () => {
  const { federation, calls } = rig();
  const answer = await federation.do('herdr:w4/tJ/pM', 'rm -rf nothing', 'seat');
  expect(answer.exitCode).toBe(1);
  expect(answer.message).toContain('is unknown, not sent');
  expect(calls.some((call) => call[1] === 'send-text' || call[1] === 'send-keys')).toBe(false);
});

test('a wrong tab in the address is an unknown pane for do and for read: workspace, tab and pane must all match', async () => {
  const { federation, calls } = rig();
  const typed = await federation.do('herdr:w1/tZ/p2', 'hi', 'seat'); // pane w1:p2 is in tab t2, not tZ
  expect(typed.message).toContain('unknown pane');
  expect(calls.some((call) => call[1] === 'send-text' || call[1] === 'send-keys')).toBe(false);
  expect(await federation.read('herdr:w1/tZ/p2')).toEqual({ exitCode: 1, message: 'els read: unknown pane herdr:w1/tZ/p2' });
  expect(calls.some((call) => call[0] === 'pane' && call[1] === 'read')).toBe(false);
  expect((await federation.read('herdr:w1/t2/p2')).message).toBe('SCREEN OF OP');
});

test('text typed but Enter refused is reported as not submitted; a line over 8000 chars is refused before anything is typed', async () => {
  const noEnter = rig({ enterFails: true });
  const partial = await noEnter.federation.do('herdr:w1/t2/p2', 'hello', 'seat');
  expect(partial.exitCode).toBe(1);
  expect(partial.message).toContain('typed but not submitted: keys refused');
  expect(noEnter.calls.filter((call) => call[1] === 'send-text')).toHaveLength(1);
  const long = rig();
  const refused = await long.federation.do('herdr:w1/t2/p2', 'x'.repeat(8001), 'seat');
  expect(refused.exitCode).toBe(2);
  expect(refused.message).toContain('longer than 8000 chars');
  expect(long.calls.some((call) => call[1] === 'send-text' || call[1] === 'send-keys')).toBe(false);
});
