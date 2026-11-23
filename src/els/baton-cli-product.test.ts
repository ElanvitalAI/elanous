import { expect, test } from 'bun:test';
import { simCli } from '../ux-sim/in-process-cli.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startElsServer } from './server.js';

test.skipIf(process.platform !== 'darwin')('product CLI baton hand/status/return/take and invalid TTL reach the server', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ebcli-'));
  let peer = 'OP';
  const started = await startElsServer({ stateRoot: root, seatLookup: async () => ({ pane: 'test-peer', seat: peer }), stall: false });
  if ('exitCode' in started) throw new Error(started.message);
  const cli = async (...args: string[]) => {
    const result = await simCli(['side', 'baton', ...args], {
      mode: 'spawn', injectTestFlag: false, stateRoot: root,
      allowPaths: [['side', 'baton']],
    });
    return { code: result.exitCode, out: result.stdout, err: result.stderr };
  };
  try {
    const denied = await cli('hand', 'OP', '--to', 'TC', '--reason', 'restart', '--ttl', 'bogus');
    expect(denied.code).toBe(1);
    expect(denied.err).toContain('baton');
    expect(JSON.parse((await cli('status')).out)).toBeNull();
    const issued = await cli('hand', 'OP', '--to', 'TC', '--reason', 'restart', '--ttl', '30m');
    expect(issued.code, issued.err).toBe(0);
    expect(JSON.parse(issued.out)).toMatchObject({ owner: 'OP', acting: 'TC', reason: 'restart' });
    expect(JSON.parse((await cli('status')).out)).toMatchObject({ owner: 'OP', acting: 'TC' });
    peer = 'TC';
    const returned = await cli('return', '--handoff', 'mail 42 handled');
    expect(returned.code, returned.err).toBe(0);
    expect(JSON.parse(returned.out)).toBeNull();
    peer = 'OP';
    const reissued = await cli('hand', 'OP', '--to', 'TC', '--reason', 'restart', '--ttl', '1h');
    expect(reissued.code, reissued.err).toBe(0);
    const taken = await cli('take', 'OP', '--handoff', 'decisions recorded');
    expect(taken.code, taken.err).toBe(0);
    expect(JSON.parse(taken.out)).toBeNull();
    const events = readFileSync(join(root, 'els', 'baton-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(e => [e.action, e.actor])).toEqual([['hand', 'OP'], ['return', 'TC'], ['hand', 'OP'], ['take', 'OP']]);
    expect(events[1].handoff).toBe('mail 42 handled');
    expect(events[3].handoff).toBe('decisions recorded');
  } finally { await started.close(); rmSync(root, { recursive: true, force: true }); }
}, 120_000);
