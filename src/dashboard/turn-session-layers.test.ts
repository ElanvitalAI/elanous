// TUI-SEAT-MEMORY-SCOPE — the TUI preamble's file-memory layer (global ⊕ seat scope) and its
// once-per-session cadence, plus the self-ambient cache.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { saveMemory, type ContextMemoryCard } from '../memory.js';
import { buildDashboardTurnPreamble } from './turn-preamble.js';
import {
  resetTurnSessionLayers,
  resolveMemoryScope,
  SESSION_LAYER_CACHE_MAX,
  sessionMemoryLayer,
  sessionSelfAmbientParts,
} from './turn-session-layers.js';
import type { getUserConfig } from '../user-config.js';

const card = (seat: string, topic: string): ContextMemoryCard => ({
  project: '', seat, topic, source: 'test', updatedAt: '2026-10-14T00:00:00.000Z', status: 'active',
});

const tempDirs: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
afterAll(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

function seedStore(): string {
  const root = tempDir('tui-memory-');
  saveMemory({ type: 'user', name: 'global-pref', description: 'answers in Korean', body: 'GLOBAL-BODY' }, root);
  saveMemory({ type: 'project', name: 'test-seat-card', description: 'TEST seat note', body: 'TEST-SEAT-BODY', contextCard: card('TEST', 'a') }, root);
  saveMemory({ type: 'project', name: 'other-seat-card', description: 'OTHER seat note', body: 'OTHER-SEAT-BODY', contextCard: card('OTHER', 'b') }, root);
  return root;
}

const text = (messages: readonly { content: unknown }[]): string => messages.map(m => String(m.content)).join('\n');

let events: Array<[string, string, Record<string, unknown> | undefined]> = [];
beforeEach(() => {
  resetTurnSessionLayers();
  events = [];
  spyOn(debug, 'log').mockImplementation((category, event, data) => {
    events.push([category, event, data as Record<string, unknown> | undefined]);
  });
});
afterEach(() => { spyOn(debug, 'log').mockRestore(); });

describe('resolveMemoryScope', () => {
  test('a /seats/<seat> cwd wins over COORD_ID', () => {
    expect(resolveMemoryScope('/Users/x/elanous-hq/seats/TEST/sub', { COORD_ID: 'OP' })).toEqual({ seat: 'TEST' });
  });
  test('COORD_ID names the seat outside a seat directory; ELANOUS_PROJECT names the project', () => {
    expect(resolveMemoryScope('/tmp/work', { COORD_ID: 'OPC', ELANOUS_PROJECT: 'elanous' })).toEqual({ seat: 'OPC', project: 'elanous' });
  });
  test('no seat signal means no seat scope', () => {
    expect(resolveMemoryScope('/tmp/work', {})).toEqual({});
  });
});

describe('sessionMemoryLayer — scope', () => {
  test('a TEST seat session sees global and TEST cards, never another seat (index included)', () => {
    const root = seedStore();
    const layer = text(sessionMemoryLayer({ sessionKey: 's1', cwd: '/hq/seats/TEST', root, env: {} }));
    expect(layer).toContain('global-pref');
    expect(layer).toContain('TEST-SEAT-BODY');
    expect(layer).not.toContain('other-seat-card');
    expect(layer).not.toContain('OTHER-SEAT-BODY');
  });

  test('outside any seat, seat-tagged cards stay out', () => {
    const root = seedStore();
    const layer = text(sessionMemoryLayer({ sessionKey: 's1', cwd: '/tmp/x', root, env: {} }));
    expect(layer).toContain('global-pref');
    expect(layer).not.toContain('test-seat-card');
    expect(layer).not.toContain('other-seat-card');
  });

  test('an empty store yields no layer', () => {
    const root = tempDir('tui-memory-empty-');
    expect(sessionMemoryLayer({ sessionKey: 's1', cwd: '/hq/seats/TEST', root, env: {} })).toEqual([]);
  });

  test('a budget too small for the index drops the index but never throws', () => {
    const root = seedStore();
    expect(() => sessionMemoryLayer({ sessionKey: 's1', cwd: '/hq/seats/TEST', root, env: {}, maxTokens: 1 })).not.toThrow();
  });
});

describe('sessionMemoryLayer — cadence', () => {
  test('the second turn reuses the same messages without rebuilding', () => {
    const root = seedStore();
    const first = sessionMemoryLayer({ sessionKey: 's1', cwd: '/hq/seats/TEST', root, env: {} });
    const second = sessionMemoryLayer({ sessionKey: 's1', cwd: '/hq/seats/TEST', root, env: {} });
    expect(second).toBe(first);
    expect(events.filter(([c]) => c === 'chat.memory-layer').map(([, e]) => e)).toEqual(['built', 'reused']);
  });

  test('a new card rebuilds the layer and the new content shows up', () => {
    const root = seedStore();
    sessionMemoryLayer({ sessionKey: 's1', cwd: '/hq/seats/TEST', root, env: {} });
    saveMemory({ type: 'project', name: 'late-test-card', description: 'later', body: 'LATE-BODY', contextCard: card('TEST', 'c') }, root);
    const after = text(sessionMemoryLayer({ sessionKey: 's1', cwd: '/hq/seats/TEST', root, env: {} }));
    expect(after).toContain('LATE-BODY');
    expect(events.filter(([c]) => c === 'chat.memory-layer').map(([, e]) => e)).toEqual(['built', 'changed']);
  });

  test('a touched file with the same content keeps the previous messages byte-identical', () => {
    const root = seedStore();
    const first = sessionMemoryLayer({ sessionKey: 's1', cwd: '/hq/seats/TEST', root, env: {} });
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(root, 'MEMORY.md'), future, future);
    const second = sessionMemoryLayer({ sessionKey: 's1', cwd: '/hq/seats/TEST', root, env: {} });
    expect(second).toBe(first);
    expect(events.at(-1)?.[2]).toMatchObject({ sameContent: true });
  });

  test('a different budget rebuilds instead of returning the layer built for the previous budget', () => {
    const root = seedStore();
    const full = text(sessionMemoryLayer({ sessionKey: 's1', cwd: '/hq/seats/TEST', root, env: {} }));
    const tiny = text(sessionMemoryLayer({ sessionKey: 's1', cwd: '/hq/seats/TEST', root, env: {}, maxTokens: 1 }));
    expect(full).toContain('TEST-SEAT-BODY');
    expect(tiny).not.toContain('TEST-SEAT-BODY');
  });

  test('a different session builds its own layer', () => {
    const root = seedStore();
    sessionMemoryLayer({ sessionKey: 's1', cwd: '/hq/seats/TEST', root, env: {} });
    sessionMemoryLayer({ sessionKey: 's2', cwd: '/hq/seats/TEST', root, env: {} });
    expect(events.filter(([c]) => c === 'chat.memory-layer').map(([, e]) => e)).toEqual(['built', 'built']);
  });
});

describe('sessionSelfAmbientParts', () => {
  test('reads the stores once per TTL, then reports unchanged or changed', () => {
    let calls = 0;
    let value = 'A';
    const build = () => { calls += 1; return [value]; };
    expect(sessionSelfAmbientParts('s1', { now: 0, ttlMs: 100, build })).toEqual(['A']);
    expect(sessionSelfAmbientParts('s1', { now: 50, ttlMs: 100, build })).toEqual(['A']);
    expect(calls).toBe(1);
    expect(sessionSelfAmbientParts('s1', { now: 150, ttlMs: 100, build })).toEqual(['A']);
    value = 'B';
    expect(sessionSelfAmbientParts('s1', { now: 300, ttlMs: 100, build })).toEqual(['B']);
    expect(calls).toBe(3);
    expect(events.filter(([c]) => c === 'chat.self-ambient').map(([, e]) => e)).toEqual(['built', 'unchanged', 'changed']);
  });

  test('a failing read leaves the layer out for that turn, is observed, and the next turn reads again', () => {
    sessionSelfAmbientParts('s1', { now: 0, ttlMs: 10, build: () => ['A'] });
    const parts = sessionSelfAmbientParts('s1', { now: 100, ttlMs: 10, build: () => { throw new Error('db locked'); } });
    expect(parts).toEqual([]);
    expect(events.at(-1)?.slice(0, 2)).toEqual(['chat.self-ambient', 'failed']);
    expect(sessionSelfAmbientParts('s1', { now: 101, ttlMs: 10, build: () => ['B'] })).toEqual(['B']);
  });

  test('the cache is LRU: a session used within its TTL survives, the least recently used is dropped', () => {
    const built: string[] = [];
    const call = (key: string) => sessionSelfAmbientParts(key, { now: 0, build: () => { built.push(key); return ['A']; } });
    for (let i = 0; i < SESSION_LAYER_CACHE_MAX; i += 1) call(`s${i}`);
    call('s0'); // a TTL hit: no read, but s0 becomes the most recent
    call(`s${SESSION_LAYER_CACHE_MAX}`); // the 33rd session evicts s1, not s0
    built.length = 0;
    call('s0');
    expect(built).toEqual([]);
    call('s1');
    expect(built).toEqual(['s1']);
  });
});

describe('buildDashboardTurnPreamble — memory layer', () => {
  const fakeConfig = { chat: { conciseness: 'balanced' } } as unknown as ReturnType<typeof getUserConfig>;

  test('the TUI preamble carries the seat-scoped memory layer, and memory:false omits it', () => {
    const root = seedStore();
    const build = (memory: { root: string; env: NodeJS.ProcessEnv } | false) => text(buildDashboardTurnPreamble({
      userText: 'hello', cwd: '/hq/seats/TEST', sessionId: 'p1', userConfig: fakeConfig, controlEnv: {}, memory,
    }));
    const withMemory = build({ root, env: {} });
    expect(withMemory).toContain('TEST-SEAT-BODY');
    expect(withMemory).not.toContain('OTHER-SEAT-BODY');
    expect(build(false)).not.toContain('TEST-SEAT-BODY');
  });

  test('a failing memory store drops the layer, logs failed, and the turn still gets its preamble', () => {
    // A regular file as the store root: listMemories' readdir throws ENOTDIR inside buildMemoryInjection.
    const root = join(tempDir('tui-memory-broken-'), 'not-a-dir');
    writeFileSync(root, 'x');
    const messages = buildDashboardTurnPreamble({
      userText: 'hello', cwd: '/hq/seats/TEST', sessionId: 'p2', userConfig: fakeConfig, controlEnv: {},
      memory: { root, env: {} },
    });
    expect(messages.length).toBeGreaterThan(0);
    expect(text(messages)).not.toContain('## Memory');
    const failed = events.filter(([c, e]) => c === 'chat.memory-layer' && e === 'failed');
    expect(failed).toHaveLength(1);
    expect(String(failed[0]?.[2]?.error)).toContain('ENOTDIR');
  });
});
