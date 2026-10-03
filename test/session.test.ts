// ── Session persistence tests ──

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSession, adoptSession, appendMessage, loadSession, listSessions, deleteSession,
  findTelegramSession, resolveSessionId, forkSessionFromHistory,
  getActiveSessionId, setActiveSessionId, clearActiveSessionId,
  defaultSessionSourceKind,
} from '../src/session/index';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sessions-'));
  // Redirect state/active away from user's real home
  process.env.XDG_STATE_HOME = join(root, '_state');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.XDG_STATE_HOME;
});

describe('session CRUD', () => {
  test('createSession writes empty jsonl + index entry', () => {
    const s = createSession({ provider: 'grok', model: 'grok-4' }, root);
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.messageCount).toBe(0);
    expect(s.source).toBe('cli');
    expect(s.sourceKind).toBe('keyboard');
    expect(existsSync(join(root, `${s.id}.jsonl`))).toBe(true);
    expect(existsSync(join(root, 'index.json'))).toBe(true);
  });

  test('defaultSessionSourceKind centralizes the fallback mapping', () => {
    expect(defaultSessionSourceKind(undefined)).toBe('keyboard');
    expect(defaultSessionSourceKind('cli')).toBe('keyboard');
    expect(defaultSessionSourceKind('telegram')).toBe('telegram');
  });

  test('appendMessage persists + updates meta', () => {
    const s = createSession({ provider: 'grok', model: 'grok-4' }, root);
    const m = appendMessage(s.id, {
      role: 'user', content: 'hello world', ts: new Date().toISOString(),
    }, root);
    expect(m.messageCount).toBe(1);
    expect(m.title).toBe('hello world');

    const loaded = loadSession(s.id, root);
    expect(loaded).not.toBeNull();
    expect(loaded!.messages.length).toBe(1);
    expect(loaded!.messages[0].content).toBe('hello world');
  });

  test('title is first user message truncated to 60 chars', () => {
    const s = createSession({}, root);
    const longText = 'a'.repeat(100);
    const m = appendMessage(s.id, { role: 'user', content: longText, ts: new Date().toISOString() }, root);
    expect(m.title.length).toBe(60);
  });

  test('listSessions returns newest-first', () => {
    const a = createSession({}, root);
    const b = createSession({}, root);
    appendMessage(b.id, { role: 'user', content: 'b first', ts: '2026-04-15T12:00:00Z' }, root);
    const all = listSessions({}, root);
    expect(all[0].id).toBe(b.id); // bumped by append
    expect(all[1].id).toBe(a.id);
  });

  test('listSessions honors limit + source filter', () => {
    createSession({ source: 'cli' }, root);
    createSession({ source: 'telegram', tgChatId: 100 }, root);
    createSession({ source: 'cli' }, root);
    expect(listSessions({ source: 'cli' }, root).length).toBe(2);
    expect(listSessions({ source: 'telegram' }, root).length).toBe(1);
    expect(listSessions({ sourceKind: 'telegram' }, root).length).toBe(1);
    expect(listSessions({ limit: 1 }, root).length).toBe(1);
  });

  test('projectId persists in the existing index and filters before limit', () => {
    const old = createSession({ title: 'legacy' }, root);
    const other = createSession({ projectId: 'other' }, root);
    const matched = createSession({ projectId: 'project-a' }, root);
    const newestNonmatch = createSession({ projectId: 'other' }, root);
    expect(listSessions({ projectId: 'project-a', limit: 1 }, root).map(m => m.id)).toEqual([matched.id]);
    expect(listSessions({ projectId: 'other' }, root).map(m => m.id)).toEqual([newestNonmatch.id, other.id]);
    expect(listSessions({ projectId: 'missing' }, root)).toEqual([]);
    expect(listSessions({}, root).map(m => m.id)).toEqual([newestNonmatch.id, matched.id, other.id, old.id]);
    expect(loadSession(matched.id, root)?.meta.projectId).toBe('project-a');
    expect(JSON.parse(readFileSync(join(root, 'index.json'), 'utf-8'))
      .find((m: { id: string }) => m.id === matched.id).projectId).toBe('project-a');
    expect(Object.hasOwn(loadSession(old.id, root)!.meta, 'projectId')).toBe(false);
    expect(Object.hasOwn(JSON.parse(readFileSync(join(root, 'index.json'), 'utf-8'))
      .find((m: { id: string }) => m.id === old.id), 'projectId')).toBe(false);
    appendMessage(old.id, { role: 'user', content: 'old record', ts: '2026-04-15T12:00:00Z' }, root);
    expect(Object.hasOwn(loadSession(old.id, root)!.meta, 'projectId')).toBe(false);
    expect(Object.hasOwn(JSON.parse(readFileSync(join(root, 'index.json'), 'utf-8'))
      .find((m: { id: string }) => m.id === old.id), 'projectId')).toBe(false);
  });

  test('adopt and fork preserve optional projectId without assigning it to untagged sessions', () => {
    const adopted = adoptSession('adopted-id', { projectId: 'project-a' }, root);
    expect(loadSession(adopted.id, root)?.meta.projectId).toBe('project-a');
    expect(adoptSession(adopted.id, { projectId: 'other' }, root).projectId).toBe('project-a');
    const fork = forkSessionFromHistory({ projectId: 'project-a', messages: [] }, root);
    expect(fork.meta.projectId).toBe('project-a');
    expect(Object.hasOwn(createSession({}, root), 'projectId')).toBe(false);
  });

  test('deleteSession removes file + index entry', () => {
    const s = createSession({}, root);
    appendMessage(s.id, { role: 'user', content: 'gone', ts: '2026-04-15T12:00:00Z' }, root);
    expect(deleteSession(s.id, root)).toBe(true);
    expect(existsSync(join(root, `${s.id}.jsonl`))).toBe(false);
    expect(loadSession(s.id, root)).toBeNull();
    expect(deleteSession(s.id, root)).toBe(false);
  });

  test('loadSession for unknown id returns null', () => {
    expect(loadSession('does-not-exist', root)).toBeNull();
  });

  test('malformed JSONL line skipped, rest loaded', () => {
    const s = createSession({}, root);
    const file = join(root, `${s.id}.jsonl`);
    appendMessage(s.id, { role: 'user', content: 'one', ts: 'x' }, root);
    // Corrupt the file: append garbage
    require('node:fs').appendFileSync(file, '{not json\n');
    appendMessage(s.id, { role: 'assistant', content: 'two', ts: 'y' }, root);
    const loaded = loadSession(s.id, root)!;
    expect(loaded.messages.length).toBe(2);
    expect(loaded.messages[0].content).toBe('one');
    expect(loaded.messages[1].content).toBe('two');
  });

  test('forkSessionFromHistory creates new session with copied messages + parent pointer', () => {
    const parent = createSession({ provider: 'openai', model: 'gpt-5' }, root);
    const forked = forkSessionFromHistory({
      provider: 'openai',
      model: 'gpt-5',
      forkedFromId: parent.id,
      messages: [
        { role: 'system', content: 'system seed', ts: '2026-04-28T00:00:00Z' },
        { role: 'user', content: 'hello fork', ts: '2026-04-28T00:00:01Z' },
        { role: 'assistant', content: 'copied reply', ts: '2026-04-28T00:00:02Z' },
      ],
    }, root);

    expect(forked.meta.id).not.toBe(parent.id);
    expect(forked.meta.forkedFromId).toBe(parent.id);
    expect(forked.meta.provider).toBe('openai');
    expect(forked.meta.model).toBe('gpt-5');
    expect(forked.meta.messageCount).toBe(3);
    expect(forked.meta.title).toBe('hello fork');
    expect(forked.messages.map((m) => [m.role, m.content])).toEqual([
      ['system', 'system seed'],
      ['user', 'hello fork'],
      ['assistant', 'copied reply'],
    ]);
    expect(listSessions({}, root)[0]?.id).toBe(forked.meta.id);
  });
});

describe('telegram session routing', () => {
  test('findTelegramSession by chatId', () => {
    const a = createSession({ source: 'telegram', tgChatId: 111 }, root);
    createSession({ source: 'telegram', tgChatId: 222 }, root);
    const found = findTelegramSession(111, undefined, root);
    expect(found?.id).toBe(a.id);
    expect(findTelegramSession(999, undefined, root)).toBeNull();
  });

  test('findTelegramSession respects thread/topic isolation', () => {
    const t0 = createSession({ source: 'telegram', tgChatId: 500, tgThreadId: 0 }, root);
    const t5 = createSession({ source: 'telegram', tgChatId: 500, tgThreadId: 5 }, root);
    expect(findTelegramSession(500, 0, root)?.id).toBe(t0.id);
    expect(findTelegramSession(500, 5, root)?.id).toBe(t5.id);
  });

  test('tgSessionKey set for telegram sources', () => {
    const s = createSession({ source: 'telegram', tgChatId: 100, tgThreadId: 7 }, root);
    expect(s.tgSessionKey).toBe('telegram:group:100:7');
    const dm = createSession({ source: 'telegram', tgChatId: 100 }, root);
    expect(dm.tgSessionKey).toBe('telegram:dm:100:0');
  });
});

describe('resolveSessionId prefix', () => {
  test('returns full id for unique prefix', () => {
    const s = createSession({}, root);
    const prefix = s.id.slice(0, 8);
    expect(resolveSessionId(prefix, root)).toBe(s.id);
  });

  test('null for no match', () => {
    createSession({}, root);
    expect(resolveSessionId('ffffffff-ffff-4fff', root)).toBeNull();
  });

  test('throws on ambiguous prefix', () => {
    // Can't deterministically force a prefix collision with uuid v4.
    // Instead, query with empty prefix, which matches ALL.
    createSession({}, root);
    createSession({}, root);
    expect(() => resolveSessionId('', root)).toThrow(/ambiguous/);
  });
});

describe('active session marker', () => {
  test('set / get / clear round-trip', () => {
    expect(getActiveSessionId()).toBeNull();
    const s = createSession({}, root);
    setActiveSessionId(s.id);
    expect(getActiveSessionId()).toBe(s.id);
    clearActiveSessionId();
    expect(getActiveSessionId()).toBeNull();
  });

  test('deleting active session clears marker', () => {
    const s = createSession({}, root);
    setActiveSessionId(s.id);
    deleteSession(s.id, root);
    expect(getActiveSessionId()).toBeNull();
  });
});
