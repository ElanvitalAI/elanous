import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as seatRegistry from './seat-registry.js';
import { normalizeSeatRegistryV1Entry, readSeatRegistryV2, type SeatRegistryEntry } from './seat-registry.js';
import { messageReplyBodyFor, resolveWake, seatDeliveryView, wakeRecipient } from './msg-wake.js';
import { registerMsgCommands } from '../cli/msg-cli.js';
import { Command } from 'commander';

const v1 = (wake: SeatRegistryEntry['wake'], extra: Partial<SeatRegistryEntry> = {}): SeatRegistryEntry => ({
  address: 'RES', host: 'local', wake, replyBody: 'agent', optIn: false, ...extra,
});

test('v1 wake=none reads as eln queue, not a dead delivery', () => {
  expect(normalizeSeatRegistryV1Entry(v1('none'))).toEqual({
    address: 'RES', host: 'local', runtime: 'eln', delivery: 'queue', replyBody: 'agent', optIn: false,
  });
  expect(normalizeSeatRegistryV1Entry(v1('herdr', { target: 'wJ:p1', optIn: true }))).toMatchObject({
    runtime: 'external-cli', delivery: 'adapter', session: 'wJ:p1',
  });
  // A no-inject v1 wake must not become adapter without a session. The v2 parser rejects that shape.
  expect(normalizeSeatRegistryV1Entry(v1('none', { target: 'wJ:p9' }))).toEqual({
    address: 'RES', host: 'local', runtime: 'eln', delivery: 'queue', replyBody: 'agent', optIn: false,
  });
});

test('v2 parser rejects agent delivery=none and accepts a human parked seat', () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-reg-v2-'));
  const path = join(root, 'seat-registry.json');
  try {
    writeFileSync(path, JSON.stringify({
      version: 2,
      seats: [{ address: 'RES', host: 'local', runtime: 'eln', delivery: 'none', replyBody: 'agent', optIn: false }],
    }));
    expect(readSeatRegistryV2(path)).toMatchObject({ status: 'invalid' });
    writeFileSync(path, JSON.stringify({
      version: 2,
      seats: [
        { address: 'RES', host: 'local', runtime: 'eln', delivery: 'queue', replyBody: 'agent', optIn: false },
        { address: 'CROWN', host: 'local', runtime: 'human', delivery: 'parked', replyBody: 'none', optIn: false },
      ],
    }));
    const ready = readSeatRegistryV2(path);
    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') return;
    expect(ready.registry.seats.map(row => row.delivery)).toEqual(['queue', 'parked']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('v1 registry file normalizes through the v2 reader', () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-reg-v1-'));
  const path = join(root, 'seat-registry.json');
  try {
    writeFileSync(path, JSON.stringify({
      version: 1,
      seats: [{ address: 'OP', host: 'local', wake: 'none', replyBody: 'agent', optIn: false }],
    }));
    const ready = readSeatRegistryV2(path);
    expect(ready).toMatchObject({
      status: 'ready',
      registry: { version: 2, seats: [{ address: 'OP', runtime: 'eln', delivery: 'queue' }] },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a non-string session is invalid instead of being dropped', () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-reg-session-'));
  const path = join(root, 'seat-registry.json');
  try {
    writeFileSync(path, JSON.stringify({
      version: 2,
      seats: [{ address: 'RES', host: 'local', runtime: 'eln', delivery: 'queue', session: 123, replyBody: 'agent', optIn: false }],
    }));
    expect(readSeatRegistryV2(path)).toMatchObject({ status: 'invalid', reason: expect.stringContaining('session must be a string') });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a v2 registry seat routes host and reply without a local pane census', () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-reg-route-'));
  const path = join(root, 'seat-registry.json');
  try {
    writeFileSync(path, JSON.stringify({
      version: 2,
      seats: [
        { address: 'RES', host: 'lab-a', runtime: 'eln', delivery: 'queue', replyBody: 'agent', optIn: false },
        { address: 'MK', host: 'lab-b', runtime: 'external-cli', delivery: 'adapter', session: 'wJ:p1', replyBody: 'rules', optIn: true },
      ],
    }));
    const deps = {
      registryPath: path,
      listHerdrPanes: () => { throw new Error('v2 route must not census local panes'); },
    };
    expect(resolveWake('RES', deps)).toMatchObject({ wake: 'sse', source: 'seat-registry', host: 'lab-a', optIn: false });
    expect(resolveWake('MK', deps)).toEqual({ wake: 'herdr', target: 'wJ:p1', source: 'seat-registry', host: 'lab-b', optIn: true });
    expect(messageReplyBodyFor('RES', deps)).toBe('agent');
    expect(messageReplyBodyFor('MK', deps)).toBe('rules');
    expect(seatDeliveryView('RES', deps)).toEqual({ runtime: 'eln', delivery: 'queue' });
    expect(seatDeliveryView('MK', deps)).toEqual({ runtime: 'external-cli', delivery: 'adapter', session: 'wJ:p1' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('external-cli queue routes with no injection, and a human adapter never injects', () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-reg-human-'));
  const path = join(root, 'seat-registry.json');
  try {
    writeFileSync(path, JSON.stringify({
      version: 2,
      seats: [
        { address: 'CLI', host: 'lab-c', runtime: 'external-cli', delivery: 'queue', replyBody: 'agent', optIn: false },
        { address: 'CROWN', host: 'lab-d', runtime: 'human', delivery: 'adapter', session: 'wJ:p2', replyBody: 'none', optIn: true },
      ],
    }));
    const deps = { registryPath: path, listHerdrPanes: () => { throw new Error('no-inject route must not census'); } };
    const ready = readSeatRegistryV2(path);
    expect(ready.status).toBe('ready');
    expect(resolveWake('CLI', deps)).toMatchObject({ wake: 'sse', source: 'seat-registry', host: 'lab-c', optIn: false });
    expect(resolveWake('CLI', deps).target).toBeUndefined();
    expect(resolveWake('CROWN', deps)).toMatchObject({ wake: 'sse', source: 'seat-registry', host: 'lab-d', optIn: false });
    expect(resolveWake('CROWN', deps).target).toBeUndefined();
    expect(seatDeliveryView('CLI', deps)).toEqual({ runtime: 'external-cli', delivery: 'queue' });
    expect(seatDeliveryView('CROWN', deps)).toEqual({ runtime: 'human', delivery: 'adapter', session: 'wJ:p2' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an injected v1 registry and the route command share one snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-reg-inject-'));
  const path = join(root, 'seat-registry.json');
  try {
    const injected = {
      status: 'ready' as const,
      registry: {
        version: 1 as const,
        seats: [{ address: 'RES', host: 'lab-a', wake: 'none' as const, replyBody: 'agent' as const, optIn: false }],
      },
    };
    writeFileSync(path, JSON.stringify({
      version: 2,
      seats: [
        { address: 'RES', host: 'lab-a', runtime: 'eln', delivery: 'queue', replyBody: 'agent', optIn: false },
        { address: 'CROWN', host: 'lab-d', runtime: 'human', delivery: 'adapter', session: 'wJ:p2', replyBody: 'none', optIn: true },
      ],
    }));
    const deps = { registryPath: path, readRegistry: () => injected, listHerdrPanes: () => { throw new Error('injected route must not census'); } };
    expect(resolveWake('RES', deps)).toMatchObject({ wake: 'none', reason: 'registry-wake-disabled', host: 'lab-a' });
    expect(seatDeliveryView('RES', deps)).toEqual({ runtime: 'eln', delivery: 'queue' });

    const lines: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerMsgCommands(program, { out: { log: (line: string) => lines.push(line), error: () => {} }, wakeDeps: { registryPath: path, listHerdrPanes: () => [] } });
    let reads = 0;
    const realRead = seatRegistry.registryFileRead.read;
    seatRegistry.registryFileRead.read = (file: string) => { reads += 1; return realRead(file); };
    try { await program.parseAsync(['node', 'eln', 'msg', 'route', 'RES']); }
    finally { seatRegistry.registryFileRead.read = realRead; }
    expect(reads).toBe(1);
    expect(lines.join('\n')).toContain('wake=sse');
    expect(lines.join('\n')).not.toContain('registry-wake-disabled');
    expect(lines.join('\n')).toContain('runtime=eln');
    expect(lines.join('\n')).toContain('delivery=queue');
    expect(lines.join('\n')).toContain('host=lab-a');

    const woken = await wakeRecipient('CROWN', 1, { from: 'OP' }, {
      registryPath: path, listHerdrPanes: () => { throw new Error('human adapter must not inject'); }, live: true,
    });
    expect(woken.result).toBe('none-sse');
    expect(woken.wake).toBe('sse');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
