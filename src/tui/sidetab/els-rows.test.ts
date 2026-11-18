import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestEls } from '../../els/client.js';
import { createFederation } from '../../els/federation.js';
import { startElsServer, elsSocketPath } from '../../els/server.js';
import { elsRowsFromList, fetchElsSidetabRows } from './els-rows.js';
import { formatSidetabSectionFrame, groupSidetabSections } from './sections.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const pane = (extra: Record<string, unknown>) => ({ address: 'node-b:w1/t1/p1', workspace: 'OP', tab: 't1', pane: 'p1', title: 'shell', state: 'idle', host: 'node-b', reach: 'local', ...extra });
const list = (panes: object[], hosts: object[] = [{ name: 'node-b', reach: 'local' }]) => JSON.stringify({ hosts, panes });

test('local panes become rows with the status word; an exited pane keeps the process badge', () => {
  const rows = elsRowsFromList(list([pane({ state: 'working', title: 'eln · fix' }), pane({ address: 'node-b:w1/t1/p2', pane: 'p2', state: 'exited' }),
    pane({ address: 'node-b:w1/t1/p3', pane: 'p3', state: 'blocked' })]), 'node-b');
  expect(rows.map((row) => [row.id, row.label, row.badge, row.agentState])).toEqual([
    ['els:node-b:w1/t1/p1', 'eln · fix', 'busy', 'working'],
    ['els:node-b:w1/t1/p2', 'shell', 'exited', undefined],
    ['els:node-b:w1/t1/p3', 'shell', 'idle', 'blocked'],
  ]);
  expect(rows.every((row) => row.kind === 'els' && row.remoteHost === undefined)).toBe(true);
});

test('a remote pane is marked ⇄host; a remote host that does not answer is one ✕ row; this host being down is no row', () => {
  const rows = elsRowsFromList(list(
    [pane({ address: 'minim5:w9/t9/p9', host: 'minim5', reach: 'up', title: '↳ ⎇ harness · review ●', state: 'working' })],
    [{ name: 'node-b', reach: 'down', reason: 'no els server' }, { name: 'minim5', reach: 'up' }, { name: 'aws1', reach: 'down', reason: 'timeout' }]), 'node-b');
  expect(rows.map((row) => [row.label, row.badge, row.remoteHost])).toEqual([
    ['⇄minim5 ↳ ⎇ harness · review ●', 'busy', 'minim5'],
    ['✕ ⇄aws1 · 연결 끊김', 'stale', 'aws1'],
  ]);
});

test('malformed or hostile answers give no rows, never a throw', () => {
  expect(elsRowsFromList('not json', 'node-b')).toEqual([]);
  expect(elsRowsFromList('{"panes":"x","hosts":7}', 'node-b')).toEqual([]);
  // Valid JSON that is not an object at the top level (direct call: the no-throw contract is this function's own).
  for (const body of ['null', '7', '"text"', 'true', '[]', '[null]']) expect(elsRowsFromList(body, 'node-b')).toEqual([]);
  expect(elsRowsFromList(list([{ title: 'no address' }, null as never]), 'node-b')).toEqual([]);
});

test('the Els section exists only while the server lists panes, after the stored section order', () => {
  const only = [{ id: 's', label: 'a', kind: 'tui', badge: 'idle' as const, sessionId: 'x' }];
  expect(groupSidetabSections(only).map((section) => section.id)).toEqual(['sessions']);
  expect(formatSidetabSectionFrame(only, 0, 30, 20).lines.join('\n')).not.toContain('Els');
  const withEls = [...only, ...elsRowsFromList(list([pane({})]), 'node-b')];
  expect(groupSidetabSections(withEls).map((section) => section.id)).toEqual(['sessions', 'els']);
  const frame = formatSidetabSectionFrame(withEls, 1, 30, 20).lines.join('\n');
  expect(frame).toContain('Els · 1');
  expect(frame).toContain('shell');
});

test('real els server: the panel reads its panes, sees a state change, and closing the panel leaves the server and pane running', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-side-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const screens = { text: '' };
  const started = await startElsServer({ stateRoot: root, spawn: () => ({ id: 'pty_1', isAlive: () => true, write: () => {}, renderScreen: async () => screens.text, onExit: () => {}, kill: () => {} }) });
  if ('exitCode' in started) throw new Error(started.message);
  cleanups.push(() => started.close());
  const askLocal = (request: Parameters<typeof requestEls>[1]) => requestEls(elsSocketPath(root), request);
  const deps = (hostFetch?: () => Promise<{ status: number; body: unknown }>) => ({ localHost: 'node-b',
    list: () => createFederation({ localHost: 'node-b', askLocal, registry: { hosts: hostFetch ? [{ name: 'minim5', baseUrl: 'http://100.64.0.2:8790' }] : [], rejected: [] },
      fetchJson: hostFetch ?? (() => Promise.reject(new Error('no remote'))) }).list() });
  expect(await fetchElsSidetabRows(deps())).toEqual([]);
  expect((await askLocal({ op: 'new', ws: 'OP', cwd: '/work', command: ['eln'], title: 'worker' })).exitCode).toBe(0);
  const rows = await fetchElsSidetabRows(deps());
  expect(rows.map((row) => [row.label, row.kind])).toEqual([['worker', 'els']]);
  // A remote that answers is ⇄-marked; one that times out is ✕, and the local row is unaffected.
  const remote = await fetchElsSidetabRows(deps(async () => ({ status: 200, body: { host: 'minim5', panes: [{ ws: 'w1', tab: 't1', pane: 'p1', title: 'away', cwd: '/', state: 'working' }] } })));
  expect(remote.map((row) => row.label)).toEqual(['worker', '⇄minim5 away']);
  const silent = await fetchElsSidetabRows(deps(() => Promise.reject(new Error('timeout'))));
  expect(silent.map((row) => row.label)).toEqual(['worker', '✕ ⇄minim5 · 연결 끊김']);
  // «Closing the panel» = no more polls. The owner and its pane are exactly as they were.
  expect((await askLocal({ op: 'ping' })).exitCode).toBe(0);
  expect((await fetchElsSidetabRows(deps())).map((row) => row.label)).toEqual(['worker']);
});

test('no els server: the panel gets no rows and nothing is started', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-side-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const rows = await fetchElsSidetabRows({ localHost: 'node-b', list: () => createFederation({ localHost: 'node-b', registry: { hosts: [], rejected: [] },
    askLocal: (request) => requestEls(elsSocketPath(root), request), fetchJson: () => Promise.reject(new Error('x')) }).list() });
  expect(rows).toEqual([]);
  expect((await requestEls(elsSocketPath(root), { op: 'ping' })).exitCode).toBe(1);
});
