import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESS_SPACE_ENV } from '../harness/harness-space.js';
import type { ContentBlock } from '../llm.js';
import {
  HARNESS_SESSION_ORIGIN,
  appendMessage,
  collectToolUseById,
  createSession,
  forkSessionById,
  isHarnessSessionOrigin,
  listSessions,
  loadSession,
  persistMessageContent,
  resolveCreateSessionOrigin,
  getActiveSessionId,
  setActiveSessionId,
  clearActiveSessionId,
  toolTraceFieldsFromContent,
} from './index.js';

let root: string;
let priorHarness: string | undefined;

function withStateDir<T>(stateDir: string, run: () => T): T {
  const previous = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = stateDir;
  try { return run(); }
  finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'session-harness-origin-'));
  priorHarness = process.env[HARNESS_SPACE_ENV];
  delete process.env[HARNESS_SPACE_ENV];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (priorHarness === undefined) delete process.env[HARNESS_SPACE_ENV];
  else process.env[HARNESS_SPACE_ENV] = priorHarness;
});

function addUser(id: string, content: string): void {
  appendMessage(id, { role: 'user', content, ts: new Date().toISOString() }, root);
}

describe('active session pointer state universe', () => {
  test('different ELANOUS_STATE_DIR values use separate pointer files', () => {
    const first = mkdtempSync(join(tmpdir(), 'session-pointer-universe-a-'));
    const second = mkdtempSync(join(tmpdir(), 'session-pointer-universe-b-'));
    const previousXdgStateHome = process.env.XDG_STATE_HOME;
    // A regression to the old stateRoot() must still write only into this test.
    process.env.XDG_STATE_HOME = first;
    try {
      withStateDir(first, () => setActiveSessionId('session-a'));
      withStateDir(second, () => {
        expect(getActiveSessionId()).toBeNull();
        setActiveSessionId('session-b');
      });
      withStateDir(first, () => expect(getActiveSessionId()).toBe('session-a'));
      withStateDir(second, () => expect(getActiveSessionId()).toBe('session-b'));
      expect(existsSync(join(first, 'elanous', 'active'))).toBe(true);
      expect(existsSync(join(second, 'elanous', 'active'))).toBe(true);
    } finally {
      if (previousXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousXdgStateHome;
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  test('without ELANOUS_STATE_DIR keeps the existing XDG pointer path', () => {
    const stateHome = mkdtempSync(join(tmpdir(), 'session-pointer-xdg-'));
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    const previousXdgStateHome = process.env.XDG_STATE_HOME;
    delete process.env.ELANOUS_STATE_DIR;
    process.env.XDG_STATE_HOME = stateHome;
    try {
      setActiveSessionId('default-session');
      expect(existsSync(join(stateHome, 'elanous', 'active'))).toBe(true);
      expect(getActiveSessionId()).toBe('default-session');
      clearActiveSessionId();
      expect(getActiveSessionId()).toBeNull();
    } finally {
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateDir;
      if (previousXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousXdgStateHome;
      rmSync(stateHome, { recursive: true, force: true });
    }
  });
});

describe('harness session origin — existing origin field', () => {
  test('resolveCreateSessionOrigin uses the existing origin axis, not a new field', () => {
    expect(HARNESS_SESSION_ORIGIN).toBe('harness');
    expect(resolveCreateSessionOrigin(undefined, {})).toBeUndefined();
    expect(resolveCreateSessionOrigin(undefined, { [HARNESS_SPACE_ENV]: 'self-implement' }))
      .toBe(HARNESS_SESSION_ORIGIN);
    expect(resolveCreateSessionOrigin('cli', { [HARNESS_SPACE_ENV]: 'self-implement' })).toBe('cli');
    expect(isHarnessSessionOrigin('harness')).toBe(true);
    expect(isHarnessSessionOrigin('cli')).toBe(false);
    expect(isHarnessSessionOrigin(undefined)).toBe(false);
  });

  test('사람 대화 createSession 에는 하니스를 말하는 값이 없다', () => {
    const human = createSession({ origin: 'cli', title: 'human' }, root);
    expect(human.origin).toBe('cli');
    expect(isHarnessSessionOrigin(human.origin)).toBe(false);
    const unlabeled = createSession({ title: 'old' }, root);
    expect(unlabeled.origin).toBeUndefined();
    expect(isHarnessSessionOrigin(unlabeled.origin)).toBe(false);
  });

  test('하니스 공간에서 만든 세션은 origin=harness 를 남긴다', () => {
    process.env[HARNESS_SPACE_ENV] = 'self-implement';
    const child = createSession({ title: 'goal child' }, root);
    expect(child.origin).toBe(HARNESS_SESSION_ORIGIN);
    expect(isHarnessSessionOrigin(child.origin)).toBe(true);
    expect(child.sourceKind).toBe('keyboard');
  });

  test('forkSessionById origin override marks the child without changing the parent', () => {
    const parent = createSession({ origin: 'cli', title: 'parent' }, root);
    addUser(parent.id, 'keep talking');
    const child = forkSessionById(parent.id, { origin: HARNESS_SESSION_ORIGIN }, root);
    expect(child).not.toBeNull();
    expect(child!.meta.origin).toBe(HARNESS_SESSION_ORIGIN);
    expect(child!.meta.forkedFromId).toBe(parent.id);
    expect(loadSession(parent.id, root)?.meta.origin).toBe('cli');
  });

  test('forkSessionById without origin copies the parent origin', () => {
    const parent = createSession({ origin: 'pwa', title: 'pwa parent' }, root);
    addUser(parent.id, 'pwa hello');
    const child = forkSessionById(parent.id, {}, root);
    expect(child?.meta.origin).toBe('pwa');
  });

  test('excludeOrigins hides harness and keeps unlabeled old sessions', () => {
    const harness = createSession({ origin: HARNESS_SESSION_ORIGIN, title: 'harness' }, root);
    const old = createSession({ title: 'unlabeled old' }, root);
    const human = createSession({ origin: 'cli', title: 'human' }, root);
    addUser(harness.id, 'h');
    addUser(old.id, 'o');
    addUser(human.id, 'u');
    const visible = listSessions({ excludeOrigins: [HARNESS_SESSION_ORIGIN] }, root);
    const ids = visible.map((m) => m.id);
    expect(ids).toContain(old.id);
    expect(ids).toContain(human.id);
    expect(ids).not.toContain(harness.id);
    expect(visible.every((m) => !isHarnessSessionOrigin(m.origin))).toBe(true);
  });
});

describe('persistMessageContent — saved tool-use wording', () => {
  test('tool_use block keeps live SSE wording and the tool name as a string', () => {
    const saved = persistMessageContent([
      { type: 'tool_use', id: 'call-1', name: 'finance_quote', input: {} },
    ]);
    expect(typeof saved).toBe('string');
    expect(saved).toBe('🔧 finance_quote');
    expect(saved).toContain('finance_quote');
    expect(saved).not.toBe('[tool_use]');
  });

  test('tool_use without a name keeps the unknown [tool_use] marker', () => {
    const missingName = { type: 'tool_use', id: 'call-x', input: {} } as ContentBlock;
    const blankName: ContentBlock = { type: 'tool_use', id: 'call-y', name: '  ', input: {} };
    expect(persistMessageContent([missingName])).toBe('[tool_use]');
    expect(persistMessageContent([blankName])).toBe('[tool_use]');
  });

  test('ordinary string turns stay unchanged', () => {
    expect(persistMessageContent('반가워요')).toBe('반가워요');
    expect(persistMessageContent([{ type: 'text', text: 'plain reply' }])).toBe('plain reply');
  });

  test('appendMessage stores the named tool-use string; loadSession still reads legacy [tool_use]', () => {
    const session = createSession({ origin: 'cli', title: 'tool turn' }, root);
    const named = persistMessageContent([
      { type: 'tool_use', id: 'call-1', name: 'finance_quote', input: {} },
    ]);
    appendMessage(session.id, {
      role: 'assistant',
      content: named,
      ts: new Date().toISOString(),
    }, root);
    appendMessage(session.id, {
      role: 'user',
      content: '[tool_result]',
      ts: new Date().toISOString(),
    }, root);
    const loaded = loadSession(session.id, root);
    expect(loaded).not.toBeNull();
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.messages[0]!.content).toBe('🔧 finance_quote');
    expect(typeof loaded!.messages[0]!.content).toBe('string');

    const unnamedSession = createSession({ origin: 'cli', title: 'unnamed tool' }, root);
    const unnamed = persistMessageContent([
      { type: 'tool_use', id: 'call-x', input: {} } as ContentBlock,
    ]);
    appendMessage(unnamedSession.id, {
      role: 'assistant',
      content: unnamed,
      ts: new Date().toISOString(),
    }, root);
    const unnamedLoaded = loadSession(unnamedSession.id, root);
    expect(unnamedLoaded!.messages).toHaveLength(1);
    expect(unnamedLoaded!.messages[0]!.content).toBe('[tool_use]');

    const legacy = createSession({ origin: 'cli', title: 'legacy' }, root);
    appendMessage(legacy.id, {
      role: 'assistant',
      content: '[tool_use]',
      ts: new Date().toISOString(),
    }, root);
    appendMessage(legacy.id, {
      role: 'user',
      content: '[tool_result]',
      ts: new Date().toISOString(),
    }, root);
    const reopened = loadSession(legacy.id, root);
    expect(reopened!.messages).toHaveLength(2);
    expect(reopened!.messages[0]!.content).toBe('[tool_use]');
    expect(reopened!.messages[1]!.content).toBe('[tool_result]');
    expect(reopened!.messages[0]!.toolName).toBeUndefined();
    expect(reopened!.messages[1]!.toolName).toBeUndefined();
  });
});

describe('toolTraceFieldsFromContent — structured copy, no string parse', () => {
  test('copies tool_use name/input and tool_result content from blocks', () => {
    const use = toolTraceFieldsFromContent([
      { type: 'tool_use', id: 'call-1', name: 'AskUserQuestion', input: { prompt: '어느 쪽?' } },
    ]);
    expect(use).toEqual({ toolName: 'AskUserQuestion', toolArgs: { prompt: '어느 쪽?' } });

    const byId = collectToolUseById([
      { content: [{ type: 'tool_use', id: 'call-1', name: 'AskUserQuestion', input: { prompt: '어느 쪽?' } }] },
    ]);
    const result = toolTraceFieldsFromContent(
      [{ type: 'tool_result', tool_use_id: 'call-1', content: '왼쪽' }],
      byId,
    );
    expect(result).toEqual({
      toolName: 'AskUserQuestion',
      toolArgs: { prompt: '어느 쪽?' },
      toolResult: '왼쪽',
    });
  });

  test('plain strings that look like tool markers stay field-less', () => {
    expect(toolTraceFieldsFromContent('[tool_result]')).toBeUndefined();
    expect(toolTraceFieldsFromContent('🔧 AskUserQuestion')).toBeUndefined();
    expect(toolTraceFieldsFromContent('안녕')).toBeUndefined();
    expect(toolTraceFieldsFromContent([{ type: 'text', text: '[tool_result]' }])).toBeUndefined();
  });

  test('loadSession still accepts JSONL rows that omit tool fields', () => {
    const session = createSession({ origin: 'cli', title: 'legacy absent fields' }, root);
    appendMessage(session.id, {
      role: 'user',
      content: '[tool_result]',
      ts: new Date().toISOString(),
    }, root);
    const loaded = loadSession(session.id, root);
    expect(loaded).not.toBeNull();
    expect(loaded!.messages).toHaveLength(1);
    expect(loaded!.messages[0]!.content).toBe('[tool_result]');
    expect(loaded!.messages[0]!.toolName).toBeUndefined();
    expect(loaded!.messages[0]!.toolArgs).toBeUndefined();
    expect(loaded!.messages[0]!.toolResult).toBeUndefined();
  });
});
