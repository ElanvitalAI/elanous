import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childPrompt, parseOver, parseWorkers, reduceLocal, runMap, voteLabel, type ChildRunner, type MapChildResult } from './map.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'orc-test-'));
const kid = (n: number, text: string, ok = true): MapChildResult => ({ n, item: `i${n}`, worker: 'sim', ok, attempts: 1, code: ok ? 0 : 1, durationMs: 1, pane: 'headless', text });

describe('orchestrate map inputs', () => {
  test('--over N makes N shards; files are JSON arrays or lines', () => {
    expect(parseOver('3')).toEqual(['shard 1 of 3', 'shard 2 of 3', 'shard 3 of 3']);
    const d = tmp();
    writeFileSync(join(d, 'a.json'), '["x","y"]');
    writeFileSync(join(d, 'b.txt'), 'one\n\ntwo\n');
    expect(parseOver(join(d, 'a.json'))).toEqual(['x', 'y']);
    expect(parseOver(join(d, 'b.txt'))).toEqual(['one', 'two']);
    expect(() => parseOver('0')).toThrow('between 1 and 100');
    expect(() => parseOver(join(d, 'missing'))).toThrow('no file');
  });
  test('--workers rotation with counts; unknown worker refused', () => {
    expect(parseWorkers('eln:2,claude')).toEqual(['eln', 'eln', 'claude']);
    expect(() => parseWorkers('gpt')).toThrow('unknown worker «gpt»');
  });
  test('prompt fills {item} or appends the item', () => {
    expect(childPrompt('Rate {item} ({n}/{total})', 'tea', 2, 5)).toBe('Rate tea (2/5)');
    expect(childPrompt('Rate it', 'tea', 1, 1)).toContain('Item 1 of 1: tea');
  });
});

describe('reducers', () => {
  test('vote label from VERDICT line, else last line', () => {
    expect(voteLabel('blah\nVERDICT: **Yes**\n')).toBe('Yes');
    expect(voteLabel('a\nno\n')).toBe('no');
  });
  test('vote majority, tie, consensus two thirds, failed children ignored', () => {
    const kids = [kid(1, 'VERDICT: yes'), kid(2, 'VERDICT: YES'), kid(3, 'VERDICT: no'), kid(4, 'VERDICT: no', false)];
    expect(reduceLocal('vote', kids)).toMatchObject({ label: 'yes', output: expect.stringContaining('Majority: yes (2/3)') });
    expect(reduceLocal('consensus', kids)).toMatchObject({ label: 'yes' });
    expect(reduceLocal('consensus', [kid(1, 'VERDICT: a'), kid(2, 'VERDICT: b'), kid(3, 'VERDICT: a'), kid(4, 'VERDICT: b')])).toMatchObject({ label: 'no consensus' });
    expect(reduceLocal('vote', [kid(1, 'VERDICT: a'), kid(2, 'VERDICT: b')])).toMatchObject({ label: 'tie' });
    expect(reduceLocal('concat', kids).output).toContain('## 1. i1 (sim)');
  });
});

describe('runMap', () => {
  const ok: ChildRunner = async (s) => ({ code: 0, text: `answer ${s.item}\nVERDICT: go`, pane: 'headless', durationMs: 5 });
  test('fans out, never exceeds max-parallel, writes result, receipt and stage feed', async () => {
    let live = 0, peak = 0;
    const runChild: ChildRunner = async (s, c) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 20)); live--; return ok(s, c); };
    const r = await runMap({ task: 't', items: ['a', 'b', 'c', 'd', 'e'], workers: ['eln', 'codex', 'claude'], reducer: 'consensus', maxParallel: 2, outDir: tmp(), id: 'T1', runChild, log: () => {} });
    expect(peak).toBe(2);
    expect(r).toMatchObject({ ok: 5, failed: 0, items: 5, workers: { eln: 2, codex: 2, claude: 1 }, reduce: { label: 'go', partial: false } });
    const feed = readFileSync(r.paths.feed, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { phase: string; nodes: unknown[]; consensus?: { label: string } });
    expect(feed.map((f) => f.phase)).toContain('spawn');
    expect(feed.at(-1)).toMatchObject({ phase: 'receipt', consensus: { label: 'go' } });
    expect(feed.at(-1)!.nodes).toHaveLength(5);
    expect(JSON.parse(readFileSync(r.paths.receipt, 'utf8'))).toMatchObject({ schema: 'orchestrate.map/1', id: 'T1' });
    expect(readFileSync(r.paths.result, 'utf8')).toContain('5/5 children answered');
  });
  test('timeout retries once, then a partial reduce lists the failure', async () => {
    const seen: string[] = [];
    const runChild: ChildRunner = async (s, c) => { seen.push(`${s.n}:${s.attempt}`); return s.item === 'slow' ? { code: 124, text: '', pane: 'headless', durationMs: 1, error: 'timed out after 1s' } : ok(s, c); };
    const r = await runMap({ task: 't', items: ['a', 'slow', 'c'], workers: ['sim'], reducer: 'vote', outDir: tmp(), runChild, log: () => {} });
    expect(seen.filter((x) => x.startsWith('2:'))).toEqual(['2:1', '2:2']);
    expect(r).toMatchObject({ ok: 2, failed: 1, failures: [{ n: 2, item: 'slow', error: 'timed out after 1s' }], reduce: { partial: true, label: 'go' } });
    expect(readFileSync(r.paths.result, 'utf8')).toContain('## Failures');
  });
  test('a missing worker CLI fails fast without retry (real runner)', async () => {
    const old = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      const r = await runMap({ task: 't', items: ['a'], workers: ['codex'], reducer: 'concat', outDir: tmp(), log: () => {} });
      expect(r.children[0]).toMatchObject({ ok: false, attempts: 1, code: 127, error: 'worker CLI «codex» not on PATH' });
    } finally { process.env.PATH = old; }
  });
  test('the parallel cap is refused above 6', async () => {
    await expect(runMap({ task: 't', items: ['a'], workers: ['sim'], reducer: 'concat', maxParallel: 7, outDir: tmp(), runChild: ok, log: () => {} })).rejects.toThrow('the cap is 6');
  });
  test('els refusal falls back to headless and says so', async () => {
    const runChild: ChildRunner = async (s, c) => c.els ? { code: 0, text: 'x\nVERDICT: go', pane: 'headless', durationMs: 1, elsError: 'els new: denied — verified tool seat required' } : ok(s, c);
    const r = await runMap({ task: 't', items: ['a', 'b'], workers: ['sim'], reducer: 'concat', maxParallel: 1, outDir: tmp(), runChild, els: { cli: ['true'], env: {}, ws: 'w' }, log: () => {} });
    expect(r.mode).toBe('headless');
    expect(r.modeNote).toContain('verified tool seat required');
  });
  test('abort cancels the rest, closes opened tabs, reduces what answered', async () => {
    const ctl = new AbortController();
    const runChild: ChildRunner = async (s, c) => {
      c.onTab(`tab-${s.n}`);
      if (s.n === 2) { ctl.abort(); return { code: 130, text: '', pane: 'els:w/x', durationMs: 1, error: 'cancelled' }; }
      return ok(s, c);
    };
    const r = await runMap({ task: 't', items: ['a', 'b', 'c', 'd'], workers: ['sim'], reducer: 'concat', maxParallel: 1, outDir: tmp(), runChild, signal: ctl.signal, els: { cli: ['true'], env: {}, ws: 'w' }, log: () => {} });
    expect(r).toMatchObject({ cancelled: true, ok: 1 });
    expect(r.failures.map((f) => f.error)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  });
  test('sim workers through the real child runner (headless bash)', async () => {
    const r = await runMap({ task: 't', items: ['a', 'b'], workers: ['sim'], reducer: 'vote', outDir: tmp(), timeoutMs: 15_000, log: () => {},
      sim: (item, _n, attempt) => item === 'b' && attempt === 1 ? { text: 'boom', delayMs: 50, exit: 3 } : { text: `ok ${item}\nVERDICT: fine`, delayMs: 50 } });
    expect(r).toMatchObject({ ok: 2, reduce: { label: 'fine' } });
    expect(r.children[1]).toMatchObject({ attempts: 2, ok: true });
  });
});
