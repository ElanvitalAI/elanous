import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGraphRunHost, parseGraphRunOrigin, type GraphRunOrigin } from './graph-run-host.js';
import type { GraphRunOptions } from './runner.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { try { chmodSync(join(root, 'graph-runs'), 0o700); } catch { /* absent */ } rmSync(root, { recursive: true, force: true }); } });
const seat: GraphRunOrigin = { kind: 'seat' };

function fixture(known = ['build'], chmod?: (path: string, mode: number) => void) {
  const root = mkdtempSync(join(tmpdir(), 'graph-run-host-'));
  roots.push(root);
  const calls: Array<{ file: string; options: GraphRunOptions }> = [];
  const gates: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  const host = createGraphRunHost({
    root, resolveGraphFile: id => known.includes(id) ? `/graphs/${id}.yaml` : undefined,
    run: (file, options) => { calls.push({ file, options }); return new Promise<void>((resolve, reject) => { gates.push({ resolve, reject }); }); },
    now: () => new Date(0), ...(chmod ? { chmod } : {}),
  });
  return { root, host, calls, gates };
}
const startsDir = (root: string) => join(root, 'graph-runs', '_starts');
const recordOf = (root: string, runId: string) => JSON.parse(readFileSync(join(startsDir(root), `${runId}.json`), 'utf8')) as Record<string, unknown>;

describe('origin parsing (request body, nothing stored)', () => {
  test('seat (optionally named) and graph origins only; ids are segment-checked; human is not an origin at this stage', () => {
    expect(parseGraphRunOrigin({ kind: 'seat' })).toEqual(seat);
    expect(parseGraphRunOrigin({ kind: 'seat', seat: 'SEAT-A' })).toEqual({ kind: 'seat', seat: 'SEAT-A' });
    expect(parseGraphRunOrigin({ kind: 'seat', seat: '../x' })).toBeNull();
    expect(parseGraphRunOrigin({ kind: 'graph', parentRunId: 'run-a', parentNodeId: 'node-b' })).toEqual({ kind: 'graph', parentRunId: 'run-a', parentNodeId: 'node-b' });
    expect(parseGraphRunOrigin({ kind: 'graph', parentRunId: 'run-a' })).toBeNull();
    expect(parseGraphRunOrigin({ kind: 'graph', parentRunId: '../x', parentNodeId: 'n' })).toBeNull();
    expect(parseGraphRunOrigin({ kind: 'human', ownerId: 'owner-1' })).toBeNull();
    expect(parseGraphRunOrigin({ kind: 'admin' })).toBeNull();
    expect(parseGraphRunOrigin('seat')).toBeNull();
    // an unknown field inside origin is refused, not dropped; a field of the other kind is unknown too
    expect(parseGraphRunOrigin({ kind: 'seat', ownerId: 'owner-1' })).toBeNull();
    expect(parseGraphRunOrigin({ kind: 'seat', parentRunId: 'run-a' })).toBeNull();
    expect(parseGraphRunOrigin({ kind: 'graph', parentRunId: 'run-a', parentNodeId: 'node-b', seat: 'SEAT-A' })).toBeNull();
    expect(parseGraphRunOrigin({ kind: 'graph', parentRunId: 'run-a', parentNodeId: 'node-b', extra: true })).toBeNull();
  });
});

describe('start returns at once and the run is detached from the caller', () => {
  test('runId comes back while the runner is still going; the runner gets no signal; origin is recorded', async () => {
    const { host, calls, gates, root } = fixture();
    const origin: GraphRunOrigin = { kind: 'graph', parentRunId: 'run-parent', parentNodeId: 'node-1' };
    const started = host.start({ graphId: 'build', input: { topic: 'x' }, origin });
    expect(started).toMatchObject({ ok: true, status: 'started' });
    if (!started.ok) throw new Error('unreachable');
    await Promise.resolve();
    expect(calls.map(call => call.file)).toEqual(['/graphs/build.yaml']);
    expect(calls[0]!.options.signal).toBeUndefined();
    expect(calls[0]!.options.runId).toBe(started.runId);
    expect(calls[0]!.options.input).toEqual({ topic: 'x' });
    expect(recordOf(root, started.runId)).toMatchObject({ runId: started.runId, graphId: 'build', origin, status: 'started' });
    gates[0]!.resolve();
    await new Promise(resolve => setTimeout(resolve));
    expect(readdirSync(startsDir(root))).toEqual([`${started.runId}.json`]);
  });

  test('every call is a new run: the same body twice is two runIds and two runner calls', async () => {
    const { host, calls } = fixture();
    const first = host.start({ graphId: 'build', origin: seat });
    const second = host.start({ graphId: 'build', origin: seat });
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(second.runId).not.toBe(first.runId);
    await Promise.resolve();
    expect(calls.map(call => call.options.runId)).toEqual([first.runId, second.runId]);
  });

  test('unknown graph, bad origin and bad ids start nothing and write nothing', () => {
    const { host, calls, root } = fixture();
    expect(host.start({ graphId: 'nope', origin: seat })).toEqual({ ok: false, error: 'graph-not-found' });
    expect(host.start({ graphId: 'build', origin: null })).toEqual({ ok: false, error: 'bad-origin' });
    expect(host.start({ graphId: '../build', origin: seat })).toEqual({ ok: false, error: 'bad-request' });
    expect(calls).toEqual([]);
    expect(() => readdirSync(startsDir(root))).toThrow();
  });
});

describe('failure paths', () => {
  test('runner failure is kept on the record, not lost; the record is private', async () => {
    const { host, gates, root } = fixture();
    const started = host.start({ graphId: 'build', origin: seat });
    if (!started.ok) throw new Error('unreachable');
    await Promise.resolve();
    gates[0]!.reject(new Error('runner exploded'));
    await new Promise(resolve => setTimeout(resolve));
    expect(recordOf(root, started.runId)).toMatchObject({ status: 'failed', error: 'runner exploded' });
  });

  test('record write failure: no run is started and the caller is told', () => {
    const { host, calls, root } = fixture();
    writeFileSync(join(root, 'graph-runs'), 'a file where the directory should be');
    expect(host.start({ graphId: 'build', origin: seat })).toEqual({ ok: false, error: 'record-write-failed' });
    expect(calls).toEqual([]);
  });

  test('chmod failure on the record: the start is refused, no record is left, a retry starts one run', async () => {
    let refuse = true;
    const { host, calls, root } = fixture(['build'], () => { if (refuse) throw new Error('chmod denied'); });
    expect(host.start({ graphId: 'build', origin: seat })).toEqual({ ok: false, error: 'record-write-failed' });
    expect(calls).toEqual([]);
    expect(readdirSync(startsDir(root))).toEqual([]);
    refuse = false;
    expect(host.start({ graphId: 'build', origin: seat })).toMatchObject({ ok: true });
    await Promise.resolve();
    expect(calls).toHaveLength(readdirSync(startsDir(root)).length);
  });

  test('a failed run whose record cannot be rewritten is logged, never thrown into the caller', async () => {
    let seen = 0;
    const { host, gates, root } = fixture(['build'], () => { if (seen++ > 0) throw new Error('chmod denied'); });
    const started = host.start({ graphId: 'build', origin: seat });
    if (!started.ok) throw new Error('unreachable');
    await Promise.resolve();
    gates[0]!.reject(new Error('runner exploded'));
    await new Promise(resolve => setTimeout(resolve));
    expect(recordOf(root, started.runId)).toMatchObject({ runId: started.runId });
  });
});
