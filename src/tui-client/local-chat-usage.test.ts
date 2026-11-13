import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeLocalChatSession, isMeasuredTurnUsage, runLocalChatTurn } from './local-chat-turn.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';

test('measured usage accepts only nonnegative safe integer provider fields', () => {
  expect(isMeasuredTurnUsage({ inputTokens: 14, outputTokens: 6 })).toBe(true);
  expect(isMeasuredTurnUsage({ inputTokens: 0 })).toBe(true);
  for (const value of [{}, { inputTokens: -1 }, { inputTokens: 1.5 }, { inputTokens: Number.MAX_SAFE_INTEGER + 1 },
    { inputTokens: 3, usedTokens: 9 }, { outputTokens: '6' }]) expect(isMeasuredTurnUsage(value)).toBe(false);
});

test('sticky child reports measured usage only for the matching turn and session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'b3-usage-child-'));
  const sessionId = 'b3-measured-usage-session';
  const cli = join(root, 'fake-cli.ts');
  mkdirSync(join(root, 'config'));
  setElanousConfigDir(join(root, 'config'));
  writeFileSync(cli, `
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({ input: process.stdin })) {
      const input = JSON.parse(line);
      const usage = (turnId, sessionId, value) => console.log(JSON.stringify({ event: 'usage-complete', turnId, sessionId, usage: value }));
      usage('other-turn', '${sessionId}', { inputTokens: 900, outputTokens: 900 });
      usage(input.id, 'other-session', { inputTokens: 800, outputTokens: 800 });
      usage(input.id, '${sessionId}', { inputTokens: -1, outputTokens: 2 });
      usage(input.id, '${sessionId}', { inputTokens: 14, outputTokens: 6 });
      usage(input.id, '${sessionId}', { inputTokens: 999, outputTokens: 999 });
      console.log(JSON.stringify({ event: 'result', turnId: input.id, sessionId: '${sessionId}', reply: 'ok' }));
    }
  `);
  const received: Array<{ inputTokens?: number; outputTokens?: number }> = [];
  try {
    await runLocalChatTurn(sessionId, 'measure', new AbortController().signal, cli,
      undefined, undefined, { onMeasuredUsage: (usage) => received.push(usage) });
    expect(received).toEqual([{ inputTokens: 14, outputTokens: 6 }]);
  } finally {
    await closeLocalChatSession(sessionId);
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
