import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as llm from '../llm.js';
import type { LLMProvider } from '../llm.js';
import { TURN_INTERRUPTED_MARKER } from '../chat/interjection.js';
import { nextTuiPublicHistory } from '../tui/core/public-history.js';
import { createSession, loadSession } from './index.js';
import { runTurn } from './chat.js';

test('real aborted turn persists provenance and hides partial after reload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'abort-partial-provenance-'));
  const previous = process.env.ELANOUS_SESSION_ROOT;
  process.env.ELANOUS_SESSION_ROOT = root;
  const controller = new AbortController();
  const stream = spyOn(llm, 'streamLLMWithTools').mockImplementation(async (_messages, handlers) => {
    handlers.onText?.('partial secret', 'partial secret');
    controller.abort();
    return 'partial secret';
  });
  try {
    const provider: LLMProvider = { name: 'fake', defaultModel: 'fake', available: () => true,
      async *chat() { yield 'unused'; }, async *streamChat() { yield { type: 'text', delta: 'unused' } as const; } };
    const session = createSession({ provider: provider.name, model: provider.defaultModel, source: 'tui' });
    const result = await runTurn({ userConfig: { chat: {}, llm: { provider: 'fake', model: 'fake', memoryJudge: { enabled: false, crossRecall: false }, goalLoop: { enabled: false } } } as never,
      sessionId: session.id, userText: 'question', systemPrompt: 'base', skipMemoryInjection: true,
      tools: [{ name: 'Read', description: 'read', parameters: { type: 'object', properties: {} } }],
      dispatchTool: async () => 'ok', provider, signal: controller.signal });
    expect(result.text).toBe('partial secret');
    const rows = loadSession(session.id)!.messages;
    const partialIndex = rows.findIndex(row => row.role === 'assistant' && row.content === 'partial secret');
    expect(partialIndex).not.toBe(-1);
    expect(rows[partialIndex]?.replyFinal).toBe(false);
    expect(rows[partialIndex + 1]).toMatchObject({ role: 'user', content: TURN_INTERRUPTED_MARKER, interruptionMarker: true });
    expect(nextTuiPublicHistory(rows)[partialIndex]?.role).toBe('system');
  } finally {
    stream.mockRestore();
    if (previous === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
