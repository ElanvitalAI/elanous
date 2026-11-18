// OP-LONG-SESSION-COMPACT core (trigger-only scope) — deterministic tests through the real `runTurn`.
// Only the external LLM is faked: the chat provider (LLMProvider seam) and the summarizer
// (CompactProvider seam).

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, LLMMessage, LLMProvider } from '../llm.js';
import { debug } from '../debug/log.js';
import { estimateMessagesTokens, trimToBudget, DEFAULT_TOKEN_BUDGET } from '../tokens.js';
import { CHAT_DEFAULTS, type ChatAutoCompactConfig } from '../user-config/chat.js';
import { resolveAutoCompactWindow } from '../compact/auto.js';
import { resetAutoCompactStateForTest } from '../compact/auto-state.js';
import type { CompactProvider } from '../compact/provider.js';
import * as actualUserIntent from '../user-intent/index.js';
import { appendMessage, createSession, loadSession, rewriteSessionMessages, type SerializedMessage } from './index.js';
import { runTurn, toLLM } from './chat.js';
import { resolveTurnCompactTrigger } from './long-session-compact.js';
import { compactSessionHistory } from './compact-session.js';

// ── fixture parameters (not product constants) ───────────────────────────────
const MODEL = 'eln-long-sim'; // matches no catalog entry nor family rule → the 32k fallback window (compact/auto.ts)
// A small working budget puts the existing threshold BELOW the 24k input cap.
const SMALL: ChatAutoCompactConfig = { ...CHAT_DEFAULTS.autoCompact, workingBudgetTokens: 4_000 };
const REPLY_CHARS = 1_200;
const SYSTEM_PROMPT = 'O4 core system prompt — you are the OP seat.';
const SEAT_INSTRUCTION = 'O4 core seat instruction: keep the landing queue moving.';
const SUMMARY_OPEN = '<context_summary>';

let root = '';
const savedEnv: Record<string, string | undefined> = {};
const intentSpy = spyOn(actualUserIntent, 'userIntentLogger').mockImplementation(() => ({ emit: () => null } as never));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'o4-compact-core-'));
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

const summarizer: CompactProvider = {
  async summarize(args) { return { summary: 'fake summary', modelUsed: 'fake', sourceMessageCount: args.messages.length }; },
  getContextWindow: () => resolveAutoCompactWindow(MODEL),
  getAutoCompactThreshold: () => CHAT_DEFAULTS.autoCompact.triggerRatio,
};

const recorder = (name: string) => {
  const requests: LLMMessage[][] = [];
  const provider: LLMProvider = {
    name, defaultModel: MODEL, available: () => true,
    async *chat() { yield 'unused'; },
    async *streamChat(messages) {
      requests.push(structuredClone(messages));
      yield { type: 'text', delta: `reply ${requests.length} ${'r'.repeat(REPLY_CHARS)}` };
    },
  };
  return { requests, provider };
};
const turn = (provider: LLMProvider, sessionId: string, userText: string, config?: ChatAutoCompactConfig, extra: object = {}) => runTurn({
  userConfig: {
    chat: config ? { autoCompact: config } : {},
    llm: { provider: provider.name, model: provider.defaultModel, goalLoop: { enabled: false }, memoryJudge: { enabled: false, crossRecall: false } },
  } as never,
  sessionId, userText, systemPrompt: SYSTEM_PROMPT, skipMemoryInjection: true, provider, compactProvider: summarizer, ...extra,
});
const conversation = (count: number, from: number, chars = REPLY_CHARS): SerializedMessage[] => Array.from({ length: count }, (_, i): SerializedMessage => ({
  role: i % 2 === 0 ? 'user' : 'assistant', content: `seeded ${from + i} ${'m'.repeat(chars)}`, ts: new Date(Date.UTC(2026, 10, 17, 0, from + i)).toISOString(),
}));
const wireTokens = (sessionId: string, userText: string) => estimateMessagesTokens(toLLM([
  ...loadSession(sessionId)!.messages, { role: 'user', content: userText, ts: 'now' },
], SYSTEM_PROMPT));
const turnStart = (log: { mock: { calls: unknown[][] } }) => log.mock.calls
  .filter((call: unknown[]) => call[0] === 'compact.session' && call[1] === 'turn-start')
  .map((call: unknown[]) => call[2] as { fired: boolean; usedTokens: number; triggerTokens: number });

describe('O4 core — trigger = min(existing threshold, input cap)', () => {
  test('a small working budget keeps the existing threshold ratio × min(window, workingBudget)', () => {
    const window = resolveAutoCompactWindow(MODEL);
    const existing = Math.floor(SMALL.triggerRatio * Math.min(window, SMALL.workingBudgetTokens));
    expect(existing < DEFAULT_TOKEN_BUDGET).toBe(true);
    expect(resolveTurnCompactTrigger(MODEL, SMALL, DEFAULT_TOKEN_BUDGET)).toBe(existing);
  });

  test('an existing threshold above the input cap is clamped to the cap (the D1 case)', () => {
    const window = resolveAutoCompactWindow(MODEL);
    const cfg = CHAT_DEFAULTS.autoCompact;
    expect(Math.floor(cfg.triggerRatio * Math.min(window, cfg.workingBudgetTokens)) > DEFAULT_TOKEN_BUDGET).toBe(true);
    expect(resolveTurnCompactTrigger(MODEL, cfg, DEFAULT_TOKEN_BUDGET)).toBe(DEFAULT_TOKEN_BUDGET);
  });

  test('reproduction (D1): the 24k trim dropped the seat instruction before the old threshold was reached', () => {
    const history: SerializedMessage[] = [{ role: 'user', content: SEAT_INSTRUCTION, ts: 't0' }];
    for (let at = 1; estimateMessagesTokens(toLLM(history, SYSTEM_PROMPT)) <= DEFAULT_TOKEN_BUDGET; at += 2) history.push(...conversation(2, at));
    const trimmed = trimToBudget(toLLM(history, SYSTEM_PROMPT), DEFAULT_TOKEN_BUDGET);
    expect(trimmed.kept.some(m => m.content === SEAT_INSTRUCTION)).toBe(false);
    const window = resolveAutoCompactWindow(MODEL);
    const oldThreshold = Math.floor(CHAT_DEFAULTS.autoCompact.triggerRatio * Math.min(window, CHAT_DEFAULTS.autoCompact.workingBudgetTokens));
    expect(trimmed.used < oldThreshold).toBe(true);
  });
});

describe('O4 core — turn-start compaction fires before the trim (real runTurn)', () => {
  test('default config: the store compacts at the 24k cap before any trim, and the prompt is still sent', async () => {
    const { requests, provider } = recorder('o4-core-default');
    const session = createSession({ source: 'cli', provider: provider.name, model: MODEL });
    appendMessage(session.id, { role: 'user', content: SEAT_INSTRUCTION, ts: new Date(Date.UTC(2026, 10, 17)).toISOString() });
    for (let at = 1; wireTokens(session.id, 'current request') < DEFAULT_TOKEN_BUDGET; at += 2) {
      for (const row of conversation(2, at)) appendMessage(session.id, row);
    }
    const log = spyOn(debug, 'log');
    try {
      await turn(provider, session.id, 'current request');
      expect(turnStart(log).map(event => event.fired)).toEqual([true]);
      const stored = loadSession(session.id)!.messages;
      expect(stored.some(row => row.content.startsWith(SUMMARY_OPEN))).toBe(true);
      const request = requests.at(-1)!;
      expect(estimateMessagesTokens(request)).toBeLessThanOrEqual(DEFAULT_TOKEN_BUDGET);
      // Nothing trimmed: the request is the compacted store plus this turn's user row.
      expect(request.map(m => m.content)).toEqual(toLLM(stored.slice(0, -1), SYSTEM_PROMPT).map(m => m.content));
      // D2: the system prompt is still sent after the summary row exists.
      expect(request[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
    } finally {
      log.mockRestore();
    }
  });

  test('small working budget: a long session compacts at the existing threshold and the prompt stays first', async () => {
    const { requests, provider } = recorder('o4-core-small');
    const session = createSession({ source: 'cli', provider: provider.name, model: MODEL });
    const trigger = resolveTurnCompactTrigger(MODEL, SMALL, DEFAULT_TOKEN_BUDGET);
    const replyTokens = estimateMessagesTokens([{ role: 'assistant', content: 'r'.repeat(REPLY_CHARS) }]);
    // Enough turns to cross the trigger at least twice from an empty session.
    const turns = 2 * Math.ceil(trigger / replyTokens) + 2;
    const log = spyOn(debug, 'log');
    try {
      for (let n = 0; n < turns; n++) await turn(provider, session.id, `turn ${n}: continue`, SMALL);
      expect(turnStart(log).filter(event => event.fired).length).not.toBe(0);
      for (const event of turnStart(log)) expect(event.usedTokens >= event.triggerTokens).toBe(true);
      for (const request of requests) {
        expect(request[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
        expect(estimateMessagesTokens(request)).toBeLessThanOrEqual(DEFAULT_TOKEN_BUDGET);
      }
    } finally {
      log.mockRestore();
    }
  });

  test('the trigger is measured on the request as sent — an attached image can cross it', async () => {
    const { provider } = recorder('o4-core-image');
    const session = createSession({ source: 'cli', provider: provider.name, model: MODEL });
    const trigger = resolveTurnCompactTrigger(MODEL, SMALL, DEFAULT_TOKEN_BUDGET);
    const image: ContentBlock = { type: 'image', mediaType: 'image/png', base64: 'aW1hZ2U=' };
    const imageTokens = estimateMessagesTokens([{ role: 'user', content: [image] }]) - estimateMessagesTokens([{ role: 'user', content: '' }]);
    // Grow with small rows until the text-only request sits just under the trigger, within one image.
    appendMessage(session.id, { role: 'user', content: SEAT_INSTRUCTION, ts: new Date(Date.UTC(2026, 10, 17)).toISOString() });
    let at = 1;
    while (wireTokens(session.id, 'look') + imageTokens / 2 < trigger) {
      appendMessage(session.id, { ...conversation(1, at, 8)[0]!, role: 'assistant' });
      at++;
    }
    expect(wireTokens(session.id, 'look') < trigger).toBe(true);
    const log = spyOn(debug, 'log');
    try {
      await turn(provider, session.id, 'look', SMALL, { userImages: [image] });
      expect(turnStart(log).map(event => event.fired)).toEqual([true]);
    } finally {
      log.mockRestore();
    }
  });

  test('an explicit opts.maxTokens keeps the trim-only contract (no storage rewrite)', async () => {
    const { provider } = recorder('o4-core-explicit');
    const session = createSession({ source: 'cli', provider: provider.name, model: MODEL });
    appendMessage(session.id, { role: 'user', content: SEAT_INSTRUCTION, ts: new Date(Date.UTC(2026, 10, 17)).toISOString() });
    for (const row of conversation(8, 1)) appendMessage(session.id, row);
    const log = spyOn(debug, 'log');
    try {
      await turn(provider, session.id, 'explicit', SMALL, { maxTokens: wireTokens(session.id, 'explicit') });
      expect(turnStart(log)).toHaveLength(0);
      expect(loadSession(session.id)!.messages.some(row => row.content.startsWith(SUMMARY_OPEN))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});

describe('O4 core — toLLM keeps the system prompt (D2)', () => {
  test('a compaction summary row no longer suppresses the turn system prompt', () => {
    const wire = toLLM([
      { role: 'system', content: `${SUMMARY_OPEN}\nold\n</context_summary>`, ts: 't0' },
      { role: 'user', content: 'next', ts: 't1' },
    ], SYSTEM_PROMPT);
    expect(wire[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
  });

  test('a stored head row identical to the turn prompt is not duplicated', () => {
    const wire = toLLM([{ role: 'system', content: SYSTEM_PROMPT, ts: 't0' }, { role: 'user', content: 'next', ts: 't1' }], SYSTEM_PROMPT);
    expect(wire.map(m => m.content)).toEqual([SYSTEM_PROMPT, 'next']);
  });
});

// ── Terra #38156 must-fix: the compactor never converts audit rows into user rows ──

const AUDIT_MARK = 'AUDIT-O4';
const auditRow = (n: number): SerializedMessage => ({
  role: 'tool', content: `⚙️ Read ${AUDIT_MARK}-${n}`, toolName: 'Read', toolArgs: `{"file_path":"/${AUDIT_MARK}/${n}"}`,
  toolResult: `${AUDIT_MARK}-RESULT-${n}`, ts: new Date(Date.UTC(2026, 10, 17, 2, n)).toISOString(),
});
const interimRow = (n: number): SerializedMessage => ({
  role: 'assistant', content: `${AUDIT_MARK}-INTERIM-${n}`, goalInterim: true, ts: new Date(Date.UTC(2026, 10, 17, 3, n)).toISOString(),
});
/** A session whose audit rows sit both before the kept tail and inside it. */
const seedWithAudit = (sessionId: string) => {
  appendMessage(sessionId, { role: 'user', content: SEAT_INSTRUCTION, ts: new Date(Date.UTC(2026, 10, 17)).toISOString() });
  let n = 0;
  for (let at = 1; at < 17; at += 2) {
    for (const row of conversation(2, at)) appendMessage(sessionId, row);
    appendMessage(sessionId, at % 4 === 1 ? auditRow(n) : interimRow(n));
    n++;
  }
  for (const row of conversation(1, 20)) appendMessage(sessionId, row);
  appendMessage(sessionId, auditRow(n));
  for (const row of conversation(1, 21)) appendMessage(sessionId, { ...row, role: 'assistant' });
};
const auditLines = (rows: SerializedMessage[]) => rows.filter(row => row.role === 'tool' || row.goalInterim === true).map(row => JSON.stringify(row));
const hasAuditInUser = (messages: Array<{ role: string; content: unknown }>) => messages
  .some(m => m.role === 'user' && JSON.stringify(m.content).includes(AUDIT_MARK));

describe('O4 core — compaction keeps audit rows as they are (Terra #38156)', () => {
  test('stored tool/interim rows keep role and bytes; no user row carries audit content; tail order kept', async () => {
    const session = createSession({ source: 'cli', model: MODEL });
    seedWithAudit(session.id);
    const before = loadSession(session.id)!.messages;
    const result = await compactSessionHistory(session.id, { config: CHAT_DEFAULTS.autoCompact, force: true, provider: summarizer, modelId: MODEL });
    expect(result.fired).toBe(true);
    const after = loadSession(session.id)!.messages;
    expect(auditLines(after)).toEqual(auditLines(before));
    expect(hasAuditInUser(after)).toBe(false);
    // The kept tail is the stored rows as they were, in order (an audit row inside it stays in place).
    const summaryAt = after.findIndex(row => row.content.startsWith(SUMMARY_OPEN));
    const tail = after.slice(summaryAt + 1).map(row => JSON.stringify(row));
    expect(before.map(row => JSON.stringify(row)).slice(-tail.length)).toEqual(tail);
  });

  test('the codex request-size guard path (prepareOnly) shares the same role-preserving rewrite', async () => {
    const session = createSession({ source: 'tui', model: MODEL });
    seedWithAudit(session.id);
    const before = loadSession(session.id)!.messages;
    const prepared = await compactSessionHistory(session.id, { config: CHAT_DEFAULTS.autoCompact, force: true, prepareOnly: true, provider: summarizer, modelId: MODEL });
    expect(prepared.fired).toBe(true);
    expect(auditLines(prepared.preparedMessages!)).toEqual(auditLines(before));
    expect(hasAuditInUser(prepared.preparedMessages!)).toBe(false);
    // prepareOnly writes nothing until commit.
    expect(loadSession(session.id)!.messages.map(row => JSON.stringify(row))).toEqual(before.map(row => JSON.stringify(row)));
  });

  test('through runTurn: auto-compaction keeps audit rows and the next request has no audit user message', async () => {
    const { requests, provider } = recorder('o4-core-audit');
    const session = createSession({ source: 'cli', provider: provider.name, model: MODEL });
    seedWithAudit(session.id);
    const trigger = resolveTurnCompactTrigger(MODEL, SMALL, DEFAULT_TOKEN_BUDGET);
    expect(wireTokens(session.id, 'current request') >= trigger).toBe(true);
    const before = loadSession(session.id)!.messages;
    const log = spyOn(debug, 'log');
    try {
      await turn(provider, session.id, 'current request', SMALL);
      await turn(provider, session.id, 'next request', SMALL);
      expect(turnStart(log).some(event => event.fired)).toBe(true);
    } finally {
      log.mockRestore();
    }
    const after = loadSession(session.id)!.messages;
    expect(auditLines(after)).toEqual(auditLines(before));
    expect(hasAuditInUser(after)).toBe(false);
    for (const request of requests) expect(hasAuditInUser(request)).toBe(false);
  });
});

// ── Claude r2 #38156 must-fixes: no row lost to the async summary window; re-measure after compaction ──

const hooked = (onSummarize: () => void, summary = 'fake summary'): CompactProvider => ({
  ...summarizer,
  async summarize(args) { onSummarize(); return { summary, modelUsed: 'fake', sourceMessageCount: args.messages.length }; },
});
const lines = (rows: SerializedMessage[]) => rows.map(row => JSON.stringify(row));
const sessionLog = (log: { mock: { calls: unknown[][] } }, event: string) => log.mock.calls
  .filter((call: unknown[]) => call[0] === 'session.compact' && call[1] === event).map((call: unknown[]) => call[2] as Record<string, unknown>);

describe('O4 core — rows appended while the summary is in flight are kept (r2 mf1)', () => {
  test('appends land after the compacted history in their order; zero rows lost', async () => {
    const session = createSession({ source: 'cli', model: MODEL });
    seedWithAudit(session.id);
    const late: SerializedMessage[] = [
      { role: 'user', content: 'arrived during the summary', ts: new Date(Date.UTC(2026, 10, 17, 4)).toISOString() },
      auditRow(90),
      { role: 'assistant', content: 'also arrived during the summary', ts: new Date(Date.UTC(2026, 10, 17, 4, 1)).toISOString() },
    ];
    const result = await compactSessionHistory(session.id, {
      config: CHAT_DEFAULTS.autoCompact, force: true, modelId: MODEL,
      provider: hooked(() => { for (const row of late) appendMessage(session.id, row); }),
    });
    expect(result.fired).toBe(true);
    const after = loadSession(session.id)!.messages;
    expect(after.some(row => row.content.startsWith(SUMMARY_OPEN))).toBe(true);
    const tail = after.slice(-late.length);
    expect(tail.map(row => ({ role: row.role, content: row.content }))).toEqual(late.map(row => ({ role: row.role, content: row.content })));
    for (const row of late) expect(after.filter(stored => stored.content === row.content)).toHaveLength(1);
  });

  test('a changed prefix retries once from a fresh snapshot', async () => {
    const session = createSession({ source: 'cli', model: MODEL });
    seedWithAudit(session.id);
    let calls = 0;
    const editOnce = hooked(() => {
      calls++;
      if (calls > 1) return;
      const rows = loadSession(session.id)!.messages;
      rewriteSessionMessages(session.id, rows.map((row, i) => (i === 1 ? { ...row, content: `${row.content} (edited)` } : row)));
    });
    const log = spyOn(debug, 'log');
    try {
      const result = await compactSessionHistory(session.id, { config: CHAT_DEFAULTS.autoCompact, force: true, modelId: MODEL, provider: editOnce });
      expect(calls).toBe(2);
      expect(sessionLog(log, 'retry')).toHaveLength(1);
      expect(result.fired).toBe(true);
      expect(loadSession(session.id)!.messages.some(row => row.content.startsWith(SUMMARY_OPEN))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test('a prefix that changes again on the retry skips the compaction and leaves the store as it is', async () => {
    const session = createSession({ source: 'cli', model: MODEL });
    seedWithAudit(session.id);
    let calls = 0;
    const editAlways = hooked(() => {
      calls++;
      const rows = loadSession(session.id)!.messages;
      rewriteSessionMessages(session.id, rows.map((row, i) => (i === 1 ? { ...row, content: `${row.content} (edit ${calls})` } : row)));
    });
    const log = spyOn(debug, 'log');
    try {
      const result = await compactSessionHistory(session.id, { config: CHAT_DEFAULTS.autoCompact, force: true, modelId: MODEL, provider: editAlways });
      const afterEdits = loadSession(session.id)!.messages;
      expect(result.fired).toBe(false);
      expect(result.reason).toBe('store-changed');
      expect(sessionLog(log, 'skipped').map(event => event.reason)).toEqual(['store-changed']);
      expect(afterEdits.some(row => row.content.startsWith(SUMMARY_OPEN))).toBe(false);
      expect(afterEdits[1]!.content.endsWith(`(edit ${calls})`)).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test('the codex guard commit (prepareOnly) keeps appends and skips a changed prefix', async () => {
    const session = createSession({ source: 'tui', model: MODEL });
    seedWithAudit(session.id);
    const prepared = await compactSessionHistory(session.id, { config: CHAT_DEFAULTS.autoCompact, force: true, prepareOnly: true, provider: summarizer, modelId: MODEL });
    const late: SerializedMessage = { role: 'user', content: 'arrived before the commit', ts: new Date(Date.UTC(2026, 10, 17, 5)).toISOString() };
    appendMessage(session.id, late);
    prepared.commit!();
    const after = loadSession(session.id)!.messages;
    const shape = (rows: SerializedMessage[]) => rows.map(row => ({ role: row.role, content: row.content }));
    expect(shape(after.slice(0, prepared.preparedMessages!.length))).toEqual(shape(prepared.preparedMessages!));
    expect(after.at(-1)?.content).toBe(late.content);

    const other = createSession({ source: 'tui', model: MODEL });
    seedWithAudit(other.id);
    const preparedOther = await compactSessionHistory(other.id, { config: CHAT_DEFAULTS.autoCompact, force: true, prepareOnly: true, provider: summarizer, modelId: MODEL });
    const edited = loadSession(other.id)!.messages.map((row, i) => (i === 1 ? { ...row, content: `${row.content} (edited)` } : row));
    rewriteSessionMessages(other.id, edited);
    const beforeCommit = lines(loadSession(other.id)!.messages);
    preparedOther.commit!();
    expect(lines(loadSession(other.id)!.messages)).toEqual(beforeCommit);
  });
});

describe('O4 core — the request is re-measured after compaction (r2 mf2)', () => {
  // A row of this many characters is about a third of the input cap (ASCII ≈ 4 chars per token · tokens.ts).
  const bigChars = Math.floor((DEFAULT_TOKEN_BUDGET * 4) / 3);
  const big = (role: 'user' | 'assistant', n: number): SerializedMessage => ({ role, content: `big ${n} ${'b'.repeat(bigChars)}`, ts: new Date(Date.UTC(2026, 10, 17, 6, n)).toISOString() });

  test('still over the cap after compaction: older tail rows go, the anchor and the latest user turn stay', async () => {
    const { requests, provider } = recorder('o4-core-remeasure');
    const session = createSession({ source: 'cli', provider: provider.name, model: MODEL });
    appendMessage(session.id, { role: 'user', content: SEAT_INSTRUCTION, ts: new Date(Date.UTC(2026, 10, 17)).toISOString() });
    for (const row of conversation(6, 1)) appendMessage(session.id, row);
    for (const row of [big('assistant', 1), big('user', 2), big('assistant', 3)]) appendMessage(session.id, row);
    const log = spyOn(debug, 'log');
    try {
      await turn(provider, session.id, 'current request', SMALL);
      expect(turnStart(log).map(event => event.fired)).toEqual([true]);
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(estimateMessagesTokens(request)).toBeLessThanOrEqual(DEFAULT_TOKEN_BUDGET);
      expect(request[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
      expect(request.at(-1)).toEqual({ role: 'user', content: 'current request' });
      // The first user message left after compaction (the anchor) is kept; an older big reply went.
      expect(request.some(m => typeof m.content === 'string' && m.content.startsWith('big 2'))).toBe(true);
      expect(request.filter(m => typeof m.content === 'string' && m.content.startsWith('big ')).length < 3).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test('impossible to fit (the summary alone is over the cap): ✗ and the provider is never called', async () => {
    const { requests, provider } = recorder('o4-core-impossible');
    const session = createSession({ source: 'cli', provider: provider.name, model: MODEL });
    seedWithAudit(session.id);
    const hugeSummary = 's'.repeat((DEFAULT_TOKEN_BUDGET + 1) * 4);
    const statusLines: string[] = [];
    const log = spyOn(debug, 'log');
    try {
      await expect(runTurn({
        userConfig: { chat: { autoCompact: SMALL }, llm: { provider: provider.name, model: MODEL, goalLoop: { enabled: false }, memoryJudge: { enabled: false, crossRecall: false } } } as never,
        sessionId: session.id, userText: 'current request', systemPrompt: SYSTEM_PROMPT, skipMemoryInjection: true, provider,
        compactProvider: hooked(() => {}, hugeSummary), onStatusLine: line => statusLines.push(line),
      })).rejects.toThrow('✗');
      expect(requests).toHaveLength(0);
      expect(statusLines.some(line => line.startsWith('✗'))).toBe(true);
      expect(sessionLog(log, 'over-budget')).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });
});
