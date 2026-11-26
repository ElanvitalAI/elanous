import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, type PrInfo } from '../land-graph/land-graph.js';
import { parseFocused, readFocused, readReceipt, type RemoteGrep } from './land-graph-cli.js';

// Fixtures = real RES pregate.py GREEN-lane receipt dirs (home path sanitized to /Users/op, process lists dropped;
// 39636's rawSha256['focused.raw'] re-hashed after the sanitize). Layout: <PR>-<head12>-<host>/{receipt.json,SUMMARY.json[,focused.raw]}.
const FIX = join(import.meta.dir, 'fixtures', 'land-graph-receipts');
const remoteMissing: RemoteGrep = () => ({ ok: false, stdout: 'RAW-MISSING\n', missing: true });
const remoteDown: RemoteGrep = () => ({ ok: false, stdout: '', missing: false });
const remoteNever: RemoteGrep = () => { throw new Error('remote must not be asked when a local raw exists'); };

describe('pregate receipt reader (real light/full receipt layout)', () => {
  test('receipt.json fields: head, ssh host (not actualHost), focused files, rawDir, focused step exit, raw SHA', () => {
    const r = readReceipt(join(FIX, '39636-125b88e8f22c-node-b'))!;
    expect(r.head).toBe('125b88e8f22c97dca0df7d93f5e03afd93ae9046');
    expect(r.host).toBe('node-b');
    expect(r.rawDir).toBe('/var/folders/6w/lwcnwd3146s1sd01fxn67ggr0000gn/T/res-a161-2sfybtkj');
    expect(r.focusedExit).toBe(0);
    expect(r.focusedSha).toMatch(/^[0-9a-f]{64}$/);
    const red = readReceipt(join(FIX, '39192-d707b9f6643c-minim5'))!;
    expect(red.host).toBe('minim5');
    expect(red.focusedExit).toBe(1);
  });

  test('local focused.raw next to the receipt (SHA match) → bun summary 24 pass 0 fail, no ssh', () => {
    expect(readFocused(readReceipt(join(FIX, '39636-125b88e8f22c-node-b'))!, remoteNever)).toEqual({ pass: 24, fail: 0 });
  });

  test('local copy from another run (SHA mismatch) is ignored', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'lg-rcpt-')), '39636-125b88e8f22c-node-b');
    cpSync(join(FIX, '39636-125b88e8f22c-node-b'), dir, { recursive: true });
    writeFileSync(join(dir, 'focused.raw'), ' 99 pass\n 0 fail\n');
    expect(readFocused(readReceipt(dir)!, remoteMissing)).toEqual({ swept: true, exit: 0 });
  });

  test('raws/ subdir mirror is read', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'lg-rcpt-')), '39636-125b88e8f22c-node-b');
    cpSync(join(FIX, '39636-125b88e8f22c-node-b'), dir, { recursive: true });
    mkdirSync(join(dir, 'raws')); cpSync(join(dir, 'focused.raw'), join(dir, 'raws', 'focused.raw'));
    writeFileSync(join(dir, 'focused.raw'), 'other run\n');
    expect(readFocused(readReceipt(dir)!, remoteNever)).toEqual({ pass: 24, fail: 0 });
  });

  test('host temp rawDir swept: the receipt step exit is what is left (0 → swept pass · 1 → swept fail)', () => {
    expect(readFocused(readReceipt(join(FIX, '40085-e6d2f3e7bf37-minim5'))!, remoteMissing)).toEqual({ swept: true, exit: 0 });
    expect(readFocused(readReceipt(join(FIX, '39192-d707b9f6643c-minim5'))!, remoteMissing)).toEqual({ swept: true, exit: 1 });
  });

  test('host unreachable stays unreadable (the raw may still be there)', () => {
    expect(readFocused(readReceipt(join(FIX, '40085-e6d2f3e7bf37-minim5'))!, remoteDown)).toBe('unreadable');
  });

  test('ssh grep output parses like coach-land.sh', () => {
    const remote: RemoteGrep = () => ({ ok: true, stdout: ' 26 pass\n 0 fail\n', missing: false });
    expect(readFocused(readReceipt(join(FIX, '40085-e6d2f3e7bf37-minim5'))!, remote)).toEqual({ pass: 26, fail: 0 });
    expect(parseFocused('(pass) a > b [1ms]\n\n 3 pass\n 2 fail\n 9 expect() calls\n')).toEqual({ pass: 3, fail: 2 });
    expect(parseFocused('(pass) only names\n')).toBe('unreadable');
  });
});

describe('decide on the read focused result', () => {
  const pr: PrInfo = { number: 40085, head: 'e6d2f3e7bf3707772484e38aac88ed1e3a5eb87c', base: 'main', draft: false, state: 'OPEN', title: 't', author: 'TC', files: ['src/compact/pipeline.ts'] };
  const receipt = readReceipt(join(FIX, '40085-e6d2f3e7bf37-minim5'))!;
  const facts = { pr, receipt, olderReceiptHead: null, hold: null, security: [], landedBefore: false };
  test('readable 0 fail → land', () => {
    expect(decide({ ...facts, focused: { pass: 24, fail: 0 } }).action).toBe('land');
  });
  test('swept exit 0 → wait (re-run pregate) · swept exit 1 → refuse baseline-failing-focused', () => {
    expect(decide({ ...facts, focused: { swept: true, exit: 0 } })).toMatchObject({ action: 'wait', cls: 'focused-unreadable', why: 'focused raw swept (receipt step exit 0) — re-run pregate' });
    expect(decide({ ...facts, focused: { swept: true, exit: 1 } })).toMatchObject({ action: 'refuse', cls: 'baseline-failing-focused', why: 'focused step exit 1 (raw swept)' });
  });
});
