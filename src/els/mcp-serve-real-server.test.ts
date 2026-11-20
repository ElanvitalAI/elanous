import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { requestEls } from './client.js';
import { findPane, elsJournalPath, loadJournal } from './journal.js';
import { createControlledBackend, createSocketBackend, serveElsMcpStdio } from './mcp-serve.js';
import { AUTH_OWNER_TOKEN_ENV, AUTH_PANE_TOKEN_ENV } from './server-auth.js';
import { elsSocketPath, startElsServer } from './server.js';
import { createLineDecoder } from './wire.js';

// ELS-MCP-SERVER sign-off (JUD #111411 ②): the MCP stdio loop (serveElsMcpStdio, injected streams) → the control door
// (control.ts, control-allow.json + audit) → the socket backend → a REAL startElsServer owning REAL PTY panes.
// mcp-serve.test.ts covers the same surface against fakes; only the real-server wiring is added here.
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir(); // train TMPDIR is long; unix sockets stop at 103 bytes
const DELIVERED = '⇢ mcp-stdio:real · echo MCP_PAYLOAD_7'; // `echo <word>` is on the door's safe list; a shell `do` off it is held
const WAIT_MS = 20_000;
const TEST_MS = 90_000; // a real holder PTY start plus a handful of waits of at most WAIT_MS each

const savedEnv = { owner: process.env[AUTH_OWNER_TOKEN_ENV], pane: process.env[AUTH_PANE_TOKEN_ENV] };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const [key, value] of [[AUTH_OWNER_TOKEN_ENV, savedEnv.owner], [AUTH_PANE_TOKEN_ENV, savedEnv.pane]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

const until = async <T>(check: () => Promise<T | undefined> | T | undefined, what: string): Promise<T> => {
  const stop = Date.now() + WAIT_MS;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

type Rpc = { id: number; result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string }[] }; error?: { code: number; message: string; data?: { reason: string } } };
const ALLOW = (principal: string) => [
  { principal, workspace: '*', pane: '*', actions: ['list'] },
  { principal, workspace: 'proj', pane: '*', actions: ['new', 'read', 'do'] },
];

/** A real els server (real holder PTYs) with the OP seat registered by the owner token over the real socket. One server
 *  per test: startElsServer exports the owner token into process.env, restored in afterEach. */
async function realServer(principals: readonly string[]) {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-mcpr-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const started = await startElsServer({ stateRoot: root });
  if ('exitCode' in started) throw new Error(started.message);
  const socket = elsSocketPath(root);
  cleanups.push(async () => {
    const listed = await requestEls(socket, { op: 'ls' });
    for (const row of listed.exitCode === 0 ? (JSON.parse(listed.message) as { panes: { pane: string }[] }).panes : []) await requestEls(socket, { op: 'close', pane: row.pane, confirmed: true });
    await started.close();
  });
  // JUD #39057 ⓒ1③: the first owner act on a server is the explicit OP registration.
  const seated = await requestEls(socket, { op: 'seat-set', seat: 'OP' });
  expect(seated.message, 'seat-set OP answer').toContain('OP registered');
  const controlDir = join(root, 'els');
  writeFileSync(join(controlDir, 'control-allow.json'), JSON.stringify({ rules: principals.flatMap(ALLOW) }));
  const rows = async (): Promise<{ pane: string; workspace: string; address: string }[]> => (JSON.parse((await requestEls(socket, { op: 'ls' })).message) as { panes: { pane: string; workspace: string; address: string }[] }).panes;
  const audit = () => readFileSync(join(controlDir, 'control-audit.jsonl'), 'utf8').trim().split('\n').map((row) => JSON.parse(row) as { principal: string; action: string; result: string; text?: string });
  return { root, socket, controlDir, rows, audit };
}

/** The real MCP stdio loop in this process, wired exactly like `els mcp serve` (journal-backed lookup, socket backend). */
async function mcpClient(server: Awaited<ReturnType<typeof realServer>>, clientName: string) {
  const { root, socket, controlDir } = server;
  const lookup = async (ref: string) => {
    const journal = loadJournal(elsJournalPath(root));
    const pane = findPane(journal, ref);
    const tab = pane ? journal.tabs.find((row) => row.id === pane.tabId) : undefined;
    const ws = tab ? journal.workspaces.find((row) => row.id === tab.workspaceId) : undefined;
    return pane && ws ? { workspace: ws.name || ws.id, pane: pane.id, shell: pane.kind === 'pty' } : undefined;
  };
  const env = { SHELL: '/bin/sh' };
  const backend = createControlledBackend({ stateDir: controlDir, lookup, inner: createSocketBackend(socket, env, root), env, cwd: root });
  const input = new PassThrough();
  const answers = new Map<number, Rpc>();
  const decoder = createLineDecoder((raw) => { const row = JSON.parse(raw) as Rpc; answers.set(row.id, row); });
  const output = new Writable({ write(chunk: Buffer, _enc, done) { decoder.push(chunk); done(); } });
  const serving = serveElsMcpStdio(backend, input, output, { pollMs: 60_000 });
  cleanups.push(async () => { input.end(); await serving; });
  let nextId = 1;
  const rpc = async (method: string, params: Record<string, unknown> = {}): Promise<Rpc> => {
    const id = nextId++;
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return until(() => answers.get(id), `answer to ${method}`);
  };
  await rpc('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: clientName } });
  return {
    rpc,
    call: (name: string, args: Record<string, unknown> = {}) => rpc('tools/call', { name, arguments: args }),
    text: (answer: Rpc): string => answer.result?.content?.[0]?.text ?? '',
  };
}

test('real server + real PTY: tools/list, els_new, els_ls, els_do, els_read run end-to-end through the door, every action audited', async () => {
  const server = await realServer(['mcp-stdio:real']);
  const mcp = { ...(await mcpClient(server, 'real')), ...server };
  const tools = await mcp.rpc('tools/list');
  expect(tools.result?.tools?.map((tool) => tool.name)).toEqual(['els_ls', 'els_read', 'els_do', 'els_new', 'els_status']);

  // els_new: an allow-listed argv opens a real shell PTY in workspace `proj`.
  const opened = await mcp.call('els_new', { ws: 'proj', cwd: mcp.root, command: ['sh'] });
  expect(opened.error, `els_new answer: ${JSON.stringify(opened)}`).toBeUndefined();
  const { pane } = JSON.parse(mcp.text(opened)) as { pane: string };

  // els_ls: the new pane is listed through the real server, in workspace proj.
  const listed = JSON.parse(mcp.text(await mcp.call('els_ls'))) as { panes: { pane: string; workspace: string; address: string }[] };
  const row = listed.panes.find((candidate) => candidate.pane === pane);
  expect(row?.workspace).toBe('proj');

  // els_do by full ws/tab/pane address, els_read by bare pane id. `do` types «⇢ <sender> · <text>» into the PTY, so the
  // PTY's own echo proves delivery AND that the sender mark is the transport's principal, not a tool argument.
  const done = await mcp.call('els_do', { address: row!.address, text: 'echo MCP_PAYLOAD_7' });
  expect(done.error, `els_do answer: ${JSON.stringify(done)}`).toBeUndefined();
  const screen = await until(async () => { const read = await mcp.call('els_read', { address: pane }); return mcp.text(read).includes(DELIVERED) ? mcp.text(read) : undefined; }, 'the delivered line on the screen');
  expect(screen).toContain(DELIVERED);
  // The same pane is readable as a resource, and its direct screen (as OP, over the real socket) agrees.
  const resource = await mcp.rpc('resources/read', { uri: `els://pane/${row!.address}/screen` });
  expect(resource.result).toMatchObject({ contents: [{ mimeType: 'text/plain' }] });
  expect((await requestEls(mcp.socket, { op: 'read', pane })).message).toContain(DELIVERED);

  const executed = new Set(mcp.audit().filter((entry) => entry.principal === 'mcp-stdio:real' && entry.result === 'executed').map((entry) => entry.action));
  expect([...executed].sort()).toEqual(['do', 'list', 'new', 'read']);
  expect(mcp.audit().every((entry) => entry.result !== 'denied')).toBe(true);
}, TEST_MS);

test('real server + real PTY: outside the allow list is -32001 at the door — els_do/els_read/els_new refused, audited denied, the real pane never typed into', async () => {
  const server = await realServer(['mcp-stdio:real']);
  const mcp = { ...(await mcpClient(server, 'real')), ...server };
  // A real pane in a workspace the principal has no rule for (made by the OP seat, not through MCP).
  const other = JSON.parse((await requestEls(mcp.socket, { op: 'new', ws: 'other', cwd: mcp.root, command: ['/bin/sh'] })).message) as { pane: string };
  const panesBefore = (await mcp.rows()).map((row) => row.pane);

  const typed = await mcp.call('els_do', { address: other.pane, text: 'MCP_DENIED_7' });
  expect(typed.error?.code).toBe(-32001);
  expect(typed.error?.data?.reason).toContain('not in control-allow.json');
  expect((await mcp.call('els_read', { address: other.pane })).error?.code).toBe(-32001);
  expect((await mcp.call('els_new', { ws: 'other', cwd: mcp.root, command: ['sh'] })).error?.code).toBe(-32001);
  // Inside the allowed workspace but off the argv allowlist: denied at the door front, nothing spawned.
  const argv = await mcp.call('els_new', { ws: 'proj', cwd: mcp.root, command: ['bash', '-c', 'echo spawned-by-mcp'] });
  expect(argv.error?.code).toBe(-32001);
  expect(argv.error?.data?.reason).toContain('not on the allowlist');
  // A principal that is not in control-allow.json at all gets nothing, not even a listing.
  const stranger = await mcpClient(server, 'stranger');
  expect((await stranger.call('els_ls')).error?.code).toBe(-32001);

  expect((await mcp.rows()).map((row) => row.pane)).toEqual(panesBefore);
  // The OP-side read proves the denied line never reached the PTY: a line sent afterwards by the OP is on screen, the denied one never was.
  await requestEls(mcp.socket, { op: 'do', pane: other.pane, text: 'AFTER_7', from: 'OP' });
  const screen = await until(async () => { const text = (await requestEls(mcp.socket, { op: 'read', pane: other.pane })).message; return text.includes('⇢ OP · AFTER_7') ? text : undefined; }, 'the OP line on the other pane');
  expect(screen).not.toContain('MCP_DENIED_');

  const denied = mcp.audit().filter((entry) => entry.principal === 'mcp-stdio:real' && entry.result === 'denied').map((entry) => entry.action);
  expect(denied).toEqual(['do', 'read', 'new', 'new']);
  expect(mcp.audit().some((entry) => entry.principal === 'mcp-stdio:real' && entry.action === 'do' && entry.result === 'executing')).toBe(false);
  expect(mcp.audit().every((entry) => entry.text === undefined)).toBe(true);
}, TEST_MS);
