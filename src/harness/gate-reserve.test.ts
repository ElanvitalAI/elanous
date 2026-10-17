import { expect, test } from 'bun:test';
import { detectReleaseGateActive, gateReserve } from './gate-reserve.js';

const gate = { pid: 42, status: 'running', path: ['version-release', 'gate'], currentNode: { nodeId: 'gate' },
  nodes: [{ nodeId: 'version-release', ok: true }] };
const probe = (run: unknown, command = '42 bun /repo/bin/elanous.mjs release run --version 0.2.28') => ({
  processes: () => command,
  runsRoot: '/isolated', list: () => ['release.json'], modifiedAt: () => Date.now(), read: () => JSON.stringify(run),
});

test('active release run or resume at the gate stage is detected from argv and its own run', async () => {
  for (const command of ['42 bun /repo/bin/elanous.mjs release run --version 0.2.28',
    '42 bun /repo/bin/elanous.mjs --test release resume --run run-1 --from gate']) {
    expect(await detectReleaseGateActive(probe(gate, command))).toBe(true);
  }
  expect(gateReserve({ releaseGateActive: true, seat: 'TC', configuredGateCap: 4 })).toEqual({ active: true, wouldCap: 3 });
  expect(gateReserve({ releaseGateActive: true, seat: 'OP', configuredGateCap: 0 })).toEqual({ active: true, wouldCap: 0 });
});

test('inactive gate, unrelated pid, or completed gate does not signal activity', async () => {
  expect(await detectReleaseGateActive(probe({ ...gate, path: ['version-release'] }))).toBe(false);
  expect(await detectReleaseGateActive(probe(gate, '43 bun /repo/bin/elanous.mjs release run --version 0.2.28'))).toBe(false);
  expect(await detectReleaseGateActive(probe({ ...gate, nodes: [...gate.nodes, { nodeId: 'gate', ok: true }] }))).toBe(false);
  expect(await detectReleaseGateActive({ ...probe(gate), list: () => ['broken.json', 'release.json'],
    read: (path) => path.endsWith('broken.json') ? '{' : JSON.stringify(gate) })).toBe(true);
  expect(gateReserve({ releaseGateActive: false, seat: 'TC', configuredGateCap: 4 })).toEqual({ active: false, wouldCap: 4 });
});

test('unavailable process or run measurement fails open to the existing gate cap', async () => {
  expect(await detectReleaseGateActive({ ...probe(gate), processes: () => { throw Error('ps unavailable'); } })).toBe(false);
  expect(await detectReleaseGateActive({ ...probe(gate), read: () => { throw Error('run unavailable'); } })).toBe(false);
  expect(await detectReleaseGateActive({ ...probe(gate), list: () => { throw Error('ledger unavailable'); } })).toBe(false);
  expect(gateReserve({ releaseGateActive: false, seat: 'MK', configuredGateCap: 2 })).toEqual({ active: false, wouldCap: 2 });
});

test('ledger probe reads at most the recent 32 files', async () => {
  let reads = 0;
  const files = Array.from({ length: 64 }, (_, index) => `${String(index).padStart(2, '0')}.json`);
  const active = await detectReleaseGateActive({ ...probe({ ...gate, pid: 99 }), list: () => files,
    modifiedAt: (path) => Number(path.match(/(\d+)\.json$/)?.[1] ?? 0),
    read: async () => { reads++; return JSON.stringify({ ...gate, pid: 99 }); } });
  expect(active).toBe(false);
  expect(reads).toBe(32);
});

test('newest ledger is selected by modified time even when more than 512 names precede it', async () => {
  const files = ['active.json', ...Array.from({ length: 600 }, (_, index) => `${String(index).padStart(3, '0')}.json`)];
  const observed = await detectReleaseGateActive({ ...probe(gate), list: () => files,
    modifiedAt: (path) => path.endsWith('active.json') ? 10_000 : 1,
    read: (path) => JSON.stringify(path.endsWith('active.json') ? gate : { ...gate, pid: 99 }) });
  expect(observed).toBe(true);
});

test('deadline applies while awaiting process, directory, metadata and ledger reads', async () => {
  const base = probe(gate);
  for (const stage of ['processes', 'list', 'modifiedAt', 'read'] as const) {
    let entered = false;
    const slow = async <T>(value: T): Promise<T> => { entered = true; await Bun.sleep(80); return value; };
    const delayed = stage === 'processes' ? { processes: () => slow(base.processes()) }
      : stage === 'list' ? { list: () => slow(base.list()) }
      : stage === 'modifiedAt' ? { modifiedAt: () => slow(Date.now()) }
      : { read: () => slow(base.read()) };
    expect(await detectReleaseGateActive({ ...base, ...delayed, timeoutMs: 20 })).toBe(false);
    expect(entered).toBe(true);
  }
});
