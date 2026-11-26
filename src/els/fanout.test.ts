import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driveQueue, fillSlots, gatherRows, loadRecord, observe, parseDuration, parseOver, planFanout, saveRecord, shellQuote, stripScreenHeader, substitute, waitAll,
  type FanoutRecord, type LaunchFn, type ListedPane } from './fanout.js';

const plan = (items: string[], max?: number): FanoutRecord => planFanout({ runId: 'fan-t-1', ws: 'fan-demo', template: 'echo {item} #{i}', cwd: '/w', items, now: 1000, ...(max ? { max } : {}) });

/** A fake owner: `new` hands out p1, p2, …; a refusal can be scripted for one title. */
function fakeOwner(refuse?: string): { launch: LaunchFn; launched: string[] } {
  const launched: string[] = [];
  return { launched, launch: async (item) => {
    if (item.title === refuse) return { exitCode: 1, message: 'els new: denied — no tool rule grants new for this workspace' };
    launched.push(item.title);
    return { exitCode: 0, message: JSON.stringify({ pane: `p${item.i}`, address: `fan-demo/t${item.i}/p${item.i}` }) };
  } };
}

test('substitution: {item} is single-quoted (CJK, quote, $() literal), {i} is the 1-based index', () => {
  expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  expect(substitute('echo {item} {i} {item}', '사과 배', 2)).toBe(`echo '사과 배' 2 '사과 배'`);
  expect(substitute('echo {item}', '$(whoami)', 1)).toBe(`echo '$(whoami)'`);
  expect(substitute('echo {item}', "it's", 3)).toBe(`echo 'it'\\''s'`);
  expect(substitute('echo {other}', 'x', 1)).toBe('echo {other}');
});

test('plan: tabs named «FAN·i» by default, «AG·i» with a prefix; --over file lines or a count', () => {
  expect(plan(['a', 'b']).items.map((it) => [it.title, it.command, it.state])).toEqual([['FAN·1', "echo 'a' #1", 'queued'], ['FAN·2', "echo 'b' #2", 'queued']]);
  expect(planFanout({ runId: 'r', ws: 'w', prefix: 'AG', template: 'x', cwd: '/', items: ['a'], now: 0 }).items[0]!.title).toBe('AG·1');
  expect(parseOver('items.txt', () => 'apple\r\n\n사과\n')).toEqual({ ok: true, items: ['apple', '사과'] });
  expect(parseOver('3', () => undefined)).toEqual({ ok: true, items: ['1', '2', '3'] });
  expect(parseOver('nope', () => undefined).ok).toBe(false);
  expect(parseDuration('10m')).toBe(600000);
  expect(parseDuration('90s')).toBe(90000);
  expect(parseDuration('bad')).toBeUndefined();
  expect(stripScreenHeader('[screen 80x24 cursor=(row 2, col 0, visible true)]\nitem a\n')).toBe('item a\n');
});

test('K-limit queue: 6 items --max 3 start 3, then one more per exit, until none is queued', async () => {
  const record = plan(['a', 'b', 'c', 'd', 'e', 'f'], 3);
  const owner = fakeOwner();
  await fillSlots(record, 0, owner.launch, () => 2000);
  expect(owner.launched).toEqual(['FAN·1', 'FAN·2', 'FAN·3']);
  let push: (panes: ListedPane[]) => void = () => {};
  const done = driveQueue(record, { launch: owner.launch, save: () => {}, now: () => 3000, subscribe: (onList) => { push = onList; return { close: () => {} }; } });
  push([{ pane: 'p1', state: 'exited', exit: { code: 0 } }, { pane: 'p2', state: 'working' }, { pane: 'p3', state: 'working' }]);
  await Bun.sleep(5);
  expect(owner.launched).toEqual(['FAN·1', 'FAN·2', 'FAN·3', 'FAN·4']);
  push([{ pane: 'p1', state: 'exited' }, { pane: 'p2', state: 'exited', exit: { code: 0 } }, { pane: 'p3', state: 'exited', exit: { code: 1 } }, { pane: 'p4', state: 'working' }]);
  expect(await done).toEqual({ ok: true });
  expect(owner.launched).toEqual(['FAN·1', 'FAN·2', 'FAN·3', 'FAN·4', 'FAN·5', 'FAN·6']);
});

test('a door refusal is kept verbatim on the item and nothing is bypassed', async () => {
  const record = plan(['a', 'b'], 2);
  const owner = fakeOwner('FAN·2');
  await fillSlots(record, 0, owner.launch, () => 1);
  expect(record.items.map((it) => it.state)).toEqual(['launched', 'launch-failed']);
  expect(record.items[1]!.error).toBe('els new: denied — no tool rule grants new for this workspace');
});

test('gather: mixed exit codes → exited / failed / running / queued with durations and last N lines', async () => {
  const record = plan(['ok', 'bad', 'slow', 'later'], 3);
  await fillSlots(record, 0, fakeOwner().launch, () => 1000);
  observe(record, [{ pane: 'p1', state: 'exited', exit: { code: 0 } }, { pane: 'p2', state: 'exited', exit: { code: 7, tail: ['boom'] } }, { pane: 'p3', state: 'working' }], 4000);
  const screens: Record<string, string> = { p1: 'l1\nl2\nl3\n\n', p3: '진행 중\n' };
  const rows = await gatherRows(record, { tail: 2, now: 6000, readFile: () => undefined, readScreen: async (pane) => screens[pane] });
  expect(rows.map((r) => [r.i, r.status, r.exitCode, r.durationMs, r.output])).toEqual([
    [1, 'exited', 0, 3000, ['l2', 'l3']],
    [2, 'failed', 7, 3000, ['boom']],
    [3, 'running', null, 5000, ['진행 중']],
    [4, 'queued', null, null, []],
  ]);
  const files = await gatherRows(record, { tail: 2, now: 6000, file: '/o/out-{i}.txt', readFile: (p) => (p === '/o/out-1.txt' ? 'answer one\n' : undefined), readScreen: async () => undefined });
  expect(files[0]!.output).toEqual(['answer one']);
  expect(files[0]!.outputSource).toBe('file');
});

test('wait: a timeout returns partial (complete false) with the running tab still running', async () => {
  const record = plan(['a', 'b'], 2);
  await fillSlots(record, 0, fakeOwner().launch, () => 0);
  const result = await waitAll(record, { save: () => {}, now: () => 10, timeoutMs: 30, // 출처: #40227 timeout-partial fixture
    subscribe: (onList) => { onList([{ pane: 'p1', state: 'exited', exit: { code: 0 } }, { pane: 'p2', state: 'working' }]); return { close: () => {} }; } });
  expect(result).toEqual({ complete: false, reason: 'timeout' });
  expect(record.items.map((it) => it.done?.code ?? 'running')).toEqual([0, 'running']);
});

test('run records persist on disk: a fresh load (another shell, after reattach) sees launches and exit stamps', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fanout-'));
  try {
    const record = plan(['a'], 1);
    await fillSlots(record, 0, fakeOwner().launch, () => 5);
    observe(record, [], 9);   // the owner forgot the pane → stamped from what we saw
    saveRecord(root, record);
    const again = loadRecord(root, 'fan-t-1')!;
    expect(again.items[0]).toEqual({ ...record.items[0]!, done: { code: null, endedAt: 9, tail: [] } });
    expect(loadRecord(root, '../etc')).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
