// MEMORY-OBSERVABILITY — `memory.write` / `memory.recall` are the one door for memory activity in `elanous logs`.
// Expectations are literals (independent of the product's constants).
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { pinSeatMemory, recallSeatMemoriesForTurn, resetSeatMemoryRecallForTest, saveSeatMemory, deleteSeatMemory } from './seat-memory.js';
import { traceMemoryRecall, traceMemoryWrite } from './memory-trace.js';
import { buildSeatMemoryIndexSystemMessages, resetSeatBootCacheForTest, seatMemoryIndexStaleness } from '../seat/seat-boot-preamble.js';
import { seatMemoryRecallText } from './seat-memory-layers.js';
import { saveMemory, deleteMemory } from '../memory.js';
import { MEMORY_CLI_WRITE_COMMANDS } from '../cli/memory-cli.js';

const dirs: string[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), `mem-trace-${prefix}-`)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

let events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
beforeEach(() => {
  events = [];
  resetSeatMemoryRecallForTest();
  resetSeatBootCacheForTest();
  spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: Record<string, unknown>) => {
    events.push({ category, event, data });
  }) as typeof debug.log);
});
afterEach(() => { spyOn(debug, 'log').mockRestore(); resetSeatBootCacheForTest(); });

const traced = (category: 'memory.write' | 'memory.recall') => events.filter(e => e.category === category);

describe('memory.write — every store write is one line (names only, never the body)', () => {
  test('seat store: created · deduped-or-updated · pinned · deleted carry seat, name and origin', () => {
    const dir = join(temp('seat'), 'seats', 'OP');
    saveSeatMemory({ name: 'crown-docs-only', description: 'MK = docs only', type: 'feedback', body: 'secret-free body text' }, dir, 'OP', { origin: 'memory-cli.add-seat' });
    pinSeatMemory('crown-docs-only', dir);
    deleteSeatMemory('crown-docs-only', dir, 'OP');
    const rows = traced('memory.write');
    expect(rows.map(r => r.event)).toEqual(['created', 'pinned', 'deleted']);
    expect(rows[0]!.data).toEqual({ store: 'seat', action: 'created', seat: 'OP', name: 'crown-docs-only', origin: 'memory-cli.add-seat', bytes: 21 });
    expect(rows[1]!.data).toEqual({ store: 'seat', action: 'pinned', seat: 'OP', name: 'crown-docs-only' });
    expect(JSON.stringify(rows)).not.toContain('secret-free body text');
  });

  test('a secret-looking write is traced as refused with the reason', () => {
    const dir = temp('secret');
    const key = ['sk', '-', 'Q'.repeat(8), '7'.repeat(12)].join('');
    saveSeatMemory({ name: 'leak', description: 'x', type: 'project', body: `key ${key}` }, dir, 'OP');
    const row = traced('memory.write')[0]!;
    expect(row.event).toBe('refused');
    expect(row.data.reason).toBe('secret-pattern');
    expect(JSON.stringify(row)).not.toContain(key);
  });

  test('global store: created then deleted, with origin and seat from the gate', () => {
    const root = temp('global');
    const e = saveMemory({ type: 'project', name: 'mail-digest-op-probe', description: 'digest', body: 'three lines' }, root, { origin: 'msg-ack-digest', seat: 'OP', mode: 'shadow' });
    deleteMemory(e.id, root);
    const rows = traced('memory.write');
    expect(rows.map(r => r.event)).toEqual(['created', 'deleted']);
    expect(rows[0]!.data).toMatchObject({ store: 'global', seat: 'OP', name: 'mail-digest-op-probe', origin: 'msg-ack-digest', bytes: 11 });
  });

  test('a long name is bounded at 80 chars plus an ellipsis', () => {
    traceMemoryWrite({ store: 'seat', action: 'created', name: 'n'.repeat(120) });
    expect(String(traced('memory.write')[0]!.data.name)).toBe(`${'n'.repeat(80)}…`);
  });
});

describe('memory.recall — session-start index and every turn, hit or miss with the reason', () => {
  test('turn recall: a miss says no-match, a hit lists names, the same line again says already-shown', () => {
    const dir = temp('turn');
    saveSeatMemory({ name: 'zebra-marker', description: 'zebra marker', type: 'project', body: 'zebra body' }, dir, 'OP');
    events = [];
    recallSeatMemoriesForTurn({ seat: 'OP', dir, text: 'release cut timing check', sessionKey: 'OP:s1', trace: { session: 's1' } });
    recallSeatMemoriesForTurn({ seat: 'OP', dir, text: 'zebra marker please', sessionKey: 'OP:s1', trace: { session: 's1' } });
    recallSeatMemoriesForTurn({ seat: 'OP', dir, text: 'zebra marker please', sessionKey: 'OP:s1', trace: { session: 's1' } });
    const rows = traced('memory.recall');
    expect(rows.map(r => [r.event, r.data.hit, r.data.reason ?? null])).toEqual([
      ['turn', false, 'no-match'], ['turn', true, null], ['turn', false, 'already-shown'],
    ]);
    expect(rows[1]!.data).toMatchObject({ store: 'seat', seat: 'OP', session: 's1', names: ['zebra-marker'], count: 1 });
  });

  test('a pin written after the session-start snapshot is reported as a stale index on the next turn', () => {
    const home = temp('stale');
    const cwd = join(home, 'work', 'seats', 'OP');
    mkdirSync(cwd, { recursive: true });
    const root = join(home, 'mem');
    const dir = join(root, 'seats', 'OP');
    const deps = { home, msgPath: join(home, 'msg.db'), seatMemoryRoot: root, env: { ELANOUS_TRACK: 'OP' } as NodeJS.ProcessEnv };
    saveSeatMemory({ name: 'old-fact', description: 'old fact', type: 'project', body: 'old body' }, dir, 'OP');
    const before = buildSeatMemoryIndexSystemMessages({ cwd, sessionId: 's1' }, deps).map(m => String(m.content)).join('');
    expect(seatMemoryIndexStaleness(cwd)?.staleIndex).toBe(false);
    saveSeatMemory({ name: 'crown-new-pin', description: 'crown new pin', type: 'feedback', body: 'new pin body' }, dir, 'OP');
    pinSeatMemory('crown-new-pin', dir);
    const future = new Date(Date.now() + 5_000);
    utimesSync(join(dir, 'MEMORY.md'), future, future);
    const after = buildSeatMemoryIndexSystemMessages({ cwd, sessionId: 's1' }, deps).map(m => String(m.content)).join('');
    expect(after).toBe(before);
    expect(after).not.toContain('crown-new-pin');
    expect(seatMemoryIndexStaleness(cwd)?.staleIndex).toBe(true);
    events = [];
    seatMemoryRecallText({ cwd, userText: 'crown new pin check', sessionId: 's1' }, deps);
    const turn = traced('memory.recall').find(r => r.event === 'turn')!;
    expect(turn.data).toMatchObject({ staleIndex: true, session: 's1', hit: true, names: ['crown-new-pin'] });
  });

  test('session-start traces lines and bytes without a count field', () => {
    traceMemoryRecall({ store: 'seat', via: 'session-start', seat: 'OP', hit: true, lines: 3, bytes: 120, truncated: false });
    expect(traced('memory.recall')[0]!.data).toEqual({ store: 'seat', via: 'session-start', seat: 'OP', hit: true, lines: 3, bytes: 120, truncated: false });
  });
});

describe('memory CLI — only the store-changing subcommands register the logs.db sink', () => {
  test('write set', () => {
    expect([...MEMORY_CLI_WRITE_COMMANDS].sort()).toEqual(['add', 'delete', 'import', 'import-claude', 'pin', 'priority', 'promote', 'seed-op', 'sync-proxy', 'unpin']);
  });
});
