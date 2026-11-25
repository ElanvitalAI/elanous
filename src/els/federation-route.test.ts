// ELS-REMOTE-TAB stage 1 — the remote-tab route seam (ssh now; relay · vm reserved) and the hosts.json `route` field.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFederation, type RemoteTabRoute } from './federation.js';
import { loadHostRegistry, type FederatedHost } from './hosts.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const viaWindow: FederatedHost = { name: 'box-a', baseUrl: 'http://100.64.0.21:8790' };
const viaRelay: FederatedHost = { name: 'box-r', baseUrl: 'http://100.64.0.22:8790', route: 'relay' };

function fed(routes?: Record<string, RemoteTabRoute>) {
  const posted: { host: string; path: string; payload: unknown }[] = [];
  const federation = createFederation({
    localHost: 'here',
    askLocal: async () => ({ exitCode: 0, message: 'local' }),
    registry: { hosts: [viaWindow, viaRelay], rejected: [] },
    fetchJson: async () => { throw new Error('not used'); },
    postJson: async (host, path, payload) => {
      posted.push({ host: host.name, path, payload });
      return path === '/els/new'
        ? { status: 200, body: { ws: 'w9', tab: 't9', pane: 'p9', address: 'w9/t9/p9' } }
        : { status: 200, body: { message: 'closed p9' } };
    },
    ...(routes ? { routes } : {}),
  });
  return { federation, posted };
}

test('default ssh route: new and close go to the host window as POST /els/new and /els/close', async () => {
  const { federation, posted } = fed();
  const made = await federation.new({ host: viaWindow }, { ws: 'demo', cwd: '/tmp', command: ['eln'] }, 'OP');
  expect(made.exitCode).toBe(0);
  expect(JSON.parse(made.message)).toEqual({ ws: 'w9', tab: 't9', pane: 'p9', address: 'box-a:w9/t9/p9', host: 'box-a' });
  const closed = await federation.close('box-a/p9', 'OP');
  expect(closed).toEqual({ exitCode: 0, message: 'closed p9' });
  expect(posted).toEqual([
    { host: 'box-a', path: '/els/new', payload: { ws: 'demo', cwd: '/tmp', command: ['eln'], from: 'here/OP' } },
    { host: 'box-a', path: '/els/close', payload: { address: 'p9', from: 'here/OP' } },
  ]);
});

test('a host on a route kind with nothing plugged in is refused without any request', async () => {
  const { federation, posted } = fed();
  expect(await federation.new({ host: viaRelay }, { ws: 'demo', cwd: '/tmp', command: ['eln'] }, 'OP'))
    .toEqual({ exitCode: 1, message: 'els new: box-r route relay is not available in this build' });
  expect(await federation.close('box-r/p1', 'OP'))
    .toEqual({ exitCode: 1, message: 'els close: box-r route relay is not available in this build' });
  expect(posted).toEqual([]);
});

test('a plugged-in route of that kind carries new and close (the relay/vm seam)', async () => {
  const calls: string[] = [];
  const relay: RemoteTabRoute = {
    kind: 'relay',
    newPane: async (host, payload) => { calls.push(`new ${host.name} ${payload.ws}`); return { status: 200, body: { pane: 'p5' } }; },
    closePane: async (host, payload) => { calls.push(`close ${host.name} ${payload.address}`); return { status: 404, body: {} }; },
  };
  const { federation, posted } = fed({ relay });
  expect(await federation.new({ host: viaRelay, ws: 'w2' }, { ws: 'demo', cwd: '/tmp', command: ['sh'] }, 'OP'))
    .toEqual({ exitCode: 0, message: '{"pane":"p5"}' });
  expect(await federation.close('box-r/p5', 'OP')).toEqual({ exitCode: 1, message: 'els close: unknown pane box-r/p5' });
  expect(calls).toEqual(['new box-r w2', 'close box-r p5']);
  expect(posted).toEqual([]);
});

test('hosts.json route: ssh is the default, relay and vm are kept, anything else is rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'els-route-'));
  dirs.push(dir);
  const path = join(dir, 'hosts.json');
  writeFileSync(path, JSON.stringify({ hosts: [
    { name: 'plain', baseUrl: 'http://100.64.0.31:8790' },
    { name: 'said-ssh', baseUrl: 'http://100.64.0.32:8790', route: 'ssh' },
    { name: 'relayed', baseUrl: 'http://100.64.0.33:8790', route: 'relay' },
    { name: 'cloud', baseUrl: 'http://100.64.0.34:8790', route: 'vm' },
    { name: 'weird', baseUrl: 'http://100.64.0.35:8790', route: 'carrier-pigeon' },
  ] }));
  const registry = loadHostRegistry(path);
  expect(registry.hosts).toEqual([
    { name: 'plain', baseUrl: 'http://100.64.0.31:8790' },
    { name: 'said-ssh', baseUrl: 'http://100.64.0.32:8790' },
    { name: 'relayed', baseUrl: 'http://100.64.0.33:8790', route: 'relay' },
    { name: 'cloud', baseUrl: 'http://100.64.0.34:8790', route: 'vm' },
  ]);
  expect(registry.rejected).toEqual(['weird: route must be ssh, relay or vm']);
});

test('newTarget: a registered name (and name/ws) is remote; an unknown name is this host', () => {
  const { federation } = fed();
  expect(federation.newTarget('box-a')).toEqual({ host: viaWindow });
  expect(federation.newTarget('box-a/demo')).toEqual({ host: viaWindow, ws: 'demo' });
  expect(federation.newTarget('nobody')).toBeUndefined();
});

test('attachTarget: an ssh host passes through; a relay host is refused behind the seam (no transport chosen)', () => {
  const { federation } = fed();
  expect(federation.attachTarget('box-a/p3')).toEqual({ host: viaWindow, pane: 'p3' });
  expect(federation.attachTarget('box-r/p3')).toEqual({ refused: 'els attach: box-r route relay is not available in this build' });
  expect(federation.attachTarget('p3')).toBeUndefined();
});

test('newTarget is only consulted for the explicit --host value: a plain command word is never a host here', () => {
  const { federation } = fed();
  expect(federation.newTarget('box-r')).toEqual({ host: viaRelay });
  expect(federation.newTarget('box-a/x/y')).toBeUndefined();
});
