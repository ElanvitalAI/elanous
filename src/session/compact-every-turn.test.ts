// ELN-COMPACT-EVERY-TURN — a long seat's record keeps every person row verbatim (COMPACT P0), so a compaction cannot
// bring it back under the 16k turn-start trigger. The forced turn-start compaction then fired on every turn and
// rewrote the summary at the head of the history each time (OP seat 11-24: record 58k→94k tokens; cache hit 54%
// against 81–88% on other terra seats). Synthetic universe: recorder chat provider + fake summarizer, no LLM.
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider } from '../llm.js';
import { debug } from '../debug/log.js';
import { estimateMessagesTokens } from '../tokens.js';
import { CHAT_DEFAULTS } from '../user-config/chat.js';
import { resolveAutoCompactWindow } from '../compact/auto.js';
import { resetAutoCompactStateForTest } from '../compact/auto-state.js';
import type { CompactProvider } from '../compact/provider.js';
import * as actualUserIntent from '../user-intent/index.js';
import { appendMessage, createSession, loadSession } from './index.js';
import { runTurn, toLLM } from './chat.js';

const MODEL = 'compact-every-turn';
const SEAT_TURNS = 50; // acceptance scenario: a 50-turn OP session
const SEED_RECORD_TOKENS = 17_000; // above the 16k record trigger, made only of person rows that compaction keeps verbatim

let root = '';
const savedEnv: Record<string, string | undefined> = {};
const intentSpy = spyOn(actualUserIntent, 'userIntentLogger').mockImplementation(() => ({ emit: () => null } as never));
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'compact-every-turn-'));
  for (const key of ['HOME', 'ELANOUS_SESSION_ROOT']) savedEnv[key] = process.env[key];
  process.env.HOME = root;
  process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
});
afterAll(() => {
  intentSpy.mockRestore();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => { resetAutoCompactStateForTest(); });

let summaries = 0;
const summarizer: CompactProvider = {
  async summarize(args) { summaries++; return { summary: `summary ${summaries}`, modelUsed: 'fake', sourceMessageCount: args.messages.length }; },
  getContextWindow: () => resolveAutoCompactWindow(MODEL),
  getAutoCompactThreshold: () => CHAT_DEFAULTS.autoCompact.triggerRatio,
};
const provider: LLMProvider = {
  name: 'compact-every-turn', defaultModel: MODEL, available: () => true,
  async *chat() { yield 'unused'; },
  async *streamChat() { yield { type: 'text', delta: `확인했습니다. 다음 점검은 05:15 KST 입니다. ${'r'.repeat(200)}` }; },
};

test('50-turn seat session over the record trigger: at most one forced compaction, the summary stays put', async () => {
  const session = createSession({ source: 'cli', provider: provider.name, model: MODEL });
  let seq = 0;
  while (estimateMessagesTokens(toLLM(loadSession(session.id)!.messages)) < SEED_RECORD_TOKENS) {
    appendMessage(session.id, { role: 'user', content: `사람 지시 ${seq++} ${'u'.repeat(1_200)}`, ts: new Date().toISOString(), from: { kind: 'human' } });
  }
  const log = spyOn(debug, 'log');
  const summaryHeads: string[] = [];
  try {
    for (let turn = 0; turn < SEAT_TURNS; turn++) {
      await runTurn({
        userConfig: { chat: {}, llm: { provider: provider.name, model: MODEL, memoryJudge: { enabled: false, crossRecall: false } } } as never,
        sessionId: session.id, userText: `[notice · seat-mail] digest ${turn}`, systemPrompt: 'seat contract',
        skipMemoryInjection: true, provider, compactProvider: summarizer,
      });
      const head = loadSession(session.id)!.messages.find((row) => row.role === 'system' && row.content.startsWith('<context_summary>'));
      summaryHeads.push(head?.content ?? '');
    }
    const fired = log.mock.calls.filter((call) => call[0] === 'compact.session' && call[1] === 'turn-start'
      && (call[2] as { fired?: boolean }).fired === true);
    expect(fired.length).toBe(1);
    // the history head the provider caches is rewritten once, then byte-identical for the remaining turns
    expect(new Set(summaryHeads.filter(Boolean)).size).toBe(1);
  } finally { log.mockRestore(); }
}, 60_000); // 출처: 50 synthetic turns on a loaded host
