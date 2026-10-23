import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogStore, StoreSink } from '../mss/logging/log-store.js';
import type { LogRecord } from '../mss/logging/record.js';
import type { LogSink } from '../mss/logging/sink.js';
import { processTuiLogTag, setTuiLogName, setTuiLogSession, tagTuiRecord, withTuiLogTag } from './tui-log-tag.js';
import { claimTuiOwnedSession } from '../capture/tui-self-report.js';

const rec = (data?: unknown): LogRecord => ({ ts: new Date().toISOString(), category: 'tui.event-loop', event: 'stall', ...(data === undefined ? {} : { data }) });

afterEach(() => { setTuiLogName(undefined); setTuiLogSession(null); });

describe('tagTuiRecord — TUI-LOG-SESSION-TAG', () => {
  test('plain payload gets pid · name · session', () => {
    const out = tagTuiRecord(rec({ lagMs: 45640 }), { pid: 20960, name: 'n8n', session: () => 'elanous-session-btkl04' });
    expect(out.data).toEqual({ lagMs: 45640, tuiPid: 20960, tuiName: 'n8n', tuiSession: 'elanous-session-btkl04' });
  });
  test('caller fields win', () => {
    const out = tagTuiRecord(rec({ tuiPid: 1 }), { pid: 2 });
    expect(out.data).toEqual({ tuiPid: 1 });
  });
  test('absent payload becomes the tag; unknown name/session are omitted', () => {
    expect(tagTuiRecord(rec(), { pid: 7, session: () => null }).data).toEqual({ tuiPid: 7 });
  });
  test('primitive and non-plain payloads are left as they were', () => {
    const r1 = rec('text');
    expect(tagTuiRecord(r1, { pid: 7 })).toBe(r1);
    const r2 = rec([1, 2]);
    expect(tagTuiRecord(r2, { pid: 7 })).toBe(r2);
  });
  test('a throwing session getter does not break logging', () => {
    expect(tagTuiRecord(rec({}), { pid: 7, session: () => { throw new Error('x'); } }).data).toEqual({ tuiPid: 7 });
  });
  test('process tag follows the self-report: launch name ⊕ owned session claim', () => {
    setTuiLogName(' n8n ');
    claimTuiOwnedSession('elanous-session-abc');
    expect(tagTuiRecord(rec({}), processTuiLogTag()).data).toEqual({ tuiPid: process.pid, tuiName: 'n8n', tuiSession: 'elanous-session-abc' });
    claimTuiOwnedSession(null);
    expect(tagTuiRecord(rec({}), processTuiLogTag()).data).toEqual({ tuiPid: process.pid, tuiName: 'n8n' });
  });
  test('the wrapper keeps the inner sink name (store) and forwards flush', () => {
    let flushed = 0;
    const seen: LogRecord[] = [];
    const inner: LogSink = { name: 'store', emit: (r) => { seen.push(r); }, flush: () => { flushed++; } };
    const w = withTuiLogTag(inner, { pid: 9 });
    w.emit(rec({ a: 1 }));
    w.flush?.();
    expect(w.name).toBe('store');
    expect(seen[0]!.data).toEqual({ a: 1, tuiPid: 9 });
    expect(flushed).toBe(1);
  });
});

// Incident repro: 10-23 n8n SIGTTIN — two TUIs wrote `tui.event-loop stall` to one logs.db and the rows
// could not be told apart. Two stores on the same file (= two processes) · two wrapped sinks.
describe('TUI-LOG-SESSION-TAG 10-23 n8n — two TUIs, one logs.db', () => {
  test('rows are distinguishable by name and pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-log-tag-'));
    const path = join(dir, 'logs.db');
    const a = new LogStore(path, { instance: 'tag-test' });
    const b = new LogStore(path, { instance: 'tag-test' });
    try {
      const sinkA = new StoreSink(a, 'tui', { installExitHandlers: false });
      const sinkB = new StoreSink(b, 'tui', { installExitHandlers: false });
      const tA = withTuiLogTag(sinkA, { pid: 20960, name: 'n8n', session: () => 'elanous-session-btkl04' });
      const tB = withTuiLogTag(sinkB, { pid: 31337, name: 'opt' });
      tA.emit(rec({ lagMs: 45640, streamingInFlight: false }));
      tB.emit(rec({ lagMs: 553, streamingInFlight: true }));
      sinkA.flush();
      sinkB.flush();
      const reader = new LogStore(path, { instance: 'tag-test', readonly: true });
      try {
        const all = reader.query({ surfaces: ['tui'] });
        expect(all.length).toBe(2);
        const n8n = reader.query({ surfaces: ['tui'], grep: '"tuiName":"n8n"' });
        expect(n8n.length).toBe(1);
        const d = JSON.parse(String(n8n[0]!.data));
        expect(d).toMatchObject({ lagMs: 45640, tuiPid: 20960, tuiName: 'n8n', tuiSession: 'elanous-session-btkl04' });
        const byPid = reader.query({ surfaces: ['tui'], grep: '"tuiPid":31337' });
        expect(byPid.length).toBe(1);
        expect(JSON.parse(String(byPid[0]!.data))).toMatchObject({ tuiName: 'opt', lagMs: 553 });
      } finally { reader.close(); }
      sinkA.close();
      sinkB.close();
    } finally {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
