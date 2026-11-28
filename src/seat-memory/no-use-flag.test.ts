// MEMORY-NO-USE-FLAG-PER-TASK (내부 문서 `MEMORY-CONTRACT` E-9) — a real seat store in a temp dir. Literal expectations (rule 11).
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { resetSeatBootCacheForTest } from '../seat/seat-boot-preamble.js';
import { resetSeatMemoryRecallForTest, saveSeatMemory } from './seat-memory.js';
import { buildSeatMemoryLayers, seatMemoryRecallText } from './seat-memory-layers.js';

let events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
let root = '';
beforeEach(() => {
  events = [];
  root = mkdtempSync(join(tmpdir(), 'mem-nouse-'));
  resetSeatBootCacheForTest(); resetSeatMemoryRecallForTest();
  spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
    events.push({ category, event, data: { ...(data ?? {}) } });
  }) as typeof debug.log);
});
afterEach(() => {
  spyOn(debug, 'log').mockRestore();
  resetSeatBootCacheForTest(); resetSeatMemoryRecallForTest();
  rmSync(root, { recursive: true, force: true });
});

const deps = () => ({ home: join(root, 'home'), msgPath: join(root, 'msg.db'), seatMemoryRoot: join(root, 'mem'), env: { ELANOUS_TRACK: 'OP' } as NodeJS.ProcessEnv });
const dir = () => join(root, 'mem', 'seats', 'OP');
const ASK = 'mk docs rule 대로 배정해';

describe('E-9 «do not use memory» is a structured per-task input', () => {
  test('memory: off → no recall, no crown tail · traced reason=off · the store is untouched', () => {
    saveSeatMemory({ name: 'mk-docs-rule', description: 'mk docs rule', type: 'feedback', body: 'MK 는 문서만' }, dir(), 'OP');
    saveSeatMemory({ name: 'crown-1128-mk-docs-only', description: '지시 · 대상 MK · 만료 2099-01-01T00:00:00.000Z', type: 'feedback', body: 'crown body' }, dir(), 'OP');
    events = [];
    expect(seatMemoryRecallText({ cwd: root, userText: ASK, sessionId: 'a', memory: 'off' }, deps())).toBeNull();
    expect(events.filter(e => e.category === 'memory.recall').map(e => [e.event, e.data.reason, e.data.seat, e.data.hit, e.data.session])).toEqual([['turn', 'off', 'OP', false, 'a']]);
    expect(readdirSync(dir()).sort()).toEqual(['MEMORY.md', 'crown-1128-mk-docs-only.md', 'mk-docs-rule.md']);
  });

  test('the next task without the input recalls again · memory: on is the same as no input', () => {
    saveSeatMemory({ name: 'mk-docs-rule', description: 'mk docs rule', type: 'feedback', body: 'MK 는 문서만' }, dir(), 'OP');
    seatMemoryRecallText({ cwd: root, userText: ASK, sessionId: 'b', memory: 'off' }, deps());
    expect(seatMemoryRecallText({ cwd: root, userText: ASK, sessionId: 'b' }, deps())).toContain('### mk-docs-rule [feedback]');
    expect(seatMemoryRecallText({ cwd: root, userText: ASK, sessionId: 'c', memory: 'on' }, deps())).toContain('### mk-docs-rule [feedback]');
  });

  test('buildSeatMemoryLayers passes the input through: recall layer empty', () => {
    saveSeatMemory({ name: 'mk-docs-rule', description: 'mk docs rule', type: 'feedback', body: 'MK 는 문서만' }, dir(), 'OP');
    expect(buildSeatMemoryLayers({ cwd: root, userText: ASK, sessionId: 'd', memory: 'off' }, deps()).recall).toEqual([]);
  });
});
