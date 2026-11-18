// TURN-FIELD-BUG-2 (OP #90723) — a TUI session resumed after a restart does not redo its old person inputs.
// Live 11-18: JUD-B re-ran «상태줄에 버전 261117_2055·dev 가 보이는지 한 줄 OP 에.» (an OP input typed in the tab before
// the migrate) on every restart; RES wake-miss screens: busy seats continued the interrupted turn for 3 min+ while new
// mail waited 180 s. Real runTurn · recording provider · seeded session history.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMMessage, LLMProvider } from '../llm.js';
import * as actualUserIntent from '../user-intent/index.js';
import { appendMessage, createSession } from './index.js';
import { RESUME_BOUNDARY_BLOCK, runTurn } from './chat.js';

let root = '';
const saved: Record<string, string | undefined> = {};
const intentSpy = spyOn(actualUserIntent, 'userIntentLogger').mockImplementation(() => ({ emit: () => null } as never));
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'field2-resume-'));
  for (const key of ['HOME', 'ELANOUS_SESSION_ROOT']) saved[key] = process.env[key];
  process.env.HOME = root;
  process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
});
afterAll(() => {
  intentSpy.mockRestore();
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
});

function recorder() {
  const requests: LLMMessage[][] = [];
  const provider: LLMProvider = {
    name: 'field2-rec', defaultModel: 'field2-model', available: () => true,
    async *chat() { yield 'unused'; },
    async *streamChat(messages) { requests.push(structuredClone(messages)); yield { type: 'text', delta: 'ok' }; },
  };
  return { requests, provider };
}
const run = (provider: LLMProvider, sessionId: string, userText: string) => runTurn({
  userConfig: { chat: {}, llm: { provider: provider.name, model: provider.defaultModel, goalLoop: { enabled: false }, memoryJudge: { enabled: false, crossRecall: false } } } as never,
  sessionId, userText, systemPrompt: 'seat system prompt', skipMemoryInjection: true, provider,
});
const text = (messages: LLMMessage[]): string => messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

describe('TURN-FIELD-BUG-2 — resumed TUI session: the first turn is told the old inputs are done', () => {
  test('first turn after resume carries the boundary once; the next turn does not', async () => {
    const session = createSession({ source: 'tui', provider: 'field2-rec', model: 'field2-model' });
    appendMessage(session.id, { role: 'user', content: '상태줄에 버전 261117_2055·dev 가 보이는지 한 줄 OP 에.', ts: '2026-11-17T12:00:00.000Z' });
    appendMessage(session.id, { role: 'user', content: '[사용자가 이 턴을 중단했습니다]', ts: '2026-11-17T12:00:05.000Z' });
    const { requests, provider } = recorder();
    await run(provider, session.id, '[notice · seat-mail] RES-INFRA 재기동 확인 — «확인» 한 단어 답장');
    expect(text(requests[0]!)).toContain(RESUME_BOUNDARY_BLOCK);
    await run(provider, session.id, '다음 지시');
    expect(text(requests[1]!)).not.toContain('## Resumed session boundary');
  });

  test('a brand-new session (no earlier person input) gets no boundary', async () => {
    const session = createSession({ source: 'tui', provider: 'field2-rec', model: 'field2-model' });
    const { requests, provider } = recorder();
    await run(provider, session.id, '첫 지시');
    expect(text(requests[0]!)).not.toContain('## Resumed session boundary');
  });

  test('a non-TUI session (cli) is unchanged', async () => {
    const session = createSession({ source: 'cli', provider: 'field2-rec', model: 'field2-model' });
    appendMessage(session.id, { role: 'user', content: '옛 지시', ts: '2026-11-17T12:00:00.000Z' });
    const { requests, provider } = recorder();
    await run(provider, session.id, '새 지시');
    expect(text(requests[0]!)).not.toContain('## Resumed session boundary');
  });
});
