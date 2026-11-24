import { afterEach, expect, spyOn, test } from 'bun:test';
import * as llm from '../llm.js';
import { debug } from '../debug/log.js';
import { runCoreTurn, seatResearchSkipReason } from './run-core-turn.js';

// RESEARCH-TURN-ON-SEAT-MAIL — a seat's ordinary turn never enters the research ladder unless the person asks for it.
const spec = (name: string) => ({ name, description: name, parameters: { type: 'object' } });
const restores: Array<{ mockRestore(): void }> = [];
afterEach(() => { while (restores.length) restores.pop()!.mockRestore(); });

async function ladderCalls(userText: string, seat: string | null): Promise<{ calls: number; skipped: unknown[] }> {
  let calls = 0;
  const skipped: unknown[] = [];
  restores.push(spyOn(llm, 'streamLLMWithTools').mockImplementation(async () => 'done'));
  const original = debug.log.bind(debug);
  restores.push(spyOn(debug, 'log').mockImplementation(((category: string, event: string, fields?: unknown, opts?: unknown) => {
    if (category === 'research.turn' && event === 'skipped-seat') skipped.push(fields);
    return (original as (...args: unknown[]) => unknown)(category, event, fields, opts);
  }) as typeof debug.log));
  await runCoreTurn({ sessionId: 'seat-skip-test', messages: [{ role: 'user', content: userText }], userText,
    tools: [spec('WebSearch'), spec('WebFetch')], dispatchTool: async () => 'ok', signal: new AbortController().signal },
  { runResearch: async () => { calls += 1; return { ok: true, output: 'evidence' }; }, stallSeat: seat, stallMailer: async () => {} });
  return { calls, skipped };
}

test('a seat-mail notice turn does not run the research ladder', async () => {
  const run = await ladderCalls('[notice · seat-mail · 1 msg · from TC · #4242]\n\nDid update-all run on the TC rail? PR #39151', 'OP');
  expect(run.calls).toBe(0);
  expect(run.skipped).toEqual([{ sessionId: 'seat-skip-test', seat: 'OP', reason: 'queue-notice' }]);
});

test('a seat session plain operations question does not run the research ladder', async () => {
  const run = await ladderCalls('What is the latest status of the release rail and TC?', 'OP');
  expect(run.calls).toBe(0);
  expect(run.skipped).toEqual([{ sessionId: 'seat-skip-test', seat: 'OP', reason: 'seat-session' }]);
});

test('a seat session that explicitly asks for research still runs the ladder', async () => {
  const run = await ladderCalls('최신 배터리 정책 동향을 조사해줘', 'OP');
  expect(run.calls).toBe(1);
  expect(run.skipped).toEqual([]);
});

test('a non-seat ordinary session keeps the old research route', async () => {
  const run = await ladderCalls('What is the latest status of the release rail and TC?', null);
  expect(run.calls).toBe(1);
  expect(run.skipped).toEqual([]);
});

test('skip reasons: notice always, seat unless explicit, missing seat identity = none', () => {
  expect(seatResearchSkipReason('[notice · seat-mail]\n\nplease research this', 'MK')).toBe('queue-notice');
  expect(seatResearchSkipReason('did update-all run', 'JUD')).toBe('seat-session');
  expect(seatResearchSkipReason('search the web for bun 1.3 notes', 'JUD')).toBeNull();
  expect(seatResearchSkipReason('did update-all run', null)).toBeNull();
});
