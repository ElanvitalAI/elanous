import { describe, expect, test } from 'bun:test';
import { dispatchHeavyCheck, resolveGateRemoteSettings, type GateRemoteRunner } from '../self-implement/gate-remote.js';

// PREGATE-HOST-BALANCE: an unnamed `self gate --remote` goes to the guardian's routed host (route.json); an explicit host or
// no fresh route keeps the old choice (gateRemote.host).
const HEAD = 'a'.repeat(40); const MAIN = 'b'.repeat(40);
function runner(): GateRemoteRunner & { hosts: string[] } {
  const hosts: string[] = [];
  return {
    hosts,
    local(_cmd, args) {
      if (args[0] === 'status') return { rc: 0, stdout: '', stderr: '' };
      if (args[0] === 'cat-file') return { rc: 0, stdout: 'commit\n', stderr: '' };
      if (args[0] === 'rev-parse') return { rc: 0, stdout: `${args.at(-1)!.startsWith('HEAD') ? HEAD : MAIN}\n`, stderr: '' };
      return { rc: 0, stdout: '', stderr: '' };
    },
    ssh(host) { hosts.push(host); return { rc: 98, stdout: '', stderr: '__GATE_REMOTE_BUSY=3\n' }; },
  };
}

describe('PREGATE-HOST-BALANCE — self gate --remote follows the guardian route', () => {
  const settings = resolveGateRemoteSettings({ hostCaps: { 'node-b': 6, 'node-c': 3 }, slotWaitSeconds: 0 }, {});
  const run = async (remote: true | string, routed: string | null) => {
    const r = runner();
    await dispatchHeavyCheck({ tool: 'self-gate', repo: '/r', flags: { local: false, remote }, explicitRemoteOnly: true, remoteArgv: ['x'], runLocal: () => { throw new Error('local gate must not run'); } },
      { runner: r, settings, env: {}, load1: 1, write: { out: () => {}, err: () => {} }, routeHost: () => routed });
    return r.hosts;
  };
  test('unnamed --remote → routed host', async () => { expect((await run(true, 'node-c'))[0]).toBe('node-c'); });
  test('explicit host wins over the route', async () => { expect((await run('node-b', 'node-c'))[0]).toBe('node-b'); });
  test('no fresh route → gateRemote.host', async () => { expect((await run(true, null))[0]).toBe(settings.host); });
  test('an invalid routed name is ignored', async () => { expect((await run(true, '-oProxyCommand=x'))[0]).toBe(settings.host); });
});
