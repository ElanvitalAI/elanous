// MEMORY-FAILURE-TRUTH (내부 문서 `MEMORY-CONTRACT` E-11 · E-13) — a real seat store in a temp dir. Literal expectations (rule 11).
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { resetSeatBootCacheForTest } from '../seat/seat-boot-preamble.js';
import { resetSeatMemoryRecallForTest, saveSeatMemory } from './seat-memory.js';
import { seatMemoryRecallText } from './seat-memory-layers.js';

let events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
const roots: string[] = [];
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), 'mem-failure-')); roots.push(d); return d; };
beforeEach(() => {
  events = [];
  resetSeatBootCacheForTest(); resetSeatMemoryRecallForTest();
  spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
    events.push({ category, event, data: { ...(data ?? {}) } });
  }) as typeof debug.log);
});
afterEach(() => {
  spyOn(debug, 'log').mockRestore();
  resetSeatBootCacheForTest(); resetSeatMemoryRecallForTest();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('E-13 an index write failure reports failure and leaves no half-written entry', () => {
  test('new entry: the save throws · no entry file · traced failed/index-write', () => {
    const dir = join(temp(), 'seats', 'OP');
    mkdirSync(join(dir, 'MEMORY.md'), { recursive: true }); // the index path is a directory → its write fails
    expect(() => saveSeatMemory({ name: 'y-rule', description: 'y', type: 'feedback', body: 'y body' }, dir, 'OP', { origin: 'tool.memory_save' })).toThrow();
    expect(readdirSync(dir).sort()).toEqual(['MEMORY.md']);
    expect(events.filter(e => e.category === 'memory.write').map(e => e.data)).toEqual([
      { store: 'seat', action: 'failed', seat: 'OP', name: 'y-rule', origin: 'tool.memory_save', reason: 'index-write' },
    ]);
  });

  test('update: the previous entry text is put back', () => {
    const dir = join(temp(), 'seats', 'OP');
    saveSeatMemory({ name: 'z-rule', description: 'z', type: 'feedback', body: 'z first body' }, dir, 'OP');
    const before = readFileSync(join(dir, 'z-rule.md'), 'utf8');
    rmSync(join(dir, 'MEMORY.md'));
    mkdirSync(join(dir, 'MEMORY.md'));
    expect(() => saveSeatMemory({ name: 'z-rule', description: 'z changed', type: 'feedback', body: 'z second body' }, dir, 'OP')).toThrow();
    expect(readFileSync(join(dir, 'z-rule.md'), 'utf8')).toBe(before);
    expect(readFileSync(join(dir, 'z-rule.md'), 'utf8')).toContain('z first body');
  });
});

describe('E-11 an unreadable store is not «no match»', () => {
  const deps = (root: string) => ({ home: join(root, 'home'), msgPath: join(root, 'msg.db'), seatMemoryRoot: join(root, 'mem'), env: { ELANOUS_TRACK: 'OP' } as NodeJS.ProcessEnv });

  test('the seat store path is a file → no layer, memory.recall turn reason=error', () => {
    const root = temp();
    mkdirSync(join(root, 'mem', 'seats'), { recursive: true });
    writeFileSync(join(root, 'mem', 'seats', 'OP'), 'not a directory');
    expect(seatMemoryRecallText({ cwd: root, userText: 'mk docs rule 대로 배정해', sessionId: 's1' }, deps(root))).toBeNull();
    const recall = events.filter(e => e.category === 'memory.recall');
    expect(recall.map(e => [e.event, e.data.reason, e.data.seat, e.data.hit, e.data.session])).toEqual([['turn', 'error', 'OP', false, 's1']]);
  });

  test('a readable store with nothing that matches → reason=no-match (unchanged)', () => {
    const root = temp();
    saveSeatMemory({ name: 'zebra-fact', description: 'zebra', type: 'project', body: 'zebra body' }, join(root, 'mem', 'seats', 'OP'), 'OP');
    events = [];
    expect(seatMemoryRecallText({ cwd: root, userText: 'mk docs rule 대로 배정해', sessionId: 's2' }, deps(root))).toBeNull();
    expect(events.filter(e => e.category === 'memory.recall').map(e => e.data.reason)).toEqual(['no-match']);
  });
});
